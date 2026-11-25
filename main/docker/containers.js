'use strict';

const { LABELS, MANAGED_FILTER, projectFilter, serviceFilter, composeProject, phpImage, networkName } = require('../naming');
const { runDocker, firstLine } = require('./exec');
const { healthOf } = require('./health');
const { NAME_RE } = require('../compose/generate');

const ID_RE = /^[a-f0-9]{12,64}$/;

function assertProjectName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error('Invalid project name');
  }
}

function parseLabels(text) {
  const labels = {};
  for (const part of String(text || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) {
      labels[part.slice(0, i)] = part.slice(i + 1);
    }
  }
  return labels;
}

// Only ProjectDockHub containers are ever listed or changed.
async function listContainers(projectName) {
  const args = ['ps', '-a', '--filter', MANAGED_FILTER];
  if (projectName !== null && projectName !== undefined) {
    assertProjectName(projectName);
    args.push('--filter', projectFilter(projectName));
  }
  args.push('--format', '{{json .}}');

  const res = await runDocker(args);
  if (!res.ok) {
    throw new Error(firstLine(res.stderr) || 'Could not list containers');
  }

  return res.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const c = JSON.parse(line);
      const labels = parseLabels(c.Labels);
      return {
        id: c.ID,
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        // 'healthy', 'unhealthy', 'starting', or null when the image has no health check.
        health: healthOf(c.Status),
        project: labels[LABELS.project] || null,
        service: labels[LABELS.service] || null,
      };
    });
}

// Returns container ids for one project, found by label.
async function projectContainerIds(projectName, { runningOnly }) {
  assertProjectName(projectName);

  const args = ['ps'];
  if (!runningOnly) {
    args.push('-a');
  }
  args.push('-q', '--filter', MANAGED_FILTER, '--filter', projectFilter(projectName));

  const res = await runDocker(args);
  if (!res.ok) {
    throw new Error(firstLine(res.stderr) || 'Could not find containers');
  }

  return res.stdout
    .split('\n')
    .map((id) => id.trim())
    .filter((id) => ID_RE.test(id));
}

// Last lines of logs for each container in the project. Capped at 500 lines per container.
async function projectLogs(projectName, lines = 500) {
  const ids = await projectContainerIds(projectName, { runningOnly: false });
  const cap = Math.min(Math.max(Number(lines) || 500, 1), 500);
  const chunks = [];

  for (const id of ids) {
    // With timestamps, so the window can put the lines of all containers in time order.
    const res = await runDocker(['logs', '--timestamps', '--tail', String(cap), id]);
    chunks.push(`== ${id.slice(0, 12)} ==\n${res.stdout}${res.stderr}`);
  }

  return chunks.join('\n');
}

// Named data volumes of one project, found by ProjectDockHub labels.
async function projectVolumeNames(projectName) {
  assertProjectName(projectName);
  const res = await runDocker([
    'volume', 'ls', '-q',
    '--filter', MANAGED_FILTER,
    '--filter', projectFilter(projectName),
  ]);
  if (!res.ok) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${composeProject(projectName)}-`));
}

// Services the project should have but that have no container at all (for example after
// `docker rm`). Such a project is not fully running, and Start has to create the container again.
function missingServices(items, expected) {
  const have = new Set(items.map((c) => c.service));
  return expected.filter((service) => !have.has(service));
}

async function stopProject(projectName) {
  const ids = await projectContainerIds(projectName, { runningOnly: true });
  if (ids.length === 0) {
    return { ok: true, skipped: true, stdout: '', stderr: '' };
  }
  return runDocker(['stop', ...ids], { timeout: 120000 });
}

// Removes every container of one ProjectDockHub project, with its anonymous volumes (the database data),
// then the PHP image and network it created. Containers are found by ProjectDockHub labels,
// so containers that belong to anything else are never touched.
// With `keepData`, the named volumes with the database data stay, otherwise they are removed too.
async function removeProject(projectName, { keepData = false } = {}) {
  assertProjectName(projectName);
  const ids = await projectContainerIds(projectName, { runningOnly: false });
  if (ids.length > 0) {
    const res = await runDocker(['rm', '-f', '-v', ...ids], { timeout: 120000 });
    if (!res.ok) return res;
  }

  if (!keepData) {
    const vols = await projectVolumeNames(projectName);
    if (vols.length > 0) {
      const res = await runDocker(['volume', 'rm', '-f', ...vols], { timeout: 60000 });
      if (!res.ok) return res;
    }
  }

  // These can be rebuilt on the next create, so a failure here is not an error.
  await runDocker(['image', 'rm', phpImage(projectName)]);
  await runDocker(['network', 'rm', networkName(projectName)]);
  return { ok: true, stdout: '', stderr: '' };
}

// Starts or stops ONE service of a project (its container), found by the ProjectDockHub labels.
// `action` is 'start', 'stop' or 'remove'. A service whose container does not exist (removed) cannot be started
// here: starting the whole project creates it again. 'remove' deletes only the container (docker rm -f);
// named data volumes stay, so the next start of the project creates the container again with the same data.
const SERVICE_ACTIONS = { start: ['start'], stop: ['stop'], remove: ['rm', '-f'] };

async function serviceAction(projectName, serviceName, action, run = runDocker) {
  assertProjectName(projectName);
  if (typeof serviceName !== 'string' || !NAME_RE.test(serviceName)) throw new Error('Invalid service name');
  if (!Object.prototype.hasOwnProperty.call(SERVICE_ACTIONS, action)) throw new Error('Invalid action');

  const found = await run(['ps', '-a', '-q', '--filter', MANAGED_FILTER,
    '--filter', projectFilter(projectName), '--filter', serviceFilter(serviceName)]);
  if (!found.ok) throw new Error(firstLine(found.stderr) || 'Could not find the container');
  const ids = found.stdout.split(String.fromCharCode(10)).map((id) => id.trim()).filter((id) => ID_RE.test(id));
  if (ids.length === 0) {
    return { ok: false, stdout: '', stderr: `The container of ${serviceName} does not exist. Start the whole project to create it.` };
  }
  return run([...SERVICE_ACTIONS[action], ...ids], { timeout: action === 'start' ? 60000 : 120000 });
}

async function restartProject(projectName) {
  const ids = await projectContainerIds(projectName, { runningOnly: false });
  if (ids.length === 0) {
    return { ok: true, skipped: true, stdout: '', stderr: '' };
  }
  return runDocker(['restart', ...ids], { timeout: 180000 });
}

module.exports = {
  listContainers,
  stopProject,
  restartProject,
  serviceAction,
  removeProject,
  missingServices,
  projectVolumeNames,
  projectLogs,
};
