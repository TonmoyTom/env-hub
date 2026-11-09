'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isInside, removeProjectFolder } = require('../main/project/folders');

test('isInside accepts subfolders only', () => {
  const base = path.join(os.tmpdir(), 'envhub-projects');
  assert.equal(isInside(base, path.join(base, 'shop')), true);
  assert.equal(isInside(base, base), false);
  assert.equal(isInside(base, path.join(base, '..', 'other')), false);
  assert.equal(isInside(base, path.join(base, 'a', '..', '..', 'x')), false);
  assert.equal(isInside(base, os.homedir()), false);
  assert.equal(isInside(base, ''), false);
  assert.equal(isInside(base, undefined), false);
});

test('removeProjectFolder deletes the folder and its files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-del-'));
  const folder = path.join(base, 'shop');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'src', 'a.txt'), 'x');

  const res = removeProjectFolder(base, folder);
  assert.equal(res.deleted, true);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(base), true);
});

test('removeProjectFolder leaves folders outside the base and reports a missing one', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-del-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-keep-'));

  const res = removeProjectFolder(base, outside);
  assert.equal(res.deleted, false);
  assert.match(res.error, /outside/);
  assert.equal(fs.existsSync(outside), true);

  assert.deepEqual(removeProjectFolder(base, path.join(base, 'nope')), { deleted: false, missing: true, error: null });
});
