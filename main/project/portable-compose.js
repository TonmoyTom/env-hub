'use strict';

// Writes the portable files that live inside a project folder: Dockerfile (when the stack needs one),
// docker-compose.yml and .env. Every path is relative to the folder, so the whole folder can be copied
// to another server and started with `docker compose up -d --build`.

const registry = require('../registry/versions');
const { normalizeOptions, VITE_COMMAND } = require('../stacks/laravel');
const { normalizeNodeOptions, NODE_STACK_DEFS } = require('../stacks/node');
const { hostPortFor, AUTO_PORT } = require('../stacks/docker');
const { extraServicesOf } = require('../stacks/extras');
const { languageOf, languageCommand } = require('../stacks/languages');

const RESTART = 'unless-stopped';
const WEB_BIND = '${APP_BIND:-127.0.0.1}';

// Writes a YAML value. JSON strings are valid YAML double-quoted scalars, so quoting is safe.
function scalar(value) {
  return JSON.stringify(value);
}

// Turns a plain object (maps, arrays of scalars, scalars) into YAML lines. Only the shapes used here.
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  if (Array.isArray(value)) {
    for (const item of value) lines.push(`${pad}- ${scalar(item)}`);
    return lines;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (child !== null && typeof child === 'object') {
      if (Array.isArray(child) && child.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else if (!Array.isArray(child) && Object.keys(child).length === 0) {
        lines.push(`${pad}${key}: {}`);
      } else {
        lines.push(`${pad}${key}:`);
        lines.push(...toYaml(child, indent + 2));
      }
    } else {
      lines.push(`${pad}${key}: ${scalar(child)}`);
    }
  }
  return lines;
}

// Database, cache and tool services for the ticked options. Shared by every stack.
// Passwords are read from .env, so the compose file itself holds no secret.
function serviceBlocks(opts, v) {
  const services = {};
  const volumes = {};

  if (opts.mysql) {
    services.mysql = {
      image: `mysql:${registry.serviceVersion({ mysql: v.mysql }, 'mysql')}`,
      restart: RESTART,
      environment: {
        MYSQL_ROOT_PASSWORD: '${DB_ROOT_PASSWORD:?Set DB_ROOT_PASSWORD in .env}',
        MYSQL_DATABASE: '${DB_DATABASE:-app}',
        MYSQL_USER: '${DB_USERNAME:-app}',
        MYSQL_PASSWORD: '${DB_PASSWORD:?Set DB_PASSWORD in .env}',
      },
      // Only this computer can reach the database from outside Docker.
      ports: ['127.0.0.1:${DB_PORT:-3306}:3306'],
      volumes: ['mysql-data:/var/lib/mysql'],
      healthcheck: {
        test: ['CMD-SHELL', 'mysqladmin ping -h 127.0.0.1 -u root -p"$$MYSQL_ROOT_PASSWORD" --silent'],
        interval: '5s',
        timeout: '3s',
        retries: 30,
      },
    };
    volumes['mysql-data'] = {};
  }

  if (opts.postgres) {
    services.postgres = {
      image: `postgres:${registry.serviceVersion({ postgres: v.postgres }, 'postgres')}`,
      restart: RESTART,
      environment: {
        POSTGRES_DB: '${DB_DATABASE:-app}',
        POSTGRES_USER: '${DB_USERNAME:-app}',
        POSTGRES_PASSWORD: '${DB_PASSWORD:?Set DB_PASSWORD in .env}',
      },
      ports: ['127.0.0.1:${DB_PORT:-5432}:5432'],
      volumes: ['postgres-data:/var/lib/postgresql/data'],
    };
    volumes['postgres-data'] = {};
  }

  if (opts.mongodb) {
    services.mongodb = {
      image: `mongo:${registry.serviceVersion({ mongodb: v.mongodb }, 'mongodb')}`,
      restart: RESTART,
      environment: {
        MONGO_INITDB_ROOT_USERNAME: 'root',
        MONGO_INITDB_ROOT_PASSWORD: '${DB_ROOT_PASSWORD:?Set DB_ROOT_PASSWORD in .env}',
      },
      ports: ['127.0.0.1:${DB_PORT:-27017}:27017'],
      volumes: ['mongo-data:/data/db'],
    };
    volumes['mongo-data'] = {};
  }

  if (opts.redis) {
    services.redis = {
      image: `redis:${registry.serviceVersion({ redis: v.redis }, 'redis')}`,
      restart: RESTART,
      volumes: ['redis-data:/data'],
    };
    volumes['redis-data'] = {};
  }

  if (opts.phpmyadmin) {
    services.phpmyadmin = {
      image: 'phpmyadmin:5',
      restart: RESTART,
      environment: { PMA_HOST: 'mysql', PMA_USER: 'root', PMA_PASSWORD: '${DB_ROOT_PASSWORD}' },
      ports: ['127.0.0.1:${PMA_PORT:-8081}:80'],
      depends_on: ['mysql'],
    };
  }

  if (opts.adminer) {
    const db = opts.mysql ? 'mysql' : 'postgres';
    services.adminer = {
      image: 'adminer:4',
      restart: RESTART,
      ports: ['127.0.0.1:${ADMINER_PORT:-8082}:8080'],
      depends_on: [db],
    };
  }

  if (opts.mailpit) {
    services.mailpit = {
      image: 'axllent/mailpit',
      restart: RESTART,
      ports: ['127.0.0.1:${MAIL_WEB_PORT:-8025}:8025', '127.0.0.1:${MAIL_SMTP_PORT:-1025}:1025'],
    };
  }

  return { services, volumes };
}

// The services the user added by hand ("+ Add more services"). Ports stay on this computer.
function extraBlocks(spec) {
  const services = {};
  for (const extra of extraServicesOf(spec)) {
    const service = { image: extra.image, restart: RESTART };
    if (extra.ports) service.ports = extra.ports.map((p) => `127.0.0.1:${p.host}:${p.container}`);
    if (extra.env) service.environment = extra.env;
    if (extra.command) service.command = extra.command;
    services[extra.name] = service;
  }
  return services;
}

// Names of the database and cache services that the app container should wait for.
function dependencyNames(opts) {
  return ['mysql', 'postgres', 'mongodb', 'redis'].filter((key) => opts[key]);
}

function laravelCompose(spec) {
  const { name, options, versions } = spec;
  const opts = normalizeOptions(options);
  const v = versions || {};
  const blocks = serviceBlocks(opts, v);
  const services = {};

  services.nginx = {
    image: 'nginx:stable',
    restart: RESTART,
    // APP_BIND=127.0.0.1 (default) keeps the site on this computer. Set APP_BIND=0.0.0.0 on a server.
    ports: [`${WEB_BIND}:\${APP_PORT:-8080}:80`],
    volumes: ['./:/var/www/html', './docker/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro'],
    depends_on: ['php'],
  };

  const phpDeps = {};
  if (opts.mysql) phpDeps.mysql = { condition: 'service_healthy' };
  if (opts.redis) phpDeps.redis = { condition: 'service_started' };
  services.php = {
    build: { context: './docker/php', dockerfile: 'Dockerfile' },
    image: `${name}-php`,
    restart: RESTART,
    working_dir: '/var/www/html',
    volumes: ['./:/var/www/html'],
    ...(Object.keys(phpDeps).length > 0 ? { depends_on: phpDeps } : {}),
  };

  Object.assign(services, blocks.services);

  if (opts.node) {
    services.node = {
      image: 'node:22-alpine',
      restart: RESTART,
      working_dir: '/var/www/html',
      // Polling is needed for file changes to show up when the folder is shared from Windows.
      environment: { CHOKIDAR_USEPOLLING: 'true' },
      command: ['sh', '-c', VITE_COMMAND],
      ports: ['127.0.0.1:${VITE_PORT:-5173}:5173'],
      volumes: ['./:/var/www/html'],
    };
  }

  Object.assign(services, extraBlocks(spec));
  return { name, services, volumes: blocks.volumes };
}

function nodeCompose(spec) {
  const { name, stack, options, versions } = spec;
  const def = NODE_STACK_DEFS[stack];
  const opts = normalizeNodeOptions(options);
  const blocks = serviceBlocks(opts, versions || {});
  const deps = dependencyNames(opts);

  const app = {
    build: { context: '.', dockerfile: 'Dockerfile' },
    image: `${name}-node`,
    restart: RESTART,
    working_dir: '/app',
    environment: { CHOKIDAR_USEPOLLING: 'true', WATCHPACK_POLLING: 'true' },
    command: ['sh', '-c', def.command],
    ports: [`${WEB_BIND}:\${APP_PORT:-${def.port}}:${def.port}`],
    // node_modules lives in a Docker volume: much faster than the shared folder on Windows and Mac.
    volumes: ['./:/app', 'node_modules:/app/node_modules'],
  };
  if (deps.length > 0) app.depends_on = deps;

  return { name, services: { app, ...blocks.services, ...extraBlocks(spec) }, volumes: { 'node_modules': {}, ...blocks.volumes } };
}

function dockerCompose(spec) {
  const { name, image, containerPort, options, versions } = spec;
  const command = spec.command || languageCommand(image);
  const opts = normalizeNodeOptions(options);
  const blocks = serviceBlocks(opts, versions || {});
  const deps = dependencyNames(opts);
  const hostPort = hostPortFor(containerPort);

  const app = {
    build: { context: '.', dockerfile: 'Dockerfile' },
    image: `${name}-app`,
    restart: RESTART,
    working_dir: '/app',
    environment: { PORT: String(containerPort) },
    ports: [`${WEB_BIND}:\${APP_PORT:-${hostPort}}:${containerPort}`],
    volumes: ['./:/app'],
    // Like `docker run -it`, so images whose default command is a shell do not exit at once.
    tty: true,
    stdin_open: true,
  };
  if (command) app.command = ['sh', '-c', command];
  if (deps.length > 0) app.depends_on = deps;

  return { name, services: { app, ...blocks.services, ...extraBlocks(spec) }, volumes: blocks.volumes };
}

// Builds the compose object for the stack. Laravel is the default, so older calls keep working.
function portableCompose(spec) {
  const stack = spec.stack || 'laravel';
  const base = { ...spec, stack };
  let compose;
  if (stack === 'laravel') compose = laravelCompose(base);
  else if (stack === 'docker') compose = dockerCompose(base);
  else compose = nodeCompose(base);

  const out = { name: compose.name, services: compose.services };
  if (Object.keys(compose.volumes).length > 0) out.volumes = compose.volumes;
  return out;
}

function portableComposeYaml(spec) {
  const header =
    '# Generated by ProjectDockHub. Every path is relative, so this folder can be copied to another server.\n' +
    '# Passwords and ports are in .env. Start with: docker compose up -d --build\n';
  return header + toYaml(portableCompose(spec)).join('\n') + '\n';
}

// Dockerfile for stacks that build their own image. Laravel's PHP Dockerfile is written by scaffold.js.
function portableDockerfile(spec) {
  const stack = spec.stack || 'laravel';
  if (stack === 'laravel') return null;
  if (stack === 'docker') {
    const port = Number(spec.containerPort) || AUTO_PORT;
    const lang = languageOf(spec.image);
    if (lang) return lang.dockerfile(spec.image.trim());
    return [
      `# Your image. Change FROM to any Docker Hub image you need.`,
      `FROM ${spec.image}`,
      'WORKDIR /app',
      `EXPOSE ${port}`,
      '',
    ].join('\n');
  }
  const def = NODE_STACK_DEFS[stack];
  return [
    `FROM node:${spec.nodeVersion}-alpine`,
    'WORKDIR /app',
    'ENV CHOKIDAR_USEPOLLING=true WATCHPACK_POLLING=true',
    `EXPOSE ${def.port}`,
    '',
  ].join('\n');
}

// .env for compose and for the app. Created only once; an existing file is never overwritten.
function portableEnvText({ name, stack, options, dbPassword, rootPassword, appPort }) {
  const kind = stack || 'laravel';
  const opts = kind === 'laravel' ? normalizeOptions(options) : normalizeNodeOptions(options);
  const port = appPort || (kind === 'laravel' ? 8080 : kind === 'docker' ? hostPortFor(AUTO_PORT) : NODE_STACK_DEFS[kind].port);
  const pw = String(dbPassword || '');
  const root = String(rootPassword || dbPassword || '');
  const lines = [`# ${name}: values for docker compose and for the app. Keep this file private.`, `APP_PORT=${port}`, 'APP_BIND=127.0.0.1'];

  if (opts.mysql) {
    lines.push('DB_CONNECTION=mysql', 'DB_HOST=mysql', 'DB_PORT=3306', 'DB_DATABASE=app', 'DB_USERNAME=app', `DB_PASSWORD=${pw}`, `DB_ROOT_PASSWORD=${root}`);
    lines.push(`MYSQL_URL=mysql://app:${pw}@mysql:3306/app`);
  }
  if (opts.postgres) {
    lines.push('DB_CONNECTION=pgsql', 'DB_HOST=postgres', 'DB_PORT=5432', 'DB_DATABASE=app', 'DB_USERNAME=app', `DB_PASSWORD=${pw}`);
    lines.push(`POSTGRES_URL=postgres://app:${pw}@postgres:5432/app`);
    if (!opts.mysql) lines.push(`DATABASE_URL=postgres://app:${pw}@postgres:5432/app`);
  }
  if (opts.mongodb) {
    lines.push(`MONGODB_URL=mongodb://root:${root}@mongodb:27017/app?authSource=admin`);
  }
  if (opts.redis) lines.push('REDIS_HOST=redis', 'REDIS_PORT=6379', 'REDIS_URL=redis://redis:6379');
  if (opts.mailpit) lines.push('MAIL_MAILER=smtp', 'MAIL_HOST=mailpit', 'MAIL_PORT=1025');
  return lines.join('\n') + '\n';
}

// Every file the portable setup writes, for one project spec.
function portableFiles(spec) {
  return {
    dockerfile: portableDockerfile(spec),
    compose: portableComposeYaml(spec),
    env: portableEnvText({ ...spec, appPort: spec.appPort }),
  };
}

module.exports = { portableCompose, portableComposeYaml, portableDockerfile, portableEnvText, portableFiles, toYaml };
