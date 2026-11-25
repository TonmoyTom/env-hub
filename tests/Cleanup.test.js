'use strict';

const test = require('node:test');
const assert = require('node:assert');
const cleanup = require('../main/docker/cleanup');

test('docker system df lines become sizes in bytes', () => {
  const text = [
    '{"Active":"30","Reclaimable":"18.38GB (71%)","Size":"25.62GB","TotalCount":"157","Type":"Images"}',
    '{"Active":"14","Reclaimable":"43.21MB (65%)","Size":"66.02MB","TotalCount":"53","Type":"Containers"}',
    '{"Active":"22","Reclaimable":"1.675GB (37%)","Size":"4.458GB","TotalCount":"44","Type":"Local Volumes"}',
    '{"Active":"0","Reclaimable":"10.69GB","Size":"10.69GB","TotalCount":"1001","Type":"Build Cache"}',
  ].join('\n');
  const u = cleanup.parseDiskUsage(text);
  assert.deepStrictEqual(u.images, { total: 157, active: 30, size: 25.62e9, reclaimable: 18.38e9 });
  assert.strictEqual(u.volumes.reclaimable, 1.675e9);
  assert.strictEqual(u.build.total, 1001);
  assert.deepStrictEqual(cleanup.parseDiskUsage('').containers, { total: 0, active: 0, size: 0, reclaimable: 0 });
});

test('unused volumes: only ones with no container, with their maker, biggest first', () => {
  const list = cleanup.parseUnusedVolumes({
    Volumes: [
      { Name: 'envhub-old-mysql-data', Links: '0', Size: '210MB', Labels: 'com.envhub.managed=true,com.envhub.project=old' },
      { Name: 'shop_db', Links: '0', Size: '1.2GB', Labels: 'com.docker.compose.project=shop,com.docker.compose.volume=db' },
      { Name: 'in-use', Links: '1', Size: '5GB', Labels: '' },
      { Name: 'fcad15cdda8d', Links: '0', Size: '0B', Labels: 'com.docker.volume.anonymous=' },
      { Name: 'bad name', Links: '0', Size: '1MB', Labels: '' },
    ],
  });
  assert.deepStrictEqual(list.map((v) => v.name), ['shop_db', 'envhub-old-mysql-data', 'fcad15cdda8d']);
  assert.deepStrictEqual(list[0].owner, { kind: 'compose', project: 'shop' });
  assert.deepStrictEqual(list[1].owner, { kind: 'app', project: 'old', prefix: 'envhub', current: true });
  assert.strictEqual(list[2].owner.kind, 'anonymous');
  assert.strictEqual(cleanup.volumeOwner({ 'com.otherprefix.managed': 'true', 'com.otherprefix.project': 'x' }).current, false);
});

test('prune runs only fixed commands and reads the freed space', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'version') return { ok: true, stdout: '27.4.0\n', stderr: '' };
    if (args[0] === 'builder') return { ok: true, stdout: 'ID\tRECLAIMABLE\nabc\ttrue\nTotal:\t10.69GB\n', stderr: '' };
    return { ok: true, stdout: 'Deleted Images:\nTotal reclaimed space: 1.5GB\n', stderr: '' };
  };
  assert.strictEqual((await cleanup.prune('build', run)).reclaimed, 10.69e9);
  assert.strictEqual((await cleanup.prune('dangling', run)).reclaimed, 1.5e9);
  await cleanup.prune('volumes', run);
  assert.deepStrictEqual(calls.at(-1), ['volume', 'prune', '-f'], 'no -a: named volumes are never pruned');
  await assert.rejects(() => cleanup.prune('everything', run), /Unknown cleanup/);
});

test('volume prune is refused on Docker before 23 (it removed named volumes there)', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    return { ok: true, stdout: '20.10.24\n', stderr: '' };
  };
  await assert.rejects(() => cleanup.prune('volumes', run), /older than version 23/);
  assert.ok(!calls.some((a) => a[0] === 'volume'));
});

test('removeVolumes checks names, never forces, and reports each failure', async () => {
  const run = async (args) => (args[2] === 'busy'
    ? { ok: false, stdout: '', stderr: 'Error response from daemon: remove busy: volume is in use\n' }
    : { ok: true, stdout: '', stderr: '' });
  const res = await cleanup.removeVolumes(['old-data', 'busy'], run);
  assert.deepStrictEqual(res.removed, ['old-data']);
  assert.match(res.failed[0].error, /in use/);
  await assert.rejects(() => cleanup.removeVolumes(['ok', '-f'], run), /Invalid volume/);
  await assert.rejects(() => cleanup.removeVolumes([], run), /Invalid volume/);
});
