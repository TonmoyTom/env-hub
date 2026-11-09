'use strict';

const { validateProject, IMAGE_RE } = require('../compose/generate');
const { hostPortFor } = require('./docker');

// Extra services the user adds by hand on top of any stack: any Docker Hub image,
// with optional ports, environment variables and a start command.
const MAX_EXTRAS = 8;
const MAX_PORTS = 5;
const RESERVED = ['nginx', 'php', 'node', 'app', 'mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit'];

// "getmeili/meilisearch:v1.10" -> "meilisearch". Adds -2, -3 when the name is taken.
function serviceNameFor(image, taken) {
  let base = image.split(':')[0].split('/').pop().toLowerCase()
    .replace(/[._]+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (!/^[a-z]/.test(base)) base = `svc-${base}`;
  base = base.slice(0, 36).replace(/-+$/, '') || 'service';

  let name = base;
  let n = 2;
  while (taken.has(name)) {
    name = `${base}-${n}`;
    n += 1;
  }
  return name;
}

function parsePorts(value) {
  if (value === undefined || value === null || value === '') return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[,\s]+/).filter(Boolean);
  if (parts.length > MAX_PORTS) {
    throw new Error(`Use at most ${MAX_PORTS} ports per service`);
  }
  return parts.map((part) => {
    const port = Number(part);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${part}`);
    }
    return port;
  });
}

// One KEY=value per line.
function parseEnv(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  if (typeof value !== 'string') throw new Error('Invalid environment variables');

  const env = {};
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    if (at < 1) {
      throw new Error(`Invalid environment line: ${line.slice(0, 40)}. Use KEY=value`);
    }
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return env;
}

// Split on spaces and passed as is, with no shell, so it is added to the image's own entry point.
function parseCommand(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') throw new Error('Invalid command');
  return value.split(/\s+/).filter(Boolean);
}

// Where known databases and stores keep their data inside the container, by image name.
// A Docker volume is mounted there, so the data survives a new container (Stop and Start, Edit services).
// An image that is not in the list gets no volume, as before.
const DATA_PATHS = {
  mariadb: '/var/lib/mysql',
  mysql: '/var/lib/mysql',
  percona: '/var/lib/mysql',
  mongo: '/data/db',
  redis: '/data',
  valkey: '/data',
  rabbitmq: '/var/lib/rabbitmq',
  elasticsearch: '/usr/share/elasticsearch/data',
  opensearch: '/usr/share/opensearch/data',
  meilisearch: '/meili_data',
  minio: '/data',
  clickhouse: '/var/lib/clickhouse',
  'clickhouse-server': '/var/lib/clickhouse',
  cassandra: '/var/lib/cassandra',
  couchdb: '/opt/couchdb/data',
  neo4j: '/data',
  influxdb: '/var/lib/influxdb2',
  server: '/var/opt/mssql',
};

// The data folder of an image, or '' when it is not known. PostgreSQL 18 and newer moved it.
function dataPathFor(image) {
  const [repo, tag = ''] = String(image).split(':');
  const base = repo.split('/').pop().toLowerCase();
  if (base === 'postgres' || base === 'postgis') {
    const major = Number.parseInt(tag, 10);
    return Number.isNaN(major) || major >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data';
  }
  // "mcr.microsoft.com/mssql/server" has the generic name "server", so it is matched with its registry.
  if (base === 'server' && !/mssql/.test(repo)) return '';
  return DATA_PATHS[base] || '';
}

// The services as they are saved in the project: { name, image, ports: [int], env, command }.
function toService(extra) {
  const service = { name: extra.name, image: extra.image };
  if (extra.ports.length > 0) {
    service.ports = extra.ports.map((port) => ({ host: hostPortFor(port), container: port }));
  }
  if (Object.keys(extra.env).length > 0) service.env = extra.env;
  if (extra.command.length > 0) service.command = extra.command;
  const dataPath = dataPathFor(extra.image);
  if (dataPath) service.dataVolumes = [{ name: 'data', target: dataPath }];
  return service;
}

// Checks what the form sent and returns the clean list. Throws on anything wrong.
// `previous` is the saved list of a project that is being edited. An item that carries the name
// of one of those keeps it, so removing one service does not rename (and so replace) the others.
function normalizeExtraServices(list, previous = []) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('Invalid extra services');
  if (list.length > MAX_EXTRAS) throw new Error(`Add at most ${MAX_EXTRAS} extra services`);

  const known = new Set(
    (Array.isArray(previous) ? previous : [])
      .map((p) => p && p.name)
      .filter((n) => typeof n === 'string'),
  );
  const taken = new Set(RESERVED);

  // Names to keep are reserved first, so a new service never takes one of them.
  const kept = list.map((item) => {
    const wanted = item && typeof item === 'object' && typeof item.name === 'string' ? item.name : '';
    if (known.has(wanted) && !taken.has(wanted)) {
      taken.add(wanted);
      return wanted;
    }
    return null;
  });

  const result = [];

  list.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid extra service');
    const image = typeof item.image === 'string' ? item.image.trim() : '';
    if (!IMAGE_RE.test(image)) {
      throw new Error(`Invalid image: ${image.slice(0, 60) || '(empty)'}`);
    }

    const name = kept[i] || serviceNameFor(image, taken);
    taken.add(name);
    result.push({
      name,
      image,
      ports: parsePorts(item.ports),
      env: parseEnv(item.env),
      command: parseCommand(item.command),
    });
  });

  // The same checks the Compose file gets, so a bad value is caught here and not at start.
  if (result.length > 0) {
    validateProject({ name: 'check', services: result.map(toService) });
  }
  return result;
}

// Service objects for a saved project, ready to add to its service list.
function extraServicesOf(spec) {
  return Array.isArray(spec.extraServices) ? spec.extraServices.map(toService) : [];
}

module.exports = { normalizeExtraServices, extraServicesOf, dataPathFor, MAX_EXTRAS };
