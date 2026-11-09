'use strict';

const http = require('http');
const { runDocker, streamDocker } = require('./exec');

const PULL_TIMEOUT_MS = 30 * 60 * 1000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
const UP_TIMEOUT_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 15 * 60 * 1000;
const READY_POLL_MS = 2000;

// "a2318d6c47ec: Pull complete" (older Docker) or "a2318d6c47ec Pull complete" (newer).
const LAYER_LINE = /^([0-9a-f]{12,64}):?\s+(.+)$/i;
// BuildKit prints "#8 [stage-0 3/6] RUN ..." or "#8 [3/6] RUN ...".
const BUILD_STEP = /\[(?:[\w.-]+\s+)?(\d+)\/(\d+)\]/;

// Counts image layers while `docker pull` runs, so the progress is real and not a guess.
function createLayerTracker() {
  const seen = new Set();
  const finished = new Set();

  return {
    feed(line) {
      const match = LAYER_LINE.exec(line);
      if (!match) return;

      const [, id, state] = match;
      if (/Pulling fs layer|Waiting|Downloading|Download complete|Extracting/i.test(state)) {
        seen.add(id);
      }
      if (/Pull complete|Already exists/i.test(state)) {
        seen.add(id);
        finished.add(id);
      }
    },
    // 0 to 1, or null while no layer has been seen yet.
    fraction() {
      return seen.size === 0 ? null : finished.size / seen.size;
    },
  };
}

// Reads the step number from a build line. Returns 0 to 1, or null if the line has none.
function parseBuildStep(line) {
  const match = BUILD_STEP.exec(line);
  if (!match) return null;

  const step = Number(match[1]);
  const total = Number(match[2]);
  return total > 0 && step <= total ? step / total : null;
}

// Node projects run `npm install` inside the container every time it is created, and the web
// server only starts after that. These services are waited for, so "ready" really means ready.
function readyService(config) {
  return (config.services || []).find(
    (s) => s.name === 'node' && Array.isArray(s.command) && /npm install/.test(s.command.join(' ')) && (s.ports || []).length > 0,
  );
}

function needsReadyWait(config) {
  return Boolean(readyService(config));
}

// True when something answers HTTP on the port. Any status counts, even 404 or 500.
// Docker accepts the connection before the app is up, so a plain connect test is not enough.
function httpAnswers(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Waits until the app of a Node project answers, while telling the user what it is doing.
// Resolves { ok: true } when it answers or when the wait runs out (the project is then still
// starting, and `notReady` is set), and { ok: false, stderr } when the container stopped.
async function waitForApp({ projectName, config, report, log = () => {}, timeoutMs = READY_TIMEOUT_MS, pollMs = READY_POLL_MS }) {
  const svc = readyService(config);
  if (!svc) return { ok: true };

  const container = `envhub-${projectName}-${svc.name}`;
  const port = svc.ports[0].host;
  const started = Date.now();
  let lastLine = '';
  report('ready', null, 'Installing packages (npm install). The first time this can take a few minutes');
  log('Waiting for the app: npm install, then the dev server');

  while (Date.now() - started < timeoutMs) {
    if (await httpAnswers(port)) {
      report('ready', 1, 'The app answers');
      return { ok: true };
    }

    const state = await runDocker(['inspect', '--format', '{{.State.Status}}', container]);
    const status = state.ok ? state.stdout.trim() : '';
    if (status === 'exited' || status === 'dead') {
      const out = await runDocker(['logs', '--tail', '15', container]);
      return { ok: false, stdout: '', stderr: 'The app container stopped. ' + (out.stdout + out.stderr).trim() };
    }

    const out = await runDocker(['logs', '--tail', '3', container]);
    const lines = (out.stdout + out.stderr).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const newest = lines[lines.length - 1] || '';
    if (newest && newest !== lastLine) {
      lastLine = newest;
      log(newest);
    }
    const detail = status === 'restarting'
      ? 'The app is restarting, check the Logs'
      : newest
        ? `Installing and starting: ${newest.slice(0, 80)}`
        : 'Installing packages (npm install). The first time this can take a few minutes';
    report('ready', null, detail);

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  log('The app is still starting. It will be ready when npm install finishes');
  return { ok: true, notReady: true };
}

// The steps shown to the user for one start. The build step exists only when an image is built.
function stepsFor(config) {
  const steps = [
    { id: 'ports', label: 'Checking ports' },
    { id: 'files', label: 'Preparing files' },
    { id: 'pull', label: 'Downloading images' },
  ];
  if (config.services.some((s) => s.build)) {
    steps.push({ id: 'build', label: 'Building the PHP image' });
  }
  steps.push({ id: 'up', label: 'Starting containers' });
  if (needsReadyWait(config)) steps.push({ id: 'ready', label: 'Installing packages and starting the app' });
  return steps;
}

// Downloads the images that are not on this computer yet, one by one.
async function pullImages(images, report, log = () => {}) {
  const missing = [];
  for (const image of images) {
    const found = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image]);
    if (!found.ok) missing.push(image);
  }

  if (missing.length === 0) {
    log('All images are already on this computer');
    report('pull', 1, 'All images are already on this computer');
    return { ok: true };
  }

  for (let i = 0; i < missing.length; i += 1) {
    const tracker = createLayerTracker();
    const label = `Downloading ${missing[i]} (${i + 1} of ${missing.length})`;
    log(`$ docker pull ${missing[i]}`);
    report('pull', i / missing.length, label);

    const res = await streamDocker(
      ['pull', missing[i]],
      (line) => {
        log(line);
        tracker.feed(line);
        const within = tracker.fraction();
        report('pull', (i + (within === null ? 0 : within)) / missing.length, label);
      },
      { timeout: PULL_TIMEOUT_MS },
    );

    if (!res.ok) {
      return { ok: false, stdout: '', stderr: res.tail.join('\n') };
    }
  }

  report('pull', 1, 'Images downloaded');
  return { ok: true };
}

// Builds the images of the project (the PHP image). Progress comes from the build step numbers.
async function buildImages(composeArgs, report, log = () => {}) {
  let best = 0;

  const res = await streamDocker(
    [...composeArgs, 'build'],
    (line) => {
      log(line);
      const fraction = parseBuildStep(line);
      if (fraction !== null && fraction > best) best = fraction;
      report('build', Math.min(best, 0.97), line.slice(0, 90));
    },
    {
      timeout: BUILD_TIMEOUT_MS,
      env: { BUILDKIT_PROGRESS: 'plain', COMPOSE_PROGRESS: 'plain' },
    },
  );

  if (!res.ok) {
    return { ok: false, stdout: '', stderr: res.tail.join('\n') };
  }

  report('build', 1, 'Image built');
  return { ok: true };
}

// Downloads and builds what is missing, then starts the containers.
// `report(step, fraction, detail)` is called as the work moves on. fraction is 0 to 1 or null.
// Resolves like runDocker: { ok, stdout, stderr }.
async function setupProject({ composeFile, projectName, config, report, log = () => {} }) {
  const composeArgs = ['compose', '-f', composeFile, '-p', `envhub-${projectName}`];

  const images = [...new Set(config.services.filter((s) => !s.build).map((s) => s.image))];
  report('pull', 0, 'Checking which images are on this computer');
  const pulled = await pullImages(images, report, log);
  if (!pulled.ok) return pulled;

  if (config.services.some((s) => s.build)) {
    report('build', 0, 'Starting the build');
    log('$ docker compose build');
    const built = await buildImages(composeArgs, report, log);
    if (!built.ok) return built;
  }

  report('up', null, 'Starting the containers');
  log('$ docker compose up -d --remove-orphans');
  // --remove-orphans takes away the containers of services the user removed from the project.
  const up = await streamDocker([...composeArgs, 'up', '-d', '--remove-orphans'], log, {
    timeout: UP_TIMEOUT_MS,
    env: { COMPOSE_PROGRESS: 'plain' },
  });
  return up.ok ? { ok: true, stdout: '', stderr: '' } : { ok: false, stdout: '', stderr: up.tail.join('\n') };
}

module.exports = {
  setupProject,
  stepsFor,
  waitForApp,
  readyService,
  httpAnswers,
  pullImages,
  createLayerTracker,
  parseBuildStep,
};
