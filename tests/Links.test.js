'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { buildLinks, commandText } = require('../main/stacks/links');
const { buildProject } = require('../main/stacks');
const { portsOf } = require('../main/network/ports');

const folder = path.join(os.tmpdir(), 'envhub-test-links');

test('a command is shown the way it would be typed', () => {
  assert.equal(commandText(['sh', '-c', 'npm install && npm run dev']), 'sh -c "npm install && npm run dev"');
  assert.equal(commandText(['server', '/data', '--console-address', ':9001']), 'server /data --console-address :9001');
  assert.equal(commandText(['echo', 'say "hi"']), 'echo "say \\"hi\\""');
  assert.equal(commandText(undefined), '');
});

test('every service gets its web addresses, shell command and container name', () => {
  const config = buildProject(
    { name: 'api', stack: 'nestjs', nodeVersion: '22', folder, options: { redis: true }, extraServices: [{ name: 'minio', image: 'minio/minio:latest', ports: [9000], env: {}, command: ['server', '/data'] }] },
    'x',
  );
  const links = buildLinks({ name: 'api', config, ports: portsOf(config), composeFile: '/data/projects/api/compose.json', running: true });

  assert.equal(links.running, true);
  assert.deepEqual(links.services.map((s) => s.name), ['node', 'redis', 'minio']);

  const node = links.services[0];
  assert.equal(node.container, 'envhub-api-node');
  assert.equal(node.shell, 'docker exec -it envhub-api-node sh');
  assert.deepEqual(node.ports, [{ container: 3000, host: 3000, url: 'http://localhost:3000', lanUrls: [] }]);
  assert.match(node.command, /^sh -c "npm install/);

  const minio = links.services[2];
  assert.equal(minio.command, 'server /data');
  assert.deepEqual(minio.ports.map((p) => p.url), ['http://localhost:9000']);
});

test('the project commands use the compose file and the envhub project name', () => {
  const config = buildProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder, options: {} }, 'x');
  const links = buildLinks({ name: 'api', config, ports: [], composeFile: 'C:\\Users\\tom\\AppData\\envhub\\projects\\api\\compose.json' });

  assert.equal(links.running, false);
  const logs = links.commands.find((c) => c.label === 'Show the logs live');
  assert.equal(logs.text, 'docker compose -f "C:\\Users\\tom\\AppData\\envhub\\projects\\api\\compose.json" -p envhub-api logs -f');
  assert.ok(links.commands.some((c) => c.text === 'docker ps --filter label=com.envhub.project=api'));
});

test('a service without ports has an empty list', () => {
  const config = buildProject({ name: 'api', stack: 'nestjs', nodeVersion: '22', folder, options: { postgres: true } }, 'x');
  const links = buildLinks({ name: 'api', config, ports: portsOf(config).filter((p) => p.service === 'node'), composeFile: '/c.json' });
  assert.deepEqual(links.services.find((s) => s.name === 'postgres').ports, []);
});
