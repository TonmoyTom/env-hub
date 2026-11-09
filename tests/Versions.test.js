'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../main/registry/versions');
const builtin = require('../main/registry/versions').snapshot();
const { mysql, postgres, mongodb, redis } = require('../main/stacks/services');
const { generateCompose } = require('../main/compose/generate');
const { buildProject } = require('../main/stacks');
const { applyServiceEdit, describeForEdit } = require('../main/stacks/edit');

test('built in file has every key with a default that is in its list', () => {
  for (const key of registry.KEYS) {
    assert.ok(builtin[key].versions.includes(builtin[key].default), key);
  }
});

test('merge adds the user versions, newest first, without duplicates', () => {
  const { registry: merged, warnings } = registry.mergeRegistry(builtin, { php: { versions: ['8.5', '8.3', '8.10'] } });
  assert.deepEqual(merged.php.versions, ['8.10', '8.5', '8.3', '8.2', '8.1']);
  assert.equal(merged.php.default, '8.3');
  assert.deepEqual(warnings, []);
});

test('merge can change the default, but only to a version in the list', () => {
  assert.equal(registry.mergeRegistry(builtin, { node: { default: '24', versions: ['24'] } }).registry.node.default, '24');
  const bad = registry.mergeRegistry(builtin, { node: { default: '99', versions: [] } });
  assert.equal(bad.registry.node.default, '22');
  assert.equal(bad.warnings.length, 1);
});

test('merge skips wrong entries and reports them', () => {
  const { registry: merged, warnings } = registry.mergeRegistry(builtin, {
    mysql: { versions: ['9.1', '8.0; rm -rf', 'latest', 5] },
    redis: 'nope',
  });
  assert.ok(merged.mysql.versions.includes('9.1'));
  assert.equal(merged.mysql.versions.length, builtin.mysql.versions.length + 1);
  assert.equal(warnings.length, 4);
});

test('load: a missing file is fine, broken JSON is reported, a good file is merged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-ver-'));
  const file = path.join(dir, 'versions.json');
  assert.deepEqual(registry.load(file).warnings, []);
  fs.writeFileSync(file, '{ not json');
  assert.equal(registry.load(file).warnings.length, 1);
  assert.ok(registry.has('php', '8.3'));
  fs.writeFileSync(file, JSON.stringify({ php: { versions: ['8.4'] }, postgres: { versions: ['18'] } }));
  registry.load(file);
  assert.ok(registry.has('php', '8.4'));
  assert.ok(registry.has('postgres', '18'));
  registry.load(path.join(dir, 'gone.json'));
  assert.equal(registry.has('php', '8.4'), false);
});

test('services use the chosen version and keep the old versions when none is given', () => {
  assert.equal(mysql('pw').image, 'mysql:8.0');
  assert.equal(postgres('pw').image, 'postgres:16');
  assert.equal(mongodb('pw').image, 'mongo:7');
  assert.equal(redis().image, 'redis:7');
  assert.equal(mysql('pw', '8.4').image, 'mysql:8.4');
  assert.equal(postgres('pw', '17').image, 'postgres:17');
  assert.equal(mongodb('pw', '8').image, 'mongo:8');
  assert.equal(redis('6').image, 'redis:6');
  assert.equal(mysql('pw', 'bad;tag').image, 'mysql:8.0');
});

test('PostgreSQL 18 and newer use the new data folder', () => {
  assert.equal(postgres('pw', '17').dataVolumes[0].target, '/var/lib/postgresql/data');
  assert.equal(postgres('pw', '18').dataVolumes[0].target, '/var/lib/postgresql');
});

test('normalizeVersions validates and merges', () => {
  registry.load('/nonexistent/versions.json');
  assert.deepEqual(registry.normalizeVersions({ mysql: '8.4' }), { mysql: '8.4' });
  assert.deepEqual(registry.normalizeVersions({ redis: '6' }, { mysql: '8.4' }), { mysql: '8.4', redis: '6' });
  assert.equal(registry.normalizeVersions(undefined), undefined);
  assert.equal(registry.normalizeVersions({ mysql: '' }), undefined);
  assert.throws(() => registry.normalizeVersions({ mysql: '7.7' }), /Unsupported mysql version/);
  assert.throws(() => registry.normalizeVersions([]), /Invalid versions/);
});

test('a project builds with its saved versions, and old projects keep the old ones', () => {
  const base = { name: 'shop', stack: 'nestjs', nodeVersion: '22', folder: path.resolve('/home/x/shop'), options: { mysql: true, postgres: true, mongodb: true, redis: true } };
  const old = buildProject(base, 'pw');
  assert.deepEqual(old.services.map((s) => s.image).filter((i) => !i.startsWith('node')), ['mysql:8.0', 'postgres:16', 'mongo:7', 'redis:7']);
  const next = buildProject({ ...base, versions: { mysql: '8.4', postgres: '17' } }, 'pw');
  const images = next.services.map((s) => s.image);
  assert.ok(images.includes('mysql:8.4') && images.includes('postgres:17') && images.includes('mongo:7'));
  generateCompose(next);
});

test('edit keeps, changes and shows the versions', () => {
  const spec = { name: 'shop', stack: 'nestjs', nodeVersion: '22', folder: path.resolve('/x/shop'), options: { mysql: true } };
  assert.equal(describeForEdit(spec).versions.mysql, '8.0');
  const changed = applyServiceEdit(spec, { versions: { mysql: '8.4' } });
  assert.equal(changed.versions.mysql, '8.4');
  assert.equal(applyServiceEdit(changed, {}).versions.mysql, '8.4');
  assert.equal(describeForEdit(changed).versions.mysql, '8.4');
  assert.throws(() => applyServiceEdit(spec, { versions: { mysql: '1.0' } }), /Unsupported/);
});

// ----- Docker Hub versions -----

test('Docker Hub versions are added, but never older than the oldest built in one', () => {
  const remote = { php: ['8.5', '8.4', '8.0', '7.4'], node: ['24', '22', '18'], mysql: ['9.1', '5.7'], redis: ['8', 'latest', '7;x'] };
  const { registry: merged, warnings } = registry.mergeRegistry(builtin, null, remote);
  assert.deepEqual(merged.php.versions, ['8.5', '8.4', '8.3', '8.2', '8.1']);
  assert.deepEqual(merged.node.versions, ['24', '22', '20']);
  assert.deepEqual(merged.mysql.versions, ['9.1', '8.4', '8.0']);
  assert.deepEqual(merged.redis.versions, ['8', '7', '6']);
  assert.deepEqual(warnings, []);
});

test('Docker Hub versions never change a default', () => {
  const { registry: merged } = registry.mergeRegistry(builtin, null, { php: ['8.5'], node: ['24'], mysql: ['9.1'] });
  assert.equal(merged.php.default, builtin.php.default);
  assert.equal(merged.node.default, builtin.node.default);
  assert.equal(merged.mysql.default, builtin.mysql.default);
});

test('user file and Docker Hub lists are merged together', () => {
  const { registry: merged } = registry.mergeRegistry(builtin, { php: { versions: ['8.6'] } }, { php: ['8.5'] });
  assert.deepEqual(merged.php.versions, ['8.6', '8.5', '8.3', '8.2', '8.1']);
});

test('setRemote feeds has() and normalizeVersions, and null forgets it', () => {
  registry.load('/nonexistent/versions.json');
  registry.setRemote({ mysql: ['9.1'], php: ['8.5', 'bad'] });
  assert.ok(registry.has('mysql', '9.1'));
  assert.ok(registry.has('php', '8.5'));
  assert.equal(registry.has('php', 'bad'), false);
  assert.deepEqual(registry.normalizeVersions({ mysql: '9.1' }), { mysql: '9.1' });
  registry.load('/nonexistent/versions.json');
  assert.ok(registry.has('mysql', '9.1'), 'load keeps the Docker Hub lists');
  registry.setRemote(null);
  assert.equal(registry.has('mysql', '9.1'), false);
  assert.throws(() => registry.normalizeVersions({ mysql: '9.1' }), /Unsupported/);
});

test('cache: read, write and freshness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-cache-'));
  const file = path.join(dir, 'sub', 'versions-cache.json');
  assert.equal(registry.readCache(file), null);
  registry.writeCache(file, { php: ['8.5'] }, 1000);
  assert.deepEqual(registry.readCache(file), { fetchedAt: 1000, lists: { php: ['8.5'] } });
  assert.equal(registry.cacheIsFresh({ fetchedAt: 1000 }, 1000 + registry.CACHE_TTL_MS - 1), true);
  assert.equal(registry.cacheIsFresh({ fetchedAt: 1000 }, 1000 + registry.CACHE_TTL_MS), false);
  assert.equal(registry.cacheIsFresh({ fetchedAt: 5000 }, 1000), false);
  assert.equal(registry.cacheIsFresh(null), false);
  fs.writeFileSync(file, '{ broken');
  assert.equal(registry.readCache(file), null);
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: 'x', lists: {} }));
  assert.equal(registry.readCache(file), null);
});

test('refresh: fresh cache means no Docker Hub call, stale cache calls it and saves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-refresh-'));
  const file = path.join(dir, 'versions-cache.json');
  registry.load('/nonexistent/versions.json');
  registry.setRemote(null);
  let calls = 0;
  const fetchLists = async () => { calls += 1; return { lists: { php: ['8.5'], mysql: ['9.1'] }, errors: ['redis: no versions found'] }; };

  const first = await registry.refresh(file, fetchLists);
  assert.equal(first.source, 'hub');
  assert.deepEqual(first.errors, ['redis: no versions found']);
  assert.equal(calls, 1);
  assert.ok(registry.has('php', '8.5'));
  assert.deepEqual(registry.readCache(file).lists, { php: ['8.5'], mysql: ['9.1'] });

  registry.setRemote(null);
  const second = await registry.refresh(file, fetchLists);
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1, 'no second call while the cache is fresh');
  assert.ok(registry.has('mysql', '9.1'), 'cache is applied at once');

  const forced = await registry.refresh(file, fetchLists, true);
  assert.equal(forced.source, 'hub');
  assert.equal(calls, 2);
  registry.setRemote(null);
});

test('refresh: Docker Hub down keeps the cached and built in versions, nothing throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-down-'));
  const file = path.join(dir, 'versions-cache.json');
  registry.writeCache(file, { node: ['24'] }, Date.now() - registry.CACHE_TTL_MS - 5000);
  registry.setRemote(null);

  const down = await registry.refresh(file, async () => { throw new Error('offline'); });
  assert.equal(down.source, 'cache');
  assert.deepEqual(down.errors, ['offline']);
  assert.ok(registry.has('node', '24'), 'stale cache still used');
  assert.ok(registry.has('node', '22'));

  const empty = await registry.refresh(file, async () => ({ lists: {}, errors: ['all failed'] }));
  assert.equal(empty.source, 'cache');
  assert.ok(registry.readCache(file).fetchedAt < Date.now() - registry.CACHE_TTL_MS, 'a failed refresh does not look fresh');

  const partial = await registry.refresh(file, async () => ({ lists: { php: ['8.5'] }, errors: [] }));
  assert.equal(partial.source, 'hub');
  assert.deepEqual(registry.readCache(file).lists, { node: ['24'], php: ['8.5'] }, 'a list that failed keeps its cached versions');
  registry.setRemote(null);
});
