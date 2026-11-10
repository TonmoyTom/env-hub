'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installArgs, mergeEnv, INSTALLABLE_STACKS } = require('../main/project/installer');
const { scaffoldNode, scaffoldLaravel, finishInstall } = require('../main/project/scaffold');

test('every creatable app stack has an install command', () => {
  assert.deepStrictEqual(INSTALLABLE_STACKS.sort(), ['laravel', 'nestjs', 'nextjs', 'nuxt', 'vue']);
});

test('installArgs mounts the folder and uses the right image', () => {
  const node = installArgs({ stack: 'nextjs', name: 'web', folder: 'C:/x/web', nodeVersion: '22' });
  assert.ok(node.includes('node:22-alpine'));
  assert.ok(node.includes('type=bind,source=C:/x/web,target=/app'));
  const php = installArgs({ stack: 'laravel', name: 'shop', folder: '/x/shop', phpVersion: '8.3' });
  assert.ok(php.includes('composer:2'));
  assert.throws(() => installArgs({ stack: 'docker', name: 'a', folder: '/x' }), /cannot be installed/);
});

test('mergeEnv replaces envhub keys and keeps the app lines', () => {
  const merged = mergeEnv('APP_NAME=Laravel\nAPP_KEY=base64:abc\n# DB_HOST=127.0.0.1\nDB_CONNECTION=sqlite\n', 'APP_PORT=8080\nDB_CONNECTION=mysql\n');
  assert.match(merged, /APP_KEY=base64:abc/);
  assert.match(merged, /DB_CONNECTION=mysql/);
  assert.doesNotMatch(merged, /sqlite/);
  assert.match(merged, /APP_PORT=8080/);
});

test('install mode writes no server.js, and finishInstall adds the portable files', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-inst-'));
  const folder = scaffoldNode({ baseDir: base, name: 'web', stack: 'nextjs', nodeVersion: '22', install: true });
  assert.deepStrictEqual(fs.readdirSync(folder), []);
  // Pretend the generator ran.
  fs.writeFileSync(path.join(folder, 'package.json'), '{}');
  finishInstall(folder, { stack: 'nextjs', name: 'web', nodeVersion: '22', options: {}, versions: {}, dbPassword: 'pw' });
  assert.ok(fs.existsSync(path.join(folder, 'docker-compose.yml')));
  assert.ok(fs.existsSync(path.join(folder, 'Dockerfile')));
  assert.ok(!fs.existsSync(path.join(folder, 'server.js')));
});

test('laravel install mode keeps public/ empty and merges the generated .env', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-inst-'));
  const folder = scaffoldLaravel({ baseDir: base, name: 'shop', phpVersion: '8.3', options: { mysql: true }, install: true });
  assert.ok(!fs.existsSync(path.join(folder, 'public')));
  fs.writeFileSync(path.join(folder, '.env'), 'APP_KEY=base64:abc\nDB_CONNECTION=sqlite\n');
  finishInstall(folder, { stack: 'laravel', name: 'shop', phpVersion: '8.3', options: { mysql: true }, versions: {}, dbPassword: 'pw' });
  const env = fs.readFileSync(path.join(folder, '.env'), 'utf8');
  assert.match(env, /APP_KEY=base64:abc/);
  assert.match(env, /DB_CONNECTION=mysql/);
  assert.match(env, /SESSION_DRIVER=file/);
});

test('docker language with install keeps only the dependency file, no starter code', () => {
  const { scaffoldDocker } = require('../main/project/scaffold');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-lang-'));
  const clean = scaffoldDocker({ baseDir: base, name: 'py', image: 'python:3.12', containerPort: 8000, options: {}, versions: {}, dbPassword: 'pw', install: true });
  assert.ok(fs.existsSync(path.join(clean, 'requirements.txt')));
  assert.ok(!fs.existsSync(path.join(clean, 'app.py')));
  const starter = scaffoldDocker({ baseDir: base, name: 'py2', image: 'python:3.12', containerPort: 8000, options: {}, versions: {}, dbPassword: 'pw' });
  assert.ok(fs.existsSync(path.join(starter, 'app.py')));
});

test('Node projects get a "ready" step and wait until the app answers', async () => {
  const http = require('http');
  const { stepsFor, waitForApp } = require('../main/docker/pipeline');
  const server = http.createServer((req, res) => res.end('hi'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = { services: [{ name: 'node', image: 'node:22', command: ['sh', '-c', 'npm install && npm run dev'], ports: [{ host: port, container: 3000 }] }] };

  assert.deepStrictEqual(stepsFor(config).map((s) => s.id), ['ports', 'files', 'pull', 'up', 'ready']);
  assert.ok(!stepsFor({ services: [{ name: 'redis', image: 'redis:7' }] }).some((s) => s.id === 'ready'));

  const events = [];
  const res = await waitForApp({ projectName: 'x', config, report: (step, f, d) => events.push([step, f, d]) });
  server.close();
  assert.strictEqual(res.ok, true);
  assert.ok(!res.notReady);
  assert.strictEqual(events[events.length - 1][0], 'ready');
});

test('Node projects keep node_modules in a Docker volume', () => {
  const { portableComposeYaml } = require('../main/project/portable-compose');
  const { nodeProject } = require('../main/stacks/node');
  const yaml = portableComposeYaml({ stack: 'nextjs', name: 'web', nodeVersion: '22', options: {}, versions: {} });
  assert.match(yaml, /node_modules:\/app\/node_modules/);
  assert.match(yaml, /^volumes:\n {2}node_modules: \{\}/m);
  const cfg = nodeProject({ name: 'web', stack: 'nextjs', nodeVersion: '22', folder: '/x/web', dbPassword: 'pw', options: {} });
  assert.deepStrictEqual(cfg.services[0].dataVolumes, [{ name: 'node-modules', target: '/app/node_modules' }]);
});

test('Linux file ownership: containers run as the host user, other systems are untouched', () => {
  const { hostUser, volumeOwnerCommands } = require('../main/docker/hostuser');
  const { userArgs } = require('../main/project/installer');
  const { generateCompose } = require('../main/compose/generate');
  const { nodeProject } = require('../main/stacks/node');

  assert.strictEqual(hostUser('win32', () => 1000, () => 1000), null);
  assert.strictEqual(hostUser('darwin', () => 501, () => 20), null);
  assert.strictEqual(hostUser('linux', () => 0, () => 0), null);
  assert.strictEqual(hostUser('linux', () => 1000, () => 1001), '1000:1001');

  assert.deepStrictEqual(userArgs(null), []);
  const args = userArgs('1000:1001');
  assert.deepStrictEqual(args.slice(0, 2), ['--user', '1000:1001']);
  assert.ok(args.includes('HOME=/tmp'));

  const cfg = nodeProject({ name: 'web', stack: 'nextjs', nodeVersion: '22', folder: '/x/web', dbPassword: 'pw', options: {} });
  cfg.services[0].user = '1000:1001';
  const compose = generateCompose(cfg);
  assert.strictEqual(compose.services.node.user, '1000:1001');
  assert.strictEqual(compose.services.node.environment.HOME, '/tmp');
  const cmds = volumeOwnerCommands(cfg, 'web');
  assert.strictEqual(cmds.length, 2);
  assert.ok(cmds[1].includes('envhub-web-node-node-modules'.replace(/^/, 'type=volume,source=')) || cmds[1].some((a) => a.includes('envhub-web-node-node-modules')));
  assert.deepStrictEqual(volumeOwnerCommands({ services: [{ name: 'node', image: 'x', dataVolumes: [{ name: 'a', target: '/a' }] }] }, 'web'), []);
  assert.throws(() => generateCompose({ ...cfg, services: [{ ...cfg.services[0], user: 'root' }] }), /Invalid user/);
});

test('detectProject guesses the stack and version of an existing folder', () => {
  const { detectProject, suggestName, pickPhp } = require('../main/project/detect');
  const mk = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-det-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
  };

  const laravel = detectProject(mk({ 'composer.json': JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.0' } }) }));
  assert.strictEqual(laravel.stack, 'laravel');
  assert.strictEqual(laravel.version, '8.2');
  assert.strictEqual(laravel.hasVendor, false);

  assert.strictEqual(detectProject(mk({ 'package.json': JSON.stringify({ dependencies: { next: '15', react: '19' } }) })).stack, 'nextjs');
  assert.strictEqual(detectProject(mk({ 'package.json': JSON.stringify({ dependencies: { nuxt: '3', vue: '3' } }) })).stack, 'nuxt');
  assert.strictEqual(detectProject(mk({ 'package.json': JSON.stringify({ dependencies: { '@nestjs/core': '10' } }) })).stack, 'nestjs');
  assert.strictEqual(detectProject(mk({ 'package.json': JSON.stringify({ devDependencies: { vue: '3' } }) })).stack, 'vue');
  const bare = detectProject(mk({ 'package.json': '{}' }));
  assert.strictEqual(bare.stack, 'docker');
  assert.strictEqual(bare.language.command, '');
  assert.strictEqual(detectProject(mk({})).stack, null);

  const node = detectProject(mk({ 'package.json': JSON.stringify({ dependencies: { next: '15' } }), '.nvmrc': 'v20.11.0\n' }));
  assert.strictEqual(node.version, '20');

  assert.strictEqual(suggestName('C:/www/My Shop_2'), 'my-shop-2');
  assert.strictEqual(suggestName('/x/123'), 'app-123');
  assert.strictEqual(pickPhp('^7.4|^8.0'), '8.1');
});

test('an imported Laravel project keeps its own folder clean (support files elsewhere)', () => {
  const { laravelProject } = require('../main/stacks/laravel');
  const { writeLaravelSupport } = require('../main/project/scaffold');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-sup-'));
  writeLaravelSupport(dir, '8.3');
  assert.ok(fs.existsSync(path.join(dir, 'php', 'Dockerfile')));
  assert.ok(fs.existsSync(path.join(dir, 'nginx', 'default.conf')));
  const cfg = laravelProject({ name: 'shop', phpVersion: '8.3', folder: '/x/shop', dbPassword: 'pw', options: {}, supportDir: dir });
  const php = cfg.services.find((s) => s.name === 'php');
  assert.strictEqual(php.build.context, path.join(dir, 'php'));
  const plain = laravelProject({ name: 'shop', phpVersion: '8.3', folder: '/x/shop', dbPassword: 'pw', options: {} });
  assert.strictEqual(plain.services.find((s) => s.name === 'php').build.context, path.join('/x/shop', 'docker', 'php'));
});

test('detectProject finds other languages and fills a Docker image project', () => {
  const { detectProject } = require('../main/project/detect');
  const mk = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-lang-'));
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
  };

  const py = detectProject(mk({ 'requirements.txt': 'flask\n', 'app.py': 'from flask import Flask\n', '.python-version': '3.11.4\n' }));
  assert.strictEqual(py.stack, 'docker');
  assert.strictEqual(py.language.image, 'python:3.11');
  assert.strictEqual(py.language.port, 5000);
  assert.strictEqual(py.language.command, 'pip install --no-cache-dir -r requirements.txt && python app.py');

  const django = detectProject(mk({ 'requirements.txt': 'django\n', 'manage.py': '' })).language;
  assert.match(django.command, /manage\.py runserver 0\.0\.0\.0:8000$/);

  const fast = detectProject(mk({ 'main.py': 'from fastapi import FastAPI\n', 'requirements.txt': 'fastapi\nuvicorn\n' })).language;
  assert.match(fast.command, /uvicorn main:app --host 0\.0\.0\.0 --port 8000$/);

  assert.strictEqual(detectProject(mk({ 'go.mod': 'module x\n\ngo 1.22\n' })).language.image, 'golang:1.22');
  assert.strictEqual(detectProject(mk({ 'Cargo.toml': '[package]\n' })).language.command, 'cargo run');
  const mvn = detectProject(mk({ 'pom.xml': '<java.version>17</java.version><artifactId>spring-boot-starter</artifactId>' })).language;
  assert.strictEqual(mvn.image, 'maven:3-eclipse-temurin-17');
  assert.strictEqual(mvn.command, 'mvn -q spring-boot:run');
  assert.strictEqual(detectProject(mk({ Gemfile: 'source "x"\n', 'bin/rails': '' })).language.port, 3000);

  const node = detectProject(mk({ 'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }) })).language;
  assert.strictEqual(node.command, 'npm install && npm start');
  assert.strictEqual(detectProject(mk({})).stack, null);
});

test('a Python Docker image project installs requirements.txt before it starts', () => {
  const { dockerProject } = require('../main/stacks/docker');
  const py = dockerProject({ name: 'py', folder: '/x/py', image: 'python:3.12', containerPort: 8000, options: {} });
  assert.deepStrictEqual(py.services[0].command, ['sh', '-c', 'pip install --no-cache-dir -r requirements.txt && python app.py']);
  const own = dockerProject({ name: 'py', folder: '/x/py', image: 'python:3.12', containerPort: 8000, command: 'python x.py', options: {} });
  assert.deepStrictEqual(own.services[0].command, ['sh', '-c', 'python x.py']);
  const go = dockerProject({ name: 'g', folder: '/x/g', image: 'golang:1.23', containerPort: 8000, options: {} });
  assert.deepStrictEqual(go.services[0].command, ['sh', '-c', 'go run .']);
});

test('Python frameworks: starter files, packages, command and database environment', () => {
  const fw = require('../main/stacks/python-frameworks');
  const { scaffoldDocker } = require('../main/project/scaffold');
  const { dockerProject } = require('../main/stacks/docker');

  assert.strictEqual(fw.normalizeFramework('', 'python:3.12'), '');
  assert.strictEqual(fw.normalizeFramework('flask', 'python:3.12'), 'flask');
  assert.throws(() => fw.normalizeFramework('flask', 'golang:1.23'), /needs a Python image/);
  assert.throws(() => fw.normalizeFramework('rails', 'python:3.12'), /Unsupported framework/);

  const files = fw.frameworkFiles('flask', { mysql: true });
  assert.match(files['requirements.txt'], /^flask\npymysql\ncryptography\n$/);
  assert.match(files['db.py'], /pymysql/);
  assert.ok(!/psycopg2/.test(files['db.py']));
  assert.ok(Object.keys(fw.frameworkFiles('django', {})).includes('config/settings.py'));
  assert.match(fw.frameworkFiles('django', { postgres: true })['config/settings.py'], /postgresql/);
  assert.match(fw.frameworkCommand('fastapi'), /^pip install --no-cache-dir -r requirements.txt && uvicorn main:app/);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-fw-'));
  const folder = scaffoldDocker({ baseDir: base, name: 'f', image: 'python:3.12', containerPort: 5000, options: { mysql: true }, framework: 'flask' });
  assert.ok(fs.existsSync(path.join(folder, 'app.py')));
  assert.match(fs.readFileSync(path.join(folder, 'app.py'), 'utf8'), /Flask/);

  const project = dockerProject({ name: 'f', folder: '/x/f', image: 'python:3.12', containerPort: 5000, options: { mysql: true }, dbPassword: 'rootpw', appPassword: 'apppw', dbName: 'shop', dbUser: 'shopper' });
  const env = project.services[0].env;
  assert.strictEqual(env.MYSQL_HOST, 'mysql');
  assert.strictEqual(env.MYSQL_DATABASE, 'shop');
  assert.strictEqual(env.MYSQL_USER, 'shopper');
  assert.strictEqual(env.MYSQL_PASSWORD, 'apppw');
});

test('Keep Python packages: a volume and pip settings, only for Python and only when asked', () => {
  const { dockerProject } = require('../main/stacks/docker');
  const { describeForEdit, applyServiceEdit } = require('../main/stacks/edit');
  const on = dockerProject({ name: 'p', folder: '/x/p', image: 'python:3.12', containerPort: 8000, options: {}, keepPackages: true });
  const app = on.services[0];
  assert.deepStrictEqual(app.dataVolumes, [{ name: 'packages', target: '/pkgs' }]);
  assert.strictEqual(app.env.PYTHONUSERBASE, '/pkgs');
  assert.strictEqual(app.env.PIP_USER, '1');
  assert.ok(app.env.PATH.startsWith('/pkgs/bin:'));
  assert.strictEqual(dockerProject({ name: 'p', folder: '/x/p', image: 'python:3.12', containerPort: 8000, options: {} }).services[0].dataVolumes, undefined);
  assert.deepStrictEqual(dockerProject({ name: 'g', folder: '/x/g', image: 'golang:1.23', containerPort: 8000, options: {}, keepPackages: true }).services[0].dataVolumes, [{ name: 'go', target: '/go' }]);
  assert.strictEqual(dockerProject({ name: 'g', folder: '/x/g', image: 'ubuntu:24.04', containerPort: 8000, options: {}, keepPackages: true }).services[0].dataVolumes, undefined);
  const targets = (image) => dockerProject({ name: 'k', folder: '/x/k', image, containerPort: 8000, options: {}, keepPackages: true }).services[0].dataVolumes.map((v) => v.target);
  assert.deepStrictEqual(targets('node:22-alpine'), ['/app/node_modules']);
  assert.deepStrictEqual(targets('rust:1'), ['/usr/local/cargo/registry', '/cache']);
  assert.deepStrictEqual(targets('maven:3-eclipse-temurin-21'), ['/root/.m2']);
  assert.deepStrictEqual(targets('ruby:3.3'), ['/usr/local/bundle']);

  const spec = { name: 'p', stack: 'docker', image: 'python:3.12', containerPort: 8000, folder: '/x/p', options: {} };
  assert.strictEqual(describeForEdit(spec).packagesLabel, 'Python');
  assert.strictEqual(describeForEdit({ ...spec, image: 'ubuntu:24.04' }).packagesLabel, '');
  assert.strictEqual(describeForEdit(spec).keepPackages, false);
  assert.strictEqual(applyServiceEdit(spec, { keepPackages: true }).keepPackages, true);
  assert.strictEqual(applyServiceEdit({ ...spec, keepPackages: true }, { keepPackages: false }).keepPackages, undefined);
  assert.strictEqual(applyServiceEdit({ ...spec, image: 'golang:1.23' }, { keepPackages: true }).keepPackages, true);
  assert.strictEqual(applyServiceEdit({ ...spec, image: 'ubuntu:24.04' }, { keepPackages: true }).keepPackages, undefined);
});

test('extra services keep the data of known databases in a volume', () => {
  const { dataPathFor, extraServicesOf, normalizeExtraServices } = require('../main/stacks/extras');
  assert.strictEqual(dataPathFor('mariadb:11'), '/var/lib/mysql');
  assert.strictEqual(dataPathFor('docker.elastic.co/elasticsearch/elasticsearch:8.15.0'), '/usr/share/elasticsearch/data');
  assert.strictEqual(dataPathFor('getmeili/meilisearch:v1.10'), '/meili_data');
  assert.strictEqual(dataPathFor('postgres:16'), '/var/lib/postgresql/data');
  assert.strictEqual(dataPathFor('postgres:18'), '/var/lib/postgresql');
  assert.strictEqual(dataPathFor('postgres'), '/var/lib/postgresql');
  assert.strictEqual(dataPathFor('mcr.microsoft.com/mssql/server:2022-latest'), '/var/opt/mssql');
  assert.strictEqual(dataPathFor('someone/server'), '');
  assert.strictEqual(dataPathFor('memcached:1.6'), '');
  const list = normalizeExtraServices([{ image: 'mariadb:11', ports: '3306', env: 'MARIADB_ROOT_PASSWORD=root' }, { image: 'memcached:1.6' }]);
  const services = extraServicesOf({ extraServices: list });
  assert.deepStrictEqual(services[0].dataVolumes, [{ name: 'data', target: '/var/lib/mysql' }]);
  assert.strictEqual(services[1].dataVolumes, undefined);
});

test('settings: the projects folder can be chosen, is checked, and earlier folders are remembered', () => {
  const settings = require('../main/store/settings');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-set-data-'));
  const dirA = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-set-')), 'a');
  const dirB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-set-')), 'b');
  const fallback = path.join(os.tmpdir(), 'envhub-default-projects');

  settings.init(data);
  assert.strictEqual(settings.projectsBaseDir(fallback), fallback);
  assert.throws(() => settings.setProjectsDir('relative/dir', { dataDir: data }), /full folder path/);
  assert.throws(() => settings.setProjectsDir(path.join(data, 'x'), { dataDir: data }), /belongs to ProjectDockHub/);

  assert.strictEqual(settings.setProjectsDir(dirA, { dataDir: data }), path.resolve(dirA));
  assert.ok(fs.existsSync(dirA));
  assert.strictEqual(settings.projectsBaseDir(fallback), path.resolve(dirA));

  settings.setProjectsDir(dirB, { dataDir: data });
  const known = settings.knownProjectDirs(fallback);
  assert.ok(known.includes(path.resolve(dirA)) && known.includes(path.resolve(dirB)) && known.includes(path.resolve(fallback)));

  // saved to disk and read back
  settings.init(data);
  assert.strictEqual(settings.projectsBaseDir(fallback), path.resolve(dirB));
  settings.resetProjectsDir();
  assert.strictEqual(settings.projectsBaseDir(fallback), fallback);
  assert.ok(settings.knownProjectDirs(fallback).includes(path.resolve(dirB)));
});

test('sync: export leaves out passwords and the demo, import checks every project', () => {
  const { exportProjects, planImport } = require('../main/store/sync');
  const specs = [
    { name: 'demo', stack: 'custom', services: [] },
    { name: 'shop', stack: 'nextjs', nodeVersion: '22', folder: '/p/shop', options: {}, dbPassword: 'secret1', redisPassword: 'secret2', mail: { host: 'h', password: 'secret3' }, hostPorts: { 'node:3000': 3001 } },
    { name: 'blog', stack: 'laravel', phpVersion: '8.3', folder: '/p/blog', options: {} },
  ];
  const data = exportProjects(specs, new Date('2026-01-02T03:04:05Z'));
  const text = JSON.stringify(data);
  assert.ok(!/secret/.test(text));
  assert.ok(!text.includes('hostPorts'));
  assert.deepStrictEqual(data.projects.map((p) => p.name), ['shop', 'blog']);
  assert.strictEqual(data.exportedAt, '2026-01-02T03:04:05.000Z');
  assert.strictEqual(specs[1].dbPassword, 'secret1'); // the saved project itself is not changed

  const plan = planImport(JSON.parse(text), {
    existingNames: ['blog'],
    creatableStacks: ['laravel', 'nextjs'],
    folderExists: (f) => f === '/p/shop',
  });
  assert.deepStrictEqual(plan.add.map((p) => p.name), ['shop']);
  assert.match(plan.skipped[0].reason, /already exists/);

  const missing = planImport(JSON.parse(text), { existingNames: [], creatableStacks: ['laravel', 'nextjs'], folderExists: () => false });
  assert.strictEqual(missing.add.length, 0);
  assert.match(missing.skipped[0].reason, /folder not found/);

  assert.throws(() => planImport({ hello: 1 }, { existingNames: [], creatableStacks: [], folderExists: () => true }), /not a ProjectDockHub projects file/);
  assert.throws(() => planImport({ format: 'envhub-projects', version: 99, projects: [] }, { existingNames: [], creatableStacks: [], folderExists: () => true }), /newer ProjectDockHub/);
  const bad = planImport({ format: 'envhub-projects', version: 1, projects: [{ name: 'Bad Name', stack: 'laravel', folder: '/x' }, { name: 'ok', stack: 'cobol', folder: '/x' }] }, { existingNames: [], creatableStacks: ['laravel'], folderExists: () => true });
  assert.deepStrictEqual(bad.skipped.map((s) => s.reason), ['invalid name', 'unknown stack "cobol"']);
});

test('menu has the planned entries, and the document view turns Markdown into safe HTML', () => {
  const { buildTemplate } = require('../main/menu');
  const { markdownToHtml } = require('../main/docview');
  const calls = [];
  const actions = new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) });
  const template = buildTemplate(actions, false);
  const labels = template.map((m) => m.label || m.role);
  assert.deepStrictEqual(labels, ['File', 'editMenu', 'viewMenu', 'Tools', 'windowMenu', 'Help']);

  const find = (items, label) => items.find((i) => i.label === label);
  const file = template[0].submenu;
  assert.ok(find(file, 'Projects folder...'));
  const sync = find(template[3].submenu, 'Sync').submenu.filter((i) => i.label);
  assert.strictEqual(sync.length, 4);
  assert.deepStrictEqual(sync.map((i) => i.label[0]), ['1', '1', '2', '3']);
  const help = template[5].submenu;
  find(help, 'Planning').click();
  find(file, 'New project').click();
  assert.deepStrictEqual(calls, [['showDoc', 'planning'], ['sendToWindow', 'new-project']]);

  const html = markdownToHtml('# Title\n\n- one **bold** `code`\n- <script>alert(1)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nx < y\n```\n');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<th>a<\/th>/);
  assert.ok(!/<script>/.test(html));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /x &lt; y/);
});

test('connectionData gives the Credentials tab the same facts as the text, as data', () => {
  const { connectionData } = require('../main/stacks/connection');
  const config = {
    stack: 'nextjs',
    services: [
      { name: 'node', image: 'node:22' },
      { name: 'mysql', image: 'mysql:8.0' },
      { name: 'redis', image: 'redis:7' },
      { name: 'phpmyadmin', image: 'phpmyadmin:5' },
      { name: 'rabbitmq', image: 'rabbitmq:3', env: { RABBITMQ_DEFAULT_PASS: 'rb' } },
    ],
  };
  const ports = [
    { service: 'mysql', container: 3306, host: 3307 },
    { service: 'redis', container: 6379, host: 6380 },
    { service: 'phpmyadmin', container: 80, host: 8081 },
    { service: 'rabbitmq', container: 15672, host: 15672 },
  ];
  const data = connectionData({ config, ports, password: 'apppw', rootPassword: 'rootpw', dbName: 'shop', dbUser: 'shopper' });
  assert.match(data.env.docker, /DB_HOST=mysql/);
  assert.match(data.env.host, /DB_HOST=localhost/);
  assert.match(data.env.host, /DB_PORT=3307/);
  const mysql = data.databases.find((d) => d.key === 'mysql');
  assert.deepStrictEqual([mysql.host, mysql.port, mysql.database, mysql.user, mysql.password, mysql.rootPassword], ['localhost', '3307', 'shop', 'shopper', 'apppw', 'rootpw']);
  const redis = data.databases.find((d) => d.key === 'redis');
  assert.strictEqual(redis.note, 'No password');
  assert.deepStrictEqual(data.pages.map((p) => [p.service, p.url]), [['phpmyadmin', 'http://localhost:8081']]);
  assert.deepStrictEqual(data.extras, [{ name: 'rabbitmq', image: 'rabbitmq:3', ports: [{ host: 15672, container: 15672 }], env: { RABBITMQ_DEFAULT_PASS: 'rb' } }]);
});

test('tray menu: Open ProjectDockHub and Exit', () => {
  const { trayTemplate } = require('../main/tray');
  const calls = [];
  const items = trayTemplate({ show: () => calls.push('show'), quit: () => calls.push('quit') });
  const labels = items.filter((i) => i.label).map((i) => i.label);
  assert.deepStrictEqual(labels, ['Open ProjectDockHub', 'Exit']);
  items.find((i) => i.label === 'Exit').click();
  items.find((i) => i.label === 'Open ProjectDockHub').click();
  assert.deepStrictEqual(calls, ['quit', 'show']);
});

test('describeVolumes lists data and cache volumes with their sizes, and the shared folders', () => {
  const { describeVolumes } = require('../main/stacks/volumes');
  const config = {
    services: [
      { name: 'node', volumes: [{ source: 'C:/p/web', target: '/app' }], dataVolumes: [{ name: 'node-modules', target: '/app/node_modules' }] },
      { name: 'mysql', dataVolumes: [{ name: 'data', target: '/var/lib/mysql' }] },
      { name: 'mariadb', dataVolumes: [{ name: 'data', target: '/var/lib/mysql' }] },
      { name: 'redis' },
    ],
  };
  const out = describeVolumes(config, 'web', ['envhub-web-mysql-data'], [{ name: 'envhub-web-mysql-data', bytes: 5000 }]);
  assert.deepStrictEqual(out.volumes.map((v) => [v.name, v.kind, v.exists, v.bytes]), [
    ['envhub-web-node-node-modules', 'cache', false, null],
    ['envhub-web-mysql-data', 'data', true, 5000],
    ['envhub-web-mariadb-data', 'data', false, null],
  ]);
  assert.strictEqual(out.totalBytes, 5000);
  assert.deepStrictEqual(out.folders, [{ service: 'node', source: 'C:/p/web', target: '/app' }]);
  assert.deepStrictEqual(describeVolumes({ services: [] }, 'x'), { volumes: [], folders: [], totalBytes: 0 });
});

test('docker events restart by themselves and report when Docker goes away and comes back', async () => {
  const { EventEmitter } = require('events');
  const { startEvents } = require('../main/docker/events');
  const children = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.kill = () => child.emit('close', 0);
    children.push(child);
    return child;
  };
  const changes = [];
  const states = [];
  const realSetTimeout = global.setTimeout;
  // Fast timers: every wait is 5 ms, so the test does not take seconds.
  global.setTimeout = (fn) => realSetTimeout(fn, 5);
  try {
    const stop = startEvents((c) => changes.push(c), null, (s) => states.push(s), fakeSpawn);
    assert.strictEqual(children.length, 1);

    // a container event comes through
    children[0].stdout.emit('data', Buffer.from(JSON.stringify({ Action: 'start', Actor: { ID: 'abc', Attributes: { name: 'envhub-p-app', 'com.envhub.project': 'p', 'com.envhub.service': 'app' } } }) + '\n'));
    assert.deepStrictEqual(changes.map((c) => [c.action, c.project, c.service]), [['start', 'p', 'app']]);

    // Docker stops: the program ends -> "down", and it is started again
    children[0].emit('close', 1);
    assert.deepStrictEqual(states, ['down']);
    await new Promise((r) => realSetTimeout(r, 40));
    assert.strictEqual(children.length, 2);

    // Docker is back: the new program stays alive -> "up"
    await new Promise((r) => realSetTimeout(r, 40));
    assert.deepStrictEqual(states, ['down', 'up']);

    // a program that ends again right away is still only reported once
    children[1].emit('close', 1);
    children[children.length - 1].emit('close', 1);
    stop();
    const count = children.length;
    await new Promise((r) => realSetTimeout(r, 40));
    assert.strictEqual(children.length, count); // stopped: no more restarts
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('docker check: an empty or error answer is not "running"', () => {
  const { SERVER_VERSION, CONNECT_ERROR } = require('../main/docker/check');
  for (const good of ['27.4.0', '28.0.1-rc.1', '24.0.7']) assert.ok(SERVER_VERSION.test(good), good);
  for (const bad of ['', 'error during connect: Get "http://x/info"', 'unknown', ' ']) assert.ok(!SERVER_VERSION.test(bad), bad);
  assert.ok(CONNECT_ERROR.test('error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'));
  assert.ok(CONNECT_ERROR.test('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'));
  assert.ok(!CONNECT_ERROR.test('27.4.0'));
});
