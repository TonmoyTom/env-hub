'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { portableCompose, portableComposeYaml, portableEnvText } = require('../main/project/portable-compose');
const { scaffoldLaravel } = require('../main/project/scaffold');

const ALL = { mysql: true, redis: true, phpmyadmin: true, mailpit: true, node: true };

test('portable compose uses only relative bind paths', () => {
  const yaml = portableComposeYaml({ name: 'shop', phpVersion: '8.3', options: ALL, versions: {} });
  const binds = yaml.match(/"[^"]*:[^"]*"/g) || [];
  for (const b of binds) {
    assert.ok(!/["\s]C:|["\s]\//.test(b.replace(/^"\$\{[^}]*\}/, '')), `absolute path found: ${b}`);
  }
  assert.ok(yaml.includes('"./docker/php"'));
  assert.ok(yaml.includes('"./docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro"'));
  assert.ok(!yaml.includes('envhub-'), 'no envhub labels or container names in the portable file');
});

test('portable compose includes only the services that were chosen', () => {
  const only = portableCompose({ name: 'shop', phpVersion: '8.3', options: {}, versions: {} });
  assert.deepEqual(Object.keys(only.services), ['nginx', 'php']);
  assert.equal(only.services.php.depends_on, undefined);

  const full = portableCompose({ name: 'shop', phpVersion: '8.3', options: ALL, versions: {} });
  assert.deepEqual(Object.keys(full.services), ['nginx', 'php', 'mysql', 'redis', 'phpmyadmin', 'mailpit', 'node']);
  assert.deepEqual(Object.keys(full.volumes), ['mysql-data', 'redis-data']);
});

test('passwords come from .env, never written into the compose file', () => {
  const yaml = portableComposeYaml({ name: 'shop', phpVersion: '8.3', options: ALL, versions: {} });
  assert.ok(yaml.includes('${DB_PASSWORD:?'));
  assert.ok(yaml.includes('${DB_ROOT_PASSWORD:?'));
  const env = portableEnvText({ name: 'shop', options: ALL, dbPassword: 'abc123', rootPassword: 'abc123' });
  assert.ok(env.includes('DB_PASSWORD=abc123\n'));
  assert.ok(env.includes('DB_ROOT_PASSWORD=abc123\n'));
  assert.ok(!yaml.includes('abc123'));
});

test('env file has no database keys when mysql is off', () => {
  const env = portableEnvText({ name: 'shop', options: {}, dbPassword: 'x', rootPassword: 'x' });
  assert.ok(!env.includes('DB_PASSWORD'));
  assert.ok(env.includes('APP_PORT=8080'));
});

test('scaffoldLaravel writes docker-compose.yml, Dockerfile and .env into the project folder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-portable-'));
  const folder = scaffoldLaravel({
    baseDir: base,
    name: 'shop',
    phpVersion: '8.3',
    options: { mysql: true, redis: true },
    versions: {},
    dbPassword: 'pw1234',
  });
  assert.ok(fs.existsSync(path.join(folder, 'docker-compose.yml')));
  assert.ok(fs.existsSync(path.join(folder, 'docker', 'php', 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(folder, 'docker', 'nginx', 'default.conf')));
  const env = fs.readFileSync(path.join(folder, '.env'), 'utf8');
  assert.ok(env.includes('DB_PASSWORD=pw1234'));
  assert.ok(fs.readFileSync(path.join(folder, '.gitignore'), 'utf8').includes('.env'));
  fs.rmSync(base, { recursive: true, force: true });
});

const { portableDockerfile, portableFiles } = require('../main/project/portable-compose');

test('node stack gets a Dockerfile with its Node version and port', () => {
  const df = portableDockerfile({ stack: 'nestjs', nodeVersion: '22' });
  assert.ok(df.startsWith('FROM node:22-alpine'));
  assert.ok(df.includes('EXPOSE 3000'));
  const vue = portableDockerfile({ stack: 'vue', nodeVersion: '20' });
  assert.ok(vue.includes('EXPOSE 5173'));
});

test('node compose builds from the folder and runs the stack command with a relative mount', () => {
  const yaml = portableFiles({ stack: 'nestjs', name: 'api', nodeVersion: '22', options: { postgres: true }, versions: {} }).compose;
  assert.ok(yaml.includes('"./:/app"'));
  assert.ok(yaml.includes('npm run start:dev'));
  assert.ok(yaml.includes('"postgres"'));
  assert.ok(!yaml.includes('C:'));
});

test('docker image stack has a Dockerfile from the chosen image and the port in .env', () => {
  const files = portableFiles({ stack: 'docker', name: 'py', image: 'python:3.12', containerPort: 8000, options: {}, versions: {}, dbPassword: 'pw' });
  assert.ok(files.dockerfile.includes('FROM python:3.12'));
  assert.ok(files.env.includes('APP_PORT=8000'));
});

test('scaffoldNode and scaffoldDocker write the portable files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-portable-node-'));
  const { scaffoldNode, scaffoldDocker } = require('../main/project/scaffold');
  const n = scaffoldNode({ baseDir: base, name: 'api', stack: 'nestjs', nodeVersion: '22', options: {}, versions: {}, dbPassword: 'pw' });
  assert.ok(fs.existsSync(path.join(n, 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(n, 'docker-compose.yml')));
  const d = scaffoldDocker({ baseDir: base, name: 'py', image: 'python:3.12', containerPort: 8000, options: {}, versions: {}, dbPassword: 'pw' });
  assert.ok(fs.readFileSync(path.join(d, 'Dockerfile'), 'utf8').includes('FROM python:3.12'));
  assert.ok(fs.existsSync(path.join(d, '.env')));
  fs.rmSync(base, { recursive: true, force: true });
});

const { languageOf, languageCommand } = require('../main/stacks/languages');

test('known languages are detected from the image name', () => {
  assert.equal(languageOf('python:3.12').key, 'python');
  assert.equal(languageOf('golang:1.23').key, 'go');
  assert.equal(languageOf('rust:1.80').key, 'rust');
  assert.equal(languageOf('eclipse-temurin:21').key, 'java');
  assert.equal(languageOf('nginx:stable'), null);
  assert.equal(languageCommand('python:3.12'), 'python app.py');
});

test('python Dockerfile installs requirements.txt; go Dockerfile downloads modules', () => {
  assert.ok(portableDockerfile({ stack: 'docker', image: 'python:3.12', containerPort: 8000 }).includes('pip install'));
  assert.ok(portableDockerfile({ stack: 'docker', image: 'golang:1.23', containerPort: 8000 }).includes('go mod download'));
});

test('extra services are written into the compose file with ports on this computer', () => {
  const yaml = portableComposeYaml({
    stack: 'docker', name: 'py', image: 'python:3.12', containerPort: 8000, options: {}, versions: {},
    extraServices: [{ name: 'minio', image: 'minio/minio', ports: [9000], env: { MINIO_ROOT_USER: 'a' }, command: ['server', '/data'] }],
  });
  assert.ok(yaml.includes('minio:'));
  assert.ok(yaml.includes('"127.0.0.1:9000:9000"'));
  assert.ok(yaml.includes('"minio/minio"'));
});
