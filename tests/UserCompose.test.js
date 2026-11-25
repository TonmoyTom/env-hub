'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const uc = require('../main/compose/user-compose');

// Shaped like `docker compose config --format json`.
const CONFIG = {
  services: {
    php_fpm: { build: { context: '/x' }, ports: [] },
    web: {
      image: 'nginx:1.27',
      ports: [
        { target: 80, published: '8099', protocol: 'tcp' },
        { target: 5173, published: '5173', host_ip: '127.0.0.1', protocol: 'tcp' },
        { target: 9000, published: '9000-9005', protocol: 'tcp' },
        { target: 53, published: '5353', protocol: 'udp' },
      ],
    },
    db: { image: 'mysql:8.4', container_name: 'mydb' },
    worker: { image: 'alpine', deploy: { replicas: 3 } },
  },
};

test('the compose config becomes the services the app knows, with safe names', () => {
  const sum = uc.summarizeComposeConfig(CONFIG, 'shop');
  assert.deepStrictEqual(sum.services.map((s) => [s.name, s.composeName]), [['db', 'db'], ['php-fpm', 'php_fpm'], ['web', 'web'], ['worker', 'worker']]);
  const php = sum.services.find((s) => s.name === 'php-fpm');
  assert.strictEqual(php.build, true);
  assert.strictEqual(php.image, 'envhub-shop-php_fpm', 'the image name Compose gives a built service');
  const web = sum.services.find((s) => s.name === 'web');
  assert.deepStrictEqual(web.ports, [{ host: 8099, container: 80, lan: true }, { host: 5173, container: 5173, lan: false }], 'ranges and udp are left out');
  assert.strictEqual(sum.webService, 'web');
  assert.strictEqual(sum.webPort, 80);
  assert.match(sum.warnings[0], /worker runs 3 copies/);
  assert.throws(() => uc.summarizeComposeConfig({ services: {} }, 'shop'), /no services/);
});

test('aliases never clash and always start with a letter', () => {
  const used = new Set();
  assert.strictEqual(uc.aliasFor('my_app', used), 'my-app');
  assert.strictEqual(uc.aliasFor('my.app', used), 'my-app-2');
  assert.strictEqual(uc.aliasFor('1worker', used), 's-1worker');
  assert.strictEqual(uc.aliasFor('API', used), 'api');
});

test('the override adds only labels and container names, keyed by the real service name', () => {
  const sum = uc.summarizeComposeConfig(CONFIG, 'shop');
  const o = uc.overrideFor('shop', sum.services);
  assert.deepStrictEqual(Object.keys(o.services).sort(), ['db', 'php_fpm', 'web', 'worker']);
  assert.deepStrictEqual(o.services.php_fpm, {
    labels: { 'com.envhub.managed': 'true', 'com.envhub.project': 'shop', 'com.envhub.service': 'php-fpm', 'com.envhub.stack': 'compose' },
    container_name: 'envhub-shop-php-fpm',
  });
  assert.ok(!('container_name' in o.services.worker), 'scaled copies cannot share one name');
  assert.deepStrictEqual(Object.keys(o.services.web).sort(), ['container_name', 'labels'], 'no ports, images or commands are changed');
});

test('compose file names: found in Compose order, and never a path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  try {
    assert.strictEqual(uc.findComposeFile(dir), null);
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    assert.strictEqual(uc.findComposeFile(dir), 'docker-compose.yml');
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
    assert.strictEqual(uc.findComposeFile(dir), 'compose.yaml');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => uc.assertComposeFileName('../other/docker-compose.yml'), /Invalid compose file/);
  assert.throws(() => uc.assertComposeFileName('compose.json'), /Invalid compose file/);
  const spec = { name: 'shop', folder: path.resolve('/projects/shop'), composeFile: 'compose.yaml' };
  assert.deepStrictEqual(uc.composeArgsFor(spec, '/data/override.json'), ['compose', '-f', path.join(spec.folder, 'compose.yaml'), '-f', '/data/override.json', '-p', 'envhub-shop']);
});

test('readComposeConfig asks Docker Compose and reports a broken file clearly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-'));
  try {
    fs.writeFileSync(path.join(dir, 'compose.yaml'), 'services: {}\n');
    const spec = { name: 'shop', folder: dir, composeFile: 'compose.yaml' };
    const ok = await uc.readComposeConfig(spec, async (args) => {
      assert.deepStrictEqual(args.slice(-3), ['config', '--format', 'json']);
      return { ok: true, stdout: JSON.stringify(CONFIG), stderr: '' };
    });
    assert.strictEqual(ok.services.length, 4);
    await assert.rejects(
      () => uc.readComposeConfig(spec, async () => ({ ok: false, stdout: '', stderr: 'yaml: line 3: mapping values are not allowed here\n' })),
      /could not read compose.yaml: yaml: line 3/,
    );
    await assert.rejects(() => uc.readComposeConfig({ ...spec, composeFile: 'docker-compose.yml' }, async () => ({ ok: true })), /is not in/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
