'use strict';

// Service catalog: what ProjectDockHub knows about a Docker image, so it can show credentials and .env lines
// for any service, not only the built-in ones. One entry per kind of service, matched by the image name.
//
// Built-in entries are in services-catalog.json next to this file. The user can add or change entries in
// <app data>/services-catalog.json: the same format, and an entry with the same "id" replaces the built-in one.
// Both files are read again on every call, so an edit shows up without restarting the app.
//
// Placeholders in "fields", "env", "user", "password", "database":
//   {service}              the service name (the host inside Docker)
//   {host}                 the service name inside Docker, 127.0.0.1 from this computer
//   {port:NAME}            the container port inside Docker, the published port from this computer
//   {user} {password} {database}   the entry's own values (themselves templates)
//   {auth}                 "user:password@" when there is a user, else nothing (for URLs)
//   {env:A,B|default}      the first of the service's environment values A, B that is set, else default
//   {password|null}        the value, or "null" when it is empty (any placeholder can have |fallback)

const fs = require('fs');
const path = require('path');

const BUILT_IN = path.join(__dirname, 'services-catalog.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SECRET_KEY_RE = /PASS|SECRET|TOKEN|KEY/i;

function readFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data && Array.isArray(data.services) ? data.services : [];
    return { entries: list.filter(validEntry), error: '' };
  } catch (err) {
    if (err.code === 'ENOENT') return { entries: [], error: '' };
    return { entries: [], error: `${path.basename(file)}: ${err.message}` };
  }
}

function validEntry(e) {
  return Boolean(e) && typeof e === 'object' && typeof e.id === 'string' && ID_RE.test(e.id)
    && Array.isArray(e.match) && e.match.every((m) => typeof m === 'string' && m.length > 0 && m.length < 200);
}

// The user's entries first; one with the same id replaces the built-in one.
function loadCatalog(userFile, builtInFile = BUILT_IN) {
  const user = userFile ? readFile(userFile) : { entries: [], error: '' };
  const builtIn = readFile(builtInFile);
  const ids = new Set(user.entries.map((e) => e.id));
  return { entries: [...user.entries, ...builtIn.entries.filter((e) => !ids.has(e.id))], error: user.error };
}

// "docker.io/library/redis:7-alpine" -> "redis", "ghcr.io/x/y@sha256:..." -> "ghcr.io/x/y".
function imageRepo(image) {
  let name = String(image || '').trim().toLowerCase();
  name = name.split('@')[0];
  const slash = name.lastIndexOf('/');
  const colon = name.lastIndexOf(':');
  if (colon > slash) name = name.slice(0, colon);
  return name.replace(/^(docker\.io\/|index\.docker\.io\/|registry-1\.docker\.io\/)/, '').replace(/^library\//, '');
}

function findEntry(entries, image) {
  const repo = imageRepo(image);
  return entries.find((e) => e.match.some((m) => imageRepo(m) === repo)) || null;
}

// Fills one template. `ctx` has service, host, ports (name -> number or null), env, and the resolved
// user / password / database. Returns null when a port it needs is not published (from this computer).
function fill(template, ctx) {
  let missing = false;
  const text = String(template).replace(/\{([a-z]+)(?::([A-Za-z0-9_,]+))?(?:\|([^}]*))?\}/g, (all, key, arg, fallback) => {
    let value;
    if (key === 'service') value = ctx.service;
    else if (key === 'host') value = ctx.host;
    else if (key === 'port') {
      const port = ctx.ports[arg];
      if (port === null || port === undefined) {
        missing = true;
        return '';
      }
      value = String(port);
    } else if (key === 'env') {
      const names = String(arg || '').split(',');
      const hit = names.find((n) => ctx.env[n] !== undefined && ctx.env[n] !== '');
      value = hit ? String(ctx.env[hit]) : '';
    } else if (key === 'user' || key === 'password' || key === 'database') value = ctx[key] || '';
    else if (key === 'auth') value = ctx.user ? `${encodeURIComponent(ctx.user)}:${encodeURIComponent(ctx.password || '')}@` : '';
    else return all;
    return value === '' && fallback !== undefined ? fallback : value;
  });
  return missing ? null : text;
}

function contextFor(entry, { service, env, containerPorts, hostPorts }, where) {
  const ports = {};
  for (const [name, containerPort] of Object.entries(entry.ports || {})) {
    ports[name] = where === 'docker' ? containerPort : hostPorts.get(Number(containerPort)) ?? null;
  }
  const ctx = { service, host: where === 'docker' ? service : '127.0.0.1', ports, env };
  // user / password / database are templates themselves (usually {env:...|default}).
  ctx.user = entry.user ? fill(entry.user, ctx) || '' : '';
  ctx.password = entry.password ? fill(entry.password, ctx) || '' : '';
  ctx.database = entry.database ? fill(entry.database, ctx) || '' : '';
  return ctx;
}

// One card for the Credentials tab. `ports` is [{ container, host }] of this service.
function describeService(entries, { name, image, env = {}, ports = [] }) {
  const hostPorts = new Map(ports.filter((p) => p.host).map((p) => [Number(p.container), Number(p.host)]));
  const entry = findEntry(entries, image);
  if (!entry) {
    // Not in the catalog: the ports and environment values of the service, as they are.
    const fields = ports.map((p) => ({
      label: `Port ${p.container}`,
      value: p.host ? `localhost:${p.host} (inside Docker ${name}:${p.container})` : `${name}:${p.container} (inside Docker only)`,
      secret: false,
    }));
    for (const [key, value] of Object.entries(env)) fields.push({ label: key, value: String(value), secret: SECRET_KEY_RE.test(key) });
    return { name, image, known: false, label: name, kind: 'other', note: 'Not in the service catalog. Add it in Settings > Services catalog to get .env lines.', fields, env: null, web: null };
  }

  const facts = { service: name, env, hostPorts };
  const inDocker = contextFor(entry, facts, 'docker');
  const onHost = contextFor(entry, facts, 'host');
  const fields = (entry.fields || [])
    .map((f) => ({ label: String(f.label || ''), value: fill(f.value, inDocker), secret: f.secret === true }))
    .filter((f) => f.label && f.value !== null && f.value !== '');
  const lines = (list, ctx) => {
    const out = (list || []).map((line) => fill(line, ctx));
    return out.some((l) => l === null) ? null : out.join('\n');
  };
  const webPort = entry.web && entry.ports ? hostPorts.get(Number(entry.ports[entry.web])) || null : null;
  return {
    name,
    image,
    known: true,
    id: entry.id,
    label: entry.label || entry.id,
    kind: entry.kind || 'other',
    viewer: entry.viewer || '',
    note: entry.note || '',
    fields,
    // Inside Docker always works; from this computer only when the ports it needs are published.
    env: entry.env ? { docker: lines(entry.env, inDocker), host: lines(entry.env, onHost) } : null,
    // The service's own web page, when it has one and its port is published.
    web: webPort ? { port: webPort, url: `http://localhost:${webPort}` } : null,
  };
}

const USER_FILE_EXAMPLE = {
  _help: 'Your own service catalog. Entries here are added to the built-in ones; one with the same id replaces it. See the built-in entries for every field. Placeholders: {service} {host} {port:NAME} {user} {password} {database} {auth} {env:NAME1,NAME2|default}.',
  services: [
    {
      id: 'my-search',
      label: 'My search engine',
      kind: 'search',
      match: ['example/my-search'],
      ports: { http: 9300 },
      web: 'http',
      password: '{env:MY_SEARCH_KEY|}',
      fields: [
        { label: 'URL', value: 'http://{host}:{port:http}' },
        { label: 'Key', value: '{password}', secret: true },
      ],
      env: ['MY_SEARCH_URL=http://{host}:{port:http}', 'MY_SEARCH_KEY={password}'],
    },
  ],
};

module.exports = { loadCatalog, findEntry, describeService, imageRepo, fill, USER_FILE_EXAMPLE };
