'use strict';

const { runDocker } = require('./exec');

// "27.4.0", "28.0.1-rc.1"... and nothing else (an empty answer or a message is not a version).
const SERVER_VERSION = /^[0-9][0-9A-Za-z.+_-]*$/;
const CONNECT_ERROR = /error during connect|cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|dockerDesktopLinuxEngine/i;

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
  // `docker info` can exit with 0 even when the engine is off (Docker Desktop closed): it then prints an error
  // and no version. So "running" needs a real version number, and no connection error.
  const serverVersion = server.stdout.trim();
  const answered = server.ok && SERVER_VERSION.test(serverVersion) && !CONNECT_ERROR.test(`${server.stderr}
${server.stdout}`);
  if (!answered) {
    const denied = /permission denied/i.test(`${server.stderr}
${server.stdout}`);
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
    serverVersion,
    reason: null,
    platform,
  };
}

module.exports = { checkDocker, SERVER_VERSION, CONNECT_ERROR };
