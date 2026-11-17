'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { laravelProject } = require('../main/stacks/laravel');
const { generateCompose } = require('../main/compose/generate');
const { applyServiceEdit, describeForEdit } = require('../main/stacks/edit');
const { describeVolumes } = require('../main/stacks/volumes');
const { vendorPlan, lockHash, syncVendorVolume } = require('../main/project/vendor-volume');

const FOLDER = path.resolve('/projects/shop');
const base = { name: 'shop', stack: 'laravel', phpVersion: '8.3', folder: FOLDER, options: { mysql: true } };

function phpOf(project) {
  return project.services.find((s) => s.name === 'php');
}

test('vendor volume: off by default, on only for the PHP service', () => {
  assert.strictEqual(phpOf(laravelProject(base)).dataVolumes, undefined);

  const project = laravelProject({ ...base, vendorVolume: true });
  assert.deepStrictEqual(phpOf(project).dataVolumes, [{ name: 'vendor', target: '/var/www/html/vendor' }]);
  assert.strictEqual(project.services.find((s) => s.name === 'nginx').dataVolumes, undefined);

  const compose = generateCompose(project);
  assert.ok(compose.volumes['envhub-shop-php-vendor']);
  assert.ok(compose.services.php.volumes.some((v) => v.type === 'volume' && v.target === '/var/www/html/vendor'));
});

test('vendor volume: the Volumes tab lists it as installed packages', () => {
  const list = describeVolumes(laravelProject({ ...base, vendorVolume: true }), 'shop').volumes;
  const vendor = list.find((v) => v.name === 'envhub-shop-php-vendor');
  assert.strictEqual(vendor.kind, 'cache');
});

test('vendor volume: saved for Laravel on Windows and Mac, never on Linux or another stack', () => {
  assert.strictEqual(applyServiceEdit(base, { vendorVolume: true }, 'win32').vendorVolume, true);
  assert.strictEqual(applyServiceEdit(base, { vendorVolume: true }, 'darwin').vendorVolume, true);
  assert.strictEqual(applyServiceEdit(base, { vendorVolume: true }, 'linux').vendorVolume, undefined);
  // A form that does not send the field keeps the saved choice; false turns it off.
  assert.strictEqual(applyServiceEdit({ ...base, vendorVolume: true }, {}, 'win32').vendorVolume, true);
  assert.strictEqual(applyServiceEdit({ ...base, vendorVolume: true }, { vendorVolume: false }, 'win32').vendorVolume, undefined);

  const node = { name: 'web', stack: 'nextjs', nodeVersion: '22', folder: FOLDER };
  assert.strictEqual(applyServiceEdit(node, { vendorVolume: true }, 'win32').vendorVolume, undefined);

  assert.strictEqual(describeForEdit({ ...base, vendorVolume: true }, 'win32').php.vendorVolume, true);
  assert.strictEqual(describeForEdit(base, 'win32').php.vendorVolumeAvailable, true);
  assert.strictEqual(describeForEdit(base, 'linux').php.vendorVolumeAvailable, false);
});

test('vendor volume: what to do when the project starts', () => {
  // An empty volume is filled from the project folder, or with composer when there is no vendor folder.
  assert.strictEqual(vendorPlan({ hasAutoload: false, stamp: '', lock: 'a', hostHasVendor: true }), 'copy');
  assert.strictEqual(vendorPlan({ hasAutoload: false, stamp: '', lock: 'a', hostHasVendor: false }), 'install');
  // A filled volume is left alone until composer.lock changes.
  assert.strictEqual(vendorPlan({ hasAutoload: true, stamp: 'a', lock: 'a', hostHasVendor: true }), 'none');
  assert.strictEqual(vendorPlan({ hasAutoload: true, stamp: 'a', lock: 'b', hostHasVendor: true }), 'install');
  assert.strictEqual(vendorPlan({ hasAutoload: true, stamp: '', lock: '', hostHasVendor: true }), 'none');
});

test('vendor volume: the first start copies vendor once, the next start does nothing', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-vendor-'));
  try {
    fs.mkdirSync(path.join(folder, 'vendor'));
    fs.writeFileSync(path.join(folder, 'vendor', 'autoload.php'), '<?php');
    fs.writeFileSync(path.join(folder, 'composer.lock'), '{"packages":[]}');
    const lock = lockHash(folder);
    assert.match(lock, /^[0-9a-f]{16}$/);

    let filled = false;
    const streamed = [];
    const ran = [];
    const run = async (args) => {
      ran.push(args);
      const script = args[4] || '';
      if (script.includes('echo autoload=yes')) return { ok: true, stdout: filled ? `autoload=yes\nstamp=${lock}\n` : 'stamp=\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };
    const stream = async (args) => { streamed.push(args); filled = true; return { ok: true, tail: [] }; };

    const first = await syncVendorVolume({ projectName: 'shop', folder, run, stream });
    assert.deepStrictEqual(first, { ok: true, action: 'copy' });
    assert.strictEqual(streamed.length, 1);
    assert.ok(streamed[0].includes(`type=bind,source=${path.join(folder, 'vendor')},target=/src,readonly`));
    assert.ok(streamed[0].includes('type=volume,source=envhub-shop-php-vendor,target=/dst'));
    // The fingerprint of composer.lock is passed as an argument, not pasted into the shell text.
    assert.strictEqual(ran[ran.length - 1][ran[ran.length - 1].length - 1], lock);

    const second = await syncVendorVolume({ projectName: 'shop', folder, run, stream });
    assert.deepStrictEqual(second, { ok: true, action: 'none' });
    assert.strictEqual(streamed.length, 1);

    // composer.lock changed (git pull): composer install runs inside the PHP container.
    fs.writeFileSync(path.join(folder, 'composer.lock'), '{"packages":[1]}');
    const third = await syncVendorVolume({ projectName: 'shop', folder, run, stream });
    assert.strictEqual(third.action, 'install');
    assert.deepStrictEqual(streamed[1].slice(-4), ['composer', 'install', '--no-interaction', '--prefer-dist']);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('vendor volume: a failed copy is reported, with the last lines Docker printed', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-vendor-'));
  try {
    const res = await syncVendorVolume({
      projectName: 'shop',
      folder,
      run: async () => ({ ok: true, stdout: 'stamp=\n', stderr: '' }),
      stream: async () => ({ ok: false, tail: ['no network'] }),
    });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /composer install failed: no network/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('composer is not blocked by security advisories in the PHP container (old Laravel projects)', () => {
  const env = phpOf(laravelProject(base)).env;
  assert.strictEqual(env.COMPOSER_NO_BLOCKING, '1');
  assert.strictEqual(env.COMPOSER_NO_SECURITY_BLOCKING, '1');
  // The container still gets the php.ini hash, and the compose file accepts the variables.
  assert.ok(env.ENVHUB_PHP_INI);
  assert.strictEqual(generateCompose(laravelProject(base)).services.php.environment.COMPOSER_NO_BLOCKING, '1');
});

test('composer hints: the common failures get a plain sentence, an unknown one gets none', () => {
  const { composerHint } = require('../main/project/composer-hints');
  assert.match(composerHint(['x', 'but these were not loaded, because they are affected by security advisories']), /known security problems/);
  assert.match(composerHint('your php version (8.4.27) does not satisfy that requirement.'), /too old for PHP 8\.4\.27/);
  assert.match(composerHint(['laravel/framework replaces illuminate/support and thus cannot coexist with it.']), /new Laravel version/);
  assert.match(composerHint('Allowed memory size of 1610612736 bytes exhausted'), /COMPOSER_MEMORY_LIMIT/);
  assert.strictEqual(composerHint(['something else']), '');
  assert.strictEqual(composerHint(undefined), '');
});
