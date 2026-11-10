'use strict';

const { DB_USER, DB_NAME } = require('./services');

function hostPort(ports, service, container) {
  const found = ports.find((p) => p.service === service && p.container === container);
  return found ? found.host : null;
}

// Where a service can be reached, for one of the two .env versions:
//   'docker' -> the app runs inside Docker: host = service name, port = container port
//   'host'   -> the app runs on this computer: host = localhost, port = the port Docker published
function addressOf(target, ports, service, container) {
  if (target === 'host') {
    return { host: 'localhost', port: hostPort(ports, service, container) || container };
  }
  return { host: service, port: container };
}

// Lines for a .env file. The same variables for every stack, so a NestJS project and a Laravel
// project both get database, Redis and mail settings in one place.
// `password` is the app user's password. `rootPassword` is the container root (MongoDB uses it).
// A .env value. Values with spaces or special characters are wrapped in double quotes.
function envValue(value) {
  const text = String(value);
  return /[\s#"'$]/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

function envLines(config, creds, has, target = 'docker', ports = []) {
  const { password, dbName, redisPassword, mail } = creds;
  const user = creds.user || DB_USER;
  const isLaravel = config.stack === 'laravel';
  const at = (service, container) => addressOf(target, ports, service, container);
  const lines = [];

  // Main SQL database: MySQL first, PostgreSQL when only that one is present.
  if (has('mysql') || has('postgres')) {
    const pg = !has('mysql');
    const db = pg ? at('postgres', 5432) : at('mysql', 3306);
    lines.push(
      `DB_CONNECTION=${pg ? 'pgsql' : 'mysql'}`,
      `DB_HOST=${db.host}`,
      `DB_PORT=${db.port}`,
      `DB_DATABASE=${dbName}`,
      `DB_USERNAME=${user}`,
      `DB_PASSWORD=${password}`,
    );
  }

  // Connection strings are for Node-style apps. Laravel reads the DB_* lines above.
  if (!isLaravel) {
    const my = at('mysql', 3306);
    const pgAddr = at('postgres', 5432);
    const mysqlUrl = `mysql://${user}:${password}@${my.host}:${my.port}/${dbName}`;
    const postgresUrl = `postgresql://${user}:${password}@${pgAddr.host}:${pgAddr.port}/${dbName}`;
    if (has('mysql')) lines.push(`MYSQL_URL=${mysqlUrl}`);
    if (has('postgres')) lines.push(`POSTGRES_URL=${postgresUrl}`);
    if (has('mysql') !== has('postgres')) {
      lines.push(`DATABASE_URL=${has('mysql') ? mysqlUrl : postgresUrl}`);
    }
  }

  // MongoDB uses the app user (created on start with the app password), like MySQL and PostgreSQL.
  if (has('mongodb')) {
    const mongo = at('mongodb', 27017);
    lines.push(`MONGODB_URL=mongodb://${user}:${password}@${mongo.host}:${mongo.port}`);
  }

  if (has('redis')) {
    const redis = at('redis', 6379);
    lines.push(`REDIS_HOST=${redis.host}`, `REDIS_PASSWORD=${redisPassword || 'null'}`, `REDIS_PORT=${redis.port}`);
    if (!isLaravel) {
      const auth = redisPassword ? `:${redisPassword}@` : '';
      lines.push(`REDIS_URL=redis://${auth}${redis.host}:${redis.port}`);
    }
  }

  // An external mail server (Mailtrap or any SMTP) when the user set one. Otherwise Mailpit catches every mail.
  if (mail && mail.host) {
    lines.push(
      'MAIL_MAILER=smtp',
      'MAIL_SCHEME=null',
      `MAIL_HOST=${envValue(mail.host)}`,
      `MAIL_PORT=${mail.port}`,
      `MAIL_USERNAME=${mail.username ? envValue(mail.username) : 'null'}`,
      `MAIL_PASSWORD=${mail.password ? envValue(mail.password) : 'null'}`,
      'MAIL_FROM_ADDRESS="hello@example.com"',
      'MAIL_FROM_NAME="${APP_NAME}"',
    );
  } else if (has('mailpit')) {
    const smtp = at('mailpit', 1025);
    lines.push(
      'MAIL_MAILER=smtp',
      'MAIL_SCHEME=null',
      `MAIL_HOST=${smtp.host}`,
      `MAIL_PORT=${smtp.port}`,
      'MAIL_USERNAME=null',
      'MAIL_PASSWORD=null',
      'MAIL_FROM_ADDRESS="hello@example.com"',
      'MAIL_FROM_NAME="${APP_NAME}"',
    );
  }
  return lines;
}

// The .env text alone, for the two Copy .env buttons.
// `target`: 'docker' (app runs in Docker) or 'host' (app runs on this computer).
// `ports`: the published ports, needed for 'host'.
function envFileText({ config, ports = [], password, dbName = DB_NAME, dbUser = DB_USER, redisPassword = '', mail, target = 'docker' }) {
  const creds = { password, dbName, user: dbUser, redisPassword, mail };
  const has = (name) => config.services.some((s) => s.name === name);
  return envLines(config, creds, has, target, ports).join('\n');
}

// Plain text for the Connection panel: the two .env versions, and how to reach each tool.
function connectionText({ config, ports, password, rootPassword, dbName = DB_NAME, dbUser = DB_USER, redisPassword = '', mail }) {
  const root = rootPassword || password;
  const user = dbUser || DB_USER;
  const creds = { password, dbName, user, redisPassword, mail };
  const has = (name) => config.services.some((s) => s.name === name);
  const url = (service, container) => {
    const host = hostPort(ports, service, container);
    return host ? `http://localhost:${host}` : 'not available';
  };

  // Ports for the DB tools on this computer. The host is always localhost here, never a service name.
  const portOf = (service, container) => {
    const host = hostPort(ports, service, container);
    return host ? String(host) : 'not available';
  };

  const envDocker = envLines(config, creds, has, 'docker', ports);
  const envHost = envLines(config, creds, has, 'host', ports);
  const tools = [];
  if (has('mysql')) {
    tools.push(`  MySQL       Host localhost   Port ${portOf('mysql', 3306)}   database ${dbName}   user ${user}   password ${password}`);
    tools.push(`              root password ${root}`);
  }
  if (has('postgres')) {
    tools.push(`  PostgreSQL  Host localhost   Port ${portOf('postgres', 5432)}   database ${dbName}   user ${user}   password ${password}`);
  }
  if (has('mongodb')) {
    tools.push(`  MongoDB     Host localhost   Port ${portOf('mongodb', 27017)}   user ${user}   password ${password}   (use MongoDB Compass)`);
  }
  if (has('redis')) {
    tools.push(redisPassword
      ? `  Redis       Host localhost   Port ${portOf('redis', 6379)}   password ${redisPassword}`
      : `  Redis       Host localhost   Port ${portOf('redis', 6379)}   no password`);
  }

  const pages = [];
  if (has('phpmyadmin')) pages.push(`  phpMyAdmin  ${url('phpmyadmin', 80)}   (signs in automatically as root)`);
  if (has('adminer')) {
    const server = has('mysql') ? 'mysql' : 'postgres';
    pages.push(`  Adminer     ${url('adminer', 8080)}   (server ${server}, user ${user}, password ${password}; pick the System that matches)`);
  }
  if (mail && mail.host) {
    pages.push(`  Mail        ${mail.host}:${mail.port}   (external SMTP, e.g. Mailtrap; user ${mail.username || '-'}, password ${mail.password || '-'})`);
  } else if (has('mailpit')) {
    pages.push(`  Mailpit     ${url('mailpit', 8025)}   (the app sends mail to mailpit:1025, no login)`);
  }

  // Services the user added by hand: show where each one can be reached from this computer.
  const known = new Set(['nginx', 'php', 'node', 'app', 'mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit']);
  const extras = [];
  for (const service of config.services) {
    if (known.has(service.name)) continue;
    const mapped = ports.filter((p) => p.service === service.name);
    const where = mapped.map((p) => `localhost:${p.host} (container port ${p.container})`).join(', ');
    extras.push(`  ${service.name}  ${service.image}   ${where || 'no ports'}`);
    for (const key of Object.keys(service.env || {})) {
      extras.push(`      ${key}=${service.env[key]}`);
    }
  }

  if (envDocker.length === 0 && tools.length === 0 && pages.length === 0 && extras.length === 0) {
    return 'This project has no database or other services.';
  }

  // Two separate sections, so the host is never mixed up:
  // inside Docker the host is the service name (postgres), on this computer it is localhost.
  const out = [];
  if (envDocker.length > 0) {
    out.push('=== APP INSIDE DOCKER: .env file ===');
    out.push('Your app runs in a container, so the host is the service name (DB_HOST=postgres).');
    out.push('Use the "Copy .env (Docker)" button. Do NOT use these hosts in a DB tool.', '');
    out.push(...envDocker, '');
  }
  if (envHost.length > 0) {
    out.push('=== APP ON THIS COMPUTER: .env file ===');
    out.push('Your app runs on this computer (outside Docker), so the host is localhost and the port is the one shown.');
    out.push('Use the "Copy .env (my computer)" button.', '');
    out.push(...envHost, '');
  }
  if (tools.length > 0) {
    out.push('=== DB TOOL ON THIS COMPUTER: TablePlus, DBeaver, PgAdmin, Compass ===');
    out.push('Use Host localhost and the Port shown. Do NOT use postgres or mysql as the host here.', '');
    out.push(...tools, '');
  }
  if (pages.length > 0) {
    out.push('=== WEB PAGES: open in your browser ===', ...pages, '');
  }
  if (extras.length > 0) {
    out.push('=== EXTRA SERVICES (inside Docker use the service name as the host) ===', ...extras, '');
  }
  out.push('A port can change when the project starts, if it is taken. Start the project to see the final ones.');
  return out.join('\n');
}

// The same facts as connectionText, as data, so the window can show cards with copy buttons.
// { env: { docker, host }, databases: [...], pages: [...], extras: [...] }
function connectionData({ config, ports, password, rootPassword, dbName = DB_NAME, dbUser = DB_USER, redisPassword = '', mail }) {
  const root = rootPassword || password;
  const user = dbUser || DB_USER;
  const creds = { password, dbName, user, redisPassword, mail };
  const has = (name) => config.services.some((s) => s.name === name);
  const portOf = (service, container) => {
    const host = hostPort(ports, service, container);
    return host ? String(host) : '';
  };
  const url = (service, container) => {
    const host = hostPort(ports, service, container);
    return host ? `http://localhost:${host}` : '';
  };

  const databases = [];
  if (has('mysql')) {
    databases.push({ key: 'mysql', label: 'MySQL', host: 'localhost', port: portOf('mysql', 3306), database: dbName, user, password, rootPassword: root });
  }
  if (has('postgres')) {
    databases.push({ key: 'postgres', label: 'PostgreSQL', host: 'localhost', port: portOf('postgres', 5432), database: dbName, user, password });
  }
  if (has('mongodb')) {
    databases.push({ key: 'mongodb', label: 'MongoDB', host: 'localhost', port: portOf('mongodb', 27017), user, password, note: 'Use MongoDB Compass' });
  }
  if (has('redis')) {
    databases.push({ key: 'redis', label: 'Redis', host: 'localhost', port: portOf('redis', 6379), password: redisPassword, note: redisPassword ? '' : 'No password' });
  }

  const pages = [];
  if (has('phpmyadmin')) pages.push({ service: 'phpmyadmin', label: 'phpMyAdmin', url: url('phpmyadmin', 80), note: 'Signs in automatically as root' });
  if (has('adminer')) {
    const server = has('mysql') ? 'mysql' : 'postgres';
    pages.push({ service: 'adminer', label: 'Adminer', url: url('adminer', 8080), note: `Server ${server}, user ${user}` });
  }
  if (mail && mail.host) {
    pages.push({ service: '', label: 'Mail (SMTP)', url: `${mail.host}:${mail.port}`, note: `External SMTP, user ${mail.username || '-'}` });
  } else if (has('mailpit')) {
    pages.push({ service: 'mailpit', label: 'Mailpit', url: url('mailpit', 8025), note: 'The app sends mail to mailpit:1025, no login' });
  }

  const known = new Set(['nginx', 'php', 'node', 'app', 'mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit']);
  const extras = config.services
    .filter((service) => !known.has(service.name))
    .map((service) => ({
      name: service.name,
      image: service.image,
      ports: ports.filter((p) => p.service === service.name).map((p) => ({ host: p.host, container: p.container })),
      env: { ...(service.env || {}) },
    }));

  return {
    env: {
      docker: envLines(config, creds, has, 'docker', ports).join('\n'),
      host: envLines(config, creds, has, 'host', ports).join('\n'),
    },
    databases,
    pages,
    extras,
  };
}

module.exports = { connectionText, connectionData, envFileText };
