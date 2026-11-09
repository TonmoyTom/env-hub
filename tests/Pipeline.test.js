'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLayerTracker, parseBuildStep, stepsFor, pullImages } = require('../main/docker/pipeline');

// A stand-in `docker` program, so the real pull and stream code runs without Docker.
// It is a shell script, so the tests that use it are skipped on Windows.
const FAKE = `#!/bin/sh
case "$1" in
  image)
    [ "$FAKE_PRESENT" = "1" ] && exit 0
    exit 1 ;;
  pull)
    if [ "$FAKE_FAIL" = "1" ]; then
      echo "Error response from daemon: pull access denied" >&2
      exit 1
    fi
    if [ "$FAKE_CR" = "1" ]; then
      printf 'aaaaaaaaaaaa: Pulling fs layer\\rbbbbbbbbbbbb: Pulling fs layer\\raaaaaaaaaaaa: Pull complete\\rbbbbbbbbbbbb: Pull complete\\n'
      exit 0
    fi
    echo "7.0: Pulling from library/redis"
    echo "aaaaaaaaaaaa: Pulling fs layer"
    echo "bbbbbbbbbbbb: Pulling fs layer"
    echo "aaaaaaaaaaaa: Pull complete"
    echo "bbbbbbbbbbbb: Pull complete"
    exit 0 ;;
esac
exit 0
`;

const windows = process.platform === 'win32';

if (!windows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-fake-docker-'));
  fs.writeFileSync(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
}

function collect() {
  const events = [];
  const report = (step, fraction, detail) => events.push({ step, fraction, detail });
  return { events, report };
}

async function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('layer tracker gives a fraction once layers are known', () => {
  const tracker = createLayerTracker();
  assert.equal(tracker.fraction(), null);

  tracker.feed('7.0: Pulling from library/redis');
  assert.equal(tracker.fraction(), null);

  tracker.feed('a1a1a1a1a1a1: Pulling fs layer');
  tracker.feed('b2b2b2b2b2b2: Pulling fs layer');
  assert.equal(tracker.fraction(), 0);

  tracker.feed('a1a1a1a1a1a1: Pull complete');
  assert.equal(tracker.fraction(), 0.5);

  tracker.feed('b2b2b2b2b2b2 Already exists');
  assert.equal(tracker.fraction(), 1);
});

test('layer tracker ignores progress bars and unrelated lines', () => {
  const tracker = createLayerTracker();
  tracker.feed('a1a1a1a1a1a1: Downloading [=====>     ]  2.1MB/30MB');
  tracker.feed('Status: Downloaded newer image for redis:7');
  tracker.feed('Digest: sha256:abc');
  assert.equal(tracker.fraction(), 0);
});

test('build step numbers become a fraction', () => {
  assert.equal(parseBuildStep('#8 [stage-0 3/6] RUN apt-get update'), 0.5);
  assert.equal(parseBuildStep('#9 [4/4] WORKDIR /var/www/html'), 1);
  assert.equal(parseBuildStep('#5 [internal] load metadata for docker.io/library/php:8.3-fpm'), null);
  assert.equal(parseBuildStep('writing image sha256:abc'), null);
});

test('the build step is listed only when an image is built', () => {
  const plain = stepsFor({ services: [{ name: 'redis', image: 'redis:7' }] });
  assert.deepEqual(plain.map((s) => s.id), ['ports', 'files', 'pull', 'up']);

  const withBuild = stepsFor({ services: [{ name: 'php', image: 'x', build: { context: '/x' } }] });
  assert.deepEqual(withBuild.map((s) => s.id), ['ports', 'files', 'pull', 'build', 'up']);
});

test('pullImages reports real progress per image', { skip: windows }, async () => {
  const { events, report } = collect();
  const res = await pullImages(['redis:7', 'mysql:8.0'], report);

  assert.equal(res.ok, true);
  const fractions = events.map((e) => e.fraction);
  assert.ok(fractions.includes(0.25), `expected a 25% report, got ${fractions}`);
  assert.ok(fractions.includes(0.5), `expected a 50% report, got ${fractions}`);
  assert.equal(events[events.length - 1].fraction, 1);
  assert.match(events.find((e) => e.fraction === 0.25).detail, /redis:7 \(1 of 2\)/);
});

test('pullImages skips images that are already there', { skip: windows }, async () => {
  const { events, report } = collect();
  const res = await withEnv({ FAKE_PRESENT: '1' }, () => pullImages(['redis:7'], report));

  assert.equal(res.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].fraction, 1);
  assert.match(events[0].detail, /already on this computer/);
});

test('pullImages returns the error text when a pull fails', { skip: windows }, async () => {
  const { report } = collect();
  const res = await withEnv({ FAKE_FAIL: '1' }, () => pullImages(['redis:7'], report));

  assert.equal(res.ok, false);
  assert.match(res.stderr, /pull access denied/);
});

test('progress redrawn with carriage returns still counts layers', { skip: windows }, async () => {
  const { events, report } = collect();
  const res = await withEnv({ FAKE_CR: '1' }, () => pullImages(['redis:7'], report));

  assert.equal(res.ok, true);
  assert.ok(events.some((e) => e.fraction === 0.5));
});
