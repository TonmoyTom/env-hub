'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExtensions, normalizePhpIni, iniHash } = require('../main/stacks/php-extensions');
const { phpDockerfile } = require('../main/project/scaffold');
const { laravelProject } = require('../main/stacks/laravel');
const { applyServiceEdit, describeForEdit } = require('../main/stacks/edit');

const spec = { name: 'ams', stack: 'laravel', phpVersion: '8.3', folder: 'C:\\work\\ams' };

test('the PHP Dockerfile without extensions stays as it was', () => {
  const text = phpDockerfile('8.3');
  assert.match(text, /docker-php-ext-install pdo_mysql mbstring zip bcmath intl \\\n/);
  assert.doesNotMatch(text, /configure|pecl/);
});

test('GD adds its packages, configure flags and install', () => {
  const text = phpDockerfile('8.3', ['gd']);
  assert.match(text, /libpng-dev/);
  assert.match(text, /docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp/);
  assert.match(text, /docker-php-ext-install pdo_mysql mbstring zip bcmath intl gd/);
});

test('a PECL extension is installed and enabled', () => {
  const text = phpDockerfile('8.3', ['redis']);
  assert.match(text, /pecl install redis/);
  assert.match(text, /docker-php-ext-enable redis/);
});

test('extensions are checked, deduplicated and kept in list order', () => {
  assert.deepEqual(normalizeExtensions(['exif', 'gd', 'gd']), ['gd', 'exif']);
  assert.deepEqual(normalizeExtensions(undefined), []);
  assert.throws(() => normalizeExtensions(['gd; rm -rf /']), /Unknown PHP extension/);
  assert.throws(() => normalizeExtensions('gd'), /Invalid/);
});

test('php.ini accepts settings and comments, and rejects other lines', () => {
  assert.equal(normalizePhpIni('; limits\nupload_max_filesize = 64M\r\n[PHP]\nmemory_limit=512M'), '; limits\nupload_max_filesize = 64M\n[PHP]\nmemory_limit=512M\n');
  assert.equal(normalizePhpIni('  \n'), '');
  assert.throws(() => normalizePhpIni('upload_max_filesize 64M'), /line 1/);
  assert.throws(() => normalizePhpIni('a = 1\nnot valid'), /line 2/);
  assert.throws(() => normalizePhpIni('x'.repeat(20001)), /too long/);
});

test('the PHP service mounts custom.ini read only and changes when the text changes', () => {
  const a = laravelProject({ ...spec, dbPassword: 'x', phpIni: 'memory_limit = 1G\n' }).services.find((s) => s.name === 'php');
  const b = laravelProject({ ...spec, dbPassword: 'x', phpIni: 'memory_limit = 2G\n' }).services.find((s) => s.name === 'php');
  const ini = a.volumes.find((v) => v.target === '/usr/local/etc/php/conf.d/zz-custom.ini');
  assert.equal(ini.readOnly, true);
  assert.match(ini.source, /custom\.ini$/);
  assert.notEqual(a.env.ENVHUB_PHP_INI, b.env.ENVHUB_PHP_INI);
  assert.equal(iniHash('a'), iniHash('a'));
});

test('a rebuild is needed until the image was built with the saved extensions', () => {
  assert.equal(describeForEdit(spec).php.rebuildNeeded, false);

  const changed = applyServiceEdit(spec, { phpExtensions: ['gd'] });
  assert.equal(describeForEdit(changed).php.rebuildNeeded, true);

  assert.equal(describeForEdit({ ...changed, phpBuilt: ['gd'] }).php.rebuildNeeded, false);

  // Removing an extension that was built in needs a rebuild too.
  const removed = applyServiceEdit({ ...changed, phpBuilt: ['gd'] }, { phpExtensions: [] });
  assert.equal(describeForEdit(removed).php.rebuildNeeded, true);

  // A php.ini change alone does not need a rebuild.
  const iniOnly = applyServiceEdit(spec, { phpIni: 'memory_limit = 1G' });
  assert.equal(describeForEdit(iniOnly).php.rebuildNeeded, false);
});

test('Edit services saves PHP settings for Laravel only', () => {
  const next = applyServiceEdit(spec, { phpExtensions: ['gd'], phpIni: 'memory_limit = 1G' });
  assert.deepEqual(next.phpExtensions, ['gd']);
  assert.equal(next.phpIni, 'memory_limit = 1G\n');
  assert.deepEqual(describeForEdit(next).php.extensions, ['gd']);

  const cleared = applyServiceEdit(next, { phpExtensions: [], phpIni: '' });
  assert.equal(cleared.phpExtensions, undefined);
  assert.equal(cleared.phpIni, undefined);

  const kept = applyServiceEdit(next, {});
  assert.deepEqual(kept.phpExtensions, ['gd']);

  const node = { name: 'web', stack: 'nextjs', nodeVersion: '22', folder: 'C:\\work\\web' };
  assert.equal(describeForEdit(node).php, null);
  assert.equal(applyServiceEdit(node, { phpExtensions: ['gd'] }).phpExtensions, undefined);
});

test('a terminal starts in the project folder inside the container', async () => {
  const { shellArgs, openShell } = require('../main/docker/stats');
  const { buildLinks, workdirOf } = require('../main/stacks/links');

  assert.deepEqual(shellArgs('envhub-ams-php', '/var/www/html'), ['exec', '-it', '-w', '/var/www/html', 'envhub-ams-php', 'sh']);
  await assert.rejects(openShell('ams', 'php', { workdir: '/var/www; rm -rf /' }), /Invalid folder/);

  const config = laravelProject({ ...spec, dbPassword: 'x' });
  assert.equal(workdirOf(config.services.find((s) => s.name === 'php'), spec.folder), '/var/www/html');
  assert.equal(workdirOf({ name: 'mysql', volumes: [] }, spec.folder), '');

  const links = buildLinks({ name: 'ams', config, ports: [], composeFile: 'c.json', running: true, folder: spec.folder });
  const php = links.services.find((s) => s.name === 'php');
  assert.equal(php.shell, 'docker exec -it -w /var/www/html envhub-ams-php sh');
  assert.equal(php.workdir, '/var/www/html');
});
