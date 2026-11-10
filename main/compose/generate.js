'use strict';

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const IMAGE_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]{1,128})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const DOCKERFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)[^\r\n\0]{1,500}$/;
const { USER_ENV } = require('../docker/hostuser');
const VOLUME_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const TARGET_RE = /^\/[A-Za-z0-9._/-]{0,200}$/;
const STACKS = ['laravel', 'node', 'nextjs', 'nestjs', 'vue', 'nuxt', 'docker', 'fastapi', 'custom'];
const MAX_SERVICES = 20;
const MAX_ENV_VALUE = 1024;

function assertName(value, label) {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new Error(`Invalid ${label}: use lowercase letters, numbers and dashes, starting with a letter`);
  }
}

function assertPort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid port for ${label}: must be a whole number from 1 to 65535`);
  }
}

function assertPath(value, label) {
  if (typeof value !== 'string' || !PATH_RE.test(value)) {
    throw new Error(`Invalid path for ${label}`);
  }
}

// Throws on any invalid field. Returns nothing.
function validateProject(project) {
  if (!project || typeof project !== 'object') {
    throw new Error('Project config must be an object');
  }

  assertName(project.name, 'project name');

  if (project.stack !== undefined && !STACKS.includes(project.stack)) {
    throw new Error(`Invalid stack: ${project.stack}`);
  }

  if (!Array.isArray(project.services) || project.services.length === 0) {
    throw new Error('A project needs at least one service');
  }
  if (project.services.length > MAX_SERVICES) {
    throw new Error(`A project can have at most ${MAX_SERVICES} services`);
  }

  const seen = new Set();
  for (const svc of project.services) {
    if (!svc || typeof svc !== 'object') {
      throw new Error('Each service must be an object');
    }

    assertName(svc.name, 'service name');
    if (seen.has(svc.name)) {
      throw new Error(`Duplicate service name: ${svc.name}`);
    }
    seen.add(svc.name);

    if (typeof svc.image !== 'string' || !IMAGE_RE.test(svc.image)) {
      throw new Error(`Invalid image for service ${svc.name}`);
    }

    if (svc.ports !== undefined) {
      if (!Array.isArray(svc.ports)) {
        throw new Error(`Ports for service ${svc.name} must be a list`);
      }
      for (const port of svc.ports) {
        assertPort(port && port.host, `service ${svc.name} host`);
        assertPort(port && port.container, `service ${svc.name} container`);
        if (port.lan !== undefined && typeof port.lan !== 'boolean') {
          throw new Error(`lan for service ${svc.name} must be true or false`);
        }
      }
    }

    if (svc.env !== undefined) {
      if (typeof svc.env !== 'object' || Array.isArray(svc.env)) {
        throw new Error(`Env for service ${svc.name} must be an object`);
      }
      for (const [key, value] of Object.entries(svc.env)) {
        if (!ENV_KEY_RE.test(key)) {
          throw new Error(`Invalid env key in service ${svc.name}: ${key}`);
        }
        if (typeof value !== 'string' || value.length > MAX_ENV_VALUE) {
          throw new Error(`Env value for ${key} must be a string under ${MAX_ENV_VALUE} characters`);
        }
      }
    }

    if (svc.user !== undefined && (typeof svc.user !== 'string' || !/^\d{1,10}:\d{1,10}$/.test(svc.user))) {
      throw new Error(`Invalid user for service ${svc.name}`);
    }

    if (svc.build !== undefined) {
      if (!svc.build || typeof svc.build !== 'object') {
        throw new Error(`Build for service ${svc.name} must be an object`);
      }
      assertPath(svc.build.context, `build context of ${svc.name}`);
      if (svc.build.dockerfile !== undefined && !DOCKERFILE_RE.test(svc.build.dockerfile)) {
        throw new Error(`Invalid Dockerfile name for service ${svc.name}`);
      }
    }

    if (svc.volumes !== undefined) {
      if (!Array.isArray(svc.volumes)) {
        throw new Error(`Volumes for service ${svc.name} must be a list`);
      }
      for (const v of svc.volumes) {
        assertPath(v && v.source, `volume source of ${svc.name}`);
        if (typeof v.target !== 'string' || !TARGET_RE.test(v.target)) {
          throw new Error(`Invalid volume target in service ${svc.name}`);
        }
      }
    }

    if (svc.dataVolumes !== undefined) {
      if (!Array.isArray(svc.dataVolumes)) {
        throw new Error(`Data volumes for service ${svc.name} must be a list`);
      }
      for (const v of svc.dataVolumes) {
        if (!v || typeof v.name !== 'string' || !VOLUME_NAME_RE.test(v.name)) {
          throw new Error(`Invalid data volume name in service ${svc.name}`);
        }
        if (typeof v.target !== 'string' || !TARGET_RE.test(v.target)) {
          throw new Error(`Invalid data volume target in service ${svc.name}`);
        }
      }
    }

    if (svc.workingDir !== undefined && (typeof svc.workingDir !== 'string' || !TARGET_RE.test(svc.workingDir))) {
      throw new Error(`Invalid working directory for service ${svc.name}`);
    }

    if (svc.keepOpen !== undefined && typeof svc.keepOpen !== 'boolean') {
      throw new Error(`keepOpen for service ${svc.name} must be true or false`);
    }

    if (svc.command !== undefined) {
      const bad = !Array.isArray(svc.command)
        || svc.command.length === 0
        || svc.command.length > 20
        || svc.command.some((a) => typeof a !== 'string' || a.length > 1000 || a.includes('\0'));
      if (bad) {
        throw new Error(`Invalid command for service ${svc.name}`);
      }
    }
  }
}

// Builds a Compose object from a validated project config.
// Every service gets labels so ProjectDockHub can find and control it later.
// Ports are bound to 127.0.0.1 by default.
function generateCompose(project) {
  validateProject(project);

  const stack = project.stack || 'custom';
  const services = {};
  const volumes = {};

  for (const svc of project.services) {
    const service = {
      image: svc.image,
      container_name: `envhub-${project.name}-${svc.name}`,
      restart: 'unless-stopped',
      labels: {
        'com.envhub.managed': 'true',
        'com.envhub.project': project.name,
        'com.envhub.service': svc.name,
        'com.envhub.stack': stack,
      },
    };

    if (svc.build) {
      service.build = {
        context: svc.build.context,
        dockerfile: svc.build.dockerfile || 'Dockerfile',
      };
    }

    if (svc.ports && svc.ports.length > 0) {
      // Only a port marked `lan` is reachable from other computers. All others stay on this computer.
      service.ports = svc.ports.map((p) => `${p.lan === true ? '0.0.0.0' : '127.0.0.1'}:${p.host}:${p.container}`);
    }

    if (svc.env && Object.keys(svc.env).length > 0) {
      service.environment = { ...svc.env };
    }
    // Linux: run as the user who owns the project folder (see docker/hostuser.js).
    if (svc.user) {
      service.user = svc.user;
      service.environment = { ...USER_ENV, ...(service.environment || {}) };
    }

    const mounts = (svc.volumes || []).map((v) => ({
      type: 'bind',
      source: v.source,
      target: v.target,
    }));

    // Named volumes keep database data when the container is recreated. They are labeled so
    // ProjectDockHub can find and remove them when the project is deleted.
    for (const v of svc.dataVolumes || []) {
      const volumeName = `envhub-${project.name}-${svc.name}-${v.name}`;
      mounts.push({ type: 'volume', source: volumeName, target: v.target });
      volumes[volumeName] = {
        name: volumeName,
        labels: {
          'com.envhub.managed': 'true',
          'com.envhub.project': project.name,
          'com.envhub.service': svc.name,
        },
      };
    }
    if (mounts.length > 0) service.volumes = mounts;

    if (svc.workingDir) {
      service.working_dir = svc.workingDir;
    }

    if (svc.command) {
      service.command = [...svc.command];
    }

    // Like `docker run -it`. Images whose default command is a shell or an interpreter (golang, python,
    // node, ruby) exit at once without it, and would restart in a loop.
    if (svc.keepOpen) {
      service.tty = true;
      service.stdin_open = true;
    }

    services[svc.name] = service;
  }

  const compose = { name: `envhub-${project.name}`, services };
  if (Object.keys(volumes).length > 0) compose.volumes = volumes;
  return compose;
}

// Writes the Compose file into the app data folder. The user never edits it.
// Compose accepts JSON because JSON is valid YAML.
function writeComposeFile(dir, compose) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'compose.json');
  fs.writeFileSync(file, JSON.stringify(compose, null, 2) + '\n', { mode: 0o600 });
  return file;
}

module.exports = { generateCompose, writeComposeFile, validateProject, NAME_RE, IMAGE_RE };
