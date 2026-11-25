'use strict';

const { lockFileName, containerName, volumeName, phpImage } = require('../naming');
const crypto = require('crypto');
const { spawn } = require('child_process');
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

// Size of a folder in bytes and files. Used for the "Copied 120 MB of 310 MB" line.
async function folderSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch (err) {
          // A file that went away while counting.
        }
      }
    }
  }
  return { bytes, files };
}

function mb(bytes) {
  return `${Math.round(bytes / 1e6)} MB`;
}

// The fast way to fill the volume: this computer packs vendor/ with tar (built into Windows 10+, Mac and
// Linux) and streams it into a container that unpacks it into the volume. A shared folder is read file by file
// (slow on Windows and Mac: tens of thousands of files); one stream is many times faster.
// Resolves { ok, error? }. `progress(fraction, text)` gets called about once a second.
function copyVendorWithTar({ hostVendor, volume, image, log, progress, total, spawnFn = spawn, timeout = LONG_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    let sent = 0;
    const errors = [];
    // tar adds a header of 512 bytes (and padding) per file, so the stream is a bit bigger than the files.
    const expected = Math.max(1, total.bytes + total.files * 1024);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(timer);
      resolve(result);
    };

    const pack = spawnFn('tar', ['-cf', '-', '-C', hostVendor, '.'], { windowsHide: true });
    const unpack = spawnFn('docker', [
      'run', '--rm', '-i',
      '--mount', `type=volume,source=${volume},target=/dst`,
      '--entrypoint', 'sh', image, '-c', 'tar -xf - -C /dst',
    ], { windowsHide: true });

    const timer = setTimeout(() => {
      pack.kill();
      unpack.kill();
      finish({ ok: false, error: 'took too long' });
    }, timeout);

    const ticker = setInterval(() => {
      const fraction = Math.min(0.99, sent / expected);
      const text = `Copying vendor into the volume: ${mb(sent)} of about ${mb(expected)} (${Math.round(fraction * 100)}%)`;
      log(text);
      if (progress) progress(fraction, text);
    }, 1500);

    pack.on('error', (err) => finish({ ok: false, error: `tar could not start: ${err.message}` }));
    unpack.on('error', (err) => finish({ ok: false, error: `docker could not start: ${err.message}` }));
    pack.stderr.on('data', (chunk) => errors.push(String(chunk).trim()));
    unpack.stderr.on('data', (chunk) => errors.push(String(chunk).trim()));
    pack.stdout.on('data', (chunk) => {
      sent += chunk.length;
    });
    pack.stdout.pipe(unpack.stdin);
    // A closed stdin on the docker side (it failed) must not crash the app.
    unpack.stdin.on('error', () => {});

    // Both programs must end well. Their "close" events can come in either order.
    let packCode;
    let unpackCode;
    const judge = () => {
      if (packCode === undefined || unpackCode === undefined) return;
      if (packCode === 0 && unpackCode === 0) {
        if (progress) progress(1, `Copied ${mb(sent)} of vendor into the volume`);
        finish({ ok: true });
      } else {
        finish({ ok: false, error: errors.filter(Boolean).slice(-2).join(' | ') || `tar exit ${packCode}, docker exit ${unpackCode}` });
      }
    };
    pack.on('close', (code) => {
      packCode = code;
      judge();
    });
    unpack.on('close', (code) => {
      unpackCode = code;
      judge();
    });
  });
}

// Fills or updates the vendor volume of a running project. Resolves { ok, action, error? }.
// `progress(fraction, text)` (optional) moves the progress bar while vendor is copied.
async function syncVendorVolume({ projectName, folder, log = () => {}, progress = null, run = runDocker, stream = streamDocker, spawnFn = spawn }) {
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
    log('Copying the vendor folder into a Docker volume. This is done once');
    const total = await folderSize(hostVendor);
    log(`vendor has ${total.files} files, ${mb(total.bytes)}`);
    const fast = await copyVendorWithTar({ hostVendor, volume, image, log, progress, total, spawnFn });
    if (fast.ok) {
      res = { ok: true };
    } else {
      // No tar on this computer, or the stream failed: the slower copy through the shared folder.
      log(`The fast copy did not work (${fast.error}). Copying file by file, this can take several minutes`);
      res = await stream([
        'run', '--rm',
        '--mount', `type=bind,source=${hostVendor},target=/src,readonly`,
        '--mount', `type=volume,source=${volume},target=/dst`,
        '--entrypoint', 'sh', image, '-c', 'cp -a /src/. /dst/',
      ], log, { timeout: LONG_TIMEOUT_MS });
    }
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

module.exports = { syncVendorVolume, vendorPlan, lockHash, folderSize, copyVendorWithTar, VENDOR_TARGET, VENDOR_VOLUME, STAMP_FILE };
