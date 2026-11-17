'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dockerFilesFor, dockerignoreText, previewDockerFiles, generateDockerFiles } = require('../main/project/docker-files');

const laravel = { name: 'shop', stack: 'laravel', phpVersion: '8.3', options: { mysql: true, phpmyadmin: true }, phpExtensions: ['gd'] };
const passwords = { app: 'apppass', root: 'rootpass' };

function tempFolder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-dfiles-'));
}

test('docker files: Laravel gets the PHP Dockerfile, nginx file, compose, .dockerignore and .env', () => {
  const files = dockerFilesFor(laravel, passwords, false);
  assert.deepStrictEqual(files.map((f) => f.path), ['docker/php/Dockerfile', 'docker/nginx/default.conf', 'docker-compose.yml', '.dockerignore', '.env']);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  assert.match(byPath['docker/php/Dockerfile'], /FROM php:8\.3-fpm/);
  assert.match(byPath['docker/php/Dockerfile'], /docker-php-ext-install .* gd/);
  assert.match(byPath['docker-compose.yml'], /mysql:/);
  assert.match(byPath['docker-compose.yml'], /phpmyadmin:/);
  // The compose file holds no password: they are in the env file.
  assert.doesNotMatch(byPath['docker-compose.yml'], /rootpass|apppass/);
  assert.match(byPath['.env'], /DB_PASSWORD=apppass/);
  assert.match(byPath['.env'], /DB_ROOT_PASSWORD=rootpass/);
});

test('docker files: a Node project gets one Dockerfile, and its own ignore list', () => {
  const node = { name: 'web', stack: 'nextjs', nodeVersion: '22', options: {} };
  assert.deepStrictEqual(dockerFilesFor(node, passwords, false).map((f) => f.path), ['Dockerfile', 'docker-compose.yml', '.dockerignore', '.env']);
  assert.match(dockerignoreText(node), /^\.next$/m);
  assert.doesNotMatch(dockerignoreText(node), /^vendor$/m);
  assert.match(dockerignoreText(laravel), /^vendor$/m);
  assert.match(dockerignoreText(laravel), /^\.env$/m);
});

test('docker files: preview writes nothing, Generate creates the files', () => {
  const folder = tempFolder();
  try {
    const spec = { ...laravel, folder };
    const before = previewDockerFiles(spec, passwords);
    assert.deepStrictEqual(before.services, ['nginx', 'php', 'mysql', 'phpmyadmin']);
    assert.ok(before.files.every((f) => f.status === 'new'));
    assert.strictEqual(before.command, 'docker compose up -d --build');
    assert.deepStrictEqual(fs.readdirSync(folder), []);

    const res = generateDockerFiles(spec, passwords);
    assert.strictEqual(res.written.length, 5);
    assert.deepStrictEqual(res.backups, []);
    assert.ok(fs.existsSync(path.join(folder, '.dockerignore')));
    assert.ok(fs.existsSync(path.join(folder, 'docker', 'php', 'Dockerfile')));

    // A second Generate changes nothing.
    const again = generateDockerFiles(spec, passwords);
    assert.deepStrictEqual(again.written, []);
    assert.strictEqual(again.same.length, 5);
    assert.ok(previewDockerFiles(spec, passwords).files.every((f) => f.status === 'same'));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('docker files: the project .env is never changed, and a replaced file is kept as .bak', () => {
  const folder = tempFolder();
  try {
    fs.writeFileSync(path.join(folder, '.env'), 'APP_KEY=mine\n');
    fs.writeFileSync(path.join(folder, 'docker-compose.yml'), 'services: {}\n');
    const spec = { ...laravel, folder };

    const preview = previewDockerFiles(spec, passwords);
    assert.strictEqual(preview.files.find((f) => f.path === 'docker-compose.yml').status, 'replace');
    assert.ok(preview.files.some((f) => f.path === '.env.docker'));
    assert.ok(!preview.files.some((f) => f.path === '.env'));
    assert.strictEqual(preview.command, 'docker compose --env-file .env.docker up -d --build');

    const res = generateDockerFiles(spec, passwords);
    assert.deepStrictEqual(res.backups, ['docker-compose.yml.bak']);
    assert.strictEqual(fs.readFileSync(path.join(folder, '.env'), 'utf8'), 'APP_KEY=mine\n');
    assert.strictEqual(fs.readFileSync(path.join(folder, 'docker-compose.yml.bak'), 'utf8'), 'services: {}\n');
    assert.match(fs.readFileSync(path.join(folder, '.env.docker'), 'utf8'), /DB_ROOT_PASSWORD=rootpass/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('docker files: a project without a folder is refused', () => {
  assert.throws(() => previewDockerFiles({ ...laravel, folder: path.join(os.tmpdir(), 'envhub-no-such-folder-x') }, passwords), /folder was not found/);
  assert.throws(() => generateDockerFiles({ ...laravel }, passwords), /folder was not found/);
});
