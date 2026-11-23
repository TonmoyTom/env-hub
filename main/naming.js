'use strict';

// Every name ProjectDockHub gives to things outside the app comes from naming.json (in the project root),
// so changing the one word there changes them all:
//   containers  <prefix>-<project>-<service>          (envhub-shop-php)
//   volumes     <prefix>-<project>-<service>-<volume> (envhub-shop-mysql-data)
//   images      <prefix>-<project>-php                (envhub-shop-php)
//   networks    <prefix>-<project>_default            (envhub-shop_default)
//   labels      com.<prefix>.managed / .project / .service / .stack
//   folder      <home>/<prefix>-projects, small files .env.<prefix>-backup, .<prefix>-lock
// Changing the prefix does not rename what Docker already has: start each project again to create it
// under the new name. Old containers and volumes keep the old name until they are removed.
//
// Two names stay fixed on purpose: the app data folder (it holds the projects, passwords and settings)
// and the format id of exported project lists (old exports must still import).

const fs = require('fs');
const path = require('path');

const DEFAULT_PREFIX = 'envhub';
// Docker names allow more, but labels and folder names stay simple with this.
const PREFIX_RE = /^[a-z][a-z0-9-]{0,19}$/;

function readPrefix(file = path.join(__dirname, '..', 'naming.json')) {
  // The tests check the default names (envhub-shop-php ...), whatever naming.json says.
  // node --test sets NODE_TEST_CONTEXT in the processes that run test files.
  if (process.env.NODE_TEST_CONTEXT && arguments.length === 0) return DEFAULT_PREFIX;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const prefix = String(data.prefix || '').trim();
    if (PREFIX_RE.test(prefix)) return prefix;
    console.error(`naming.json: "${prefix}" is not a valid prefix (lowercase letters, digits and -, starting with a letter, up to 20). Using "${DEFAULT_PREFIX}".`);
  } catch (err) {
    // No file or broken JSON: the default keeps the app working.
  }
  return DEFAULT_PREFIX;
}

const PREFIX = readPrefix();
const LABEL = `com.${PREFIX}`;

const LABELS = {
  managed: `${LABEL}.managed`,
  project: `${LABEL}.project`,
  service: `${LABEL}.service`,
  stack: `${LABEL}.stack`,
};

const MANAGED_FILTER = `label=${LABELS.managed}=true`;

const composeProject = (project) => `${PREFIX}-${project}`;
const containerName = (project, service) => `${PREFIX}-${project}-${service}`;
const volumeName = (project, service, volume) => `${PREFIX}-${project}-${service}-${volume}`;
const phpImage = (project) => `${PREFIX}-${project}-php`;
const networkName = (project) => `${PREFIX}-${project}_default`;
const projectFilter = (project) => `label=${LABELS.project}=${project}`;
const serviceFilter = (service) => `label=${LABELS.service}=${service}`;

module.exports = {
  PREFIX,
  LABEL,
  LABELS,
  MANAGED_FILTER,
  PREFIX_RE,
  readPrefix,
  composeProject,
  containerName,
  volumeName,
  phpImage,
  networkName,
  projectFilter,
  serviceFilter,
  projectsFolderName: `${PREFIX}-projects`,
  envBackupName: `.env.${PREFIX}-backup`,
  lockFileName: `.${PREFIX}-lock`,
  writeTestPrefix: `.${PREFIX}-write-test-`,
};
