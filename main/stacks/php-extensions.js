'use strict';

const crypto = require('crypto');

// PHP extensions a Laravel project can add, and the php.ini lines it can set.
// The PHP image already has: pdo_mysql, mbstring, zip, bcmath, intl (see scaffold.js).
//   apt:       Debian packages the extension needs to compile
//   configure: flags for docker-php-ext-configure (run before the install)
//   pecl:      true for extensions that are not part of PHP itself (installed with pecl)
const EXTENSIONS = {
  gd: {
    label: 'GD (images: resize, crop, PNG, JPEG, WebP)',
    apt: ['libfreetype6-dev', 'libjpeg62-turbo-dev', 'libpng-dev', 'libwebp-dev'],
    configure: '--with-freetype --with-jpeg --with-webp',
  },
  exif: { label: 'EXIF (read photo information)' },
  pcntl: { label: 'PCNTL (queue workers, Horizon)' },
  sockets: { label: 'Sockets' },
  soap: { label: 'SOAP (web services)', apt: ['libxml2-dev'] },
  mysqli: { label: 'MySQLi' },
  pdo_pgsql: { label: 'PostgreSQL (pdo_pgsql)', apt: ['libpq-dev'] },
  gmp: { label: 'GMP (big numbers)', apt: ['libgmp-dev'] },
  calendar: { label: 'Calendar' },
  redis: { label: 'Redis (phpredis)', pecl: true },
  xdebug: { label: 'Xdebug (debugger, makes PHP slower)', pecl: true },
};

const MAX_INI_LENGTH = 20000;

function extensionList() {
  return Object.entries(EXTENSIONS).map(([key, def]) => ({ key, label: def.label }));
}

// A list of extension names from the form. Throws on a name that is not in the list above.
// The result is in the order of the list, without duplicates, so the same choice gives the same Dockerfile.
function normalizeExtensions(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('Invalid PHP extensions');
  for (const name of input) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(EXTENSIONS, name)) {
      throw new Error(`Unknown PHP extension: ${String(name).slice(0, 40)}`);
    }
  }
  const chosen = new Set(input);
  return Object.keys(EXTENSIONS).filter((key) => chosen.has(key));
}

// The text of the php.ini additions. Only comments, [sections] and key = value lines are accepted,
// so a typo is caught here and not when PHP fails to start.
function normalizePhpIni(input) {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new Error('Invalid php.ini text');
  if (input.length > MAX_INI_LENGTH) throw new Error(`php.ini is too long (the limit is ${MAX_INI_LENGTH} characters)`);
  if (input.includes('\0')) throw new Error('php.ini has an invalid character');
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === '' || text.startsWith(';') || /^\[[^\]\n]+\]$/.test(text)) return;
    if (!/^[A-Za-z0-9_.]+\s*=/.test(text)) {
      throw new Error(`php.ini line ${index + 1} is not valid. Use the form: name = value`);
    }
  });
  const text = lines.join('\n').trim();
  return text === '' ? '' : `${text}\n`;
}

// Part of the PHP service config. When the text changes, Docker recreates the container,
// so PHP reads the new php.ini without a manual restart.
function iniHash(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 12);
}

// The extra lines of the PHP Dockerfile for a list of extensions.
// Returns { packages: [...], configure: [...], install: [...], pecl: [...] }.
function dockerfileParts(extensions) {
  const chosen = normalizeExtensions(extensions);
  const packages = [];
  const configure = [];
  const install = [];
  const pecl = [];
  for (const key of chosen) {
    const def = EXTENSIONS[key];
    if (def.pecl) {
      pecl.push(key);
      continue;
    }
    for (const pkg of def.apt || []) if (!packages.includes(pkg)) packages.push(pkg);
    if (def.configure) configure.push(`docker-php-ext-configure ${key} ${def.configure}`);
    install.push(key);
  }
  return { packages, configure, install, pecl };
}

module.exports = {
  EXTENSIONS,
  MAX_INI_LENGTH,
  extensionList,
  normalizeExtensions,
  normalizePhpIni,
  iniHash,
  dockerfileParts,
};
