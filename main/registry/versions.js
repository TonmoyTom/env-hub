'use strict';

const fs = require('fs');
const path = require('path');

// The versions ProjectDockHub offers for PHP, Node and the database services. Three sources are merged:
//  1. Built in list: config/versions.json (it also decides the defaults).
//  2. Docker Hub, fetched in the background and kept in <app data>/versions-cache.json (refreshed once a day).
//     It only adds versions that are not older than the oldest built in one, and never changes a default.
//  3. The user's <app data>/versions.json (same shape, only the versions to add), no code change needed.
// If the file is missing or broken, the same lists built into this code are used, so the app still starts.
const FALLBACK = {
  php: { default: '8.3', versions: ['8.3', '8.2', '8.1'] },
  node: { default: '22', versions: ['22', '20'] },
  mysql: { default: '8.0', versions: ['8.4', '8.0'] },
  postgres: { default: '16', versions: ['17', '16', '15'] },
  mongodb: { default: '7', versions: ['8', '7', '6'] },
  redis: { default: '7', versions: ['7', '6'] },
};

function loadBuiltin() {
  // main/config/versions.json is where the file sits in this repo; the second place is the old one.
  for (const place of ['../config/versions.json', '../../config/versions.json']) {
    try {
      const data = require(place);
      const ok = ['php', 'node', 'mysql', 'postgres', 'mongodb', 'redis']
        .every((key) => data[key] && Array.isArray(data[key].versions) && data[key].versions.includes(data[key].default));
      if (ok) return data;
    } catch (err) {
      // not here, try the next place
    }
  }
  return FALLBACK;
}

const BUILTIN = loadBuiltin();

const KEYS = ['php', 'node', 'mysql', 'postgres', 'mongodb', 'redis'];
const SERVICE_KEYS = ['mysql', 'postgres', 'mongodb', 'redis'];

// A version goes into an image tag and a Dockerfile, so only digits and dots are allowed: 8, 8.4, 8.4.1
const VERSION_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$/;

// Versions a project had before they could be chosen. A project without a saved version keeps these,
// so changing the default list never changes a database that already holds data.
const LEGACY = { mysql: '8.0', postgres: '16', mongodb: '7', redis: '7' };

const parts = (v) => v.split('.').map(Number);

// Newest first, so the dropdown shows the latest version at the top.
function newestFirst(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (y[i] || 0) - (x[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Merges the built in registry, the Docker Hub lists (`remote`, optional) and the user's file.
// Returns { registry, warnings }. A wrong entry is skipped and reported, it never stops the app.
// Docker Hub versions that are invalid or older than the oldest built in version are dropped without a warning.
function mergeRegistry(builtin, user, remote) {
  const warnings = [];
  const registry = {};

  for (const key of KEYS) {
    const base = builtin[key];
    const list = new Set(base.versions);
    let def = base.default;

    const floor = [...base.versions].sort(newestFirst).pop();
    const fromHub = remote && Array.isArray(remote[key]) ? remote[key] : [];
    for (const v of fromHub) {
      if (typeof v === 'string' && VERSION_RE.test(v) && newestFirst(v, floor) <= 0) list.add(v);
    }
    const extra = user && typeof user === 'object' ? user[key] : undefined;

    if (extra !== undefined) {
      const versions = extra && Array.isArray(extra.versions) ? extra.versions : null;
      if (!versions) {
        warnings.push(`versions.json: "${key}" needs a "versions" list`);
      } else {
        for (const v of versions) {
          if (typeof v === 'string' && VERSION_RE.test(v)) list.add(v);
          else warnings.push(`versions.json: "${v}" is not a valid ${key} version (use digits and dots, like 8.4)`);
        }
      }
      if (extra && extra.default !== undefined) {
        if (typeof extra.default === 'string' && list.has(extra.default)) def = extra.default;
        else warnings.push(`versions.json: default "${extra.default}" for ${key} is not in the list`);
      }
    }
    registry[key] = { default: def, versions: [...list].sort(newestFirst) };
  }
  return { registry, warnings };
}

let userInput = null;
let userWarnings = [];
let remoteLists = null;
let state = mergeRegistry(BUILTIN, null, null);

function rebuild() {
  const merged = mergeRegistry(BUILTIN, userInput, remoteLists);
  state = { registry: merged.registry, warnings: [...userWarnings, ...merged.warnings] };
  return state;
}

// Reads the user's file. A missing file is normal. Broken JSON is reported and ignored.
function load(file) {
  userInput = null;
  userWarnings = [];
  try {
    userInput = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') userWarnings.push(`versions.json could not be read: ${err.message}`);
  }
  return rebuild();
}

// The lists that came from Docker Hub (or from the cache). Anything that is not a list of valid versions is ignored.
// Pass null to forget them.
function setRemote(lists) {
  if (!lists || typeof lists !== 'object') {
    remoteLists = null;
  } else {
    remoteLists = {};
    for (const key of KEYS) {
      if (Array.isArray(lists[key])) remoteLists[key] = lists[key].filter((v) => typeof v === 'string' && VERSION_RE.test(v));
    }
  }
  return rebuild();
}

// ----- Docker Hub cache: <app data>/versions-cache.json = { fetchedAt, lists } -----
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data.fetchedAt !== 'number' || !data.lists || typeof data.lists !== 'object') return null;
    return data;
  } catch (err) {
    return null;
  }
}

function writeCache(file, lists, now = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, lists }, null, 2));
}

function cacheIsFresh(cache, now = Date.now()) {
  return Boolean(cache) && now - cache.fetchedAt >= 0 && now - cache.fetchedAt < CACHE_TTL_MS;
}

// Uses the cache at once (so the app works offline and starts fast), then asks Docker Hub when the cache is
// older than a day. `fetchLists` is hub.fetchVersionLists, passed in so this file does not need the network code.
// Never throws: if Docker Hub cannot be reached the built in and cached versions stay. A list that failed keeps
// its cached versions. Returns { source: 'cache' | 'hub', errors }.
async function refresh(cacheFile, fetchLists, force = false) {
  const cache = readCache(cacheFile);
  if (cache) setRemote(cache.lists);
  if (!force && cacheIsFresh(cache)) return { source: 'cache', errors: [] };

  try {
    const { lists, errors } = await fetchLists();
    if (Object.keys(lists).length === 0) return { source: 'cache', errors };
    const merged = { ...(cache ? cache.lists : {}), ...lists };
    writeCache(cacheFile, merged);
    setRemote(merged);
    return { source: 'hub', errors };
  } catch (err) {
    return { source: 'cache', errors: [err.message] };
  }
}

const list = (key) => state.registry[key].versions;
const defaultOf = (key) => state.registry[key].default;
const has = (key, version) => Boolean(state.registry[key]) && state.registry[key].versions.includes(version);
const snapshot = () => ({ ...state.registry, warnings: state.warnings });

// What the user chose for the database services. Missing = keep what the project has.
// Returns an object with only valid keys, or undefined when there is nothing.
function normalizeVersions(input, current) {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new Error('Invalid versions');
  }
  const result = { ...(current || {}) };
  for (const key of SERVICE_KEYS) {
    const value = input ? input[key] : undefined;
    if (value === undefined || value === '') continue;
    if (!has(key, String(value))) throw new Error(`Unsupported ${key} version: ${value}`);
    result[key] = String(value);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// The version a project uses for one service.
function serviceVersion(versions, key) {
  const v = versions && versions[key];
  return typeof v === 'string' && VERSION_RE.test(v) ? v : LEGACY[key];
}

module.exports = {
  KEYS, SERVICE_KEYS, LEGACY, VERSION_RE,
  mergeRegistry, load, setRemote, refresh, readCache, writeCache, cacheIsFresh, CACHE_TTL_MS,
  list, defaultOf, has, snapshot, normalizeVersions, serviceVersion,
};
