'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeDbName, dbNameOf } = require('../main/stacks/services');
const { createDatabaseCommand, databaseSteps, ensureDatabases } = require('../main/docker/database');
const { connectionText } = require('../main/stacks/connection');
const { describeForEdit, applyServiceEdit } = require('../main/stacks/edit');

test('normalizeDbName accepts plain names and treats empty as the default', () => {
  assert.equal(normalizeDbName('shop'), 'shop');
  assert.equal(normalizeDbName(' shop_2 '), 'shop_2');
  assert.equal(normalizeDbName(''), undefined);
  assert.equal(normalizeDbName('   '), undefined);
  assert.equal(normalizeDbName(undefined), undefined);
});

test('normalizeDbName refuses anything that is not a plain identifier', () => {
  for (const bad of ['Shop', '2shop', 'my-db', 'a b', 'x`; DROP', "it's", 'a'.repeat(42)]) {
    assert.throws(() => normalizeDbName(bad), /Database name/, bad);
  }
});

test('dbNameOf falls back to app', () => {
  assert.equal(dbNameOf({}), 'app');
  assert.equal(dbNameOf({ dbName: 'shop' }), 'shop');
});

test('no database command is made for the default name', () => {
  const services = [{ name: 'mysql' }, { name: 'postgres' }];
  assert.deepEqual(databaseSteps(services, 'proj', { dbName: 'app' }), []);
  assert.equal(createDatabaseCommand('mysql', 'c', 'app'), null);
});

test('mysql command creates the database and grants the app user, with escaped backticks', () => {
  const cmd = createDatabaseCommand('mysql', 'envhub-shop-mysql', 'shop');
  assert.equal(cmd.args[0], 'exec');
  assert.equal(cmd.args[1], 'envhub-shop-mysql');
  const script = cmd.args[cmd.args.length - 1];
  assert.match(script, /CREATE DATABASE IF NOT EXISTS \\`shop\\`/);
  assert.match(script, /GRANT ALL PRIVILEGES ON \\`shop\\`\.\* TO 'app'@'%'/);
  assert.match(script, /\$MYSQL_ROOT_PASSWORD/);
  assert.ok(!script.includes('pw'), 'no password is written into the command');
});

test('postgres command uses createdb and treats "already exists" as done', () => {
  const cmd = createDatabaseCommand('postgres', 'envhub-shop-postgres', 'shop');
  assert.deepEqual(cmd.args, ['exec', 'envhub-shop-postgres', 'createdb', '-U', 'app', 'shop']);
  assert.match('createdb: error: database "shop" already exists', cmd.alreadyExists);
});

test('ensureDatabases reports a database that never becomes ready', async () => {
  const services = [{ name: 'mysql' }];
  const res = await ensureDatabases({ services, projectName: 'nope', dbName: 'shop', delay: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /Could not set up database shop in mysql/);
});

test('connection text uses the chosen database name', () => {
  const config = { services: [{ name: 'mysql' }, { name: 'postgres' }] };
  const text = connectionText({ config, ports: [], password: 'pw', dbName: 'shop' });
  assert.match(text, /MYSQL_URL=mysql:\/\/app:pw@mysql:3306\/shop/);
  assert.match(text, /database shop/);
  assert.match(text, /POSTGRES_URL=postgresql:\/\/app:pw@postgres:5432\/shop/);
  assert.doesNotMatch(text, /3306\/app\b/);
});

test('connection text defaults to app when no name is given', () => {
  const config = { services: [{ name: 'mysql' }] };
  const text = connectionText({ config, ports: [], password: 'pw' });
  assert.match(text, /mysql:3306\/app/);
});

test('applyServiceEdit stores a new name, keeps the old one when left out, and resets on empty', () => {
  const spec = { name: 'shop', stack: 'nestjs', nodeVersion: '22', options: { mysql: true }, dbName: 'old' };

  const renamed = applyServiceEdit(spec, { dbName: 'shop_new' });
  assert.equal(renamed.dbName, 'shop_new');

  const kept = applyServiceEdit(spec, {});
  assert.equal(kept.dbName, 'old');

  const reset = applyServiceEdit(spec, { dbName: '' });
  assert.equal(reset.dbName, undefined);

  assert.throws(() => applyServiceEdit(spec, { dbName: 'Bad Name' }), /Database name/);
});

test('describeForEdit shows the current database name, or app by default', () => {
  const base = { name: 'shop', stack: 'nestjs', nodeVersion: '22', options: { mysql: true } };
  assert.equal(describeForEdit(base).dbName, 'app');
  assert.equal(describeForEdit({ ...base, dbName: 'shop' }).dbName, 'shop');
});
