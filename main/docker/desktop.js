'use strict';

const { runDocker } = require('./exec');

const STOP_TIMEOUT_MS = 20000;

// Turns Docker off when ProjectDockHub exits.
// Docker Desktop (Windows, Mac, Linux) has `docker desktop stop`: it stops every container and the engine.
// `--detach` only hands the request over, so the exit does not wait until Docker is fully closed.
// Without Docker Desktop (plain Docker Engine on Linux, or an old Docker Desktop) that command does not exist.
// The engine is a system service there, so only the containers of ProjectDockHub's own projects are stopped.
//   projectNames  the names of all projects
//   stopProject   stops the running containers of one project
// Returns { desktop: true } or { desktop: false, stopped: [names], failed: [names] }.
async function shutDownDocker({ projectNames = [], stopProject, run = runDocker } = {}) {
  const res = await run(['desktop', 'stop', '--detach'], { timeout: STOP_TIMEOUT_MS });
  if (res.ok) return { desktop: true };

  const stopped = [];
  const failed = [];
  for (const name of projectNames) {
    try {
      const one = await stopProject(name);
      (one.ok ? stopped : failed).push(name);
    } catch (err) {
      failed.push(name);
    }
  }
  return { desktop: false, stopped, failed };
}

module.exports = { shutDownDocker, STOP_TIMEOUT_MS };
