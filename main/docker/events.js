'use strict';

const { spawn } = require('child_process');

const WATCHED_ACTIONS = new Set([
  'create', 'start', 'stop', 'die', 'kill', 'restart', 'pause', 'unpause', 'destroy',
]);

// Streams container events for envhub-managed containers.
// This avoids polling, so idle CPU stays low.
// Returns a stop function.
function startEvents(onChange, onError) {
  const child = spawn(
    'docker',
    [
      'events',
      '--filter', 'type=container',
      '--filter', 'label=com.envhub.managed=true',
      '--format', '{{json .}}',
    ],
    { windowsHide: true },
  );

  let buffer = '';

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
  });

  return () => {
    child.kill();
  };
}

module.exports = { startEvents };
