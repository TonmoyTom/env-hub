'use strict';

const { NAME_RE, IMAGE_RE } = require('../compose/generate');
const { normalizeNodeOptions, optionServices } = require('./node');
const { languageCommand, languageOf } = require('./languages');
const { databaseEnv } = require('./python-frameworks');
const { dbNameOf, dbUserOf } = require('./services');

// A stack made from any image on Docker Hub (python:3.12, golang:1.23, ruby:3.3, oven/bun...).
// The project folder is mounted into the container, and the user chooses the image,
// the port the app listens on, and an optional start command.
const WORK_DIR = '/app';
const MAX_COMMAND = 1000;
// Used when the user leaves the port empty. The app gets it as the PORT variable, and the
// computer side port is moved to a free one at start if this one is taken.
const AUTO_PORT = 8000;

function cleanCommand(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > MAX_COMMAND || value.includes('\0')) {
    throw new Error('Invalid command');
  }
  return value.trim();
}

// Checks the user's input and returns the clean fields. Throws on anything wrong.
function normalizeDockerInput({ image, containerPort, command }) {
  if (typeof image !== 'string' || !IMAGE_RE.test(image.trim())) {
    throw new Error('Invalid image: use a Docker Hub name like python:3.12');
  }
  const empty = containerPort === undefined || containerPort === null || String(containerPort).trim() === '';
  const port = empty ? AUTO_PORT : Number(containerPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port: use a whole number from 1 to 65535');
  }
  return { image: image.trim(), containerPort: port, command: cleanCommand(command) };
}

// Ports under 1024 need special rights on some computers, so they are shown on a higher port.
function hostPortFor(containerPort) {
  return containerPort >= 1024 ? containerPort : containerPort + 8000;
}

// "Keep installed packages": a Docker volume holds what the language installs, so it survives a new container.
// One rule per language (picked by the image name). `env` points the tools at the volume, `volumes` are the mounts.
// The same list of names is in renderer/app.js (PACKAGE_LANGUAGES), to show the check box.
const PYTHON_PATH = '/pkgs/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin';
const PACKAGE_RULES = [
  // pip and python use /pkgs/lib/python3.X, so any Python version works.
  { key: 'python', label: 'Python', match: /^python(:|$)/, env: { PYTHONUSERBASE: '/pkgs', PIP_USER: '1', PATH: PYTHON_PATH }, volumes: [{ name: 'packages', target: '/pkgs' }] },
  { key: 'node', label: 'Node.js', match: /^node(:|$)/, env: {}, volumes: [{ name: 'node-modules', target: '/app/node_modules' }] },
  { key: 'go', label: 'Go', match: /^golang(:|$)/, env: { GOCACHE: '/go/cache' }, volumes: [{ name: 'go', target: '/go' }] },
  // The cargo tools live in /usr/local/cargo/bin, so only the registry and the build folder are kept.
  { key: 'rust', label: 'Rust', match: /^rust(:|$)/, env: { CARGO_TARGET_DIR: '/cache/target' }, volumes: [{ name: 'registry', target: '/usr/local/cargo/registry' }, { name: 'target', target: '/cache' }] },
  { key: 'maven', label: 'Java (Maven)', match: /^maven(:|$)/, env: {}, volumes: [{ name: 'm2', target: '/root/.m2' }] },
  { key: 'ruby', label: 'Ruby', match: /^ruby(:|$)/, env: {}, volumes: [{ name: 'gems', target: '/usr/local/bundle' }] },
];

// The rule for an image, or null when there is none (then there is nothing to keep).
function packageRule(image) {
  const name = String(image || '').trim();
  return PACKAGE_RULES.find((rule) => rule.match.test(name)) || null;
}

function dockerProject({ name, folder, dbPassword, appPassword, dbName, dbUser, options, image, containerPort, command, versions, keepPackages }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
  const input = normalizeDockerInput({ image, containerPort, command });
  const opts = normalizeNodeOptions(options);
  const password = String(dbPassword || '');

  const app = {
    name: 'app',
    image: input.image,
    ports: [{ host: hostPortFor(input.containerPort), container: input.containerPort }],
    // Many apps (Node, Rails, Go...) listen on the PORT variable when it is set.
    env: {
      PORT: String(input.containerPort),
      ...databaseEnv(opts, {
        name: dbNameOf({ dbName }),
        user: dbUserOf({ dbUser }),
        password: appPassword || password,
        rootPassword: password,
      }),
    },
    workingDir: WORK_DIR,
    volumes: [{ source: folder, target: WORK_DIR }],
    keepOpen: true,
  };
  const rule = keepPackages === true ? packageRule(input.image) : null;
  if (rule) {
    Object.assign(app.env, rule.env);
    app.dataVolumes = rule.volumes.map((v) => ({ ...v }));
  }
  // A known language gets its own start command when the user left the command empty.
  // Python packages are installed first (the starter requirements.txt is only a comment, so this is quick).
  const lang = languageOf(input.image);
  const startCommand = input.command || (lang && lang.key === 'python'
    ? `pip install --no-cache-dir -r requirements.txt && ${languageCommand(input.image)}`
    : languageCommand(input.image));
  if (startCommand) {
    app.command = ['sh', '-c', startCommand];
  }

  return {
    name,
    stack: 'docker',
    image: input.image,
    containerPort: input.containerPort,
    services: [app, ...optionServices(opts, password, versions)],
  };
}

module.exports = { dockerProject, packageRule, normalizeDockerInput, hostPortFor, WORK_DIR, AUTO_PORT };
