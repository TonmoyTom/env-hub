'use strict';

// Service definitions shared by every stack.
// Databases use a fixed name and user, and one per-machine password, so the same credentials
// work for the app and for the admin tools.
const DB_NAME = 'app';
const DB_USER = 'app';

// Name the user can give the database in Edit services. The container always starts with `app`
// (changing its env would recreate the container), and envhub creates the chosen name next to it.
const DB_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

// Empty means "keep the default". Anything else must be a plain name, because it goes into SQL.
function normalizeDbName(value) {
  if (value === undefined || value === null) return undefined;
  const name = String(value).trim();
  if (name === '') return undefined;
  if (!DB_NAME_RE.test(name)) {
    throw new Error('Database name: use lowercase letters, digits and _, start with a letter (max 41)');
  }
  return name;
}

// The name the app should use for its database.
function dbNameOf(spec) {
  return (spec && spec.dbName) || DB_NAME;
}

// The user name the app connects with. `app` is the admin account the container starts with,
// and it is kept as it is (changing it would need a new container). The app user is created next to it.
const RESERVED_USERS = ['root', 'postgres', 'admin', 'mysql', 'mongodb', 'envhub'];

function normalizeDbUser(value) {
  if (value === undefined || value === null) return undefined;
  const user = String(value).trim();
  if (user === '') return undefined;
  if (!DB_NAME_RE.test(user)) {
    throw new Error('Database user: use lowercase letters, digits and _, start with a letter (max 41)');
  }
  if (RESERVED_USERS.includes(user)) throw new Error(`Database user: "${user}" is reserved, pick another name`);
  return user;
}

function dbUserOf(spec) {
  return (spec && spec.dbUser) || DB_USER;
}

// Passwords the user can set in Edit services. Letters, digits, _ . and - only, so they are safe
// in URLs, SQL and the .env lines. undefined = keep, '' = clear (go back to the default).
const PASSWORD_RE = /^[A-Za-z0-9_.-]{4,64}$/;

function normalizePassword(value, label) {
  if (value === undefined || value === null) return undefined;
  const password = String(value).trim();
  if (password === '') return '';
  if (!PASSWORD_RE.test(password)) {
    throw new Error(`${label}: 4 to 64 letters, digits, _ . or - (no spaces or other symbols)`);
  }
  return password;
}

// The password the app user (and the app's own .env) uses for MySQL and PostgreSQL.
// Changing it runs ALTER USER on the running database, so the data stays.
function appPasswordOf(spec, rootPassword) {
  return (spec && spec.dbPassword) || rootPassword;
}

const { serviceVersion } = require('../registry/versions');

function mysql(password, version) {
  return {
    name: 'mysql',
    image: `mysql:${serviceVersion({ mysql: version }, 'mysql')}`,
    ports: [{ host: 3306, container: 3306 }],
    env: {
      MYSQL_DATABASE: DB_NAME,
      MYSQL_USER: DB_USER,
      MYSQL_PASSWORD: password,
      MYSQL_ROOT_PASSWORD: password,
    },
    dataVolumes: [{ name: 'data', target: '/var/lib/mysql' }],
  };
}

function postgres(password, version) {
  return {
    name: 'postgres',
    image: `postgres:${serviceVersion({ postgres: version }, 'postgres')}`,
    ports: [{ host: 5432, container: 5432 }],
    env: {
      POSTGRES_DB: DB_NAME,
      POSTGRES_USER: DB_USER,
      POSTGRES_PASSWORD: password,
    },
    // PostgreSQL 18 and newer keep their data one folder higher, in a folder named after the version.
    dataVolumes: [{ name: 'data', target: Number.parseInt(serviceVersion({ postgres: version }, 'postgres'), 10) >= 18 ? '/var/lib/postgresql' : '/var/lib/postgresql/data' }],
  };
}

function mongodb(password, version) {
  return {
    name: 'mongodb',
    image: `mongo:${serviceVersion({ mongodb: version }, 'mongodb')}`,
    ports: [{ host: 27017, container: 27017 }],
    env: {
      MONGO_INITDB_ROOT_USERNAME: 'root',
      MONGO_INITDB_ROOT_PASSWORD: password,
    },
    dataVolumes: [{ name: 'data', target: '/data/db' }],
  };
}

function redis(version) {
  return {
    name: 'redis',
    image: `redis:${serviceVersion({ redis: version }, 'redis')}`,
    ports: [{ host: 6379, container: 6379 }],
    dataVolumes: [{ name: 'data', target: '/data' }],
  };
}

function mailpit() {
  return {
    name: 'mailpit',
    image: 'axllent/mailpit',
    ports: [
      { host: 8025, container: 8025 },
      { host: 1025, container: 1025 },
    ],
  };
}

// Signs in as root automatically. The page is only reachable from this computer.
function phpmyadmin(password) {
  return {
    name: 'phpmyadmin',
    image: 'phpmyadmin:5',
    ports: [{ host: 8081, container: 80 }],
    env: { PMA_HOST: 'mysql', PMA_USER: 'root', PMA_PASSWORD: password },
  };
}

// Works with MySQL and PostgreSQL. `defaultServer` is the service name filled in on the login page.
function adminer(defaultServer) {
  return {
    name: 'adminer',
    image: 'adminer:4',
    ports: [{ host: 8082, container: 8080 }],
    env: { ADMINER_DEFAULT_SERVER: defaultServer },
  };
}

// External mail server (Mailtrap, or any SMTP). It replaces Mailpit in the .env when set.
// undefined = keep, '' or an empty host = clear (back to Mailpit).
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const FREE_TEXT_RE = /^[^\r\n]{0,200}$/;

function normalizeMail(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Mail settings are invalid');
  }
  const host = String(value.host || '').trim();
  if (host === '') return '';
  if (!HOST_RE.test(host)) throw new Error('Mail host: letters, digits, dots and dashes only (e.g. sandbox.smtp.mailtrap.io)');

  const port = Number(String(value.port || '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Mail port: a number from 1 to 65535');

  const username = String(value.username || '').trim();
  const password = String(value.password || '').trim();
  if (!FREE_TEXT_RE.test(username) || !FREE_TEXT_RE.test(password)) {
    throw new Error('Mail username and password must be on one line');
  }
  return { host, port, username, password };
}

module.exports = {
  DB_NAME,
  DB_USER,
  normalizeDbName,
  dbNameOf,
  normalizeDbUser,
  dbUserOf,
  normalizePassword,
  appPasswordOf,
  normalizeMail,
  mysql,
  postgres,
  mongodb,
  redis,
  mailpit,
  phpmyadmin,
  adminer,
};
