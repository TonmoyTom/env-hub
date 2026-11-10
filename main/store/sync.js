'use strict';

// "Sync projects": move the list of projects to another computer (or back up), as one JSON file.
// Passwords are never written to the file. Pure functions: no file or Docker access here.

const { NAME_RE } = require('../compose/generate');

const FORMAT = 'envhub-projects';
const VERSION = 1;
// Fields that hold a secret. They are removed on export, the other computer makes its own.
const SECRET_FIELDS = ['dbPassword', 'redisPassword'];

function clean(spec) {
  const copy = JSON.parse(JSON.stringify(spec));
  for (const key of SECRET_FIELDS) delete copy[key];
  if (copy.mail && typeof copy.mail === 'object') delete copy.mail.password;
  // Ports are chosen again on the other computer.
  delete copy.hostPorts;
  return copy;
}

// The projects that ProjectDockHub made or imported (the built in demo is left out).
function exportProjects(specs, now = new Date()) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    projects: specs.filter((s) => s && s.stack && s.stack !== 'custom').map(clean),
  };
}

// Decides which projects of an export file can be added here.
// `folderExists(path)` tells if a project folder exists on this computer.
// Returns { add: [spec], skipped: [{ name, reason }] }. Throws when the file is not a ProjectDockHub export.
function planImport(data, { existingNames, creatableStacks, folderExists }) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.projects)) {
    throw new Error('This file is not a ProjectDockHub projects file.');
  }
  if (data.version > VERSION) {
    throw new Error('This file was made by a newer ProjectDockHub. Update ProjectDockHub first.');
  }

  const add = [];
  const skipped = [];
  const taken = new Set(existingNames);

  for (const spec of data.projects) {
    const name = spec && typeof spec.name === 'string' ? spec.name : '(no name)';
    if (!spec || typeof spec !== 'object' || !NAME_RE.test(name)) {
      skipped.push({ name, reason: 'invalid name' });
    } else if (!creatableStacks.includes(spec.stack)) {
      skipped.push({ name, reason: `unknown stack "${spec.stack}"` });
    } else if (taken.has(name)) {
      skipped.push({ name, reason: 'a project with this name already exists' });
    } else if (typeof spec.folder !== 'string' || !folderExists(spec.folder)) {
      skipped.push({ name, reason: `folder not found on this computer: ${spec.folder || '(none)'}` });
    } else {
      taken.add(name);
      add.push(clean(spec));
    }
  }
  return { add, skipped };
}

module.exports = { exportProjects, planImport, FORMAT, VERSION };
