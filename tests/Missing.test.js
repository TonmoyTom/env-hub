'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missingServices } = require('../main/docker/containers');

test('finds a service whose container was removed', () => {
  const items = [{ service: 'node', state: 'running' }];
  assert.deepEqual(missingServices(items, ['node', 'mongodb']), ['mongodb']);
});

test('nothing is missing when every service has a container', () => {
  const items = [{ service: 'node' }, { service: 'mongodb' }];
  assert.deepEqual(missingServices(items, ['node', 'mongodb']), []);
  assert.deepEqual(missingServices(items, []), []);
});
