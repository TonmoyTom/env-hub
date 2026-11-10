'use strict';

const fs = require('fs');
const path = require('path');

// The store keeps project specs (name, stack, folder), not full Compose configs.
// Secrets are never saved here.
const DEMO_SPEC = {
  name: 'demo',
  stack: 'custom',
  services: [
    {
      name: 'redis',
      image: 'redis:7',
      ports: [{ host: 6380, container: 6379 }],
    },
  ],
};

let file = null;
let specs = new Map([[DEMO_SPEC.name, DEMO_SPEC]]);

// Host ports actually used by a running project, e.g. [{ service, container, host }].
// Cleared when the project stops.
const assignments = new Map();

function init(dataDir) {
  file = path.join(dataDir, 'projects.json');
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(list)) {
      specs = new Map(list.map((s) => [s.name, s]));
    }
  } catch (err) {
    // First run: keep the demo project.
  }
}

function save() {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...specs.values()], null, 2) + '\n', { mode: 0o600 });
}

function getSpec(name) {
  return specs.get(name) || null;
}

function listSpecs() {
  return [...specs.values()];
}

function addSpec(spec) {
  specs.set(spec.name, spec);
  save();
}

// Changes some fields of a saved project. A field set to undefined is removed.
// Returns the new spec, or null when the project does not exist.
function updateSpec(name, changes) {
  const spec = specs.get(name);
  if (!spec) return null;
  const next = { ...spec, ...changes };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  specs.set(name, next);
  save();
  return next;
}

// Remembers the host ports a project started with, so it keeps the same URLs next time.
function setHostPorts(name, hostPorts) {
  const spec = specs.get(name);
  if (!spec) return;
  specs.set(name, { ...spec, hostPorts });
  save();
}

function removeSpec(name) {
  specs.delete(name);
  assignments.delete(name);
  save();
}

function getAssignments(name) {
  return assignments.get(name) || null;
}

function setAssignments(name, list) {
  assignments.set(name, list);
}

function clearAssignments(name) {
  assignments.delete(name);
}

// Host ports held by other projects, so two ProjectDockHub projects never pick the same port.
function hostPortsUsedByOthers(name) {
  const used = new Set();
  for (const [owner, list] of assignments) {
    if (owner === name) continue;
    for (const p of list) used.add(p.host);
  }
  return used;
}

module.exports = {
  init,
  getSpec,
  listSpecs,
  addSpec,
  updateSpec,
  setHostPorts,
  removeSpec,
  getAssignments,
  setAssignments,
  clearAssignments,
  hostPortsUsedByOthers,
};
