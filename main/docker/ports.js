'use strict';

const { runDocker } = require('./exec');

const ID_RE = /^[a-f0-9]{12,64}$/;
const MAX_RANGE = 1000;

// One line per container, fields separated by a tab.
// Stopped containers keep their port bindings in HostConfig, so they are included.
const FORMAT = [
  '{{.Name}}',
  '{{.State.Running}}',
  '{{json .Config.Labels}}',
  '{{json .HostConfig.PortBindings}}',
  '{{json .NetworkSettings.Ports}}',
].join('\t');

function expandHostPort(value) {
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value || '').trim());
  if (!match) return [];

  const first = Number(match[1]);
  const last = match[2] ? Number(match[2]) : first;
  if (first < 1 || last > 65535 || last < first || last - first > MAX_RANGE) return [];

  const ports = [];
  for (let p = first; p <= last; p += 1) ports.push(p);
  return ports;
}

// Input looks like { "80/tcp": [{ "HostIp": "", "HostPort": "8080" }] } or null.
function portsFromBindings(bindings) {
  const ports = [];
  if (!bindings || typeof bindings !== 'object') return ports;

  for (const list of Object.values(bindings)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry && entry.HostPort) ports.push(...expandHostPort(entry.HostPort));
    }
  }
  return ports;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

// Turns `docker inspect --format` output into Map<port, owner>.
// Containers that belong to `excludeProject` are skipped, so a project can restart on its own ports.
function parseInspectOutput(text, excludeProject) {
  const owners = new Map();

  for (const line of String(text || '').split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 5) continue;

    const [rawName, running, rawLabels, rawBindings, rawLive] = fields;
    const labels = parseJson(rawLabels) || {};
    if (excludeProject && labels['com.envhub.project'] === excludeProject) continue;

    const owner = {
      name: rawName.replace(/^\//, ''),
      project: labels['com.docker.compose.project'] || labels['com.envhub.project'] || null,
      running: running.trim() === 'true',
    };

    const ports = [
      ...portsFromBindings(parseJson(rawBindings)),
      ...portsFromBindings(parseJson(rawLive)),
    ];

    for (const port of ports) {
      const existing = owners.get(port);
      // If a running and a stopped container both want a port, report the running one.
      if (!existing || (owner.running && !existing.running)) {
        owners.set(port, owner);
      }
    }
  }

  return owners;
}

// Host ports published by every Docker container on this machine, running or stopped.
// Returns an empty map if Docker cannot be queried. The start itself will report that error.
async function dockerHostPorts(excludeProject) {
  const list = await runDocker(['ps', '-a', '-q']);
  if (!list.ok) return new Map();

  const ids = list.stdout
    .split('\n')
    .map((id) => id.trim())
    .filter((id) => ID_RE.test(id));
  if (ids.length === 0) return new Map();

  // inspect can exit non-zero if a container vanished mid-call, but stdout still has the rest.
  const res = await runDocker(['inspect', '--format', FORMAT, ...ids]);
  return parseInspectOutput(res.stdout, excludeProject);
}

module.exports = { dockerHostPorts, parseInspectOutput };
