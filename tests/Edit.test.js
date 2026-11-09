'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { normalizeExtraServices } = require('../main/stacks/extras');
const { describeForEdit, applyServiceEdit, diffServices, isEditable } = require('../main/stacks/edit');
const { buildProject } = require('../main/stacks');
const { validateProject } = require('../main/compose/generate');
const { resolveHostPorts } = require('../main/network/ports');
const projects = require('../main/store/projects');

const folder = path.join(os.tmpdir(), 'envhub-test-edit');
const names = (spec) => buildProject(spec, 'x').services.map((s) => s.name);

function nestSpec(extra = {}) {
  return { name: 'api', stack: 'nestjs', nodeVersion: '22', folder, options: { mysql: true }, ...extra };
}

test('an extra service keeps its name when another one is removed', () => {
  const previous = normalizeExtraServices([
    { image: 'acme/queue:1' },
    { image: 'other/queue:2' },
  ]);
  assert.deepEqual(previous.map((p) => p.name), ['queue', 'queue-2']);

  const next = normalizeExtraServices([{ ...previous[1], ports: '', env: '', command: '' }], previous);
  assert.deepEqual(next.map((p) => p.name), ['queue-2']);
});

test('a new extra service never takes a name that is kept', () => {
  const previous = normalizeExtraServices([{ image: 'acme/queue:1' }]);
  const next = normalizeExtraServices(
    [{ image: 'other/queue:2' }, { name: 'queue', image: 'acme/queue:1' }],
    previous,
  );
  assert.deepEqual(next.map((p) => p.name), ['queue-2', 'queue']);
});

test('a name the project never had is ignored', () => {
  const next = normalizeExtraServices([{ name: 'mysql', image: 'acme/queue:1' }, { name: 'sneaky', image: 'acme/cache:1' }], []);
  assert.deepEqual(next.map((p) => p.name), ['queue', 'cache']);
});

test('adding and removing services changes the built project', () => {
  const spec = nestSpec();
  assert.deepEqual(names(spec), ['node', 'mysql']);

  const added = applyServiceEdit(spec, { options: { mysql: true, redis: true, mailpit: true } });
  assert.deepEqual(names(added), ['node', 'mysql', 'redis', 'mailpit']);

  const removed = applyServiceEdit(added, { options: { redis: true } });
  assert.deepEqual(names(removed), ['node', 'redis']);
});

test('the edit does not change the spec it started from', () => {
  const spec = nestSpec();
  applyServiceEdit(spec, { options: { redis: true }, extraServices: [{ image: 'rabbitmq:3', ports: '5672' }] });
  assert.deepEqual(spec.options, { mysql: true });
  assert.equal(spec.extraServices, undefined);
});

test('a bad combination of services is refused', () => {
  assert.throws(
    () => applyServiceEdit(nestSpec(), { options: { phpmyadmin: true } }),
    /phpMyAdmin needs MySQL/,
  );
  assert.throws(
    () => applyServiceEdit(nestSpec(), { options: { adminer: true } }),
    /Adminer needs MySQL or PostgreSQL/,
  );
});

test('a bad extra service is refused', () => {
  assert.throws(() => applyServiceEdit(nestSpec(), { extraServices: [{ image: 'Bad Image!' }] }), /Invalid image/);
  assert.throws(() => applyServiceEdit(nestSpec(), { extraServices: [{ image: 'redis:7', ports: '99999' }] }), /Invalid port/);
  assert.throws(() => applyServiceEdit(nestSpec(), 'nope'), /Invalid input/);
});

test('only the keys of the stack are kept', () => {
  const edited = applyServiceEdit(nestSpec(), { options: { mysql: true, node: true, evil: true } });
  assert.deepEqual(Object.keys(edited.options).sort(), [
    'adminer', 'mailpit', 'mongodb', 'mysql', 'phpmyadmin', 'postgres', 'redis',
  ]);
});

test('what the form leaves out stays as it is', () => {
  const spec = nestSpec({ extraServices: normalizeExtraServices([{ image: 'rabbitmq:3', ports: '5672' }]) });
  const edited = applyServiceEdit(spec, { options: { redis: true } });
  assert.deepEqual(edited.extraServices, spec.extraServices);

  const same = applyServiceEdit(spec, {});
  assert.deepEqual(same.options, describeForEdit(spec).options);
  assert.deepEqual(same.extraServices, spec.extraServices);
});

test('removing every extra service removes the field', () => {
  const spec = nestSpec({ extraServices: normalizeExtraServices([{ image: 'rabbitmq:3' }]) });
  const edited = applyServiceEdit(spec, { extraServices: [] });
  assert.equal(edited.extraServices, undefined);
});

test('a laravel project saved without options shows the old defaults', () => {
  const details = describeForEdit({ name: 'shop', stack: 'laravel', phpVersion: '8.3', folder });
  assert.deepEqual(details.options, { mysql: true, redis: true, phpmyadmin: false, node: false, mailpit: true });
  assert.ok(details.optionKeys.includes('node'));
  assert.ok(!details.optionKeys.includes('postgres'));
});

test('a laravel edit builds a valid project', () => {
  const spec = { name: 'shop', stack: 'laravel', phpVersion: '8.3', folder };
  const edited = applyServiceEdit(spec, { options: { mysql: true, redis: false, phpmyadmin: true, node: true, mailpit: false } });
  assert.deepEqual(names(edited), ['nginx', 'php', 'mysql', 'phpmyadmin', 'node']);
  validateProject(buildProject(edited, 'x'));
});

test('the form text of an extra service goes back in unchanged', () => {
  const spec = nestSpec({
    extraServices: normalizeExtraServices([
      { image: 'minio/minio:latest', ports: '9000,9001', env: 'MINIO_ROOT_USER=a\nMINIO_ROOT_PASSWORD=b=c', command: 'server /data --console-address :9001' },
    ]),
  });
  const details = describeForEdit(spec);
  assert.equal(details.extras[0].ports, '9000,9001');
  assert.equal(details.extras[0].env, 'MINIO_ROOT_USER=a\nMINIO_ROOT_PASSWORD=b=c');

  const again = applyServiceEdit(spec, { options: details.options, extraServices: details.extras });
  assert.deepEqual(again.extraServices, spec.extraServices);
});

test('the demo project and unknown stacks cannot be edited', () => {
  const demo = { name: 'demo', stack: 'custom', services: [] };
  assert.equal(isEditable(demo), false);
  assert.throws(() => describeForEdit(demo), /cannot be edited/);
  assert.throws(() => applyServiceEdit(demo, {}), /cannot be edited/);
});

test('a docker image project can be edited too', () => {
  const spec = { name: 'tool', stack: 'docker', image: 'python:3.12', containerPort: 8000, folder, options: {} };
  const edited = applyServiceEdit(spec, { options: { postgres: true } });
  assert.deepEqual(names(edited), ['app', 'postgres']);
});

test('diffServices lists added, removed and changed services', () => {
  const before = buildProject(nestSpec({ extraServices: normalizeExtraServices([{ image: 'rabbitmq:3' }]) }), 'x');
  const afterSpec = applyServiceEdit(nestSpec({ extraServices: normalizeExtraServices([{ image: 'rabbitmq:3' }]) }), {
    options: { redis: true },
    extraServices: [{ name: 'rabbitmq', image: 'rabbitmq:4' }],
  });
  const diff = diffServices(before, buildProject(afterSpec, 'x'));
  assert.deepEqual(diff, { added: ['redis'], removed: ['mysql'], changed: ['rabbitmq'] });
});

test('updateSpec changes fields, drops undefined ones and survives a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-edit-store-'));
  projects.init(dir);
  projects.addSpec(nestSpec({ extraServices: [{ name: 'x', image: 'a/x:1', ports: [], env: {}, command: [] }] }));
  projects.setHostPorts('api', { 'node:3000': 3001 });

  const next = projects.updateSpec('api', { options: { redis: true }, extraServices: undefined });
  assert.deepEqual(next.options, { redis: true });
  assert.equal('extraServices' in next, false);

  projects.init(dir);
  const saved = projects.getSpec('api');
  assert.deepEqual(saved.options, { redis: true });
  assert.equal(saved.extraServices, undefined);
  assert.deepEqual(saved.hostPorts, { 'node:3000': 3001 });
  assert.equal(projects.updateSpec('missing', {}), null);
});

test('resolveHostPorts keeps a port the project itself holds', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const project = { name: 'api', services: [{ name: 'node', image: 'node:22', ports: [{ host: port, container: 3000 }] }] };

    const moved = await resolveHostPorts(project, new Set());
    assert.equal(moved.changed.length, 1);

    const kept = await resolveHostPorts(project, new Set(), new Set([port]));
    assert.deepEqual(kept.changed, []);
    assert.equal(kept.project.services[0].ports[0].host, port);

    // Another project's port stays off limits, even when it is listed as owned.
    const reserved = await resolveHostPorts(project, new Set([port]), new Set([port]));
    assert.equal(reserved.changed.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
