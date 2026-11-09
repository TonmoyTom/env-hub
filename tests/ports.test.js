'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { isListening, isPortFree, findFreePort, resolveHostPorts } = require('../main/network/ports');

function listenOnFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function projectWithPort(host) {
  return {
    name: 'portcheck',
    services: [{ name: 'redis', image: 'redis:7', ports: [{ host, container: 6379 }] }],
  };
}

test('isPortFree is false while something listens on the port', async () => {
  const server = await listenOnFreePort();
  const port = server.address().port;
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await close(server);
  }
});

test('isPortFree is true once the port is released', async () => {
  const server = await listenOnFreePort();
  const port = server.address().port;
  await close(server);
  assert.equal(await isPortFree(port), true);
});

test('resolveHostPorts moves a busy port and reports the change', async () => {
  const server = await listenOnFreePort();
  const busy = server.address().port;
  try {
    const { project, changed } = await resolveHostPorts(projectWithPort(busy));
    const newPort = project.services[0].ports[0].host;

    assert.notEqual(newPort, busy);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].wanted, busy);
    assert.equal(changed[0].actual, newPort);
  } finally {
    await close(server);
  }
});

test('resolveHostPorts keeps a free port and reports no change', async () => {
  const server = await listenOnFreePort();
  const port = server.address().port;
  await close(server);

  const { project, changed } = await resolveHostPorts(projectWithPort(port));
  assert.equal(project.services[0].ports[0].host, port);
  assert.deepEqual(changed, []);
});

test('resolveHostPorts skips ports reserved by other projects', async () => {
  const server = await listenOnFreePort();
  const port = server.address().port;
  await close(server);

  const reserved = new Set([port]);
  const { project, changed } = await resolveHostPorts(projectWithPort(port), reserved);
  assert.notEqual(project.services[0].ports[0].host, port);
  assert.equal(changed.length, 1);
});

test('findFreePort gets past a block of unavailable ports wider than 100', async () => {
  // Stands in for the blocks Windows reserves. Several can sit next to each other.
  const start = 20000;
  const blocked = new Set();
  for (let p = start; p < start + 250; p += 1) blocked.add(p);

  const found = await findFreePort(start, blocked);
  assert.ok(found >= start + 250, `expected a port from ${start + 250} up, got ${found}`);
  assert.equal(blocked.has(found), false);
});

test('a probe that connects to itself does not count as a listener', async () => {
  // Same number as the client port, which is what happens on Windows when ports are probed in order.
  const server = await listenOnFreePort();
  const port = server.address().port;
  await close(server);

  assert.equal(await isListening(port, port), false);
  assert.equal(await isPortFree(port), true);
});

test('a real listener is still found when the probe port differs', async () => {
  const server = await listenOnFreePort();
  const port = server.address().port;
  try {
    assert.equal(await isListening(port), true);
  } finally {
    await close(server);
  }
});
