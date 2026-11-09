'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInspectOutput } = require('../main/docker/ports');
const { applySavedPorts, toSavedPorts } = require('../main/network/ports');

// Builds one line the way `docker inspect --format` prints it.
function line({ name, running, labels = {}, bindings = null, live = null }) {
  return [
    `/${name}`,
    String(running),
    JSON.stringify(labels),
    JSON.stringify(bindings),
    JSON.stringify(live),
  ].join('\t');
}

const nginxBinding = (port) => ({ '80/tcp': [{ HostIp: '', HostPort: String(port) }] });

test('a stopped container still reserves its ports', () => {
  const text = line({
    name: 'trion_nginx',
    running: false,
    labels: { 'com.docker.compose.project': 'tirono-website' },
    bindings: nginxBinding(8080),
  });

  const owners = parseInspectOutput(text);
  assert.deepEqual(owners.get(8080), {
    name: 'trion_nginx',
    project: 'tirono-website',
    running: false,
  });
});

test('live ports of a running container are included', () => {
  const text = line({
    name: 'random-port',
    running: true,
    bindings: { '80/tcp': [{ HostIp: '', HostPort: '' }] },
    live: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '49153' }] },
  });

  const owners = parseInspectOutput(text);
  assert.equal(owners.get(49153).running, true);
  assert.equal(owners.size, 1);
});

test('containers of the excluded project are skipped', () => {
  const text = [
    line({ name: 'envhub-shop-nginx', running: true, labels: { 'com.envhub.project': 'shop' }, bindings: nginxBinding(8080) }),
    line({ name: 'envhub-blog-nginx', running: true, labels: { 'com.envhub.project': 'blog' }, bindings: nginxBinding(8081) }),
  ].join('\n');

  const owners = parseInspectOutput(text, 'shop');
  assert.equal(owners.has(8080), false);
  assert.equal(owners.has(8081), true);
});

test('port ranges are expanded and empty or null bindings are ignored', () => {
  const text = [
    line({ name: 'range', running: true, bindings: { '8000/tcp': [{ HostPort: '8000-8002' }] } }),
    line({ name: 'none', running: true, bindings: null }),
    line({ name: 'empty', running: true, bindings: { '80/tcp': [{ HostPort: '' }] } }),
  ].join('\n');

  const owners = parseInspectOutput(text);
  assert.deepEqual([...owners.keys()].sort(), [8000, 8001, 8002]);
});

test('a running owner is reported over a stopped one for the same port', () => {
  const text = [
    line({ name: 'old', running: false, bindings: nginxBinding(8080) }),
    line({ name: 'current', running: true, bindings: nginxBinding(8080) }),
  ].join('\n');

  assert.equal(parseInspectOutput(text).get(8080).name, 'current');
});

test('garbage lines are ignored', () => {
  const owners = parseInspectOutput('not a container line\n\n');
  assert.equal(owners.size, 0);
});

test('toSavedPorts and applySavedPorts keep a project on the same ports', () => {
  const project = {
    name: 'shop',
    services: [
      { name: 'nginx', image: 'nginx:stable', ports: [{ host: 8080, container: 80 }] },
      { name: 'redis', image: 'redis:7', ports: [{ host: 6379, container: 6379 }] },
      { name: 'php', image: 'x' },
    ],
  };

  const saved = toSavedPorts([
    { service: 'nginx', container: 80, host: 8082 },
    { service: 'redis', container: 6379, host: 6381 },
  ]);
  assert.deepEqual(saved, { 'nginx:80': 8082, 'redis:6379': 6381 });

  const applied = applySavedPorts(project, saved);
  assert.equal(applied.services[0].ports[0].host, 8082);
  assert.equal(applied.services[1].ports[0].host, 6381);
  assert.equal(applied.services[2].ports, undefined);

  // The original project is not changed.
  assert.equal(project.services[0].ports[0].host, 8080);
});

test('applySavedPorts ignores invalid saved values', () => {
  const project = {
    name: 'shop',
    services: [{ name: 'nginx', image: 'nginx:stable', ports: [{ host: 8080, container: 80 }] }],
  };

  for (const bad of ['8082', 0, 70000, 1.5, null]) {
    const applied = applySavedPorts(project, { 'nginx:80': bad });
    assert.equal(applied.services[0].ports[0].host, 8080, String(bad));
  }
});
