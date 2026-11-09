'use strict';

const fs = require('fs');
const path = require('path');

// True only when `folder` is a real subfolder of `base`, never `base` itself or anything outside it.
function isInside(base, folder) {
  if (typeof base !== 'string' || typeof folder !== 'string' || !base || !folder) return false;
  const relative = path.relative(path.resolve(base), path.resolve(folder));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// Deletes a project's folder, but only inside the envhub projects folder.
// Returns { deleted, missing, error }. It never throws.
function removeProjectFolder(base, folder) {
  if (!isInside(base, folder)) {
    return { deleted: false, missing: false, error: 'The folder is outside the envhub projects folder, so it was left alone.' };
  }
  if (!fs.existsSync(folder)) {
    return { deleted: false, missing: true, error: null };
  }
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    return { deleted: true, missing: false, error: null };
  } catch (err) {
    return { deleted: false, missing: false, error: err.message };
  }
}

module.exports = { isInside, removeProjectFolder };
