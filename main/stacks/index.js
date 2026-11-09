'use strict';

const { laravelProject } = require('./laravel');
const { nodeProject, NODE_STACKS, NODE_STACK_DEFS } = require('./node');
const { dockerProject } = require('./docker');
const { extraServicesOf } = require('./extras');

// Every stack the New project form can create. Laravel and Docker image are special,
// the Node stacks come from NODE_STACK_DEFS in node.js.
const CREATABLE_STACKS = ['laravel', ...NODE_STACKS, 'docker'];

const NAMES = {
  laravel: 'Laravel',
  docker: 'Docker image',
  ...Object.fromEntries(NODE_STACKS.map((key) => [key, NODE_STACK_DEFS[key].label])),
};

// Turns a saved project spec into the full service list. Other stacks pass through unchanged.
function buildProject(spec, dbPassword = '') {
  const project = withLanShare(withRedisPassword(buildStack(spec, dbPassword), spec), spec);
  const extras = extraServicesOf(spec);
  if (extras.length === 0) return project;
  return { ...project, services: [...project.services, ...extras] };
}

// Redis asks for the password on start, when the user set one. Without one it runs as before.
function withRedisPassword(project, spec) {
  if (!spec || !spec.redisPassword || !Array.isArray(project.services)) return project;
  const services = project.services.map((svc) => (svc.name === 'redis'
    ? { ...svc, command: ['redis-server', '--requirepass', spec.redisPassword] }
    : svc));
  return { ...project, services };
}

// "Share on my network": only the project's own web page is published on all network adapters.
// Databases, admin tools and mail pages always stay on 127.0.0.1.
function withLanShare(project, spec) {
  if (!spec || spec.lanShare !== true || !Array.isArray(project.services)) return project;
  const main = mainWebService(spec);
  const services = project.services.map((svc) => (svc.name === main && Array.isArray(svc.ports)
    ? { ...svc, ports: svc.ports.map((port) => ({ ...port, lan: true })) }
    : svc));
  return { ...project, services };
}

function buildStack(spec, dbPassword) {
  if (spec.stack === 'laravel') {
    return laravelProject({ ...spec, dbPassword });
  }
  if (NODE_STACKS.includes(spec.stack)) {
    return nodeProject({ ...spec, dbPassword });
  }
  if (spec.stack === 'docker') {
    return dockerProject({ ...spec, dbPassword, appPassword: spec.dbPassword });
  }
  return spec;
}

// Short text for the project list, e.g. "Laravel · PHP 8.3".
function stackLabel(spec) {
  const name = NAMES[spec.stack] || 'Custom';
  if (spec.stack === 'laravel' && spec.phpVersion) return `${name} · PHP ${spec.phpVersion}`;
  if (NODE_STACKS.includes(spec.stack) && spec.nodeVersion) return `${name} · Node ${spec.nodeVersion}`;
  if (spec.stack === 'docker' && spec.image) return `${name} · ${spec.image}`;
  return name;
}

// The service the Open button shows in the browser.
function mainWebService(spec) {
  if (spec.stack === 'docker') return 'app';
  return NODE_STACKS.includes(spec.stack) ? 'node' : 'nginx';
}

// The container port of that service's web page.
function mainWebPort(spec) {
  if (spec.stack === 'docker') return Number(spec.containerPort);
  if (NODE_STACKS.includes(spec.stack)) return NODE_STACK_DEFS[spec.stack].port;
  return 80;
}

module.exports = { buildProject, stackLabel, mainWebService, mainWebPort, CREATABLE_STACKS };
