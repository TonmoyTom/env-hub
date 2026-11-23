'use strict';

const { lockFileName, containerName, volumeName, phpImage } = require('../naming');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { runDocker, streamDocker } = require('../docker/exec');
const { composerHint } = require('./composer-hints');

// "Fast vendor" for a Laravel project: vendor/ lives in a Docker volume instead of the shared project folder.
// On Windows and Mac every file of a shared folder is slow to read (about 1 ms each), and a Laravel page touches
// thousands of vendor files. A volume is on Docker's own disk, so those reads are fast.
//
// The volume starts empty, so it is filled when the project starts:
//   copy     the vendor folder of the project is copied in (first start with the option on)
//   install  `composer install` runs inside the PHP container (no vendor folder, or composer.lock changed)
// A small file in the volume remembers which composer.lock it was filled from.
const WEB_ROOT = '/var/www/html';
const VENDOR_TARGET = `${WEB_ROOT}/vendor`;
const VENDOR_VOLUME = 'vendor';
const STAMP_FILE = lockFileName;
const LONG_TIMEOUT_MS = 30 * 60 * 1000;

// A short fingerprint of composer.lock. Empty when the project has none.
function lockHash(folder) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, 'composer.lock'))).digest('hex').slice(0, 16);
  } catch (err) {
    return '';
  }
}

// What has to happen to the volume: 'none', 'copy' or 'install'. Pure.
//   hasAutoload    the volume has vendor/autoload.php
//   stamp          the composer.lock fingerprint saved in the volume ('' when none)
//   lock           the fingerprint of composer.lock now ('' when the project has none)
//   hostHasVendor  the project folder has vendor/autoload.php
function vendorPlan({ hasAutoload, stamp, lock, hostHasVendor }) {
  if (!hasAutoload) return hostHasVendor ? 'copy' : 'install';
  if (lock && stamp !== lock) return 'install';
  return 'none';
}

// Fills or updates the vendor volume of a running project. Resolves { ok, action, error? }.
async function syncVendorVolume({ projectName, folder, log = () => {}, run = runDocker, stream = streamDocker }) {
  const container = containerName(projectName, 'php');
  const volume = volumeName(projectName, 'php', VENDOR_VOLUME);
  const image = phpImage(projectName);

  const probe = await run([
    'exec', container, 'sh', '-c',
    `[ -f ${VENDOR_TARGET}/autoload.php ] && echo autoload=yes; echo "stamp=$(cat ${VENDOR_TARGET}/${STAMP_FILE} 2>/dev/null)"`,
  ]);
  if (!probe.ok) {
    return { ok: false, action: 'none', error: `could not look into the PHP container: ${(probe.stderr || '').trim().slice(0, 200)}` };
  }
  const stampLine = probe.stdout.split(/\r?\n/).find((line) => line.startsWith('stamp=')) || 'stamp=';
  const lock = lockHash(folder);
  const hostVendor = path.join(folder, 'vendor');
  const action = vendorPlan({
    hasAutoload: /^autoload=yes$/m.test(probe.stdout),
    stamp: stampLine.slice('stamp='.length).trim(),
    lock,
    hostHasVendor: fs.existsSync(path.join(hostVendor, 'autoload.php')),
  });
  if (action === 'none') return { ok: true, action };

  let res;
  if (action === 'copy') {
    log('Copying the vendor folder into a Docker volume. This is done once and can take a few minutes');
    res = await stream([
      'run', '--rm',
      '--mount', `type=bind,source=${hostVendor},target=/src,readonly`,
      '--mount', `type=volume,source=${volume},target=/dst`,
      '--entrypoint', 'sh', image, '-c', 'cp -a /src/. /dst/',
    ], log, { timeout: LONG_TIMEOUT_MS });
  } else {
    log('Installing the PHP packages into the vendor volume (composer install)');
    res = await stream([
      'exec', '-w', WEB_ROOT, '-e', 'COMPOSER_ALLOW_SUPERUSER=1', container,
      'composer', 'install', '--no-interaction', '--prefer-dist',
    ], log, { timeout: LONG_TIMEOUT_MS });
  }
  if (!res.ok) {
    const tail = res.tail || [];
    const hint = composerHint(tail);
    return { ok: false, action, error: `${action === 'copy' ? 'copying vendor' : 'composer install'} failed: ${tail.slice(-3).join(' | ') || 'unknown error'}${hint ? ` ${hint}` : ''}` };
  }

  // Remember which composer.lock the volume belongs to. `$1` keeps the value out of the shell text.
  await run(['exec', container, 'sh', '-c', `printf %s "$1" > ${VENDOR_TARGET}/${STAMP_FILE}`, 'sh', lock]);
  log('The vendor volume is ready');
  return { ok: true, action };
}

module.exports = { syncVendorVolume, vendorPlan, lockHash, VENDOR_TARGET, VENDOR_VOLUME, STAMP_FILE };
