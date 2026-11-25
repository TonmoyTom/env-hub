'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { checkHostPort, parsePort } = require('../main/network/port-choice');

const ownPorts = [
  { service: 'nginx', container: 80, host: 8083 },
  { service: 'mysql', container: 3306, host: 3306 },
];

function facts(port, extra = {}) {
  return {
    port,
    service: 'nginx',
    container: 80,
    ownPorts,
    ownRunning: new Set(),
    otherProjects: new Map(),
    dockerOwners: new Map(),
    isPortFree: async () => true,
    ...extra,
  };
}

test('port choice: a free port can be used', async () => {
  const res = await checkHostPort(facts('8080'));
  assert.deepStrictEqual([res.ok, res.port], [true, 8080]);
});

test('port choice: the same port is fine and changes nothing', async () => {
  const res = await checkHostPort(facts(8083));
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.same, true);
});

test('port choice: bad numbers are refused', async () => {
  for (const bad of ['', 'abc', '0', '65536', '80.5', '-1']) {
    const res = await checkHostPort(facts(bad));
    assert.strictEqual(res.ok, false, bad);
    assert.strictEqual(res.reason, 'invalid', bad);
  }
  assert.strictEqual(parsePort(' 8080 '), 8080);
});

test('port choice: a port of another service in the same project is refused', async () => {
  const res = await checkHostPort(facts(3306));
  assert.strictEqual(res.reason, 'own');
  assert.match(res.message, /mysql/);
});

test('port choice: a port of another project is refused, and says which', async () => {
  const res = await checkHostPort(facts(8085, { otherProjects: new Map([[8085, { project: 'tirono-pcm', service: 'nginx' }]]) }));
  assert.strictEqual(res.reason, 'project');
  assert.match(res.message, /tirono-pcm/);
});

test('port choice: a port of any Docker container is refused, even a stopped one', async () => {
  const owners = new Map([[8080, { name: 'my-other-app', project: null, running: false }]]);
  const res = await checkHostPort(facts(8080, { dockerOwners: owners }));
  assert.strictEqual(res.reason, 'docker');
  assert.match(res.message, /my-other-app.*stopped/);
});

test('port choice: a port another program uses is refused; one this project already holds is not', async () => {
  const busy = await checkHostPort(facts(8080, { isPortFree: async () => false }));
  assert.strictEqual(busy.reason, 'busy');
  const own = await checkHostPort(facts(8080, { isPortFree: async () => false, ownRunning: new Set([8080]) }));
  assert.strictEqual(own.ok, true);
});

test('port choice: a service without that port is refused', async () => {
  const res = await checkHostPort(facts(8080, { service: 'php' }));
  assert.strictEqual(res.reason, 'unknown');
});
