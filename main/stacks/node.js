'use strict';

const { NAME_RE } = require('../compose/generate');
const svc = require('./services');
const registry = require('../registry/versions');
const { hostUser } = require('../docker/hostuser');

// One entry per Node based stack. To add another (Svelte, Astro...), add a line here,
// then add it to NAMES in stacks/index.js and to the renderer lists (see HANDOVER.md).
// `port` is the port the dev server listens on inside the container.
const VITE_DEV = 'npm install && npm run dev -- --host 0.0.0.0';
const NODE_STACK_DEFS = {
  nestjs: { label: 'NestJS', port: 3000, command: 'npm install && npm run start:dev' },
  nextjs: { label: 'Next.js', port: 3000, command: 'npm install && npm run dev -- -H 0.0.0.0' },
  vue: { label: 'Vue.js', port: 5173, command: VITE_DEV },
  nuxt: { label: 'Nuxt.js', port: 3000, command: VITE_DEV },
};
const NODE_STACKS = Object.keys(NODE_STACK_DEFS);
const OPTION_KEYS = ['mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit'];

// Returns every option as a boolean. Nothing is on unless asked for, so a project is Node only.
function normalizeNodeOptions(options) {
  if (options === undefined || options === null) {
    return Object.fromEntries(OPTION_KEYS.map((key) => [key, false]));
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid options');
  }

  const result = {};
  for (const key of OPTION_KEYS) {
    result[key] = options[key] === true;
  }
  if (result.phpmyadmin && !result.mysql) {
    throw new Error('phpMyAdmin needs MySQL');
  }
  if (result.adminer && !result.mysql && !result.postgres) {
    throw new Error('Adminer needs MySQL or PostgreSQL');
  }
  return result;
}

// The database and tool services for the ticked options. Shared by every stack that offers them.
function optionServices(opts, password, versions) {
  const services = [];
  if (opts.mysql) services.push(svc.mysql(password, versions && versions.mysql));
  if (opts.postgres) services.push(svc.postgres(password, versions && versions.postgres));
  if (opts.mongodb) services.push(svc.mongodb(password, versions && versions.mongodb));
  if (opts.redis) services.push(svc.redis(versions && versions.redis));
  if (opts.phpmyadmin) services.push(svc.phpmyadmin(password));
  if (opts.adminer) services.push(svc.adminer(opts.mysql ? 'mysql' : 'postgres'));
  if (opts.mailpit) services.push(svc.mailpit());
  return services;
}

function nodeProject({ name, stack, nodeVersion, folder, dbPassword, options, versions }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
  if (!NODE_STACKS.includes(stack)) {
    throw new Error('Unsupported stack');
  }
  if (!registry.has('node', nodeVersion)) {
    throw new Error('Unsupported Node version');
  }

  const def = NODE_STACK_DEFS[stack];
  const opts = normalizeNodeOptions(options);
  const password = String(dbPassword || '');

  const user = hostUser();
  const services = [
    {
      name: 'node',
      ...(user ? { user } : {}),
      image: `node:${nodeVersion}-alpine`,
      ports: [{ host: def.port, container: def.port }],
      // Polling is needed for file changes to show up when the folder is shared from Windows.
      env: { CHOKIDAR_USEPOLLING: 'true', WATCHPACK_POLLING: 'true' },
      workingDir: '/app',
      command: ['sh', '-c', def.command],
      volumes: [{ source: folder, target: '/app' }],
      // node_modules lives in a Docker volume: much faster than the shared folder on Windows and Mac.
      dataVolumes: [{ name: 'node-modules', target: '/app/node_modules' }],
    },
  ];

  services.push(...optionServices(opts, password, versions));

  return { name, stack, nodeVersion, services };
}

module.exports = {
  nodeProject,
  normalizeNodeOptions,
  optionServices,
  NODE_STACKS,
  NODE_STACK_DEFS,
};
