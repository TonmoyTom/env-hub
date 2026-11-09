'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCompose, validateProject } = require('../main/compose/generate');

const base = {
  name: 'shop',
  stack: 'laravel',
  services: [
    {
      name: 'mysql',
      image: 'mysql:8.0',
      ports: [{ host: 3306, container: 3306 }],
      env: { MYSQL_DATABASE: 'app' },
    },
    { name: 'redis', image: 'redis:7' },
  ],
};

test('generates labelled services with localhost-only ports', () => {
  const compose = generateCompose(base);

  assert.equal(compose.name, 'envhub-shop');
  assert.equal(compose.services.mysql.container_name, 'envhub-shop-mysql');
  assert.deepEqual(compose.services.mysql.ports, ['127.0.0.1:3306:3306']);
  assert.deepEqual(compose.services.mysql.environment, { MYSQL_DATABASE: 'app' });
  assert.equal(compose.services.mysql.labels['com.envhub.managed'], 'true');
  assert.equal(compose.services.mysql.labels['com.envhub.project'], 'shop');
  assert.equal(compose.services.mysql.labels['com.envhub.service'], 'mysql');
  assert.equal(compose.services.mysql.labels['com.envhub.stack'], 'laravel');
});

test('services without ports or env get no ports or environment keys', () => {
  const compose = generateCompose(base);

  assert.equal(compose.services.redis.ports, undefined);
  assert.equal(compose.services.redis.environment, undefined);
});

test('rejects invalid project names', () => {
  for (const name of ['Shop', 'shop; rm -rf /', '', '1shop', 'a'.repeat(41)]) {
    assert.throws(() => validateProject({ ...base, name }), /Invalid project name/, name);
  }
});

test('rejects images that could carry shell syntax', () => {
  const project = { ...base, services: [{ name: 'x', image: 'mysql 8; ls' }] };
  assert.throws(() => validateProject(project), /image/);
});

test('rejects ports outside 1 to 65535', () => {
  const project = {
    ...base,
    services: [{ name: 'x', image: 'redis:7', ports: [{ host: 0, container: 6379 }] }],
  };
  assert.throws(() => validateProject(project), /Invalid port/);
});

test('rejects non-string env values and bad env keys', () => {
  const badValue = { ...base, services: [{ name: 'x', image: 'redis:7', env: { A: 1 } }] };
  assert.throws(() => validateProject(badValue), /must be a string/);

  const badKey = { ...base, services: [{ name: 'x', image: 'redis:7', env: { 'A B': 'x' } }] };
  assert.throws(() => validateProject(badKey), /Invalid env key/);
});

test('rejects duplicate service names', () => {
  const project = {
    ...base,
    services: [
      { name: 'redis', image: 'redis:7' },
      { name: 'redis', image: 'redis:7' },
    ],
  };
  assert.throws(() => validateProject(project), /Duplicate service name/);
});

test('rejects a project with no services', () => {
  assert.throws(() => validateProject({ ...base, services: [] }), /at least one service/);
});
