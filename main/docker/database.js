'use strict';

const { runDocker } = require('./exec');
const { DB_NAME, DB_USER } = require('../stacks/services');

// After the containers start, envhub does two small things inside the database containers:
//   1. creates the database the user named (if it is not the default `app`),
//   2. creates the app user (if it is new) and sets its password to the current one.
// Both are done with SQL on the running server, so nothing is recreated and the data stays.
// The admin account (`app` in the container, the MySQL root) is never renamed here.
// Names and passwords are checked before they get here (see services.js), and every command
// is a plain argument list, so no host or container shell reads the user's text.

const ATTEMPTS = 40;
const DELAY_MS = 3000;

// The account the container starts with. It is the admin, and it keeps its name.
const ADMIN_USER = DB_USER;

// MySQL string literal. Passwords are already limited to safe characters, this is a second guard.
function sqlString(value) {
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// PostgreSQL string literal.
function pgString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// JavaScript string content (used inside the mongosh --eval script).
function jsString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// Creates the database. Returns null for services that have no database to create.
function createDatabaseCommand(service, container, dbName) {
  if (!dbName || dbName === DB_NAME) return null;

  if (service === 'mysql') {
    // The mysql image sets MYSQL_ROOT_PASSWORD in the container, so no password is passed on the command line.
    // The backtick is escaped for the shell that runs inside the container.
    const bt = '\\`';
    const sql = `CREATE DATABASE IF NOT EXISTS ${bt}${dbName}${bt}; `
      + `GRANT ALL PRIVILEGES ON ${bt}${dbName}${bt}.* TO '${ADMIN_USER}'@'%'; FLUSH PRIVILEGES;`;
    return {
      container,
      args: ['exec', container, 'sh', '-c', `mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "${sql}"`],
      alreadyExists: null,
    };
  }

  if (service === 'postgres') {
    return {
      container,
      args: ['exec', container, 'createdb', '-U', ADMIN_USER, dbName],
      alreadyExists: /already exists/i,
    };
  }

  return null;
}

// Creates the app user if it is new, sets its password, and gives it the database.
// `rootPassword` is the password the container was started with (the admin / root one), which does not change.
// `dbUser` and `dbName` are checked names, so they are safe to put into SQL.
function alterUserCommand(service, container, password, rootPassword, dbUser = ADMIN_USER, dbName = DB_NAME) {
  if (!password) return null;

  if (service === 'mysql') {
    const sql = `CREATE USER IF NOT EXISTS '${dbUser}'@'%' IDENTIFIED BY ${sqlString(password)}; `
      + `ALTER USER '${dbUser}'@'%' IDENTIFIED BY ${sqlString(password)}; `
      + `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'%'; FLUSH PRIVILEGES;`;
    return {
      container,
      args: ['exec', '-e', `MYSQL_PWD=${rootPassword || ''}`, container, 'mysql', '-uroot', '-e', sql],
      alreadyExists: null,
    };
  }

  if (service === 'postgres') {
    // The postgres image trusts local connections inside the container, so no password is needed to connect.
    const sql = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') `
      + `THEN CREATE ROLE "${dbUser}" LOGIN; END IF; END $$; `
      + `ALTER ROLE "${dbUser}" WITH LOGIN PASSWORD ${pgString(password)}; `
      + `ALTER DATABASE "${dbName}" OWNER TO "${dbUser}";`;
    return {
      container,
      args: ['exec', container, 'psql', '-U', ADMIN_USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
      alreadyExists: null,
    };
  }

  if (service === 'mongodb') {
    // Authenticates as root with the root password (it never changes), then creates the app user
    // with the current password, or updates its password if it already exists. The root user is untouched.
    const pw = jsString(password);
    const name = jsString(dbUser);
    const js = `var a = db.getSiblingDB('admin'); `
      + `if (a.getUser('${name}')) { a.changeUserPassword('${name}', '${pw}'); } `
      + `else { a.createUser({ user: '${name}', pwd: '${pw}', roles: [{ role: 'root', db: 'admin' }] }); }`;
    return {
      container,
      args: ['exec', container, 'mongosh', '--quiet', '-u', 'root', '-p', rootPassword || '', '--authenticationDatabase', 'admin', '--eval', js],
      alreadyExists: null,
    };
  }

  return null;
}

// Every step for the database services of a project, in order.
// `dbName`, `dbUser` and `appPassword` are optional: a step is only made when there is something to do.
function databaseSteps(services, projectName, { dbName, dbUser, appPassword, rootPassword } = {}) {
  const steps = [];
  for (const svc of services) {
    const container = `envhub-${projectName}-${svc.name}`;
    const create = createDatabaseCommand(svc.name, container, dbName);
    if (create) steps.push({ service: svc.name, label: `database ${dbName}`, ...create });
    const alter = alterUserCommand(svc.name, container, appPassword, rootPassword, dbUser || ADMIN_USER, dbName || DB_NAME);
    if (alter) steps.push({ service: svc.name, label: `the app user ${dbUser || ADMIN_USER}`, ...alter });
  }
  return steps;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs one command until the server accepts it. A fresh server can take a while to start.
async function runUntilReady(cmd, log, delay) {
  let last = '';
  for (let i = 1; i <= ATTEMPTS; i += 1) {
    const res = await runDocker(cmd.args);
    if (res.ok) return { ok: true };

    last = `${res.stderr || res.stdout || ''}`.trim();
    if (cmd.alreadyExists && cmd.alreadyExists.test(last)) return { ok: true };

    log(`Waiting for ${cmd.service} to accept connections (${i} of ${ATTEMPTS})`);
    await wait(delay);
  }
  return { ok: false, error: last.split('\n').pop() || 'no answer' };
}

// Runs every step. Returns { ok, errors }. A failure does not stop the start: the containers keep running.
async function ensureDatabases({
  services, projectName, dbName, dbUser, appPassword, rootPassword, log = () => {}, delay = DELAY_MS,
}) {
  const steps = databaseSteps(services, projectName, { dbName, dbUser, appPassword, rootPassword });
  const errors = [];

  for (const step of steps) {
    log(`Setting up ${step.label} in ${step.service}`);
    const res = await runUntilReady(step, log, delay);
    if (res.ok) {
      log(`${step.label} is ready in ${step.service}`);
    } else {
      const message = `Could not set up ${step.label} in ${step.service}: ${res.error}`;
      log(message);
      errors.push(message);
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  sqlString,
  pgString,
  jsString,
  createDatabaseCommand,
  alterUserCommand,
  databaseSteps,
  ensureDatabases,
};
