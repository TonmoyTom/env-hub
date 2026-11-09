'use strict';

const { runDocker } = require('./exec');

// Returns a plain object the renderer can display.
// reason is one of: null, 'not-found', 'daemon-not-running', 'permission-denied', 'error'
async function checkDocker() {
  const platform = process.platform;

  const client = await runDocker(['--version']);
  if (!client.ok) {
    return {
      installed: false,
      running: false,
      clientVersion: null,
      serverVersion: null,
      reason: client.code === 'ENOENT' ? 'not-found' : 'error',
      platform,
    };
  }

  const server = await runDocker(['info', '--format', '{{.ServerVersion}}']);
  if (!server.ok) {
    const denied = /permission denied/i.test(server.stderr);
    return {
      installed: true,
      running: false,
      clientVersion: client.stdout.trim(),
      serverVersion: null,
      reason: denied ? 'permission-denied' : 'daemon-not-running',
      platform,
    };
  }

  return {
    installed: true,
    running: true,
    clientVersion: client.stdout.trim(),
    serverVersion: server.stdout.trim(),
    reason: null,
    platform,
  };
}

module.exports = { checkDocker };
