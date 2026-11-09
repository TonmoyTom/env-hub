'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCompose, validateProject } = require('../main/compose/generate');
const { mysql, postgres, mongodb, redis } = require('../main/stacks/services');

const base = (services) => ({ name: 'shop', stack: 'custom', services });

test('database services mount a named data volume', () => {
  const compose = generateCompose(base([mysql('pw'), postgres('pw'), mongodb('pw'), redis()]));
  assert.deepEqual(compose.services.mysql.volumes, [
    { type: 'volume', source: 'envhub-shop-mysql-data', target: '/var/lib/mysql' },
  ]);
  assert.equal(compose.services.postgres.volumes[0].target, '/var/lib/postgresql/data');
  assert.equal(compose.services.mongodb.volumes[0].target, '/data/db');
  assert.equal(compose.services.redis.volumes[0].target, '/data');
});

test('top level volumes are named and labeled for cleanup', () => {
  const compose = generateCompose(base([mysql('pw')]));
  assert.deepEqual(compose.volumes['envhub-shop-mysql-data'], {
    name: 'envhub-shop-mysql-data',
    labels: {
      'com.envhub.managed': 'true',
      'com.envhub.project': 'shop',
      'com.envhub.service': 'mysql',
    },
  });
});

test('no volumes key when no service has data volumes', () => {
  const compose = generateCompose(base([{ name: 'web', image: 'nginx' }]));
  assert.equal(compose.volumes, undefined);
  assert.equal(compose.services.web.volumes, undefined);
});

test('bind mounts and data volumes can be mixed', () => {
  const svc = { name: 'db', image: 'mysql:8.0', volumes: [{ source: '/home/a', target: '/x' }], dataVolumes: [{ name: 'data', target: '/d' }] };
  const compose = generateCompose(base([svc]));
  assert.equal(compose.services.db.volumes.length, 2);
  assert.equal(compose.services.db.volumes[0].type, 'bind');
  assert.equal(compose.services.db.volumes[1].type, 'volume');
});

test('rejects an invalid data volume', () => {
  assert.throws(() => validateProject(base([{ name: 'db', image: 'mysql', dataVolumes: [{ name: 'Bad Name', target: '/d' }] }])), /data volume name/);
  assert.throws(() => validateProject(base([{ name: 'db', image: 'mysql', dataVolumes: [{ name: 'data', target: 'relative' }] }])), /data volume target/);
});
