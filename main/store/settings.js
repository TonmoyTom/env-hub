'use strict';

const fs = require('fs');
const path = require('path');

// Small user settings, kept in <app data>/settings.json. No secrets here.
//   projectsDir  where NEW projects are created (empty = the default folder)
//   projectDirs  every folder that was ever used for projects, so a project made earlier in another
//                folder can still be deleted together with its files
let file = null;
let data = { projectsDir: '', projectDirs: [] };

function init(dir) {
  file = path.join(dir, 'settings.json');
  data = { projectsDir: '', projectDirs: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.projectsDir === 'string') data.projectsDir = saved.projectsDir;
    if (Array.isArray(saved.projectDirs)) data.projectDirs = saved.projectDirs.filter((d) => typeof d === 'string');
  } catch (err) {
    // No file yet, or a broken one: start with the defaults.
  }
}

function save() {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// The folder new projects go to.
function projectsBaseDir(defaultDir) {
  return data.projectsDir || defaultDir;
}

// All folders that can hold projects (current, earlier ones, the default), without repeats.
function knownProjectDirs(defaultDir) {
  return [...new Set([data.projectsDir, ...data.projectDirs, defaultDir].filter(Boolean).map((d) => path.resolve(d)))];
}

// Checks the folder the user chose and saves it. It must be an absolute path that exists or can be made,
// must be writable, and must not be envhub's own data folder. Returns the resolved path.
function setProjectsDir(folder, { dataDir } = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new Error('Choose a full folder path, like C:/Projects');
  }
  const dir = path.resolve(folder);
  if (dataDir) {
    const own = path.resolve(dataDir);
    if (dir === own || dir.startsWith(own + path.sep)) throw new Error('Choose another folder: this one belongs to envhub itself');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.envhub-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    throw new Error(`Cannot write in this folder: ${dir}`);
  }
  const before = data.projectsDir;
  if (before && before !== dir && !data.projectDirs.includes(before)) data.projectDirs.push(before);
  data.projectsDir = dir;
  save();
  return dir;
}

// Back to the default folder. Earlier folders are remembered.
function resetProjectsDir() {
  if (data.projectsDir && !data.projectDirs.includes(data.projectsDir)) data.projectDirs.push(data.projectsDir);
  data.projectsDir = '';
  save();
}

module.exports = { init, projectsBaseDir, knownProjectDirs, setProjectsDir, resetProjectsDir };
