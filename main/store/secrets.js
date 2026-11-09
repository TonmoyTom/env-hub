'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Secrets are generated once per machine and kept in the app data folder.
// They are never logged and never written into the repo.
function secretsFile(dataDir) {
  return path.join(dataDir, 'secrets.json');
}

function loadAll(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(secretsFile(dataDir), 'utf8'));
  } catch (err) {
    return {};
  }
}

function getOrCreateSecret(dataDir, key) {
  const all = loadAll(dataDir);
  if (!all[key]) {
    all[key] = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretsFile(dataDir), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  }
  return all[key];
}

module.exports = { getOrCreateSecret };
