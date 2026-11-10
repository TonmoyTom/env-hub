'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSize, parseStatsLines, parseVolumeSizes, shellArgs, openShell } = require('../main/docker/stats');

test('sizes from docker stats and docker system df are read in the right units', () => {
  assert.equal(parseSize('312MiB'), 312 * 1024 * 1024);
  assert.equal(parseSize('7.6GiB'), Math.round(7.6 * 1024 ** 3));
  assert.equal(parseSize('1.4GB', { GB: 1e9 }), 1400000000);
  assert.equal(parseSize('--'), 0);
  assert.equal(parseSize(''), 0);
});

test('stats lines give CPU and memory per service, and ignore broken lines', () => {
  const text = [
    '{"Name":"envhub-shop-api-app","CPUPerc":"12.50%","MemUsage":"312MiB / 7.6GiB","MemPerc":"4.00%"}',
    'not json',
    '{"Name":"envhub-shop-api-mysql","CPUPerc":"--","MemUsage":"0B / 0B","MemPerc":"--"}',
  ].join('\n');
  const rows = parseStatsLines(text, 'shop-api');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].service, 'app');
  assert.equal(rows[0].cpuPercent, 12.5);
  assert.equal(rows[0].memBytes, 312 * 1024 * 1024);
  assert.equal(rows[0].memPercent, 4);
  assert.equal(rows[1].cpuPercent, 0);
});

test('volume sizes are read from the Local Volumes table, only for this project', () => {
  const text = [
    'Images space usage:',
    '',
    'REPOSITORY   TAG   SIZE',
    'php          8.3   500MB',
    '',
    'Local Volumes space usage:',
    '',
    'VOLUME NAME                    LINKS     SIZE',
    'envhub-shop-api-mysql-data     1         1.4GB',
    'envhub-other-mysql-data        1         9GB',
    'envhub-shop-api-redis-data     0         20MB',
    '',
  ].join('\n');
  const volumes = parseVolumeSizes(text, 'shop-api');
  assert.deepEqual(volumes.map((v) => v.name), ['envhub-shop-api-mysql-data', 'envhub-shop-api-redis-data']);
  assert.equal(volumes[0].bytes, 1400000000);
  assert.equal(volumes[1].bytes, 20000000);
});

test('no Local Volumes table gives an empty list', () => {
  assert.deepEqual(parseVolumeSizes('nothing here', 'shop-api'), []);
});

test('a shell is run as an argument list on a checked container name', () => {
  assert.deepEqual(shellArgs('envhub-shop-api-app'), ['exec', '-it', 'envhub-shop-api-app', 'sh']);
});

test('a bad project name or service never reaches docker', async () => {
  await assert.rejects(openShell('Bad Name!', 'app'), /Invalid project name/);
  await assert.rejects(openShell('shop-api', 'app; rm -rf /'), /Unknown service/);
});
