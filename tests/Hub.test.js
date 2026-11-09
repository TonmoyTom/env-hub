'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchImages, listTags } = require('../main/docker/hub');

const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('search maps results and puts official images first', async () => {
  const fetchFn = reply({
    results: [
      { repo_name: 'someone/python-app', short_description: 'x', star_count: 900, is_official: false },
      { repo_name: 'python', short_description: 'Python', star_count: 9000, is_official: true },
      { repo_name: 'Bad Name!', star_count: 1 },
    ],
  });
  const list = await searchImages('python', fetchFn);
  assert.deepEqual(list.map((i) => i.name), ['python', 'someone/python-app']);
  assert.equal(list[0].official, true);
});

test('search skips the call for short text and builds a safe URL', async () => {
  let called = null;
  const fetchFn = async (url) => { called = url; return { ok: true, status: 200, json: async () => ({ results: [] }) }; };
  assert.deepEqual(await searchImages('a', fetchFn), []);
  assert.equal(called, null);
  await searchImages('vue js&x=1', fetchFn);
  assert.match(called, /query=vue%20js%26x%3D1&page_size=10$/);
});

test('tags: official images use library/, bad names are refused', async () => {
  let called = null;
  const fetchFn = async (url) => {
    called = url;
    return { ok: true, status: 200, json: async () => ({ results: [{ name: '3.13' }, { name: '3.12-slim' }, { name: 5 }] }) };
  };
  assert.deepEqual(await listTags('python', fetchFn), ['3.13', '3.12-slim']);
  assert.match(called, /repositories\/library\/python\/tags/);
  await listTags('oven/bun', fetchFn);
  assert.match(called, /repositories\/oven\/bun\/tags/);
  await assert.rejects(() => listTags('../etc', fetchFn), /Invalid image name/);
});

test('errors are readable', async () => {
  await assert.rejects(() => searchImages('python', reply({}, 429)), /busy/);
  await assert.rejects(() => searchImages('python', reply({}, 500)), /error \(500\)/);
  await assert.rejects(() => searchImages('python', async () => { throw new Error('x'); }), /Could not reach/);
});

const { imageExists } = require('../main/docker/hub');

test('imageExists: true, false, and unknown', async () => {
  let called = null;
  const status = (code) => async (url) => { called = url; return { ok: code < 400, status: code }; };

  assert.equal(await imageExists('python:3.12', status(200)), true);
  assert.match(called, /repositories\/library\/python\/tags\/3\.12$/);
  assert.equal(await imageExists('oven/bun', status(200)), true);
  assert.match(called, /repositories\/oven\/bun\/tags\/latest$/);
  assert.equal(await imageExists('RabbitMQ', status(404)), false);
  assert.equal(await imageExists('python', status(500)), null);
  assert.equal(await imageExists('python', async () => { throw new Error('offline'); }), null);
  // Other registries are not checked.
  assert.equal(await imageExists('ghcr.io/me/app:1', status(404)), null);
  assert.equal(await imageExists('docker.elastic.co/elasticsearch/elasticsearch:8.15.0', status(404)), null);
  // A name that cannot exist is refused without a request.
  called = null;
  assert.equal(await imageExists('Bad Name!', status(200)), false);
  assert.equal(called, null);
});

const { listVersionTags, fetchVersionLists } = require('../main/docker/hub');

const tagPage = (names, next = null) => ({ results: names.map((name) => ({ name })), next });

test('versions: php keeps only <major.minor>-fpm tags', async () => {
  let called = null;
  const fetchFn = async (url) => {
    called = url;
    return { ok: true, status: 200, json: async () => tagPage(['8.4-fpm', '8.4.1-fpm', '8-fpm', 'fpm', '8.3-fpm', '8.3-fpm-alpine', '8.2-fpm']) };
  };
  assert.deepEqual(await listVersionTags('php', fetchFn), ['8.4', '8.3', '8.2']);
  assert.match(called, /repositories\/library\/php\/tags\?page_size=100&ordering=last_updated&name=-fpm$/);
});

test('versions: node keeps only even majors with -alpine', async () => {
  const fetchFn = reply(tagPage(['25-alpine', '24-alpine', '24.1.0-alpine', '23-alpine', '22-alpine', '22-alpine3.20', '20-alpine']));
  assert.deepEqual(await listVersionTags('node', fetchFn), ['24', '22', '20']);
});

test('versions: database lists take plain numbers only', async () => {
  const names = ['26.10', '26.7', '9.7', '9.7.2', '9.6', '9.1-oraclelinux9', '9.0', '8.4', '8.3', '8.1', 'lts', 'innovation', '8.0', '5.7'];
  assert.deepEqual(await listVersionTags('mysql', reply(tagPage(names))), ['26.10', '26.7', '9.7', '8.4', '8.0']);
  assert.deepEqual(await listVersionTags('postgres', reply(tagPage(['17', '17.2', '16', '16-alpine', 'latest']))), ['17', '16']);
  assert.deepEqual(await listVersionTags('redis', reply(tagPage(['8', '7', '7.4', '7-alpine']))), ['8', '7']);
  assert.deepEqual(await listVersionTags('mongodb', reply(tagPage(['8', '7', '7.0', 'latest']))), ['8', '7']);
});

test('versions: follows next pages, at most 3, and only on Docker Hub', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    const n = urls.length;
    return { ok: true, status: 200, json: async () => tagPage([`${30 - n}`], 'https://hub.docker.com/v2/next-page') };
  };
  assert.deepEqual(await listVersionTags('postgres', fetchFn), ['29', '28', '27']);
  assert.equal(urls.length, 3);
  const evil = async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => tagPage(['17'], 'https://evil.example/x') }; };
  urls.length = 0;
  assert.deepEqual(await listVersionTags('postgres', evil), ['17']);
  assert.equal(urls.length, 1);
});

test('versions: unknown list is refused, Hub errors are readable', async () => {
  await assert.rejects(() => listVersionTags('ruby', reply({})), /Unknown version list/);
  await assert.rejects(() => listVersionTags('php', reply({}, 429)), /busy/);
});

test('fetchVersionLists: a failed or empty list is reported, the others stay', async () => {
  const fetchFn = async (url) => {
    if (url.includes('/library/php/')) return { ok: false, status: 500, json: async () => ({}) };
    if (url.includes('/library/redis/')) return { ok: true, status: 200, json: async () => tagPage(['latest']) };
    return { ok: true, status: 200, json: async () => tagPage(['17', '16', '9.7', '8.4', '8', '7', '24-alpine']) };
  };
  const { lists, errors } = await fetchVersionLists(fetchFn);
  assert.equal(lists.php, undefined);
  assert.equal(lists.redis, undefined);
  assert.deepEqual(lists.postgres, ['17', '16', '8', '7']);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => e.startsWith('php:')));
  assert.ok(errors.some((e) => e.startsWith('redis:')));
});
