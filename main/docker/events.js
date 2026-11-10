'use strict';

const { spawn } = require('child_process');

const WATCHED_ACTIONS = new Set([
  'create', 'start', 'stop', 'die', 'kill', 'restart', 'pause', 'unpause', 'destroy',
]);

const RESTART_AFTER_MS = 3000;
const STABLE_AFTER_MS = 1500;

// Streams container events for envhub-managed containers.
// This avoids polling, so idle CPU stays low.
// When Docker stops, `docker events` ends. It is started again every few seconds until Docker is back, so the
// window keeps getting updates after Docker Desktop was closed and opened again.
//   onChange(change)   a container changed
//   onError(err)       the docker program could not be started
//   onState('down' | 'up')   the stream ended (Docker went away) / has been running for a moment (Docker is there)
// Returns a stop function.
function startEvents(onChange, onError, onState, spawnFn = spawn) {
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let stableTimer = null;
  let down = false;

  function handleLine(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      return;
    }

    const action = event.Action || event.status;
    if (!WATCHED_ACTIONS.has(action)) return;

    const attrs = (event.Actor && event.Actor.Attributes) || {};
    onChange({
      action,
      id: event.Actor ? event.Actor.ID : null,
      name: attrs.name || null,
      project: attrs['com.envhub.project'] || null,
      service: attrs['com.envhub.service'] || null,
    });
  }

  function ended() {
    clearTimeout(stableTimer);
    child = null;
    if (stopped) return;
    if (!down) {
      down = true;
      if (onState) onState('down');
    }
    restartTimer = setTimeout(launch, RESTART_AFTER_MS);
  }

  function launch() {
    if (stopped) return;
    let buffer = '';
    child = spawnFn(
      'docker',
      [
        'events',
        '--filter', 'type=container',
        '--filter', 'label=com.envhub.managed=true',
        '--format', '{{json .}}',
      ],
      { windowsHide: true },
    );

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      if (onError) onError(err);
      ended();
    });
    child.on('close', ended);

    // Still alive after a moment: Docker is there. (A dead Docker makes the program end at once.)
    stableTimer = setTimeout(() => {
      if (down) {
        down = false;
        if (onState) onState('up');
      }
    }, STABLE_AFTER_MS);
  }

  launch();

  return () => {
    stopped = true;
    clearTimeout(restartTimer);
    clearTimeout(stableTimer);
    if (child) child.kill();
  };
}

module.exports = { startEvents, RESTART_AFTER_MS, STABLE_AFTER_MS };
