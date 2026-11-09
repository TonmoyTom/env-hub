'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePassword, appPasswordOf } = require('../main/stacks/services');
const { sqlString, pgString, alterUserCommand, databaseSteps } = require('../main/docker/database');
const { normalizeMail } = require('../main/stacks/services');
const { describeForEdit, applyServiceEdit } = require('../main/stacks/edit');
const { buildProject } = require('../main/stacks');
const { connectionText, envFileText } = require('../main/stacks/connection');

const SPEC = { name: 'shop', stack: 'nestjs', nodeVersion: '22', options: { mysql: true, redis: true } };

test('normalizePassword: undefined keeps, empty clears, plain values pass', () => {
  assert.equal(normalizePassword(undefined, 'DB'), undefined);
  assert.equal(normalizePassword('', 'DB'), '');
  assert.equal(normalizePassword('  secret-1_x.y  ', 'DB'), 'secret-1_x.y');
});

test('normalizePassword refuses short, long or symbol passwords', () => {
  for (const bad of ['abc', 'a'.repeat(65), 'has space', "it's", 'x@y', 'p#ss', 'a/b', 'a%b']) {
    assert.throws(() => normalizePassword(bad, 'DB'), /DB: 4 to 64/, bad);
  }
});

test('appPasswordOf uses the saved password, else the root one', () => {
  assert.equal(appPasswordOf({}, 'root1'), 'root1');
  assert.equal(appPasswordOf({ dbPassword: 'mine1' }, 'root1'), 'mine1');
});

test('SQL string literals escape quotes and backslashes', () => {
  assert.equal(sqlString("a'b"), "'a\\'b'");
  assert.equal(sqlString('a\\b'), "'a\\\\b'");
  assert.equal(pgString("a'b"), "'a''b'");
});

test('mysql alter command sets the app user password with the root password in the environment', () => {
  const cmd = alterUserCommand('mysql', 'envhub-shop-mysql', 'newpw1', 'rootpw1');
  assert.deepEqual(cmd.args.slice(0, 4), ['exec', '-e', 'MYSQL_PWD=rootpw1', 'envhub-shop-mysql']);
  const sql = cmd.args[cmd.args.length - 1];
  assert.ok(sql.includes("ALTER USER 'app'@'%' IDENTIFIED BY 'newpw1';"));
  assert.ok(sql.includes("CREATE USER IF NOT EXISTS 'app'@'%'"));
});

test('postgres alter command uses ALTER USER with the password', () => {
  const cmd = alterUserCommand('postgres', 'envhub-shop-postgres', 'newpw1', 'rootpw1');
  const sql = cmd.args[cmd.args.length - 1];
  assert.ok(sql.includes(`ALTER ROLE "app" WITH LOGIN PASSWORD 'newpw1'`));
  assert.ok(sql.includes(`ALTER DATABASE "app" OWNER TO "app"`));
});

test('no alter command without a password, nor for other services', () => {
  assert.equal(alterUserCommand('mysql', 'c', '', 'root'), null);
  assert.equal(alterUserCommand('redis', 'c', 'pw1', 'root'), null);
});

test('databaseSteps adds the password step to every database service', () => {
  const services = [{ name: 'mysql' }, { name: 'postgres' }, { name: 'redis' }];
  const steps = databaseSteps(services, 'shop', { dbName: 'app', appPassword: 'newpw1', rootPassword: 'root1' });
  assert.deepEqual(steps.map((s) => `${s.service}:${s.label}`), [
    'mysql:the app user app',
    'postgres:the app user app',
  ]);
});

test('applyServiceEdit keeps, sets and clears the two passwords', () => {
  const spec = { ...SPEC, dbPassword: 'old-db', redisPassword: 'old-redis' };

  const kept = applyServiceEdit(spec, {});
  assert.equal(kept.dbPassword, 'old-db');
  assert.equal(kept.redisPassword, 'old-redis');

  const changed = applyServiceEdit(spec, { dbPassword: 'new-db1', redisPassword: 'new-red1' });
  assert.equal(changed.dbPassword, 'new-db1');
  assert.equal(changed.redisPassword, 'new-red1');

  const cleared = applyServiceEdit(spec, { dbPassword: '', redisPassword: '' });
  assert.equal(cleared.dbPassword, undefined);
  assert.equal(cleared.redisPassword, undefined);

  assert.throws(() => applyServiceEdit(spec, { redisPassword: 'a b' }), /Redis password/);
});

test('describeForEdit returns the saved passwords, or empty strings', () => {
  assert.equal(describeForEdit(SPEC).dbPassword, '');
  assert.equal(describeForEdit({ ...SPEC, redisPassword: 'red-pw1' }).redisPassword, 'red-pw1');
});

test('a Redis password puts --requirepass on the redis service only', () => {
  const plain = buildProject(SPEC, 'rootpw1');
  const redisPlain = plain.services.find((s) => s.name === 'redis');
  assert.equal(redisPlain.command, undefined);

  const locked = buildProject({ ...SPEC, redisPassword: 'red-pw1' }, 'rootpw1');
  const redis = locked.services.find((s) => s.name === 'redis');
  assert.deepEqual(redis.command, ['redis-server', '--requirepass', 'red-pw1']);
  const mysql = locked.services.find((s) => s.name === 'mysql');
  assert.equal(mysql.command, undefined);
});

test('Laravel .env lines follow the layout: DB, Redis with null password, Mailpit block', () => {
  const config = { stack: 'laravel', services: [{ name: 'mysql' }, { name: 'redis' }, { name: 'mailpit' }] };
  const text = connectionText({ config, ports: [], password: 'secret', dbName: 'mamun_sir' });
  for (const line of [
    'DB_HOST=mysql',
    'DB_PORT=3306',
    'DB_DATABASE=mamun_sir',
    'DB_USERNAME=app',
    'DB_PASSWORD=secret',
    'REDIS_HOST=redis',
    'REDIS_PASSWORD=null',
    'REDIS_PORT=6379',
    'MAIL_MAILER=smtp',
    'MAIL_SCHEME=null',
    'MAIL_HOST=mailpit',
    'MAIL_PORT=1025',
    'MAIL_USERNAME=null',
    'MAIL_PASSWORD=null',
    'MAIL_FROM_ADDRESS="hello@example.com"',
    'MAIL_FROM_NAME="${APP_NAME}"',
  ]) {
    assert.ok(text.split('\n').includes(line), line);
  }

  const withRedis = connectionText({ config, ports: [], password: 'secret', dbName: 'app', redisPassword: 'red-pw1' });
  assert.ok(withRedis.split('\n').includes('REDIS_PASSWORD=red-pw1'));
});

test('"my computer" .env uses localhost and the published ports', () => {
  const config = { services: [{ name: 'postgres' }, { name: 'redis' }, { name: 'mailpit' }] };
  const ports = [
    { service: 'postgres', container: 5432, host: 5433 },
    { service: 'redis', container: 6379, host: 6380 },
    { service: 'mailpit', container: 1025, host: 1026 },
  ];
  const host = envFileText({ config, ports, target: 'host', password: 'pw-app1', dbName: 'api' }).split('\n');
  assert.ok(host.includes('DB_HOST=localhost'));
  assert.ok(host.includes('DB_PORT=5433'));
  assert.ok(host.includes('REDIS_HOST=localhost'));
  assert.ok(host.includes('REDIS_PORT=6380'));
  assert.ok(host.includes('MAIL_HOST=localhost'));
  assert.ok(host.includes('MAIL_PORT=1026'));
  assert.ok(host.includes('DATABASE_URL=postgresql://app:pw-app1@localhost:5433/api'));

  const docker = envFileText({ config, ports, password: 'pw-app1', dbName: 'api' }).split('\n');
  assert.ok(docker.includes('DB_HOST=postgres'));
  assert.ok(docker.includes('DB_PORT=5432'));
  assert.ok(docker.includes('MAIL_PORT=1025'));
});

test('NestJS .env has database, Redis and Mailpit settings, and no comment lines', () => {
  const config = { services: [{ name: 'postgres' }, { name: 'redis' }, { name: 'mailpit' }] };
  const text = envFileText({ config, password: 'pw-app1', dbName: 'api', redisPassword: '' });
  const lines = text.split('\n');
  assert.ok(lines.includes('DB_CONNECTION=pgsql'));
  assert.ok(lines.includes('DB_HOST=postgres'));
  assert.ok(lines.includes('DB_DATABASE=api'));
  assert.ok(lines.includes('DB_PASSWORD=pw-app1'));
  assert.ok(lines.includes('DATABASE_URL=postgresql://app:pw-app1@postgres:5432/api'));
  assert.ok(lines.includes('REDIS_PASSWORD=null'));
  assert.ok(lines.includes('REDIS_URL=redis://redis:6379'));
  assert.ok(lines.includes('MAIL_HOST=mailpit'));
  assert.ok(lines.includes('MAIL_PORT=1025'));
  assert.ok(lines.every((line) => !line.startsWith('Put this') && line.trim() !== ''));
});

test('MongoDB gets an app user with the app password, created or updated on start', () => {
  const cmd = alterUserCommand('mongodb', 'envhub-shop-mongodb', 'newpw1', 'rootpw1');
  assert.deepEqual(cmd.args.slice(0, 3), ['exec', 'envhub-shop-mongodb', 'mongosh']);
  assert.ok(cmd.args.includes('rootpw1'));
  const js = cmd.args[cmd.args.length - 1];
  assert.match(js, /createUser\(\{ user: 'app', pwd: 'newpw1'/);
  assert.match(js, /changeUserPassword\('app', 'newpw1'\)/);
});

test('DB user: default app, a new name shows in the .env and tools, reserved names are refused', () => {
  const { normalizeDbUser, dbUserOf } = require('../main/stacks/services');
  assert.equal(normalizeDbUser(''), undefined);
  assert.equal(normalizeDbUser('mamun'), 'mamun');
  assert.equal(dbUserOf({}), 'app');
  assert.equal(dbUserOf({ dbUser: 'mamun' }), 'mamun');
  for (const bad of ['root', 'postgres', 'Mamun', '1user', 'a-b']) {
    assert.throws(() => normalizeDbUser(bad), /Database user/, bad);
  }

  const config = { services: [{ name: 'mysql' }] };
  const lines = envFileText({ config, password: 'pw-app1', dbName: 'mamun_sir', dbUser: 'mamun' }).split('\n');
  assert.ok(lines.includes('DB_USERNAME=mamun'));
  assert.ok(lines.includes('DB_DATABASE=mamun_sir'));
  assert.ok(lines.includes('DB_PASSWORD=pw-app1'));
  assert.ok(lines.includes('MYSQL_URL=mysql://mamun:pw-app1@mysql:3306/mamun_sir'));
});

test('DB user step creates the user and gives it the database (MySQL and PostgreSQL)', () => {
  const my = alterUserCommand('mysql', 'c', 'pw-app1', 'root1', 'mamun', 'mamun_sir');
  const mySql = my.args[my.args.length - 1];
  assert.ok(mySql.includes("CREATE USER IF NOT EXISTS 'mamun'@'%'"));
  assert.ok(mySql.includes('GRANT ALL PRIVILEGES ON `mamun_sir`.* TO \'mamun\'@\'%\''));

  const pg = alterUserCommand('postgres', 'c', 'pw-app1', 'root1', 'mamun', 'mamun_sir');
  const pgSql = pg.args[pg.args.length - 1];
  assert.ok(pgSql.includes('CREATE ROLE "mamun" LOGIN'));
  assert.ok(pgSql.includes('ALTER DATABASE "mamun_sir" OWNER TO "mamun"'));
  assert.ok(pg.args.includes('app'), 'the admin account stays app');
});

test('normalizeMail: empty host clears, valid settings pass, bad values are refused', () => {
  assert.equal(normalizeMail(undefined), undefined);
  assert.equal(normalizeMail({ host: '', port: '', username: '', password: '' }), '');
  assert.deepEqual(
    normalizeMail({ host: 'sandbox.smtp.mailtrap.io', port: '2525', username: 'u1', password: 'p1' }),
    { host: 'sandbox.smtp.mailtrap.io', port: 2525, username: 'u1', password: 'p1' },
  );
  assert.throws(() => normalizeMail({ host: 'bad host', port: '2525' }), /Mail host/);
  assert.throws(() => normalizeMail({ host: 'ok.host', port: '99999' }), /Mail port/);
  assert.throws(() => normalizeMail({ host: 'ok.host', port: '25', username: 'a\nb' }), /one line/);
});

test('external mail replaces the Mailpit lines in the .env', () => {
  const config = { services: [{ name: 'mailpit' }] };
  const external = envFileText({
    config,
    password: 'pw-app1',
    dbName: 'app',
    mail: { host: 'sandbox.smtp.mailtrap.io', port: 2525, username: 'mt-user', password: 'mt-pass' },
  }).split('\n');
  assert.ok(external.includes('MAIL_HOST=sandbox.smtp.mailtrap.io'));
  assert.ok(external.includes('MAIL_PORT=2525'));
  assert.ok(external.includes('MAIL_USERNAME=mt-user'));
  assert.ok(external.includes('MAIL_PASSWORD=mt-pass'));
  assert.ok(!external.includes('MAIL_HOST=mailpit'));

  const local = envFileText({ config, password: 'pw-app1', dbName: 'app' }).split('\n');
  assert.ok(local.includes('MAIL_HOST=mailpit'));
});

test('connection text shows the app password for the app, the root password for root, and the Redis password', () => {
  const config = buildProject({ ...SPEC, options: { mysql: true, redis: true, mongodb: true } }, 'rootpw1');
  const text = connectionText({
    config,
    ports: [],
    password: 'newpw1',
    rootPassword: 'rootpw1',
    dbName: 'shop',
    redisPassword: 'red-pw1',
  });
  assert.match(text, /MYSQL_URL=mysql:\/\/app:newpw1@mysql:3306\/shop/);
  assert.match(text, /root password rootpw1/);
  assert.match(text, /REDIS_URL=redis:\/\/:red-pw1@redis:6379/);
  assert.match(text, /MONGODB_URL=mongodb:\/\/app:newpw1@mongodb:27017/);
});
