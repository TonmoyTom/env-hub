'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { laravelProject, normalizeOptions } = require('../main/stacks/laravel');
const { nodeProject, normalizeNodeOptions } = require('../main/stacks/node');
const { connectionText } = require('../main/stacks/connection');
const { buildProject, stackLabel, mainWebService, mainWebPort } = require('../main/stacks');
const { dockerProject } = require('../main/stacks/docker');
const { scaffoldNode, scaffoldDocker } = require('../main/project/scaffold');
const { generateCompose, validateProject } = require('../main/compose/generate');

const folder = path.join(os.tmpdir(), 'envhub-test-stacks');
const ALL = { mysql: true, redis: true, phpmyadmin: true, node: true, mailpit: true };
const names = (project) => project.services.map((s) => s.name);

test('laravel with every option has all seven services', () => {
  const project = laravelProject({ name: 'shop', phpVersion: '8.3', folder, dbPassword: 'x', options: ALL });
  assert.deepEqual(names(project), ['nginx', 'php', 'mysql', 'redis', 'phpmyadmin', 'mailpit', 'node']);
});

test('laravel with only redis has nginx, php and redis', () => {
  const options = { mysql: false, redis: true, phpmyadmin: false, node: false, mailpit: false };
  const project = laravelProject({ name: 'shop', phpVersion: '8.3', folder, dbPassword: 'x', options });
  assert.deepEqual(names(project), ['nginx', 'php', 'redis']);
});

test('phpMyAdmin is wired to the mysql service', () => {
  const project = laravelProject({ name: 'shop', phpVersion: '8.3', folder, dbPassword: 'secret', options: ALL });
  const pma = project.services.find((s) => s.name === 'phpmyadmin');

  assert.equal(pma.image, 'phpmyadmin:5');
  assert.equal(pma.env.PMA_HOST, 'mysql');
  assert.equal(pma.env.PMA_PASSWORD, 'secret');
  assert.deepEqual(pma.ports, [{ host: 8081, container: 80 }]);
});

test('laravel node service runs npm in the project folder', () => {
  const project = laravelProject({ name: 'shop', phpVersion: '8.3', folder, dbPassword: 'x', options: ALL });
  const node = project.services.find((s) => s.name === 'node');

  assert.equal(node.image, 'node:22-alpine');
  assert.equal(node.workingDir, '/var/www/html');
  assert.deepEqual(node.volumes, [{ source: folder, target: '/var/www/html' }]);
  assert.match(node.command[2], /npm run dev -- --host 0\.0\.0\.0/);
  assert.match(node.command[2], /No package\.json yet/);
});

test('options: phpMyAdmin needs MySQL, missing options mean the old service set', () => {
  assert.throws(
    () => normalizeOptions({ mysql: false, phpmyadmin: true }),
    /phpMyAdmin needs MySQL/,
  );
  assert.deepEqual(normalizeOptions(undefined), {
    mysql: true, redis: true, phpmyadmin: false, node: false, mailpit: true,
  });
  assert.throws(() => normalizeOptions('all'), /Invalid options/);
});

test('NestJS is a single node service on port 3000', () => {
  const project = nodeProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder });
  assert.deepEqual(names(project), ['node']);

  const node = project.services[0];
  assert.equal(node.image, 'node:22-alpine');
  assert.deepEqual(node.ports, [{ host: 3000, container: 3000 }]);
  assert.deepEqual(node.volumes, [{ source: folder, target: '/app' }]);
  assert.match(node.command[2], /npm run start:dev/);
});

test('Next.js starts the dev server on all interfaces', () => {
  const project = nodeProject({ name: 'site', stack: 'nextjs', nodeVersion: '20', folder });
  assert.equal(project.services[0].image, 'node:20-alpine');
  assert.match(project.services[0].command[2], /npm run dev -- -H 0\.0\.0\.0/);
});

test('node stacks reject bad input', () => {
  assert.throws(() => nodeProject({ name: 'api', stack: 'rails', nodeVersion: '22', folder }), /Unsupported stack/);
  assert.throws(() => nodeProject({ name: 'api', stack: 'nestjs', nodeVersion: '14', folder }), /Unsupported Node version/);
  assert.throws(() => nodeProject({ name: 'Api!', stack: 'nestjs', nodeVersion: '22', folder }), /Invalid project name/);
});

test('generated compose carries command, working_dir and env for a node service', () => {
  const compose = generateCompose(nodeProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder }));
  const node = compose.services.node;

  assert.equal(node.working_dir, '/app');
  assert.equal(node.command[0], 'sh');
  assert.equal(node.environment.CHOKIDAR_USEPOLLING, 'true');
  assert.deepEqual(node.ports, ['127.0.0.1:3000:3000']);
  assert.equal(node.labels['com.envhub.stack'], 'nestjs');
});

test('validation rejects a bad command or working directory', () => {
  const base = { name: 'x', image: 'node:22-alpine' };
  const wrap = (svc) => ({ name: 'api', services: [{ ...base, ...svc }] });

  assert.throws(() => validateProject(wrap({ command: 'npm start' })), /Invalid command/);
  assert.throws(() => validateProject(wrap({ command: [] })), /Invalid command/);
  assert.throws(() => validateProject(wrap({ command: ['ok', 5] })), /Invalid command/);
  assert.throws(() => validateProject(wrap({ workingDir: 'app' })), /Invalid working directory/);
});

test('buildProject picks the right stack and passes others through', () => {
  const laravel = buildProject({ name: 'shop', stack: 'laravel', phpVersion: '8.3', folder, options: ALL }, 'x');
  assert.equal(laravel.services.length, 7);

  const nest = buildProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder });
  assert.deepEqual(names(nest), ['node']);

  const demo = { name: 'demo', stack: 'custom', services: [{ name: 'redis', image: 'redis:7' }] };
  assert.equal(buildProject(demo), demo);
});

test('labels and the main page service', () => {
  assert.equal(stackLabel({ stack: 'laravel', phpVersion: '8.2' }), 'Laravel · PHP 8.2');
  assert.equal(stackLabel({ stack: 'nextjs', nodeVersion: '22' }), 'Next.js · Node 22');
  assert.equal(stackLabel({ stack: 'custom' }), 'Custom');
  assert.equal(mainWebService({ stack: 'laravel' }), 'nginx');
  assert.equal(mainWebService({ stack: 'nestjs' }), 'node');
});

test('scaffoldNode writes a placeholder app and refuses an existing folder', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-node-'));
  const created = scaffoldNode({ baseDir, name: 'api', stack: 'nestjs', nodeVersion: '22' });

  const pkg = JSON.parse(fs.readFileSync(path.join(created, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['start:dev'], 'node server.js');
  assert.equal(pkg.scripts.dev, 'node server.js');
  assert.match(fs.readFileSync(path.join(created, 'server.js'), 'utf8'), /listen\(3000, '0\.0\.0\.0'\)/);

  assert.throws(
    () => scaffoldNode({ baseDir, name: 'api', stack: 'nestjs', nodeVersion: '22' }),
    /already exists/,
  );
});

const NODE_ALL = {
  mysql: true, postgres: true, mongodb: true, redis: true, phpmyadmin: true, adminer: true, mailpit: true,
};
const nest = (options, dbPassword = 'pw123') => nodeProject({
  name: 'api', stack: 'nestjs', nodeVersion: '22', folder, dbPassword, options,
});

test('NestJS with every service has node and all seven others', () => {
  assert.deepEqual(names(nest(NODE_ALL)), [
    'node', 'mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit',
  ]);
});

test('NestJS is Node only when no options are given', () => {
  assert.deepEqual(names(nest(undefined)), ['node']);
});

test('PostgreSQL and MongoDB get the shared credentials', () => {
  const project = nest({ postgres: true, mongodb: true });
  const pg = project.services.find((s) => s.name === 'postgres');
  const mongo = project.services.find((s) => s.name === 'mongodb');

  assert.equal(pg.image, 'postgres:16');
  assert.deepEqual(pg.env, { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'pw123' });
  assert.deepEqual(pg.ports, [{ host: 5432, container: 5432 }]);
  assert.equal(mongo.image, 'mongo:7');
  assert.equal(mongo.env.MONGO_INITDB_ROOT_USERNAME, 'root');
  assert.equal(mongo.env.MONGO_INITDB_ROOT_PASSWORD, 'pw123');
});

test('Adminer opens on the database that is there', () => {
  const pgOnly = nest({ postgres: true, adminer: true });
  assert.equal(pgOnly.services.find((s) => s.name === 'adminer').env.ADMINER_DEFAULT_SERVER, 'postgres');

  const both = nest({ mysql: true, postgres: true, adminer: true });
  assert.equal(both.services.find((s) => s.name === 'adminer').env.ADMINER_DEFAULT_SERVER, 'mysql');
});

test('Node options: tools need their database, nothing is on by default', () => {
  assert.throws(() => normalizeNodeOptions({ phpmyadmin: true }), /phpMyAdmin needs MySQL/);
  assert.throws(() => normalizeNodeOptions({ adminer: true, mongodb: true }), /Adminer needs MySQL or PostgreSQL/);
  assert.throws(() => normalizeNodeOptions([]), /Invalid options/);

  const none = normalizeNodeOptions(undefined);
  assert.equal(Object.values(none).some(Boolean), false);
});

test('generated compose for NestJS with services is valid and labelled', () => {
  const project = nest(NODE_ALL);
  validateProject(project);
  const compose = generateCompose(project);

  assert.equal(Object.keys(compose.services).length, 8);
  assert.equal(compose.services.postgres.labels['com.envhub.service'], 'postgres');
  assert.equal(compose.services.adminer.ports[0], '127.0.0.1:8082:8080');
});

test('connection text for NestJS lists .env lines, ports and pages', () => {
  const config = nest({ mysql: true, redis: true, phpmyadmin: true });
  const ports = [
    { service: 'mysql', container: 3306, host: 3307 },
    { service: 'redis', container: 6379, host: 6379 },
    { service: 'phpmyadmin', container: 80, host: 8081 },
  ];
  const text = connectionText({ config, ports, password: 'pw123' });

  assert.match(text, /MYSQL_URL=mysql:\/\/app:pw123@mysql:3306\/app/);
  assert.match(text, /DATABASE_URL=mysql:\/\/app:pw123@mysql:3306\/app/);
  assert.match(text, /REDIS_URL=redis:\/\/redis:6379/);
  assert.match(text, /Host localhost\s+Port 3307/);
  assert.match(text, /http:\/\/localhost:8081/);
  assert.doesNotMatch(text, /POSTGRES_URL/);
});

test('with two SQL databases there is no ambiguous DATABASE_URL', () => {
  const config = nest({ mysql: true, postgres: true });
  const text = connectionText({ config, ports: [], password: 'pw123' });

  assert.match(text, /MYSQL_URL=/);
  assert.match(text, /POSTGRES_URL=postgresql:\/\/app:pw123@postgres:5432\/app/);
  assert.doesNotMatch(text, /DATABASE_URL/);
});

test('connection text for Laravel uses the usual DB_ variables', () => {
  const config = laravelProject({ name: 'shop', phpVersion: '8.3', folder, dbPassword: 'pw123', options: ALL });
  const text = connectionText({ config, ports: [], password: 'pw123' });

  assert.match(text, /DB_HOST=mysql/);
  assert.match(text, /DB_DATABASE=app/);
  assert.match(text, /DB_PASSWORD=pw123/);
  assert.match(text, /REDIS_HOST=redis/);
  assert.match(text, /MAIL_HOST=mailpit/);
  assert.match(text, /MAIL_PORT=1025/);
});

test('connection text says so when there is nothing to connect to', () => {
  const config = nodeProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder });
  assert.equal(connectionText({ config, ports: [], password: '' }), 'This project has no database or other services.');
});

test('Vue runs Vite on 5173 and Nuxt on 3000', () => {
  const vue = nodeProject({ name: 'ui', stack: 'vue', nodeVersion: '22', folder });
  assert.deepEqual(vue.services[0].ports, [{ host: 5173, container: 5173 }]);
  assert.match(vue.services[0].command[2], /npm run dev -- --host 0\.0\.0\.0/);

  const nuxt = nodeProject({ name: 'site', stack: 'nuxt', nodeVersion: '20', folder });
  assert.deepEqual(nuxt.services[0].ports, [{ host: 3000, container: 3000 }]);
  assert.equal(stackLabel({ stack: 'nuxt', nodeVersion: '20' }), 'Nuxt.js · Node 20');
  assert.equal(mainWebPort({ stack: 'vue' }), 5173);
});

test('Docker image stack mounts the folder and runs the chosen command', () => {
  const project = buildProject({
    name: 'py', stack: 'docker', image: 'python:3.12', containerPort: 8000,
    command: 'python -m http.server 8000', folder, options: { redis: true },
  }, 'x');
  validateProject(project);

  assert.deepEqual(names(project), ['app', 'redis']);
  const app = project.services[0];
  assert.equal(app.image, 'python:3.12');
  assert.deepEqual(app.ports, [{ host: 8000, container: 8000 }]);
  assert.deepEqual(app.volumes, [{ source: folder, target: '/app' }]);
  assert.deepEqual(app.command, ['sh', '-c', 'python -m http.server 8000']);
  assert.equal(stackLabel({ stack: 'docker', image: 'python:3.12' }), 'Docker image · python:3.12');
  assert.equal(mainWebService({ stack: 'docker' }), 'app');
  assert.equal(mainWebPort({ stack: 'docker', containerPort: 8000 }), 8000);
});

test('Docker image stack uses the image default command and a high host port for low ports', () => {
  const project = dockerProject({ name: 'web', image: 'nginx:stable', containerPort: 80, folder });
  assert.equal(project.services[0].command, undefined);
  assert.deepEqual(project.services[0].ports, [{ host: 8080, container: 80 }]);
});

test('Docker image stack picks a port by itself and gives it to the app as PORT', () => {
  const project = dockerProject({ name: 'py', image: 'python:3.12', containerPort: '', folder });
  assert.deepEqual(project.services[0].ports, [{ host: 8000, container: 8000 }]);
  assert.deepEqual(project.services[0].env, { PORT: '8000' });
  assert.equal(project.containerPort, 8000);
});

test('Docker image stack rejects a bad image, port or name', () => {
  const ok = { name: 'py', folder, image: 'python:3.12', containerPort: 8000 };
  assert.throws(() => dockerProject({ ...ok, image: 'Bad Image!' }), /Invalid image/);
  assert.throws(() => dockerProject({ ...ok, image: '' }), /Invalid image/);
  assert.throws(() => dockerProject({ ...ok, containerPort: 70000 }), /Invalid port/);
  assert.throws(() => dockerProject({ ...ok, containerPort: 'abc' }), /Invalid port/);
  assert.throws(() => dockerProject({ ...ok, name: 'Py!' }), /Invalid project name/);
});

test('scaffoldDocker makes a folder with a README and refuses an existing one', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-docker-'));
  const created = scaffoldDocker({ baseDir, name: 'py', image: 'python:3.12' });
  assert.match(fs.readFileSync(path.join(created, 'README.md'), 'utf8'), /python:3\.12/);
  assert.throws(() => scaffoldDocker({ baseDir, name: 'py', image: 'python:3.12' }), /already exists/);
});

const { normalizeExtraServices } = require('../main/stacks/extras');

test('extra services are cleaned, named from the image and added to any stack', () => {
  const extras = normalizeExtraServices([
    { image: 'rabbitmq:3-management', ports: '5672, 15672' },
    { image: 'getmeili/meilisearch:v1.10', ports: '7700', env: 'MEILI_ENV=development\nMEILI_NO_ANALYTICS=true' },
    { image: 'minio/minio:latest', ports: '9000,9001', command: 'server /data --console-address :9001' },
    { image: 'redis:7' },
  ]);
  assert.deepEqual(extras.map((e) => e.name), ['rabbitmq', 'meilisearch', 'minio', 'redis-2']);
  assert.deepEqual(extras[0].ports, [5672, 15672]);
  assert.equal(extras[1].env.MEILI_NO_ANALYTICS, 'true');
  assert.deepEqual(extras[2].command, ['server', '/data', '--console-address', ':9001']);

  const project = buildProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder, extraServices: extras });
  assert.deepEqual(names(project), ['node', 'rabbitmq', 'meilisearch', 'minio', 'redis-2']);
  assert.deepEqual(project.services[1].ports, [{ host: 5672, container: 5672 }, { host: 15672, container: 15672 }]);
  validateProject(project);

  const laravel = buildProject({ name: 'shop', stack: 'laravel', phpVersion: '8.3', folder, extraServices: extras }, 'x');
  assert.equal(laravel.services.length, 2 + 3 + 4); // nginx, php, the old default mysql, redis, mailpit, and the four extras
});

test('extra services reject bad input', () => {
  assert.deepEqual(normalizeExtraServices(undefined), []);
  assert.throws(() => normalizeExtraServices('x'), /Invalid extra services/);
  assert.throws(() => normalizeExtraServices([{ image: 'Bad Image!' }]), /Invalid image/);
  assert.throws(() => normalizeExtraServices([{ image: '' }]), /Invalid image/);
  assert.throws(() => normalizeExtraServices([{ image: 'redis:7', ports: '99999' }]), /Invalid port/);
  assert.throws(() => normalizeExtraServices([{ image: 'redis:7', env: 'NOEQUALS' }]), /Invalid environment line/);
  assert.throws(() => normalizeExtraServices([{ image: 'redis:7', env: 'bad key=1' }]), /Invalid env key/);
  assert.throws(() => normalizeExtraServices(Array(9).fill({ image: 'redis:7' })), /at most 8/);
});

test('Docker image app stays open like docker run -it, so shell images do not restart in a loop', () => {
  const project = dockerProject({ name: 'go', image: 'golang:1.23', containerPort: 8080, folder });
  const compose = generateCompose(project);
  assert.equal(compose.services.app.tty, true);
  assert.equal(compose.services.app.stdin_open, true);

  const other = generateCompose(nodeProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder }));
  assert.equal(other.services.node.tty, undefined);
  assert.throws(() => validateProject({ name: 'x', services: [{ name: 'a', image: 'redis:7', keepOpen: 'yes' }] }), /keepOpen/);
});
