'use strict';

const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert/strict');
const { lanAddresses, isPrivateIPv4 } = require('../main/network/lan');
const { generateCompose } = require('../main/compose/generate');
const { buildProject } = require('../main/stacks');
const { applyServiceEdit, describeForEdit } = require('../main/stacks/edit');
const { buildLinks } = require('../main/stacks/links');

const ifaces = {
  'Wi-Fi': [{ family: 'IPv4', address: '192.168.0.23', internal: false }],
  'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
  Ethernet: [{ family: 'IPv4', address: '10.0.0.5', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
  Public: [{ family: 'IPv4', address: '8.8.8.8', internal: false }],
};

test('lanAddresses keeps real private adapters, best first, and skips virtual and public ones', () => {
  assert.deepEqual(lanAddresses(ifaces).map((a) => a.address), ['192.168.0.23', '10.0.0.5']);
});

test('isPrivateIPv4', () => {
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('nope'), false);
});

const spec = (extra = {}) => ({
  name: 'shop', stack: 'nestjs', nodeVersion: '22', folder: '/home/x/shop', options: { mysql: true, phpmyadmin: true }, ...extra,
});

test('without sharing every port stays on 127.0.0.1', () => {
  const compose = generateCompose(buildProject(spec(), 'pw'));
  for (const svc of Object.values(compose.services)) {
    for (const port of svc.ports || []) assert.match(port, /^127\.0\.0\.1:/);
  }
});

test('with sharing only the main web page is on 0.0.0.0', () => {
  const compose = generateCompose(buildProject(spec({ lanShare: true }), 'pw'));
  assert.match(compose.services.node.ports[0], /^0\.0\.0\.0:/);
  assert.match(compose.services.mysql.ports[0], /^127\.0\.0\.1:/);
  assert.match(compose.services.phpmyadmin.ports[0], /^127\.0\.0\.1:/);
});

test('laravel shares nginx', () => {
  const laravel = generateCompose(buildProject({ name: 'l', stack: 'laravel', phpVersion: '8.3', folder: path.resolve('/home/x/l'), options: {}, lanShare: true }, 'pw'));
  assert.match(laravel.services.nginx.ports[0], /^0\.0\.0\.0:/);
});

test('edit: lanShare is saved, kept when missing, and cleared', () => {
  const on = applyServiceEdit(spec(), { lanShare: true });
  assert.equal(on.lanShare, true);
  assert.equal(describeForEdit(on).lanShare, true);
  assert.equal(applyServiceEdit(on, {}).lanShare, true);
  assert.equal(applyServiceEdit(on, { lanShare: false }).lanShare, undefined);
  assert.equal(describeForEdit(spec()).lanShare, false);
});

test('links show the network address only for the shared page', () => {
  const config = buildProject(spec({ lanShare: true }), '');
  const ports = [{ service: 'node', container: 3000, host: 3000 }, { service: 'mysql', container: 3306, host: 3306 }];
  const data = buildLinks({ name: 'shop', config, ports, composeFile: '/c.json', running: true, lan: { enabled: true, service: 'node', addresses: ['192.168.0.23'] } });
  assert.deepEqual(data.services.find((s) => s.name === 'node').ports[0].lanUrls, ['http://192.168.0.23:3000']);
  assert.deepEqual(data.services.find((s) => s.name === 'mysql').ports[0].lanUrls, []);
  assert.equal(data.lanFound, true);
});

test('lanShare is saved by the store and survives a reload', () => {
  const fs = require('fs');
  const os = require('os');
  const store = require('../main/store/projects');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envhub-store-'));
  store.init(dir);
  store.addSpec(spec());
  const next = applyServiceEdit(store.getSpec('shop'), { lanShare: true });
  store.updateSpec('shop', { options: next.options, lanShare: next.lanShare });
  store.init(dir);
  assert.equal(store.getSpec('shop').lanShare, true);
  store.updateSpec('shop', { lanShare: applyServiceEdit(store.getSpec('shop'), { lanShare: false }).lanShare });
  assert.equal('lanShare' in store.getSpec('shop'), false);
});
