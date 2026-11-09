'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeEnvFile } = require('../main/project/envfile');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-env-'));
  const folder = path.join(base, 'shop');
  fs.mkdirSync(folder);
  return { base, folder };
}

test('creates .env when there is none', () => {
  const { base, folder } = setup();
  const res = writeEnvFile(base, folder, 'A=1\n');
  assert.equal(res.status, 'created');
  assert.equal(fs.readFileSync(path.join(folder, '.env'), 'utf8'), 'A=1\n');
});

test('same content is left alone', () => {
  const { base, folder } = setup();
  writeEnvFile(base, folder, 'A=1\n');
  assert.equal(writeEnvFile(base, folder, 'A=1\n').status, 'unchanged');
  assert.equal(fs.existsSync(path.join(folder, '.env.envhub-backup')), false);
});

test('a different .env is backed up, each time with a new name', () => {
  const { base, folder } = setup();
  fs.writeFileSync(path.join(folder, '.env'), 'MINE=1\n');
  const first = writeEnvFile(base, folder, 'A=1\n');
  assert.equal(first.status, 'updated');
  assert.equal(fs.readFileSync(first.backup, 'utf8'), 'MINE=1\n');
  const second = writeEnvFile(base, folder, 'A=2\n');
  assert.notEqual(second.backup, first.backup);
  assert.equal(fs.readFileSync(second.backup, 'utf8'), 'A=1\n');
  assert.equal(fs.readFileSync(first.backup, 'utf8'), 'MINE=1\n');
});

test('refuses a folder outside the projects folder and a missing folder', () => {
  const { base, folder } = setup();
  assert.throws(() => writeEnvFile(path.join(base, 'other'), folder, 'A=1\n'), /outside/);
  assert.throws(() => writeEnvFile(base, path.join(base, 'gone'), 'A=1\n'), /does not exist/);
});

test('does not follow a .env link', { skip: process.platform === 'win32' }, () => {
  const { base, folder } = setup();
  const target = path.join(base, 'secret');
  fs.writeFileSync(target, 'X');
  fs.symlinkSync(target, path.join(folder, '.env'));
  assert.throws(() => writeEnvFile(base, folder, 'A=1\n'), /link/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'X');
});
