'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Where Docker Desktop is installed on Windows. The first one that exists is started.
function windowsCandidates(env = process.env) {
  return [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'Docker', 'Docker', 'Docker Desktop.exe'));
}

// The program and arguments that open Docker Desktop, or null when this system has no such way
// (plain Docker Engine on Linux is a service that needs administrator rights).
function launchCommand(platform = process.platform, exists = fs.existsSync, env = process.env) {
  if (platform === 'win32') {
    const exe = windowsCandidates(env).find((file) => exists(file));
    return exe ? { command: exe, args: [] } : null;
  }
  if (platform === 'darwin') return { command: 'open', args: ['-a', 'Docker'] };
  if (platform === 'linux') {
    // Docker Desktop for Linux is a per-user service. Plain Docker Engine is a system service: pkexec
    // shows the normal password window of the desktop.
    const home = env.HOME || '';
    if (home && exists(path.join(home, '.docker', 'desktop')) && exists('/usr/lib/systemd/user/docker-desktop.service')) {
      return { command: 'systemctl', args: ['--user', 'start', 'docker-desktop'] };
    }
    if (exists('/usr/bin/pkexec')) return { command: 'pkexec', args: ['systemctl', 'start', 'docker'] };
  }
  return null;
}

// Opens Docker Desktop. It only starts the program: Docker needs a minute to be ready,
// so the window checks again by itself. Resolves { ok, error? }.
function startDockerDesktop(spawnFn = spawn, command = launchCommand()) {
  if (!command) return Promise.resolve({ ok: false, error: 'Docker could not be started from here. Start it yourself (for example: sudo systemctl start docker).' });
  return new Promise((resolve) => {
    try {
      const child = spawnFn(command.command, command.args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', (err) => resolve({ ok: false, error: `Could not open Docker Desktop: ${err.message}` }));
      child.unref();
      // An immediate error (file missing) arrives before this timer.
      setTimeout(() => resolve({ ok: true }), 300);
    } catch (err) {
      resolve({ ok: false, error: `Could not open Docker Desktop: ${err.message}` });
    }
  });
}

// The official download for this computer. The address is fixed here, nothing from the window goes into it.
// Windows and Mac get the installer itself, Linux gets the install guide (Docker Engine is installed with the
// package manager there).
function downloadUrl(platform = process.platform, arch = process.arch) {
  const cpu = arch === 'arm64' ? 'arm64' : 'amd64';
  if (platform === 'win32') return `https://desktop.docker.com/win/main/${cpu}/Docker%20Desktop%20Installer.exe`;
  if (platform === 'darwin') return `https://desktop.docker.com/mac/main/${cpu === 'arm64' ? 'arm64' : 'amd64'}/Docker.dmg`;
  return 'https://docs.docker.com/engine/install/';
}

module.exports = { startDockerDesktop, launchCommand, downloadUrl };
