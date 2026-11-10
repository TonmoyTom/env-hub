'use strict';

const net = require('net');

const HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 500;

// True when something already accepts connections on this port.
// Docker Desktop and other programs often listen on 0.0.0.0, and a plain bind test on 127.0.0.1
// can miss that on Windows. A connect test catches it without opening the firewall.
//
// A connection to a free port can connect to itself: if the system picks the same number for
// the client's own port, TCP joins the socket to itself and "connect" fires with no server.
// Windows hands out client ports in order, so probing ports one by one in that range does it
// every time. Such a connection means nobody is listening.
// `sourcePort` forces the client port and exists only so a test can cause that case.
function isListening(port, sourcePort) {
  return new Promise((resolve) => {
    const options = { port, host: HOST };
    if (sourcePort) options.localPort = sourcePort;

    const socket = net.connect(options);
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    }

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(socket.localPort !== port));
    socket.once('timeout', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

// True when nothing is using the port on localhost.
async function isPortFree(port) {
  if (await isListening(port)) return false;
  return canBind(port);
}

// Finds the first free port starting at `start`, skipping any in `taken`.
// Windows reserves blocks of 100 ports (Hyper-V, Docker Desktop), often several in a row,
// and binding inside a block fails. The scan is wide enough to get past a few of them.
async function findFreePort(start, taken = new Set(), maxTries = 1000) {
  for (let port = start; port < start + maxTries && port <= 65535; port += 1) {
    if (taken.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found from ${start} to ${Math.min(start + maxTries - 1, 65535)}`);
}

// Flat list of host port mappings for a project config.
function portsOf(project) {
  const list = [];
  for (const svc of project.services) {
    for (const p of svc.ports || []) {
      list.push({ service: svc.name, container: p.container, host: p.host });
    }
  }
  return list;
}

// Returns a copy of the project with busy host ports moved to free ones.
// `reserved` holds ports that must not be used (other ProjectDockHub projects, other Docker containers).
// `changed` lists each port that was moved, so the UI can tell the user.
// `owned` holds host ports this project's own running containers already use. They are not
// busy for this project, so applying a change to a running project keeps its URLs.
async function resolveHostPorts(project, reserved = new Set(), owned = new Set()) {
  const taken = new Set(reserved);
  const changed = [];
  const services = [];

  for (const svc of project.services) {
    const ports = [];
    for (const p of svc.ports || []) {
      let host = p.host;
      if (taken.has(host) || (!owned.has(host) && !(await isPortFree(host)))) {
        const actual = await findFreePort(host + 1, taken);
        changed.push({ service: svc.name, wanted: host, actual });
        host = actual;
      }
      taken.add(host);
      ports.push({ ...p, host });
    }
    services.push({ ...svc, ports });
  }

  return { project: { ...project, services }, changed };
}

function savedKey(service, container) {
  return `${service}:${container}`;
}

// Ports chosen on an earlier start, as { "nginx:80": 8081 }.
function toSavedPorts(list) {
  const saved = {};
  for (const p of list) {
    saved[savedKey(p.service, p.container)] = p.host;
  }
  return saved;
}

// Returns a copy of the project that prefers the ports saved on an earlier start,
// so a project keeps the same URL every time unless that port is taken.
function applySavedPorts(project, saved) {
  if (!saved || typeof saved !== 'object') return project;

  const services = project.services.map((svc) => {
    if (!svc.ports) return svc;
    const ports = svc.ports.map((p) => {
      const host = saved[savedKey(svc.name, p.container)];
      const valid = Number.isInteger(host) && host >= 1 && host <= 65535;
      return valid ? { ...p, host } : p;
    });
    return { ...svc, ports };
  });

  return { ...project, services };
}

module.exports = {
  isListening,
  isPortFree,
  findFreePort,
  resolveHostPorts,
  portsOf,
  toSavedPorts,
  applySavedPorts,
};
