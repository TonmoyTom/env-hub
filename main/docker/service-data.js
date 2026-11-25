'use strict';

// What the Mail and Redis tabs show: the mails Mailpit caught, and the keys and values in Redis.
// Mailpit is asked through its own API on this computer (http://127.0.0.1:<port>/api/v1/...).
// Redis is asked with redis-cli inside its container (docker exec), so no port or tool is needed here.
// Every input from the window is checked first; commands are passed as arguments, never through a shell.

const { runDocker } = require('./exec');
const { containerName } = require('../naming');

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAIL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_KEYS = 500;
const MAX_VALUE_ITEMS = 200;
const MAX_TEXT = 256 * 1024;
const REDIS_TIMEOUT_MS = 10000;
const MAIL_TIMEOUT_MS = 6000;

function assertProject(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('Invalid project name');
}

function cut(text, max = MAX_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n… (cut at ${Math.round(max / 1024)} KB)` : value;
}

// ---------- Mailpit ----------

// `target` is { port } when Mailpit's port 8025 is published on this computer, or { container } when it is
// not (for example an extra service added without ports). Then the request runs inside the container:
// BusyBox wget for reading, nc for the DELETE (BusyBox wget cannot send DELETE).
const CONTAINER_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;

async function mailpitFetch(target, pathAndQuery, options = {}, fetchFn = fetch, run = runDocker) {
  if (target && target.container) return mailpitExec(target.container, pathAndQuery, options, run);
  const label = options.label || 'Mailpit';
  const port = target && typeof target === 'object' ? target.port : target;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${label} has no port on this computer`);
  const { label: _label, containerPort: _containerPort, contentType, ...fetchOptions } = options;
  if (contentType) fetchOptions.headers = { ...(fetchOptions.headers || {}), 'content-type': contentType };
  let res;
  try {
    res = await fetchFn(`http://127.0.0.1:${port}${pathAndQuery}`, {
      ...fetchOptions,
      signal: AbortSignal.timeout(MAIL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`${label} does not answer. Start the project first.`);
  }
  if (!res.ok) throw new Error(`${label} answered ${res.status}`);
  const type = res.headers.get('content-type') || '';
  return type.includes('json') ? res.json() : res.text();
}

async function mailpitExec(container, pathAndQuery, options, run) {
  if (typeof container !== 'string' || !CONTAINER_RE.test(container)) throw new Error('Invalid container');
  const method = options.method || 'GET';
  const label = options.label || 'Mailpit';
  const inner = Number.isInteger(options.containerPort) ? options.containerPort : 8025;
  let res;
  if (method === 'GET') {
    res = await run(['exec', container, 'wget', '-qO-', `http://127.0.0.1:${inner}${pathAndQuery}`], { timeout: MAIL_TIMEOUT_MS });
  } else {
    const body = options.body || '';
    const type = options.contentType || 'application/json';
    const request = `${method} ${pathAndQuery} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: ${type}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    // The request is passed as $1, never pasted into the shell text.
    res = await run(['exec', container, 'sh', '-c', `printf "%s" "$1" | nc 127.0.0.1 ${inner}`, 'sh', request], { timeout: MAIL_TIMEOUT_MS });
    if (res.ok && !/^HTTP\/1\.[01] 2\d\d/.test(res.stdout || '')) {
      throw new Error(`${label} answered: ${(res.stdout || '').split('\n')[0].trim() || 'nothing'}`);
    }
  }
  if (!res.ok) {
    const message = `${res.stderr || ''}${res.stdout || ''}`;
    if (/No such container|is not running/i.test(message)) throw new Error(`${label} is not running. Start the project first.`);
    throw new Error(`${label} does not answer inside its container.`);
  }
  const text = res.stdout || '';
  if (method !== 'GET') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    return text;
  }
}

function person(p) {
  if (!p) return '';
  return p.Name ? `${p.Name} <${p.Address}>` : String(p.Address || '');
}

async function listMails(port, { search = '', limit = 100 } = {}, fetchFn = fetch, run = runDocker) {
  const query = String(search || '').trim().slice(0, 200);
  const max = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const path = query
    ? `/api/v1/search?query=${encodeURIComponent(query)}&limit=${max}`
    : `/api/v1/messages?limit=${max}`;
  const data = await mailpitFetch(port, path, {}, fetchFn, run);
  return {
    total: Number(data.total ?? data.messages_count ?? 0),
    unread: Number(data.unread ?? 0),
    messages: (data.messages || []).map((m) => ({
      id: m.ID,
      from: person(m.From),
      to: (m.To || []).map(person).join(', '),
      subject: m.Subject || '(no subject)',
      created: m.Created,
      size: m.Size || 0,
      read: m.Read === true,
      snippet: m.Snippet || '',
      attachments: Number(m.Attachments || 0),
    })),
  };
}

async function readMail(port, id, fetchFn = fetch, run = runDocker) {
  if (typeof id !== 'string' || !MAIL_ID_RE.test(id)) throw new Error('Invalid mail');
  const m = await mailpitFetch(port, `/api/v1/message/${id}`, {}, fetchFn, run);
  const hostPort = port && typeof port === 'object' ? port.port : port;
  return {
    id: m.ID,
    from: person(m.From),
    to: (m.To || []).map(person).join(', '),
    cc: (m.Cc || []).map(person).join(', '),
    subject: m.Subject || '(no subject)',
    date: m.Date,
    text: cut(m.Text),
    html: cut(m.HTML),
    attachments: (m.Attachments || []).map((a) => ({ name: a.FileName, type: a.ContentType, size: a.Size })),
    // The page Mailpit renders for this mail, shown in a sandboxed frame (no scripts). Without a published
    // port there is no such page here; the window then shows `html` itself in the sandboxed frame.
    viewUrl: Number.isInteger(hostPort) ? `http://127.0.0.1:${hostPort}/view/${m.ID}.html` : '',
  };
}

async function deleteMails(port, ids, fetchFn = fetch, run = runDocker) {
  if (ids !== 'all' && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && MAIL_ID_RE.test(id)))) {
    throw new Error('Invalid mail');
  }
  const body = ids === 'all' ? undefined : JSON.stringify({ IDs: ids });
  await mailpitFetch(port, '/api/v1/messages', {
    method: 'DELETE',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body,
  }, fetchFn, run);
  return { ok: true };
}

// ---------- Smocker: requests an app sent to a fake API (fax, payment, SMS ...) ----------
// The app calls Smocker instead of the real provider. Its admin API (port 8081 in the container) lists
// every request it caught, can clear them, and can load a rule that answers every request with 200 OK.

const SMOCKER = { label: 'Smocker', containerPort: 8081 };

// Every request (any method, any path) gets 200 and a small JSON body, so the app sees "sent".
const OK_MOCK = [
  '- request:',
  '    method:',
  '      matcher: ShouldMatch',
  '      value: .*',
  '    path:',
  '      matcher: ShouldMatch',
  '      value: /.*',
  '  response:',
  '    status: 200',
  '    headers:',
  '      Content-Type: application/json',
  '    body: \'{"status":"queued","id":"test-1"}\'',
  '',
].join('\n');

function firstValues(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  return out;
}

function queryText(params) {
  const parts = [];
  for (const [key, values] of Object.entries(params || {})) {
    for (const v of Array.isArray(values) ? values : [values]) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

async function listRequests(target, fetchFn = fetch, run = runDocker) {
  const data = await mailpitFetch(target, '/history', SMOCKER, fetchFn, run);
  const list = Array.isArray(data) ? data : [];
  return list.map((entry, i) => {
    const req = entry.request || {};
    const res = entry.response || {};
    return {
      i,
      at: req.date || null,
      method: req.method || '',
      path: req.path || '',
      query: queryText(req.query_params),
      headers: firstValues(req.headers),
      body: cut(req.body_string !== undefined ? req.body_string : (req.body ? JSON.stringify(req.body) : '')),
      origin: req.origin || '',
      status: Number(res.status) || 0,
      responseBody: cut(typeof res.body === 'string' ? res.body : res.body ? JSON.stringify(res.body) : ''),
      mocked: Boolean(entry.context && entry.context.mock_id),
    };
  }).reverse();
}

async function resetRequests(target, fetchFn = fetch, run = runDocker) {
  await mailpitFetch(target, '/reset', { ...SMOCKER, method: 'POST', body: '' }, fetchFn, run);
  return { ok: true };
}

async function answerAllOk(target, fetchFn = fetch, run = runDocker) {
  await mailpitFetch(target, '/mocks', { ...SMOCKER, method: 'POST', body: OK_MOCK, contentType: 'application/x-yaml' }, fetchFn, run);
  return { ok: true };
}

// ---------- Redis ----------

function checkDb(db) {
  const n = Number(db);
  if (!Number.isInteger(n) || n < 0 || n > 15) throw new Error('Invalid Redis database');
  return n;
}

function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024 || /[\r\n]/.test(key)) throw new Error('Invalid key');
  return key;
}

// redis-cli in the project's redis container. --raw prints one value per line, without quotes.
// `projectName` is the project, or { project, service } when Redis runs under another service name.
async function redisCli(projectName, password, db, args, run = runDocker) {
  const project = typeof projectName === 'object' ? projectName.project : projectName;
  const service = typeof projectName === 'object' ? projectName.service : 'redis';
  assertProject(project);
  if (typeof service !== 'string' || !NAME_RE.test(service)) throw new Error('Invalid service');
  const env = password ? ['-e', `REDISCLI_AUTH=${password}`] : [];
  const res = await run(['exec', ...env, containerName(project, service), 'redis-cli', '--no-auth-warning', '--raw', '-n', String(db), ...args], { timeout: REDIS_TIMEOUT_MS });
  const out = `${res.stdout || ''}`;
  // A wrong password still exits with 0: redis-cli only prints "AUTH failed" / "NOAUTH".
  if (/AUTH failed|NOAUTH|WRONGPASS/i.test(`${res.stderr || ''}\n${out.split('\n')[0]}`)) {
    throw new Error(password
      ? 'Redis did not accept the saved password. Save the Redis password in the Settings tab again, then Save and apply.'
      : 'Redis asks for a password. Set the Redis password in the Settings tab, then Save and apply.');
  }
  if (!res.ok) {
    const message = `${res.stderr || ''}${out}`.trim();
    if (/No such container|is not running/i.test(message)) throw new Error('Redis is not running. Start the project first.');
    if (/NOAUTH|WRONGPASS/i.test(message)) throw new Error('Redis asked for a password that does not match. Save the Redis password in the Settings tab again.');
    throw new Error(message.split('\n')[0] || 'Redis did not answer');
  }
  // redis-cli prints errors on stdout. Commands that return stored data are not checked: a value may start with "ERR".
  const returnsData = ['GET', 'LRANGE', 'SRANDMEMBER', 'ZRANGE', 'HGETALL', 'XRANGE', 'EVAL'].includes(args[0]);
  const first = out.trim().split('\n')[0] || '';
  if (!returnsData && /^(\(error\) )?(ERR|NOAUTH|WRONGPASS|WRONGTYPE)\b/.test(first)) {
    throw new Error(first);
  }
  if (args[0] === 'EVAL' && /^(\(error\) )?(ERR|NOAUTH|WRONGPASS)\b/.test(first) && !out.includes('\n', first.length + 1)) {
    throw new Error(first);
  }
  return out;
}

function lines(text) {
  const list = String(text).split('\n');
  if (list.length && list[list.length - 1] === '') list.pop();
  return list.map((l) => l.replace(/\r$/, ''));
}

// Key counts of every database that has keys: "db0:keys=12,expires=3,avg_ttl=0".
async function redisOverview(projectName, password, run = runDocker) {
  const info = await redisCli(projectName, password, 0, ['INFO', 'keyspace'], run);
  const memory = await redisCli(projectName, password, 0, ['INFO', 'memory'], run).catch(() => '');
  const dbs = {};
  for (const line of lines(info)) {
    const m = /^db(\d+):keys=(\d+)/.exec(line);
    if (m) dbs[Number(m[1])] = Number(m[2]);
  }
  const used = /used_memory_human:(\S+)/.exec(memory);
  return { dbs, memory: used ? used[1] : '' };
}

// Up to MAX_KEYS keys matching the pattern, each with its type and TTL (seconds, -1 = no expiry).
// One Lua script walks SCAN, so this is one docker exec, not one per key.
const SCAN_SCRIPT = [
  "local out = {}",
  "local cursor = '0'",
  "local limit = tonumber(ARGV[2])",
  "repeat",
  "  local res = redis.call('SCAN', cursor, 'MATCH', ARGV[1], 'COUNT', 1000)",
  "  cursor = res[1]",
  "  for _, k in ipairs(res[2]) do",
  "    out[#out + 1] = k",
  "    out[#out + 1] = redis.call('TYPE', k)['ok']",
  "    out[#out + 1] = tostring(redis.call('TTL', k))",
  "    if #out >= limit * 3 then return out end",
  "  end",
  "until cursor == '0'",
  "return out",
].join('\n');

async function redisKeys(projectName, password, { db = 0, pattern = '*' } = {}, run = runDocker) {
  const n = checkDb(db);
  const match = String(pattern || '*').trim().slice(0, 200) || '*';
  const out = await redisCli(projectName, password, n, ['EVAL', SCAN_SCRIPT, '0', match, String(MAX_KEYS)], run);
  const list = lines(out);
  const keys = [];
  for (let i = 0; i + 2 < list.length; i += 3) {
    keys.push({ key: list[i], type: list[i + 1], ttl: Number(list[i + 2]) });
  }
  keys.sort((a, b) => a.key.localeCompare(b.key));
  return { keys, more: keys.length >= MAX_KEYS };
}

async function redisValue(projectName, password, { db = 0, key } = {}, run = runDocker) {
  const n = checkDb(db);
  const k = checkKey(key);
  const type = lines(await redisCli(projectName, password, n, ['TYPE', k], run))[0] || 'none';
  const ttl = Number(lines(await redisCli(projectName, password, n, ['TTL', k], run))[0]);
  const last = String(MAX_VALUE_ITEMS - 1);
  let value;
  let size = null;
  if (type === 'string') {
    value = cut(await redisCli(projectName, password, n, ['GET', k], run)).replace(/\n$/, '');
  } else if (type === 'list') {
    size = Number(lines(await redisCli(projectName, password, n, ['LLEN', k], run))[0]);
    value = lines(await redisCli(projectName, password, n, ['LRANGE', k, '0', last], run));
  } else if (type === 'set') {
    size = Number(lines(await redisCli(projectName, password, n, ['SCARD', k], run))[0]);
    value = lines(await redisCli(projectName, password, n, ['SRANDMEMBER', k, String(MAX_VALUE_ITEMS)], run));
  } else if (type === 'zset') {
    size = Number(lines(await redisCli(projectName, password, n, ['ZCARD', k], run))[0]);
    const flat = lines(await redisCli(projectName, password, n, ['ZRANGE', k, '0', last, 'WITHSCORES'], run));
    value = [];
    for (let i = 0; i + 1 < flat.length; i += 2) value.push({ member: flat[i], score: flat[i + 1] });
  } else if (type === 'hash') {
    size = Number(lines(await redisCli(projectName, password, n, ['HLEN', k], run))[0]);
    const flat = lines(await redisCli(projectName, password, n, ['HGETALL', k], run));
    value = [];
    for (let i = 0; i + 1 < flat.length && value.length < MAX_VALUE_ITEMS; i += 2) value.push({ field: flat[i], value: cut(flat[i + 1], 16 * 1024) });
  } else if (type === 'stream') {
    value = cut(await redisCli(projectName, password, n, ['XRANGE', k, '-', '+', 'COUNT', '50'], run));
  } else if (type === 'none') {
    throw new Error('This key does not exist any more.');
  } else {
    value = `(${type} values are not shown here)`;
  }
  return { key: k, type, ttl, size, value };
}

async function redisDelete(projectName, password, { db = 0, key } = {}, run = runDocker) {
  await redisCli(projectName, password, checkDb(db), ['DEL', checkKey(key)], run);
  return { ok: true };
}

async function redisFlush(projectName, password, { db = 0 } = {}, run = runDocker) {
  await redisCli(projectName, password, checkDb(db), ['FLUSHDB'], run);
  return { ok: true };
}

module.exports = {
  listRequests,
  resetRequests,
  answerAllOk,
  OK_MOCK,
  listMails,
  readMail,
  deleteMails,
  redisOverview,
  redisKeys,
  redisValue,
  redisDelete,
  redisFlush,
  SCAN_SCRIPT,
};
