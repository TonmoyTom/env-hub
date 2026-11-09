'use strict';

const el = {};
let refreshTimer = null;
let createView = null;
let startView = null;

// Project name -> the progress view that is showing its start.
const progressViews = new Map();

// ---------- Docker status ----------

function clearGuidance() {
  el.guidance.hidden = true;
  el.guidance.textContent = '';
}

function showGuidance(lines) {
  el.guidance.textContent = '';
  for (const text of lines) {
    const p = document.createElement('p');
    p.textContent = text;
    el.guidance.appendChild(p);
  }
  el.guidance.hidden = false;
}

function isDesktopPlatform(platform) {
  return platform === 'darwin' || platform === 'win32';
}

function renderStatus(status) {
  clearGuidance();

  if (status.reason === 'not-found') {
    el.title.textContent = 'Docker is not installed';
    el.detail.textContent = '';
    if (isDesktopPlatform(status.platform)) {
      // Docker Desktop installs both the docker command (CLI) and the engine that runs the containers.
      showGuidance([
        'Docker is not on this computer. Install Docker Desktop, it includes the docker command and the engine:',
        'https://www.docker.com/products/docker-desktop/',
        'On Windows, if Docker Desktop asks to turn on WSL 2, accept it and restart the computer when asked.',
        'Do not want Docker Desktop? Install Rancher Desktop (free): https://rancherdesktop.io/',
        'In Rancher Desktop, set Container Engine to "dockerd (moby)". It gives the docker and docker compose commands that envhub needs.',
        'Open Docker Desktop (or Rancher Desktop) and wait until it says "running", then click Check again.',
      ]);
    } else {
      showGuidance([
        'Install Docker Engine for your Linux distribution.',
        'Guide: https://docs.docker.com/engine/install/',
        'Then click Check again.',
      ]);
    }
    return;
  }

  if (status.reason === 'daemon-not-running') {
    el.title.textContent = 'Docker is installed but not running';
    el.detail.textContent = status.clientVersion || '';
    if (isDesktopPlatform(status.platform)) {
      showGuidance([
        'Open Docker Desktop and wait until it says it is running.',
        'Then click Check again.',
      ]);
    } else {
      showGuidance(['Start the Docker service, then click Check again.']);
    }
    return;
  }

  if (status.reason === 'permission-denied') {
    el.title.textContent = 'Docker needs permission';
    el.detail.textContent = status.clientVersion || '';
    showGuidance([
      'This user account cannot access Docker.',
      'On Linux, your user must be in the docker group. Log out and back in after changing it.',
      'Then click Check again.',
    ]);
    return;
  }

  if (status.reason === 'error' || !status.running) {
    el.title.textContent = 'Could not check Docker';
    el.detail.textContent = '';
    showGuidance(['Something unexpected happened. Click Check again.']);
    return;
  }

  el.title.textContent = 'Docker is running';
  el.detail.textContent = `${status.clientVersion} | Server ${status.serverVersion}`;
}

async function checkDocker() {
  el.button.disabled = true;
  el.title.textContent = 'Checking Docker...';
  el.detail.textContent = '';
  clearGuidance();

  try {
    renderStatus(await window.envhub.checkDocker());
  } catch (err) {
    renderStatus({ reason: 'error', running: false, platform: '' });
  } finally {
    el.button.disabled = false;
  }
}

// ---------- Progress view ----------

function clock(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function timeLeft(seconds) {
  if (seconds < 60) return 'less than a minute';
  return `about ${Math.round(seconds / 60)} min`;
}

function lastLines(text, count = 5) {
  return String(text || '')
    .split('\n')
    .filter((line) => line.trim())
    .slice(-count)
    .join('\n');
}

function makeElement(tag, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// A progress bar, a step list and a clock inside `root`.
// begin() starts the clock, update() takes the events from the main process, finish() stops it.
function createProgressView(root) {
  root.textContent = '';

  const title = makeElement('p', 'progress-title');
  const track = makeElement('div', 'track');
  const fill = makeElement('div', 'fill');
  const detail = makeElement('p', 'muted small progress-detail');
  const time = makeElement('p', 'muted small progress-time');
  const list = makeElement('ol', 'steps');
  const logButton = makeElement('button', 'log-toggle');
  const terminal = makeElement('pre', 'terminal');

  logButton.type = 'button';
  logButton.textContent = 'Logs';
  terminal.hidden = true;
  terminal.setAttribute('aria-label', 'Docker output');
  logButton.addEventListener('click', () => {
    terminal.hidden = !terminal.hidden;
    logButton.textContent = terminal.hidden ? 'Logs' : 'Hide logs';
    terminal.scrollTop = terminal.scrollHeight;
  });

  track.appendChild(fill);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  root.append(title, track, detail, time, logButton, terminal, list);
  const logLines = [];

  let timer = null;
  let startedAt = 0;
  let stepsKey = '';
  let items = [];
  let leftText = '';

  function elapsedSeconds() {
    return Math.floor((Date.now() - startedAt) / 1000);
  }

  function tick() {
    time.textContent = `Elapsed ${clock(elapsedSeconds())}${leftText}`;
  }

  function setPercent(value) {
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    fill.style.width = `${percent}%`;
    track.setAttribute('aria-valuenow', String(percent));
    return percent;
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return {
    begin(text) {
      stop();
      startedAt = Date.now();
      stepsKey = '';
      items = [];
      leftText = '';
      list.textContent = '';
      logLines.length = 0;
      terminal.textContent = '';
      title.textContent = text;
      detail.textContent = '';
      track.className = 'track indeterminate';
      setPercent(0);
      tick();
      timer = setInterval(tick, 1000);
    },

    // A line of text with no steps, for work that happens before the steps are known.
    note(text) {
      detail.textContent = text;
    },

    // Raw Docker output. Only the last 500 lines are kept.
    log(lines) {
      const stick = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 20;
      logLines.push(...lines);
      if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
      terminal.textContent = logLines.join('\n');
      if (stick) terminal.scrollTop = terminal.scrollHeight;
    },

    update(event) {
      const key = event.steps.map((s) => s.id).join(',');
      if (key !== stepsKey) {
        stepsKey = key;
        list.textContent = '';
        items = event.steps.map((step) => {
          const item = makeElement('li');
          item.append(makeElement('span', 'mark'), makeElement('span', 'label'));
          item.lastChild.textContent = step.label;
          list.appendChild(item);
          return item;
        });
      }

      const index = event.steps.findIndex((s) => s.id === event.step);
      items.forEach((item, i) => {
        item.classList.toggle('done', i < index);
        item.classList.toggle('active', i === index);
      });

      const known = typeof event.fraction === 'number';
      const overall = ((index + (known ? event.fraction : 0)) / event.steps.length) * 100;
      track.className = known ? 'track' : 'track indeterminate';
      const percent = setPercent(overall);
      detail.textContent = event.detail || '';

      // Only guess the time left once real progress is known and enough time has passed.
      const seconds = elapsedSeconds();
      leftText = known && percent >= 15 && seconds >= 10
        ? ` · ${timeLeft((seconds * (100 - percent)) / percent)} left`
        : '';
      tick();
    },

    finish(ok, text, message) {
      stop();
      const seconds = elapsedSeconds();
      items.forEach((item) => {
        item.classList.remove('active');
        if (ok) item.classList.add('done');
      });
      title.textContent = text;
      detail.textContent = message || '';
      track.className = ok ? 'track' : 'track failed';
      if (ok) setPercent(100);
      time.textContent = `${ok ? 'Finished in' : 'Stopped after'} ${clock(seconds)}`;
    },
  };
}

// Starts a project and shows the progress in `view`. begin() must have been called already.
async function runStart(name, view, options) {
  progressViews.set(name, view);

  let res;
  try {
    res = await window.envhub.startProject(name, options);
  } catch (err) {
    res = { ok: false, stderr: err.message };
  } finally {
    progressViews.delete(name);
  }

  if (res.ok === false) {
    view.finish(false, `Could not start ${name}`, lastLines(res.stderr) || 'Unknown error');
  } else if (res.alreadyRunning) {
    view.finish(true, `${name} is already running`, '');
  } else {
    view.finish(true, `${name} is ready`, portMoves(res));
  }
  return res;
}

// ---------- Projects ----------

function setActionStatus(text) {
  el.actionStatus.textContent = text;
}

function firstLine(text) {
  return String(text || '').split('\n').find((line) => line.trim()) || '';
}

// Tells the user when a port was changed because it was taken.
function portMoves(res) {
  return (res.changed || [])
    .map((c) => {
      let who = '';
      if (c.usedBy) {
        const label = c.usedBy.project ? `${c.usedBy.project} / ${c.usedBy.name}` : c.usedBy.name;
        who = ` by ${label}${c.usedBy.running ? '' : ' (stopped)'}`;
      }
      return `Port ${c.wanted} is taken${who}, so ${c.service} uses ${c.actual}.`;
    })
    .join(' ');
}

function describeResult(label, name, res) {
  if (!res) return `${label} ${name}: done.`;
  if (res.ok === false) {
    return `${label} failed: ${firstLine(res.stderr) || 'unknown error'}`;
  }
  if (res.skipped) return `${label} ${name}: no containers to change.`;
  if (res.alreadyRunning) return `${name} is already running.`;

  return [`${label} ${name}: done.`, portMoves(res)].filter(Boolean).join(' ');
}

async function runProjectAction(label, method, name) {
  setActionStatus(`${label} ${name}...`);
  try {
    const res = await window.envhub[method](name);
    setActionStatus(describeResult(label, name, res));
  } catch (err) {
    setActionStatus(`${label} failed: ${err.message}`);
  }
  await loadProjects();
  scheduleRefreshContainers();
}

// Start from the project list, with the same progress view the wizard uses.
async function startFromList(name) {
  el.startCard.hidden = false;
  startView.begin(`Starting ${name}`);
  const res = await runStart(name, startView);
  setActionStatus(describeResult('Start', name, res));
  await loadProjects();
  scheduleRefreshContainers();
}

async function openService(name, service, label, say = setActionStatus) {
  try {
    await window.envhub.openProject(name, service);
    say(`Opened ${label} for ${name}.`);
  } catch (err) {
    say(`Could not open ${label}: ${err.message}`);
  }
}

async function deleteProject(name, keepData = false) {
  setActionStatus(`Deleting ${name}...`);
  try {
    const res = await window.envhub.deleteProject(name, { keepData });
    if (res.ok === false) {
      setActionStatus(`Delete failed: ${firstLine(res.stderr) || 'unknown error'}`);
    } else {
      if (res.folderError) {
        setActionStatus(`Deleted ${name}, but its folder could not be deleted: ${res.folder}. Delete it yourself. (${res.folderError})`);
      } else if (res.folderDeleted) {
        setActionStatus(`Deleted ${name} and its folder.${keepData ? ' Database data was kept.' : ''}`);
      } else {
        setActionStatus(`Deleted ${name}.`);
      }
    }
  } catch (err) {
    setActionStatus(`Delete failed: ${err.message}`);
  }
  el.logsCard.hidden = true;
  if (editState.name === name) closeEdit();
  if (linksState.name === name) closeLinks();
  hideCreateCard();
  await loadProjects();
  scheduleRefreshContainers();
}

// Two clicks are needed, so a project is not deleted by accident.
// A confirm() dialog is avoided because it can leave text inputs unfocusable in Electron on Windows.
function armDelete(button, name) {
  if (button.dataset.armed === 'true') {
    const keep = button.parentElement.querySelector('.keep-data input');
    const keepData = Boolean(keep && keep.checked);
    disarmDelete(button);
    deleteProject(name, keepData);
    return;
  }

  button.dataset.armed = 'true';
  button.textContent = 'Confirm delete';
  const label = makeElement('label', 'keep-data');
  const box = document.createElement('input');
  box.type = 'checkbox';
  label.append(box, document.createTextNode(' Keep database data'));
  button.after(label);
  setActionStatus(`Click Confirm delete to remove ${name}. The containers, the database data and the project folder with all your files are deleted, unless you tick Keep database data. This cannot be undone.`);
  setTimeout(() => disarmDelete(button), 8000);
}

function disarmDelete(button) {
  button.dataset.armed = 'false';
  button.textContent = 'Delete';
  const label = button.parentElement && button.parentElement.querySelector('.keep-data');
  if (label) label.remove();
}

function showPanel(title, text) {
  el.logsCard.hidden = false;
  el.logsTitle.textContent = title;
  el.logsOutput.textContent = text;
  el.copyEnvDocker.hidden = true;
  el.copyEnvHost.hidden = true;
  el.writeEnvDocker.hidden = true;
  el.writeEnvHost.hidden = true;
  el.logsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function showLogs(name) {
  showPanel(`Logs: ${name}`, 'Loading...');
  try {
    const text = await window.envhub.projectLogs(name);
    el.logsOutput.textContent = text.trim() ? text : 'No logs yet.';
  } catch (err) {
    el.logsOutput.textContent = `Could not load logs: ${err.message}`;
  }
}

// Database, Redis and mail credentials, plus the .env lines, shown in the same panel the logs use.
let connectionName = '';

async function showConnection(name) {
  showPanel(`Credentials & .env: ${name}`, 'Loading...');
  connectionName = name;
  try {
    el.logsOutput.textContent = await window.envhub.projectConnection(name);
    el.copyEnvDocker.hidden = false;
    el.copyEnvHost.hidden = false;
    el.writeEnvDocker.hidden = false;
    el.writeEnvHost.hidden = false;
    el.copyEnvDocker.textContent = 'Copy .env (Docker)';
    el.copyEnvHost.textContent = 'Copy .env (my computer)';
  } catch (err) {
    el.logsOutput.textContent = `Could not load connection info: ${err.message}`;
  }
}

// Copies only the .env lines (no comments) to the clipboard, so they can be pasted into .env as they are.
// `target` is 'docker' (app runs in Docker) or 'host' (app runs on this computer).
// Writes the .env into the project folder. The answer says what happened and where the backup went.
async function writeEnvToFolder(target) {
  if (!connectionName) return;
  try {
    const res = await window.envhub.writeEnv(connectionName, target);
    const say = { created: 'Created', updated: 'Updated', unchanged: 'Already up to date:' }[res.status];
    const backup = res.backup ? `\nThe old .env was saved as ${res.backup}` : '';
    setActionStatus(`${say} ${res.file}${backup}`);
  } catch (err) {
    setActionStatus(`Could not write .env: ${err.message || err}`);
  }
}

async function copyEnvFile(button, target, label) {
  if (!connectionName) return;
  try {
    const text = await window.envhub.projectEnv(connectionName, target);
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch (err) {
    el.logsOutput.textContent = `Could not copy. Select the text below and copy it yourself.\n\n${err.message || err}`;
    return;
  }
  setTimeout(() => { button.textContent = label; }, 2000);
}

const STATUS_TEXT = { running: 'Running', partly: 'Partly running', stopped: 'Stopped' };

function portText(ports) {
  return ports.map((p) => `${p.service}: localhost:${p.host}`).join('  ·  ');
}

function addButton(parent, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', onClick);
  parent.appendChild(button);
  return button;
}

async function loadProjects() {
  const projects = await window.envhub.listProjects();
  el.projectList.textContent = '';

  for (const project of projects) {
    const row = makeElement('div', 'row');
    const info = document.createElement('div');

    const name = makeElement('div', 'row-name');
    name.textContent = `${project.name} · ${project.label}`;

    // On / off badge: green = running, amber = some containers up, grey = stopped.
    const state = STATUS_TEXT[project.state] ? project.state : 'stopped';
    const badge = makeElement('span', `status status-${state}`);
    badge.textContent = `● ${STATUS_TEXT[state]}`;
    name.append(' ', badge);

    const ports = makeElement('div', 'muted small');
    ports.textContent = portText(project.ports);

    info.append(name, ports);

    const actions = makeElement('div', 'row-actions');
    addButton(actions, 'Start', () => startFromList(project.name));
    addButton(actions, 'Stop', () => runProjectAction('Stop', 'stopProject', project.name));
    addButton(actions, 'Restart', () => runProjectAction('Restart', 'restartProject', project.name));
    addButton(actions, 'Open', () => runProjectAction('Open', 'openProject', project.name));
    addButton(actions, 'Folder', () => runProjectAction('Folder', 'openFolder', project.name));
    if (['nestjs', 'nextjs', 'vue', 'nuxt'].includes(project.stack)) {
      const editorButton = addButton(actions, 'Packages for editor', () => runProjectAction('Install packages for the editor (a few minutes)', 'installPackages', project.name));
      editorButton.title = 'Installs node_modules into the project folder so VS Code can find the types. The app itself keeps its own fast copy in Docker.';
    }
    addButton(actions, 'Logs', () => showLogs(project.name));
    addButton(actions, 'Credentials & .env', () => showConnection(project.name));
    addButton(actions, 'Links & commands', () => openLinks(project.name));
    if (project.editable) {
      addButton(actions, 'Edit services', () => openEdit(project.name));
    }

    const pages = [['phpmyadmin', 'phpMyAdmin'], ['adminer', 'Adminer'], ['mailpit', 'Mailpit']];
    for (const [service, label] of pages) {
      if (project.services.includes(service)) {
        addButton(actions, label, () => openService(project.name, service, label));
      }
    }

    const deleteButton = addButton(actions, 'Delete', () => armDelete(deleteButton, project.name));

    row.append(info, actions);
    el.projectList.appendChild(row);
  }
}

// ---------- New project wizard ----------

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const STAGES = ['name', 'setup', 'create'];

let VERSIONS = {
  laravel: [['8.3', 'PHP 8.3'], ['8.2', 'PHP 8.2'], ['8.1', 'PHP 8.1']],
  nestjs: [['22', 'Node 22'], ['20', 'Node 20']],
  nextjs: [['22', 'Node 22'], ['20', 'Node 20']],
  vue: [['22', 'Node 22'], ['20', 'Node 20']],
  nuxt: [['22', 'Node 22'], ['20', 'Node 20']],
  docker: [],
};
const OPTION_KEYS = ['mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit', 'node'];

// Versions of the database services, and the lists for PHP and Node. They come from the main process
// (config/versions.json plus the user's versions.json), so a new version never needs a code change here.
const DB_VERSION_KEYS = ['mysql', 'postgres', 'mongodb', 'redis'];
let registry = null;

function applyRegistry(data) {
  registry = data;
  const nodeList = data.node.versions.map((v) => [v, `Node ${v}`]);
  VERSIONS = {
    laravel: data.php.versions.map((v) => [v, `PHP ${v}`]),
    nestjs: nodeList,
    nextjs: nodeList,
    vue: nodeList,
    nuxt: nodeList,
    docker: [],
  };
  for (const key of DB_VERSION_KEYS) fillVersionSelect(document.getElementById(`ver-${key}`), key, data[key].default);
  const warnings = data.warnings || [];
  el.versionsWarning.textContent = warnings.join(' ');
  el.versionsWarning.hidden = warnings.length === 0;
}

// Fills a version dropdown. `current` is kept in the list even when it is no longer offered.
function fillVersionSelect(select, key, current) {
  if (!select || !registry) return;
  const versions = [...registry[key].versions];
  if (current && !versions.includes(current)) versions.push(current);
  select.textContent = '';
  for (const version of versions) {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    select.appendChild(option);
  }
  select.value = current || registry[key].default;
}

async function loadRegistry() {
  try {
    applyRegistry(await window.envhub.getVersions());
  } catch (err) {
    registry = null;
  }
}

// Which services each stack offers, and which are ticked at first.
// NestJS and Next.js start as Node only, so every service there is the user's choice.
const NODE_SERVICES = ['mysql', 'postgres', 'mongodb', 'redis', 'phpmyadmin', 'adminer', 'mailpit'];
const NODE_NOTE = 'Node only unless you tick something. MongoDB has no web page here, use MongoDB Compass.';
const STACK_OPTIONS = {
  laravel: ['mysql', 'redis', 'phpmyadmin', 'mailpit', 'node'],
  nestjs: NODE_SERVICES,
  nextjs: NODE_SERVICES,
  vue: NODE_SERVICES,
  nuxt: NODE_SERVICES,
  docker: NODE_SERVICES,
};
const DEFAULT_OPTIONS = {
  laravel: ['mysql', 'redis', 'phpmyadmin', 'node'],
  nestjs: [],
  nextjs: [],
  vue: [],
  nuxt: [],
  docker: [],
};
const OPTIONS_LEGEND = {
  laravel: 'Services (nginx and PHP are always included)',
  nestjs: 'Services (Node is always included)',
  nextjs: 'Services (Node is always included)',
  vue: 'Services (Node is always included)',
  nuxt: 'Services (Node is always included)',
  docker: 'Extra services (your image is always included)',
};
const OPTIONS_NOTE = {
  laravel: '',
  nestjs: NODE_NOTE,
  nextjs: NODE_NOTE,
  vue: NODE_NOTE,
  nuxt: NODE_NOTE,
  docker: 'Your project folder is mounted at /app. Leave the port empty to pick one automatically (your app gets it as PORT). Without a start command the container just stays open, so you can run your code inside it.',
};

// What the user chose, kept while the three steps are shown.
const wizard = { name: '', input: null, created: false, mode: 'new', folder: '' };

function optionBox(key) {
  return document.getElementById(`opt-${key}`);
}

function showStage(stage) {
  el.stageName.hidden = stage !== 'name';
  el.stageSetup.hidden = stage !== 'setup';
  el.stageCreate.hidden = stage !== 'create';

  const at = STAGES.indexOf(stage);
  for (const item of el.stageItems) {
    const position = STAGES.indexOf(item.dataset.stage);
    item.classList.toggle('active', position === at);
    item.classList.toggle('done', position < at);
  }
}

const INSTALL_LABELS = { laravel: 'Laravel', nestjs: 'NestJS', nextjs: 'Next.js', vue: 'Vue.js', nuxt: 'Nuxt.js' };

// Fills the version list and shows the services that fit the chosen stack.
function syncStackForm() {
  const stack = el.newStack.value;

  const isDocker = stack === 'docker';
  el.newVersion.hidden = isDocker;
  el.dockerFields.hidden = !isDocker;
  el.dockerError.hidden = true;

  el.newVersion.textContent = '';
  for (const [value, label] of VERSIONS[stack]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    el.newVersion.appendChild(option);
  }

  for (const key of OPTION_KEYS) {
    const box = optionBox(key);
    box.parentElement.hidden = !STACK_OPTIONS[stack].includes(key);
    box.checked = DEFAULT_OPTIONS[stack].includes(key);
  }
  if (!isDocker) {
  el.installYesText.textContent = `Yes: install a fresh ${INSTALL_LABELS[stack] || ''} app (official generator, no placeholder ${stack === 'laravel' ? 'page' : 'server.js'})`;
  el.installNoText.textContent = stack === 'laravel'
    ? 'No: simple placeholder page (public/index.php), I will put my own app in'
    : 'No: simple placeholder server.js, I will edit it myself';
  }
  // A Docker image has nothing to install, and an empty folder would not start. So no question there.
  el.installChoice.hidden = wizard.mode === 'existing' || isDocker;
  syncPythonRow();
  el.optionsLegend.textContent = OPTIONS_LEGEND[stack];
  el.optionsNote.textContent = OPTIONS_NOTE[stack];
  el.optionsNote.hidden = !OPTIONS_NOTE[stack];
  renderSuggestions();
}

// ---------- Suggested and extra services ----------

// Ready made extras. Clicking a suggestion fills a row with these values, and the user can change them.
const CATALOG = {
  mariadb: {
    label: 'MariaDB', image: 'mariadb:11', ports: '3306',
    env: 'MARIADB_ROOT_PASSWORD=root\nMARIADB_DATABASE=app\nMARIADB_USER=app\nMARIADB_PASSWORD=app',
  },
  rabbitmq: { label: 'RabbitMQ', image: 'rabbitmq:3-management', ports: '5672,15672' },
  memcached: { label: 'Memcached', image: 'memcached:1.6', ports: '11211' },
  elasticsearch: {
    label: 'Elasticsearch', image: 'docker.elastic.co/elasticsearch/elasticsearch:8.15.0', ports: '9200',
    env: 'discovery.type=single-node\nxpack.security.enabled=false\nES_JAVA_OPTS=-Xms512m -Xmx512m',
  },
  meilisearch: { label: 'Meilisearch', image: 'getmeili/meilisearch:v1.10', ports: '7700', env: 'MEILI_ENV=development' },
  minio: {
    label: 'MinIO (file storage)', image: 'minio/minio:latest', ports: '9000,9001',
    env: 'MINIO_ROOT_USER=minioadmin\nMINIO_ROOT_PASSWORD=minioadmin',
    command: 'server /data --console-address :9001',
  },
};
const BUILTIN_LABELS = {
  mysql: 'MySQL', postgres: 'PostgreSQL', mongodb: 'MongoDB', redis: 'Redis',
  phpmyadmin: 'phpMyAdmin', adminer: 'Adminer', mailpit: 'Mailpit',
};

// What projects of each kind usually need. Ids are either a tick box above or a CATALOG entry.
const SUGGEST_BY_STACK = {
  laravel: ['redis', 'mailpit', 'meilisearch', 'minio', 'memcached', 'elasticsearch'],
  nestjs: ['postgres', 'redis', 'rabbitmq', 'mongodb', 'minio', 'elasticsearch'],
  nextjs: ['postgres', 'redis', 'meilisearch', 'minio', 'mailpit'],
  nuxt: ['postgres', 'redis', 'meilisearch', 'minio', 'mailpit'],
  vue: [],
};
const SUGGEST_BY_IMAGE = [
  [/python|django|flask|fastapi/, ['postgres', 'redis', 'rabbitmq', 'mailpit', 'minio', 'elasticsearch']],
  [/node|bun|deno/, ['mongodb', 'postgres', 'redis', 'rabbitmq', 'minio']],
  [/golang|\bgo\b/, ['postgres', 'redis', 'rabbitmq', 'minio']],
  [/ruby|rails/, ['postgres', 'redis', 'memcached', 'mailpit']],
  [/php/, ['mysql', 'redis', 'mailpit', 'meilisearch', 'memcached']],
  [/java|openjdk|temurin|maven|gradle|spring/, ['postgres', 'mysql', 'rabbitmq', 'elasticsearch', 'redis']],
  [/dotnet|aspnet/, ['postgres', 'redis', 'rabbitmq', 'mailpit']],
  [/rust/, ['postgres', 'redis', 'rabbitmq']],
];
const SUGGEST_DEFAULT = ['postgres', 'mysql', 'redis', 'mailpit'];
const MAX_EXTRA_ROWS = 8;

// Variables an image needs before it starts (passwords, database names, modes).
// The first pattern that matches the image name is used. Images not listed here get no menu fields.
// `value` is the default shown in the menu. Empty values are not written.
const ENV_TEMPLATES = [
  [/mariadb/, [
    { key: 'MARIADB_ROOT_PASSWORD', label: 'Root password', value: 'root' },
    { key: 'MARIADB_DATABASE', label: 'Database name', value: 'app' },
    { key: 'MARIADB_USER', label: 'User', value: 'app' },
    { key: 'MARIADB_PASSWORD', label: 'User password', value: 'app' },
  ]],
  [/mysql/, [
    { key: 'MYSQL_ROOT_PASSWORD', label: 'Root password', value: 'root' },
    { key: 'MYSQL_DATABASE', label: 'Database name', value: 'app' },
    { key: 'MYSQL_USER', label: 'User', value: 'app' },
    { key: 'MYSQL_PASSWORD', label: 'User password', value: 'app' },
  ]],
  [/postgres/, [
    { key: 'POSTGRES_USER', label: 'User', value: 'app' },
    { key: 'POSTGRES_PASSWORD', label: 'Password', value: 'app' },
    { key: 'POSTGRES_DB', label: 'Database name', value: 'app' },
  ]],
  [/mongo/, [
    { key: 'MONGO_INITDB_ROOT_USERNAME', label: 'Root user', value: 'app' },
    { key: 'MONGO_INITDB_ROOT_PASSWORD', label: 'Root password', value: 'app' },
  ]],
  [/rabbitmq/, [
    { key: 'RABBITMQ_DEFAULT_USER', label: 'User', value: 'app' },
    { key: 'RABBITMQ_DEFAULT_PASS', label: 'Password', value: 'app' },
  ]],
  [/minio/, [
    { key: 'MINIO_ROOT_USER', label: 'Root user', value: 'minioadmin' },
    { key: 'MINIO_ROOT_PASSWORD', label: 'Root password', value: 'minioadmin' },
  ]],
  [/meilisearch/, [
    { key: 'MEILI_MASTER_KEY', label: 'Master key (empty = no key)', value: '' },
    { key: 'MEILI_ENV', label: 'Mode', value: 'development' },
  ]],
  [/elasticsearch/, [
    { key: 'discovery.type', label: 'Discovery type', value: 'single-node' },
    { key: 'xpack.security.enabled', label: 'Security (true/false)', value: 'false' },
  ]],
];

function envTemplateFor(image) {
  const name = (image || '').trim().toLowerCase();
  const hit = ENV_TEMPLATES.find(([pattern]) => pattern.test(name));
  return hit ? hit[1] : [];
}

// Reads KEY=value lines into an object. Lines without "=" are ignored here (the server reports them).
function parseEnvLines(text) {
  const values = {};
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf('=');
    if (at < 1) continue;
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

// Replaces the menu's variables in the text box and keeps every other line as it was.
// An empty menu value removes that variable.
function mergeEnvLines(text, fields) {
  const keys = new Set(fields.map((field) => field.key));
  const kept = (text || '').split(/\r?\n/).filter((raw) => {
    const line = raw.trim();
    const at = line.indexOf('=');
    return line === '' || at < 1 || !keys.has(line.slice(0, at).trim());
  });
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  for (const field of fields) {
    if (field.value !== '') kept.push(`${field.key}=${field.value}`);
  }
  return kept.join('\n');
}

// Fills the menu of one service row from its image and the variables already in its text box.
function renderEnvMenu(panel, image, envBox) {
  const template = envTemplateFor(image);
  const current = parseEnvLines(envBox.value);
  panel.textContent = '';

  if (template.length === 0) {
    const note = makeElement('p', 'muted small');
    note.textContent = 'No known variables for this image. Type them in the box below (KEY=value, one per line).';
    panel.appendChild(note);
    return;
  }

  const title = makeElement('p', 'small');
  title.textContent = 'Fill in what this image needs. Values are written to the box below when you press Apply.';
  panel.appendChild(title);

  for (const item of template) {
    const field = makeElement('label', 'env-menu-field');
    const name = makeElement('span', 'small');
    name.textContent = `${item.label}  (${item.key})`;
    const input = serviceInput('input', 'env-menu-input', item.key, item.key in current ? current[item.key] : item.value);
    input.dataset.key = item.key;
    field.append(name, input);
    panel.appendChild(field);
  }

  const apply = makeElement('button', 'env-menu-apply');
  apply.type = 'button';
  apply.textContent = 'Apply';
  apply.addEventListener('click', () => {
    const fields = [...panel.querySelectorAll('.env-menu-input')].map((input) => ({
      key: input.dataset.key,
      value: input.value.trim(),
    }));
    envBox.value = mergeEnvLines(envBox.value, fields);
    panel.hidden = true;
  });
  panel.appendChild(apply);
}

function suggestionIds() {
  const stack = el.newStack.value;
  if (stack !== 'docker') return SUGGEST_BY_STACK[stack] || [];
  const image = el.dockerImage.value.trim().toLowerCase();
  if (!image) return SUGGEST_DEFAULT;
  const hit = SUGGEST_BY_IMAGE.find(([pattern]) => pattern.test(image));
  return hit ? hit[1] : SUGGEST_DEFAULT;
}

function extraRowIds() {
  return [...el.extraServices.children].map((row) => row.dataset.catalog);
}

// Shows a button for each suggestion that is not already ticked or added.
function renderSuggestions() {
  const stack = el.newStack.value;
  const ticks = STACK_OPTIONS[stack] || [];
  const added = extraRowIds();
  el.suggestionChips.textContent = '';

  for (const id of suggestionIds()) {
    const builtin = ticks.includes(id);
    if (builtin && optionBox(id).checked) continue;
    if (!builtin && (!CATALOG[id] || added.includes(id))) continue;

    const label = builtin ? BUILTIN_LABELS[id] : CATALOG[id].label;
    const chip = makeElement('button', 'chip');
    chip.type = 'button';
    chip.textContent = `+ ${label}`;
    chip.addEventListener('click', () => {
      if (builtin) {
        optionBox(id).checked = true;
        syncOptionDependencies(id);
      } else {
        addServiceRow(CATALOG[id], id);
      }
      renderSuggestions();
    });
    el.suggestionChips.appendChild(chip);
  }
  el.suggestions.hidden = el.suggestionChips.children.length === 0;
}

function serviceInput(tag, className, placeholder, value) {
  const input = makeElement(tag, className);
  if (tag === 'input') input.type = 'text';
  if (tag === 'textarea') input.rows = 2;
  input.placeholder = placeholder;
  input.value = value || '';
  input.autocomplete = 'off';
  return input;
}

// `container` is the list the row goes into: the New project form, or the Edit services form.
// A row of a service that already exists carries its name, so the server keeps that name.
function addServiceRow(preset = {}, catalogId = '', container = el.extraServices) {
  if (container.children.length >= MAX_EXTRA_ROWS) return;

  const row = makeElement('div', 'service-row');
  row.dataset.catalog = catalogId;
  if (preset.name) {
    row.dataset.name = preset.name;
    row.dataset.original = preset.image || '';
  }

  const top = makeElement('div', 'field-row');
  const remove = makeElement('button', '');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    row.remove();
    if (container === el.extraServices) renderSuggestions();
  });
  const image = serviceInput('input', 'svc-image', 'search Docker Hub, e.g. rabbitmq', preset.image);
  const tag = makeElement('select', 'svc-tag');
  tag.hidden = true;
  tag.setAttribute('aria-label', 'Tag');
  const envBox = serviceInput('textarea', 'svc-env', 'environment variables, one KEY=value per line (optional)', preset.env);

  // Env menu: fills the variables this image needs, written into the environment box.
  const envPanel = makeElement('div', 'env-menu');
  envPanel.hidden = true;
  const envToggle = makeElement('button', 'env-menu-toggle');
  envToggle.type = 'button';
  envToggle.textContent = 'Credentials';
  envToggle.title = 'Fill in the passwords and names this image needs';
  envToggle.addEventListener('click', () => {
    if (envPanel.hidden) renderEnvMenu(envPanel, resolvedImage(image, tag), envBox);
    envPanel.hidden = !envPanel.hidden;
  });

  top.append(image, tag, serviceInput('input', 'svc-ports', 'ports, e.g. 5672,15672', preset.ports), envToggle, remove);

  const list = makeElement('ul', 'suggestions plain');
  list.hidden = true;
  const hint = makeElement('p', 'muted small');
  const error = makeElement('p', 'error small svc-error');
  error.hidden = true;
  createImagePicker({ input: image, tagSelect: tag, list, hint, onChange: () => { error.hidden = true; } });

  row.append(
    top,
    list,
    hint,
    error,
    envPanel,
    envBox,
    serviceInput('input', 'svc-command', 'start command (optional)', preset.command),
  );
  container.appendChild(row);
  if (!catalogId && !preset.image) row.querySelector('.svc-image').focus();
}

// The rows the user filled in. Empty rows are skipped. The server checks every value.
function collectExtras(container = el.extraServices) {
  return [...container.children]
    .map((row) => {
      const extra = {
        image: resolvedImage(row.querySelector('.svc-image'), row.querySelector('.svc-tag')),
        ports: row.querySelector('.svc-ports').value.trim(),
        env: row.querySelector('.svc-env').value,
        command: row.querySelector('.svc-command').value.trim(),
      };
      if (row.dataset.name) extra.name = row.dataset.name;
      return extra;
    })
    .filter((extra) => extra.image !== '');
}

// ---------- Docker Hub search ----------

// Adds Docker Hub search to an image text box: suggestions while typing, then a tag list.
// `input` is the text box, `tagSelect` the tag dropdown, `list` the suggestions, `hint` a small text line.
function createImagePicker({ input, tagSelect, list, hint, onChange }) {
  let timer = null;
  let seq = 0;

  function hide() {
    list.hidden = true;
    list.textContent = '';
  }

  function choose(name) {
    seq += 1;
    input.value = name;
    hide();
    hint.textContent = '';
    loadTags(name);
    if (onChange) onChange();
  }

  function show(items) {
    list.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.tabIndex = 0;

      const title = makeElement('strong', '');
      title.textContent = item.name;
      const meta = makeElement('span', 'muted small');
      meta.textContent = `${item.official ? '  official' : ''}  ★ ${item.stars}`;
      const desc = makeElement('div', 'muted small');
      desc.textContent = item.description;

      li.append(title, meta, desc);
      li.addEventListener('mousedown', (event) => { event.preventDefault(); choose(item.name); });
      li.addEventListener('keydown', (event) => { if (event.key === 'Enter') choose(item.name); });
      list.appendChild(li);
    }
    list.hidden = items.length === 0;
  }

  async function search() {
    const query = input.value.trim();
    const mine = ++seq;

    if (query.length < 2 || query.includes(':')) {
      hide();
      hint.textContent = '';
      return;
    }

    hint.textContent = 'Searching Docker Hub...';
    try {
      const items = await window.envhub.hubSearch(query);
      if (mine !== seq) return;
      show(items);
      hint.textContent = items.length === 0 ? 'No images found on Docker Hub for this name.' : '';
    } catch (err) {
      if (mine !== seq) return;
      hide();
      hint.textContent = `${err.message} You can still type an image name yourself.`;
    }
  }

  async function loadTags(image) {
    tagSelect.hidden = true;
    tagSelect.textContent = '';
    try {
      const tags = await window.envhub.hubTags(image);
      if (input.value.trim() !== image || tags.length === 0) return;
      for (const tag of tags) {
        const option = document.createElement('option');
        option.value = tag;
        option.textContent = tag;
        tagSelect.appendChild(option);
      }
      tagSelect.hidden = false;
    } catch (err) {
      // Tags are optional. Without them the image uses its latest tag.
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    tagSelect.hidden = true;
    timer = setTimeout(search, 350);
    if (onChange) onChange();
  });
  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// The image to use: the text, plus the chosen tag when the text has none.
function resolvedImage(input, tagSelect) {
  const image = input.value.trim();
  if (image && !image.includes(':') && !tagSelect.hidden && tagSelect.value) {
    return `${image}:${tagSelect.value}`;
  }
  return image;
}

// Asks Docker Hub if the image exists. Only a clear "not found" blocks. Returns an error text or ''.
async function imageProblem(image) {
  try {
    const found = await window.envhub.hubCheck(image);
    if (found === false) {
      return `"${image}" was not found on Docker Hub. Pick one from the suggestions, or check the name and tag.`;
    }
  } catch (err) {
    // If the check itself fails, let the user go on.
  }
  return '';
}

// phpMyAdmin needs MySQL. Adminer needs MySQL or PostgreSQL.
function syncOptionDependencies(changedKey) {
  const on = (key) => optionBox(key).checked;

  if (changedKey === 'phpmyadmin' && on('phpmyadmin')) {
    optionBox('mysql').checked = true;
  }
  if (changedKey === 'adminer' && on('adminer') && !on('mysql') && !on('postgres')) {
    optionBox('mysql').checked = true;
  }
  if (!on('mysql')) {
    optionBox('phpmyadmin').checked = false;
  }
  if (!on('mysql') && !on('postgres')) {
    optionBox('adminer').checked = false;
  }
}

// Languages that have a "keep installed packages" volume. Same list as PACKAGE_RULES in main/stacks/docker.js.
const PACKAGE_LANGUAGES = [
  [/^python(:|$)/, 'Python'], [/^node(:|$)/, 'Node.js'], [/^golang(:|$)/, 'Go'],
  [/^rust(:|$)/, 'Rust'], [/^maven(:|$)/, 'Java (Maven)'], [/^ruby(:|$)/, 'Ruby'],
];

// The keep-packages choice shows only for an image of one of those languages.
function syncPythonRow() {
  const image = resolvedImage(el.dockerImage, el.dockerTag).toLowerCase();
  const hit = PACKAGE_LANGUAGES.find(([pattern]) => pattern.test(image));
  el.keepPackagesRow.hidden = !(el.newStack.value === 'docker' && hit);
  if (hit) el.keepPackagesText.textContent = hit[1];
}

// Shows where new projects are saved, and lets the user change it.
function showProjectsDir(info) {
  el.projectsDir.textContent = info.projectsDir;
  el.resetProjectsDir.hidden = info.isDefault;
}

async function loadProjectsDir() {
  try {
    showProjectsDir(await window.envhub.getSettings());
  } catch (err) {
    el.projectsDir.textContent = '(unknown)';
  }
}

async function changeProjectsDir(reset) {
  try {
    showProjectsDir(await (reset ? window.envhub.resetProjectsDir() : window.envhub.chooseProjectsDir()));
    el.nameError.hidden = true;
  } catch (err) {
    el.nameError.textContent = ipcMessage(err);
    el.nameError.hidden = false;
  }
}

function sourceMode() {
  return document.querySelector('input[name="project-source"]:checked').value;
}

// Existing project: shows the folder fields, and takes "Docker image" out of the stack list (it needs no folder scan).
function syncSourceForm() {
  const existing = sourceMode() === 'existing';
  wizard.mode = existing ? 'existing' : 'new';
  el.existingFields.hidden = !existing;
  el.projectsDirRow.hidden = existing;
  el.projectsDirNote.hidden = existing;
}

// Reads the folder, fills the name and picks the stack and version it found. Returns false and shows why when it cannot.
async function prepareExisting() {
  const typed = el.existingFolder.value.trim();
  wizard.mode = 'existing';
  try {
    const found = await window.envhub.detectProject(typed);
    wizard.folder = found.folder;
    if (!el.newName.value.trim()) el.newName.value = found.name;
    if (found.stack === 'docker' && found.language) {
      el.newStack.value = 'docker';
      wizard.detectedNote = `Found a ${found.language.label} project. ${found.language.note}`;
    } else if (found.stack) {
      el.newStack.value = found.stack;
      wizard.detectedNote = `Found a ${INSTALL_LABELS[found.stack]} project.`;
    } else {
      wizard.detectedNote = 'Could not tell the language from this folder. Pick the stack, or a Docker image, yourself.';
    }
    syncStackForm();
    if (found.stack === 'docker' && found.language) {
      el.dockerImage.value = found.language.image;
      el.dockerPort.value = found.language.port;
      el.dockerCommand.value = found.language.command;
      renderSuggestions();
    }
    if (found.version) el.newVersion.value = found.version;
    el.optionsNote.textContent = `${wizard.detectedNote} ${el.optionsNote.textContent}`.trim();
    el.optionsNote.hidden = false;
    return true;
  } catch (err) {
    wizard.mode = 'new';
    el.nameError.textContent = ipcMessage(err);
    el.nameError.hidden = false;
    return false;
  }
}

async function pickFolder() {
  try {
    const folder = await window.envhub.pickFolder();
    if (folder) el.existingFolder.value = folder;
  } catch (err) {
    el.nameError.textContent = ipcMessage(err);
    el.nameError.hidden = false;
  }
}

async function submitName(event) {
  event.preventDefault();
  let name = el.newName.value.trim();
  const existing = sourceMode() === 'existing';

  if (existing) {
    const ok = await prepareExisting();
    if (!ok) return;
    name = el.newName.value.trim();
  }

  if (!NAME_RE.test(name)) {
    el.nameError.textContent = 'Use lowercase letters, numbers and dashes, starting with a letter (up to 40 characters).';
    el.nameError.hidden = false;
    return;
  }

  // A project or a leftover folder with this name would stop the create later, so say it now.
  try {
    const info = await window.envhub.checkName(name);
    if (info.projectExists) {
      el.nameError.textContent = `A project named "${name}" already exists. Pick another name.`;
      el.nameError.hidden = false;
      return;
    }
    if (info.folderExists && !existing) {
      el.nameError.textContent = `A folder named "${name}" already exists in ${info.folder.replace(/[\\/][^\\/]*$/, '')}. Pick another name, or delete that folder first.`;
      el.nameError.hidden = false;
      return;
    }
  } catch (err) {
    // If the check itself fails, let the user go on. The create step checks again.
  }

  el.nameError.hidden = true;
  wizard.mode = existing ? 'existing' : 'new';
  wizard.name = name;
  if (existing) syncStackForm();
  el.setupName.textContent = name;
  showStage('setup');
}

async function submitSetup(event) {
  event.preventDefault();
  const stack = el.newStack.value;

  const options = {};
  for (const key of STACK_OPTIONS[stack]) {
    options[key] = optionBox(key).checked;
  }

  wizard.input = { name: wizard.name, stack, version: el.newVersion.value, options };

  if (stack === 'docker') {
    const image = resolvedImage(el.dockerImage, el.dockerTag);
    const portText = el.dockerPort.value.trim();
    const port = portText === '' ? null : Number(portText);
    if (!image || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) {
      el.dockerError.textContent = 'Enter an image name (like python:3.12). The port must be a number from 1 to 65535, or empty.';
      el.dockerError.hidden = false;
      return;
    }
    const problem = await imageProblem(image);
    if (problem) {
      el.dockerError.textContent = problem;
      el.dockerError.hidden = false;
      return;
    }
    el.dockerError.hidden = true;
    wizard.input = {
      name: wizard.name,
      stack,
      image,
      containerPort: port === null ? '' : port,
      command: el.dockerCommand.value.trim(),
      keepPackages: !el.keepPackagesRow.hidden && el.keepPackages.checked,
      options,
    };
  }
  wizard.input.install = wizard.mode !== 'existing' && stack !== 'docker' && document.querySelector('input[name="install-app"]:checked').value === 'yes';
  if (wizard.mode === 'existing') wizard.input.folder = wizard.folder;
  wizard.input.extraServices = collectExtras();
  wizard.input.versions = {};
  for (const key of DB_VERSION_KEYS) {
    const box = optionBox(key);
    const select = document.getElementById(`ver-${key}`);
    if (box && box.checked && select && select.value) wizard.input.versions[key] = select.value;
  }
  wizard.input.dbName = el.newDbName.value.trim();
  wizard.input.dbUser = el.newDbUser.value.trim();
  wizard.input.dbPassword = el.newDbPass.value.trim();

  // Every extra image is checked, and the first wrong one is shown next to its row.
  for (const row of el.extraServices.children) {
    const image = resolvedImage(row.querySelector('.svc-image'), row.querySelector('.svc-tag'));
    const error = row.querySelector('.svc-error');
    error.hidden = true;
    if (!image) continue;
    const problem = await imageProblem(image);
    if (problem) {
      error.textContent = problem;
      error.hidden = false;
      return;
    }
  }
  wizard.created = false;
  runCreate();
}

// Shows the buttons that fit the result of the last step.
function showCreateResult(ok) {
  el.createActions.hidden = false;
  el.createOpen.hidden = !ok;
  el.createConnection.hidden = !ok;
  el.createRetry.hidden = ok || !wizard.created;
  el.createAnother.textContent = ok ? 'Create another project' : 'Start over';
}

async function runCreate() {
  const { name, input } = wizard;

  showStage('create');
  el.createActions.hidden = true;
  el.createMessage.textContent = '';

  createView.begin(`Setting up ${name}`);
  createView.note(wizard.mode === 'existing' ? 'Adding your project' : 'Creating the project folder');

  // The installer's output arrives as project logs under this name.
  progressViews.set(name, createView);
  try {
    await (wizard.mode === 'existing' ? window.envhub.importProject(input) : window.envhub.createProject(input));
    wizard.created = true;
  } catch (err) {
    progressViews.delete(name);
    createView.finish(false, 'Could not create the project', err.message);
    showCreateResult(false);
    return;
  }
  progressViews.delete(name);

  await loadProjects();
  const res = await runStart(name, createView);
  await loadProjects();
  scheduleRefreshContainers();
  showCreateResult(res.ok !== false);
}

async function retryStart() {
  el.createActions.hidden = true;
  el.createMessage.textContent = '';
  createView.begin(`Starting ${wizard.name}`);
  const res = await runStart(wizard.name, createView);
  await loadProjects();
  scheduleRefreshContainers();
  showCreateResult(res.ok !== false);
}

function createAnother() {
  el.newName.value = '';
  el.existingFolder.value = '';
  wizard.mode = 'new';
  wizard.folder = '';
  document.querySelector('input[name="project-source"][value="new"]').checked = true;
  syncSourceForm();
  el.nameError.hidden = true;
  wizard.created = false;
  el.createMessage.textContent = '';
  el.extraServices.textContent = '';
  el.newDbName.value = '';
  el.newDbUser.value = '';
  el.newDbPass.value = '';
  showStage('name');
  el.newName.focus();
}

// The New project card is hidden after a delete or when the user clicks Done.
// The "New project" button in the Projects card brings it back.
function hideCreateCard() {
  el.createCard.hidden = true;
}

function showCreateCard() {
  createAnother();
  el.createCard.hidden = false;
  el.createCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- Edit services ----------

// Change the services of a project that already exists. Save only stores the new services.
// Save and apply also starts the project again, so Docker recreates what changed.
const EDIT_LABELS = { ...BUILTIN_LABELS, node: 'Node (npm, Vite)' };
const editState = { name: '', running: false };
let editView = null;

function editBox(key) {
  return el.editOptions.querySelector(`input[data-key="${key}"]`);
}

// phpMyAdmin needs MySQL. Adminer needs MySQL or PostgreSQL. Only boxes the stack offers are touched.
function syncEditDependencies(changedKey) {
  const on = (key) => Boolean(editBox(key)) && editBox(key).checked;
  const set = (key, value) => {
    if (editBox(key)) editBox(key).checked = value;
  };

  if (changedKey === 'phpmyadmin' && on('phpmyadmin')) set('mysql', true);
  if (changedKey === 'adminer' && on('adminer') && !on('mysql') && !on('postgres')) set('mysql', true);
  if (!on('mysql')) set('phpmyadmin', false);
  if (!on('mysql') && !on('postgres')) set('adminer', false);
  syncEditDbField();
}

// The database boxes show only when MySQL or PostgreSQL is ticked, the Redis box only when Redis is ticked.
function syncEditDbField() {
  const on = (key) => Boolean(editBox(key)) && editBox(key).checked;
  el.editDb.hidden = !(on('mysql') || on('postgres') || on('mongodb'));
  el.editRedis.hidden = !on('redis');
}

// The message of an error that came through the main process, without Electron's prefix.
function ipcMessage(err) {
  return String((err && err.message) || err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

function setEditBusy(busy) {
  el.editSave.disabled = busy;
  el.editApply.disabled = busy;
  el.editAddService.disabled = busy;
}

function renderEdit(details) {
  editState.name = details.name;
  editState.running = details.running === true;
  el.editTitle.textContent = `Edit services: ${details.name} · ${details.label}`;

  for (const label of el.editOptions.querySelectorAll('label')) label.remove();
  for (const key of details.optionKeys) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.key = key;
    box.checked = details.options[key] === true;
    box.addEventListener('change', () => syncEditDependencies(key));
    label.append(box, ` ${EDIT_LABELS[key] || key}`);
    if (registry && DB_VERSION_KEYS.includes(key)) {
      const select = document.createElement('select');
      select.className = 'ver-select';
      select.dataset.versionKey = key;
      select.setAttribute('aria-label', `${EDIT_LABELS[key]} version`);
      fillVersionSelect(select, key, (details.versions && details.versions[key]) || registry[key].default);
      label.append(' ', select);
    }
    el.editOptions.appendChild(label);
  }

  el.editDbName.value = details.dbName || 'app';
  el.editDbUser.value = details.dbUser || 'app';
  el.editDbPass.value = details.dbPassword || '';
  el.editRedisPass.value = details.redisPassword || '';
  el.editLan.checked = details.lanShare === true;
  el.editPython.hidden = !details.packagesLabel;
  el.editKeepPackagesText.textContent = details.packagesLabel || '';
  el.editKeepPackages.checked = details.keepPackages === true;
  syncEditDbField();

  el.editExtras.textContent = '';
  for (const extra of details.extras) addServiceRow(extra, '', el.editExtras);
  el.editApply.textContent = editState.running ? 'Save and apply' : 'Save and start';
}

// Reloads everything that shows ports or containers, now and once more when the containers have settled.
async function refreshAfterEdit() {
  await loadProjects();
  scheduleRefreshContainers();
  scheduleLinksRefresh();
  setTimeout(() => {
    loadProjects();
    scheduleRefreshContainers();
    scheduleLinksRefresh();
  }, 2500);
}

function closeEdit() {
  editState.name = '';
  el.editCard.hidden = true;
}

async function openEdit(name) {
  editState.name = '';
  el.editCard.hidden = false;
  el.editError.hidden = true;
  el.editProgress.hidden = true;
  el.editExtras.textContent = '';
  for (const label of el.editOptions.querySelectorAll('label')) label.remove();
  el.editMessage.textContent = 'Loading...';
  el.editCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    renderEdit(await window.envhub.projectDetails(name));
    el.editMessage.textContent = '';
  } catch (err) {
    el.editMessage.textContent = `Could not load the project: ${ipcMessage(err)}`;
  }
}

// "Added: redis. Removed: mailpit." plus what to do next.
function savedText(res, applyNow) {
  const { added, removed, changed } = res.changes;
  const parts = [];
  if (added.length > 0) parts.push(`Added: ${added.join(', ')}.`);
  if (removed.length > 0) parts.push(`Removed: ${removed.join(', ')}.`);
  if (changed.length > 0) parts.push(`Changed: ${changed.join(', ')}.`);
  if (parts.length === 0) parts.push('No service changes.');
  if (!applyNow) {
    parts.push(res.details.running
      ? 'Saved. Click Save and apply to update the running containers.'
      : 'Saved. The changes start with the next Start.');
  }
  return parts.join(' ');
}

async function applyEdit(name) {
  el.editProgress.hidden = false;
  editView.begin(`Applying changes to ${name}`);
  const res = await runStart(name, editView, { apply: true });
  setActionStatus(describeResult('Apply', name, res));
  await refreshAfterEdit();
}

async function saveEdit(applyNow) {
  const name = editState.name;
  if (!name) return;

  setEditBusy(true);
  el.editError.hidden = true;
  try {
    const options = {};
    for (const box of el.editOptions.querySelectorAll('input[data-key]')) {
      options[box.dataset.key] = box.checked;
    }

    // Only a new or changed image is looked up on Docker Hub. The server checks every value anyway.
    for (const row of el.editExtras.children) {
      const image = resolvedImage(row.querySelector('.svc-image'), row.querySelector('.svc-tag'));
      const error = row.querySelector('.svc-error');
      error.hidden = true;
      if (!image || image === row.dataset.original) continue;
      const problem = await imageProblem(image);
      if (problem) {
        error.textContent = problem;
        error.hidden = false;
        return;
      }
    }

    let res;
    try {
      res = await window.envhub.updateProject(name, {
        options,
        extraServices: collectExtras(el.editExtras),
        dbName: el.editDbName.value.trim(),
        dbUser: el.editDbUser.value.trim(),
        dbPassword: el.editDbPass.value.trim(),
        redisPassword: el.editRedisPass.value.trim(),
        lanShare: el.editLan.checked,
        keepPackages: el.editPython.hidden ? undefined : el.editKeepPackages.checked,
        versions: Object.fromEntries([...el.editOptions.querySelectorAll('select[data-version-key]')].map((s) => [s.dataset.versionKey, s.value])),
      });
    } catch (err) {
      el.editError.textContent = ipcMessage(err);
      el.editError.hidden = false;
      return;
    }

    renderEdit(res.details);
    el.editMessage.textContent = savedText(res, applyNow);
    await refreshAfterEdit();
    if (applyNow) await applyEdit(name);
  } finally {
    setEditBusy(false);
  }
}

// ---------- Links & commands ----------

// One panel with every web address of a project, a shell command for each service, and the Docker
// commands for the whole project. The addresses are opened by the main process.
const linksState = { name: '' };
let linksTimer = null;

function closeLinks() {
  linksState.name = '';
  el.linksCard.hidden = true;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    el.linksMessage.textContent = 'Copied.';
  } catch (err) {
    el.linksMessage.textContent = 'Could not copy. Select the text and copy it yourself.';
  }
}

async function openPort(name, service, container, label) {
  try {
    await window.envhub.openPort(name, service, container);
    el.linksMessage.textContent = `Opened ${label}.`;
  } catch (err) {
    el.linksMessage.textContent = `Could not open ${label}: ${ipcMessage(err)}`;
  }
}

function codeLine(text) {
  const line = makeElement('code', 'cmd');
  line.textContent = text;
  return line;
}

function renderLinks(data) {
  el.linksTitle.textContent = `Links & commands: ${data.name}`;
  const notes = [];
  if (!data.running) notes.push('The project is not running. Start it to open the links.');
  if (data.lanShare && !data.lanFound) notes.push('Sharing is on, but no Wi-Fi or network address was found on this computer.');
  el.linksNote.textContent = notes.join(' ');

  el.linksServices.textContent = '';
  for (const svc of data.services) {
    const row = makeElement('div', 'row');
    const info = document.createElement('div');
    const title = makeElement('div', 'row-name');
    title.textContent = svc.name;
    const meta = makeElement('div', 'muted small');
    meta.textContent = svc.image;
    info.append(title, meta);
    if (svc.command) info.appendChild(codeLine(`runs: ${svc.command}`));
    info.appendChild(codeLine(svc.shell));

    const actions = makeElement('div', 'row-actions');
    for (const port of svc.ports) {
      const label = port.url.replace('http://', '');
      const button = addButton(actions, `Open ${label}`, () => openPort(data.name, svc.name, port.container, label));
      button.disabled = !data.running;
    }
    for (const port of svc.ports) {
      for (const url of port.lanUrls || []) {
        info.appendChild(codeLine(`other computers: ${url}`));
        addButton(actions, `Copy ${url.replace('http://', '')}`, () => copyText(url));
      }
    }
    addButton(actions, 'Copy shell command', () => copyText(svc.shell));

    row.append(info, actions);
    el.linksServices.appendChild(row);
  }

  el.linksCommands.textContent = '';
  for (const command of data.commands) {
    const row = makeElement('div', 'row');
    const info = document.createElement('div');
    const label = makeElement('div', 'muted small');
    label.textContent = command.label;
    info.append(label, codeLine(command.text));

    const actions = makeElement('div', 'row-actions');
    addButton(actions, 'Copy', () => copyText(command.text));
    row.append(info, actions);
    el.linksCommands.appendChild(row);
  }
}

async function loadLinks() {
  const name = linksState.name;
  if (!name) return;
  try {
    const data = await window.envhub.projectLinks(name);
    if (linksState.name === name) renderLinks(data);
  } catch (err) {
    el.linksMessage.textContent = `Could not load: ${ipcMessage(err)}`;
  }
}

// Called when containers change, so the panel keeps showing what is running.
function scheduleLinksRefresh() {
  if (!linksState.name) return;
  clearTimeout(linksTimer);
  linksTimer = setTimeout(loadLinks, 300);
}

async function openLinks(name) {
  linksState.name = name;
  el.linksCard.hidden = false;
  el.linksMessage.textContent = 'Loading...';
  el.linksCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  await loadLinks();
  if (el.linksMessage.textContent === 'Loading...') el.linksMessage.textContent = '';
}

// ---------- Containers ----------

async function refreshContainers() {
  el.containerList.textContent = '';
  try {
    const items = await window.envhub.listContainers();
    if (items.length === 0) {
      const li = makeElement('li', 'muted');
      li.textContent = 'No envhub containers yet. Start a project above.';
      el.containerList.appendChild(li);
      return;
    }
    for (const c of items) {
      const li = document.createElement('li');
      li.textContent = `${c.name}  |  ${c.state}  |  ${c.image}`;
      el.containerList.appendChild(li);
    }
  } catch (err) {
    const li = makeElement('li', 'muted');
    li.textContent = `Could not load containers: ${err.message}`;
    el.containerList.appendChild(li);
  }
}

function scheduleRefreshContainers() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshContainers, 300);
}

// ---------- Startup ----------

function byId(id) {
  return document.getElementById(id);
}

document.addEventListener('DOMContentLoaded', async () => {
  el.appInfo = byId('app-info');
  el.title = byId('docker-title');
  el.detail = byId('docker-detail');
  el.guidance = byId('docker-guidance');
  el.button = byId('check-again');

  el.stageItems = [...document.querySelectorAll('#stages li')];
  el.stageName = byId('stage-name');
  el.stageSetup = byId('stage-setup');
  el.stageCreate = byId('stage-create');
  el.newName = byId('new-name');
  el.projectsDirRow = byId('projects-dir-row');
  el.projectsDirNote = byId('projects-dir-note');
  el.projectsDir = byId('projects-dir');
  el.resetProjectsDir = byId('reset-projects-dir');
  el.keepPackagesRow = byId('keep-packages-row');
  el.keepPackages = byId('keep-packages');
  el.keepPackagesText = byId('keep-packages-text');
  el.editKeepPackagesText = byId('edit-keep-packages-text');
  el.editPython = byId('edit-python');
  el.editKeepPackages = byId('edit-keep-packages');
  el.existingFields = byId('existing-fields');
  el.existingFolder = byId('existing-folder');
  el.nameError = byId('name-error');
  el.setupName = byId('setup-name');
  el.newStack = byId('new-stack');
  el.newVersion = byId('new-version');
  el.installChoice = byId('install-choice');
  el.installYesText = byId('install-yes-text');
  el.installNoText = byId('install-no-text');
  el.suggestions = byId('suggestions');
  el.suggestionChips = byId('suggestion-chips');
  el.extraServices = byId('extra-services');
  el.dockerFields = byId('docker-fields');
  el.dockerImage = byId('docker-image');
  el.dockerPort = byId('docker-port');
  el.dockerCommand = byId('docker-command');
  el.dockerError = byId('docker-error');
  el.dockerTag = byId('docker-tag');
  el.dockerSuggestions = byId('docker-suggestions');
  el.dockerHint = byId('docker-hint');
  el.optionsLegend = byId('options-legend');
  el.optionsNote = byId('options-note');
  el.createProgress = byId('create-progress');
  el.createMessage = byId('create-message');
  el.createActions = byId('create-actions');
  el.createOpen = byId('create-open');
  el.createConnection = byId('create-connection');
  el.createRetry = byId('create-retry');
  el.createAnother = byId('create-another');
  el.createDone = byId('create-done');
  el.createCard = byId('create-card');
  el.newProjectBtn = byId('new-project-btn');

  el.editCard = byId('edit-card');
  el.editTitle = byId('edit-title');
  el.editOptions = byId('edit-options');
  el.editExtras = byId('edit-extras');
  el.editDb = byId('edit-db');
  el.editDbName = byId('edit-db-name');
  el.editDbPass = byId('edit-db-pass');
  el.editRedis = byId('edit-redis');
  el.editRedisPass = byId('edit-redis-pass');
  el.editLan = byId('edit-lan');
  el.versionsWarning = byId('versions-warning');
  el.versionsFileBtn = byId('versions-file-btn');
  el.newDbName = byId('new-db-name');
  el.newDbUser = byId('new-db-user');
  el.editDbUser = byId('edit-db-user');
  el.newDbPass = byId('new-db-pass');
  el.editAddService = byId('edit-add-service');
  el.editError = byId('edit-error');
  el.editMessage = byId('edit-message');
  el.editSave = byId('edit-save');
  el.editApply = byId('edit-apply');
  el.editProgress = byId('edit-progress');

  el.linksCard = byId('links-card');
  el.linksTitle = byId('links-title');
  el.linksNote = byId('links-note');
  el.linksServices = byId('links-services');
  el.linksCommands = byId('links-commands');
  el.linksMessage = byId('links-message');

  el.projectList = byId('project-list');
  el.actionStatus = byId('action-status');
  el.startCard = byId('start-card');
  el.logsCard = byId('logs-card');
  el.logsTitle = byId('logs-title');
  el.logsOutput = byId('logs-output');
  el.copyEnvDocker = byId('copy-env-docker');
  el.copyEnvHost = byId('copy-env-host');
  el.writeEnvDocker = byId('write-env-docker');
  el.writeEnvHost = byId('write-env-host');
  el.containerList = byId('container-list');

  createView = createProgressView(el.createProgress);
  startView = createProgressView(byId('start-progress'));
  editView = createProgressView(el.editProgress);

  el.button.addEventListener('click', checkDocker);
  el.stageName.addEventListener('submit', submitName);
  for (const radio of document.querySelectorAll('input[name="project-source"]')) radio.addEventListener('change', syncSourceForm);
  byId('pick-folder').addEventListener('click', pickFolder);
  byId('change-projects-dir').addEventListener('click', () => changeProjectsDir(false));
  el.resetProjectsDir.addEventListener('click', () => changeProjectsDir(true));
  loadProjectsDir();
  el.stageSetup.addEventListener('submit', submitSetup);
  byId('setup-back').addEventListener('click', () => showStage('name'));
  el.dockerImage.addEventListener('input', syncPythonRow);
  el.dockerTag.addEventListener('change', syncPythonRow);
  el.newStack.addEventListener('change', syncStackForm);
  createImagePicker({
    input: el.dockerImage,
    tagSelect: el.dockerTag,
    list: el.dockerSuggestions,
    hint: el.dockerHint,
    onChange: renderSuggestions,
  });
  byId('add-service').addEventListener('click', () => addServiceRow());
  for (const key of OPTION_KEYS) {
    optionBox(key).addEventListener('change', () => {
      syncOptionDependencies(key);
      renderSuggestions();
    });
  }
  el.createOpen.addEventListener('click', () => {
    openService(wizard.name, null, 'the project', (text) => { el.createMessage.textContent = text; });
  });
  el.createConnection.addEventListener('click', () => showConnection(wizard.name));
  el.createRetry.addEventListener('click', retryStart);
  el.createAnother.addEventListener('click', createAnother);
  el.createDone.addEventListener('click', hideCreateCard);
  el.newProjectBtn.addEventListener('click', showCreateCard);
  byId('links-close').addEventListener('click', closeLinks);
  byId('links-refresh').addEventListener('click', loadLinks);
  byId('edit-close').addEventListener('click', closeEdit);
  el.editAddService.addEventListener('click', () => addServiceRow({}, '', el.editExtras));
  el.editSave.addEventListener('click', () => saveEdit(false));
  el.editApply.addEventListener('click', () => saveEdit(true));
  byId('close-start').addEventListener('click', () => { el.startCard.hidden = true; });
  byId('close-logs').addEventListener('click', () => { el.logsCard.hidden = true; });
  el.writeEnvDocker.addEventListener('click', () => writeEnvToFolder('docker'));
  el.writeEnvHost.addEventListener('click', () => writeEnvToFolder('host'));
  el.copyEnvDocker.addEventListener('click', () => copyEnvFile(el.copyEnvDocker, 'docker', 'Copy .env (Docker)'));
  el.copyEnvHost.addEventListener('click', () => copyEnvFile(el.copyEnvHost, 'host', 'Copy .env (my computer)'));
  byId('refresh-containers').addEventListener('click', refreshContainers);

  window.envhub.onContainersChanged(() => {
    scheduleRefreshContainers();
    scheduleLinksRefresh();
    // Keeps the On / Stopped badge right when a container starts or stops outside envhub too.
    loadProjects();
  });
  // Clicks in the application menu (File, Tools > Sync) arrive here.
  window.envhub.onMenuAction((action) => {
    if (action === 'new-project' || action === 'existing-project') {
      showCreateCard();
      const radio = document.querySelector(`input[name="project-source"][value="${action === 'existing-project' ? 'existing' : 'new'}"]`);
      if (radio) {
        radio.checked = true;
        syncSourceForm();
      }
    } else if (action === 'refresh') {
      loadProjects();
      scheduleRefreshContainers();
    } else if (action === 'projects-dir-changed') {
      loadProjectsDir();
    } else if (action === 'versions-refreshed') {
      loadRegistry();
    }
  });
  window.envhub.onProjectLog((event) => {
    const view = progressViews.get(event.name);
    if (view) view.log(event.lines);
  });
  window.envhub.onProjectProgress((event) => {
    const view = progressViews.get(event.name);
    if (view) view.update(event);
  });

  el.versionsFileBtn.addEventListener('click', async () => {
    try {
      const res = await window.envhub.openVersionsFile();
      setActionStatus(`Opened ${res.file}. Add versions, save it, then restart envhub.`);
    } catch (err) {
      setActionStatus(`Could not open the versions file: ${ipcMessage(err)}`);
    }
  });

  await loadRegistry();
  syncStackForm();
  showStage('name');

  try {
    const info = await window.envhub.getAppInfo();
    el.appInfo.textContent = `${info.name} ${info.version}`;
  } catch (err) {
    el.appInfo.textContent = '';
  }

  checkDocker();
  loadProjects();
  refreshContainers();
});
