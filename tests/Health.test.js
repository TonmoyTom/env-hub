'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { healthOf, explainState, diagnoseContainer, waitsForInput } = require('../main/docker/health');

const levels = (res) => res.findings.map((f) => f.level);
const texts = (res) => res.findings.map((f) => f.text).join(' | ');

test('health word from the docker ps status', () => {
  assert.strictEqual(healthOf('Up 5 minutes (healthy)'), 'healthy');
  assert.strictEqual(healthOf('Up 2 seconds (health: starting)'), 'starting');
  assert.strictEqual(healthOf('Up 1 hour (unhealthy)'), 'unhealthy');
  assert.strictEqual(healthOf('Up 3 hours'), null);
  assert.strictEqual(healthOf(undefined), null);
});

test('a shell as the only command is a restart loop with a clear fix (the hylafax case)', () => {
  const res = explainState({
    State: { Status: 'restarting', Restarting: true, ExitCode: 0 },
    RestartCount: 41,
    Config: { Cmd: ['/bin/bash'], Image: 'neoseason/hylafax:nocfg' },
  });
  assert.strictEqual(res.findings[0].level, 'error');
  assert.match(res.findings[0].text, /only starts "\/bin\/bash".*again and again/);
  assert.match(res.findings[0].fix, /start command/);
  assert.match(texts(res), /restarted 41 times/);
  assert.ok(waitsForInput(['python3']));
  assert.ok(!waitsForInput(['python3', 'app.py']));
  assert.ok(!waitsForInput(['sh', '-c', 'nginx -g "daemon off;"']));
});

test('exit codes, out of memory and docker errors are explained', () => {
  const notFound = explainState({ State: { Status: 'exited', ExitCode: 127 }, Config: { Cmd: ['srv'] } });
  assert.match(texts(notFound), /not found/);
  const oom = explainState({ State: { Status: 'exited', ExitCode: 137, OOMKilled: true }, Config: {} });
  assert.match(texts(oom), /ran out of memory/);
  assert.ok(!/killed \(exit code 137\)/.test(texts(oom)), 'OOM is said once, not twice');
  const port = explainState({ State: { Status: 'created', ExitCode: 128, Error: 'Bind for 0.0.0.0:8080 failed: port is already allocated' }, Config: {} });
  assert.match(port.findings[0].fix, /Change the port/);
});

test('log lines add hints only when something is wrong', () => {
  const crashed = explainState(
    { State: { Status: 'exited', ExitCode: 1 }, Config: { Cmd: ['php-fpm'] } },
    'SQLSTATE[HY000] [2002] Connection refused\nAccess denied for user root',
  );
  assert.match(texts(crashed), /could not reach another service/);
  assert.match(texts(crashed), /login .* was refused/);
  const fine = explainState({ State: { Status: 'running', Running: true }, Config: {} }, 'Connection refused once, retried');
  assert.deepStrictEqual(levels(fine), ['ok']);
});

test('a failing health check shows its last output', () => {
  const res = explainState({
    State: { Status: 'running', Running: true, Health: { Status: 'unhealthy', FailingStreak: 5, Log: [{ ExitCode: 1, Output: 'curl: (7) Failed to connect to localhost port 80' }] } },
    Config: {},
  });
  assert.strictEqual(res.health, 'unhealthy');
  assert.match(texts(res), /health check fails \(5 times in a row\): curl: \(7\)/);
});

test('diagnoseContainer finds the container by labels and reads inspect and logs', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'ps') return { ok: true, stdout: 'abcdef123456\n', stderr: '' };
    if (args[0] === 'inspect') return { ok: true, stdout: JSON.stringify([{ Name: '/envhub-shop-fax', State: { Status: 'exited', ExitCode: 0 }, Config: { Cmd: ['bash'] } }]), stderr: '' };
    return { ok: true, stdout: 'line 1\n', stderr: 'line 2\n' };
  };
  const res = await diagnoseContainer('shop', 'fax', run);
  assert.strictEqual(res.container, 'envhub-shop-fax');
  assert.ok(calls[0].includes('label=com.envhub.project=shop'));
  assert.ok(calls[0].includes('label=com.envhub.service=fax'));
  assert.deepStrictEqual(calls[2], ['logs', '--tail', '30', 'abcdef123456']);
  assert.strictEqual(res.logs, 'line 1\nline 2');
  await assert.rejects(() => diagnoseContainer('shop', 'bad name', run), /Invalid service/);
});
