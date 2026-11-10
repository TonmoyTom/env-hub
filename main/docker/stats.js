'use strict';

// Live numbers for the project details page: CPU and memory of the running containers, the size of
// the project's volumes, and opening a shell in one service. Every docker call uses an argument array.

const { spawn } = require('child_process');
const { runDocker, firstLine } = require('./exec');
const { NAME_RE } = require('../compose/generate');
const { projectVolumeNames } = require('./containers');

const BINARY = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
const DECIMAL = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

// "312MiB" -> bytes, "1.4GB" -> bytes. Anything unknown is 0 so one odd value never breaks the page.
function parseSize(text, table = { ...BINARY, ...DECIMAL }) {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*$/.exec(String(text || ''));
  if (!m) return 0;
  const unit = table[m[2].toUpperCase()];
  return unit ? Math.round(Number(m[1]) * unit) : 0;
}

// Output of `docker stats --no-stream --format {{json .}}`, one JSON object per line.
// The container name is envhub-<project>-<service>, so the service is the part after the project.
function parseStatsLines(text, projectName) {
  const prefix = `envhub-${projectName}-`;
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch (err) {
      continue;
    }
    const container = String(item.Name || '');
    const used = String(item.MemUsage || '').split('/')[0];
    rows.push({
      container,
      service: container.startsWith(prefix) ? container.slice(prefix.length) : container,
      cpuPercent: Number.parseFloat(item.CPUPerc) || 0,
      memBytes: parseSize(used),
      memPercent: Number.parseFloat(item.MemPerc) || 0,
    });
  }
  return rows;
}

// Output of `docker system df -v` (plain text). Only the "Local Volumes" table is read.
// Columns are separated by two or more spaces: VOLUME NAME, LINKS, SIZE.
function parseVolumeSizes(text, projectName) {
  const prefix = `envhub-${projectName}-`;
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line) => /^VOLUME NAME\s+LINKS\s+SIZE/.test(line.trim()));
  if (start < 0) return [];
  const volumes = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) break;
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 3) break;
    if (cols[0].startsWith(prefix)) {
      volumes.push({ name: cols[0], bytes: parseSize(cols[cols.length - 1], DECIMAL) });
    }
  }
  return volumes;
}

function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
}

// CPU and memory of the running containers of one project.
async function projectStats(projectName) {
  assertName(projectName);
  const ids = await runDocker([
    'ps', '-q',
    '--filter', 'label=com.envhub.managed=true',
    '--filter', `label=com.envhub.project=${projectName}`,
  ]);
  const idList = ids.ok ? ids.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  if (idList.length === 0) {
    return { cpuPercent: 0, memBytes: 0, memPercent: 0, containers: [] };
  }
  const res = await runDocker(['stats', '--no-stream', '--format', '{{json .}}', ...idList], { timeout: 30000 });
  if (!res.ok) {
    throw new Error(firstLine(res.stderr) || 'Could not read the container numbers');
  }
  const containers = parseStatsLines(res.stdout, projectName);
  return {
    cpuPercent: containers.reduce((sum, c) => sum + c.cpuPercent, 0),
    memBytes: containers.reduce((sum, c) => sum + c.memBytes, 0),
    memPercent: containers.reduce((sum, c) => sum + c.memPercent, 0),
    containers,
  };
}

// Size of the project's named volumes (the database data), in bytes.
async function projectDisk(projectName) {
  assertName(projectName);
  const names = await projectVolumeNames(projectName);
  if (names.length === 0) {
    return { bytes: 0, volumes: [] };
  }
  const res = await runDocker(['system', 'df', '-v'], { timeout: 60000 });
  if (!res.ok) {
    throw new Error(firstLine(res.stderr) || 'Could not read the volume sizes');
  }
  const volumes = parseVolumeSizes(res.stdout, projectName);
  return { bytes: volumes.reduce((sum, v) => sum + v.bytes, 0), volumes };
}

// The argument list for a terminal window that runs a shell in one container.
// Only the container name is put in, and it is built from names that were already checked.
function shellArgs(container) {
  return ['exec', '-it', container, 'sh'];
}

// Opens a terminal window with a shell in the container. Returns when the window was started.
async function openShell(projectName, service, { platform = process.platform, spawnFn } = {}) {
  assertName(projectName);
  if (typeof service !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(service)) {
    throw new Error('Unknown service');
  }
  const container = `envhub-${projectName}-${service}`;
  const running = await runDocker([
    'ps', '--filter', `name=^${container}$`, '--filter', 'status=running', '--format', '{{.Names}}',
  ]);
  if (!running.ok || !running.stdout.split('\n').some((l) => l.trim() === container)) {
    throw new Error('Start the project first. This service is not running.');
  }

  const launch = spawnFn || spawn;
  const dockerLine = ['docker', ...shellArgs(container)].join(' ');

  return new Promise((resolve, reject) => {
    let child;
    if (platform === 'win32') {
      // `start ""` opens a new console window; the empty title is required.
      child = launch('cmd.exe', ['/d', '/s', '/c', `start "" cmd /k ${dockerLine}`], {
        detached: true, stdio: 'ignore', windowsVerbatimArguments: true,
      });
    } else if (platform === 'darwin') {
      const script = `tell application "Terminal" to do script "${dockerLine}"`;
      child = launch('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    } else {
      child = launch('x-terminal-emulator', ['-e', ...['docker', ...shellArgs(container)]], {
        detached: true, stdio: 'ignore',
      });
    }
    child.once('error', (err) => {
      reject(new Error(err.code === 'ENOENT' ? 'No terminal app was found on this computer' : err.message));
    });
    child.once('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

module.exports = {
  parseSize,
  parseStatsLines,
  parseVolumeSizes,
  projectStats,
  projectDisk,
  openShell,
  shellArgs,
};
