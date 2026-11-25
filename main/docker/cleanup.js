'use strict';

// Disk use and cleanup for the whole Docker engine (docker system df / prune), not only ProjectDockHub.
// Prune kinds are a fixed list. Volumes are never pruned by name pattern: only anonymous unused ones are
// pruned, and named volumes are removed one by one after the user picked them (docker refuses a volume in use).

const { runDocker, firstLine } = require('./exec');
const { parseSize } = require('./stats');
const { PREFIX } = require('../naming');

const DF_TYPES = { Images: 'images', Containers: 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'build' };
const VOLUME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const LONG = 10 * 60 * 1000;

// What each button removes. "volumes" removes only anonymous volumes no container uses (Docker 23 and newer).
const PRUNE = {
  build: ['builder', 'prune', '-f'],
  dangling: ['image', 'prune', '-f'],
  images: ['image', 'prune', '-a', '-f'],
  containers: ['container', 'prune', '-f'],
  volumes: ['volume', 'prune', '-f'],
};

// "18.38GB (71%)" -> bytes. "0B" -> 0.
function sizeOf(text) {
  return parseSize(String(text || '').replace(/\s*\(.*\)\s*$/, ''));
}

// Output of `docker system df --format json`: one JSON object per line.
function parseDiskUsage(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const key = DF_TYPES[row.Type];
    if (!key) continue;
    out[key] = {
      total: Number(row.TotalCount) || 0,
      active: Number(row.Active) || 0,
      size: sizeOf(row.Size),
      reclaimable: sizeOf(row.Reclaimable),
    };
  }
  for (const key of Object.values(DF_TYPES)) {
    if (!out[key]) out[key] = { total: 0, active: 0, size: 0, reclaimable: 0 };
  }
  return out;
}

function labelMap(text) {
  const labels = {};
  for (const part of String(text || '').split(',')) {
    const at = part.indexOf('=');
    if (at > 0) labels[part.slice(0, at)] = part.slice(at + 1);
  }
  return labels;
}

// Who made a volume, from its labels: this app (any prefix, also an old one), a Compose project, or nobody (anonymous).
function volumeOwner(labels) {
  for (const [key, value] of Object.entries(labels)) {
    const m = /^com\.([a-z][a-z0-9-]{0,19})\.project$/.exec(key);
    if (m && m[1] !== 'docker' && labels[`com.${m[1]}.managed`] === 'true') {
      return { kind: 'app', project: value, prefix: m[1], current: m[1] === PREFIX };
    }
  }
  if (labels['com.docker.compose.project']) return { kind: 'compose', project: labels['com.docker.compose.project'] };
  if (Object.prototype.hasOwnProperty.call(labels, 'com.docker.volume.anonymous')) return { kind: 'anonymous', project: '' };
  return { kind: 'other', project: '' };
}

// Volumes no container uses (running or stopped), from `docker system df -v --format json`. Biggest first.
function parseUnusedVolumes(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (err) {
    return [];
  }
  const list = (data && Array.isArray(data.Volumes)) ? data.Volumes : [];
  return list
    .filter((v) => String(v.Links) === '0' && VOLUME_RE.test(String(v.Name || '')))
    .map((v) => ({ name: v.Name, size: sizeOf(v.Size), owner: volumeOwner(labelMap(v.Labels)) }))
    .sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));
}

async function diskUsage(run = runDocker) {
  const res = await run(['system', 'df', '--format', 'json'], { timeout: 120000 });
  if (!res.ok) throw new Error(firstLine(res.stderr) || 'Could not read the disk use from Docker');
  return parseDiskUsage(res.stdout);
}

async function unusedVolumes(run = runDocker) {
  const res = await run(['system', 'df', '-v', '--format', 'json'], { timeout: 180000 });
  if (!res.ok) throw new Error(firstLine(res.stderr) || 'Could not list the volumes');
  return parseUnusedVolumes(res.stdout);
}

// "Total reclaimed space: 1.2GB" (prune) or "Total:\t10.69GB" (builder prune) -> bytes.
function reclaimedOf(text) {
  const m = /Total(?: reclaimed space)?:\s*([0-9.]+\s*[A-Za-z]+)/i.exec(String(text || ''));
  return m ? parseSize(m[1].replace(/\s+/g, '')) : 0;
}

async function dockerMajor(run) {
  const res = await run(['version', '--format', '{{.Server.Version}}']);
  const m = /^(\d+)\./.exec(String(res.stdout || '').trim());
  return m ? Number(m[1]) : 0;
}

async function prune(kind, run = runDocker) {
  if (!Object.prototype.hasOwnProperty.call(PRUNE, kind)) throw new Error('Unknown cleanup');
  // Before Docker 23, volume prune also removed named volumes (database data). Never run it there.
  if (kind === 'volumes' && (await dockerMajor(run)) < 23) {
    throw new Error('This Docker is older than version 23, where removing unused volumes would also remove named volumes with data. Remove volumes one by one below instead.');
  }
  const res = await run(PRUNE[kind], { timeout: LONG });
  if (!res.ok) throw new Error(firstLine(res.stderr) || 'Docker could not clean up');
  return { ok: true, reclaimed: reclaimedOf(`${res.stdout}\n${res.stderr}`) };
}

// Named volumes the user picked. Docker itself refuses a volume a container still uses (no -f).
async function removeVolumes(names, run = runDocker) {
  if (!Array.isArray(names) || names.length === 0 || names.length > 500 || names.some((n) => typeof n !== 'string' || !VOLUME_RE.test(n))) {
    throw new Error('Invalid volume names');
  }
  const removed = [];
  const failed = [];
  for (const name of names) {
    const res = await run(['volume', 'rm', name], { timeout: 60000 });
    if (res.ok) removed.push(name);
    else failed.push({ name, error: firstLine(res.stderr) || 'could not remove' });
  }
  return { removed, failed };
}

module.exports = { parseDiskUsage, parseUnusedVolumes, volumeOwner, reclaimedOf, diskUsage, unusedVolumes, prune, removeVolumes, PRUNE };
