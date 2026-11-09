'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const projects = require('../main/store/projects');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-store-'));
}

test('removeSpec removes a project and it stays removed after a reload', () => {
  const dir = tempDir();
  projects.init(dir);
  projects.addSpec({ name: 'shop', stack: 'laravel', phpVersion: '8.3', folder: '/x/shop' });
  projects.setAssignments('shop', [{ service: 'nginx', container: 80, host: 8081 }]);

  projects.removeSpec('shop');
  assert.equal(projects.getSpec('shop'), null);
  assert.equal(projects.getAssignments('shop'), null);

  projects.init(dir);
  assert.equal(projects.getSpec('shop'), null);
  assert.ok(projects.getSpec('demo'));
});

test('removing every project leaves an empty list after a reload', () => {
  const dir = tempDir();
  projects.init(dir);
  for (const spec of projects.listSpecs()) {
    projects.removeSpec(spec.name);
  }

  projects.init(dir);
  assert.equal(projects.listSpecs().length, 0);
});

test('saved host ports survive a reload', () => {
  const dir = tempDir();
  projects.init(dir);
  projects.addSpec({ name: 'blog', stack: 'laravel', phpVersion: '8.3', folder: '/x/blog' });
  projects.setHostPorts('blog', { 'nginx:80': 8082 });

  projects.init(dir);
  assert.deepEqual(projects.getSpec('blog').hostPorts, { 'nginx:80': 8082 });
});
