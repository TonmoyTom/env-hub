'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, session, Menu } = require('electron');

// Linux: the dock finds the app icon through this .desktop name. Started from another app's terminal (VS Code),
// the window would carry that app's name and be grouped under its icon, so it is always set here.
if (process.platform === 'linux') {
  process.env.CHROME_DESKTOP = 'projectdockhub.desktop';
  if (typeof app.setDesktopName === 'function') app.setDesktopName('projectdockhub.desktop');
}
const fs = require('fs');
const path = require('path');
const naming = require('./naming');
const { checkDocker } = require('./docker/check');
const { startDockerDesktop, downloadUrl } = require('./docker/launch');
const { shutDownDocker } = require('./docker/desktop');
const { syncVendorVolume } = require('./project/vendor-volume');
const { composerHint } = require('./project/composer-hints');
const { previewDockerFiles, generateDockerFiles } = require('./project/docker-files');
const { runningProjects } = require('./tray');
const {
  listContainers,
  stopProject,
  restartProject,
  serviceAction,
  removeProject,
  missingServices,
  projectLogs,
  projectVolumeNames,
} = require('./docker/containers');
const { describeVolumes } = require('./stacks/volumes');
const { startEvents } = require('./docker/events');
const { dockerHostPorts } = require('./docker/ports');
const { setupProject, stepsFor, waitForApp } = require('./docker/pipeline');
const { generateCompose, writeComposeFile, validateProject, NAME_RE } = require('./compose/generate');
const { resolveHostPorts, portsOf, applySavedPorts, toSavedPorts } = require('./network/ports');
const { buildProject, stackLabel, mainWebService, mainWebPort, CREATABLE_STACKS } = require('./stacks');
const registry = require('./registry/versions');
const { normalizeOptions } = require('./stacks/laravel');
const { normalizeNodeOptions, NODE_STACKS } = require('./stacks/node');
const { streamDocker } = require('./docker/exec');
const { projectStats, projectDisk, openShell } = require('./docker/stats');
const { searchImages, listTags, imageExists, fetchVersionLists } = require('./docker/hub');
const { normalizeExtraServices } = require('./stacks/extras');
const { isEditable, describeForEdit, applyServiceEdit, diffServices } = require('./stacks/edit');
const { buildLinks, workdirOf } = require('./stacks/links');
const { normalizeDockerInput, packageRule } = require('./stacks/docker');
const { normalizeFramework, frameworkCommand, FRAMEWORKS } = require('./stacks/python-frameworks');
const { connectionText, connectionData, envFileText } = require('./stacks/connection');
const { dbNameOf, dbUserOf, appPasswordOf, normalizeDbName, normalizeDbUser, normalizePassword, normalizeMail } = require('./stacks/services');
const { ensureDatabases } = require('./docker/database');
const { scaffoldLaravel, scaffoldNode, scaffoldDocker, finishInstall, writeLaravelSupport, writePhpSettings } = require('./project/scaffold');
const { detectProject } = require('./project/detect');
const { installProject, restoreLaravel, userArgs, INSTALLABLE_STACKS } = require('./project/installer');
const { hostUser, volumeOwnerCommands } = require('./docker/hostuser');
const { removeProjectFolder, isInside } = require('./project/folders');
const { writeEnvFile } = require('./project/envfile');
const { lanAddresses } = require('./network/lan');
const { buildDiagnosis, gatherFacts, addFirewallRule } = require('./network/diagnose');
const { getOrCreateSecret } = require('./store/secrets');
const projects = require('./store/projects');
const settings = require('./store/settings');
const { exportProjects, planImport } = require('./store/sync');
const { installMenu } = require('./menu');
const { createTray } = require('./tray');
const { openDocWindow } = require('./docview');

const VERSIONS_WAIT_MS = 2500;
let versionsReady = Promise.resolve();

const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');

// Services that have a web page, with the container port that serves it.
// The renderer can only pick a name from this list. It can never pass a URL.
const OPENABLE = { nginx: 80, node: 3000, phpmyadmin: 80, adminer: 8080, mailpit: 8025 };

let mainWindow = null;
let stopEvents = null;
// The tray icon. Closing the window hides it; only Exit (tray, File menu, or the system) quits.
let tray = null;
let quitting = false;
let trayHintShown = false;

// Only accept IPC calls that come from our own local page.
function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('file://');
}

// Every IPC handler goes through here so the sender is always checked.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      throw new Error('Untrusted sender');
    }
    return fn(...args);
  });
}

// The app was called envhub before. Its data folder (projects, secrets, settings) keeps that name when it exists,
// so the rename loses nothing. A new install uses the new name. Something that already set the folder (a test
// script) is left alone.
const LEGACY_DATA_DIR = path.join(app.getPath('appData'), 'envhub');
if (app.getPath('userData') === path.join(app.getPath('appData'), app.getName()) && fs.existsSync(LEGACY_DATA_DIR)) {
  app.setPath('userData', LEGACY_DATA_DIR);
}

function dataDir() {
  return app.getPath('userData');
}

// New projects live outside Documents, which is often synced by OneDrive.
// The old default folder keeps being used when it exists, so the projects made before the rename stay together
// with the new ones. It is always one of the folders a project can be deleted from.
function legacyProjectsDir() {
  return path.join(app.getPath('home'), naming.projectsFolderName);
}

function defaultProjectsDir() {
  return fs.existsSync(legacyProjectsDir()) ? legacyProjectsDir() : path.join(app.getPath('home'), 'ProjectDockHub-projects');
}

function knownProjectDirs() {
  return [...new Set([...settings.knownProjectDirs(defaultProjectsDir()), path.resolve(legacyProjectsDir())])];
}

// The user can choose another folder (Settings in the New project step). Projects made earlier stay where they are.
function projectsBaseDir() {
  return settings.projectsBaseDir(defaultProjectsDir());
}

function projectsSettings() {
  return {
    projectsDir: projectsBaseDir(),
    defaultDir: defaultProjectsDir(),
    isDefault: projectsBaseDir() === defaultProjectsDir(),
    // Where ProjectDockHub keeps the compose file of each project (<app data>/projects/<name>/compose.json).
    dockerFilesDir: path.join(dataDir(), 'projects'),
    stopDockerOnExit: settings.stopDockerOnExit(),
    askOnExit: settings.askOnExit(),
  };
}

function requireSpec(name) {
  const spec = projects.getSpec(name);
  if (!spec) {
    throw new Error('Unknown project');
  }
  return spec;
}

// Full Compose config for a spec. The database password is read from the secrets store.
function dbPasswordFor(spec) {
  return CREATABLE_STACKS.includes(spec.stack) ? getOrCreateSecret(dataDir(), `${spec.name}.db`) : '';
}

// The passwords of a project. `root` is the one the containers were created with (it never changes).
// `app` is the password the app user should have now (the one the user set, or the root one).
function credentialsFor(spec) {
  const root = dbPasswordFor(spec);
  return { root, app: appPasswordOf(spec, root), redis: spec.redisPassword || '', user: dbUserOf(spec) };
}

function configForStart(spec) {
  return buildProject(spec, dbPasswordFor(spec));
}

// Config used only to read port numbers. No secret is needed for that.
function configForPorts(spec) {
  return buildProject(spec, '');
}

// 'running' when every container is up, 'partly' when some are, 'stopped' otherwise (or none exist).
async function projectState(name, expected = []) {
  try {
    const items = await listContainers(name);
    if (items.length === 0) return 'stopped';
    const up = items.filter((c) => c.state === 'running').length;
    if (up === items.length && missingServices(items, expected).length === 0) return 'running';
    return up > 0 ? 'partly' : 'stopped';
  } catch (err) {
    return 'stopped';
  }
}

async function isProjectRunning(name) {
  try {
    const items = await listContainers(name);
    return items.some((c) => c.state === 'running');
  } catch (err) {
    return false;
  }
}

// True only when there are containers and every one is running. A container that is restarting
// or has exited means the project needs a real start, which also applies a changed setup.
async function isProjectFullyRunning(name, expected = []) {
  try {
    const items = await listContainers(name);
    return items.length > 0 && items.every((c) => c.state === 'running') && missingServices(items, expected).length === 0;
  } catch (err) {
    return false;
  }
}

// Ports to show and open: the ones in use now, else the ones saved from the last start,
// else the defaults.
function serviceNamesOf(spec) {
  return configForPorts(spec).services.map((svc) => svc.name);
}

function knownPorts(spec) {
  const assigned = projects.getAssignments(spec.name);
  if (assigned) return assigned;
  return portsOf(applySavedPorts(configForPorts(spec), spec.hostPorts));
}

// Host ports the running containers of this project hold now: the ones in use this session,
// else the ones saved from the last start.
function ownedHostPorts(spec) {
  const assigned = projects.getAssignments(spec.name);
  const hosts = assigned ? assigned.map((p) => p.host) : Object.values(spec.hostPorts || {});
  return new Set(hosts.filter((host) => Number.isInteger(host)));
}

function summarizeProject(spec) {
  const config = configForPorts(spec);
  return {
    name: spec.name,
    stack: spec.stack || 'custom',
    label: stackLabel(spec),
    editable: isEditable(spec),
    services: config.services.map((s) => s.name),
    // Services that keep data in a Docker volume (databases and stores), for the delete question.
    dataServices: config.services.filter((s) => (s.dataVolumes || []).some((v) => v.name === 'data')).map((s) => s.name),
    // A project the user brought in keeps its folder when the project is deleted.
    imported: spec.imported === true,
    folder: spec.folder || '',
    ports: knownPorts(spec),
  };
}

// Sends step by step progress to the window. Updates inside one step are limited to a few per second.
function progressReporter(name, steps) {
  let lastStep = null;
  let lastSent = 0;

  return (step, fraction, detail) => {
    const now = Date.now();
    if (step === lastStep && now - lastSent < 200) return;
    lastStep = step;
    lastSent = now;
    sendToRenderer('project:progress', { name, steps, step, fraction, detail });
  };
}

// Sends the raw Docker output to the window. Lines are sent in small batches, because a pull can print hundreds a second.
function logSender(name) {
  let lines = [];
  let timer = null;

  function flush() {
    timer = null;
    if (lines.length === 0) return;
    sendToRenderer('project:log', { name, lines });
    lines = [];
  }

  const send = (line) => {
    lines.push(String(line).slice(0, 500));
    if (!timer) timer = setTimeout(flush, 100);
  };
  send.flush = flush;
  return send;
}

// The folder of an existing project: an absolute path to a folder that exists, not ProjectDockHub's own data.
function checkExistingFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new Error('Enter the full path of the project folder, like C:/laragon/www/myapp');
  }
  const dir = path.resolve(folder);
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (err) {
    throw new Error(`Folder not found: ${dir}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${dir}`);
  const data = path.resolve(dataDir());
  if (dir === data || dir.startsWith(data + path.sep)) throw new Error('Choose your own project folder, not the ProjectDockHub data folder');
  if (projects.listSpecs().some((s) => s.folder && path.resolve(s.folder) === dir)) {
    throw new Error('This folder is already a project in ProjectDockHub');
  }
  return dir;
}

// Host ports of projects that are starting right now, by project name. Two projects started together never pick the same port.
const startingPorts = new Map();

// Runs the stack's generator in the new folder, then writes docker-compose.yml, .env and the rest.
// If the generator fails the half made folder is removed, so the user can try again with the same name.
async function runInstall(installOpts, portableSpec) {
  const log = logSender(installOpts.name);
  const res = await installProject(installOpts, log);
  log.flush();
  if (!res.ok) {
    try {
      fs.rmSync(installOpts.folder, { recursive: true, force: true });
    } catch (err) {
      // The folder stays; the next try reports that it exists.
    }
    throw new Error(`Could not install ${installOpts.stack}: ${(res.tail || []).slice(-4).join(' | ') || 'unknown error'}`);
  }
  finishInstall(installOpts.folder, portableSpec);
}

function registerIpcHandlers() {
  handle('app:getInfo', () => ({ name: app.getName(), version: app.getVersion(), prefix: naming.PREFIX }));
  handle('docker:check', () => checkDocker());
  // Window buttons of the Linux title bar (the window has no native one there).
  handle('window:control', (action) => {
    if (!mainWindow) return { ok: false };
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
    else if (action === 'close') mainWindow.close();
    else return { ok: false };
    return { ok: true };
  });
  // The Linux title bar has no native menu bar: its File/Edit/... buttons open the same menus here.
  handle('window:menu', (label, x, y) => {
    const menu = Menu.getApplicationMenu();
    const item = menu && menu.items.find((it) => it.label === label);
    if (!mainWindow || !item || !item.submenu) return { ok: false };
    item.submenu.popup({ window: mainWindow, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
    return { ok: true };
  });
  handle('docker:start', () => startDockerDesktop());
  // Opens the official Docker download in the browser (the file goes to the Downloads folder).
  handle('docker:download', async () => {
    await shell.openExternal(downloadUrl());
    return { ok: true };
  });
  handle('containers:list', (projectName) => listContainers(projectName));
  // Used by the New project form, so a name that is taken is caught on the first step.
  handle('project:checkName', (name) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error('Invalid project name');
    }
    const folder = path.join(projectsBaseDir(), name);
    return { projectExists: projects.getSpec(name) !== null, folderExists: fs.existsSync(folder), folder };
  });

  // Each project with its state: running (all containers up), partly (some up), stopped (none up).
  handle('projects:list', async () => {
    const specs = projects.listSpecs();
    return Promise.all(specs.map(async (spec) => ({ ...summarizeProject(spec), state: await projectState(spec.name, serviceNamesOf(spec)) })));
  });

  handle('project:create', async (input) => {
    const { name, stack, version, options } = input || {};
    // true = run the official generator (Laravel, Next.js...) and drop the placeholder; false = placeholder server.js / index.php.
    const install = Boolean(input) && input.install === true && INSTALLABLE_STACKS.includes(stack);

    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error('Invalid project name: use lowercase letters, numbers and dashes, starting with a letter');
    }
    if (!CREATABLE_STACKS.includes(stack)) {
      throw new Error('Unsupported stack');
    }
    if (projects.getSpec(name)) {
      throw new Error('A project with this name already exists');
    }

    const baseDir = projectsBaseDir();
    const extraServices = normalizeExtraServices(input.extraServices);
    // Optional database name and password from the New project form. Checked before anything is created.
    const dbName = normalizeDbName(input.dbName);
    const dbUser = normalizeDbUser(input.dbUser);
    const mail = normalizeMail(input.mail);
    const dbPassword = normalizePassword(input.dbPassword, 'Database password') || undefined;
    const versions = registry.normalizeVersions(input.versions);
    let spec;

    // Everything is validated before any folder is created.
    // Same password ProjectDockHub uses for the running containers, so the folder's .env matches them.
    const folderPassword = dbPassword || getOrCreateSecret(dataDir(), `${name}.db`);
    if (stack === 'laravel') {
      if (!registry.has('php', version)) {
        throw new Error('Unsupported PHP version');
      }
      const opts = normalizeOptions(options);
      const folder = scaffoldLaravel({ baseDir, name, phpVersion: version, options: opts, versions, dbPassword: folderPassword, extraServices, install });
      if (install) {
        await runInstall({ stack, name, folder, phpVersion: version }, { stack, name, phpVersion: version, options: opts, versions, dbPassword: folderPassword, extraServices });
      }
      spec = { name, stack, phpVersion: version, folder, options: opts };
    } else if (stack === 'docker') {
      const framework = normalizeFramework(input.framework, input.image);
      // A framework starter brings its own port and start command, unless the user typed one.
      const typed = { ...input };
      if (framework && String(typed.containerPort === undefined || typed.containerPort === null ? '' : typed.containerPort).trim() === '') typed.containerPort = FRAMEWORKS[framework].port;
      if (framework && !String(typed.command || '').trim()) typed.command = frameworkCommand(framework);
      const { image, containerPort, command } = normalizeDockerInput(typed);
      const opts = normalizeNodeOptions(options);
      const folder = scaffoldDocker({ baseDir, name, image, containerPort, command, options: opts, versions, dbPassword: folderPassword, extraServices, install, framework });
      spec = { name, stack, image, containerPort, command, folder, options: opts };
      if (framework) spec.framework = framework;
      if (input.keepPackages === true && packageRule(image)) spec.keepPackages = true;
    } else {
      if (!registry.has('node', version)) {
        throw new Error('Unsupported Node version');
      }
      const opts = normalizeNodeOptions(options);
      const folder = scaffoldNode({ baseDir, name, stack, nodeVersion: version, options: opts, versions, dbPassword: folderPassword, extraServices, install });
      if (install) {
        await runInstall({ stack, name, folder, nodeVersion: version }, { stack, name, nodeVersion: version, options: opts, versions, dbPassword: folderPassword, extraServices });
      }
      spec = { name, stack, nodeVersion: version, folder, options: opts };
    }

    if (dbName) spec.dbName = dbName;
    if (dbUser) spec.dbUser = dbUser;
    if (mail) spec.mail = mail;
    if (dbPassword) spec.dbPassword = dbPassword;
    if (versions) spec.versions = versions;

    if (extraServices.length > 0) {
      spec.extraServices = extraServices;
    }
    projects.addSpec(spec);
    return summarizeProject(spec);
  });

  // ---------- Where new projects are saved ----------
  handle('settings:get', () => projectsSettings());
  handle('settings:chooseProjectsDir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Choose the folder for new projects', defaultPath: projectsBaseDir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return projectsSettings();
    settings.setProjectsDir(res.filePaths[0], { dataDir: dataDir() });
    return projectsSettings();
  });
  // Opens the folder with the compose files in Explorer / Finder. The path is built here, never sent by the window.
  handle('settings:openDockerFilesDir', async () => {
    const dir = path.join(dataDir(), 'projects');
    fs.mkdirSync(dir, { recursive: true });
    const error = await shell.openPath(dir);
    return { ok: !error, error };
  });
  handle('settings:resetProjectsDir', () => {
    settings.resetProjectsDir();
    return projectsSettings();
  });
  handle('settings:setAskOnExit', (value) => {
    settings.setAskOnExit(value);
    return projectsSettings();
  });
  handle('settings:setStopDockerOnExit', (value) => {
    settings.setStopDockerOnExit(value);
    return projectsSettings();
  });

  // ---------- Existing project (a folder the user already has, for example a git clone) ----------

  // The user picks the folder with the system dialog, or types the path.
  handle('project:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win, { title: 'Choose your project folder', properties: ['openDirectory'] });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  // Checks the folder and guesses stack and version. Writes nothing.
  handle('project:detect', (folder) => {
    const dir = checkExistingFolder(folder);
    return { folder: dir, ...detectProject(dir) };
  });

  // Adds the folder as a project. The folder is only read: ProjectDockHub writes no file into it,
  // except a missing vendor/ and .env for Laravel (composer install), and never deletes it.
  handle('project:import', async (input) => {
    const { name, stack, version, options } = input || {};
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error('Invalid project name: use lowercase letters, numbers and dashes, starting with a letter');
    }
    if (!['laravel', 'docker', ...NODE_STACKS].includes(stack)) {
      throw new Error('Unsupported stack');
    }
    if (projects.getSpec(name)) {
      throw new Error('A project with this name already exists');
    }
    const folder = checkExistingFolder(input.folder);
    const extraServices = normalizeExtraServices(input.extraServices);
    const dbName = normalizeDbName(input.dbName);
    const dbUser = normalizeDbUser(input.dbUser);
    const mail = normalizeMail(input.mail);
    const dbPassword = normalizePassword(input.dbPassword, 'Database password') || undefined;
    const versions = registry.normalizeVersions(input.versions);
    let spec;

    if (stack === 'laravel') {
      if (!registry.has('php', version)) throw new Error('Unsupported PHP version');
      const opts = normalizeOptions(options);
      const supportDir = path.join(dataDir(), 'projects', name, 'laravel');
      writeLaravelSupport(supportDir, version);
      spec = { name, stack, phpVersion: version, folder, options: opts, supportDir, imported: true };
      if (!fs.existsSync(path.join(folder, 'vendor', 'autoload.php'))) {
        const log = logSender(name);
        const res = await restoreLaravel({ folder }, log);
        log.flush();
        if (!res.ok || !fs.existsSync(path.join(folder, 'vendor', 'autoload.php'))) {
          const tail = res.tail || [];
          throw new Error(`composer install failed: ${tail.slice(-4).join(' | ') || 'unknown error'}${composerHint(tail) ? ` ${composerHint(tail)}` : ''}`);
        }
      }
    } else if (stack === 'docker') {
      const { image, containerPort, command } = normalizeDockerInput(input);
      spec = { name, stack, image, containerPort, command, folder, options: normalizeNodeOptions(options), imported: true };
      if (input.keepPackages === true && packageRule(image)) spec.keepPackages = true;
    } else {
      if (!registry.has('node', version)) throw new Error('Unsupported Node version');
      spec = { name, stack, nodeVersion: version, folder, options: normalizeNodeOptions(options), imported: true };
    }

    if (dbName) spec.dbName = dbName;
    if (dbUser) spec.dbUser = dbUser;
    if (mail) spec.mail = mail;
    if (dbPassword) spec.dbPassword = dbPassword;
    if (versions) spec.versions = versions;
    if (extraServices.length > 0) spec.extraServices = extraServices;
    projects.addSpec(spec);
    return summarizeProject(spec);
  });

  // `options.apply` is used after the services were edited: the project is started again even when
  // everything is running, so Docker recreates what changed and removes what is gone.
  handle('project:start', async (name, options) => {
    const spec = requireSpec(name);
    // `rebuild` builds the PHP image again from nothing (the Rebuild button). It always applies the project.
    const rebuild = Boolean(options) && options.rebuild === true;
    const apply = rebuild || (Boolean(options) && options.apply === true);
    // custom.ini must exist before Docker mounts it. Older projects get an empty one here.
    if (spec.stack === 'laravel') writePhpSettings(spec);
    const config = applySavedPorts(configForStart(spec), spec.hostPorts);

    if (!apply && (await isProjectFullyRunning(spec.name, config.services.map((svc) => svc.name)))) {
      return {
        ok: true,
        alreadyRunning: true,
        changed: [],
        ports: knownPorts(spec),
      };
    }

    const report = progressReporter(spec.name, stepsFor(config));
    const log = logSender(spec.name);
    report('ports', null, 'Looking for free ports');
    log('Looking for free ports');

    // Ports held by any Docker container (running or stopped) or by another ProjectDockHub project
    // are off limits, so several projects can run together without clashing.
    // Anything else using a port on this machine is caught by the free-port check.
    const dockerPorts = await dockerHostPorts(spec.name);
    // Ports another project is claiming right now (its start has not finished) are off limits too.
    const claimed = [...startingPorts.entries()].filter(([other]) => other !== spec.name).flatMap(([, ports]) => [...ports]);
    const reserved = new Set([...projects.hostPortsUsedByOthers(spec.name), ...dockerPorts.keys(), ...claimed]);
    // When changes are applied to a running project, its own ports are not busy: keep them.
    const owned = apply && (await isProjectRunning(spec.name)) ? ownedHostPorts(spec) : new Set();
    const { project: resolved, changed: moved } = await resolveHostPorts(config, reserved, owned);
    const changed = moved.map((c) => ({ ...c, usedBy: dockerPorts.get(c.wanted) || null }));
    startingPorts.set(spec.name, new Set(portsOf(resolved).map((p) => p.host)));
    try {

    for (const c of changed) {
      log(`Port ${c.wanted} is taken, ${c.service} uses ${c.actual}`);
    }
    report('files', null, 'Writing the setup files');
    log('Writing the setup files');
    const dir = path.join(dataDir(), 'projects', spec.name);
    const file = writeComposeFile(dir, generateCompose(resolved));

    // Linux only (no commands elsewhere): hand new volumes to the user the container runs as.
    for (const args of volumeOwnerCommands(resolved, spec.name)) {
      await streamDocker(args, log, { timeout: 10 * 60 * 1000 });
    }

    const res = await setupProject({ composeFile: file, projectName: spec.name, config: resolved, report, log, rebuild });
    // The image now has these extensions, so the "rebuild needed" notice can go away.
    if (res.ok && spec.stack === 'laravel') projects.updateSpec(spec.name, { phpBuilt: spec.phpExtensions || [] });
    if (res.ok && spec.stack === 'laravel' && spec.vendorVolume === true) {
      // vendor/ is in a Docker volume: fill it the first time, and after composer.lock changed.
      report('up', null, 'Preparing the vendor volume');
      const synced = await syncVendorVolume({ projectName: spec.name, folder: spec.folder, log });
      if (!synced.ok) {
        res.ok = false;
        res.stderr = `Vendor volume: ${synced.error}. Turn off "Keep vendor in a Docker volume" in the project's Settings tab to go back.`;
      }
    }
    if (res.ok) {
      // Node apps need npm install first. Wait here so the progress bar stays up until the app answers.
      const ready = await waitForApp({ projectName: spec.name, config: resolved, report, log });
      if (!ready.ok) {
        log.flush();
        return { ...res, ...ready, changed, ports: portsOf(resolved) };
      }
      res.notReady = ready.notReady === true;
    }
    if (res.ok) {
      // The database the user named is created next to `app`, without touching the data already there.
      const creds = credentialsFor(spec);
      const dbs = await ensureDatabases({
        services: resolved.services,
        projectName: spec.name,
        dbName: dbNameOf(spec),
        dbUser: creds.user,
        appPassword: creds.app,
        rootPassword: creds.root,
        log,
      });
      res.dbErrors = dbs.errors;
    }
    log.flush();
    if (res.ok) {
      projects.setAssignments(spec.name, portsOf(resolved));
      projects.setHostPorts(spec.name, toSavedPorts(portsOf(resolved)));
    }
    return { ...res, changed, ports: portsOf(resolved) };
    } finally {
      startingPorts.delete(spec.name);
    }
  });

  handle('project:stop', async (name) => {
    const spec = requireSpec(name);
    const res = await stopProject(spec.name);
    if (res.ok) {
      projects.clearAssignments(spec.name);
    }
    return res;
  });

  // What the Edit services form shows for a project.
  handle('project:details', async (name) => {
    const spec = requireSpec(name);
    return { ...describeForEdit(spec), running: await isProjectRunning(spec.name) };
  });

  // Saves new services for a project. Nothing is started here: the renderer starts the project
  // with `apply` when the user asks for it. Everything is validated before anything is saved.
  handle('project:update', async (name, input) => {
    const spec = requireSpec(name);
    const next = applyServiceEdit(spec, input);

    const before = configForPorts(spec);
    const after = configForPorts(next);
    validateProject(after);

    // The PHP image is rebuilt from this Dockerfile on the next start, so write it only when the list changed.
    // php.ini is written on every start (see project:start), but also here, so the file is there at once.
    if (spec.stack === 'laravel') {
      const extensionsChanged = JSON.stringify(spec.phpExtensions || []) !== JSON.stringify(next.phpExtensions || []);
      writePhpSettings(next, { dockerfile: extensionsChanged });
    }

    const saved = projects.updateSpec(spec.name, {
      phpExtensions: next.phpExtensions,
      phpIni: next.phpIni,
      vendorVolume: next.vendorVolume,
      options: next.options,
      extraServices: next.extraServices,
      dbName: next.dbName,
      dbUser: next.dbUser,
      dbPassword: next.dbPassword,
      redisPassword: next.redisPassword,
      lanShare: next.lanShare,
      keepPackages: next.keepPackages,
      versions: next.versions,
      mail: next.mail,
    });
    return {
      ok: true,
      changes: diffServices(before, after),
      details: { ...describeForEdit(saved), running: await isProjectRunning(spec.name) },
    };
  });

  handle('project:restart', (name) => restartProject(requireSpec(name).name));

  // One service of a project: its stop and start icons in the Services list.
  handle('service:stop', (name, service) => serviceAction(requireSpec(name).name, service, 'stop'));
  handle('service:start', (name, service) => serviceAction(requireSpec(name).name, service, 'start'));
  handle('service:remove', (name, service) => serviceAction(requireSpec(name).name, service, 'remove'));

  handle('project:delete', async (name, options) => {
    const spec = requireSpec(name);
    if (!NAME_RE.test(spec.name)) {
      throw new Error('Invalid project name');
    }

    // If Docker cannot remove the containers, keep the project so the user can try again.
    const keepData = Boolean(options && options.keepData === true);
    const res = await removeProject(spec.name, { keepData });
    if (!res.ok) {
      return res;
    }

    // The generated Compose folder goes, and so does the project folder with all the files in it.
    // The project folder is only deleted when it is inside the ProjectDockHub projects folder.
    fs.rmSync(path.join(dataDir(), 'projects', spec.name), { recursive: true, force: true });
    // Only a folder ProjectDockHub created is deleted, in any folder that was used for projects. A project the user
    // brought in (imported) is never deleted, even when it sits inside a projects folder.
    let folderResult = null;
    if (spec.folder && !spec.imported) {
      for (const base of knownProjectDirs()) {
        folderResult = removeProjectFolder(base, spec.folder);
        if (folderResult.deleted || folderResult.missing) break;
      }
    }
    projects.removeSpec(spec.name);
    return {
      ok: true,
      keepData,
      folder: spec.folder || null,
      folderDeleted: folderResult ? folderResult.deleted : false,
      folderError: folderResult ? folderResult.error : null,
    };
  });

  // Opens one of the project's web pages. `service` is optional and defaults to the main page.
  handle('project:open', async (name, service) => {
    const spec = requireSpec(name);
    const target = service === undefined || service === null ? mainWebService(spec) : service;

    const isMain = target === mainWebService(spec);
    if (typeof target !== 'string' || !(isMain || Object.hasOwn(OPENABLE, target))) {
      throw new Error('Unknown service');
    }
    if (!(await isProjectRunning(spec.name))) {
      throw new Error('Start the project first');
    }

    const containerPort = isMain ? mainWebPort(spec) : OPENABLE[target];
    const web = knownPorts(spec).find((p) => p.service === target && p.container === containerPort);
    if (!web) {
      throw new Error('This project has no such page');
    }

    // The URL is built here from a port number. The renderer cannot pass a URL.
    await shell.openExternal(`http://localhost:${web.host}`);
    return { ok: true };
  });

  // Opens the project folder in the file manager. Only the folder saved in the project spec is used.
  // Installs node_modules into the project folder too, so the editor (VS Code) finds the types.
  // Runs inside Docker, so Node is not needed on this computer. The app itself uses its own volume.
  handle('project:installPackages', async (name) => {
    const spec = requireSpec(name);
    if (!NODE_STACKS.includes(spec.stack) || !fs.existsSync(path.join(spec.folder, 'package.json'))) {
      throw new Error('This project has no package.json');
    }
    const log = logSender(spec.name);
    const res = await streamDocker(
      ['run', '--rm', '--mount', `type=bind,source=${spec.folder},target=/app`, '-w', '/app', ...userArgs(hostUser()), `node:${spec.nodeVersion}-alpine`, 'npm', 'install'],
      log,
      { timeout: 15 * 60 * 1000 },
    );
    log.flush();
    return res.ok ? { ok: true } : { ok: false, stderr: res.tail.slice(-3).join(' | ') };
  });

  handle('project:openFolder', async (name) => {
    const spec = requireSpec(name);
    if (typeof spec.folder !== 'string' || !fs.existsSync(spec.folder)) {
      throw new Error('The project folder was not found');
    }
    const error = await shell.openPath(spec.folder);
    if (error) {
      throw new Error(error);
    }
    return { ok: true };
  });

  // Everything for the Links & commands panel. Only text is returned, nothing is run.
  handle('project:links', async (name) => {
    const spec = requireSpec(name);
    return buildLinks({
      name: spec.name,
      config: configForPorts(spec),
      ports: knownPorts(spec),
      composeFile: path.join(dataDir(), 'projects', spec.name, 'compose.json'),
      folder: spec.folder,
      running: await isProjectRunning(spec.name),
      lan: {
        enabled: spec.lanShare === true,
        service: mainWebService(spec),
        addresses: lanAddresses().map((a) => a.address),
      },
    });
  });

  // "Why can't another computer open my site?" Checks run on this computer; nothing is changed.
  function mainWebHostPort(spec) {
    const hit = knownPorts(spec).find((p) => p.service === mainWebService(spec));
    return hit ? hit.host : null;
  }

  handle('project:testAccess', async (name) => {
    const spec = requireSpec(name);
    const port = mainWebHostPort(spec);
    const facts = await gatherFacts({
      running: await isProjectRunning(spec.name),
      lanShare: spec.lanShare === true,
      addresses: lanAddresses().map((a) => a.address),
      port,
    });
    return { port, ...buildDiagnosis(facts) };
  });

  // Adds the Windows Firewall rule for the project's web port (Windows asks the user for permission).
  handle('project:allowFirewall', async (name) => addFirewallRule(mainWebHostPort(requireSpec(name))));

  // Live numbers for the details page. Only the project name is sent; the service is checked by openShell.
  handle('project:stats', (name) => projectStats(requireSpec(name).name));
  handle('project:disk', (name) => projectDisk(requireSpec(name).name));
  // The Volumes tab: every Docker volume of the project, and the folders shared from this computer.
  // The sizes are not here: `docker system df` can take many seconds, so the window asks for them
  // separately (project:disk) and fills them in when they arrive.
  handle('project:volumes', async (name) => {
    const spec = requireSpec(name);
    const existing = await projectVolumeNames(spec.name);
    return describeVolumes(configForPorts(spec), spec.name, existing, []);
  });
  handle('project:shell', (name, service) => {
    const spec = requireSpec(name);
    const found = configForPorts(spec).services.find((svc) => svc.name === service);
    if (!found) {
      throw new Error('This project has no such service');
    }
    // The terminal starts in the project folder inside the container (for example /var/www/html).
    return openShell(spec.name, service, { workdir: workdirOf(found, spec.folder) });
  });

  // Opens the web page of one published port. The renderer sends a service name and a container port,
  // the URL is built here from the host port, so the renderer can never pass a URL.
  handle('project:openPort', async (name, service, container) => {
    const spec = requireSpec(name);
    if (typeof service !== 'string' || !Number.isInteger(container)) {
      throw new Error('Unknown service');
    }
    if (!(await isProjectRunning(spec.name))) {
      throw new Error('Start the project first');
    }
    const port = knownPorts(spec).find((p) => p.service === service && p.container === container);
    if (!port) {
      throw new Error('This project has no such port');
    }
    await shell.openExternal(`http://localhost:${port.host}`);
    return { ok: true };
  });

  // Docker Hub lookups for the New project form. The renderer sends text only, never a URL.
  handle('hub:search', (query) => searchImages(query));
  handle('hub:tags', (image) => listTags(image));
  handle('hub:check', (image) => imageExists(image));

  handle('project:logs', (name) => projectLogs(requireSpec(name).name, 500));

  // Credentials and .env lines for the Connection panel. Only this window can ask for them.
  // The same, as data for the Credentials tab (cards with copy buttons).
  handle('project:connectionData', (name) => {
    const spec = requireSpec(name);
    const creds = credentialsFor(spec);
    return {
      ...connectionData({
        config: buildProject(spec, creds.root),
        ports: knownPorts(spec),
        password: creds.app,
        rootPassword: creds.root,
        dbName: dbNameOf(spec),
        dbUser: creds.user,
        redisPassword: creds.redis,
        mail: spec.mail,
      }),
      // For the "Slow on Windows?" tip in the Credentials tab.
      folder: spec.folder || '',
      platform: process.platform,
    };
  });

  handle('project:connection', (name) => {
    const spec = requireSpec(name);
    const creds = credentialsFor(spec);
    return connectionText({
      config: buildProject(spec, creds.root),
      ports: knownPorts(spec),
      password: creds.app,
      rootPassword: creds.root,
      dbName: dbNameOf(spec),
      dbUser: creds.user,
      redisPassword: creds.redis,
      mail: spec.mail,
    });
  });

  // The versions the New project and Edit services forms offer: built in list, Docker Hub (cached, refreshed
  // once a day in the background) and the user's versions.json. When a refresh is running, wait for it a
  // moment, so the first start after a day already shows the new versions. A slow Docker Hub never blocks the form.
  handle('registry:get', async () => {
    let timer;
    const wait = new Promise((resolve) => { timer = setTimeout(resolve, VERSIONS_WAIT_MS); });
    await Promise.race([versionsReady, wait]);
    clearTimeout(timer);
    return registry.snapshot();
  });

  // Opens <app data>/versions.json in the user's editor. The file is created with an empty example first.
  handle('registry:openFile', () => openVersionsFile());

  // ---------- Docker files in the project folder (Settings tab) ----------
  // What "Generate Docker files" would write: the services and the files, nothing is written here.
  handle('project:dockerFiles', (name) => {
    const spec = requireSpec(name);
    if (!isEditable(spec)) throw new Error('This project has no Docker files to generate.');
    const creds = credentialsFor(spec);
    return previewDockerFiles(spec, { app: creds.app, root: creds.root });
  });
  // Writes them. Only because the button was pressed; a file that is replaced is kept as .bak.
  handle('project:generateDockerFiles', (name) => {
    const spec = requireSpec(name);
    if (!isEditable(spec)) throw new Error('This project has no Docker files to generate.');
    const creds = credentialsFor(spec);
    return generateDockerFiles(spec, { app: creds.app, root: creds.root });
  });

  // Only the .env lines, for the Copy .env button. Same values as the Connection panel.
  handle('project:env', (name, target) => envTextFor(requireSpec(name), target));

  // Writes the same lines into <project folder>/.env. An existing different .env is backed up first.
  handle('project:writeEnv', (name, target) => {
    const spec = requireSpec(name);
    if (!spec.folder) throw new Error('This project has no folder.');
    // The user's own folder (an imported project) is written only because this button was pressed, and the old .env is backed up.
    const bases = knownProjectDirs();
    const base = spec.imported ? path.dirname(spec.folder) : bases.find((b) => isInside(b, spec.folder)) || projectsBaseDir();
    const res = writeEnvFile(base, spec.folder, envTextFor(spec, target));
    return { ...res, folder: spec.folder };
  });
}

function envTextFor(spec, target) {
  const creds = credentialsFor(spec);
  return envFileText({
    config: buildProject(spec, creds.root),
    ports: knownPorts(spec),
    target: target === 'host' ? 'host' : 'docker',
    password: creds.app,
    dbName: dbNameOf(spec),
    dbUser: creds.user,
    redisPassword: creds.redis,
    mail: spec.mail,
  });
}

// ---------- Application menu ----------

// Opens <app data>/versions.json in the user's editor. The file is created with an empty example first.
async function openVersionsFile() {
  const file = path.join(dataDir(), 'versions.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{\n  "php": { "versions": [] }\n}\n');
  }
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
  return { file };
}

// PLANNING.md and HANDOVER.md sit next to the code (they are packed into the app too).
const DOCS = { planning: ['Planning', 'PLANNING.md'], handover: ['Handover notes', 'HANDOVER.md'] };

// Runs a menu action and shows a clear message if it fails, so a menu click never ends in silence.
function guarded(run) {
  return async () => {
    try {
      await run();
    } catch (err) {
      dialog.showErrorBox('ProjectDockHub', err.message || String(err));
    }
  };
}

function setupMenu() {
  const say = (message, detail) => dialog.showMessageBox(mainWindow, { type: 'info', message, detail, buttons: ['OK'] });

  installMenu({
    sendToWindow: (name) => sendToRenderer('menu:action', name),

    chooseProjectsDir: guarded(async () => {
      const res = await dialog.showOpenDialog(mainWindow, { title: 'Choose the folder for new projects', defaultPath: projectsBaseDir(), properties: ['openDirectory', 'createDirectory'] });
      if (res.canceled || res.filePaths.length === 0) return;
      const dir = settings.setProjectsDir(res.filePaths[0], { dataDir: dataDir() });
      sendToRenderer('menu:action', 'projects-dir-changed');
      await say('New projects will be saved in:', `${dir}\n\nProjects you made earlier stay where they are.`);
    }),

    openProjectsDir: guarded(async () => {
      fs.mkdirSync(projectsBaseDir(), { recursive: true });
      const error = await shell.openPath(projectsBaseDir());
      if (error) throw new Error(error);
    }),

    openDataDir: guarded(async () => {
      const error = await shell.openPath(dataDir());
      if (error) throw new Error(error);
    }),

    // Sync 1: the list of projects, as one file. No passwords are written.
    exportProjects: guarded(async () => {
      const res = await dialog.showSaveDialog(mainWindow, { title: 'Export projects', defaultPath: path.join(app.getPath('documents'), 'projectdockhub-projects.json'), filters: [{ name: 'ProjectDockHub projects', extensions: ['json'] }] });
      if (res.canceled || !res.filePath) return;
      const data = exportProjects(projects.listSpecs());
      fs.writeFileSync(res.filePath, JSON.stringify(data, null, 2));
      await say(`Exported ${data.projects.length} project(s).`, `${res.filePath}\n\nNo passwords are in this file. Project folders are not copied: bring your code with git or by copying the folders, then import.`);
    }),

    importProjects: guarded(async () => {
      const res = await dialog.showOpenDialog(mainWindow, { title: 'Import projects', filters: [{ name: 'ProjectDockHub projects', extensions: ['json'] }], properties: ['openFile'] });
      if (res.canceled || res.filePaths.length === 0) return;
      let data;
      try {
        data = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
      } catch (err) {
        throw new Error('This file is not valid JSON.');
      }
      const plan = planImport(data, {
        existingNames: projects.listSpecs().map((s) => s.name),
        creatableStacks: CREATABLE_STACKS,
        folderExists: (folder) => fs.existsSync(folder) && fs.statSync(folder).isDirectory(),
      });
      for (const spec of plan.add) projects.addSpec(spec);
      sendToRenderer('menu:action', 'refresh');
      const skipped = plan.skipped.map((s) => `- ${s.name}: ${s.reason}`).join('\n');
      await say(`Imported ${plan.add.length} project(s).`, skipped ? `Skipped ${plan.skipped.length}:\n${skipped}` : 'Press Start on a project to run it.');
    }),

    // Sync 2: ask Docker again what is running.
    refreshDocker: () => sendToRenderer('menu:action', 'refresh'),

    // Sync 3: fetch the newest PHP / Node / database versions from Docker Hub now (normally once a day).
    refreshVersions: guarded(async () => {
      const res = await registry.refresh(path.join(dataDir(), 'versions-cache.json'), () => fetchVersionLists(), true);
      sendToRenderer('menu:action', 'versions-refreshed');
      if (res.source === 'hub') await say('Version lists updated from Docker Hub.', 'New versions show in the New project form.');
      else await say('Could not reach Docker Hub.', `${res.errors.slice(0, 3).join('\n') || 'The saved lists are used.'}`);
    }),

    showDoc: (key) => {
      const doc = DOCS[key];
      if (!doc) return;
      const win = openDocWindow(mainWindow, doc[0], path.join(__dirname, '..', doc[1]));
      if (!win) dialog.showErrorBox('ProjectDockHub', `Could not open ${doc[1]}.`);
    },
    openVersionsFile: guarded(openVersionsFile),

    about: () => say(`ProjectDockHub ${app.getVersion()}`, 'Run local development projects in Docker without typing commands.\nFree and open source (MIT).'),
  });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// The tray menu lists the running projects and their services. It is renewed a moment after containers change.
let trayTimer = null;
function scheduleTrayRefresh() {
  if (!tray || !tray.updateProjects) return;
  clearTimeout(trayTimer);
  trayTimer = setTimeout(async () => {
    try {
      tray.updateProjects(runningProjects(await listContainers(null)));
    } catch (err) {
      // Docker is off: nothing runs.
      if (tray && !tray.isDestroyed()) tray.updateProjects([]);
    }
  }, 600);
}

// Brings the window back from the tray (or makes a new one if it was really closed).
function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 680,
    minWidth: 780,
    minHeight: 520,
    title: 'ProjectDockHub',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    // Some Linux desktops (GNOME on Wayland) give the window no title bar, so there is no way to move, minimize
    // or close it. Draw our own bar with the three window buttons there.
    ...(process.platform === 'linux'
      ? { frame: false }
      : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      disableBlinkFeatures: 'Auxclick',
    },
  });

  if (process.platform === 'linux') {
    // A drag strip across the top (the sidebar and page start below it). insertCSS is not blocked by the page policy.
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.insertCSS(
        'body{padding-top:34px;box-sizing:border-box}.app{min-height:calc(100vh - 34px)}.sidebar{top:34px!important;height:calc(100vh - 34px)!important}' +
          '.winbar{display:flex!important}',
      ).catch(() => {});
    });
  }

  // Block navigation away from the app page and block new windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // The close button hides the window to the tray. The containers, Docker events and the tray stay.
  mainWindow.on('close', (event) => {
    if (quitting || !tray) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && process.platform === 'win32') {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: 'ProjectDockHub is still running',
        content: 'It is here next to the clock. Right click the icon and choose Exit to close it.',
      });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadFile(INDEX_PATH);
}

// Starting ProjectDockHub again while it runs in the tray brings back the window that is already open.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showWindow();
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  // Deny every web permission request (camera, notifications, openExternal, ...): the app needs none.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  projects.init(dataDir());
  settings.init(dataDir());
  for (const warning of registry.load(path.join(dataDir(), 'versions.json')).warnings) console.warn(warning);
  // Docker Hub versions: the cache is used at once, a refresh runs in the background when it is older than a day.
  versionsReady = registry
    .refresh(path.join(dataDir(), 'versions-cache.json'), () => fetchVersionLists())
    .then((res) => { for (const error of res.errors) console.warn(`Docker Hub versions: ${error}`); })
    .catch((err) => console.warn(`Docker Hub versions: ${err.message}`));
  registerIpcHandlers();
  createWindow();
  setupMenu();
  try {
    tray = createTray({
      show: showWindow,
      quit: () => app.quit(),
      openProject: (name) => {
        showWindow();
        sendToRenderer('menu:action', `open-project:${name}`);
      },
    });
  } catch (err) {
    // Some Linux desktops have no tray. Then the close button quits, as before.
    console.warn(`No tray icon: ${err.message}`);
    tray = null;
  }

  // Container status comes from Docker events, not polling.
  stopEvents = startEvents(
    (change) => {
      sendToRenderer('containers:changed', change);
      scheduleTrayRefresh();
    },
    () => {},
    // Docker went away or came back: the window checks Docker again at once.
    (state) => {
      sendToRenderer('docker:state', state);
      scheduleTrayRefresh();
    },
  );
  scheduleTrayRefresh();

  app.on('activate', () => showWindow());
});

// Exit asks whether Docker should stop too (Settings > Docker engine). Stopping Docker frees the memory it holds.
// The quit waits for the answer and for Docker: the first before-quit is held back, and the app quits for real
// when Docker has answered. "Do not ask again" saves the choice; Settings can turn the question on again.
let dockerShutdown = 'no';
let exitAsked = false;
// The answer to the Exit question: 'stop' or 'keep' (null = not asked, the saved setting decides).
let exitChoice = null;


app.on('before-quit', (event) => {
  // The question first, once per Exit. Cancel keeps the app open.
  if (!exitAsked && dockerShutdown === 'no' && gotSingleInstanceLock && app.isReady() && settings.askOnExit()) {
    event.preventDefault();
    exitAsked = true;
    const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : undefined;
    const options = {
      type: 'question',
      title: 'Exit ProjectDockHub',
      message: 'Turn Docker off too?',
      detail: 'Stop Docker: every container stops and Docker Desktop closes, so it no longer uses memory. Containers of other tools stop too.\n\nKeep Docker running: your projects keep running and can still be opened in the browser.',
      buttons: ['Stop Docker and exit', 'Exit, keep Docker running', 'Cancel'],
      defaultId: settings.stopDockerOnExit() ? 0 : 1,
      cancelId: 2,
      noLink: true,
      checkboxLabel: 'Do not ask again (you can change it in Settings)',
      checkboxChecked: false,
    };
    (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
      .then(({ response, checkboxChecked }) => {
        if (response === 2) {
          exitAsked = false;
          return;
        }
        exitChoice = response === 0 ? 'stop' : 'keep';
        if (checkboxChecked) {
          try {
            settings.setStopDockerOnExit(exitChoice === 'stop');
            settings.setAskOnExit(false);
          } catch (err) {
            console.warn(`Could not save the exit choice: ${err.message}`);
          }
        }
        app.quit();
      })
      .catch(() => {
        exitAsked = false;
      });
    return;
  }

  quitting = true;
  if (stopEvents) {
    stopEvents();
    stopEvents = null;
  }
  const stopDocker = exitChoice ? exitChoice === 'stop' : settings.stopDockerOnExit();
  if (dockerShutdown === 'no' && gotSingleInstanceLock && app.isReady() && stopDocker) {
    dockerShutdown = 'running';
    event.preventDefault();
    if (mainWindow) mainWindow.hide();
    shutDownDocker({ projectNames: projects.listSpecs().map((s) => s.name), stopProject })
      .catch((err) => console.warn(`Could not stop Docker: ${err.message}`))
      .finally(() => {
        dockerShutdown = 'done';
        app.quit();
      });
  } else if (dockerShutdown === 'running') {
    // A second Exit while Docker is still stopping: keep waiting.
    event.preventDefault();
  }
});

// With a tray icon the app stays when its window is hidden. Without one, closing the window quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) {
    app.quit();
  }
});
