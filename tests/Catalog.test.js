'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadCatalog, describeService, imageRepo, findEntry } = require('../main/catalog/catalog');

const { entries } = loadCatalog(null);

test('catalog: image names are matched without registry, library/ and tag', () => {
  assert.strictEqual(imageRepo('axllent/mailpit:edge'), 'axllent/mailpit');
  assert.strictEqual(imageRepo('docker.io/library/redis:7-alpine'), 'redis');
  assert.strictEqual(imageRepo('ghcr.io/acme/app@sha256:abc'), 'ghcr.io/acme/app');
  assert.strictEqual(imageRepo('localhost:5000/team/db:1'), 'localhost:5000/team/db');
  assert.strictEqual(findEntry(entries, 'mariadb:11').id, 'mysql');
  assert.strictEqual(findEntry(entries, 'rediscommander/redis-commander:latest').id, 'redis-commander');
  assert.strictEqual(findEntry(entries, 'someone/unknown:1'), null);
});

test('catalog: Mailpit added as an extra service without ports (the real case)', () => {
  const card = describeService(entries, { name: 'mailpit-2', image: 'axllent/mailpit:edge', env: {}, ports: [] });
  assert.strictEqual(card.label, 'Mailpit');
  assert.strictEqual(card.env.docker, 'MAIL_MAILER=smtp\nMAIL_HOST=mailpit-2\nMAIL_PORT=1025\nMAIL_USERNAME=null\nMAIL_PASSWORD=null\nMAIL_ENCRYPTION=null');
  // No published port: nothing for "this computer", and no web page to open.
  assert.strictEqual(card.env.host, null);
  assert.strictEqual(card.web, null);
});

test('catalog: published ports are used from this computer', () => {
  const card = describeService(entries, { name: 'mail', image: 'axllent/mailpit', env: {}, ports: [{ container: 1025, host: 1026 }, { container: 8025, host: 8026 }] });
  assert.match(card.env.host, /MAIL_HOST=127\.0\.0\.1\nMAIL_PORT=1026/);
  assert.deepStrictEqual(card.web, { port: 8026, url: 'http://localhost:8026' });
});

test('catalog: MySQL credentials come from the service environment, with fallbacks', () => {
  const card = describeService(entries, {
    name: 'db2',
    image: 'mysql:8.4',
    env: { MYSQL_ROOT_PASSWORD: 'rootpw', MYSQL_DATABASE: 'shop' },
    ports: [{ container: 3306, host: 3399 }],
  });
  const field = (label) => card.fields.find((f) => f.label === label);
  assert.strictEqual(field('User').value, 'root');
  assert.strictEqual(field('Password').value, 'rootpw');
  assert.strictEqual(field('Password').secret, true);
  assert.strictEqual(field('Database').value, 'shop');
  assert.match(card.env.docker, /DB_HOST=db2\nDB_PORT=3306\nDB_DATABASE=shop\nDB_USERNAME=root\nDB_PASSWORD=rootpw/);
  assert.match(card.env.host, /DB_HOST=127\.0\.0\.1\nDB_PORT=3399/);
});

test('catalog: Redis without a password says null, MongoDB builds a URL with or without a user', () => {
  const redis = describeService(entries, { name: 'cache', image: 'valkey/valkey:8', env: {}, ports: [] });
  assert.match(redis.env.docker, /REDIS_PASSWORD=null/);
  const mongoAuth = describeService(entries, { name: 'mongo2', image: 'mongo:7', env: { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: 'p@ss' }, ports: [] });
  assert.strictEqual(mongoAuth.env.docker, 'MONGODB_URI=mongodb://admin:p%40ss@mongo2:27017/?authSource=admin');
  const mongoOpen = describeService(entries, { name: 'mongo3', image: 'mongo', env: {}, ports: [] });
  assert.strictEqual(mongoOpen.env.docker, 'MONGODB_URI=mongodb://mongo3:27017/?authSource=admin');
});

test('catalog: an unknown image still shows its ports and environment values', () => {
  const card = describeService(entries, { name: 'thing', image: 'acme/thing:2', env: { API_TOKEN: 'x', MODE: 'dev' }, ports: [{ container: 9000, host: 9001 }] });
  assert.strictEqual(card.known, false);
  assert.strictEqual(card.env, null);
  assert.deepStrictEqual(card.fields.map((f) => [f.label, f.secret]), [['Port 9000', false], ['API_TOKEN', true], ['MODE', false]]);
});

test('catalog: the user file adds entries and replaces a built-in one by id; a broken file is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-catalog-'));
  try {
    const file = path.join(dir, 'services-catalog.json');
    fs.writeFileSync(file, JSON.stringify({ services: [
      { id: 'mailpit', label: 'My Mailpit', match: ['axllent/mailpit'], ports: { smtp: 2525 }, env: ['MAIL_PORT={port:smtp}'] },
      { id: 'acme', label: 'Acme', match: ['acme/thing'], ports: {}, env: ['ACME=1'] },
      { id: 'BAD ID', match: ['x'] },
    ] }));
    const loaded = loadCatalog(file);
    assert.strictEqual(loaded.error, '');
    assert.strictEqual(findEntry(loaded.entries, 'axllent/mailpit').label, 'My Mailpit');
    assert.strictEqual(findEntry(loaded.entries, 'acme/thing:1').label, 'Acme');
    assert.strictEqual(loaded.entries.filter((e) => e.id === 'mailpit').length, 1);
    fs.writeFileSync(file, '{ not json');
    const broken = loadCatalog(file);
    assert.match(broken.error, /services-catalog\.json/);
    assert.ok(findEntry(broken.entries, 'redis'), 'the built-in catalog still works');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
