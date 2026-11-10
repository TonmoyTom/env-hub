'use strict';

const fs = require('fs');
const path = require('path');
const { isInside } = require('./folders');

// Writes the .env text into the project folder (inside the ProjectDockHub projects folder only).
// An existing .env that differs is copied to .env.envhub-backup (or -2, -3...) first, never lost.
// Returns { status: 'created' | 'updated' | 'unchanged', file, backup }. Throws a readable error.
function writeEnvFile(base, folder, text) {
  if (!isInside(base, folder)) {
    throw new Error('The project folder is outside the ProjectDockHub projects folder, so no .env was written.');
  }
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error('The project folder does not exist any more.');
  }

  const file = path.join(folder, '.env');
  let existing = null;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('.env is a link, so it was left alone.');
    existing = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (existing === text) return { status: 'unchanged', file, backup: null };

  let backup = null;
  if (existing !== null) {
    backup = path.join(folder, '.env.envhub-backup');
    for (let i = 2; fs.existsSync(backup); i += 1) backup = path.join(folder, `.env.envhub-backup-${i}`);
    fs.writeFileSync(backup, existing, { mode: 0o600 });
  }

  fs.writeFileSync(file, text, { mode: 0o600 });
  return { status: existing === null ? 'created' : 'updated', file, backup };
}

module.exports = { writeEnvFile };
