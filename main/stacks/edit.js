'use strict';

const { CREATABLE_STACKS, stackLabel } = require('./index');
const { packageRule } = require('./docker');
const { normalizeOptions } = require('./laravel');
const { normalizeNodeOptions } = require('./node');
const { normalizeExtraServices, MAX_EXTRAS } = require('./extras');
const registry = require('../registry/versions');
const { normalizeDbName, dbNameOf, normalizeDbUser, dbUserOf, normalizePassword, normalizeMail } = require('./services');

// Editing the services of a project that already exists.
// Everything here is pure: it takes a saved spec and returns a new one, nothing is written.

function isEditable(spec) {
  return Boolean(spec) && CREATABLE_STACKS.includes(spec.stack);
}

function assertEditable(spec) {
  if (!isEditable(spec)) {
    throw new Error('This project cannot be edited');
  }
}

// Laravel has its own list of options, every other stack uses the Node list.
function normalizerFor(spec) {
  return spec.stack === 'laravel' ? normalizeOptions : normalizeNodeOptions;
}

// The options as they are now. A project saved without options gets the defaults of its stack.
function currentOptions(spec) {
  return normalizerFor(spec)(spec.options);
}

function envText(env) {
  return Object.entries(env || {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

// What the Edit services form shows: the tick boxes that fit the stack, and the extra services as text.
function describeForEdit(spec) {
  assertEditable(spec);
  const options = currentOptions(spec);
  return {
    name: spec.name,
    stack: spec.stack,
    label: stackLabel(spec),
    optionKeys: Object.keys(options),
    options,
    dbName: dbNameOf(spec),
    dbUser: dbUserOf(spec),
    dbPassword: spec.dbPassword || '',
    redisPassword: spec.redisPassword || '',
    lanShare: spec.lanShare === true,
    packagesLabel: spec.stack === 'docker' && packageRule(spec.image) ? packageRule(spec.image).label : '',
    keepPackages: spec.keepPackages === true,
    versions: Object.fromEntries(registry.SERVICE_KEYS.map((key) => [key, registry.serviceVersion(spec.versions, key)])),
    mail: spec.mail || { host: '', port: '', username: '', password: '' },
    extras: (spec.extraServices || []).map((extra) => ({
      name: extra.name,
      image: extra.image,
      ports: (extra.ports || []).join(','),
      env: envText(extra.env),
      command: (extra.command || []).join(' '),
    })),
    maxExtras: MAX_EXTRAS,
  };
}

// Returns a copy of the spec with the new options and extra services. Throws on anything wrong.
// Whatever the form leaves out stays as it is.
function applyServiceEdit(spec, input) {
  assertEditable(spec);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid input');
  }

  const options = normalizerFor(spec)(input.options === undefined ? currentOptions(spec) : input.options);
  const extraServices = normalizeExtraServices(
    input.extraServices === undefined ? spec.extraServices : input.extraServices,
    spec.extraServices || [],
  );

  // A missing dbName keeps the saved one. An empty value goes back to the default `app`.
  const dbName = input.dbName === undefined ? spec.dbName : normalizeDbName(input.dbName);
  const dbUser = input.dbUser === undefined ? spec.dbUser : normalizeDbUser(input.dbUser);

  // Passwords: a missing field keeps the saved one, an empty field clears it (default password, no Redis password).
  const dbPassword = input.dbPassword === undefined
    ? spec.dbPassword
    : normalizePassword(input.dbPassword, 'Database password') || undefined;
  const redisPassword = input.redisPassword === undefined
    ? spec.redisPassword
    : normalizePassword(input.redisPassword, 'Redis password') || undefined;

  // Share the web page with other computers on the same network. Missing = keep.
  const lanShare = input.lanShare === undefined ? spec.lanShare : input.lanShare === true;
  const keepPackages = input.keepPackages === undefined ? spec.keepPackages : input.keepPackages === true;

  // Versions of the database services. A missing field keeps the saved ones.
  const versions = registry.normalizeVersions(input.versions, spec.versions);

  // Mail: a missing field keeps the saved one. An empty host clears it (Mailpit is used again).
  const mail = input.mail === undefined ? spec.mail : normalizeMail(input.mail) || undefined;

  return {
    ...spec,
    options,
    extraServices: extraServices.length > 0 ? extraServices : undefined,
    dbName,
    dbUser,
    dbPassword,
    redisPassword,
    lanShare: lanShare === true ? true : undefined,
    keepPackages: keepPackages === true && spec.stack === 'docker' && packageRule(spec.image) ? true : undefined,
    versions,
    mail,
  };
}

// Compares two built configs by service name: which were added, removed or changed.
function diffServices(before, after) {
  const was = new Map(before.services.map((s) => [s.name, JSON.stringify(s)]));
  const now = new Map(after.services.map((s) => [s.name, JSON.stringify(s)]));

  return {
    added: [...now.keys()].filter((name) => !was.has(name)),
    removed: [...was.keys()].filter((name) => !now.has(name)),
    changed: [...now.keys()].filter((name) => was.has(name) && was.get(name) !== now.get(name)),
  };
}

module.exports = { isEditable, describeForEdit, applyServiceEdit, diffServices };
