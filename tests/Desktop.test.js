'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { shutDownDocker } = require('../main/docker/desktop');

test('exit: Docker Desktop is asked to stop, and no project is stopped one by one', async () => {
  const calls = [];
  const res = await shutDownDocker({
    projectNames: ['shop', 'blog'],
    stopProject: async (name) => { calls.push(name); return { ok: true }; },
    run: async (args) => { calls.push(args.join(' ')); return { ok: true }; },
  });
  assert.deepStrictEqual(res, { desktop: true });
  assert.deepStrictEqual(calls, ['desktop stop --detach']);
});

test('exit without Docker Desktop: the containers of every project are stopped', async () => {
  const res = await shutDownDocker({
    projectNames: ['shop', 'blog', 'broken'],
    stopProject: async (name) => {
      if (name === 'broken') throw new Error('boom');
      return { ok: name === 'shop' };
    },
    run: async () => ({ ok: false, code: 1 }),
  });
  assert.deepStrictEqual(res, { desktop: false, stopped: ['shop'], failed: ['blog', 'broken'] });
});

test('settings: stopping Docker on exit is on by default and the choice is saved', () => {
  const settings = require('../main/store/settings');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-settings-'));
  try {
    settings.init(dir);
    assert.strictEqual(settings.stopDockerOnExit(), true);
    settings.setStopDockerOnExit(false);
    settings.init(dir);
    assert.strictEqual(settings.stopDockerOnExit(), false);
    assert.throws(() => settings.setStopDockerOnExit('yes'), /Invalid value/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
