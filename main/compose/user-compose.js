'use strict';

// Projects that run the user's own docker-compose.yml ("compose" stack).
// The user's file is used as it is and never written to. A second, small file (override.json in the app data
// folder) adds only the ProjectDockHub labels and container names, so Logs, Shell, Stats, Data and the
// Containers page find the containers like any other project:
//   docker compose -f <their file> -f <override.json> -p <prefix>-<project> up -d
// Docker Compose itself reads the user's file (and its .env), so every Compose feature keeps working.

const fs = require('fs');
const path = require('path');
const { LABELS, composeProject, containerName } = require('../naming');
const { runDocker, firstLine } = require('../docker/exec');
const { NAME_RE } = require('./generate');

// The names `docker compose` looks for, in its own order.
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/;
// Container ports that are usually the web page, best first. Decides what the Open button opens.
const WEB_PORTS = [80, 8080, 8000, 3000, 5173, 4200, 5000, 8081, 443, 8443];

function findComposeFile(folder) {
  for (const name of COMPOSE_FILES) {
    try {
      if (fs.statSync(path.join(folder, name)).isFile()) return name;
    } catch (err) {
      // Not there: try the next name.
    }
  }
  return null;
}

// A file name inside the project folder, never a path elsewhere.
function assertComposeFileName(name) {
  if (typeof name !== 'string' || !FILE_RE.test(name)) throw new Error('Invalid compose file name');
  return name;
}

// The app's own name for a Compose service: lowercase letters, digits and dashes (php_fpm -> php-fpm).
// Compose itself keeps the real name; only labels and container names use this one.
function aliasFor(name, used) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s-${base}`;
  base = base.slice(0, 36).replace(/-+$/, '') || 's';
  let alias = base;
  for (let n = 2; used.has(alias); n += 1) alias = `${base}-${n}`;
  used.add(alias);
  return alias;
}

// "8099" -> 8099. Ranges ("8000-8005") and random ports ("") are left out: the app cannot open those.
function hostPortOf(published) {
  const text = String(published === undefined || published === null ? '' : published);
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

// The JSON of `docker compose config --format json` -> what the app keeps about the project.
// composeName: the real service name. name: the app's name (same, or the alias).
function summarizeComposeConfig(config, projectName) {
  const services = [];
  const warnings = [];
  const used = new Set();
  const entries = Object.entries((config && config.services) || {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) throw new Error('The compose file has no services');
  if (entries.length > 40) throw new Error('The compose file has more than 40 services');

  for (const [composeName, svc] of entries) {
    const name = aliasFor(composeName, used);
    const build = Boolean(svc.build);
    const image = svc.image || (build ? `${composeProject(projectName)}-${composeName}` : '');
    const ports = [];
    for (const p of svc.ports || []) {
      const host = hostPortOf(p.published);
      const container = Number(p.target);
      if (host === null || !Number.isInteger(container)) continue;
      if (p.protocol && p.protocol !== 'tcp') continue;
      ports.push({ host, container, lan: !p.host_ip || p.host_ip === '0.0.0.0' || p.host_ip === '::' });
    }
    const replicas = Number((svc.deploy && svc.deploy.replicas) || svc.scale || 1);
    if (replicas > 1) warnings.push(`${composeName} runs ${replicas} copies. Shell, Data and "Why?" use the first one.`);
    services.push({ name, composeName, image, build, ports, replicas });
  }

  // The service whose port looks most like a web page.
  let web = null;
  for (const want of WEB_PORTS) {
    for (const svc of services) {
      const hit = svc.ports.find((p) => p.container === want);
      if (hit && !web) web = { service: svc.name, port: hit.container };
    }
  }
  if (!web) {
    const first = services.find((svc) => svc.ports.length > 0);
    if (first) web = { service: first.name, port: first.ports[0].container };
  }
  return { services, warnings, webService: web ? web.service : '', webPort: web ? web.port : null };
}

// The second Compose file: labels and container names only. Copies of a scaled service keep Compose's names.
function overrideFor(projectName, services) {
  const out = {};
  for (const svc of services) {
    const entry = {
      labels: {
        [LABELS.managed]: 'true',
        [LABELS.project]: projectName,
        [LABELS.service]: svc.name,
        [LABELS.stack]: 'compose',
      },
    };
    if (!(svc.replicas > 1)) entry.container_name = containerName(projectName, svc.name);
    out[svc.composeName] = entry;
  }
  return { services: out };
}

function composeFilePath(spec) {
  return path.join(spec.folder, assertComposeFileName(spec.composeFile));
}

function overridePath(dataDir, projectName) {
  return path.join(dataDir, 'projects', projectName, 'override.json');
}

function writeOverride(dataDir, projectName, services) {
  const file = overridePath(dataDir, projectName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(overrideFor(projectName, services), null, 2)}\n`, { mode: 0o600 });
  return file;
}

// docker compose arguments for one project: the user's file first (its folder is the project folder,
// so relative paths and .env work as with a plain `docker compose up`), then the override.
function composeArgsFor(spec, override) {
  const args = ['compose', '-f', composeFilePath(spec)];
  if (override) args.push('-f', override);
  args.push('-p', composeProject(spec.name));
  return args;
}

// Reads the user's file through Docker Compose, so .env values, extends and includes are resolved
// exactly as `docker compose up` would.
async function readComposeConfig(spec, run = runDocker) {
  if (!NAME_RE.test(spec.name)) throw new Error('Invalid project name');
  const file = composeFilePath(spec);
  if (!fs.existsSync(file)) throw new Error(`${spec.composeFile} is not in ${spec.folder} any more`);
  const res = await run([...composeArgsFor(spec, null), 'config', '--format', 'json'], { timeout: 60000 });
  if (!res.ok) {
    throw new Error(`Docker Compose could not read ${spec.composeFile}: ${firstLine(res.stderr) || 'unknown error'}`);
  }
  let config;
  try {
    config = JSON.parse(res.stdout);
  } catch (err) {
    throw new Error('Docker Compose gave an answer that could not be read');
  }
  return summarizeComposeConfig(config, spec.name);
}

module.exports = {
  COMPOSE_FILES,
  findComposeFile,
  assertComposeFileName,
  aliasFor,
  summarizeComposeConfig,
  overrideFor,
  writeOverride,
  overridePath,
  composeArgsFor,
  composeFilePath,
  readComposeConfig,
};
