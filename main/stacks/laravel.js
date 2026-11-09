'use strict';

const path = require('path');
const { NAME_RE } = require('../compose/generate');
const svc = require('./services');

const registry = require('../registry/versions');

// Node for the Vite dev server of a Laravel project. Fixed, as it was before versions could be chosen.
const NODE_VERSION = '22';
const OPTION_KEYS = ['mysql', 'redis', 'phpmyadmin', 'node', 'mailpit'];

// Projects created before options existed had these services.
const LEGACY_OPTIONS = { mysql: true, redis: true, phpmyadmin: false, node: false, mailpit: true };

const VITE_COMMAND =
  "if [ -f package.json ]; then npm install && npm run dev -- --host 0.0.0.0; " +
  "else echo 'No package.json yet'; tail -f /dev/null; fi";

// Returns { mysql, redis, phpmyadmin, node, mailpit } as booleans. Throws on a bad combination.
function normalizeOptions(options) {
  if (options === undefined || options === null) {
    return { ...LEGACY_OPTIONS };
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
  return result;
}

// Builds the service list for a Laravel project.
// `folder` is the project folder on the user's machine. It is mounted into nginx, PHP and Node.
function laravelProject({ name, phpVersion, folder, dbPassword, options, versions, supportDir }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
  if (!registry.has('php', phpVersion)) {
    throw new Error('Unsupported PHP version');
  }

  const opts = normalizeOptions(options);
  const password = String(dbPassword || '');
  const webRoot = '/var/www/html';
  // An existing project keeps its own folder clean: its PHP Dockerfile and nginx file live in envhub's data folder.
  const support = supportDir || path.join(folder, 'docker');
  const nginxConf = path.join(support, 'nginx', 'default.conf');
  const phpContext = path.join(support, 'php');

  const services = [
    {
      name: 'nginx',
      image: 'nginx:stable',
      ports: [{ host: 8080, container: 80 }],
      volumes: [
        { source: folder, target: webRoot },
        { source: nginxConf, target: '/etc/nginx/conf.d/default.conf' },
      ],
    },
    {
      name: 'php',
      image: `envhub-${name}-php`,
      build: { context: phpContext, dockerfile: 'Dockerfile' },
      volumes: [{ source: folder, target: webRoot }],
    },
  ];

  if (opts.mysql) services.push(svc.mysql(password, versions && versions.mysql));
  if (opts.redis) services.push(svc.redis(versions && versions.redis));
  if (opts.phpmyadmin) services.push(svc.phpmyadmin(password));
  if (opts.mailpit) services.push(svc.mailpit());

  if (opts.node) {
    // Runs npm and the Vite dev server. Polling is needed for file changes to show up
    // when the folder is shared from Windows.
    services.push({
      name: 'node',
      image: `node:${NODE_VERSION}-alpine`,
      ports: [{ host: 5173, container: 5173 }],
      env: { CHOKIDAR_USEPOLLING: 'true' },
      workingDir: webRoot,
      command: ['sh', '-c', VITE_COMMAND],
      volumes: [{ source: folder, target: webRoot }],
    });
  }

  return { name, stack: 'laravel', phpVersion, services };
}

module.exports = { laravelProject, normalizeOptions, VITE_COMMAND };
