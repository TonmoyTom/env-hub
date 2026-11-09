'use strict';

const { runDocker, firstLine } = require('./exec');
const { NAME_RE } = require('../compose/generate');

const MANAGED_FILTER = 'label=com.envhub.managed=true';
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

// Only envhub-managed containers are ever listed or changed.
async function listContainers(projectName) {
  const args = ['ps', '-a', '--filter', MANAGED_FILTER];
  if (projectName !== null && projectName !== undefined) {
    assertProjectName(projectName);
    args.push('--filter', `label=com.envhub.project=${projectName}`);
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
        project: labels['com.envhub.project'] || null,
        service: labels['com.envhub.service'] || null,
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
  args.push('-q', '--filter', MANAGED_FILTER, '--filter', `label=com.envhub.project=${projectName}`);

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
    const res = await runDocker(['logs', '--tail', String(cap), id]);
    chunks.push(`== ${id.slice(0, 12)} ==\n${res.stdout}${res.stderr}`);
  }

  return chunks.join('\n');
}

// Named data volumes of one project, found by envhub labels.
async function projectVolumeNames(projectName) {
  assertProjectName(projectName);
  const res = await runDocker([
    'volume', 'ls', '-q',
    '--filter', MANAGED_FILTER,
    '--filter', `label=com.envhub.project=${projectName}`,
  ]);
  if (!res.ok) return [];
  return res.stdout.split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`envhub-${projectName}-`));
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

// Removes every container of one envhub project, with its anonymous volumes (the database data),
// then the PHP image and network it created. Containers are found by envhub labels,
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
  await runDocker(['image', 'rm', `envhub-${projectName}-php`]);
  await runDocker(['network', 'rm', `envhub-${projectName}_default`]);
  return { ok: true, stdout: '', stderr: '' };
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
  removeProject,
  missingServices,
  projectVolumeNames,
  projectLogs,
};
