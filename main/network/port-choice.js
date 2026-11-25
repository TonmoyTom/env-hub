'use strict';

// Choosing a host port by hand (Settings tab > Ports), for example nginx 8083 -> 8080.
// A port can be used only when nothing else has it:
//   another service of the same project, another ProjectDockHub project (running, or saved for its next
//   start), any Docker container on this computer (running or stopped), or any other program.
// The answer says who has it, so the window can show "8080 is used by tirono-pcm / nginx".

const MIN_PORT = 1;
const MAX_PORT = 65535;

function parsePort(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

// facts:
//   port, service, container   the wanted change
//   ownPorts       [{ service, container, host }] of this project now
//   ownRunning     Set of host ports this project's running containers hold (free for itself)
//   otherProjects  Map host port -> { project, service } of other ProjectDockHub projects
//   dockerOwners   Map host port -> { name, project, running } of Docker containers (this project excluded)
//   isPortFree     async (port) => boolean, the check on this computer
async function checkHostPort(facts) {
  const port = parsePort(facts.port);
  if (port === null) {
    return { ok: false, reason: 'invalid', message: `Use a number from ${MIN_PORT} to ${MAX_PORT}.` };
  }
  const own = facts.ownPorts || [];
  const current = own.find((p) => p.service === facts.service && p.container === facts.container);
  if (!current) return { ok: false, reason: 'unknown', message: 'This service has no such port.' };
  if (current.host === port) return { ok: true, port, same: true, message: `${facts.service} already uses ${port}.` };

  const sibling = own.find((p) => p.host === port && !(p.service === facts.service && p.container === facts.container));
  if (sibling) {
    return { ok: false, port, reason: 'own', message: `${port} is used by ${sibling.service} in this project.` };
  }

  const other = facts.otherProjects && facts.otherProjects.get(port);
  if (other) {
    return { ok: false, port, reason: 'project', usedBy: other, message: `${port} is used by the project ${other.project}${other.service ? ` (${other.service})` : ''}.` };
  }

  const container = facts.dockerOwners && facts.dockerOwners.get(port);
  if (container) {
    const state = container.running ? 'running' : 'stopped';
    return { ok: false, port, reason: 'docker', usedBy: container, message: `${port} is used by the Docker container ${container.name} (${state}).` };
  }

  // This project's own running containers may hold the port (for example after a swap); that is not busy.
  const ownRunning = facts.ownRunning || new Set();
  if (!ownRunning.has(port) && !(await facts.isPortFree(port))) {
    return { ok: false, port, reason: 'busy', message: `${port} is used by another program on this computer.` };
  }

  return { ok: true, port, message: `${port} is free.` };
}

module.exports = { checkHostPort, parsePort };
