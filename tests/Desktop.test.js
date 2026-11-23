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

test('start Docker: Windows uses the installed Docker Desktop.exe, Mac uses open, Linux uses systemctl', () => {
  const { launchCommand, startDockerDesktop } = require('../main/docker/launch');
  const env = { ProgramFiles: 'C:\Program Files' };
  const exe = path.join('C:\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
  assert.deepStrictEqual(launchCommand('win32', (f) => f === exe, env), { command: exe, args: [] });
  assert.strictEqual(launchCommand('win32', () => false, env), null);
  assert.deepStrictEqual(launchCommand('darwin'), { command: 'open', args: ['-a', 'Docker'] });
  assert.strictEqual(launchCommand('linux', () => false, { HOME: '/h' }), null);
  assert.deepStrictEqual(launchCommand('linux', (f) => f === '/usr/bin/pkexec', { HOME: '/h' }), { command: 'pkexec', args: ['systemctl', 'start', 'docker'] });
  assert.deepStrictEqual(launchCommand('linux', () => true, { HOME: '/h' }), { command: 'systemctl', args: ['--user', 'start', 'docker-desktop'] });
  return startDockerDesktop(undefined, null).then((res) => {
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /could not be started/);
  });
});

test('download Docker: the official installer for this computer, the install guide on Linux', () => {
  const { downloadUrl } = require('../main/docker/launch');
  assert.match(downloadUrl('win32', 'x64'), /^https:\/\/desktop\.docker\.com\/win\/main\/amd64\//);
  assert.match(downloadUrl('win32', 'arm64'), /\/win\/main\/arm64\//);
  assert.match(downloadUrl('darwin', 'arm64'), /\/mac\/main\/arm64\/Docker\.dmg$/);
  assert.match(downloadUrl('darwin', 'x64'), /\/mac\/main\/amd64\/Docker\.dmg$/);
  assert.strictEqual(downloadUrl('linux', 'x64'), 'https://docs.docker.com/engine/install/');
});

test('one service: stop and start find the container by the project and service labels', async () => {
  const { serviceAction } = require('../main/docker/containers');
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return args[0] === 'ps' ? { ok: true, stdout: 'aaaaaaaaaaaa\n', stderr: '' } : { ok: true, stdout: '', stderr: '' };
  };
  assert.deepStrictEqual(await serviceAction('shop', 'mysql', 'stop', run), { ok: true, stdout: '', stderr: '' });
  assert.ok(calls[0].includes('label=com.envhub.project=shop') && calls[0].includes('label=com.envhub.service=mysql'));
  assert.deepStrictEqual(calls[1], ['stop', 'aaaaaaaaaaaa']);
  await serviceAction('shop', 'mysql', 'start', run);
  assert.deepStrictEqual(calls[3], ['start', 'aaaaaaaaaaaa']);
  // Remove deletes only the container (named volumes stay).
  await serviceAction('shop', 'mysql', 'remove', run);
  assert.deepStrictEqual(calls[5], ['rm', '-f', 'aaaaaaaaaaaa']);
  await assert.rejects(() => serviceAction('shop', 'mysql', 'toString', run), /Invalid action/);

  const none = await serviceAction('shop', 'redis', 'start', async () => ({ ok: true, stdout: '', stderr: '' }));
  assert.strictEqual(none.ok, false);
  assert.match(none.stderr, /does not exist/);

  await assert.rejects(() => serviceAction('shop', 'bad name!', 'stop', run), /Invalid service name/);
  await assert.rejects(() => serviceAction('shop', 'mysql', 'rm', run), /Invalid action/);
  await assert.rejects(() => serviceAction('Bad Project', 'mysql', 'stop', run), /Invalid project name/);
});
