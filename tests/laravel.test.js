'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  laravelProject
} = require('../main/stacks/laravel');
const {
  scaffoldLaravel
} = require('../main/project/scaffold');
const {
  generateCompose,
  validateProject
} = require('../main/compose/generate');

const folder = path.join(os.tmpdir(), 'envhub-test-shop');

test('laravel project has nginx, php, mysql, redis and mailpit', () => {
  const project = laravelProject({
    name: 'shop',
    phpVersion: '8.3',
    folder,
    dbPassword: 'x'
  });
  const names = project.services.map((s) => s.name);
  assert.deepEqual(names, ['nginx', 'php', 'mysql', 'redis', 'mailpit']);
});

test('laravel project mounts the project folder and builds the PHP image', () => {
  const project = laravelProject({
    name: 'shop',
    phpVersion: '8.3',
    folder,
    dbPassword: 'x'
  });
  const php = project.services.find((s) => s.name === 'php');
  const nginx = project.services.find((s) => s.name === 'nginx');

  assert.equal(php.build.context, path.join(folder, 'docker', 'php'));
  assert.equal(php.image, 'envhub-shop-php');
  assert.deepEqual(nginx.volumes[0], {
    source: folder,
    target: '/var/www/html'
  });
});

test('generated compose for laravel validates and uses bind mounts', () => {
  const project = laravelProject({
    name: 'shop',
    phpVersion: '8.3',
    folder,
    dbPassword: 'x'
  });
  validateProject(project);
  const compose = generateCompose(project);

  assert.equal(compose.services.php.build.dockerfile, 'Dockerfile');
  assert.deepEqual(compose.services.php.volumes, [{
    type: 'bind',
    source: folder,
    target: '/var/www/html'
  }, ]);
  assert.deepEqual(compose.services.nginx.ports, ['127.0.0.1:8080:80']);
});

test('rejects unsupported PHP versions and bad names', () => {
  assert.throws(
    () => laravelProject({
      name: 'shop',
      phpVersion: '7.4',
      folder,
      dbPassword: 'x'
    }),
    /Unsupported PHP version/,
  );
  assert.throws(
    () => laravelProject({
      name: 'Shop!',
      phpVersion: '8.3',
      folder,
      dbPassword: 'x'
    }),
    /Invalid project name/,
  );
});

test('rejects a volume target that is not an absolute path', () => {
  const project = {
    name: 'shop',
    services: [{
      name: 'x',
      image: 'redis:7',
      volumes: [{
        source: folder,
        target: 'var/www'
      }],
    }],
  };
  assert.throws(() => validateProject(project), /volume target/);
});

test('scaffold creates the starter files and refuses an existing folder', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-scaffold-'));
  const created = scaffoldLaravel({
    baseDir,
    name: 'shop',
    phpVersion: '8.2'
  });

  assert.equal(created, path.join(baseDir, 'shop'));
  assert.ok(fs.existsSync(path.join(created, 'public', 'index.php')));
  assert.ok(fs.existsSync(path.join(created, 'docker', 'php', 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(created, 'docker', 'nginx', 'default.conf')));

  const dockerfile = fs.readFileSync(path.join(created, 'docker', 'php', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM php:8\.2-fpm/);
  assert.match(dockerfile, /pdo_mysql/);

  assert.throws(
    () => scaffoldLaravel({
      baseDir,
      name: 'shop',
      phpVersion: '8.2'
    }),
    /already exists/,
  );
});
