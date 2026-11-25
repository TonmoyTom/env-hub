'use strict';

const test = require('node:test');
const assert = require('node:assert');
const data = require('../main/docker/service-data');

function fakeRun(answers) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const command = args[args.indexOf('-n') + 2];
    const answer = answers[command];
    return typeof answer === 'function' ? answer(args) : answer || { ok: true, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('redis keys: one EVAL lists key, type and ttl, sorted', async () => {
  const { run, calls } = fakeRun({
    EVAL: { ok: true, stdout: 'b:key\nhash\n-1\na:key\nstring\n120\n', stderr: '' },
  });
  const res = await data.redisKeys('shop', 'pw', { db: 1, pattern: 'a*' }, run);
  assert.deepStrictEqual(res.keys, [
    { key: 'a:key', type: 'string', ttl: 120 },
    { key: 'b:key', type: 'hash', ttl: -1 },
  ]);
  const args = calls[0];
  assert.ok(args.includes('REDISCLI_AUTH=pw'), 'the password goes in as an environment value');
  assert.strictEqual(args[args.indexOf('-n') + 1], '1');
  assert.ok(args.includes('a*'));
  assert.ok(args.includes('envhub-shop-redis'));
});

test('redis: a wrong password gives a clear message, even though redis-cli exits with 0', async () => {
  const { run } = fakeRun({ EVAL: { ok: true, stdout: 'NOAUTH Authentication required.\n', stderr: 'AUTH failed: WRONGPASS invalid username-password pair\n' } });
  await assert.rejects(() => data.redisKeys('shop', 'bad', {}, run), /did not accept the saved password/);
});

test('redis: a stored value that starts with ERR is a value, not an error', async () => {
  const { run } = fakeRun({
    TYPE: { ok: true, stdout: 'string\n', stderr: '' },
    TTL: { ok: true, stdout: '-1\n', stderr: '' },
    GET: { ok: true, stdout: 'ERR this is just text\n', stderr: '' },
  });
  const res = await data.redisValue('shop', '', { db: 0, key: 'note' }, run);
  assert.strictEqual(res.value, 'ERR this is just text');
});

test('redis: hashes come back as field / value pairs', async () => {
  const { run } = fakeRun({
    TYPE: { ok: true, stdout: 'hash\n', stderr: '' },
    TTL: { ok: true, stdout: '30\n', stderr: '' },
    HLEN: { ok: true, stdout: '2\n', stderr: '' },
    HGETALL: { ok: true, stdout: 'user_id\n1\ncsrf\nxyz\n', stderr: '' },
  });
  const res = await data.redisValue('shop', '', { db: 0, key: 'session' }, run);
  assert.deepStrictEqual(res.value, [{ field: 'user_id', value: '1' }, { field: 'csrf', value: 'xyz' }]);
  assert.strictEqual(res.size, 2);
});

test('redis: bad input is refused before docker runs', async () => {
  const { run, calls } = fakeRun({});
  await assert.rejects(() => data.redisKeys('Bad Name', '', {}, run), /Invalid project name/);
  await assert.rejects(() => data.redisKeys('shop', '', { db: 16 }, run), /Invalid Redis database/);
  await assert.rejects(() => data.redisValue('shop', '', { db: 0, key: 'a\nFLUSHALL' }, run), /Invalid key/);
  await assert.rejects(() => data.redisDelete('shop', '', { db: 0, key: '' }, run), /Invalid key/);
  assert.strictEqual(calls.length, 0);
});

test('mail: ids are checked, and a stopped Mailpit gives a clear message', async () => {
  await assert.rejects(() => data.readMail(8025, '../../etc/passwd'), /Invalid mail/);
  await assert.rejects(() => data.deleteMails(8025, ['ok-id', 'bad id']), /Invalid mail/);
  const down = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => data.listMails(8025, {}, down), /Mailpit does not answer/);
});

test('requests (Smocker): history is reshaped, newest first, with query and body', async () => {
  const fetchFn = async (url) => {
    assert.strictEqual(url, 'http://127.0.0.1:18081/history');
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ([
        { context: { mock_id: 'a' }, request: { method: 'POST', path: '/v2/faxes', body_string: '{"to":"+1"}', query_params: { priority: ['high'] }, headers: { 'Content-Type': ['application/json'] }, date: '2026-11-24T10:00:00Z' }, response: { status: 200, body: { status: 'queued' } } },
        { context: {}, request: { method: 'GET', path: '/v2/faxes/1' }, response: { status: 666 } },
      ]),
    };
  };
  const list = await data.listRequests({ port: 18081 }, fetchFn);
  assert.deepStrictEqual(list.map((r) => [r.method, r.path, r.status, r.mocked]), [['GET', '/v2/faxes/1', 666, false], ['POST', '/v2/faxes', 200, true]]);
  assert.strictEqual(list[1].query, 'priority=high');
  assert.strictEqual(list[1].body, '{"to":"+1"}');
  assert.strictEqual(list[1].responseBody, '{"status":"queued"}');
  assert.deepStrictEqual(list[1].headers, { 'Content-Type': 'application/json' });
});

test('requests (Smocker): without a port the rule goes in through docker exec, as YAML on port 8081', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { ok: true, stdout: 'HTTP/1.0 200 OK\r\n\r\n', stderr: '' };
  };
  await data.answerAllOk({ container: 'envhub-shop-smocker' }, fetch, run);
  const args = calls[0];
  assert.deepStrictEqual(args.slice(0, 4), ['exec', 'envhub-shop-smocker', 'sh', '-c']);
  assert.strictEqual(args[4], 'printf "%s" "$1" | nc 127.0.0.1 8081');
  const request = args[6];
  assert.match(request, /^POST \/mocks HTTP\/1\.0\r\n/);
  assert.match(request, /Content-Type: application\/x-yaml/);
  assert.ok(request.endsWith(data.OK_MOCK));
  await assert.rejects(() => data.answerAllOk({ container: 'bad name; rm -rf /' }, fetch, run), /Invalid container/);
});

test('mail: the list is reshaped for the window', async () => {
  const fetchFn = async (url) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8025\/api\/v1\/search\?query=Welcome&limit=100$/);
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        total: 1,
        unread: 1,
        messages: [{ ID: 'abc', From: { Name: 'Shop', Address: 'app@shop.test' }, To: [{ Address: 'ana@example.com' }], Subject: 'Welcome', Created: '2026-11-24T10:00:00Z', Read: false, Snippet: 'Hi', Attachments: 1 }],
      }),
    };
  };
  const res = await data.listMails(8025, { search: 'Welcome' }, fetchFn);
  assert.deepStrictEqual(res.messages[0], {
    id: 'abc', from: 'Shop <app@shop.test>', to: 'ana@example.com', subject: 'Welcome',
    created: '2026-11-24T10:00:00Z', size: 0, read: false, snippet: 'Hi', attachments: 1,
  });
});
