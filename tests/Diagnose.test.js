'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { buildDiagnosis, probePort, validPort, ruleName } = require('../main/network/diagnose');

const good = { running: true, lanShare: true, addresses: ['192.168.1.105'], port: 8083, localOk: true, lanOk: true, firewallRule: true, platform: 'win32' };
const fixesOf = (d) => d.steps.filter((s) => !s.ok).map((s) => s.fix);

test('everything fine gives no problems', () => {
  const d = buildDiagnosis(good);
  assert.equal(d.ok, true);
  assert.deepEqual(fixesOf(d), []);
});

test('stopped project offers Start', () => {
  assert.ok(fixesOf(buildDiagnosis({ ...good, running: false, localOk: false, lanOk: false })).includes('start'));
});

test('sharing off offers Settings', () => {
  assert.ok(fixesOf(buildDiagnosis({ ...good, lanShare: false, lanOk: false })).includes('settings'));
});

test('works on localhost but not on the network address offers Restart', () => {
  const d = buildDiagnosis({ ...good, lanOk: false });
  assert.deepEqual(fixesOf(d), ['restart']);
});

test('missing firewall rule offers the firewall fix on Windows only', () => {
  assert.deepEqual(fixesOf(buildDiagnosis({ ...good, firewallRule: false })), ['firewall']);
  assert.equal(buildDiagnosis({ ...good, firewallRule: false, platform: 'linux' }).ok, true);
});

test('no network address is reported', () => {
  assert.equal(buildDiagnosis({ ...good, addresses: [] }).ok, false);
});

test('always explains that 192.168 is not public', () => {
  assert.match(buildDiagnosis(good).notes.join(' '), /internet/);
});

test('validPort and ruleName', () => {
  assert.equal(validPort(8083), true);
  assert.equal(validPort('8083; calc'), false);
  assert.equal(validPort(0), false);
  assert.equal(ruleName(8083), 'EnvHub 8083');
});

test('probePort sees an open and a closed port', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  assert.equal(await probePort('127.0.0.1', port), true);
  await new Promise((r) => server.close(r));
  assert.equal(await probePort('127.0.0.1', port), false);
});
