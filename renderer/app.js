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
  // "Download Docker" is for a computer without Docker.
  el.dockerDownload.hidden = status.reason !== 'not-found';
  // "Start Docker" is for Docker that is installed but not running.
  el.dockerStart.hidden = !(status.reason === 'daemon-not-running' && status.platform !== '');

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
        'In Rancher Desktop, set Container Engine to "dockerd (moby)". It gives the docker and docker compose commands that ProjectDockHub needs.',
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

// The status bar, the Docker pill in the top bar, the engine block in the sidebar and the engine card
// on the Projects page all show the same Docker check.
let lastDockerStatus = null;

function dockerVersionParts(status) {
  const text = (status && status.clientVersion) || '';
  const m = /version\s+([\w.+-]+)(?:,\s*build\s+(\w+))?/i.exec(text);
  return { version: m ? m[1] : (status && status.serverVersion) || '', build: m && m[2] ? m[2] : '' };
}

function paintStatusBar(status) {
  lastDockerStatus = status;
  const running = Boolean(status && status.running);
  const state = !status ? 'checking' : running ? 'ok' : 'bad';
  const { version, build } = dockerVersionParts(status);
  for (const id of ['sb-dot', 'tb-docker-dot', 'ovc-engine-dot']) {
    const dot = document.getElementById(id);
    if (dot) dot.dataset.state = state;
  }
  byId('sf-state').dataset.state = state;
  byId('sb-engine').dataset.state = state;
  const missing = Boolean(status && status.reason === 'not-found');
  const word = !status ? 'Checking' : running ? 'Running' : missing ? 'Not installed' : 'Not running';
  setText('sf-state-text', word);
  setText('sf-ver', [version, build].filter(Boolean).join(' · '));
  setText('sb-engine-text', !status ? 'Checking engine' : running ? 'Engine running' : missing ? 'Docker not installed' : 'Engine stopped');
  const server = running && status.serverVersion ? ` · Server ${status.serverVersion}` : '';
  setText('sb-docker', version ? `Docker ${version}${build ? `, build ${build}` : ''}${server}` : '');
  setText('tb-docker-text', version ? `Docker ${version}` : running ? 'Docker' : missing ? 'No Docker' : status ? 'Docker off' : 'Docker');
  setText('ovc-engine', version ? `v${version}` : missing ? 'not installed' : status ? 'not running' : '–');
  setText('ovc-engine-build', build ? `build ${build}` : '');
  setText('ovc-engine-server', running && status.serverVersion ? `server ${status.serverVersion}` : '');
  document.body.classList.toggle('docker-ok', running);
  paintSettingsDocker();
}

function paintStopOnExit(value) {
  setText('sb-stop-exit', `stop-on-exit: ${value ? 'on' : 'off'}`);
}

// The Docker icon is blue when Docker runs, amber when it does not, grey while it is being checked.
function paintDockerMark() {
  el.dockerMark.dataset.state = el.title.textContent === 'Docker is running' ? 'ok' : 'bad';
  // The picture of the sleeping whale shows only when Docker is not running.
  el.dockerArt.hidden = el.dockerMark.dataset.state !== 'bad';
}

// What the Docker card showed last (reason and server version), so a check that finds the same thing changes nothing.
let dockerKey = '';
let dockerCheckBusy = false;
const DOCKER_RECHECK_MS = 8000;

// Looks at Docker again without the "Checking..." flicker. The card changes only when something changed:
// Docker Desktop was closed (or opened), or the Docker service stopped. Then the projects are read again too.
async function quietCheckDocker() {
  if (dockerCheckBusy || !dockerKey) return;
  dockerCheckBusy = true;
  try {
    const status = await window.envhub.checkDocker();
    const key = `${status.reason}|${status.serverVersion}`;
    if (key !== dockerKey) {
      dockerKey = key;
      clearGuidance();
      renderStatus(status);
      paintStatusBar(status);
      paintDockerMark();
      loadProjects();
      scheduleRefreshContainers();
    }
  } catch (err) {
    // The next check tries again.
  } finally {
    dockerCheckBusy = false;
  }
}

// Opens Docker Desktop, then looks every few seconds until the engine answers (it needs a minute or two).
const DOCKER_START_WAIT_MS = 3 * 60 * 1000;
let dockerStarting = false;

async function startDocker() {
  if (dockerStarting) return;
  dockerStarting = true;
  el.dockerStart.disabled = true;
  el.dockerStart.textContent = 'Starting...';
  el.title.textContent = 'Starting Docker...';
  el.detail.textContent = 'Docker Desktop is opening. This can take a minute or two.';
  clearGuidance();
  try {
    const res = await window.envhub.startDocker();
    if (!res.ok) {
      await checkDocker();
      showGuidance([res.error || 'Could not open Docker Desktop. Open it from the Start menu.']);
      return;
    }
    const until = Date.now() + DOCKER_START_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const status = await window.envhub.checkDocker();
      if (status.running) {
        await checkDocker();
        loadProjects();
        scheduleRefreshContainers();
        return;
      }
    }
    await checkDocker();
    showGuidance(['Docker Desktop is taking long. Wait until it says it is running, then click Check again.']);
  } catch (err) {
    await checkDocker();
  } finally {
    dockerStarting = false;
    el.dockerStart.disabled = false;
    el.dockerStart.textContent = 'Start Docker';
  }
}

async function checkDocker() {
  el.button.disabled = true;
  el.dockerMark.dataset.state = 'checking';
  paintStatusBar(null);
  el.dockerArt.hidden = true;
  el.title.textContent = 'Checking Docker...';
  el.detail.textContent = '';
  clearGuidance();

  try {
    const status = await window.envhub.checkDocker();
    dockerKey = `${status.reason}|${status.serverVersion}`;
    renderStatus(status);
    paintStatusBar(status);
    paintDockerMark();
  } catch (err) {
    dockerKey = 'error|';
    renderStatus({ reason: 'error', running: false, platform: '' });
    paintStatusBar({ running: false });
    paintDockerMark();
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

  // Minimize: only the title, the bar and the percent stay. The choice is remembered.
  const head = makeElement('div', 'progress-head');
  const percentText = makeElement('span', 'progress-percent');
  const minimize = makeElement('button', 'progress-min');
  minimize.type = 'button';
  const MIN_KEY = 'progressMinimized';
  const setMinimized = (on) => {
    root.classList.toggle('progress-mini', on);
    minimize.textContent = on ? 'Show details' : 'Minimize';
    minimize.setAttribute('aria-expanded', on ? 'false' : 'true');
    try {
      localStorage.setItem(MIN_KEY, on ? '1' : '0');
    } catch (err) {
      // Not remembered, fine.
    }
  };
  minimize.addEventListener('click', () => setMinimized(!root.classList.contains('progress-mini')));
  head.append(title, percentText, minimize);
  let startMinimized = false;
  try {
    startMinimized = localStorage.getItem(MIN_KEY) === '1';
  } catch (err) {
    startMinimized = false;
  }
  setMinimized(startMinimized);
  root.append(head, track, detail, time, logButton, terminal, list);
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
    percentText.textContent = percent > 0 ? `${percent}%` : '';
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
// The words Docker uses when its service is off (Windows pipe, Linux socket, the CLI message).
function dockerIsDown(text) {
  return /dockerDesktopLinuxEngine|docker_engine|Cannot connect to the Docker daemon|error during connect|Is the docker daemon running|pipe.*(cannot find|not found)/i.test(String(text || ''));
}

async function runStart(name, view, options) {
  progressViews.set(name, view);
  forgetProject(name);

  let res;
  try {
    res = await window.envhub.startProject(name, options);
  } catch (err) {
    res = { ok: false, stderr: err.message };
  } finally {
    progressViews.delete(name);
  }

  if (res.ok === false) {
    const text = lastLines(res.stderr) || 'Unknown error';
    const down = dockerIsDown(res.stderr);
    view.finish(false, `Could not start ${name}`, down ? 'Docker is not running. Open Docker Desktop, wait until it says it is running, then try again.' : text);
    if (down) quietCheckDocker();
  } else if (res.alreadyRunning) {
    view.finish(true, `${name} is already running`, '');
  } else {
    view.finish(true, `${name} is ready`, portMoves(res));
  }
  // New or changed services are up now: read the project again and set the cache.
  refreshProjectCache(name, 1200);
  return res;
}

// ---------- Projects ----------

// ---------- Messages: inside the card, with a cross ----------

// What happened to a project (Start, Stop, Restart, Open...) is shown inside that project's card and on its
// details page, with a cross to remove it. A message about no project in particular (name '') uses the line under the cards.
// Failures stay until the cross is used, the others go away by themselves.
const NOTE_MS = 12000;
const notes = new Map();
const noteTimers = new Map();

const CROSS_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"></path></svg>';

function noteKind(text) {
  return /failed|could not|cannot|error|not found/i.test(text) ? 'error' : 'ok';
}

// Fills one message box (card, details page or the global line), or hides it when there is no message.
function paintNote(box, name) {
  if (!box) return;
  const note = notes.get(name);
  box.textContent = '';
  box.hidden = !note;
  if (!note) return;
  box.className = `note-box note-${note.kind}`;
  if (note.kind === 'busy') {
    const spinner = makeElement('span', 'spinner');
    spinner.setAttribute('aria-hidden', 'true');
    box.appendChild(spinner);
  }
  const text = makeElement('span', 'note-text');
  text.textContent = note.text;
  const close = makeElement('button', 'note-x');
  close.type = 'button';
  close.title = 'Remove this message';
  close.setAttribute('aria-label', 'Remove this message');
  close.innerHTML = CROSS_ICON;
  close.addEventListener('click', () => clearNote(name));
  box.append(text, close);
}

function paintNotes(name) {
  if (name === '') {
    paintNote(el.actionStatus, '');
    return;
  }
  // The message of a project is a row under it in the Projects table: drawing the table again adds or removes it.
  if (projectsView.list.some((p) => p.name === name)) renderProjects();
  if (detailState.name === name) paintNote(byId('detail-note'), name);
}

function clearNote(name) {
  clearTimeout(noteTimers.get(name));
  noteTimers.delete(name);
  notes.delete(name);
  paintNotes(name);
}

function showNote(name, text, kind = noteKind(text)) {
  clearTimeout(noteTimers.get(name));
  noteTimers.delete(name);
  if (!text) {
    notes.delete(name);
  } else {
    notes.set(name, { text, kind });
    if (kind !== 'error' && kind !== 'busy' && kind !== 'warn') noteTimers.set(name, setTimeout(() => clearNote(name), NOTE_MS));
    if (kind !== 'busy') addNotification({ project: name, text, kind: ['ok', 'error', 'warn'].includes(kind) ? kind : 'info' });
  }
  paintNotes(name);
}

// A message about one project when `name` is given, otherwise the line under the cards.
function setActionStatus(text, name = '', kind) {
  showNote(name, text, kind);
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

// Words for "Packages for editor": the install takes a few minutes, so the message says so.
const EDITOR_PACKAGES_TEXT = {
  busy: 'Installing packages for the editor. This takes a few minutes...',
  done: 'Packages for the editor are installed in the project folder.',
};

function describeResult(label, name, res) {
  if (!res) return `${label} ${name}: done.`;
  if (res.ok === false) {
    return `${label} failed: ${firstLine(res.stderr) || 'unknown error'}`;
  }
  if (res.skipped) return `${label} ${name}: no containers to change.`;
  if (res.alreadyRunning) return `${name} is already running.`;

  return [`${label} ${name}: done.`, portMoves(res)].filter(Boolean).join(' ');
}

// `texts` can replace the standard words: { busy, done }.
// The stop / start icon of one service.
async function toggleService(projectName, serviceName, running, button) {
  button.disabled = true;
  const verb = running ? 'Stop' : 'Start';
  setActionStatus(`${verb} ${serviceName}...`, projectName, 'busy');
  try {
    const res = await window.envhub[running ? 'stopService' : 'startService'](projectName, serviceName);
    if (res && res.ok === false) {
      setActionStatus(`${verb} ${serviceName} failed: ${String(res.stderr || '').trim().split(String.fromCharCode(10))[0] || 'unknown error'}`, projectName, 'error');
    } else {
      setActionStatus(`${serviceName} ${running ? 'stopped' : 'started'}.`, projectName);
    }
  } catch (err) {
    setActionStatus(`${verb} ${serviceName} failed: ${ipcMessage(err)}`, projectName, 'error');
  }
  await loadProjects();
  scheduleRefreshContainers();
  refreshProjectCache(projectName, 300);
  button.disabled = false;
}

async function runProjectAction(label, method, name, texts = {}) {
  setActionStatus(texts.busy || `${label} ${name}...`, name, 'busy');
  if (method !== 'openFolder' && method !== 'openProject') forgetProject(name);
  try {
    const res = await window.envhub[method](name);
    const failed = res && res.ok === false;
    setActionStatus(texts.done && !failed ? texts.done : describeResult(label, name, res), name);
  } catch (err) {
    setActionStatus(`${label} failed: ${ipcMessage(err)}`, name, 'error');
  }
  await loadProjects();
  scheduleRefreshContainers();
  if (method !== 'openFolder' && method !== 'openProject') refreshProjectCache(name, 1200);
}

// The Starting card closes by itself a moment after a good start, and the project that came up lights up in
// the list. A newer start (another project) or a manual close cancels it, and a failed start stays open.
let startCardToken = 0;
const START_CARD_CLOSE_MS = 2200;

function closeStartCardLater(name, token) {
  setTimeout(() => {
    if (token !== startCardToken || el.startCard.hidden) return;
    el.startCard.hidden = true;
    if (document.body.dataset.view === 'projects') requestAnimationFrame(() => highlightProjectCard(name));
  }, START_CARD_CLOSE_MS);
}

// Start from the project list, with the same progress view the wizard uses.
async function startFromList(name) {
  const token = ++startCardToken;
  showView('projects');
  el.startCard.hidden = false;
  // The Starting card sits right under the Docker card, so bring the page to the top.
  window.scrollTo({ top: 0, behavior: 'smooth' });
  startView.begin(`Starting ${name}`);
  const res = await runStart(name, startView);
  setActionStatus(describeResult('Start', name, res), name);
  await loadProjects();
  scheduleRefreshContainers();
  if (res.ok !== false) closeStartCardLater(name, token);
}

async function openService(name, service, label, say = (text) => setActionStatus(text, name)) {
  try {
    await window.envhub.openProject(name, service);
    say(`Opened ${label} for ${name}.`);
  } catch (err) {
    say(`Could not open ${label}: ${err.message}`);
  }
}

async function deleteProject(name, keepData = false) {
  forgetProject(name);
  clearTimeout(cacheTimers.get(name));
  cacheTimers.delete(name);
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
        setActionStatus(`Deleted ${name}.${keepData ? ' Database data was kept.' : ''}`);
      }
    }
  } catch (err) {
    setActionStatus(`Delete failed: ${err.message}`);
  }
  el.logsCard.hidden = true;
  el.credCard.hidden = true;
  if (editState.name === name) closeEdit();
  if (linksState.name === name) closeLinks();
  el.volumesCard.hidden = true;
  if (detailState.name === name) {
    stopOverviewRefresh();
    detailState.name = '';
    showView('projects');
  }
  hideCreateCard();
  await loadProjects();
  scheduleRefreshContainers();
}

// ---------- Delete: a question first ----------

// Asks what to do before anything is deleted. It is an in-page dialog (a confirm() window can leave text
// inputs unfocusable in Electron on Windows). Resolves { keepData } or null when the user cancels.
function askDeleteProject(project) {
  return new Promise((resolve) => {
    const modal = byId('confirm-modal');
    const body = byId('confirm-body');
    const ok = byId('confirm-ok');
    const cancel = byId('confirm-cancel');
    byId('confirm-title').textContent = `Delete "${project.name}"?`;
    body.textContent = '';

    const list = makeElement('ul', 'modal-list');
    const addLine = (text) => {
      const li = makeElement('li', '');
      li.textContent = text;
      list.appendChild(li);
    };
    addLine('The containers of this project are removed.');
    if (project.imported) {
      addLine(`Your project folder is not deleted. It stays here: ${project.folder}`);
    } else {
      addLine(`The project folder and all your files in it are deleted${project.folder ? `: ${project.folder}` : ''}.`);
    }
    body.appendChild(list);

    // The database question, only when this project has data to keep.
    const data = project.dataServices || [];
    let keepRadio = null;
    if (data.length > 0) {
      const group = makeElement('fieldset', 'modal-choice');
      const legend = makeElement('legend', '');
      legend.textContent = `Database data (${data.join(', ')})`;
      group.appendChild(legend);
      const choice = (value, title, note, checked) => {
        const label = makeElement('label', 'modal-option');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'delete-data';
        radio.value = value;
        radio.checked = checked;
        const text = makeElement('span', '');
        const strong = makeElement('strong', '');
        strong.textContent = title;
        const small = makeElement('span', 'muted small');
        small.textContent = note;
        text.append(strong, small);
        label.append(radio, text);
        group.appendChild(label);
        return radio;
      };
      keepRadio = choice('keep', 'Keep the database data', 'It stays in Docker. A new project with the same name uses it again.', true);
      choice('delete', 'Delete the database data too', 'Tables, rows and files are removed for good. This cannot be undone.', false);
      body.appendChild(group);
    } else {
      const note = makeElement('p', 'muted small');
      note.textContent = 'This project has no database data.';
      body.appendChild(note);
    }

    const finish = (result) => {
      modal.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('mousedown', onBackdrop);
      resolve(result);
    };
    const onOk = () => finish({ keepData: keepRadio ? keepRadio.checked : false });
    const onCancel = () => finish(null);
    const onBackdrop = (event) => {
      if (event.target === modal) finish(null);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(null);
      } else if (event.key === 'Tab') {
        // Keep the focus inside the dialog.
        const items = [...modal.querySelectorAll('input, button')];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    modal.hidden = false;
    // The safe button has the focus, so a quick Enter does not delete anything.
    cancel.focus();
  });
}

// A plain yes / no question in the same in-page dialog. Resolves true or false.
// `cancelLabel` and `okClass` change the two buttons for this question only (a choice instead of a delete).
function confirmDialog({ title, body, okLabel, cancelLabel = '', okClass = '' }) {
  return new Promise((resolve) => {
    const modal = byId('confirm-modal');
    const ok = byId('confirm-ok');
    const cancel = byId('confirm-cancel');
    const before = ok.textContent;
    const beforeCancel = cancel.textContent;
    const beforeClass = ok.className;
    if (cancelLabel) cancel.textContent = cancelLabel;
    if (okClass) ok.className = okClass;
    byId('confirm-title').textContent = title;
    const box = byId('confirm-body');
    box.textContent = '';
    for (const part of String(body).split('\n\n')) {
      const para = makeElement('p', 'muted small');
      para.textContent = part;
      box.appendChild(para);
    }
    ok.textContent = okLabel;
    const finish = (value) => {
      modal.hidden = true;
      ok.textContent = before;
      cancel.textContent = beforeCancel;
      ok.className = beforeClass;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey, true);
    modal.hidden = false;
    cancel.focus();
  });
}

async function startDeleteProject(name) {
  const project = projectsView.list.find((p) => p.name === name);
  if (!project) return;
  const answer = await askDeleteProject(project);
  if (answer) deleteProject(name, answer.keepData);
}

function showPanel(title, text) {
  ensureProjectsView();
  mountPanel(el.logsCard);
  el.logsCard.hidden = false;
  el.logsTitle.textContent = title;
  el.logsOutput.textContent = text;
  el.copyEnvDocker.hidden = true;
  el.copyEnvHost.hidden = true;
  el.writeEnvDocker.hidden = true;
  el.writeEnvHost.hidden = true;
  el.logsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let logsName = '';

// ---------- Small icons and copy buttons ----------

// Fixed SVG markup from this file only (never text from a project), so innerHTML is safe here.
const ICONS = {
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"></path></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
  external: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"></path></svg>',
  terminal: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3"></path><path d="M13 15h4"></path></svg>',
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle></svg>',
  eyeOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>',
};

// A button with an icon in front of its text.
function setIconLabel(button, iconName, text) {
  const label = document.createElement('span');
  label.textContent = text;
  button.replaceChildren(icon(iconName), label);
}

function icon(name) {
  const span = makeElement('span', 'icon');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name];
  return span;
}

function iconButton(name, label, onClick) {
  const button = makeElement('button', 'icon-btn');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

// Copies and turns the button into a green tick for a moment.
async function copyWithFeedback(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    button.title = 'Could not copy. Select the text and copy it yourself.';
    return;
  }
  if (button.classList.contains('icon-btn')) {
    button.replaceChildren(icon('check'));
    button.classList.add('copied');
    setTimeout(() => {
      button.replaceChildren(icon('copy'));
      button.classList.remove('copied');
    }, 1400);
  } else if (button.classList.contains('ibtn') || button.classList.contains('hero-url')) {
    // Icon buttons and links keep what they show; a check mark (or "Copied") flashes for a moment.
    const before = [...button.childNodes];
    const label = button.getAttribute('aria-label');
    button.replaceChildren(button.classList.contains('ibtn') ? icon('check') : document.createTextNode('Copied'));
    button.classList.add('copied');
    if (label) button.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      button.replaceChildren(...before);
      button.classList.remove('copied');
      if (label) button.setAttribute('aria-label', label);
    }, 1400);
  } else {
    const before = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('copied');
    setTimeout(() => {
      button.textContent = before;
      button.classList.remove('copied');
    }, 1400);
  }
}

// A label, a value in a box and a copy button. Used for commands and addresses.
// `terminal` (optional) adds a button after Copy that opens a terminal in this place: { onClick, title, disabled }.
function codeRow(label, text, { terminal } = {}) {
  const row = makeElement('div', 'code-row');
  const key = makeElement('span', 'code-label');
  key.textContent = label;
  const box = makeElement('div', 'code-box');
  const code = makeElement('code', '');
  code.textContent = text;
  box.append(code, iconButton('copy', `Copy ${label.toLowerCase()}`, (event) => copyWithFeedback(text, event.currentTarget)));
  if (terminal) {
    const button = iconButton('terminal', terminal.title, terminal.onClick);
    button.disabled = terminal.disabled === true;
    box.appendChild(button);
  }
  row.append(key, box);
  return row;
}

// ---------- Credentials & .env ----------

const HIDDEN_VALUE = '••••••••••';

// One line of a credentials card: name, value, and buttons to show (for secrets) and copy it.
function credRow(label, value, { secret = false } = {}) {
  const row = makeElement('div', 'cred-row');
  const key = makeElement('span', 'cred-key');
  key.textContent = label;
  const text = value === undefined || value === null || value === '' ? '' : String(value);
  const val = makeElement('span', text ? 'cred-val' : 'cred-val empty-val');
  val.textContent = text ? (secret ? HIDDEN_VALUE : text) : 'not set';
  const actions = makeElement('span', 'cred-actions');
  if (text && secret) {
    let shown = false;
    const eye = iconButton('eye', `Show ${label.toLowerCase()}`, () => {
      shown = !shown;
      val.textContent = shown ? text : HIDDEN_VALUE;
      eye.replaceChildren(icon(shown ? 'eyeOff' : 'eye'));
      eye.title = `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`;
    });
    actions.appendChild(eye);
  }
  if (text) actions.appendChild(iconButton('copy', `Copy ${label.toLowerCase()}`, (event) => copyWithFeedback(text, event.currentTarget)));
  row.append(key, val, actions);
  return row;
}

function credSection(title, text) {
  const section = makeElement('section', 'cred-section');
  const head = makeElement('div', 'cred-section-head');
  const heading = makeElement('h3', '');
  heading.textContent = title;
  head.appendChild(heading);
  if (text) {
    const note = makeElement('p', 'muted small');
    note.textContent = text;
    head.appendChild(note);
  }
  section.appendChild(head);
  return section;
}

function credCardHead(markText, title, sub) {
  const head = makeElement('div', 'cred-card-head');
  const mark = makeElement('span', 'svc-mark');
  mark.textContent = markText.slice(0, 2);
  const info = makeElement('div', 'cred-card-title');
  const strong = makeElement('strong', '');
  strong.textContent = title;
  info.appendChild(strong);
  if (sub) {
    const small = makeElement('span', 'cred-sub');
    small.textContent = sub;
    info.appendChild(small);
  }
  head.append(mark, info);
  return head;
}

const ENV_TARGETS = [
  ['docker', 'Inside Docker (recommended)', 'Choose this if your app is a service in this project, such as php, node or app. The host is the service name (for example DB_HOST=mysql). Do not use these values in a database tool.'],
  ['host', 'Outside Docker (on my computer)', 'Choose this only if you start the app yourself with Laragon, XAMPP, php artisan serve or npm run dev. The host is localhost. If your app runs in Docker and shows "No such file or directory" or "Connection refused", you picked the wrong one: switch to "Inside Docker".'],
];

// One credentials card for a service, built from the service catalog.
function catalogCard(projectName, card) {
  const box = makeElement('div', 'cred-card catalog-card');
  box.appendChild(credCardHead(card.label || card.name, card.name, card.known ? `${card.label} · ${card.image}` : card.image));
  for (const f of card.fields || []) box.appendChild(credRow(f.label, f.value, { secret: f.secret === true }));
  if (card.note) {
    const note = makeElement('p', 'muted small catalog-note');
    note.textContent = card.note;
    box.appendChild(note);
  }
  if (card.env) {
    let target = 'docker';
    const seg = makeElement('div', 'seg');
    const block = makeElement('pre', 'env-block catalog-env');
    const hint = makeElement('p', 'muted small catalog-note');
    const copy = makeElement('button', 'btn-xs');
    copy.type = 'button';
    copy.textContent = 'Copy .env lines';
    const paint = () => {
      for (const b of seg.children) b.setAttribute('aria-pressed', b.dataset.target === target ? 'true' : 'false');
      const text = card.env[target];
      block.textContent = text || '';
      block.hidden = !text;
      copy.disabled = !text;
      hint.textContent = text ? '' : `${card.name} has no published port for this. Add the port in the Settings tab (Extra services), or use "Inside Docker".`;
      hint.hidden = Boolean(text);
    };
    for (const [value, label] of [['docker', 'Inside Docker'], ['host', 'This computer']]) {
      const b = addButton(seg, label, () => {
        target = value;
        paint();
      });
      b.dataset.target = value;
    }
    copy.addEventListener('click', (event) => copyWithFeedback(card.env[target] || '', event.currentTarget));
    const tools = makeElement('div', 'catalog-tools');
    tools.append(seg, copy);
    box.append(tools, hint, block);
    paint();
  }
  if (card.web) {
    const row = makeElement('div', 'row-actions catalog-open');
    const open = addButton(row, 'Open page', () => openService(projectName, card.name, card.label));
    open.classList.add('btn-xs', 'primary-soft');
    const url = makeElement('code', 'cred-url');
    url.textContent = card.web.url;
    row.prepend(url);
    box.appendChild(row);
  }
  return box;
}

function renderCredentials(name, data) {
  const body = el.credBody;
  body.textContent = '';
  const status = makeElement('p', 'muted small cred-status');
  status.setAttribute('aria-live', 'polite');

  // .env, for the app
  if (data.env.docker.trim() || data.env.host.trim()) {
    const section = credSection('.env file', 'Paste these lines into the .env of your app, or let ProjectDockHub write them into the project folder (an old .env is backed up first).');
    let target = 'docker';
    const seg = makeElement('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Where your app runs');
    const explain = makeElement('p', 'muted small cred-explain');
    const code = makeElement('div', 'env-block');
    let showSecrets = false;
    const choices = ENV_TARGETS.map(([value, label]) => {
      const button = addButton(seg, label, () => pick(value));
      button.dataset.value = value;
      return button;
    });
    const warning = makeElement('p', 'cred-warning small');
    warning.setAttribute('role', 'alert');
    warning.textContent = 'Your app is a service of this project, so it runs inside Docker. These localhost values will fail there with "No such file or directory" or "Connection refused". Use "Inside Docker (recommended)" instead.';
    function pick(value) {
      target = value;
      warning.hidden = !(value === 'host' && data.appInDocker);
      for (const button of choices) button.setAttribute('aria-pressed', button.dataset.value === value ? 'true' : 'false');
      explain.textContent = ENV_TARGETS.find((t) => t[0] === value)[2];
      paintEnv();
    }
    function paintEnv() {
      code.textContent = '';
      const comment = makeElement('div', 'env-comment');
      comment.textContent = `# ProjectDockHub · ${name} · ${target === 'docker' ? 'inside Docker' : 'outside Docker'}`;
      code.appendChild(comment);
      const text = data.env[target].trim();
      if (!text) {
        const none = makeElement('div', 'env-comment');
        none.textContent = '# Nothing to add for this project.';
        code.appendChild(none);
        return;
      }
      for (const line of text.split('\n')) {
        const row = makeElement('div', '');
        const at = line.indexOf('=');
        if (line.trim().startsWith('#') || at < 1) {
          row.className = 'env-comment';
          row.textContent = line;
        } else {
          const key = makeElement('span', 'env-key');
          key.textContent = line.slice(0, at);
          const eq = makeElement('span', 'env-eq');
          eq.textContent = '=';
          const value = makeElement('span', 'env-val');
          const secret = /PASS|SECRET|TOKEN|KEY/i.test(line.slice(0, at)) && line.slice(at + 1) !== '';
          value.textContent = secret && !showSecrets ? '••••••••••••••••' : line.slice(at + 1);
          if (secret && showSecrets) value.classList.add('env-secret');
          row.append(key, eq, value);
        }
        code.appendChild(row);
      }
    }
    const actions = makeElement('div', 'row-actions');
    const reveal = addButton(actions, 'Show password', () => {
      showSecrets = !showSecrets;
      reveal.textContent = showSecrets ? 'Hide password' : 'Show password';
      paintEnv();
    });
    const copyButton = addButton(actions, 'Copy', () => copyWithFeedback(data.env[target], copyButton));
    const writeButton = addButton(actions, 'Write to project folder', async () => {
      try {
        const res = await window.envhub.writeEnv(name, target);
        const word = { created: 'Created', updated: 'Updated', unchanged: 'Already up to date:' }[res.status];
        status.textContent = `${word} ${res.file}${res.backup ? `. The old .env was saved as ${res.backup}` : ''}`;
      } catch (err) {
        status.textContent = `Could not write .env: ${ipcMessage(err)}`;
      }
    });
    writeButton.classList.add('primary');
    for (const button of actions.children) button.classList.add('btn-sm');
    const top = makeElement('div', 'cred-env-top');
    top.append(seg, actions);
    section.append(top, explain, warning, code);
    pick('docker');
    body.appendChild(section);
  }

  // Database tools on this computer
  if (data.databases.length > 0) {
    const section = credSection('Database tools', 'For TablePlus, DBeaver, pgAdmin or MongoDB Compass on this computer. Use Host localhost and these ports, not the service names.');
    const grid = makeElement('div', 'cred-grid');
    for (const db of data.databases) {
      const card = makeElement('div', 'cred-card');
      card.appendChild(credCardHead(db.label, db.label, db.note || ''));
      card.appendChild(credRow('Host', db.host));
      card.appendChild(credRow('Port', db.port));
      if (db.database !== undefined) card.appendChild(credRow('Database', db.database));
      if (db.user !== undefined) card.appendChild(credRow('User', db.user));
      if (db.key !== 'redis' || db.password) card.appendChild(credRow('Password', db.password, { secret: true }));
      if (db.rootPassword) card.appendChild(credRow('Root password', db.rootPassword, { secret: true }));
      grid.appendChild(card);
    }
    section.appendChild(grid);
    body.appendChild(section);
  }

  // Admin pages in the browser
  if (data.pages.length > 0) {
    const section = credSection('Web pages', 'Admin tools that open in your browser.');
    const list = makeElement('div', 'cred-links');
    for (const page of data.pages) {
      const row = makeElement('div', 'cred-link');
      const info = makeElement('div', 'cred-link-info');
      const title = makeElement('strong', '');
      title.textContent = page.label;
      const note = makeElement('span', 'muted small');
      note.textContent = page.note;
      info.append(title, note);
      const address = makeElement('code', 'cred-url');
      address.textContent = page.url || 'Start the project to get the address';
      const actions = makeElement('div', 'row-actions');
      if (page.url) actions.appendChild(iconButton('copy', `Copy the ${page.label} address`, (event) => copyWithFeedback(page.url, event.currentTarget)));
      if (page.service && page.url) {
        const open = addButton(actions, 'Open', () => openService(name, page.service, page.label, (text) => { status.textContent = text; }));
        open.classList.add('primary-soft');
      }
      row.append(info, address, actions);
      list.appendChild(row);
    }
    section.appendChild(list);
    body.appendChild(section);
  }

  // Services the user added by hand: one card each, from the service catalog.
  if (data.extras.some((extra) => extra.card)) {
    const section = credSection('Extra services', 'From the service catalog: what your app needs to connect. Inside Docker the host is the service name; from this computer it is 127.0.0.1 and the published port.');
    const grid = makeElement('div', 'cred-grid');
    for (const extra of data.extras) grid.appendChild(catalogCard(name, extra.card || extra));
    section.appendChild(grid);
    if (data.catalogError) {
      const warn = makeElement('p', 'cred-warning small');
      warn.textContent = `Your services catalog has an error and was skipped: ${data.catalogError}`;
      section.appendChild(warn);
    }
    body.appendChild(section);
  } else if (data.extras.length > 0) {
    const section = credSection('Extra services', 'Inside Docker, use the service name as the host. From this computer, use localhost and the port shown.');
    const grid = makeElement('div', 'cred-grid');
    for (const extra of data.extras) {
      const card = makeElement('div', 'cred-card');
      card.appendChild(credCardHead(extra.name, extra.name, extra.image));
      card.appendChild(credRow('Host in Docker', extra.name));
      for (const port of extra.ports) card.appendChild(credRow(`Port ${port.container}`, `localhost:${port.host}`));
      for (const [key, value] of Object.entries(extra.env)) {
        card.appendChild(credRow(key, value, { secret: /PASS|SECRET|TOKEN|KEY/i.test(key) }));
      }
      grid.appendChild(card);
    }
    section.appendChild(grid);
    body.appendChild(section);
  }

  if (body.children.length === 0) {
    const empty = makeElement('div', 'empty');
    const title = makeElement('strong', '');
    title.textContent = 'No database or other services';
    const text = makeElement('p', 'muted small');
    text.textContent = 'Tick MySQL, PostgreSQL, MongoDB or Redis in the Settings tab, then the logins show here.';
    empty.append(title, text);
    body.appendChild(empty);
  } else {
    const foot = makeElement('p', 'muted small cred-foot');
    foot.textContent = 'A port can change when the project starts, if it is taken. Start the project to see the final ones.';
    body.appendChild(foot);
  }
  if (data.platform === 'win32' && data.folder) body.appendChild(slowOnWindowsTip(data.folder));
  body.appendChild(status);
}

// A tip for slow projects on Windows: Defender scans every file Docker reads from the project folder.
// Gives one command to copy, and the same steps for people who do not want to use a command.
// `top` is the version on the project Overview: a coloured card, with a button to hide it for good.
const slowTipKey = () => `${NAME_PREFIX}.hideSlowTip`;

function slowTipHidden() {
  try {
    return localStorage.getItem(slowTipKey()) === '1';
  } catch (err) {
    return false;
  }
}

function isWindowsBrowser() {
  return /Windows/i.test(navigator.userAgent || '');
}

function slowOnWindowsTip(folder, { top = false, project = null } = {}) {
  const quoted = folder.replace(/'/g, "''");
  const command = [
    `Add-MpPreference -ExclusionPath '${quoted}'`,
    'Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\\Docker"',
  ].join('\n');

  const details = makeElement('details', top ? 'cred-tip cred-tip-top' : 'cred-section cred-tip');
  const summary = makeElement('summary', '');
  summary.textContent = top ? 'Project slow on Windows? Click here for the fix' : 'Project slow on Windows?';
  details.appendChild(summary);

  // Laravel: the biggest gain is vendor/ in a Docker volume, so that comes first.
  if (project && project.stack === 'laravel' && project.editable) {
    const fast = makeElement('h4', '');
    fast.textContent = 'Fastest fix: keep vendor in a Docker volume';
    const fastText = makeElement('p', 'muted small');
    fastText.textContent = 'Docker reads files from the Windows disk slowly, and Laravel loads thousands of files from vendor on every page. Open the Settings tab, turn on "Keep vendor in a Docker volume" and click Save and apply. The first start copies vendor once.';
    const fastRow = makeElement('div', 'row-actions');
    const fastButton = addButton(fastRow, 'Open Settings', () => openDetailTab(project.name, 'settings'));
    fastButton.classList.add('primary-soft');
    const also = makeElement('h4', '');
    also.textContent = 'Also: exclude the folder from Windows Defender';
    details.append(fast, fastText, fastRow, also);
  }

  const intro = makeElement('p', 'muted small');
  intro.textContent = 'Docker reads your project files from the Windows disk, and Windows Defender scans every one of them. A Laravel project has thousands of files, so pages and artisan commands can take many seconds. Exclude the project folder from the Defender scan:';
  details.appendChild(intro);

  const withCommand = makeElement('h4', '');
  withCommand.textContent = 'With a command';
  const how = makeElement('p', 'muted small');
  how.textContent = 'Open PowerShell as Administrator (right-click PowerShell, then Run as administrator), paste this and press Enter:';
  const code = makeElement('pre', 'code-block');
  code.textContent = command;
  const copyRow = makeElement('div', 'row-actions');
  const copyButton = addButton(copyRow, 'Copy command', () => copyWithFeedback(command, copyButton));
  details.append(withCommand, how, code, copyRow);

  const withoutCommand = makeElement('h4', '');
  withoutCommand.textContent = 'Without a command';
  const steps = makeElement('ol', 'small');
  for (const text of [
    'Open Windows Security, then Virus & threat protection.',
    'Under "Virus & threat protection settings" click Manage settings.',
    'Scroll to Exclusions and click Add or remove exclusions.',
    `Click Add an exclusion, choose Folder, and select ${folder}`,
    'Add a second folder: %LOCALAPPDATA%\\Docker',
  ]) {
    const item = makeElement('li', '');
    item.textContent = text;
    steps.appendChild(item);
  }
  details.append(withoutCommand, steps);

  const wsl = makeElement('h4', '');
  wsl.textContent = 'Still slow? Keep the project inside WSL';
  const wslText = makeElement('p', 'muted small');
  wslText.textContent = 'Files stored inside a WSL Linux distro (for example Ubuntu, under /home/you/project) are read much faster than files on C:. Move the project there and select that folder in ProjectDockHub. Also close heavy apps: if Windows runs out of RAM it swaps to disk and everything gets slower.';
  details.append(wsl, wslText);

  if (top) {
    const hideRow = makeElement('div', 'row-actions');
    addButton(hideRow, 'Do not show this again', () => {
      try {
        localStorage.setItem(slowTipKey(), '1');
      } catch (err) {
        // The tip just comes back next time.
      }
      details.remove();
    });
    details.appendChild(hideRow);
  }
  return details;
}

// Database, Redis and mail logins, plus the .env lines, as cards with copy buttons.
let connectionName = '';

async function showConnection(name) {
  ensureProjectsView();
  mountPanel(el.credCard);
  el.credCard.hidden = false;
  el.credTitle.textContent = `Credentials & .env: ${name}`;
  connectionName = name;
  el.credBody.textContent = '';
  const note = makeElement('div', 'loading-note');
  const spinner = makeElement('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const text = makeElement('span', '');
  text.textContent = 'Loading credentials...';
  note.append(spinner, text);
  el.credBody.appendChild(note);
  el.credCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await window.envhub.projectConnectionData(name);
    if (connectionName === name) renderCredentials(name, data);
  } catch (err) {
    el.credBody.textContent = '';
    const error = makeElement('p', 'error small');
    error.textContent = `Could not load the credentials: ${ipcMessage(err)}`;
    el.credBody.appendChild(error);
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
    setActionStatus(`${say} ${res.file}${backup}`, connectionName);
  } catch (err) {
    setActionStatus(`Could not write .env: ${err.message || err}`, connectionName, 'error');
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

// ---------- Projects page ----------

const projectsView = { list: [], containers: [], filter: 'all', query: '' };

// Short mark and colour for each stack, shown on the project card.
const STACK_MARKS = {
  laravel: { text: 'La', color: '#EA580C' },
  nestjs: { text: 'Ne', color: '#E11D48' },
  nextjs: { text: 'Nx', color: '#1F2937' },
  vue: { text: 'Vu', color: '#059669' },
  nuxt: { text: 'Nu', color: '#00A67E' },
  docker: { text: 'Dk', color: '#2563EB' },
};

function isActiveProject(project) {
  return project.state === 'running' || project.state === 'partly';
}

function setText(id, text) {
  byId(id).textContent = text;
}

// A one-line message with a close (x) button. Empty text hides it. `kind` is '', 'error' or 'ok'.
function setNote(id, text, kind = '') {
  const box = byId(id);
  box.querySelector('.note-text').textContent = text || '';
  box.dataset.kind = kind;
  box.hidden = !text;
}

// Docker's own "error during connect ... dockerDesktopLinuxEngine" means: Docker Desktop is not running.
function dockerErrorText(err) {
  const text = ipcMessage(err);
  if (/error during connect|cannot connect to the docker daemon|dockerDesktopLinuxEngine|docker daemon running/i.test(text)) {
    return 'Docker is not running. Start Docker Desktop (or click Start Docker on the Projects page), then click Refresh.';
  }
  return text;
}

// ---------- The "..." menu of a project card ----------

// A floating menu: it opens over the page, so the card never grows. One menu is shared by all cards.
const MENU_ICONS = {
  dots: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"></circle><circle cx="12" cy="12" r="1.9"></circle><circle cx="19" cy="12" r="1.9"></circle></svg>',
  restart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"></path><path d="M3 21v-5h5"></path></svg>',
  folder: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
  logs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path><path d="M9 13h6M9 17h6"></path></svg>',
  key: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9"></path><path d="m16 7 3 3"></path></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"></path></svg>',
  sliders: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"></path><circle cx="16" cy="6" r="2"></circle><circle cx="10" cy="12" r="2"></circle><circle cx="18" cy="18" r="2"></circle></svg>',
  package: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5z"></path><path d="M3 8v8l9 5 9-5V8"></path><path d="M12 13v8"></path></svg>',
  globe: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path><path d="M9 7V4h6v3"></path></svg>',
};

const projectMenu = { box: null, button: null };

function closeProjectMenu() {
  if (!projectMenu.box) return;
  projectMenu.box.hidden = true;
  projectMenu.box.textContent = '';
  if (projectMenu.button) {
    projectMenu.button.setAttribute('aria-expanded', 'false');
    projectMenu.button.classList.remove('open');
  }
  projectMenu.button = null;
}

// Fixed SVG markup from this file only, so innerHTML is safe here.
function menuItem(menu, iconName, label, onClick, { danger = false, title = '' } = {}) {
  const item = makeElement('button', danger ? 'menu-item danger' : 'menu-item');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  if (title) item.title = title;
  const mark = makeElement('span', 'menu-icon');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = MENU_ICONS[iconName];
  const text = makeElement('span', '');
  text.textContent = label;
  item.append(mark, text);
  item.addEventListener('click', () => {
    closeProjectMenu();
    onClick();
  });
  menu.appendChild(item);
  return item;
}

function menuSeparator(menu) {
  const line = makeElement('div', 'menu-sep');
  line.setAttribute('role', 'separator');
  menu.appendChild(line);
}

// Opens the details page of a project straight on one of its tabs.
function openDetailTab(name, tab) {
  openDetail(name);
  setDetailTab(tab);
}

function fillProjectMenu(menu, project) {
  menuItem(menu, 'restart', 'Restart', () => runProjectAction('Restart', 'restartProject', project.name));
  menuItem(menu, 'folder', 'Open folder', () => runProjectAction('Folder', 'openFolder', project.name));
  const pages = [['phpmyadmin', 'phpMyAdmin'], ['adminer', 'Adminer'], ['mailpit', 'Mailpit']];
  for (const [service, label] of pages) {
    if (project.services.includes(service)) {
      menuItem(menu, 'globe', `Open ${label}`, () => openService(project.name, service, label));
    }
  }
  menuSeparator(menu);
  menuItem(menu, 'logs', 'Logs', () => openDetailTab(project.name, 'logs'));
  menuItem(menu, 'key', 'Credentials & .env', () => openDetailTab(project.name, 'credentials'));
  menuItem(menu, 'link', 'Links & commands', () => openDetailTab(project.name, 'services'));
  if (project.editable) menuItem(menu, 'sliders', 'Edit services', () => openDetailTab(project.name, 'settings'));
  if (['nestjs', 'nextjs', 'vue', 'nuxt'].includes(project.stack)) {
    menuItem(menu, 'package', 'Packages for editor', () => runProjectAction('Install packages', 'installPackages', project.name, EDITOR_PACKAGES_TEXT), {
      title: 'Installs node_modules into the project folder so VS Code can find the types. The app itself keeps its own fast copy in Docker.',
    });
  }
  menuSeparator(menu);
  menuItem(menu, 'trash', 'Delete project...', () => startDeleteProject(project.name), { danger: true });
}

function openProjectMenu(button, project) {
  if (projectMenu.button === button) {
    closeProjectMenu();
    return;
  }
  closeProjectMenu();
  if (!projectMenu.box) {
    const box = makeElement('div', 'popmenu');
    box.setAttribute('role', 'menu');
    box.hidden = true;
    document.body.appendChild(box);
    projectMenu.box = box;
    // Outside click, Escape, scrolling and resizing close it. Arrow keys move between the items.
    document.addEventListener('mousedown', (event) => {
      if (projectMenu.box.hidden) return;
      if (projectMenu.box.contains(event.target) || (projectMenu.button && projectMenu.button.contains(event.target))) return;
      closeProjectMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (projectMenu.box.hidden) return;
      if (event.key === 'Escape') {
        const opener = projectMenu.button;
        closeProjectMenu();
        if (opener) opener.focus();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const items = [...projectMenu.box.querySelectorAll('.menu-item')];
        const at = items.indexOf(document.activeElement);
        const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next].focus();
      }
    });
    window.addEventListener('resize', closeProjectMenu);
    window.addEventListener('scroll', closeProjectMenu, true);
  }

  const box = projectMenu.box;
  box.textContent = '';
  fillProjectMenu(box, project);
  box.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.classList.add('open');
  projectMenu.button = button;

  // Below the button, aligned to its right edge. Above it when there is no room underneath.
  const rect = button.getBoundingClientRect();
  const width = box.offsetWidth;
  const height = box.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  box.style.setProperty('--menu-left', `${left}px`);
  box.style.setProperty('--menu-top', `${top}px`);
  box.querySelector('.menu-item').focus();
}

function moreButton(project) {
  const button = makeElement('button', 'more-btn');
  button.type = 'button';
  button.title = 'More actions';
  button.setAttribute('aria-label', `More actions for ${project.name}`);
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  const mark = makeElement('span', 'menu-icon');
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = MENU_ICONS.dots;
  button.appendChild(mark);
  button.addEventListener('click', () => openProjectMenu(button, project));
  return button;
}

// ---------- Projects table (DevOps console look) ----------

const ROW_ICONS = {
  chevronRight: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>',
  chevronDown: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
  stack: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9 5-9 5-9-5z"></path><path d="M3 13l9 5 9-5"></path></svg>',
  box: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"></path><path d="M3 8l9 5 9-5M12 13v8"></path></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"></rect></svg>',
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"></path></svg>',
  terminal: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 17l6-5-6-5M12 19h8"></path></svg>',
  dots: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path></svg>',
  external: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
  logs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M9 13h6M9 17h6"></path></svg>',
  copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>',
  restart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"></path><path d="M3 21v-5h5"></path></svg>',
};

// Rows that show their containers. The first project starts open, like in the design.
const expandedProjects = new Set();
let expandedSeeded = false;
const selectedProjects = new Set();

// Fixed SVG markup from this file only, so innerHTML is safe here.
function rowIconButton(iconHtml, label, onClick, extraClass = '') {
  const button = makeElement('button', `ibtn ${extraClass}`.trim());
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconHtml;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return button;
}

function containersOf(name) {
  return (projectsView.containers || []).filter((c) => c.project === name);
}

function shellService(project) {
  for (const candidate of ['php', 'app', 'node', 'web']) {
    if (project.services.includes(candidate)) return candidate;
  }
  return project.services[0];
}

// A row of small bars, one per container: green when it runs.
function healthBars(containers) {
  const box = makeElement('span', 'hbars');
  box.setAttribute('aria-hidden', 'true');
  for (const c of containers) box.appendChild(makeElement('span', c.state !== 'running' ? 'off' : c.health === 'unhealthy' ? 'bad' : 'on'));
  return box;
}

// Minutes since a container started, read from Docker's "Up 55 minutes" text (null when not running).
function upMinutes(status) {
  const m = /^Up\s+(?:About\s+)?(an?|\d+)\s+(second|minute|hour|day|week|month)/i.exec(status || '');
  if (!m) return /^Up\s+Less than a second/i.test(status || '') ? 0 : null;
  const n = /^an?$/i.test(m[1]) ? 1 : Number(m[1]);
  const unit = { second: 1 / 60, minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 }[m[2].toLowerCase()];
  return n * unit;
}

function agoText(minutes, short = false) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 1) return short ? 'now' : 'just now';
  const units = [[43200, 'month', 'mo'], [1440, 'day', 'd'], [60, 'hour', 'h'], [1, 'minute', 'm']];
  for (const [size, long, abbr] of units) {
    if (minutes >= size) {
      const n = Math.floor(minutes / size);
      return short ? `${n}${abbr} ago` : `${n} ${long}${n === 1 ? '' : 's'} ago`;
    }
  }
  return '—';
}

function sinceText(containers) {
  const times = containers.map((c) => upMinutes(c.status)).filter((m) => m !== null);
  return times.length ? agoText(Math.max(...times)) : '—';
}

function openPortLink(project, port, text) {
  const link = makeElement('button', 'port-link');
  link.type = 'button';
  link.textContent = text || `${port.host}:${port.container}`;
  link.title = `Open ${port.service} on localhost:${port.host}`;
  link.addEventListener('click', (event) => {
    event.stopPropagation();
    window.envhub.openPort(project.name, port.service, port.container)
      .catch((err) => setActionStatus(`Could not open: ${ipcMessage(err)}`, project.name, 'error'));
  });
  return link;
}

// A small dot plus a word, never colour alone.
function statusCell(state, text, strong = false) {
  const cell = makeElement('span', `st st-${state}${strong ? ' strong' : ''}`);
  const dot = makeElement('span', 'st-dot');
  dot.setAttribute('aria-hidden', 'true');
  const word = makeElement('span', '');
  word.textContent = text;
  cell.append(dot, word);
  return cell;
}

// The status of one container: Running, Unhealthy, Restarting, Exited (code 1) ... and a "Why?" button
// when something is wrong, which explains it (exit code, health check, last log lines).
function containerStatusCell(c, project) {
  const up = c.state === 'running';
  const box = makeElement('span', 'c-status');
  let state = up ? 'running' : 'stopped';
  let word = up ? 'Running' : String(c.state || 'stopped').replace(/^./, (x) => x.toUpperCase());
  if (up && c.health === 'unhealthy') {
    state = 'error';
    word = 'Unhealthy';
  } else if (up && c.health === 'starting') {
    state = 'partly';
    word = 'Starting';
  } else if (up && c.health === 'healthy') {
    word = 'Healthy';
  } else if (c.state === 'restarting') {
    state = 'error';
    word = 'Restarting';
  } else if (c.state === 'exited') {
    const code = /^Exited \((\d+)\)/.exec(c.status || '');
    if (code && code[1] !== '0' && code[1] !== '143' && code[1] !== '137') {
      state = 'error';
      word = `Exited (code ${code[1]})`;
    }
  }
  box.appendChild(statusCell(state, word));
  const wrong = state === 'error' || c.state === 'exited' || c.state === 'dead' || c.state === 'created';
  if (wrong && project && c.service) {
    const why = makeElement('button', 'why-btn');
    why.type = 'button';
    why.textContent = 'Why?';
    why.title = `Why is ${c.service} ${word.toLowerCase()}?`;
    why.addEventListener('click', (event) => {
      event.stopPropagation();
      showWhy(project, c.service);
    });
    box.appendChild(why);
  }
  return box;
}

const WHY_ICONS = { error: '✕', warn: '!', info: 'i', ok: '✓' };

async function showWhy(project, service) {
  const modal = byId('why-modal');
  const body = byId('why-body');
  setText('why-title', `${service} in ${project}`);
  body.textContent = '';
  const wait = makeElement('p', 'muted small');
  wait.textContent = 'Reading the container state and its last log lines...';
  body.appendChild(wait);
  modal.hidden = false;
  byId('why-close').focus();
  let res;
  try {
    res = await window.envhub.containerWhy(project, service);
  } catch (err) {
    wait.textContent = `Could not read it: ${ipcMessage(err)}`;
    return;
  }
  body.textContent = '';
  const facts = [['State', res.state || '–']];
  if (res.health) facts.push(['Health check', res.health]);
  if (res.state !== 'running' && res.state !== 'missing') facts.push(['Exit code', String(res.exitCode)]);
  if (res.restartCount) facts.push(['Restarts', String(res.restartCount)]);
  if (res.command) facts.push(['Command', res.command]);
  if (res.image) facts.push(['Image', res.image]);
  body.appendChild(kvList(facts));
  const list = makeElement('ul', 'why-list');
  for (const f of res.findings || []) {
    const li = makeElement('li', `why-item why-${f.level}`);
    const icon = makeElement('span', 'why-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = WHY_ICONS[f.level] || 'i';
    const text = makeElement('div', 'why-text');
    const what = makeElement('p', '');
    what.textContent = f.text;
    text.appendChild(what);
    if (f.fix) {
      const fix = makeElement('p', 'why-fix');
      fix.textContent = f.fix;
      text.appendChild(fix);
    }
    li.append(icon, text);
    list.appendChild(li);
  }
  body.appendChild(list);
  if (res.logs) {
    const h = makeElement('h4', 'panel-title');
    h.textContent = 'Last log lines';
    const pre = makeElement('pre', 'why-logs');
    pre.textContent = res.logs;
    body.append(h, pre);
    pre.scrollTop = pre.scrollHeight;
  }
  const actions = byId('why-actions-extra');
  actions.textContent = '';
  const copy = addButton(actions, 'Copy', (event) => copyWithFeedback(
    [`${service} in ${project}: ${res.state}`, ...(res.findings || []).map((f) => `- ${f.text}${f.fix ? ` ${f.fix}` : ''}`), '', res.logs || ''].join('\n'),
    event.currentTarget,
  ));
  copy.classList.add('btn-sm');
  if (projectsView.list.some((p) => p.name === project)) {
    const logs = addButton(actions, 'Open Logs tab', () => {
      byId('why-modal').hidden = true;
      openDetailTab(project, 'logs');
    });
    logs.classList.add('btn-sm');
  }
}

// ---------- Disk & cleanup: docker system df and prune, for the whole Docker engine ----------

const cleanupView = { usage: null, volumes: [], selected: new Set(), busy: false, loadedAt: 0, running: null };

// One card per kind. Each button is a fixed prune kind in main/docker/cleanup.js; the text says what goes.
const DU_CARDS = [
  {
    key: 'images', title: 'Images',
    note: (u) => `${u.total} image${u.total === 1 ? '' : 's'}, ${u.active} used by a container`,
    actions: [
      { kind: 'dangling', label: 'Remove dangling', confirm: 'Images with no name (<none>), left over from builds and updates. Nothing uses them.' },
      { kind: 'images', label: 'Remove unused images', danger: true, confirm: 'Every image no container uses, also stopped ones, is removed. Projects whose containers were deleted download or build their images again on the next start (this can take a while).' },
    ],
  },
  {
    key: 'containers', title: 'Containers',
    note: (u) => `${u.total} container${u.total === 1 ? '' : 's'}, ${u.active} running`,
    actions: [
      { kind: 'containers', label: 'Remove stopped containers', danger: true, confirm: 'Every stopped container of every app is removed. Data in named volumes stays. ProjectDockHub projects create their containers again on the next start.' },
    ],
  },
  {
    key: 'volumes', title: 'Volumes',
    note: (u) => `${u.total} volume${u.total === 1 ? '' : 's'}, ${u.active} in use`,
    actions: [
      { kind: 'volumes', label: 'Remove anonymous unused', confirm: 'Unnamed volumes no container uses are removed. Named volumes (database data) are not touched: pick those in the list below.' },
    ],
  },
  {
    key: 'build', title: 'Build cache',
    note: (u) => `${u.total} cache entr${u.total === 1 ? 'y' : 'ies'}`,
    actions: [
      { kind: 'build', label: 'Clear build cache', confirm: 'The saved build steps are removed. The next build of an image (the PHP image, for example) takes longer once.' },
    ],
  },
];

function ownerText(owner) {
  if (!owner) return '–';
  if (owner.kind === 'app') {
    const known = projectsView.list.some((p) => p.name === owner.project);
    if (!owner.current) return `ProjectDockHub, old name ${owner.prefix}-${owner.project}`;
    return known ? `Project ${owner.project}` : `Project ${owner.project} (deleted)`;
  }
  if (owner.kind === 'compose') return `Compose project ${owner.project}`;
  if (owner.kind === 'anonymous') return 'Anonymous (no name)';
  return 'Other';
}

// A volume of a project that still exists: removing it empties that project's database.
function isLiveProjectVolume(v) {
  return Boolean(v.owner && v.owner.kind === 'app' && v.owner.current && projectsView.list.some((p) => p.name === v.owner.project));
}

function paintDiskUsage() {
  const grid = byId('du-grid');
  grid.textContent = '';
  const u = cleanupView.usage;
  if (!u) {
    setText('du-total', '–');
    setText('du-free', '–');
    return;
  }
  const total = DU_CARDS.reduce((sum, c) => sum + u[c.key].size, 0);
  const free = DU_CARDS.reduce((sum, c) => sum + u[c.key].reclaimable, 0);
  setText('du-total', formatBytes(total));
  setText('du-free', formatBytes(free));
  for (const card of DU_CARDS) {
    const data = u[card.key];
    const box = makeElement('div', 'du-card');
    const head = makeElement('div', 'du-head');
    const title = makeElement('span', 'du-title');
    title.textContent = card.title;
    const size = makeElement('span', 'du-size');
    size.textContent = formatBytes(data.size);
    head.append(title, size);
    const bar = makeElement('div', 'du-bar');
    bar.setAttribute('role', 'img');
    const share = data.size > 0 ? Math.min(100, Math.round((data.reclaimable / data.size) * 100)) : 0;
    bar.setAttribute('aria-label', `${share}% can be freed`);
    const fill = makeElement('span', '');
    fill.style.width = `${share}%`;
    bar.appendChild(fill);
    const note = makeElement('p', 'muted small');
    note.textContent = card.note(data);
    const freeLine = makeElement('p', 'du-free');
    freeLine.textContent = data.reclaimable > 0 ? `${formatBytes(data.reclaimable)} can be freed` : 'Nothing to free';
    const actions = makeElement('div', 'du-actions');
    for (const action of card.actions) {
      const button = makeElement('button', `btn-sm${action.danger ? ' danger-outline' : ''}`);
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = cleanupView.busy;
      button.addEventListener('click', () => runPrune(action, card.title));
      actions.appendChild(button);
    }
    const run = cleanupView.running;
    if (run && run.key === card.key) {
      box.classList.add('du-working');
      box.append(head, bar, note, freeLine, pruneProgress(run));
    } else {
      box.append(head, bar, note, freeLine, actions);
    }
    grid.appendChild(box);
  }
}

function paintUnusedVolumes() {
  const body = byId('vol-list');
  body.textContent = '';
  const list = cleanupView.volumes;
  setText('du-vols', cleanupView.loadedAt ? String(list.length) : '–');
  if (!list.length) {
    const empty = makeElement('p', 'muted');
    empty.textContent = cleanupView.loadedAt ? 'No unused volumes. Every volume belongs to a container.' : 'Reading the volumes...';
    const row = emptyTableRow(empty);
    row.firstChild.colSpan = 4;
    body.appendChild(row);
  }
  for (const v of list) {
    const row = makeElement('tr', 'trow');
    row.classList.toggle('selected', cleanupView.selected.has(v.name));
    const checkCell = td('col-check');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = cleanupView.selected.has(v.name);
    check.setAttribute('aria-label', `Select ${v.name}`);
    check.addEventListener('change', () => {
      if (check.checked) cleanupView.selected.add(v.name);
      else cleanupView.selected.delete(v.name);
      paintUnusedVolumes();
    });
    checkCell.appendChild(check);
    const name = td('mono vol-name');
    name.textContent = v.name;
    name.title = v.name;
    const owner = td('');
    owner.textContent = ownerText(v.owner);
    if (isLiveProjectVolume(v)) {
      owner.classList.add('warn-text');
      owner.title = 'This project still exists. Its data is in this volume.';
    }
    const size = td('num mono');
    size.textContent = formatBytes(v.size);
    row.append(checkCell, name, owner, size);
    body.appendChild(row);
  }
  const picked = list.filter((v) => cleanupView.selected.has(v.name));
  const button = byId('vol-remove');
  button.disabled = picked.length === 0 || cleanupView.busy;
  button.textContent = picked.length ? `Remove ${picked.length} selected (${formatBytes(picked.reduce((sum, v) => sum + v.size, 0))})` : 'Remove selected';
  byId('vol-all').checked = list.length > 0 && picked.length === list.length;
}

async function refreshCleanup() {
  setNote('cleanup-note', '');
  try {
    cleanupView.usage = await window.envhub.diskUsage();
  } catch (err) {
    cleanupView.usage = null;
    setNote('cleanup-note', `Could not read the disk use: ${ipcMessage(err)}`, 'error');
  }
  paintDiskUsage();
  // The volume list is slower (Docker measures every volume), so it comes second.
  try {
    cleanupView.volumes = await window.envhub.unusedVolumes();
    const names = new Set(cleanupView.volumes.map((v) => v.name));
    for (const name of [...cleanupView.selected]) if (!names.has(name)) cleanupView.selected.delete(name);
  } catch (err) {
    cleanupView.volumes = [];
    setNote('cleanup-note', `Could not list the volumes: ${ipcMessage(err)}`, 'error');
  }
  cleanupView.loadedAt = Date.now();
  paintUnusedVolumes();
}

function setCleanupBusy(busy) {
  cleanupView.busy = busy;
  byId('cleanup-refresh').disabled = busy;
  paintDiskUsage();
  paintUnusedVolumes();
}

// Docker's prune commands print nothing until they finish, so the progress comes from the disk use itself:
// it is read again every 2 seconds, and the bar shows how much of the space that could be freed is gone.
// "Remove dangling" and "Remove anonymous unused" free only part of it, so their bar only moves (no percent).
const PRUNE_POLL_MS = 2000;
const PRUNE_MEASURED = new Set(['build', 'images', 'containers']);

function elapsedText(ms) {
  const sec = Math.floor(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function pruneProgress(run) {
  const wrap = makeElement('div', 'du-progress');
  const track = makeElement('div', `du-ptrack${run.fraction === null ? ' indeterminate' : ''}`);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', run.label);
  if (run.fraction !== null) {
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(run.fraction * 100)));
  }
  const fill = makeElement('span', '');
  if (run.fraction !== null) fill.style.width = `${Math.max(3, Math.round(run.fraction * 100))}%`;
  track.appendChild(fill);
  const line = makeElement('p', 'du-ptext');
  const freed = run.freed > 0 ? `${formatBytes(run.freed)}${run.fraction !== null ? ` of ${formatBytes(run.target)}` : ''} freed` : 'Cleaning up';
  const pct = run.fraction !== null ? ` · ${Math.round(run.fraction * 100)}%` : '';
  line.textContent = `${run.done ? 'Done' : freed}${pct} · ${elapsedText((run.endedAt || Date.now()) - run.startedAt)}`;
  wrap.append(track, line);
  return wrap;
}

// Updates the bar and its text in place, so the moving bar does not start over every second.
function updatePruneProgress(run) {
  const wrap = document.querySelector('#du-grid .du-progress');
  if (!wrap) {
    paintDiskUsage();
    return;
  }
  wrap.replaceWith(pruneProgressKeepingTrack(run, wrap));
}

function pruneProgressKeepingTrack(run, old) {
  const fresh = pruneProgress(run);
  if (run.fraction === null) {
    // Keep the old moving bar element; only the text changes.
    const track = old.querySelector('.du-ptrack');
    fresh.replaceChild(track, fresh.querySelector('.du-ptrack'));
    return fresh;
  }
  const track = old.querySelector('.du-ptrack');
  track.querySelector('span').style.width = fresh.querySelector('.du-ptrack span').style.width;
  track.setAttribute('aria-valuenow', String(Math.round(run.fraction * 100)));
  fresh.replaceChild(track, fresh.querySelector('.du-ptrack'));
  return fresh;
}

async function pollPrune(run) {
  if (cleanupView.running !== run || run.done) return;
  try {
    const usage = await window.envhub.diskUsage();
    if (cleanupView.running !== run || run.done) return;
    const now = usage[run.key].reclaimable;
    run.freed = Math.max(0, run.start - now);
    if (run.measured && run.target > 0) run.fraction = Math.min(0.99, run.freed / run.target);
  } catch (err) {
    // Docker may be busy with the cleanup itself: keep the bar moving and try again.
  }
  updatePruneProgress(run);
  run.timer = setTimeout(() => pollPrune(run), PRUNE_POLL_MS);
}

async function runPrune(action, title) {
  const ok = await confirmDialog({ title: `${action.label}?`, body: action.confirm, okLabel: action.label });
  if (!ok) return;
  const card = DU_CARDS.find((c) => c.actions.includes(action));
  const before = cleanupView.usage ? cleanupView.usage[card.key] : null;
  const measured = PRUNE_MEASURED.has(action.kind) && before && before.reclaimable > 0;
  const run = {
    key: card.key,
    label: action.label,
    startedAt: Date.now(),
    start: before ? before.reclaimable : 0,
    target: before ? before.reclaimable : 0,
    measured,
    fraction: measured ? 0 : null,
    freed: 0,
    done: false,
    timer: null,
    ticker: null,
  };
  cleanupView.running = run;
  setCleanupBusy(true);
  setNote('cleanup-note', `${title}: cleaning up. This can take a few minutes; you can use other pages meanwhile.`);
  // The time ticks every second; the freed space is read every 2 seconds.
  run.ticker = setInterval(() => updatePruneProgress(run), 1000);
  run.timer = setTimeout(() => pollPrune(run), PRUNE_POLL_MS);
  let ok2 = false;
  try {
    const res = await window.envhub.pruneDocker(action.kind);
    const freed = res.reclaimed > 0 ? res.reclaimed : run.freed;
    const text = `${action.label}: done in ${elapsedText(Date.now() - run.startedAt)}. ${freed > 0 ? `${formatBytes(freed)} freed.` : 'Nothing was left to remove.'}`;
    setNote('cleanup-note', text, 'ok');
    addNotification({ text, kind: 'info', source: 'app' });
    run.freed = freed;
    ok2 = true;
  } catch (err) {
    setNote('cleanup-note', `${action.label}: ${ipcMessage(err)}`, 'error');
  }
  clearTimeout(run.timer);
  clearInterval(run.ticker);
  run.done = true;
  run.endedAt = Date.now();
  if (ok2) {
    // A full bar for a moment, so the end is seen.
    if (run.fraction !== null) run.fraction = 1;
    updatePruneProgress(run);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  cleanupView.running = null;
  setCleanupBusy(false);
  refreshCleanup();
}

async function removeSelectedVolumes() {
  const picked = cleanupView.volumes.filter((v) => cleanupView.selected.has(v.name));
  if (!picked.length) return;
  const live = [...new Set(picked.filter(isLiveProjectVolume).map((v) => v.owner.project))];
  const warning = live.length
    ? `\n\n${live.join(', ')} still exist${live.length === 1 ? 's' : ''}: the next start begins with an empty database for that service.`
    : '';
  const ok = await confirmDialog({
    title: picked.length === 1 ? 'Remove this volume?' : `Remove ${picked.length} volumes?`,
    body: `${picked.map((v) => v.name).join(', ')}\n\nThe data in ${picked.length === 1 ? 'it' : 'them'} is deleted for good.${warning}`,
    okLabel: picked.length === 1 ? 'Remove volume' : 'Remove volumes',
  });
  if (!ok) return;
  setCleanupBusy(true);
  try {
    const res = await window.envhub.removeVolumes(picked.map((v) => v.name));
    for (const name of res.removed) cleanupView.selected.delete(name);
    const freed = picked.filter((v) => res.removed.includes(v.name)).reduce((sum, v) => sum + v.size, 0);
    const failed = res.failed.length ? ` Not removed: ${res.failed.map((f) => `${f.name} (${f.error})`).join('; ')}.` : '';
    setNote('cleanup-note', `${res.removed.length} volume${res.removed.length === 1 ? '' : 's'} removed, ${formatBytes(freed)} freed.${failed}`, res.failed.length ? 'error' : 'ok');
  } catch (err) {
    setNote('cleanup-note', `Could not remove: ${ipcMessage(err)}`, 'error');
  }
  setCleanupBusy(false);
  refreshCleanup();
}

function bindCleanupPage() {
  byId('nav-cleanup').addEventListener('click', () => {
    showView('cleanup');
    // Read again when the page is opened, at most once a minute unless Refresh is clicked.
    if (!cleanupView.busy && Date.now() - cleanupView.loadedAt > 60000) refreshCleanup();
  });
  byId('cleanup-refresh').addEventListener('click', () => refreshCleanup());
  byId('vol-remove').addEventListener('click', removeSelectedVolumes);
  byId('vol-all').addEventListener('change', (event) => {
    cleanupView.selected.clear();
    if (event.target.checked) for (const v of cleanupView.volumes) cleanupView.selected.add(v.name);
    paintUnusedVolumes();
  });
  paintUnusedVolumes();
}

function bindWhyModal() {
  const close = () => {
    byId('why-modal').hidden = true;
  };
  byId('why-close').addEventListener('click', close);
  byId('why-modal').addEventListener('click', (event) => {
    if (event.target.id === 'why-modal') close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !byId('why-modal').hidden) close();
  });
}

function openShell(name, service) {
  window.envhub.projectShell(name, service)
    .catch((err) => setActionStatus(`Could not open a terminal: ${ipcMessage(err)}`, name, 'error'));
}

function td(className = '') {
  return makeElement('td', className);
}

function containerChildRow(project, c) {
  const up = c.state === 'running';
  const row = makeElement('tr', 'trow child');
  const name = td('c-name');
  const nameWrap = makeElement('span', 'c-name-wrap');
  const boxIcon = makeElement('span', 'c-box');
  boxIcon.innerHTML = ROW_ICONS.box;
  const svc = makeElement('span', 'c-svc');
  svc.textContent = c.service || c.name;
  const full = makeElement('span', 'c-full mono');
  full.textContent = c.name;
  nameWrap.append(boxIcon, svc, full);
  name.appendChild(nameWrap);
  const image = td('mono c-image');
  image.textContent = c.image || '—';
  const status = td();
  status.appendChild(containerStatusCell(c, project.name));
  const ports = td('c-ports');
  const own = project.ports.filter((p) => p.service === c.service);
  if (own.length) for (const p of own) ports.appendChild(openPortLink(project, p));
  else {
    ports.textContent = 'internal';
    ports.classList.add('muted');
  }
  const since = td('muted');
  since.textContent = up ? agoText(upMinutes(c.status)) : '—';
  const actionsCell = td('col-actions');
  const actions = makeElement('div', 'row-icons');
  if (c.service) {
    const power = rowIconButton(up ? ROW_ICONS.stop : ROW_ICONS.play, `${up ? 'Stop' : 'Start'} ${c.service}`, async () => {
      try {
        await (up ? window.envhub.stopService(project.name, c.service) : window.envhub.startService(project.name, c.service));
      } catch (err) {
        setActionStatus(`Could not ${up ? 'stop' : 'start'} ${c.service}: ${ipcMessage(err)}`, project.name, 'error');
      }
      loadProjects();
    }, 'sm');
    const shell = rowIconButton(ROW_ICONS.terminal, `Open shell in ${c.service}`, () => openShell(project.name, c.service), 'sm');
    shell.disabled = !up;
    actions.append(power, shell);
  }
  actionsCell.appendChild(actions);
  row.append(td(), name, image, status, ports, since, actionsCell);
  return row;
}

function buildProjectRows(project) {
  const state = STATUS_TEXT[project.state] ? project.state : 'stopped';
  const running = state !== 'stopped';
  const containers = containersOf(project.name);
  const up = containers.filter((c) => c.state === 'running').length;
  const total = containers.length || project.services.length;
  const open = expandedProjects.has(project.name);
  const rows = [];

  const row = makeElement('tr', 'trow parent');
  row.dataset.project = project.name;
  row.classList.toggle('open', open);
  row.classList.toggle('selected', selectedProjects.has(project.name));

  const checkCell = td('col-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = selectedProjects.has(project.name);
  check.setAttribute('aria-label', `Select ${project.name}`);
  check.addEventListener('change', () => {
    if (check.checked) selectedProjects.add(project.name);
    else selectedProjects.delete(project.name);
    row.classList.toggle('selected', check.checked);
  });
  checkCell.appendChild(check);

  const nameCell = td();
  const nameWrap = makeElement('div', 'p-name');
  const chevron = rowIconButton(open ? ROW_ICONS.chevronDown : ROW_ICONS.chevronRight, `${open ? 'Collapse' : 'Expand'} ${project.name}`, () => {
    if (expandedProjects.has(project.name)) expandedProjects.delete(project.name);
    else expandedProjects.add(project.name);
    renderProjects();
  }, 'chev');
  chevron.setAttribute('aria-expanded', open ? 'true' : 'false');
  const icon = makeElement('span', 'stack-ico');
  icon.innerHTML = ROW_ICONS.stack;
  const nameButton = makeElement('button', 'name-link');
  nameButton.type = 'button';
  nameButton.textContent = project.name;
  nameButton.title = 'Open the project details';
  nameButton.addEventListener('click', () => openDetail(project.name));
  nameWrap.append(chevron, icon, nameButton);
  nameCell.appendChild(nameWrap);

  const stackCell = td('fg2');
  stackCell.textContent = project.label;

  const statusCellTd = td();
  statusCellTd.appendChild(statusCell(state, `${STATUS_TEXT[state]} (${up}/${total})`, true));
  if (containers.length) statusCellTd.appendChild(healthBars(containers));

  const portsCell = td('p-ports');
  if (project.ports.length) {
    portsCell.appendChild(openPortLink(project, project.ports[0]));
    if (project.ports.length > 1) {
      const more = makeElement('button', 'link-quiet');
      more.type = 'button';
      more.textContent = `· Show all ports (${project.ports.length})`;
      more.addEventListener('click', () => {
        expandedProjects.add(project.name);
        renderProjects();
      });
      portsCell.append(' ', more);
    }
  } else {
    portsCell.textContent = '—';
    portsCell.classList.add('muted');
  }

  const sinceCell = td('fg2');
  sinceCell.textContent = running ? sinceText(containers) : '—';

  const actionsCell = td('col-actions');
  const actions = makeElement('div', 'row-icons');
  if (running) {
    const openButton = makeElement('button', 'btn-open');
    openButton.type = 'button';
    openButton.innerHTML = `<span>Open</span>${ROW_ICONS.external}`;
    openButton.addEventListener('click', () => runProjectAction('Open', 'openProject', project.name));
    actions.appendChild(openButton);
    actions.appendChild(rowIconButton(ROW_ICONS.stop, `Stop ${project.name}`, () => runProjectAction('Stop', 'stopProject', project.name)));
  } else {
    const startButton = makeElement('button', 'btn-open');
    startButton.type = 'button';
    startButton.innerHTML = `${ROW_ICONS.play}<span>Start</span>`;
    startButton.addEventListener('click', () => startFromList(project.name));
    actions.appendChild(startButton);
  }
  const terminal = rowIconButton(ROW_ICONS.terminal, `Open terminal for ${project.name}`, () => openShell(project.name, shellService(project)));
  terminal.disabled = !running;
  actions.append(terminal, moreButton(project));
  actions.appendChild(rowIconButton(ROW_ICONS.trash, `Delete ${project.name}`, () => startDeleteProject(project.name), 'danger-hover'));
  actionsCell.appendChild(actions);

  row.append(checkCell, nameCell, stackCell, statusCellTd, portsCell, sinceCell, actionsCell);
  rows.push(row);

  if (open) {
    const list = containers.length
      ? containers
      : project.services.map((service) => ({ service, name: dockerName(project.name, service), image: '', state: 'not created', status: '' }));
    for (const c of list) rows.push(containerChildRow(project, c));
  }

  if (notes.has(project.name)) {
    const noteRow = makeElement('tr', 'note-row');
    const cell = td();
    cell.colSpan = 7;
    const box = makeElement('div', 'note-box');
    box.setAttribute('role', 'status');
    cell.appendChild(box);
    noteRow.appendChild(cell);
    rows.push(noteRow);
    paintNote(box, project.name);
  }
  return rows;
}

// Kept for the code that still asks for one card per project.
function buildProjectCard(project) {
  const frag = document.createDocumentFragment();
  for (const row of buildProjectRows(project)) frag.appendChild(row);
  return frag;
}

// Counts for the overview cards, the filter buttons, the sidebar and the status bar.
function renderProjectCounts(list) {
  const counts = { running: 0, partly: 0, stopped: 0 };
  for (const project of list) {
    const key = counts[project.state] !== undefined ? project.state : 'stopped';
    counts[key] += 1;
  }
  const containers = (projectsView.containers || []).filter((c) => c.project);
  const up = containers.filter((c) => c.state === 'running').length;
  setText('stat-total', String(list.length));
  setText('stat-running', String(counts.running));
  setText('stat-partly', String(counts.partly));
  setText('stat-stopped', String(counts.stopped));
  let stacksNote = '';
  if (list.length && counts.running === list.length) stacksNote = 'all running';
  else if (list.length && counts.stopped === list.length) stacksNote = 'all stopped';
  setText('ovc-stacks-note', stacksNote);
  byId('ovc-stacks-note').className = `note ${counts.running === list.length ? 'ok' : ''}`;
  const bar = byId('ovc-stacks-bar');
  bar.textContent = '';
  for (const key of ['running', 'partly', 'stopped']) {
    if (!counts[key]) continue;
    const part = makeElement('span', `bar-${key}`);
    part.style.setProperty('--w', String(counts[key]));
    bar.appendChild(part);
  }
  setText('ovc-up', String(up));
  setText('ovc-total', String(containers.length));
  setText('ovc-containers-note', containers.length && up === containers.length ? 'healthy' : containers.length ? `${containers.length - up} stopped` : '');
  byId('ovc-containers-note').className = `note ${containers.length && up === containers.length ? 'ok' : 'warn'}`;
  const health = byId('ovc-health');
  health.textContent = '';
  health.setAttribute('aria-label', `${up} of ${containers.length} containers running`);
  for (const c of containers) {
    const cell = makeElement('span', c.state === 'running' ? 'on' : 'off');
    cell.title = `${c.name}: ${c.status || c.state}`;
    health.appendChild(cell);
  }

  const ports = [];
  for (const project of list) for (const port of project.ports) ports.push({ project, port });
  setText('ovc-ports', String(ports.length));
  const chips = byId('ovc-port-chips');
  chips.textContent = '';
  for (const { project, port } of ports) chips.appendChild(openPortLink(project, port, `:${port.host}`)).classList.add('chip');

  setText('nav-count', String(list.length));
  setText('nav-ccount', String(containers.length));
  setText('sb-stacks', `stacks ${list.length} · containers ${up}/${containers.length}`);
  setText('filter-all', `All ${list.length}`);
  setText('filter-active', `Active ${counts.running + counts.partly}`);
  setText('filter-stopped', `Stopped ${counts.stopped}`);
  setText('ptable-foot', `Showing ${list.length} project${list.length === 1 ? '' : 's'} · ${containers.length} container${containers.length === 1 ? '' : 's'}`);
  renderEndpoints(list);
  renderEvents(list);
}

function renderEndpoints(list) {
  const box = byId('endpoint-list');
  box.textContent = '';
  let count = 0;
  for (const project of list) {
    for (const port of project.ports) {
      const li = makeElement('li', '');
      const where = makeElement('span', 'ep-where');
      where.textContent = `${project.name} `;
      const service = makeElement('span', 'muted');
      service.textContent = `/ ${port.service === 'nginx' || port.service === project.ports[0].service ? 'web' : port.service}`;
      where.appendChild(service);
      li.append(where, openPortLink(project, port, `localhost:${port.host}`));
      box.appendChild(li);
      count += 1;
    }
  }
  setText('endpoint-count', String(count));
  if (!count) {
    const li = makeElement('li', 'muted');
    li.textContent = 'No published ports yet.';
    box.appendChild(li);
  }
}

// ---------- Events: what Docker reported while the window was open, then the state of each stack ----------

const liveEvents = [];
const LIVE_EVENTS_MAX = 30;
const EVENT_WORDS = { start: 'started', stop: 'stopped', die: 'exited', kill: 'killed', restart: 'restarted', create: 'created', destroy: 'removed', pause: 'paused', unpause: 'resumed' };

function rememberEvent(change) {
  if (!change || !change.project) return;
  liveEvents.unshift({ ...change, at: Date.now() });
  if (liveEvents.length > LIVE_EVENTS_MAX) liveEvents.length = LIVE_EVENTS_MAX;
}

function eventRow(level, source, message, age) {
  const li = makeElement('li', '');
  const dot = makeElement('span', `ev-dot ev-${level}`);
  dot.setAttribute('aria-hidden', 'true');
  const src = makeElement('span', 'ev-src');
  src.textContent = source;
  const msg = makeElement('span', 'ev-msg');
  msg.textContent = message;
  const when = makeElement('span', 'ev-age');
  when.textContent = age;
  li.append(dot, src, msg, when);
  return li;
}

function renderEvents(list) {
  const box = byId('event-list');
  if (!box) return;
  box.textContent = '';
  const rows = [];
  for (const ev of liveEvents.slice(0, 8)) {
    const level = ['start', 'restart', 'create', 'unpause'].includes(ev.action) ? 'ok' : ev.action === 'die' || ev.action === 'kill' ? 'warn' : 'off';
    const minutes = (Date.now() - ev.at) / 60000;
    rows.push(eventRow(level, ev.service ? `${ev.project}/${ev.service}` : ev.project, EVENT_WORDS[ev.action] || ev.action, agoText(minutes, true)));
  }
  for (const project of list) {
    const containers = containersOf(project.name);
    const up = containers.filter((c) => c.state === 'running');
    const times = up.map((c) => upMinutes(c.status)).filter((m) => m !== null);
    const age = times.length ? agoText(Math.max(...times), true) : '—';
    if (up.length && up.length === containers.length) {
      rows.push(eventRow('ok', project.name, `stack started · ${containers.length} container${containers.length === 1 ? '' : 's'}`, age));
    } else if (up.length) {
      rows.push(eventRow('warn', project.name, `partly running · ${up.length} of ${containers.length} containers`, age));
    } else {
      rows.push(eventRow('off', project.name, containers.length ? 'stack stopped' : 'not started yet', '—'));
    }
    for (const c of containers) {
      if (c.state !== 'running' && up.length) rows.push(eventRow('warn', `${project.name}/${c.service || c.name}`, c.status || c.state, '—'));
    }
  }
  for (const row of rows.slice(0, 8)) box.appendChild(row);
  if (!rows.length) box.appendChild(eventRow('off', 'docker', 'No events yet', ''));
}

function emptyTableRow(content) {
  const row = makeElement('tr', 'empty-row');
  const cell = td();
  cell.colSpan = 7;
  cell.appendChild(content);
  row.appendChild(cell);
  return row;
}

function renderProjects() {
  const { list, filter, query } = projectsView;
  const needle = query.trim().toLowerCase();
  const onlyRunning = byId('only-running').checked;
  if (!expandedSeeded && list.length) {
    expandedSeeded = true;
    expandedProjects.add(list[0].name);
  }
  renderProjectCounts(list);

  const shown = list.filter((project) => {
    if (filter === 'active' && !isActiveProject(project)) return false;
    if (filter === 'stopped' && isActiveProject(project)) return false;
    if (onlyRunning && project.state !== 'running') return false;
    const containerText = containersOf(project.name).map((c) => `${c.name} ${c.image}`).join(' ');
    const haystack = `${project.name} ${project.label} ${project.ports.map((p) => p.host).join(' ')} ${containerText}`.toLowerCase();
    if (needle && !haystack.includes(needle)) return false;
    return true;
  });

  el.projectList.textContent = '';
  if (list.length === 0) {
    const empty = makeElement('div', 'empty-hero');
    const title = makeElement('strong', '');
    title.textContent = 'No projects yet';
    const text = makeElement('p', 'muted');
    text.textContent = 'Make your first project and everything it needs runs in Docker.';
    const make = addButton(empty, '+ New project', () => el.newProjectBtn.click());
    make.classList.add('primary');
    empty.prepend(title, text);
    el.projectList.appendChild(emptyTableRow(empty));
    return;
  }
  if (shown.length === 0) {
    const empty = makeElement('p', 'muted');
    empty.textContent = 'No project matches this filter or search.';
    el.projectList.appendChild(emptyTableRow(empty));
    return;
  }
  for (const project of shown) {
    for (const row of buildProjectRows(project)) el.projectList.appendChild(row);
  }
}

// A spinner in the table while the project list is read for the first time.
function renderProjectsLoading() {
  for (const id of ['stat-total', 'stat-running', 'stat-partly', 'stat-stopped', 'nav-count']) {
    setText(id, '–');
  }
  el.projectList.textContent = '';
  const note = makeElement('div', 'loading-note');
  note.setAttribute('role', 'status');
  const spinner = makeElement('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const text = makeElement('span', '');
  text.textContent = 'Loading projects...';
  note.append(spinner, text);
  el.projectList.appendChild(emptyTableRow(note));
}

function renderProjectsError(err) {
  el.projectList.textContent = '';
  const box = makeElement('div', 'empty-hero');
  const text = makeElement('p', 'error');
  text.textContent = `Could not load the projects: ${ipcMessage(err)}`;
  const retry = addButton(box, 'Try again', () => {
    renderProjectsLoading();
    loadProjects();
  });
  retry.classList.add('primary');
  box.prepend(text);
  el.projectList.appendChild(emptyTableRow(box));
}

async function loadProjects() {
  try {
    const [list, containers] = await Promise.all([
      window.envhub.listProjects(),
      window.envhub.listContainers().catch(() => []),
    ]);
    projectsView.list = list;
    projectsView.containers = containers;
    // The Containers page shows ports from the project list, so it is drawn again with the new list.
    containersView.items = containers;
    if (containers.length || !containersView.error) {
      containersView.error = '';
      setContainerMessage('');
    }
    renderContainers();
  } catch (err) {
    renderProjectsError(err);
    return;
  }
  renderProjects();
  if (document.body.dataset.view === 'detail') {
    renderDetail();
    loadOverviewData(detailState.name);
  }
}

function setFilter(filter) {
  projectsView.filter = filter;
  for (const [key, id] of [['all', 'filter-all'], ['active', 'filter-active'], ['stopped', 'filter-stopped']]) {
    byId(id).setAttribute('aria-pressed', key === filter ? 'true' : 'false');
  }
  renderProjects();
}

// ---------- Views (sidebar) and theme ----------

// Shows one view: 'projects', 'new' or 'system'. The CSS hides the others.
// "All projects": back to the list, scrolled to the project that was open, with a short glow on its card.
function backToProjects() {
  const name = detailState.name;
  showView('projects');
  if (!name) return;
  // Wait one frame, so the list has its size again before it scrolls.
  requestAnimationFrame(() => requestAnimationFrame(() => highlightProjectCard(name)));
}

function highlightProjectCard(name) {
  const card = [...document.querySelectorAll('tr.parent')].find((c) => c.dataset.project === name);
  if (!card) return;
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
  card.classList.remove('pcard-flash');
  void card.offsetWidth;
  card.classList.add('pcard-flash');
  setTimeout(() => card.classList.remove('pcard-flash'), 2600);
}

function showView(view) {
  document.body.dataset.view = view;
  if (view !== 'detail') {
    stopOverviewRefresh();
    stopLogView();
    stopMailView();
    stopRequestsView();
  }
  const current = view === 'detail' ? 'projects' : view;
  for (const item of document.querySelectorAll('.nav-item[data-view]')) {
    if (item.dataset.view === current) {
      item.setAttribute('aria-current', 'page');
    } else {
      item.removeAttribute('aria-current');
    }
  }
}

const THEMES = ['system', 'light', 'dark'];

// The prefix of every Docker name (naming.json in the project root), for example envhub-shop-php.
let NAME_PREFIX = 'envhub';
const dockerName = (project, service) => `${NAME_PREFIX}-${project}${service ? `-${service}` : ''}`;
const themeKey = () => `${NAME_PREFIX}-theme`;

function readTheme() {
  try {
    const saved = localStorage.getItem(themeKey());
    return THEMES.includes(saved) ? saved : 'system';
  } catch (err) {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.dataset.theme = theme;
  }
  for (const radio of document.querySelectorAll('[data-theme-choice]')) {
    radio.checked = radio.dataset.themeChoice === theme;
  }
  try {
    localStorage.setItem(themeKey(), theme);
  } catch (err) {
    // Storage can be blocked. The theme still works for this session.
  }
}

function bindProjectsPage() {
  byId('nav-projects').addEventListener('click', () => showView('projects'));
  byId('nav-new').addEventListener('click', () => {
    if (el.createCard.hidden) {
      showCreateCard();
    } else {
      showView('new');
    }
  });
  byId('nav-system').addEventListener('click', () => showView('system'));

  byId('filter-all').addEventListener('click', () => setFilter('all'));
  byId('filter-active').addEventListener('click', () => setFilter('active'));
  byId('filter-stopped').addEventListener('click', () => setFilter('stopped'));
  byId('only-running').addEventListener('change', renderProjects);
  byId('select-all-projects').addEventListener('change', (event) => {
    selectedProjects.clear();
    if (event.target.checked) for (const project of projectsView.list) selectedProjects.add(project.name);
    renderProjects();
  });
  byId('tb-settings').addEventListener('click', () => byId('nav-settings').click());
  const globalSearch = byId('global-search');
  globalSearch.addEventListener('input', () => {
    if (document.body.dataset.view === 'system') {
      containersView.query = globalSearch.value;
      renderContainers();
      return;
    }
    if (document.body.dataset.view !== 'projects') showView('projects');
    projectsView.query = globalSearch.value;
    byId('project-search').value = globalSearch.value;
    renderProjects();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      globalSearch.focus();
      globalSearch.select();
    }
  });
  byId('project-search').addEventListener('input', (event) => {
    projectsView.query = event.target.value;
    renderProjects();
  });

  byId('nav-settings').addEventListener('click', () => {
    showView('settings');
    loadProjectsDir();
  });
  bindSettingsPage();
  byId('settings-change-dir').addEventListener('click', () => changeProjectsDir(false));
  byId('settings-reset-dir').addEventListener('click', () => changeProjectsDir(true));
  byId('settings-versions-btn').addEventListener('click', openVersionsFile);
  byId('settings-catalog-btn').addEventListener('click', async () => {
    try {
      const res = await window.envhub.openCatalogFile();
      if (res && res.ok === false) say(`Could not open the services catalog: ${res.error}`);
    } catch (err) {
      say(`Could not open the services catalog: ${ipcMessage(err)}`);
    }
  });

  byId('detail-back').addEventListener('click', backToProjects);
  byId('np-crumb-projects').addEventListener('click', hideCreateCard);
  byId('np-cancel').addEventListener('click', hideCreateCard);
  byId('detail-primary').addEventListener('click', detailPrimary);
  byId('detail-stop').addEventListener('click', () => runProjectAction('Stop', 'stopProject', detailState.name));
  byId('detail-restart').addEventListener('click', () => runProjectAction('Restart', 'restartProject', detailState.name));
  byId('detail-delete').addEventListener('click', () => startDeleteProject(detailState.name));
  byId('edit-delete').addEventListener('click', () => startDeleteProject(editState.name || detailState.name));
  for (const tab of document.querySelectorAll('.tab[data-tab]')) {
    tab.addEventListener('click', () => setDetailTab(tab.dataset.tab));
  }
  byId('detail-url').addEventListener('click', () => runProjectAction('Open', 'openProject', detailState.name));
  byId('detail-lan-url').addEventListener('click', (event) => copyWithFeedback(event.currentTarget.dataset.url || event.currentTarget.textContent, event.currentTarget));
  byId('detail-terminal').addEventListener('click', () => {
    const service = defaultShellService();
    if (service) {
      openTerminal(service);
    } else {
      setActionStatus('Start the project first. No service is running.', detailState.name, 'error');
    }
  });

  applyTheme(readTheme());
}

// ---------- Project details ----------

const detailState = { name: '', tab: 'overview' };

// Shows the panels of the Projects page again, unless the details page is open.
function ensureProjectsView() {
  if (document.body.dataset.view !== 'detail') showView('projects');
}

// The Logs, Edit and Links cards move into the open tab, or back to the Projects page.
function mountPanel(card) {
  if (document.body.dataset.view === 'detail') {
    byId('detail-panel').appendChild(card);
  } else {
    document.querySelector('.content').insertBefore(card, byId('containers-card'));
  }
}

function isRunningProject(project) {
  return project.state === 'running' || project.state === 'partly';
}

function openDetail(name) {
  detailState.name = name;
  overviewState.name = '';
  // Seen before: show it at once, the new numbers replace it a moment later.
  const cached = overviewCache.get(name);
  if (cached) Object.assign(overviewState, cached, { name });
  showLanAddress('');
  showView('detail');
  renderDetail();
  setDetailTab('overview');
  const project = projectsView.list.find((p) => p.name === name);
  if (cached && project) renderOverview(project);
  else renderOverviewLoading();
  loadOverviewData(name);
  window.scrollTo({ top: 0 });
}

function detailPrimary() {
  const project = projectsView.list.find((p) => p.name === detailState.name);
  if (!project) return;
  if (isRunningProject(project)) {
    runProjectAction('Open', 'openProject', project.name);
  } else {
    startFromList(project.name);
  }
}

function renderDetail() {
  const project = projectsView.list.find((p) => p.name === detailState.name);
  if (!project) {
    showView('projects');
    return;
  }
  const state = STATUS_TEXT[project.state] ? project.state : 'stopped';
  const running = state !== 'stopped';
  setText('detail-crumb', project.name);
  setText('detail-eyebrow', `stack / ${dockerName(project.name)}`);
  setText('detail-name', project.name);
  setText('detail-stack', project.label);
  byId('detail-status').dataset.state = state;
  setText('detail-status-text', STATUS_TEXT[state]);
  if (!running) setText('detail-uptime', '');
  const url = byId('detail-url');
  url.hidden = project.ports.length === 0;
  url.textContent = project.ports.length ? `localhost:${project.ports[0].host}` : '';
  if (project.ports.length) url.appendChild(icon('external'));
  setIconLabel(byId('detail-primary'), running ? 'external' : 'play', running ? 'Open site' : 'Start');
  byId('detail-stop').hidden = !running;
  byId('detail-terminal').disabled = !running;
  document.querySelector('.tab[data-tab="settings"]').hidden = !project.editable;
  // Mail and Redis tabs only for projects that have Mailpit / Redis.
  // Found by name or by image, so an extra service running Mailpit / Redis counts too.
  document.querySelector('.tab[data-tab="data"]').hidden = !(project.viewers && project.viewers.length);
  paintNote(byId('detail-note'), project.name);
}

// ---------- Details: overview data ----------

const overviewState = { name: '', links: null, containers: [], logs: '', details: null, stats: null, disk: null, diskAt: 0, volumes: null };
// What was last read for each project (services, containers, logs, settings form, numbers).
// Opening a project shows this at once while the new numbers load. It is replaced after every read, and dropped
// when the project changes: settings saved, a service started or stopped, a container started or stopped, deleted.
const overviewCache = new Map();
const OVERVIEW_CACHE_MAX = 30;

function rememberOverview() {
  const { name } = overviewState;
  if (!name) return;
  overviewCache.delete(name);
  overviewCache.set(name, { ...overviewState });
  // The oldest projects fall out when many are open one after another.
  while (overviewCache.size > OVERVIEW_CACHE_MAX) overviewCache.delete(overviewCache.keys().next().value);
}

// Forget what was cached for one project (the page that is open keeps showing it until the new read arrives).
function forgetProject(name) {
  overviewCache.delete(name);
}

// The project changed (a service was added, settings saved, something started or stopped):
// drop the old copy, wait a moment for Docker to settle, read everything again and set the cache from that.
// The open project is read by the page itself. A project that is not open is read in the background,
// so its details are ready (and right) the next time it is opened.
const cacheTimers = new Map();

function refreshProjectCache(name, delay = 800) {
  forgetProject(name);
  clearTimeout(cacheTimers.get(name));
  cacheTimers.set(name, setTimeout(async () => {
    cacheTimers.delete(name);
    if (!projectsView.list.some((p) => p.name === name)) return;
    if (detailState.name === name && document.body.dataset.view === 'detail') {
      loadOverviewData(name);
      return;
    }
    try {
      const snapshot = await readOverview(name, overviewCache.get(name));
      // A newer change came in while this was reading: that one sets the cache.
      if (!cacheTimers.has(name)) overviewCache.set(name, snapshot);
    } catch (err) {
      // Docker is off or the project is gone. It is read when the page is opened.
    }
  }, delay));
}

const OVERVIEW_REFRESH_MS = 5000;
const DISK_REFRESH_MS = 60000;
let overviewTimer = null;

function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '0 MB';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function stopOverviewRefresh() {
  clearTimeout(overviewTimer);
  overviewTimer = null;
}

// Reads what the overview shows. Each call may fail on its own (for example, Docker is off),
// so every value falls back to nothing instead of stopping the page.
// `before` is what was known about the project (the disk size is read only once a minute).
async function readOverview(name, before) {
  const known = before && before.name === name ? before : null;
  const diskDue = !known || Date.now() - known.diskAt > DISK_REFRESH_MS;
  const results = await Promise.allSettled([
    window.envhub.projectLinks(name),
    window.envhub.listContainers(name),
    window.envhub.projectLogs(name),
    window.envhub.projectDetails(name),
    window.envhub.projectStats(name),
    diskDue ? window.envhub.projectDisk(name) : Promise.resolve(known.disk),
    diskDue || !known.volumes ? window.envhub.projectVolumes(name) : Promise.resolve(known.volumes),
  ]);
  const value = (r) => (r.status === 'fulfilled' ? r.value : null);
  return {
    name,
    links: value(results[0]),
    containers: value(results[1]) || [],
    logs: value(results[2]) || '',
    details: value(results[3]),
    stats: value(results[4]),
    disk: diskDue ? value(results[5]) : known.disk,
    diskAt: diskDue ? Date.now() : known.diskAt,
    volumes: value(results[6]),
  };
}

// CPU and memory of the last 15 minutes, per project, for the sparklines. Sampled while the page is open.
const statsHistory = new Map();
const HISTORY_MS = 15 * 60 * 1000;

function recordStats(name, stats) {
  if (!name || !stats) return;
  const list = statsHistory.get(name) || [];
  const now = Date.now();
  list.push({ at: now, cpu: Number(stats.cpuPercent) || 0, mem: Number(stats.memBytes) || 0 });
  while (list.length && now - list[0].at > HISTORY_MS) list.shift();
  statsHistory.set(name, list);
}

async function loadOverviewData(name) {
  if (!name) return;
  stopOverviewRefresh();
  const snapshot = await readOverview(name, overviewState);
  if (detailState.name !== name || document.body.dataset.view !== 'detail') return;
  Object.assign(overviewState, snapshot);
  recordStats(name, snapshot.stats);
  rememberOverview();
  const project = projectsView.list.find((p) => p.name === name);
  if (project) renderOverview(project);
  // Keep the CPU and memory numbers moving while the page is open.
  overviewTimer = setTimeout(() => loadOverviewData(name), OVERVIEW_REFRESH_MS);
}

// Opens a terminal window with a shell in one service of the open project.
async function openTerminal(service) {
  try {
    await window.envhub.projectShell(detailState.name, service);
    const hint = service === 'php' ? ' Composer gives an error? Open the Settings tab and click "Composer problems? Click here for help".' : '';
    setActionStatus(`Opened a terminal for ${service}.${hint}`, detailState.name);
  } catch (err) {
    setActionStatus(`Could not open a terminal: ${ipcMessage(err)}`, detailState.name, 'error');
  }
}

// The service a Terminal button should open: the main web service, else the first running one.
function defaultShellService() {
  const project = projectsView.list.find((p) => p.name === detailState.name);
  const links = overviewState.name === detailState.name ? overviewState.links : null;
  const services = links ? links.services : [];
  const byContainer = new Map(overviewState.containers.map((c) => [c.name, c]));
  const up = (svc) => (byContainer.get(svc.container) || {}).state === 'running';
  // The app code lives in php / app; nginx only serves it.
  const preferred = project ? shellService(project) : null;
  const pick = services.find((svc) => svc.name === preferred && up(svc));
  if (pick) return pick.name;
  const main = project && project.ports[0] ? project.ports[0].service : null;
  const mainService = services.find((svc) => svc.name === main && up(svc));
  return mainService ? mainService.name : (services.find(up) || {}).name || null;
}

// ---------- Details: drawing ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

// A small line chart of the last 15 minutes. Flat when there is only one sample yet.
function sparkline(values, color) {
  const width = 240;
  const height = 46;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');
  const list = values.length ? values : [0];
  const series = list.length === 1 ? [list[0], list[0]] : list;
  const max = Math.max(...series) || 1;
  const min = Math.min(...series);
  const span = max - min || max || 1;
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * width;
    const y = height - 4 - ((v - min) / span) * (height - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = document.createElementNS(SVG_NS, 'polygon');
  area.setAttribute('points', `0,${height} ${points.join(' ')} ${width},${height}`);
  area.setAttribute('fill', color);
  area.setAttribute('fill-opacity', '0.12');
  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', color);
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(area, line);
  return svg;
}

function usageCard(label, value) {
  const card = makeElement('div', 'uc');
  const head = makeElement('div', 'uc-head');
  const name = makeElement('span', 'uc-label');
  name.textContent = label;
  const number = makeElement('span', 'uc-value');
  if (value instanceof Node) number.appendChild(value);
  else number.textContent = value;
  head.append(name, number);
  card.appendChild(head);
  return card;
}

function shortService(name) {
  if (name === 'phpmyadmin') return 'pma';
  return name.length > 8 ? name.slice(0, 7) : name;
}

const DISK_COLORS = ['#6EA8FF', '#E3B341', '#A78BFA', '#22D3EE', '#56D364'];

function volumeLabel(volume) {
  if (volume.label) return volume.label;
  const name = volume.name || '';
  if (/-data$/.test(name)) return 'Database data';
  if (/vendor/.test(name)) return 'Installed packages';
  if (/node_modules|-node$/.test(name)) return 'Node packages';
  return 'Docker volume';
}

function renderUsage(project, services, runningOf) {
  const fresh = overviewState.name === project.name;
  const liveStats = fresh && overviewState.stats ? overviewState.stats : null;
  const disk = fresh && overviewState.disk ? overviewState.disk : null;
  const history = statsHistory.get(project.name) || [];
  const box = byId('detail-stats');
  box.textContent = '';

  const cpu = usageCard('CPU', liveStats ? `${liveStats.cpuPercent.toFixed(1)}%` : '–');
  cpu.appendChild(sparkline(history.map((h) => h.cpu), '#22D3EE'));
  const cpuFoot = makeElement('span', 'uc-foot');
  cpuFoot.textContent = 'last 15 min';
  cpu.appendChild(cpuFoot);

  const mem = usageCard('Memory', liveStats ? formatBytes(liveStats.memBytes) : '–');
  mem.appendChild(sparkline(history.map((h) => h.mem), '#A78BFA'));
  const memFoot = makeElement('span', 'uc-foot');
  memFoot.textContent = 'last 15 min';
  mem.appendChild(memFoot);

  const diskCard = usageCard('Disk', disk ? formatBytes(disk.bytes) : '–');
  const bar = makeElement('div', 'uc-split');
  const legend = makeElement('div', 'uc-legend');
  const vols = disk ? disk.volumes.filter((v) => v.bytes > 0) : [];
  vols.forEach((v, i) => {
    const color = DISK_COLORS[i % DISK_COLORS.length];
    const part = makeElement('span', '');
    part.style.setProperty('--w', String(v.bytes));
    part.style.setProperty('--c', color);
    bar.appendChild(part);
    const item = makeElement('span', '');
    const swatch = makeElement('span', 'sw');
    swatch.style.setProperty('--c', color);
    swatch.textContent = '■';
    item.append(swatch, ` ${v.name.replace(`${dockerName(project.name)}-`, '')} ${formatBytes(v.bytes)}`);
    legend.appendChild(item);
  });
  if (!vols.length) {
    const none = makeElement('span', '');
    none.textContent = disk ? 'No volume data yet' : 'Reading sizes...';
    legend.appendChild(none);
  }
  diskCard.append(bar, legend);

  const up = services.filter(runningOf).length;
  const value = makeElement('span', '');
  value.textContent = services.length ? String(up) : '–';
  if (services.length) {
    const of = makeElement('span', 'of');
    of.textContent = `/${services.length}`;
    value.appendChild(of);
  }
  const boxes = usageCard('Containers', value);
  const grid = makeElement('div', 'uc-boxes');
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${up} of ${services.length} running`);
  for (const svc of services) {
    const cell = makeElement('div', '');
    const block = makeElement('span', runningOf(svc) ? 'on' : 'off');
    block.title = `${svc.name}: ${runningOf(svc) ? 'running' : 'stopped'}`;
    const label = makeElement('span', 'mono');
    label.textContent = shortService(svc.name);
    cell.append(block, label);
    grid.appendChild(cell);
  }
  boxes.appendChild(grid);

  box.append(cpu, mem, diskCard, boxes);
}

function renderOverviewLoading() {
  const stats = byId('detail-stats');
  stats.textContent = '';
  for (const label of ['CPU', 'Memory', 'Disk', 'Containers']) {
    const card = usageCard(label, '–');
    card.appendChild(makeElement('div', 'skeleton skel-line'));
    stats.appendChild(card);
  }
  const box = byId('detail-overview');
  box.textContent = '';
  const note = makeElement('div', 'loading-note');
  note.setAttribute('role', 'status');
  const spinner = makeElement('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const text = makeElement('span', '');
  text.textContent = 'Loading project details...';
  note.append(spinner, text);
  box.appendChild(note);
}

function panel(title, extra) {
  const section = makeElement('section', 'panel');
  const head = makeElement('div', 'panel-head');
  const heading = makeElement('h2', 'panel-title');
  heading.textContent = title;
  if (extra) {
    const more = makeElement('span', 'panel-title-extra');
    more.textContent = ` · ${extra}`;
    heading.appendChild(more);
  }
  head.appendChild(heading);
  section.appendChild(head);
  return { section, head, heading };
}

function kvList(rows) {
  const list = makeElement('dl', 'kv');
  for (const [label, value, mono = true] of rows) {
    const dt = makeElement('dt', '');
    dt.textContent = label;
    const dd = makeElement('dd', mono ? 'mono' : '');
    if (value instanceof Node) dd.appendChild(value);
    else dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

// ---------- Logs: split by container, coloured by service, in time order ----------

// The same colour for a service everywhere (overview, Logs tab, chips).
const SERVICE_COLORS = {
  nginx: '#8FD18C', php: '#D7A8FF', app: '#8FD18C', node: '#8FD18C', web: '#8FD18C',
  mysql: '#7FB4FF', mariadb: '#7FB4FF', postgres: '#7FB4FF', mongodb: '#7DD3C0',
  phpmyadmin: '#F5C46B', adminer: '#F5C46B', redis: '#F0A6CA', mailpit: '#7DD3C0',
};
const LOG_COLORS = ['#7FB4FF', '#8FD18C', '#D7A8FF', '#F0A6CA', '#7DD3C0', '#F5C46B'];

function serviceColor(name, names = []) {
  if (SERVICE_COLORS[name]) return SERVICE_COLORS[name];
  const at = Math.max(0, names.indexOf(name));
  return LOG_COLORS[at % LOG_COLORS.length];
}

let overviewLogFilter = 'all';

// projectLogs returns "== <id> ==" and then the lines of that container, each starting with Docker's timestamp.
// The result is one list for all containers, oldest first.
function parseLogs(text, containers) {
  const byShortId = new Map(containers.map((c) => [String(c.id || '').slice(0, 12), c]));
  const lines = [];
  let service = '';
  let order = 0;
  for (const raw of String(text || '').split('\n')) {
    const head = /^== ([0-9a-f]{12}) ==$/.exec(raw.trim());
    if (head) {
      const c = byShortId.get(head[1]);
      service = c ? c.service || c.name : head[1];
      continue;
    }
    if (!raw.trim()) continue;
    const stamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/.exec(raw);
    const at = stamp ? Date.parse(stamp[1]) : NaN;
    lines.push({ service, text: stamp ? stamp[2] : raw, at: Number.isNaN(at) ? null : at, order: order++ });
  }
  // Lines without a time keep their place after the timed ones of their container.
  return lines.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at - b.at;
    return a.order - b.order;
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function clockText(at) {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function dateTimeText(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockText(at)}`;
}

// The time some images print again inside the line (mysql) is left out, the Docker time is shown instead.
function logMessage(text) {
  return text.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(\d+\s+)?/, '');
}

function logLevel(text) {
  if (/\b(error|fatal|crit(ical)?|emerg)\b/i.test(text)) return 'err';
  if (/\b(warn(ing)?)\b/i.test(text)) return 'warn';
  return '';
}

function logLine(entry, names) {
  const row = makeElement('div', `log-line ${logLevel(entry.text)}`.trim());
  const svc = makeElement('span', 'log-svc');
  svc.textContent = entry.service.padEnd(7, ' ');
  svc.style.setProperty('--c', serviceColor(entry.service, names));
  row.appendChild(svc);
  if (entry.at !== null) {
    const t = makeElement('span', 'log-time');
    t.textContent = clockText(entry.at);
    row.appendChild(t);
  }
  const msg = makeElement('span', 'log-msg');
  msg.textContent = logMessage(entry.text);
  row.appendChild(msg);
  return row;
}

function logsPanel(project, services, live, lastLines = 40) {
  const fresh = overviewState.name === project.name;
  const entries = fresh ? parseLogs(overviewState.logs, overviewState.containers) : [];
  const names = services.map((svc) => svc.name);
  const p = panel('Logs');
  p.section.classList.add('logs-panel');
  const badge = makeElement('span', `live${live ? '' : ' off'}`);
  const dot = makeElement('span', 'dot');
  badge.append(dot, live ? 'Live' : 'Stopped');
  const filterLabel = makeElement('label', 'mini-field push-right');
  filterLabel.append('Service');
  const select = document.createElement('select');
  for (const value of ['all', ...names]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'all' ? 'All services' : value;
    select.appendChild(option);
  }
  select.value = names.includes(overviewLogFilter) ? overviewLogFilter : 'all';
  filterLabel.appendChild(select);
  const term = makeElement('div', 'log-term');
  const draw = () => {
    term.textContent = '';
    const shown = entries.filter((e) => select.value === 'all' || e.service === select.value).slice(-lastLines);
    for (const entry of shown) term.appendChild(logLine(entry, names));
    if (!shown.length) term.textContent = fresh ? 'No logs yet.' : 'Loading...';
    term.scrollTop = term.scrollHeight;
  };
  select.addEventListener('change', () => {
    overviewLogFilter = select.value;
    draw();
  });
  const copy = addButton(p.head, 'Copy', (event) => copyWithFeedback(term.innerText, event.currentTarget));
  copy.classList.add('btn-xs');
  p.head.insertBefore(badge, copy);
  p.head.insertBefore(filterLabel, copy);
  p.head.classList.add('wrap');
  p.section.appendChild(term);
  draw();
  return p.section;
}

// ---------- Logs tab: every line (last 500 per container), filters, follow ----------

const logView = { name: '', entries: [], services: [], service: 'all', query: '', follow: true, timestamps: true, warnOnly: false, clearedAt: null, timer: null };
const LOG_VIEW_REFRESH_MS = 4000;

function stopLogView() {
  clearTimeout(logView.timer);
  logView.timer = null;
}

async function readLogView(name) {
  const [text, containers] = await Promise.all([
    window.envhub.projectLogs(name),
    window.envhub.listContainers(name).catch(() => []),
  ]);
  if (logView.name !== name) return;
  logView.entries = parseLogs(text, containers);
  const project = projectsView.list.find((p) => p.name === name);
  const order = project ? project.services : [];
  const seen = new Set([...order.filter((s) => containers.some((c) => c.service === s)), ...containers.map((c) => c.service || c.name)]);
  logView.services = [...seen];
}

function paintLogChips() {
  const box = byId('lv-chips');
  box.textContent = '';
  for (const value of ['all', ...logView.services]) {
    const chip = makeElement('button', 'chip-btn');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', logView.service === value ? 'true' : 'false');
    if (value !== 'all') {
      const dot = makeElement('span', 'dot');
      dot.style.setProperty('background', serviceColor(value, logView.services));
      chip.appendChild(dot);
    }
    chip.append(value === 'all' ? 'All services' : value);
    chip.addEventListener('click', () => {
      logView.service = value;
      paintLogChips();
      paintLogView();
    });
    box.appendChild(chip);
  }
}

function paintLogView() {
  const body = byId('lv-body');
  const needle = logView.query.trim().toLowerCase();
  const shown = logView.entries.filter((e) => {
    if (logView.clearedAt !== null && (e.at === null || e.at <= logView.clearedAt)) return false;
    if (logView.service !== 'all' && e.service !== logView.service) return false;
    if (logView.warnOnly && !logLevel(e.text)) return false;
    if (needle && !`${e.service} ${e.text}`.toLowerCase().includes(needle)) return false;
    return true;
  });
  const keepScroll = !logView.follow ? body.scrollTop : null;
  body.textContent = '';
  shown.forEach((entry, i) => {
    const row = makeElement('div', `lv-line ${logLevel(entry.text)}`.trim());
    const num = makeElement('span', 'lv-num');
    num.textContent = String(i + 1);
    row.appendChild(num);
    if (logView.timestamps) {
      const time = makeElement('span', 'lv-time');
      time.textContent = entry.at !== null ? dateTimeText(entry.at) : '';
      row.appendChild(time);
    }
    const svc = makeElement('span', 'lv-svc');
    svc.textContent = entry.service;
    svc.style.setProperty('--c', serviceColor(entry.service, logView.services));
    const msg = makeElement('span', 'lv-msg');
    msg.textContent = logMessage(entry.text);
    row.append(svc, msg);
    body.appendChild(row);
  });
  const cursor = makeElement('div', 'lv-line lv-cursor');
  const num = makeElement('span', 'lv-num');
  num.textContent = String(shown.length + 1);
  const caret = makeElement('span', 'lv-caret');
  caret.textContent = '▍';
  cursor.append(num, caret);
  body.appendChild(cursor);
  if (!logView.entries.length) {
    const empty = makeElement('div', 'lv-empty');
    empty.textContent = 'No logs yet. Start the project to see its output.';
    body.prepend(empty);
  }
  if (logView.follow) body.scrollTop = body.scrollHeight;
  else if (keepScroll !== null) body.scrollTop = keepScroll;
  const count = logView.services.length;
  setText('lv-foot-left', `showing last 500 lines · ${count} service${count === 1 ? '' : 's'}${shown.length !== logView.entries.length ? ` · ${shown.length} match` : ''}`);
  setText('lv-foot-right', logView.follow ? 'following · auto-scroll on' : 'paused · auto-scroll off');
}

async function refreshLogView() {
  const name = logView.name;
  if (!name) return;
  stopLogView();
  try {
    await readLogView(name);
    setText('lv-error', '');
  } catch (err) {
    setText('lv-error', `Could not load logs: ${ipcMessage(err)}`);
  }
  if (logView.name !== name) return;
  paintLogChips();
  paintLogView();
  const project = projectsView.list.find((p) => p.name === name);
  const live = Boolean(project && isRunningProject(project));
  const badge = byId('lv-live');
  badge.classList.toggle('off', !live);
  byId('lv-live-text').textContent = live ? 'Live' : 'Stopped';
  // Keep reading while the tab is open and the project runs.
  if (live && document.body.dataset.view === 'detail' && detailState.tab === 'logs' && detailState.name === name) {
    logView.timer = setTimeout(refreshLogView, LOG_VIEW_REFRESH_MS);
  }
}

async function showLogs(name) {
  if (logView.name !== name) {
    Object.assign(logView, { name, entries: [], services: [], service: 'all', clearedAt: null });
    byId('lv-filter').value = logView.query;
  }
  logsName = name;
  ensureProjectsView();
  mountPanel(el.logViewCard);
  el.logViewCard.hidden = false;
  byId('lv-body').textContent = 'Loading...';
  await refreshLogView();
}

function bindLogView() {
  byId('lv-filter').addEventListener('input', (event) => {
    logView.query = event.target.value;
    paintLogView();
  });
  byId('lv-follow').addEventListener('change', (event) => {
    logView.follow = event.target.checked;
    paintLogView();
  });
  byId('lv-ts').addEventListener('change', (event) => {
    logView.timestamps = event.target.checked;
    paintLogView();
  });
  byId('lv-warn').addEventListener('change', (event) => {
    logView.warnOnly = event.target.checked;
    paintLogView();
  });
  byId('lv-refresh').addEventListener('click', refreshLogView);
  byId('lv-copy').addEventListener('click', (event) => {
    const text = [...byId('lv-body').querySelectorAll('.lv-line:not(.lv-cursor)')].map((row) => [...row.children].slice(1).map((c) => c.textContent).join('  ')).join('\n');
    copyWithFeedback(text, event.currentTarget);
  });
  byId('lv-clear').addEventListener('click', () => {
    const last = logView.entries.filter((e) => e.at !== null).pop();
    logView.clearedAt = last ? last.at : Date.now();
    paintLogView();
  });
  // Scrolling up pauses following; scrolling back to the end turns it on again.
  byId('lv-body').addEventListener('scroll', (event) => {
    const body = event.currentTarget;
    const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    if (atEnd !== logView.follow) {
      logView.follow = atEnd;
      byId('lv-follow').checked = atEnd;
      setText('lv-foot-right', atEnd ? 'following · auto-scroll on' : 'paused · auto-scroll off');
    }
  });
}

function ovCard(title) {
  const card = makeElement('section', 'panel padded');
  const head = makeElement('div', 'panel-head');
  const heading = makeElement('h2', 'panel-title');
  heading.textContent = title;
  head.appendChild(heading);
  card.appendChild(head);
  return { card, head, heading };
}

function kvRow(label, value) {
  const row = makeElement('div', 'kv-row');
  const key = makeElement('span', 'kv-key');
  key.textContent = label;
  const val = makeElement('span', 'kv-val');
  val.textContent = value;
  row.append(key, val);
  return row;
}

// The address other computers can use, when sharing on the network is on and the project is running.
function lanAddressOf(project, links) {
  if (!links || !project.ports[0]) return '';
  const main = links.services.find((svc) => svc.name === project.ports[0].service);
  const urls = main && main.ports[0] ? main.ports[0].lanUrls || [] : [];
  return urls[0] || '';
}

function showLanAddress(address) {
  const button = byId('detail-lan-url');
  byId('detail-lan').hidden = !address;
  button.textContent = address.replace(/^https?:\/\//, '');
  button.dataset.url = address;
}

// Who can open the project, in three levels, plus a button that finds out why another computer cannot.
function networkCard(project, links) {
  const card = ovCard('Who can open this?');
  const main = project.ports[0];
  const local = main ? `http://localhost:${main.host}` : '';
  const shared = Boolean(links && links.lanShare);
  const lan = lanAddressOf(project, links);

  card.card.appendChild(kvRow('This computer only', local || '-'));
  card.card.appendChild(kvRow('Same Wi-Fi / router', shared ? lan || 'No network address found' : 'Off (turn on in Settings)'));
  card.card.appendChild(kvRow('Whole internet', 'Not available'));
  const note = makeElement('p', 'pcard-note');
  note.textContent = '192.168.x.x addresses only work for devices on the same Wi-Fi or router. They cannot be opened from the internet or on mobile data.';
  card.card.appendChild(note);

  const result = makeElement('div', 'diag-result');
  const run = async () => {
    result.textContent = 'Checking...';
    try {
      renderDiagnosis(result, project, await window.envhub.testAccess(project.name), run);
    } catch (err) {
      result.textContent = `Could not check: ${ipcMessage(err)}`;
    }
  };
  const actions = makeElement('div', 'row-actions');
  addButton(actions, 'Test access', run);
  card.card.append(actions, result);
  return card.card;
}

function renderDiagnosis(box, project, diagnosis, recheck) {
  box.textContent = '';
  const summary = makeElement('p', diagnosis.ok ? 'diag-summary diag-ok' : 'diag-summary diag-bad');
  summary.textContent = diagnosis.summary;
  box.appendChild(summary);
  const fixes = {
    start: ['Start project', () => runProjectAction('Start', 'startProject', project.name)],
    restart: ['Restart project', () => runProjectAction('Restart', 'restartProject', project.name)],
    settings: ['Open Settings', () => setDetailTab('settings')],
    firewall: ['Allow in Firewall', async () => {
      const res = await window.envhub.allowFirewall(project.name);
      if (res && res.ok === false) setActionStatus(res.error || 'Could not add the firewall rule.', project.name, 'error');
      await recheck();
    }],
  };
  for (const step of diagnosis.steps) {
    const row = makeElement('div', step.ok ? 'diag-step diag-ok' : 'diag-step diag-bad');
    const title = makeElement('strong', '');
    title.textContent = `${step.ok ? '✓' : '✗'} ${step.title}`;
    row.appendChild(title);
    if (step.detail) {
      const detail = makeElement('p', 'muted small');
      detail.textContent = step.detail;
      row.appendChild(detail);
    }
    if (step.fix && fixes[step.fix]) addButton(row, fixes[step.fix][0], fixes[step.fix][1]);
    box.appendChild(row);
  }
}

function renderOverview(project) {
  const box = byId('detail-overview');
  const fresh = overviewState.name === project.name;
  const links = fresh ? overviewState.links : null;
  const services = links ? links.services : [];
  const byContainer = new Map(fresh ? overviewState.containers.map((c) => [c.name, c]) : []);
  const serviceRunning = (svc) => {
    const c = byContainer.get(svc.container);
    return Boolean(c && c.state === 'running');
  };
  const runningNow = services.filter(serviceRunning).length;
  const firstUp = fresh ? overviewState.containers.find((c) => c.state === 'running') : null;
  setText('detail-uptime', firstUp ? firstUp.status : '');
  showLanAddress(fresh ? lanAddressOf(project, links) : '');
  renderUsage(project, services, serviceRunning);

  box.textContent = '';
  const main = makeElement('div', 'ov-main');
  const side = makeElement('aside', 'ov-side');

  // Services
  const svc = panel('Services', links ? `${runningNow} of ${services.length} running` : '');
  const refresh = addButton(svc.head, 'Refresh', () => loadOverviewData(project.name));
  refresh.classList.add('btn-xs');
  if (!links || services.length === 0) {
    const note = makeElement('p', 'panel-note');
    note.textContent = !links ? (fresh ? 'Could not read the services. Check that Docker is running.' : 'Loading...') : 'This project has no containers yet.';
    svc.section.appendChild(note);
  } else {
    const scroll = makeElement('div', 'table-scroll');
    const table = makeElement('table', 'dtable mini');
    const head = makeElement('thead', '');
    const headRow = makeElement('tr', '');
    for (const label of ['Service', 'Image', 'Status', 'Port', 'Actions']) {
      const th = makeElement('th', label === 'Actions' ? 'col-actions' : '');
      th.textContent = label;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    const body = makeElement('tbody', '');
    for (const item of services) {
      const up = serviceRunning(item);
      const row = makeElement('tr', 'trow');
      const name = td('strong');
      name.textContent = item.name;
      const image = td('mono c-image');
      image.textContent = item.image;
      const status = td();
      status.appendChild(statusCell(up ? 'running' : 'stopped', up ? 'Running' : 'Stopped'));
      const portCell = td('c-ports');
      if (item.ports.length) {
        for (const port of item.ports) {
          const link = makeElement('button', 'port-link');
          link.type = 'button';
          link.textContent = `${port.host}:${port.container}`;
          link.title = `Open ${port.url}`;
          link.disabled = !up;
          link.addEventListener('click', () => openDetailPort(project.name, item.name, port.container));
          portCell.appendChild(link);
        }
      } else {
        portCell.textContent = 'internal';
        portCell.classList.add('muted');
      }
      const actionsCell = td('col-actions');
      const actions = makeElement('div', 'row-icons');
      const shell = rowIconButton(ROW_ICONS.terminal, `Open shell in ${item.name}`, () => openTerminal(item.name), 'sm');
      shell.disabled = !up;
      const copy = rowIconButton(ROW_ICONS.copy, `Copy shell command for ${item.name}`, (event) => copyWithFeedback(item.shell, event.currentTarget), 'sm');
      const power = rowIconButton(up ? ROW_ICONS.stop : ROW_ICONS.play, `${up ? 'Stop' : 'Start'} ${item.name}`, () => toggleService(project.name, item.name, up, power), 'sm');
      actions.append(shell, copy, power);
      actionsCell.appendChild(actions);
      row.append(name, image, status, portCell, actionsCell);
      body.appendChild(row);
    }
    table.append(head, body);
    scroll.appendChild(table);
    svc.section.appendChild(scroll);
  }
  main.appendChild(svc.section);

  // Logs
  main.appendChild(logsPanel(project, services, isRunningProject(project)));

  // Database
  const db = services.find((item) => ['mysql', 'postgres', 'mongodb', 'mariadb'].includes(item.name));
  if (db) {
    const dbPanel = panel('Database');
    const image = makeElement('span', 'panel-meta mono');
    image.textContent = db.image;
    dbPanel.head.appendChild(image);
    const details = fresh && overviewState.details ? overviewState.details : null;
    const dbPort = db.ports[0];
    const rows = [['Host', '127.0.0.1'], ['Port', dbPort ? String(dbPort.host) : 'not published']];
    if (db.name !== 'mongodb') {
      rows.push(['Database', details && details.dbName ? details.dbName : '–']);
      rows.push(['User', details && details.dbUser ? details.dbUser : '–']);
    }
    rows.push(['Password', '••••••••••••']);
    dbPanel.section.appendChild(kvList(rows));
    const foot = makeElement('div', 'panel-actions');
    const show = addButton(foot, 'Show credentials', () => setDetailTab('credentials'));
    show.classList.add('grow');
    if (project.services.includes('phpmyadmin')) {
      const pma = addButton(foot, 'Open phpMyAdmin', () => openService(project.name, 'phpmyadmin', 'phpMyAdmin'));
      pma.classList.add('grow', 'soft');
    } else if (project.services.includes('adminer')) {
      const adminer = addButton(foot, 'Open Adminer', () => openService(project.name, 'adminer', 'Adminer'));
      adminer.classList.add('grow', 'soft');
    }
    dbPanel.section.appendChild(foot);
    side.appendChild(dbPanel.section);
  }

  // Volumes
  const volumeData = fresh ? overviewState.volumes : null;
  const disk = fresh && overviewState.disk ? overviewState.disk : null;
  const sizeOf = new Map(disk ? disk.volumes.map((v) => [v.name, v.bytes]) : []);
  const volPanel = panel('Volumes');
  const volList = makeElement('div', 'vol-list');
  const vols = volumeData && volumeData.volumes ? volumeData.volumes : (disk ? disk.volumes : []);
  for (const v of vols) {
    const row = makeElement('div', 'vol-row');
    const mark = makeElement('span', 'vol-ico');
    mark.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path></svg>';
    const text = makeElement('div', 'vol-text');
    const name = makeElement('span', 'mono');
    name.textContent = v.name;
    const label = makeElement('span', 'muted small');
    label.textContent = volumeLabel(v);
    text.append(name, label);
    const size = makeElement('span', 'vol-size');
    const bytes = sizeOf.has(v.name) ? sizeOf.get(v.name) : v.bytes;
    size.textContent = bytes ? formatBytes(bytes) : '–';
    row.append(mark, text, size);
    volList.appendChild(row);
  }
  if (!vols.length) {
    const note = makeElement('p', 'muted small');
    note.textContent = fresh ? 'This project keeps no data in Docker volumes.' : 'Loading...';
    volList.appendChild(note);
  }
  volPanel.section.appendChild(volList);
  side.appendChild(volPanel.section);

  // Details
  const info = panel('Details');
  const shared = Boolean(links && links.lanShare);
  const folders = volumeData && volumeData.folders ? String(volumeData.folders.length) : '–';
  info.section.appendChild(kvList([['Runtime', project.label, false], ['Network share', shared ? 'On' : 'Off', false], ['Shared folders', folders, false]]));
  const infoActions = makeElement('div', 'panel-actions');
  addButton(infoActions, 'Open folder', () => runProjectAction('Folder', 'openFolder', project.name)).classList.add('grow');
  if (['nestjs', 'nextjs', 'vue', 'nuxt'].includes(project.stack)) {
    const editorButton = addButton(infoActions, 'Packages for editor', () => runProjectAction('Install packages', 'installPackages', project.name, EDITOR_PACKAGES_TEXT));
    editorButton.title = 'Installs node_modules into the project folder so VS Code can find the types. The app itself keeps its own fast copy in Docker.';
    editorButton.classList.add('grow');
  }
  info.section.appendChild(infoActions);
  side.appendChild(info.section);

  side.appendChild(networkCard(project, links));

  box.append(main, side);
}

async function openDetailPort(name, service, container) {
  try {
    await window.envhub.openPort(name, service, container);
  } catch (err) {
    setActionStatus(`Could not open ${service}: ${ipcMessage(err)}`, name, 'error');
  }
}

// Opens one tab. Overview is the only tab built here; the others reuse the existing cards.
function setDetailTab(tab) {
  detailState.tab = tab;
  for (const button of document.querySelectorAll('.tab[data-tab]')) {
    const on = button.dataset.tab === tab;
    button.setAttribute('aria-selected', on ? 'true' : 'false');
    button.classList.toggle('on', on);
  }
  byId('detail-overview').hidden = tab !== 'overview';
  el.linksCard.hidden = true;
  el.logsCard.hidden = true;
  el.editCard.hidden = true;
  el.credCard.hidden = true;
  el.volumesCard.hidden = true;
  el.logViewCard.hidden = true;
  el.mailViewCard.hidden = true;
  el.redisViewCard.hidden = true;
  if (tab !== 'logs') stopLogView();
  el.dataViewCard.hidden = true;
  if (tab !== 'data') {
    stopMailView();
    stopRequestsView();
  }

  const name = detailState.name;
  if (tab === 'services') openLinks(name);
  else if (tab === 'volumes') showVolumes(name);
  else if (tab === 'logs') showLogs(name);
  else if (tab === 'data') showData(name);
  else if (tab === 'credentials') showConnection(name);
  else if (tab === 'settings') openEdit(name);

  // The Save footer is on every tab. Off the Settings tab the form is loaded hidden, so Save works from there too.
  const project = projectsView.list.find((p) => p.name === name);
  byId('detail-footer').hidden = !(project && project.editable);
  if (project && project.editable && tab !== 'settings') openEdit(name, false);
}

// ---------- Volumes tab ----------

let volumesName = '';

const VOLUME_ICONS = {
  data: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path></svg>',
  cache: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5z"></path><path d="M3 8v8l9 5 9-5V8"></path><path d="M12 13v8"></path></svg>',
  other: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M3 10h18"></path></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
};

// A label and a value in a box with a copy button, for the paths and names.
function volField(label, value) {
  const field = makeElement('div', 'vfield');
  const key = makeElement('span', 'vfield-key');
  key.textContent = label;
  const box = makeElement('div', 'vfield-val');
  const code = makeElement('span', 'mono');
  code.textContent = value;
  box.append(code, rowIconButton(ROW_ICONS.copy, `Copy ${label.toLowerCase()}`, (event) => copyWithFeedback(value, event.currentTarget), 'sm'));
  field.append(key, box);
  return field;
}

function volumeMark(kind) {
  const mark = makeElement('span', `vmark vmark-${kind}`);
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = VOLUME_ICONS[kind] || VOLUME_ICONS.other;
  return mark;
}

const VOLUME_COLORS = { data: '#6EA8FF', cache: '#E3B341', other: '#A78BFA' };

function volumeTile(label, value) {
  const tile = makeElement('div', 'vtile');
  const name = makeElement('span', 'uc-label');
  name.textContent = label;
  const strong = makeElement('span', 'vtile-value');
  strong.textContent = value;
  tile.append(name, strong);
  return { tile, strong };
}

function renderVolumes(name, data) {
  const body = el.volumesBody;
  body.textContent = '';
  const project = projectsView.list.find((p) => p.name === name);
  const running = Boolean(project && isRunningProject(project));

  // Totals
  const tiles = makeElement('div', 'vtiles');
  tiles.appendChild(volumeTile('Docker volumes', String(data.volumes.length)).tile);
  const size = volumeTile('Size on disk', '…');
  size.strong.dataset.total = 'true';
  const split = makeElement('div', 'ovc-bar vsplit');
  split.dataset.split = 'true';
  size.tile.appendChild(split);
  tiles.appendChild(size.tile);
  tiles.appendChild(volumeTile('Shared folders', String(data.folders.length)).tile);
  body.appendChild(tiles);

  // Docker volumes
  const head = makeElement('div', 'section-head');
  const text = makeElement('div', '');
  const title = makeElement('h2', 'panel-title');
  title.textContent = 'Docker volumes';
  const note = makeElement('p', '');
  note.textContent = 'Docker keeps these on its own disk. They stay when you stop or restart the project. Deleting the project asks if they should go too.';
  text.append(title, note);
  const refresh = addButton(head, 'Refresh', () => showVolumes(name));
  refresh.classList.add('btn-sm');
  head.prepend(text);
  body.appendChild(head);

  if (data.volumes.length === 0) {
    const empty = makeElement('div', 'panel panel-empty');
    const strong = makeElement('strong', '');
    strong.textContent = 'This project has no Docker volumes';
    const small = makeElement('p', 'muted small');
    small.textContent = 'Everything it needs is in the project folder. Add a database in the Settings tab and its data volume shows here.';
    empty.append(strong, small);
    body.appendChild(empty);
  } else {
    const grid = makeElement('div', 'vgrid');
    for (const v of data.volumes) {
      const card = makeElement('section', 'vcard');
      const top = makeElement('div', 'vcard-top');
      const info = makeElement('div', 'vcard-info');
      const h3 = makeElement('h3', '');
      h3.textContent = `${v.service} · ${v.label}`;
      const p = makeElement('p', '');
      p.textContent = v.note || (v.kind === 'data' ? 'Your data. It stays when the project is stopped or restarted.' : '');
      info.append(h3, p);
      const meta = makeElement('div', 'vcard-meta');
      const bytes = makeElement('span', 'vcard-size');
      bytes.textContent = v.exists ? '…' : '–';
      if (v.exists) bytes.dataset.volume = v.name;
      const state = makeElement('span', `pill-status`);
      state.dataset.state = v.exists ? 'running' : 'stopped';
      const dot = makeElement('span', 'dot');
      state.append(dot, v.exists ? 'Created' : 'Not created yet');
      meta.append(bytes, state);
      top.append(volumeMark(v.kind), info, meta);
      const bar = makeElement('div', 'vbar');
      const fill = makeElement('div', '');
      fill.style.setProperty('--c', VOLUME_COLORS[v.kind] || VOLUME_COLORS.other);
      fill.style.setProperty('--p', '0%');
      if (v.exists) fill.dataset.bar = v.name;
      bar.appendChild(fill);
      const foot = makeElement('div', 'vcard-foot');
      const hint = makeElement('span', '');
      if (v.kind === 'data') hint.textContent = 'Deleting the project asks before this volume goes.';
      else if (v.kind === 'cache') hint.textContent = v.service === 'php' ? 'Safe to rebuild with composer install.' : 'Safe to install again.';
      else hint.textContent = 'Kept by Docker for this project.';
      const shell = addButton(foot, 'Open shell here', async () => {
        try {
          await window.envhub.projectShell(name, v.service);
        } catch (err) {
          setActionStatus(`Could not open a terminal: ${ipcMessage(err)}`, name, 'error');
        }
      });
      shell.classList.add('btn-sm');
      shell.disabled = !running;
      if (!running) shell.title = 'Start the project to open a shell';
      foot.prepend(hint);
      card.append(top, bar, volField('Volume name', v.name), volField('Inside the container', v.target), foot);
      grid.appendChild(card);
    }
    body.appendChild(grid);
    const made = data.volumes.filter((v) => v.exists).length;
    if (made < data.volumes.length) {
      const hint = makeElement('p', 'muted small');
      hint.textContent = 'A volume is created the first time the project starts.';
      body.appendChild(hint);
    }
  }

  // Folders shared from this computer
  const shared = makeElement('section', 'panel');
  const sharedHead = makeElement('div', 'panel-head');
  const sharedText = makeElement('div', 'panel-head-text');
  const sharedTitle = makeElement('h2', 'panel-title');
  sharedTitle.textContent = 'Shared folders';
  const sharedNote = makeElement('p', '');
  sharedNote.textContent = 'Folders on this computer that containers read and write directly.';
  sharedText.append(sharedTitle, sharedNote);
  sharedHead.appendChild(sharedText);
  const openFolder = addButton(sharedHead, 'Open project folder', () => runProjectAction('Folder', 'openFolder', name));
  openFolder.classList.add('btn-xs');
  shared.appendChild(sharedHead);
  if (data.folders.length === 0) {
    const none = makeElement('p', 'panel-note');
    none.textContent = 'No folders from this computer are shared into the containers.';
    shared.appendChild(none);
  } else {
    const scroll = makeElement('div', 'table-scroll');
    const table = makeElement('table', 'dtable mini folders');
    const thead = makeElement('thead', '');
    const headRow = makeElement('tr', '');
    for (const label of ['Service', 'On this computer', '', 'Inside the container']) {
      const th = makeElement('th', '');
      if (label) th.textContent = label;
      else {
        const sr = makeElement('span', 'sr-only');
        sr.textContent = 'maps to';
        th.appendChild(sr);
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    const tbody = makeElement('tbody', '');
    for (const f of data.folders) {
      const row = makeElement('tr', 'trow');
      const svc = td('strong');
      svc.textContent = f.service;
      const source = td('mono c-image');
      source.textContent = f.source;
      const arrow = td('muted');
      arrow.textContent = '→';
      const target = td('mono c-image');
      target.textContent = f.target;
      row.append(svc, source, arrow, target);
      tbody.appendChild(row);
    }
    table.append(thead, tbody);
    scroll.appendChild(table);
    shared.appendChild(scroll);
  }
  body.appendChild(shared);
}

// The sizes come later (Docker is slow to count them): fill them into the cards when they arrive.
async function fillVolumeSizes(name) {
  let bytes = new Map();
  try {
    const cached = overviewState.name === name && overviewState.disk ? overviewState.disk : null;
    const disk = cached || (await window.envhub.projectDisk(name));
    bytes = new Map(disk.volumes.map((v) => [v.name, v.bytes]));
  } catch (err) {
    bytes = null;
  }
  if (volumesName !== name) return;
  let total = 0;
  for (const span of el.volumesBody.querySelectorAll('[data-volume]')) {
    const value = bytes ? bytes.get(span.dataset.volume) || 0 : null;
    span.textContent = value === null ? '–' : formatBytes(value);
    total += value || 0;
  }
  const split = el.volumesBody.querySelector('[data-split]');
  if (split) split.textContent = '';
  for (const fill of el.volumesBody.querySelectorAll('[data-bar]')) {
    const value = bytes ? bytes.get(fill.dataset.bar) || 0 : 0;
    const share = total ? Math.round((value / total) * 100) : 0;
    fill.style.setProperty('--p', `${share}%`);
    if (split && value) {
      const part = makeElement('span', '');
      part.style.setProperty('--w', String(value));
      part.style.setProperty('background', fill.style.getPropertyValue('--c'));
      split.appendChild(part);
    }
  }
  const totalBox = el.volumesBody.querySelector('[data-total]');
  if (totalBox) totalBox.textContent = bytes ? formatBytes(total) : '–';
}

async function showVolumes(name) {
  ensureProjectsView();
  mountPanel(el.volumesCard);
  volumesName = name;
  el.volumesCard.hidden = false;
  el.volumesTitle.textContent = `Volumes: ${name}`;
  el.volumesBody.textContent = '';
  const note = makeElement('div', 'loading-note');
  const spinner = makeElement('span', 'spinner');
  spinner.setAttribute('aria-hidden', 'true');
  const text = makeElement('span', '');
  text.textContent = 'Reading the volumes from Docker...';
  note.append(spinner, text);
  el.volumesBody.appendChild(note);
  el.volumesCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  try {
    const data = await window.envhub.projectVolumes(name);
    if (volumesName === name) {
      renderVolumes(name, data);
      fillVolumeSizes(name);
    }
  } catch (err) {
    el.volumesBody.textContent = '';
    const error = makeElement('p', 'error small');
    error.textContent = `Could not read the volumes: ${ipcMessage(err)}`;
    el.volumesBody.appendChild(error);
  }
}

// ---------- Settings page helpers ----------

function say(text) {
  setActionStatus(text);
  byId('settings-message').textContent = text;
}

async function openVersionsFile() {
  try {
    const res = await window.envhub.openVersionsFile();
    say(`Opened ${res.file}. Add versions, save it, then restart ProjectDockHub.`);
  } catch (err) {
    say(`Could not open the versions file: ${ipcMessage(err)}`);
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
// The stack choice as cards. The <select id="new-stack"> stays (hidden) and is still the value every other
// part of the form reads; a card only sets it and sends the same "change" event a select would.
const STACK_INFO = {
  laravel: 'PHP, nginx, Composer',
  nestjs: 'Node.js API framework',
  nextjs: 'React with server rendering',
  vue: 'Vite and Vue single page app',
  nuxt: 'Vue with server rendering',
  docker: 'Any image: Python, Go, Rust, Java...',
};

function renderStackCards() {
  const box = byId('stack-cards');
  box.textContent = '';
  for (const option of el.newStack.options) {
    if (option.hidden) continue;
    const value = option.value;
    const mark = STACK_MARKS[value] || { text: value.slice(0, 2), color: '#64748B' };
    const card = makeElement('button', 'stack-card');
    card.type = 'button';
    card.dataset.value = value;
    card.setAttribute('role', 'radio');
    card.style.setProperty('--brand', mark.color);
    const badge = makeElement('span', 'stack-mark');
    badge.textContent = mark.text;
    badge.setAttribute('aria-hidden', 'true');
    const text = makeElement('span', 'stack-text');
    const title = makeElement('strong', '');
    title.textContent = value === 'docker' ? 'Docker image' : option.textContent;
    const note = makeElement('span', '');
    note.textContent = STACK_INFO[value] || '';
    text.append(title, note);
    card.append(badge, text);
    card.addEventListener('click', () => {
      if (el.newStack.value === value) return;
      el.newStack.value = value;
      el.newStack.dispatchEvent(new Event('change'));
    });
    box.appendChild(card);
  }
  paintStackCards();
}

function paintStackCards() {
  for (const card of document.querySelectorAll('#stack-cards .stack-card')) {
    const on = card.dataset.value === el.newStack.value;
    card.classList.toggle('on', on);
    card.setAttribute('aria-checked', on ? 'true' : 'false');
  }
}

function syncStackForm() {
  paintStackCards();
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
  // The image only starts a shell. This lets other containers log in, then runs the queue and the server.
  hylafax: {
    label: 'HylaFAX (fax server)', image: 'neoseason/hylafax:nocfg', ports: '',
    command: 'sh -c "grep -q \'^\\.\\*\' /var/spool/hylafax/etc/hosts.hfaxd || echo \'.*:21::\' >> /var/spool/hylafax/etc/hosts.hfaxd; faxq; exec hfaxd -d -i 4559"',
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
  byId('settings-projects-dir').value = info.projectsDir;
  byId('settings-docker-dir').value = info.dockerFilesDir || '';
  byId('settings-reset-dir').hidden = info.isDefault;
  const wasDirty = settingsDirty();
  savedSettings.stopDockerOnExit = info.stopDockerOnExit !== false;
  savedSettings.askOnExit = info.askOnExit !== false;
  if (!wasDirty) {
    byId('settings-stop-docker').checked = savedSettings.stopDockerOnExit;
    byId('settings-ask-exit').checked = savedSettings.askOnExit;
  }
  paintStopOnExit(savedSettings.stopDockerOnExit);
  paintSettingsBar();
}

// ---------- Settings page: a list of sections, and Cancel / Apply for the theme and the exit choice ----------

const savedSettings = { stopDockerOnExit: true, askOnExit: true };

function pendingTheme() {
  const picked = document.querySelector('input[name="theme"]:checked');
  return picked ? picked.value : readTheme();
}

function settingsDirty() {
  return pendingTheme() !== readTheme()
    || byId('settings-stop-docker').checked !== savedSettings.stopDockerOnExit
    || byId('settings-ask-exit').checked !== savedSettings.askOnExit;
}

function paintSettingsBar() {
  const dirty = settingsDirty();
  byId('settings-apply').disabled = !dirty;
  byId('settings-cancel').disabled = !dirty;
  const pending = byId('settings-pending');
  if (dirty) {
    clearTimeout(settingsDoneTimer);
    pending.classList.remove('done');
    pending.textContent = 'Changes not applied yet';
  } else if (!pending.classList.contains('done')) {
    pending.textContent = '';
  }
}

let settingsDoneTimer = null;

async function applySettings() {
  const theme = pendingTheme();
  if (theme !== readTheme()) applyTheme(theme);
  const box = byId('settings-stop-docker');
  if (box.checked !== savedSettings.stopDockerOnExit) {
    try {
      await window.envhub.setStopDockerOnExit(box.checked);
      savedSettings.stopDockerOnExit = box.checked;
      paintStopOnExit(box.checked);
    } catch (err) {
      say(`Could not save the setting: ${ipcMessage(err)}`);
    }
  }
  const ask = byId('settings-ask-exit');
  if (ask.checked !== savedSettings.askOnExit) {
    try {
      await window.envhub.setAskOnExit(ask.checked);
      savedSettings.askOnExit = ask.checked;
    } catch (err) {
      say(`Could not save the setting: ${ipcMessage(err)}`);
    }
  }
  paintSettingsBar();
  // A short "Applied" so it is clear the choice was saved.
  const pending = byId('settings-pending');
  pending.textContent = 'Applied ✓';
  pending.classList.add('done');
  clearTimeout(settingsDoneTimer);
  settingsDoneTimer = setTimeout(() => {
    pending.classList.remove('done');
    if (!settingsDirty()) pending.textContent = '';
  }, 2500);
}

function cancelSettings() {
  applyTheme(readTheme());
  byId('settings-stop-docker').checked = savedSettings.stopDockerOnExit;
  byId('settings-ask-exit').checked = savedSettings.askOnExit;
  paintSettingsBar();
}

function paintSettingsDocker() {
  const status = lastDockerStatus;
  const pill = document.getElementById('settings-docker-pill');
  if (!pill) return;
  const running = Boolean(status && status.running);
  const { version, build } = dockerVersionParts(status);
  pill.dataset.state = running ? 'running' : status ? 'partly' : 'stopped';
  setText('settings-docker-text', !status ? 'Checking' : running ? `Running · ${[version, build && `build ${build}`].filter(Boolean).join(', ')}` : 'Not running');
}

function bindSettingsPage() {
  for (const radio of document.querySelectorAll('input[name="theme"]')) radio.addEventListener('change', paintSettingsBar);
  byId('settings-ask-exit').addEventListener('change', paintSettingsBar);
  byId('settings-apply').addEventListener('click', applySettings);
  byId('settings-cancel').addEventListener('click', cancelSettings);
  byId('settings-check-docker').addEventListener('click', () => checkDocker());
  byId('settings-open-docker-dir').addEventListener('click', async () => {
    try {
      const res = await window.envhub.openDockerFilesDir();
      if (res && res.ok === false) say(`Could not open the folder: ${res.error}`);
    } catch (err) {
      say(`Could not open the folder: ${ipcMessage(err)}`);
    }
  });
  const nav = [...document.querySelectorAll('.settings-nav button')];
  for (const button of nav) {
    button.addEventListener('click', () => {
      for (const other of nav) other.removeAttribute('aria-current');
      button.setAttribute('aria-current', 'true');
      byId(button.dataset.section).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}

function changeStopDockerOnExit() {
  paintSettingsBar();
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
    wizard.composeFile = found.composeFile || '';
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

  // The folder has its own docker-compose.yml: it can run as it is, with nothing set up again.
  if (existing && wizard.composeFile) {
    const file = wizard.composeFile;
    const useIt = await confirmDialog({
      title: `Run ${file} as it is?`,
      body: `This folder has its own ${file}. ProjectDockHub can run it unchanged: your services, ports, volumes and .env. The file is only read; ProjectDockHub adds its labels from a separate file, so Logs, Shell, Stats and "Why?" work.

Or set the project up with ProjectDockHub's own services on the next page instead.`,
      okLabel: `Run ${file}`,
      cancelLabel: 'Set up with ProjectDockHub',
      okClass: 'primary',
    });
    if (useIt) {
      wizard.input = { name, stack: 'compose', folder: wizard.folder, composeFile: file };
      wizard.created = false;
      runCreate();
      return;
    }
  }
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
  wizard.composeFile = '';
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
  showView('projects');
}

function showCreateCard() {
  createAnother();
  el.createCard.hidden = false;
  showView('new');
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
  el.editRebuild.disabled = busy;
  el.editAddService.disabled = busy;
}

// ---------- Composer help (Settings tab, Laravel) ----------

// The common Composer problems in plain words, with the commands to copy. Built from text only (CSP safe).
const COMPOSER_HELP = [
  {
    title: 'Error: "affected by security advisories"',
    text: 'Old Laravel versions (7, 8...) have known security problems, so a new Composer refuses to install them. ProjectDockHub already turns this block off inside its containers. If you still see it, click Save and apply (or Restart) so the container gets the new setting, then run the command again. Old versions are fine on your own computer, but upgrade Laravel before the site goes online.',
  },
  {
    title: 'Error: "your php version does not satisfy that requirement"',
    text: 'A package is too old for the PHP of this project. Laravel 7 and 8 packages need an old PHP, newer Laravel needs PHP 8.2 or newer. The fix is to update that package, or Laravel itself (see the next point). The PHP version of an existing project cannot be changed in Settings yet.',
  },
  {
    title: 'Upgrading Laravel (for example 8 to 9)',
    text: 'Go one version at a time (8 to 9, then 10, 11, 12). First change composer.json, then update. Laravel 9 does not work with facade/ignition and fruitcake/laravel-cors, and needs newer versions of collision and Sanctum. Open the terminal of the php service and run:',
    commands: [
      'composer remove fruitcake/laravel-cors facade/ignition --no-update',
      'composer require --dev spatie/laravel-ignition:^1.0 nunomaduro/collision:^6.1 --no-update',
      'composer require laravel/sanctum:^3.0 --no-update',
      'composer update --with-all-dependencies',
    ],
    after: 'Then read the official upgrade guide of that version (laravel.com/docs/upgrade): some code has to change too, for example the CORS and TrustProxies middleware. Back up the project with git first, and run "php artisan config:clear" at the end.',
  },
  {
    title: '"Deprecated: ..." lines in the output',
    text: 'These are warnings from an old package running on a newer PHP. They do not stop anything and can be ignored.',
  },
  {
    title: 'Error: "Allowed memory size exhausted"',
    text: 'Composer ran out of memory. Run it again like this:',
    commands: ['COMPOSER_MEMORY_LIMIT=-1 composer update'],
  },
];

// "Open Composer help" (Overview): goes to the Settings tab, opens the help box and scrolls to it.
let composerHelpWanted = false;

function showComposerHelpIfWanted() {
  if (!composerHelpWanted) return;
  const box = el.editComposerHelp.querySelector('details');
  if (!box) return;
  composerHelpWanted = false;
  box.open = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openComposerHelp() {
  composerHelpWanted = true;
  setDetailTab('settings');
  // The form can already be on the page (opened before); otherwise it shows the help when it is built.
  showComposerHelpIfWanted();
}

function composerHelpCard() {
  const details = makeElement('details', 'cred-section cred-tip');
  const summary = makeElement('summary', '');
  summary.textContent = 'Composer problems? Click here for help';
  details.appendChild(summary);

  const intro = makeElement('p', 'muted small');
  intro.textContent = 'Composer installs the PHP packages of a Laravel project. Run it in the terminal of the php service (project page, Services, Terminal), not on your own computer: it uses the PHP of this project.';
  details.appendChild(intro);

  for (const item of COMPOSER_HELP) {
    const heading = makeElement('h4', '');
    heading.textContent = item.title;
    const text = makeElement('p', 'muted small');
    text.textContent = item.text;
    details.append(heading, text);
    if (item.commands) {
      const code = makeElement('pre', 'code-block');
      code.textContent = item.commands.join('\n');
      const row = makeElement('div', 'row-actions');
      const copy = addButton(row, 'Copy commands', () => copyWithFeedback(item.commands.join('\n'), copy));
      details.append(code, row);
    }
    if (item.after) {
      const after = makeElement('p', 'muted small');
      after.textContent = item.after;
      details.appendChild(after);
    }
  }
  return details;
}

// ---------- Docker files (Settings tab) ----------

const DF_STATUS = {
  new: ['New', 'status-running'],
  replace: ['Will be replaced (old one kept as .bak)', 'status-partly'],
  same: ['Up to date', 'status-stopped'],
};

// Shows the services and the files "Generate Docker files" writes. Nothing is written here.
function renderDockerFiles(data) {
  const body = byId('df-body');
  body.textContent = '';

  const servicesTitle = makeElement('p', 'df-label');
  servicesTitle.textContent = `Services (${data.services.length})`;
  const chips = makeElement('div', 'chips');
  for (const name of data.services) {
    const chip = makeElement('span', 'svc-chip');
    chip.textContent = name;
    chips.appendChild(chip);
  }

  const filesTitle = makeElement('p', 'df-label');
  filesTitle.textContent = 'Files';
  const list = makeElement('div', 'df-files');
  for (const file of data.files) {
    const row = makeElement('div', 'df-file');
    const name = makeElement('code', 'df-path');
    name.textContent = file.path;
    const [text, cls] = DF_STATUS[file.status] || DF_STATUS.new;
    const pill = makeElement('span', `status ${cls}`);
    pill.textContent = text;
    row.append(name, pill);
    list.appendChild(row);
  }

  const startTitle = makeElement('p', 'df-label');
  startTitle.textContent = 'Start it without ProjectDockHub (stop the project here first, the ports are the same)';
  const box = makeElement('div', 'code-box');
  const code = makeElement('code', '');
  code.textContent = data.command;
  const copy = addButton(box, 'Copy', () => copyWithFeedback(data.command, copy));
  box.prepend(code);

  body.append(servicesTitle, chips, filesTitle, list, startTitle, box);
}

async function loadDockerFiles(name) {
  const section = byId('edit-docker-files');
  section.dataset.project = name;
  setNote('df-message', '');
  try {
    const data = await window.envhub.dockerFiles(name);
    if (section.dataset.project !== name) return;
    byId('df-generate').disabled = false;
    renderDockerFiles(data);
  } catch (err) {
    if (section.dataset.project !== name) return;
    byId('df-body').textContent = '';
    byId('df-generate').disabled = true;
    setNote('df-message', `Docker files: ${ipcMessage(err)}`, 'error');
  }
}

async function generateDockerFilesNow() {
  const name = byId('edit-docker-files').dataset.project;
  const button = byId('df-generate');
  if (!name) return;
  button.disabled = true;
  try {
    const res = await window.envhub.generateDockerFiles(name);
    await loadDockerFiles(name);
    const parts = [];
    if (res.written.length > 0) parts.push(`Created in ${res.folder}: ${res.written.join(', ')}.`);
    else parts.push('All files were already up to date. Nothing was changed.');
    if (res.backups.length > 0) parts.push(`Old files kept as: ${res.backups.join(', ')}.`);
    setNote('df-message', parts.join(' '), 'ok');
  } catch (err) {
    setNote('df-message', `Could not write the Docker files: ${ipcMessage(err)}`, 'error');
  } finally {
    button.disabled = false;
  }
}

// Short mark and one line about each service, for the service tiles of the Settings tab.
const SERVICE_TILES = {
  mysql: ['MY', 'Database, data kept in a volume', 'blue'],
  mariadb: ['MA', 'Database, data kept in a volume', 'blue'],
  postgres: ['PG', 'Database, data kept in a volume', 'blue'],
  mongodb: ['MG', 'Document database, data kept in a volume', 'teal'],
  redis: ['RD', 'Cache and queues', 'red'],
  phpmyadmin: ['PH', 'Browser admin for MySQL', 'amber'],
  adminer: ['AD', 'Browser admin for databases', 'amber'],
  mailpit: ['MP', 'Catches outgoing mail for testing', 'teal'],
  node: ['ND', 'Front-end build and dev server', 'green'],
};

// ---------- Settings tab: choose the ports by hand ----------

// One row per published port: service, localhost:[port] -> container port, the live check, and "Use this port".
function renderPortEditor(name) {
  const box = byId('edit-ports-list');
  const project = projectsView.list.find((p) => p.name === name);
  const ports = project ? project.ports : [];
  byId('edit-ports').hidden = ports.length === 0;
  box.textContent = '';
  for (const port of ports) box.appendChild(portEditRow(name, port, isRunningProject(project)));
}

function portEditRow(name, port, running) {
  const row = makeElement('div', 'port-edit');
  const svc = makeElement('span', 'port-edit-svc');
  svc.textContent = port.service;
  const field = makeElement('label', 'port-edit-field');
  const prefix = makeElement('span', 'mono muted');
  prefix.textContent = 'localhost:';
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 5;
  input.value = String(port.host);
  input.setAttribute('aria-label', `Port on this computer for ${port.service} (container port ${port.container})`);
  const arrow = makeElement('span', 'mono muted');
  arrow.textContent = `→ ${port.container}`;
  field.append(prefix, input, arrow);
  const status = makeElement('span', 'port-edit-status');
  status.setAttribute('aria-live', 'polite');
  const use = addButton(row, 'Use this port', () => usePort(name, port, input, status, use));
  use.classList.add('btn-sm');
  use.disabled = true;
  row.prepend(svc, field, status);
  row.appendChild(use);

  let timer = null;
  let asked = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    use.disabled = true;
    status.className = 'port-edit-status';
    status.textContent = input.value.trim() === String(port.host) ? '' : 'Checking...';
    if (input.value.trim() === String(port.host)) return;
    timer = setTimeout(async () => {
      const ask = ++asked;
      try {
        const res = await window.envhub.checkPort(name, port.service, port.container, input.value);
        if (ask !== asked) return;
        status.textContent = res.message;
        status.classList.add(res.ok ? 'ok' : 'bad');
        use.disabled = !res.ok || res.same === true;
      } catch (err) {
        if (ask !== asked) return;
        status.textContent = `Could not check: ${ipcMessage(err)}`;
        status.classList.add('bad');
      }
    }, 350);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !use.disabled) use.click();
  });
  return row;
}

async function usePort(name, port, input, status, button) {
  button.disabled = true;
  try {
    const res = await window.envhub.setPort(name, port.service, port.container, input.value);
    if (!res.ok) {
      status.textContent = res.message;
      status.className = 'port-edit-status bad';
      return;
    }
    const text = res.running
      ? `${port.service} will open at localhost:${res.port}. The project still runs on ${port.host}: apply the change to use the new port.`
      : `${port.service} now opens at localhost:${res.port} (from the next start).`;
    setNote('edit-ports-note', text, 'ok');
    const note = byId('edit-ports-note');
    note.querySelector('.port-apply')?.remove();
    if (res.running) {
      const apply = makeElement('button', 'btn-xs port-apply primary');
      apply.type = 'button';
      apply.textContent = 'Apply now';
      apply.addEventListener('click', () => {
        setNote('edit-ports-note', '');
        applyEdit(name);
      });
      note.insertBefore(apply, note.querySelector('.note-close'));
    }
    addNotification({ project: name, text: `${port.service}: port ${port.host} → ${res.port}`, kind: 'ok' });
    await loadProjects();
    renderPortEditor(name);
  } catch (err) {
    status.textContent = `Could not save: ${ipcMessage(err)}`;
    status.className = 'port-edit-status bad';
  } finally {
    if (document.body.contains(button)) button.disabled = true;
  }
}

function renderEdit(details) {
  editState.name = details.name;
  editState.running = details.running === true;
  el.editTitle.textContent = `Edit services: ${details.name} · ${details.label}`;

  for (const label of el.editOptions.querySelectorAll('label')) label.remove();
  for (const key of details.optionKeys) {
    const label = makeElement('label', 'opt-tile svc-tile');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.key = key;
    box.checked = details.options[key] === true;
    box.addEventListener('change', () => syncEditDependencies(key));
    const [markText, about, tone] = SERVICE_TILES[key] || [key.slice(0, 2).toUpperCase(), '', 'blue'];
    const mark = makeElement('span', `svc-tile-mark tone-${tone}`);
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = markText;
    const text = makeElement('span', 'svc-tile-text');
    const title = makeElement('span', 'opt-name');
    title.textContent = EDIT_LABELS[key] || key;
    const note = makeElement('span', 'svc-tile-note');
    note.textContent = about;
    text.append(title, note);
    const top = makeElement('span', 'svc-tile-top');
    top.append(box, mark, text);
    label.append(top);
    if (registry && DB_VERSION_KEYS.includes(key)) {
      const row = makeElement('span', 'svc-tile-ver');
      row.append('Version');
      const select = document.createElement('select');
      select.className = 'ver-select';
      select.dataset.versionKey = key;
      select.setAttribute('aria-label', `${EDIT_LABELS[key]} version`);
      fillVersionSelect(select, key, (details.versions && details.versions[key]) || registry[key].default);
      row.append(select);
      label.append(row);
    }
    el.editOptions.appendChild(label);
  }

  const listed = projectsView.list.find((p) => p.name === details.name) || {};
  const services = listed.services || [];
  const dataCount = (listed.dataServices || []).length;
  const folderText = listed.imported ? 'Your project folder is kept.' : 'The project folder and its files are deleted too.';
  setText('edit-danger-text', `Delete stops and removes the ${services.length} container${services.length === 1 ? '' : 's'}.${dataCount ? ' You choose whether the database data goes too.' : ''} ${folderText} It asks before anything is removed.`);
  renderPortEditor(details.name);
  el.editDbName.value = details.dbName || 'app';
  el.editDbUser.value = details.dbUser || 'app';
  el.editDbPass.value = details.dbPassword || '';
  el.editRedisPass.value = details.redisPassword || '';
  el.editLan.checked = details.lanShare === true;
  el.editPython.hidden = !details.packagesLabel;
  el.editKeepPackagesText.textContent = details.packagesLabel || '';
  el.editKeepPackages.checked = details.keepPackages === true;
  loadDockerFiles(details.name);
  // Composer help: only Laravel projects have composer.
  el.editComposerHelp.textContent = '';
  if (details.php) el.editComposerHelp.appendChild(composerHelpCard());
  showComposerHelpIfWanted();
  // Slow on Windows: the fix is part of the Settings tab, under the vendor switch.
  el.editSlowTip.textContent = '';
  if (isWindowsBrowser() && details.folder) el.editSlowTip.appendChild(slowOnWindowsTip(details.folder));
  el.editVendorRow.hidden = !(details.php && details.php.vendorVolumeAvailable);
  el.editVendorVolume.checked = Boolean(details.php && details.php.vendorVolume);
  syncEditDbField();

  el.editPhp.hidden = !details.php;
  el.editRebuild.hidden = !details.php;
  el.editPhpNote.hidden = !(details.php && details.php.rebuildNeeded);
  el.editPhpExt.textContent = '';
  if (details.php) {
    for (const ext of details.php.available) {
      const label = makeElement('label', 'opt-tile');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.ext = ext.key;
      box.checked = details.php.extensions.includes(ext.key);
      const title = makeElement('span', 'opt-name');
      title.textContent = ext.label;
      label.append(box, title);
      el.editPhpExt.appendChild(label);
    }
    el.editPhpIni.value = details.php.ini;
  }

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

async function openEdit(name, show = true) {
  ensureProjectsView();
  mountPanel(el.editCard);
  if (editState.name !== name) editState.name = '';
  el.editCard.hidden = !show;
  el.editError.hidden = true;
  // An apply that is still running keeps its progress on screen when the user comes back to this tab.
  const stillApplying = applyingName === name;
  el.editProgress.hidden = !stillApplying;
  setEditBusy(applyingName !== '');
  el.editExtras.textContent = '';
  for (const label of el.editOptions.querySelectorAll('label')) label.remove();
  el.editMessage.textContent = 'Loading...';
  if (show) el.editCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // The form of the last read shows at once; the fresh one replaces it when it arrives.
  const known = overviewCache.get(name);
  if (known && known.details) {
    renderEdit(known.details);
    el.editMessage.textContent = '';
  }

  try {
    const details = await window.envhub.projectDetails(name);
    if (known && editState.name && editState.name !== name) return;
    renderEdit(details);
    if (overviewCache.has(name)) overviewCache.set(name, { ...overviewCache.get(name), details });
    el.editMessage.textContent = '';
  } catch (err) {
    if (known && known.details) return;
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

// After a successful apply, the progress panel closes by itself. A failed one stays open, so its log can be read.
const PROGRESS_CLOSE_MS = 4000;
let progressCloseTimer = null;

// The project whose apply is running now. Leaving the Settings tab does not stop it, so coming back must keep showing it.
let applyingName = '';

async function applyEdit(name, rebuild = false) {
  clearTimeout(progressCloseTimer);
  applyingName = name;
  el.editProgress.hidden = false;
  editView.begin(rebuild ? `Rebuilding the PHP container of ${name}` : `Applying changes to ${name}`);
  let res;
  try {
    res = await runStart(name, editView, { apply: true, rebuild });
  } finally {
    applyingName = '';
  }
  const result = describeResult(rebuild ? 'Rebuild' : 'Apply', name, res);
  setActionStatus(result, name);
  if (res.ok !== false) {
    // The notice about a pending rebuild goes away once the build worked.
    if (editState.name === name) {
      el.editPhpNote.hidden = true;
      el.editMessage.textContent = result;
    }
    progressCloseTimer = setTimeout(() => { el.editProgress.hidden = true; }, PROGRESS_CLOSE_MS);
  }
  await refreshAfterEdit();
}

async function saveEdit(applyNow, rebuild = false) {
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
        phpExtensions: el.editPhp.hidden ? undefined : [...el.editPhpExt.querySelectorAll('input[data-ext]')].filter((box) => box.checked).map((box) => box.dataset.ext),
        phpIni: el.editPhp.hidden ? undefined : el.editPhpIni.value,
        vendorVolume: el.editVendorRow.hidden ? undefined : el.editVendorVolume.checked,
        versions: Object.fromEntries([...el.editOptions.querySelectorAll('select[data-version-key]')].map((s) => [s.dataset.versionKey, s.value])),
      });
    } catch (err) {
      el.editError.textContent = ipcMessage(err);
      el.editError.hidden = false;
      return;
    }

    renderEdit(res.details);
    // The saved settings are the new truth for the form. The services are read again below.
    overviewCache.delete(name);
    refreshProjectCache(name, 300);
    el.editMessage.textContent = savedText(res, applyNow);
    // Tell the user that the image still has to be rebuilt. The message stays until it is closed.
    if (!applyNow && res.details.php && res.details.php.rebuildNeeded) {
      setActionStatus('PHP extensions changed. Click "Save and apply" or "Rebuild PHP container" to install them.', name, 'warn');
    }
    await refreshAfterEdit();
    if (applyNow) await applyEdit(name, rebuild);
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

// Opens a terminal window in the service, in the folder that holds the project files.
async function openLinksTerminal(name, svc) {
  try {
    await window.envhub.projectShell(name, svc.name);
    el.linksMessage.textContent = `Opened a terminal for ${svc.name}${svc.workdir ? ` in ${svc.workdir}` : ''}.`;
  } catch (err) {
    el.linksMessage.textContent = `Could not open a terminal: ${ipcMessage(err)}`;
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

function renderLinks(data) {
  el.linksTitle.textContent = `Links & commands: ${data.name}`;
  const notes = [];
  if (!data.running) notes.push('The project is not running. Start it to open the links.');
  if (data.lanShare && !data.lanFound) notes.push('Sharing is on, but no Wi-Fi or network address was found on this computer.');
  el.linksNote.textContent = notes.join(' ');
  el.linksNote.hidden = notes.length === 0;

  el.linksServices.textContent = '';
  for (const svc of data.services) {
    const card = makeElement('div', 'lk-card');
    const head = makeElement('div', 'lk-head');
    const mark = makeElement('span', 'svc-mark');
    mark.textContent = svc.name.slice(0, 2);
    const info = makeElement('div', 'lk-info');
    const title = makeElement('strong', '');
    title.textContent = svc.name;
    const image = makeElement('span', 'svc-image');
    image.textContent = svc.image;
    info.append(title, image);
    const actions = makeElement('div', 'row-actions');
    for (const port of svc.ports) {
      const label = port.url.replace('http://', '');
      const button = addButton(actions, `Open ${label}`, () => openPort(data.name, svc.name, port.container, label));
      button.disabled = !data.running;
      button.classList.add('primary-soft');
    }
    head.append(mark, info, actions);
    card.appendChild(head);
    if (svc.command) card.appendChild(codeRow('Runs', svc.command));
    card.appendChild(codeRow('Shell', svc.shell, {
      terminal: {
        title: data.running ? `Open a terminal in ${svc.name}${svc.workdir ? ` (${svc.workdir})` : ''}` : 'Start the project to open a terminal',
        disabled: !data.running,
        onClick: () => openLinksTerminal(data.name, svc),
      },
    }));
    for (const port of svc.ports) {
      for (const url of port.lanUrls || []) card.appendChild(codeRow('Other computers', url));
    }
    el.linksServices.appendChild(card);
  }

  el.linksCommands.textContent = '';
  for (const command of data.commands) el.linksCommands.appendChild(codeRow(command.label, command.text));
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
  ensureProjectsView();
  mountPanel(el.linksCard);
  linksState.name = name;
  el.linksCard.hidden = false;
  el.linksMessage.textContent = 'Loading...';
  el.linksCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  await loadLinks();
  if (el.linksMessage.textContent === 'Loading...') el.linksMessage.textContent = '';
}

// ---------- Data tab: every service that has a viewer, in one place ----------

// Which kinds of data the tab can show. The service catalog decides which service has which viewer.
const VIEWER_INFO = {
  mail: { label: 'Mail', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path></svg>' },
  requests: { label: 'API requests', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h11M11 3l4 4-4 4"></path><path d="M20 17H9M13 13l-4 4 4 4"></path></svg>' },
  keyvalue: { label: 'Key-value', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="8" ry="3"></ellipse><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"></path><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"></path></svg>' },
};
const dataView = { name: '', service: '', viewer: '' };
// The service last opened in each project, so coming back to the tab shows the same one.
const dataChoice = new Map();

function paintDataServices(project) {
  const box = byId('dv-services');
  box.textContent = '';
  for (const v of project.viewers || []) {
    const info = VIEWER_INFO[v.viewer] || { label: v.viewer, icon: '' };
    const button = makeElement('button', 'data-service');
    button.type = 'button';
    button.setAttribute('aria-pressed', v.service === dataView.service ? 'true' : 'false');
    const mark = makeElement('span', `data-service-icon viewer-${v.viewer}`);
    mark.innerHTML = info.icon;
    const text = makeElement('span', 'data-service-text');
    const name = makeElement('span', 'data-service-name');
    name.textContent = v.service;
    const kind = makeElement('span', 'data-service-kind');
    kind.textContent = `${info.label} · ${v.label}`;
    text.append(name, kind);
    button.append(mark, text);
    button.addEventListener('click', () => openDataService(project.name, v));
    box.appendChild(button);
  }
}

function openDataService(name, v) {
  dataView.service = v.service;
  dataView.viewer = v.viewer;
  dataChoice.set(name, v.service);
  const project = projectsView.list.find((p) => p.name === name);
  if (project) paintDataServices(project);
  stopMailView();
  stopRequestsView();
  el.mailViewCard.hidden = true;
  el.redisViewCard.hidden = true;
  el.reqViewCard.hidden = true;
  if (v.viewer === 'mail') showMail(name, v.service);
  else if (v.viewer === 'keyvalue') showRedis(name, v.service);
  else if (v.viewer === 'requests') showRequests(name, v.service);
}

function showData(name) {
  const project = projectsView.list.find((p) => p.name === name);
  const viewers = (project && project.viewers) || [];
  ensureProjectsView();
  mountPanel(el.dataViewCard);
  el.dataViewCard.hidden = false;
  dataView.name = name;
  if (!viewers.length) {
    byId('dv-services').textContent = '';
    byId('dv-body').textContent = '';
    return;
  }
  const wanted = dataChoice.get(name);
  const pick = viewers.find((v) => v.service === wanted) || viewers[0];
  openDataService(name, pick);
}

// ---------- Requests viewer: what an app sent to a fake API (Smocker) ----------

const reqView = { name: '', service: '', items: [], selected: -1, query: '', timer: null, info: null };
const REQ_REFRESH_MS = 4000;

function stopRequestsView() {
  clearTimeout(reqView.timer);
  reqView.timer = null;
}

function methodTag(method) {
  const tag = makeElement('span', `method-tag method-${String(method).toLowerCase()}`);
  tag.textContent = method || '?';
  return tag;
}

function shownRequests() {
  const needle = reqView.query.trim().toLowerCase();
  if (!needle) return reqView.items;
  return reqView.items.filter((r) => `${r.method} ${r.path} ${r.query} ${r.body}`.toLowerCase().includes(needle));
}

function paintRequestList() {
  const list = byId('qv-list');
  list.textContent = '';
  const items = shownRequests();
  for (const r of items) {
    const li = makeElement('li', `mail-item req-item ${r.i === reqView.selected ? 'on' : ''}`.trim());
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const top = makeElement('div', 'mail-top');
    const left = makeElement('span', 'req-line');
    const path = makeElement('span', 'req-path mono');
    path.textContent = `${r.path}${r.query ? `?${r.query}` : ''}`;
    left.append(methodTag(r.method), path);
    const time = makeElement('time', 'mail-time');
    time.textContent = r.at ? mailTime(r.at) : '';
    if (r.at) time.title = new Date(r.at).toLocaleString();
    top.append(left, time);
    const meta = makeElement('span', 'mail-snippet');
    meta.textContent = `${r.status ? `answered ${r.status}` : 'no answer'}${r.mocked ? '' : ' (no rule matched)'} · ${r.body ? r.body.slice(0, 90) : 'no body'}`;
    li.append(top, meta);
    const open = () => openRequest(r.i);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    list.appendChild(li);
  }
  if (!items.length) {
    const empty = makeElement('li', 'mail-empty');
    empty.textContent = reqView.query
      ? 'No request matches this search.'
      : 'No requests yet. Point your app\'s API URL (fax, SMS, payment) at this service; every call it makes shows here.';
    list.appendChild(empty);
  }
  setText('qv-count', `${reqView.items.length} request${reqView.items.length === 1 ? '' : 's'}`);
}

function paintRequestEmptyDetail() {
  const box = byId('qv-detail');
  box.textContent = '';
  const p = makeElement('p', 'detail-empty');
  p.textContent = 'Pick a request on the left to see what the app sent.';
  box.appendChild(p);
}

function openRequest(i) {
  reqView.selected = i;
  paintRequestList();
  const r = reqView.items.find((x) => x.i === i);
  const box = byId('qv-detail');
  box.textContent = '';
  if (!r) {
    paintRequestEmptyDetail();
    return;
  }
  const head = makeElement('div', 'mail-head');
  const title = makeElement('h3', 'req-title');
  const path = makeElement('span', 'mono');
  path.textContent = r.path;
  title.append(methodTag(r.method), path);
  head.appendChild(title);
  const rows = [['When', r.at ? new Date(r.at).toLocaleString() : '–', false], ['Answer', r.status ? `${r.status}${r.mocked ? '' : ' (no rule matched: Smocker answers 666)'}` : '–', false]];
  if (r.query) rows.push(['Query', r.query]);
  if (r.origin) rows.push(['From', r.origin]);
  head.appendChild(kvList(rows));
  const copy = addButton(head, 'Copy body', (event) => copyWithFeedback(r.body, event.currentTarget));
  copy.classList.add('btn-xs', 'mail-delete');
  copy.disabled = !r.body;
  box.appendChild(head);

  const section = (label, content) => {
    const wrap = makeElement('div', 'req-section');
    const h = makeElement('h4', 'panel-title');
    h.textContent = label;
    wrap.append(h, content);
    box.appendChild(wrap);
  };
  const body = makeElement('pre', 'mail-text');
  body.textContent = r.body ? prettyValue(r.body) : '(no body)';
  section('Request body', body);
  const headers = Object.entries(r.headers || {});
  if (headers.length) section('Request headers', valueTable(['Header', 'Value'], headers));
  const answer = makeElement('pre', 'mail-text');
  answer.textContent = r.responseBody ? prettyValue(r.responseBody) : '(empty)';
  section(`Answer sent to the app (${r.status || '–'})`, answer);
}

async function refreshRequestsView() {
  const { name, service } = reqView;
  if (!name) return;
  stopRequestsView();
  try {
    const items = await window.envhub.requestsList(name, service);
    if (reqView.name !== name || reqView.service !== service) return;
    reqView.items = items;
    setNote('qv-error', '');
    paintRequestList();
    if (reqView.selected >= 0 && !items.some((r) => r.i === reqView.selected)) {
      reqView.selected = -1;
      paintRequestEmptyDetail();
    }
  } catch (err) {
    if (reqView.name !== name) return;
    reqView.items = [];
    paintRequestList();
    setNote('qv-error', ipcMessage(err), 'error');
  }
  if (document.body.dataset.view === 'detail' && detailState.tab === 'data' && detailState.name === name && dataView.viewer === 'requests') {
    reqView.timer = setTimeout(refreshRequestsView, REQ_REFRESH_MS);
  }
}

function paintRequestsConnect() {
  const info = reqView.info;
  const box = byId('qv-connect-env');
  box.textContent = '';
  if (!info) {
    setText('qv-connect-note', 'Loading...');
    return;
  }
  const lines = [`FAX_API_URL=http://${info.service}:8080`];
  for (const line of lines) {
    const row = makeElement('div', '');
    const at = line.indexOf('=');
    const key = makeElement('span', 'env-key');
    key.textContent = line.slice(0, at);
    const eq = makeElement('span', 'env-eq');
    eq.textContent = '=';
    const value = makeElement('span', 'env-val');
    value.textContent = line.slice(at + 1);
    row.append(key, eq, value);
    box.appendChild(row);
  }
  setText('qv-connect-note', `Use http://${info.service}:8080 as the API address of your provider (fax, SMS, payment) in the app's settings. The variable name depends on your package; FAX_API_URL is an example.${info.apiPort ? ` From this computer: http://127.0.0.1:${info.apiPort}.` : ''}`);
  const open = byId('qv-open');
  open.disabled = !info.adminPort;
  open.title = info.adminPort ? 'Open Smocker\'s own page' : `${info.service} has no port 8081 on this computer. Add it in the Settings tab (Extra services) to open the page. This tab works without it.`;
}

async function showRequests(name, service) {
  if (reqView.name !== name || reqView.service !== service) {
    Object.assign(reqView, { name, service, items: [], selected: -1, query: '', info: null });
    byId('qv-search').value = '';
    paintRequestEmptyDetail();
  }
  byId('dv-body').appendChild(el.reqViewCard);
  el.reqViewCard.hidden = false;
  paintRequestsConnect();
  window.envhub.requestsInfo(name, service).then((info) => {
    if (reqView.name === name && reqView.service === service) {
      reqView.info = info;
      paintRequestsConnect();
    }
  }).catch((err) => setNote('qv-error', ipcMessage(err), 'error'));
  await refreshRequestsView();
}

function bindRequestsView() {
  byId('qv-search').addEventListener('input', (event) => {
    reqView.query = event.target.value;
    paintRequestList();
  });
  byId('qv-refresh').addEventListener('click', refreshRequestsView);
  byId('qv-ok').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await window.envhub.requestsAnswerOk(reqView.name, reqView.service);
      setNote('qv-error', 'Every request now gets 200 with {"status":"queued","id":"test-1"}. Your app sees the fax (or call) as sent.', 'ok');
    } catch (err) {
      setNote('qv-error', `Could not load the rule: ${ipcMessage(err)}`, 'error');
    }
    button.blur();
  });
  byId('qv-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Clear the caught requests?', body: 'The list is emptied. Smocker also forgets its answer rules: click "Answer every request with 200" again afterwards.', okLabel: 'Clear' });
    if (!ok) return;
    try {
      await window.envhub.requestsReset(reqView.name, reqView.service);
      reqView.selected = -1;
      paintRequestEmptyDetail();
      refreshRequestsView();
    } catch (err) {
      setNote('qv-error', `Could not clear: ${ipcMessage(err)}`, 'error');
    }
  });
  byId('qv-open').addEventListener('click', () => {
    if (reqView.info && reqView.info.adminPort) openService(reqView.name, reqView.service, 'Smocker');
  });
  byId('qv-connect-copy').addEventListener('click', (event) => copyWithFeedback(reqView.info ? `FAX_API_URL=http://${reqView.info.service}:8080` : '', event.currentTarget));
}

// ---------- Mail tab: the mails Mailpit caught ----------

const mailView = { name: '', items: [], selected: '', query: '', timer: null, searchTimer: null };
const MAIL_REFRESH_MS = 5000;

function stopMailView() {
  clearTimeout(mailView.timer);
  mailView.timer = null;
}

function mailTime(iso) {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = (Date.now() - at) / 60000;
  return minutes < 60 * 24 ? agoText(minutes, true) : new Date(at).toLocaleDateString();
}

function paintMailList() {
  const list = byId('mv-list');
  list.textContent = '';
  for (const m of mailView.items) {
    const li = makeElement('li', `mail-item ${m.read ? '' : 'unread'} ${m.id === mailView.selected ? 'on' : ''}`.trim());
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const top = makeElement('div', 'mail-top');
    const from = makeElement('span', 'mail-from');
    from.textContent = m.from || '(no sender)';
    const time = makeElement('time', 'mail-time');
    time.textContent = mailTime(m.created);
    time.title = new Date(m.created).toLocaleString();
    top.append(from, time);
    const subject = makeElement('span', 'mail-subject');
    if (m.attachments) {
      const clip = makeElement('span', 'mail-clip');
      clip.title = `${m.attachments} attachment${m.attachments === 1 ? '' : 's'}`;
      clip.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"></path></svg>';
      subject.appendChild(clip);
    }
    subject.append(m.subject);
    const snippet = makeElement('span', 'mail-snippet');
    snippet.textContent = m.snippet;
    li.append(top, subject, snippet);
    const open = () => openMail(m.id);
    li.addEventListener('click', open);
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    list.appendChild(li);
  }
  if (!mailView.items.length) {
    const empty = makeElement('li', 'mail-empty');
    empty.textContent = mailView.query
      ? 'No mail matches this search.'
      : 'No mails yet. Mails your app sends (to any address) are caught here instead of being delivered.';
    list.appendChild(empty);
  }
}

async function refreshMailView() {
  const name = mailView.name;
  if (!name) return;
  stopMailView();
  try {
    const data = await window.envhub.mailList(name, { search: mailView.query, service: mailView.service });
    if (mailView.name !== name) return;
    mailView.items = data.messages;
    setText('mv-count', `${data.total} mail${data.total === 1 ? '' : 's'}${data.unread ? ` · ${data.unread} unread` : ''}`);
    setNote('mv-error', '');
    paintMailList();
    if (!mailView.selected && !mailView.items.length) paintMailEmptyDetail();
  } catch (err) {
    if (mailView.name !== name) return;
    mailView.items = [];
    paintMailList();
    setText('mv-count', '');
    setNote('mv-error', ipcMessage(err), 'error');
  }
  if (document.body.dataset.view === 'detail' && detailState.tab === 'data' && detailState.name === name && dataView.viewer === 'mail') {
    mailView.timer = setTimeout(refreshMailView, MAIL_REFRESH_MS);
  }
}

function paintMailEmptyDetail() {
  const box = byId('mv-detail');
  box.textContent = '';
  const p = makeElement('p', 'detail-empty');
  p.textContent = 'Pick a mail on the left to read it.';
  box.appendChild(p);
}

async function openMail(id) {
  const name = mailView.name;
  mailView.selected = id;
  paintMailList();
  const box = byId('mv-detail');
  box.textContent = 'Loading...';
  try {
    const m = await window.envhub.mailRead(name, id, mailView.service);
    if (mailView.name !== name || mailView.selected !== id) return;
    box.textContent = '';
    const head = makeElement('div', 'mail-head');
    const subject = makeElement('h3', '');
    subject.textContent = m.subject;
    head.appendChild(subject);
    head.appendChild(kvList([['From', m.from, false], ['To', m.to, false], ...(m.cc ? [['Cc', m.cc, false]] : []), ['Date', new Date(m.date).toLocaleString(), false]]));
    if (m.attachments.length) {
      const files = makeElement('p', 'muted small mail-files');
      files.textContent = `Attachments: ${m.attachments.map((a) => `${a.name} (${a.size < 1e6 ? `${Math.max(1, Math.round(a.size / 1024))} KB` : formatBytes(a.size)})`).join(', ')}`;
      head.appendChild(files);
    }
    const seg = makeElement('div', 'seg');
    const view = makeElement('div', 'mail-view');
    const show = (mode) => {
      for (const b of seg.children) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
      view.textContent = '';
      if (mode === 'html' && m.html) {
        // Mailpit's own page for this mail, in a frame without scripts, forms or popups. When Mailpit has no
        // port on this computer, the mail's HTML itself goes into the same locked frame.
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', '');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.title = `Mail: ${m.subject}`;
        if (m.viewUrl) frame.src = m.viewUrl;
        else frame.srcdoc = m.html;
        view.appendChild(frame);
      } else {
        const pre = makeElement('pre', 'mail-text');
        pre.textContent = m.text || '(This mail has no text part.)';
        view.appendChild(pre);
      }
    };
    for (const [mode, label] of [['html', 'HTML'], ['text', 'Text']]) {
      const b = addButton(seg, label, () => show(mode));
      b.dataset.mode = mode;
      if (mode === 'html' && !m.html) b.disabled = true;
    }
    const del = addButton(head, 'Delete', async () => {
      try {
        await window.envhub.mailDelete(name, [id], mailView.service);
        mailView.selected = '';
        paintMailEmptyDetail();
        refreshMailView();
      } catch (err) {
        setNote('mv-error', `Could not delete: ${ipcMessage(err)}`, 'error');
      }
    });
    del.classList.add('btn-xs', 'danger-outline', 'mail-delete');
    head.appendChild(seg);
    box.append(head, view);
    show(m.html ? 'html' : 'text');
    // Reading marks it as read in Mailpit; show that in the list.
    const item = mailView.items.find((x) => x.id === id);
    if (item) {
      item.read = true;
      paintMailList();
    }
  } catch (err) {
    box.textContent = '';
    setNote('mv-error', `Could not read the mail: ${ipcMessage(err)}`, 'error');
  }
}

// The .env lines an app needs to send its mail to this Mailpit.
const mailConnect = { info: null, target: 'docker' };

function mailEnvLines() {
  const info = mailConnect.info;
  if (!info) return '';
  if (mailConnect.target === 'host') {
    if (!info.smtpPort) return '';
    return ['MAIL_MAILER=smtp', 'MAIL_HOST=127.0.0.1', `MAIL_PORT=${info.smtpPort}`, 'MAIL_USERNAME=null', 'MAIL_PASSWORD=null', 'MAIL_ENCRYPTION=null'].join('\n');
  }
  return ['MAIL_MAILER=smtp', `MAIL_HOST=${info.service}`, 'MAIL_PORT=1025', 'MAIL_USERNAME=null', 'MAIL_PASSWORD=null', 'MAIL_ENCRYPTION=null'].join('\n');
}

function paintMailConnect() {
  const info = mailConnect.info;
  for (const b of document.querySelectorAll('[data-mail-target]')) b.setAttribute('aria-pressed', b.dataset.mailTarget === mailConnect.target ? 'true' : 'false');
  const box = byId('mv-connect-env');
  box.textContent = '';
  const text = mailEnvLines();
  let note = '';
  if (!info) note = 'Loading...';
  else if (mailConnect.target === 'docker') note = `For an app that runs in this project (php, node, app). The host is the service name, ${info.service}. Mailpit needs no user and no password: every mail is caught here, nothing is delivered.`;
  else if (info.smtpPort) note = `For an app you start yourself on this computer (php artisan serve, npm run dev). Port ${info.smtpPort} is published to this computer.`;
  else note = `${info.service} has no SMTP port on this computer. Add port 1025 to it in the Settings tab (Extra services), or use "Inside Docker".`;
  setText('mv-connect-note', note);
  for (const line of text.split('\n').filter(Boolean)) {
    const row = makeElement('div', '');
    const at = line.indexOf('=');
    const key = makeElement('span', 'env-key');
    key.textContent = line.slice(0, at);
    const eq = makeElement('span', 'env-eq');
    eq.textContent = '=';
    const value = makeElement('span', 'env-val');
    value.textContent = line.slice(at + 1);
    row.append(key, eq, value);
    box.appendChild(row);
  }
  box.hidden = !text;
  byId('mv-connect-copy').disabled = !text;
  // The web page opens only when Mailpit's port 8025 is published.
  const open = byId('mv-open');
  open.disabled = Boolean(info) && !info.webPort;
  open.title = info && !info.webPort ? `${info.service} has no port 8025 on this computer. Add it in the Settings tab (Extra services) to open the page. This tab works without it.` : 'Open Mailpit in the browser';
}

async function loadMailInfo(name) {
  mailConnect.info = null;
  paintMailConnect();
  try {
    const info = await window.envhub.mailInfo(name, mailView.service);
    if (mailView.name === name) {
      mailConnect.info = info;
      paintMailConnect();
    }
  } catch (err) {
    setNote('mv-error', ipcMessage(err), 'error');
  }
}

async function showMail(name, service) {
  if (mailView.name !== name || mailView.service !== service) {
    Object.assign(mailView, { name, service, items: [], selected: '', query: '' });
    byId('mv-search').value = '';
    paintMailEmptyDetail();
  }
  // The mail viewer sits inside the Data tab.
  byId('dv-body').appendChild(el.mailViewCard);
  el.mailViewCard.hidden = false;
  loadMailInfo(name);
  await refreshMailView();
}

// ---------- Redis tab: keys and values ----------

const redisView = { name: '', db: 0, pattern: '*', keys: [], selected: '', dbs: {}, searchTimer: null };

function ttlText(ttl) {
  if (ttl === -1) return 'no expiry';
  if (ttl < 0) return '—';
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h ${Math.floor((ttl % 3600) / 60)}m`;
  return `${Math.floor(ttl / 86400)}d`;
}

function paintRedisDbs() {
  const select = byId('rv-db');
  select.textContent = '';
  for (let db = 0; db < 16; db += 1) {
    const option = document.createElement('option');
    option.value = String(db);
    const count = redisView.dbs[db] || 0;
    option.textContent = `db${db}${count ? ` · ${count} key${count === 1 ? '' : 's'}` : ''}`;
    select.appendChild(option);
  }
  select.value = String(redisView.db);
}

function paintRedisKeys(more) {
  const box = byId('rv-keys');
  box.textContent = '';
  if (!redisView.keys.length) {
    const p = makeElement('p', 'detail-empty');
    p.textContent = redisView.pattern !== '*' ? 'No key matches this pattern.' : `db${redisView.db} has no keys. Laravel keeps cache in db1 and sessions and queues in db0.`;
    box.appendChild(p);
    return;
  }
  const table = makeElement('table', 'dtable mini redis-table');
  const head = makeElement('thead', '');
  const hr = makeElement('tr', '');
  for (const label of ['Key', 'Type', 'TTL']) {
    const th = makeElement('th', '');
    th.textContent = label;
    hr.appendChild(th);
  }
  head.appendChild(hr);
  const body = makeElement('tbody', '');
  for (const k of redisView.keys) {
    const row = makeElement('tr', `trow ${k.key === redisView.selected ? 'selected' : ''}`.trim());
    row.tabIndex = 0;
    const key = td('mono redis-key');
    key.textContent = k.key;
    key.title = k.key;
    const type = td();
    const tag = makeElement('span', `type-tag type-${k.type}`);
    tag.textContent = k.type;
    type.appendChild(tag);
    const ttl = td('mono muted');
    ttl.textContent = ttlText(k.ttl);
    row.append(key, type, ttl);
    row.addEventListener('click', () => openRedisKey(k.key));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openRedisKey(k.key);
    });
    body.appendChild(row);
  }
  table.append(head, body);
  box.appendChild(table);
  if (more) {
    const p = makeElement('p', 'muted small redis-more');
    p.textContent = 'Showing the first 500 keys. Use a pattern to narrow it down.';
    box.appendChild(p);
  }
}

async function refreshRedisView() {
  const name = redisView.name;
  if (!name) return;
  try {
    const overview = await window.envhub.redisOverview(name, redisView.service);
    if (redisView.name !== name) return;
    redisView.dbs = overview.dbs;
    paintRedisDbs();
    const total = Object.values(overview.dbs).reduce((a, b) => a + b, 0);
    setText('rv-info', `${total} key${total === 1 ? '' : 's'} in all databases${overview.memory ? ` · ${overview.memory} used` : ''}`);
    const res = await window.envhub.redisKeys(name, { db: redisView.db, pattern: redisView.pattern, service: redisView.service });
    if (redisView.name !== name) return;
    redisView.keys = res.keys;
    setNote('rv-error', '');
    paintRedisKeys(res.more);
    if (redisView.selected && !res.keys.some((k) => k.key === redisView.selected)) {
      redisView.selected = '';
      paintRedisEmptyValue();
    }
  } catch (err) {
    if (redisView.name !== name) return;
    redisView.keys = [];
    paintRedisKeys(false);
    setNote('rv-error', ipcMessage(err), 'error');
  }
}

function paintRedisEmptyValue() {
  const box = byId('rv-value');
  box.textContent = '';
  const p = makeElement('p', 'detail-empty');
  p.textContent = 'Pick a key on the left to see its value.';
  box.appendChild(p);
}

// A string that is JSON is shown formatted; Laravel's serialized PHP values are shown as they are.
function prettyValue(text) {
  const value = String(text);
  if (/^\s*[[{]/.test(value)) {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (err) {
      return value;
    }
  }
  return value;
}

function valueTable(headers, rows) {
  const table = makeElement('table', 'dtable mini value-table');
  const head = makeElement('thead', '');
  const hr = makeElement('tr', '');
  for (const h of headers) {
    const th = makeElement('th', '');
    th.textContent = h;
    hr.appendChild(th);
  }
  head.appendChild(hr);
  const body = makeElement('tbody', '');
  for (const cells of rows) {
    const tr = makeElement('tr', 'trow');
    for (const cell of cells) {
      const c = td('mono');
      c.textContent = cell;
      tr.appendChild(c);
    }
    body.appendChild(tr);
  }
  table.append(head, body);
  return table;
}

async function openRedisKey(key) {
  const name = redisView.name;
  redisView.selected = key;
  for (const row of byId('rv-keys').querySelectorAll('tr.trow')) row.classList.toggle('selected', row.firstChild.textContent === key);
  const box = byId('rv-value');
  box.textContent = 'Loading...';
  try {
    const v = await window.envhub.redisValue(name, { db: redisView.db, key, service: redisView.service });
    if (redisView.name !== name || redisView.selected !== key) return;
    box.textContent = '';
    const head = makeElement('div', 'value-head');
    const title = makeElement('h3', 'mono');
    title.textContent = v.key;
    const meta = makeElement('div', 'value-meta');
    const tag = makeElement('span', `type-tag type-${v.type}`);
    tag.textContent = v.type;
    const ttl = makeElement('span', 'muted small');
    ttl.textContent = `TTL ${ttlText(v.ttl)}`;
    meta.append(tag, ttl);
    if (v.size !== null) {
      const size = makeElement('span', 'muted small');
      size.textContent = `${v.size} item${v.size === 1 ? '' : 's'}${v.size > 200 ? ' (first 200 shown)' : ''}`;
      meta.appendChild(size);
    }
    const actions = makeElement('div', 'value-actions');
    const copy = addButton(actions, 'Copy', (event) => copyWithFeedback(typeof v.value === 'string' ? v.value : JSON.stringify(v.value, null, 2), event.currentTarget));
    copy.classList.add('btn-xs');
    const del = addButton(actions, 'Delete key', async () => {
      const ok = await confirmDialog({ title: 'Delete this key?', body: `${v.key}\n\nIt is removed from Redis db${redisView.db}. Laravel makes a cache key again when it needs it.`, okLabel: 'Delete key' });
      if (!ok) return;
      try {
        await window.envhub.redisDelete(name, { db: redisView.db, key: v.key, service: redisView.service });
        redisView.selected = '';
        paintRedisEmptyValue();
        refreshRedisView();
      } catch (err) {
        setNote('rv-error', `Could not delete: ${ipcMessage(err)}`, 'error');
      }
    });
    del.classList.add('btn-xs', 'danger-outline');
    head.append(title, meta, actions);
    box.appendChild(head);
    if (v.type === 'hash') box.appendChild(valueTable(['Field', 'Value'], v.value.map((r) => [r.field, prettyValue(r.value)])));
    else if (v.type === 'zset') box.appendChild(valueTable(['Member', 'Score'], v.value.map((r) => [r.member, r.score])));
    else if (v.type === 'list' || v.type === 'set') box.appendChild(valueTable([v.type === 'list' ? '#' : '', 'Value'], v.value.map((item, i) => [v.type === 'list' ? String(i) : '•', prettyValue(item)])));
    else {
      const pre = makeElement('pre', 'mail-text value-text');
      pre.textContent = prettyValue(v.value);
      box.appendChild(pre);
    }
  } catch (err) {
    box.textContent = '';
    setNote('rv-error', ipcMessage(err), 'error');
  }
}

// The .env lines an app needs to use this Redis.
const redisConnect = { info: null, target: 'docker', showPassword: false };

function redisEnvLines(reveal = true) {
  const info = redisConnect.info;
  if (!info) return [];
  if (redisConnect.target === 'host' && !info.hostPort) return [];
  const host = redisConnect.target === 'host' ? '127.0.0.1' : info.service;
  const port = redisConnect.target === 'host' ? info.hostPort : 6379;
  const password = info.password ? (reveal ? info.password : '••••••••••••') : 'null';
  const lines = ['REDIS_CLIENT=phpredis', `REDIS_HOST=${host}`, `REDIS_PASSWORD=${password}`, `REDIS_PORT=${port}`];
  if (byId('rv-connect-laravel').checked) {
    // Laravel 11+ reads CACHE_STORE, older versions CACHE_DRIVER: both are given, the other one is ignored.
    lines.push('CACHE_STORE=redis', 'CACHE_DRIVER=redis', 'SESSION_DRIVER=redis', 'QUEUE_CONNECTION=redis');
  }
  return lines;
}

function paintRedisConnect() {
  const info = redisConnect.info;
  for (const b of document.querySelectorAll('[data-redis-target]')) b.setAttribute('aria-pressed', b.dataset.redisTarget === redisConnect.target ? 'true' : 'false');
  setText('rv-connect-sub', info ? `(${info.service}:6379 · ${info.password ? 'with password' : 'no password'})` : '');
  let note = 'Loading...';
  if (info && redisConnect.target === 'docker') {
    note = `For an app that runs in this project (php, node, app). The host is the service name, ${info.service}.`;
  } else if (info && info.hostPort) {
    note = `For an app or a tool (TablePlus, Redis Insight) on this computer. Port ${info.hostPort} is published to this computer.`;
  } else if (info) {
    note = `${info.service} has no port on this computer. Add port 6379 to it in the Settings tab, or use "Inside Docker".`;
  }
  setText('rv-connect-note', note);
  const box = byId('rv-connect-env');
  box.textContent = '';
  const lines = redisEnvLines(redisConnect.showPassword);
  for (const line of lines) {
    const row = makeElement('div', '');
    const at = line.indexOf('=');
    const key = makeElement('span', 'env-key');
    key.textContent = line.slice(0, at);
    const eq = makeElement('span', 'env-eq');
    eq.textContent = '=';
    const value = makeElement('span', 'env-val');
    value.textContent = line.slice(at + 1);
    if (line.startsWith('REDIS_PASSWORD=') && info && info.password && redisConnect.showPassword) value.classList.add('env-secret');
    row.append(key, eq, value);
    box.appendChild(row);
  }
  box.hidden = lines.length === 0;
  byId('rv-connect-copy').disabled = lines.length === 0;
  const show = byId('rv-connect-show');
  show.hidden = !(info && info.password);
  show.textContent = redisConnect.showPassword ? 'Hide password' : 'Show password';
}

async function loadRedisInfo(name) {
  redisConnect.info = null;
  redisConnect.showPassword = false;
  paintRedisConnect();
  try {
    const info = await window.envhub.redisInfo(name, redisView.service);
    if (redisView.name === name) {
      redisConnect.info = info;
      paintRedisConnect();
    }
  } catch (err) {
    setNote('rv-error', ipcMessage(err), 'error');
  }
}

async function showRedis(name, service) {
  if (redisView.name !== name || redisView.service !== service) {
    Object.assign(redisView, { name, service, db: 0, pattern: '*', keys: [], selected: '', dbs: {} });
    byId('rv-pattern').value = '';
    paintRedisDbs();
    paintRedisEmptyValue();
  }
  // The key-value viewer sits inside the Data tab.
  byId('dv-body').appendChild(el.redisViewCard);
  el.redisViewCard.hidden = false;
  loadRedisInfo(name);
  await refreshRedisView();
}

function bindDataTabs() {
  byId('mv-search').addEventListener('input', (event) => {
    clearTimeout(mailView.searchTimer);
    mailView.searchTimer = setTimeout(() => {
      mailView.query = event.target.value.trim();
      refreshMailView();
    }, 350);
  });
  byId('mv-refresh').addEventListener('click', refreshMailView);
  for (const b of document.querySelectorAll('[data-mail-target]')) {
    b.addEventListener('click', () => {
      mailConnect.target = b.dataset.mailTarget;
      paintMailConnect();
    });
  }
  byId('mv-connect-copy').addEventListener('click', (event) => copyWithFeedback(mailEnvLines(), event.currentTarget));
  byId('mv-open').addEventListener('click', () => {
    const project = projectsView.list.find((p) => p.name === mailView.name);
    openService(mailView.name, mailView.service || (project && project.mailService) || 'mailpit', 'Mailpit');
  });
  byId('mv-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Delete all mails?', body: 'Every mail Mailpit caught for this project is removed.', okLabel: 'Delete all' });
    if (!ok) return;
    try {
      await window.envhub.mailDelete(mailView.name, 'all', mailView.service);
      mailView.selected = '';
      paintMailEmptyDetail();
      refreshMailView();
    } catch (err) {
      setNote('mv-error', `Could not delete: ${ipcMessage(err)}`, 'error');
    }
  });
  byId('rv-db').addEventListener('change', (event) => {
    redisView.db = Number(event.target.value);
    redisView.selected = '';
    paintRedisEmptyValue();
    refreshRedisView();
  });
  byId('rv-pattern').addEventListener('input', (event) => {
    clearTimeout(redisView.searchTimer);
    redisView.searchTimer = setTimeout(() => {
      redisView.pattern = event.target.value.trim() || '*';
      refreshRedisView();
    }, 350);
  });
  byId('rv-refresh').addEventListener('click', refreshRedisView);
  for (const b of document.querySelectorAll('[data-redis-target]')) {
    b.addEventListener('click', () => {
      redisConnect.target = b.dataset.redisTarget;
      paintRedisConnect();
    });
  }
  byId('rv-connect-laravel').addEventListener('change', paintRedisConnect);
  byId('rv-connect-show').addEventListener('click', () => {
    redisConnect.showPassword = !redisConnect.showPassword;
    paintRedisConnect();
  });
  byId('rv-connect-copy').addEventListener('click', (event) => copyWithFeedback(redisEnvLines(true).join('\n'), event.currentTarget));
  byId('rv-flush').addEventListener('click', async () => {
    const db = redisView.db;
    const ok = await confirmDialog({ title: `Flush db${db}?`, body: `Every key in Redis db${db} of ${redisView.name} is removed (cache, sessions or queues, whatever this database holds). Other databases stay.`, okLabel: `Flush db${db}` });
    if (!ok) return;
    try {
      await window.envhub.redisFlush(redisView.name, { db, service: redisView.service });
      redisView.selected = '';
      paintRedisEmptyValue();
      refreshRedisView();
    } catch (err) {
      setNote('rv-error', `Could not flush: ${ipcMessage(err)}`, 'error');
    }
  });
}

// ---------- Notifications: the bell in the top bar and the Notifications page ----------

// Every action message (started, stopped, errors) and the container events Docker reports, newest first.
// Kept in localStorage, so they are still there after a restart. Busy messages ("Starting...") are not kept.
const NOTIF_MAX = 200;
const NOTIF_GROUP_MS = 5000;
const notifView = { items: [], filter: 'all', query: '', loaded: false };
const notifKey = () => `${NAME_PREFIX}.notifications`;

function loadNotifications() {
  if (notifView.loaded) return;
  notifView.loaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(notifKey()) || '[]');
    if (Array.isArray(saved)) {
      notifView.items = saved.filter((n) => n && typeof n.text === 'string' && typeof n.at === 'number').slice(0, NOTIF_MAX);
    }
  } catch (err) {
    notifView.items = [];
  }
}

function saveNotifications() {
  try {
    localStorage.setItem(notifKey(), JSON.stringify(notifView.items.slice(0, NOTIF_MAX)));
  } catch (err) {
    // Storage full or blocked: they stay for this session.
  }
}

function addNotification({ project = '', text, kind = 'info', source = 'app' }) {
  if (!text) return;
  loadNotifications();
  const now = Date.now();
  const last = notifView.items[0];
  // The same message twice in a row (a retry, a second click) is one notification.
  if (last && last.text === text && last.project === project && now - last.at < 3000) return;
  notifView.items.unshift({ id: `${now}-${Math.random().toString(36).slice(2, 7)}`, at: now, project, text, kind, source, read: false });
  if (notifView.items.length > NOTIF_MAX) notifView.items.length = NOTIF_MAX;
  saveNotifications();
  paintNotifications();
}

// Docker events: "start" of nginx, php and mysql a moment apart is one line "nginx, php, mysql started".
// A container that stops is reported by Docker as kill, die and stop; only "stop" is kept, and "die" alone
// (a container that exited by itself, for example after an error) becomes a warning.
const DOCKER_EVENT_WORDS = { start: 'started', stop: 'stopped', restart: 'restarted', destroy: 'removed', die: 'exited' };
const pendingDies = new Map();

// A container that dies 3 times within 2 minutes is in a restart loop: one error notification, not a warning each time.
const RESTART_LOOP_COUNT = 3;
const RESTART_LOOP_MS = 2 * 60 * 1000;
const recentDies = new Map();
const loopReported = new Map();

function watchRestartLoop(change, who) {
  const key = change.name || `${change.project}/${who}`;
  const now = Date.now();
  const times = (recentDies.get(key) || []).filter((t) => now - t < RESTART_LOOP_MS);
  times.push(now);
  recentDies.set(key, times);
  if (times.length < RESTART_LOOP_COUNT) return false;
  // Once per 10 minutes for the same container.
  if (now - (loopReported.get(key) || 0) < 10 * 60 * 1000) return true;
  loopReported.set(key, now);
  const code = Number.isInteger(change.exitCode) ? ` (exit code ${change.exitCode})` : '';
  addNotification({ project: change.project, text: `${who} keeps restarting${code}. Open the project and click "Why?" next to it.`, kind: 'error', source: 'docker' });
  return true;
}

function notifyDockerEvent(change) {
  if (!change || !change.project) return;
  const action = change.action;
  const who = change.service || change.name || 'container';
  if (action === 'unhealthy') {
    addNotification({ project: change.project, text: `${who} is unhealthy: its health check fails. Click "Why?" next to it to see the check output.`, kind: 'warn', source: 'docker' });
    return;
  }
  if (action === 'healthy') return;
  // A restart loop gives one error instead of "exited" and "started" again and again.
  if (action === 'die' && watchRestartLoop(change, who)) return;
  if (action === 'start' && (recentDies.get(change.name || `${change.project}/${who}`) || []).filter((t) => Date.now() - t < RESTART_LOOP_MS).length >= RESTART_LOOP_COUNT) return;
  if (action === 'die') {
    const key = change.name || who;
    clearTimeout(pendingDies.get(key));
    pendingDies.set(key, setTimeout(() => {
      pendingDies.delete(key);
      groupDockerEvent(change.project, who, 'die');
    }, 2500));
    return;
  }
  if (action === 'stop' || action === 'destroy') {
    const key = change.name || who;
    clearTimeout(pendingDies.get(key));
    pendingDies.delete(key);
  }
  if (!DOCKER_EVENT_WORDS[action]) return;
  groupDockerEvent(change.project, who, action);
}

function groupDockerEvent(project, who, action) {
  loadNotifications();
  const now = Date.now();
  const kind = action === 'die' ? 'warn' : 'info';
  const recent = notifView.items.find((n) => n.source === 'docker' && n.project === project && n.action === action && now - n.at < NOTIF_GROUP_MS);
  if (recent) {
    if (!recent.services.includes(who)) recent.services.push(who);
    recent.text = `${recent.services.join(', ')} ${DOCKER_EVENT_WORDS[action]}`;
    recent.at = now;
    recent.read = false;
    // Keep it at the top.
    notifView.items = [recent, ...notifView.items.filter((n) => n !== recent)];
  } else {
    notifView.items.unshift({
      id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
      at: now,
      project,
      text: `${who} ${DOCKER_EVENT_WORDS[action]}`,
      kind,
      source: 'docker',
      action,
      services: [who],
      read: false,
    });
    if (notifView.items.length > NOTIF_MAX) notifView.items.length = NOTIF_MAX;
  }
  saveNotifications();
  paintNotifications();
}

function unreadCount() {
  return notifView.items.filter((n) => !n.read).length;
}

function markAllRead() {
  let changed = false;
  for (const n of notifView.items) {
    if (!n.read) {
      n.read = true;
      changed = true;
    }
  }
  if (changed) {
    saveNotifications();
    paintNotifications();
  }
}

function notifTimeText(at) {
  const minutes = (Date.now() - at) / 60000;
  return agoText(minutes, true);
}

const NOTIF_ICONS = {
  ok: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6M12 17h.01"></path></svg>',
  warn: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6M12 17h.01"></path></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"></path><path d="M3 8l9 5 9-5M12 13v8"></path></svg>',
};

// One notification line. Fixed SVG markup from this file only, so innerHTML is safe here.
function notifRow(n, { full = false } = {}) {
  const li = makeElement('li', `notif ${n.read ? '' : 'unread'}`.trim());
  li.dataset.kind = n.kind;
  const mark = makeElement('span', 'notif-mark');
  mark.innerHTML = NOTIF_ICONS[n.kind] || NOTIF_ICONS.info;
  const body = makeElement('div', 'notif-body');
  const text = makeElement('span', 'notif-text');
  text.textContent = n.text;
  const meta = makeElement('span', 'notif-meta');
  if (n.project) {
    const link = makeElement('button', 'notif-project');
    link.type = 'button';
    link.textContent = n.project;
    link.title = `Open ${n.project}`;
    link.addEventListener('click', (event) => {
      event.stopPropagation();
      closeBellPanel();
      if (projectsView.list.some((p) => p.name === n.project)) openDetail(n.project);
    });
    meta.appendChild(link);
  }
  const source = makeElement('span', '');
  source.textContent = n.source === 'docker' ? 'Docker' : 'ProjectDockHub';
  const time = makeElement('time', '');
  time.textContent = notifTimeText(n.at);
  time.title = new Date(n.at).toLocaleString();
  meta.append(source, time);
  body.append(text, meta);
  li.append(mark, body);
  if (full) {
    const remove = rowIconButton(ROW_ICONS.trash, 'Remove this notification', () => {
      notifView.items = notifView.items.filter((x) => x.id !== n.id);
      saveNotifications();
      paintNotifications();
    }, 'sm danger-hover');
    li.appendChild(remove);
  }
  li.addEventListener('click', () => {
    if (!n.read) {
      n.read = true;
      saveNotifications();
      paintNotifications();
    }
  });
  return li;
}

function dayLabel(at) {
  const d = new Date(at);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function filteredNotifications() {
  const needle = notifView.query.trim().toLowerCase();
  return notifView.items.filter((n) => {
    if (notifView.filter === 'unread' && n.read) return false;
    if (notifView.filter === 'error' && n.kind !== 'error' && n.kind !== 'warn') return false;
    if (notifView.filter === 'docker' && n.source !== 'docker') return false;
    if (needle && !`${n.project} ${n.text}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

function paintNotifications() {
  loadNotifications();
  const unread = unreadCount();
  const badge = byId('bell-badge');
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? '99+' : String(unread);
  byId('tb-bell').setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');

  // The bell panel: the newest 8.
  const small = byId('bell-list');
  small.textContent = '';
  for (const n of notifView.items.slice(0, 8)) small.appendChild(notifRow(n));
  if (!notifView.items.length) {
    const empty = makeElement('li', 'notif-empty');
    empty.textContent = 'No notifications yet. Starting, stopping and errors show here.';
    small.appendChild(empty);
  }
  byId('bell-read-all').disabled = unread === 0;

  // The full page, grouped by day.
  const list = byId('notif-list');
  list.textContent = '';
  const shown = filteredNotifications();
  let day = '';
  for (const n of shown) {
    const label = dayLabel(n.at);
    if (label !== day) {
      day = label;
      const head = makeElement('li', 'notif-day');
      head.textContent = label;
      list.appendChild(head);
    }
    list.appendChild(notifRow(n, { full: true }));
  }
  if (!shown.length) {
    const empty = makeElement('li', 'notif-empty');
    empty.textContent = notifView.items.length ? 'Nothing matches this filter or search.' : 'No notifications yet. Starting, stopping and errors show here.';
    list.appendChild(empty);
  }
  setText('notif-foot', `${notifView.items.length} notification${notifView.items.length === 1 ? '' : 's'} · ${unread} unread`);
  byId('notif-read-all').disabled = unread === 0;
  byId('notif-clear').disabled = notifView.items.length === 0;
}

function openBellPanel() {
  paintNotifications();
  byId('bell-panel').hidden = false;
  byId('tb-bell').setAttribute('aria-expanded', 'true');
}

// Closing the panel marks what was shown as read.
function closeBellPanel() {
  const panel = byId('bell-panel');
  if (panel.hidden) return;
  panel.hidden = true;
  byId('tb-bell').setAttribute('aria-expanded', 'false');
  markAllRead();
}

function bindNotifications() {
  loadNotifications();
  byId('tb-bell').addEventListener('click', (event) => {
    event.stopPropagation();
    if (byId('bell-panel').hidden) openBellPanel();
    else closeBellPanel();
  });
  byId('bell-panel').addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeBellPanel);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeBellPanel();
  });
  byId('bell-read-all').addEventListener('click', markAllRead);
  byId('bell-see-all').addEventListener('click', () => {
    closeBellPanel();
    showView('notifications');
    window.scrollTo({ top: 0 });
  });
  byId('notif-read-all').addEventListener('click', markAllRead);
  byId('notif-clear').addEventListener('click', async () => {
    const ok = await confirmDialog({ title: 'Clear all notifications?', body: 'The list is emptied. Your projects and containers are not changed.', okLabel: 'Clear all' });
    if (!ok) return;
    notifView.items = [];
    saveNotifications();
    paintNotifications();
  });
  byId('notif-search').addEventListener('input', (event) => {
    notifView.query = event.target.value;
    paintNotifications();
  });
  for (const button of document.querySelectorAll('[data-notif-filter]')) {
    button.addEventListener('click', () => {
      notifView.filter = button.dataset.notifFilter;
      for (const other of document.querySelectorAll('[data-notif-filter]')) other.setAttribute('aria-pressed', other === button ? 'true' : 'false');
      paintNotifications();
    });
  }
  // "5m ago" moves on by itself.
  setInterval(() => {
    if (!byId('bell-panel').hidden || document.body.dataset.view === 'notifications') paintNotifications();
  }, 60000);
  paintNotifications();
}

// ---------- Containers ----------

// Every ProjectDockHub container in one table, grouped under its project, with bulk Stop and Delete.
const containersView = { items: [], query: '', onlyRunning: false, selected: new Set(), collapsed: new Set() };

function containerKey(c) {
  return `${c.project || ''}::${c.service || c.name}`;
}

function containerPorts(c) {
  const project = projectsView.list.find((p) => p.name === c.project);
  return project ? project.ports.filter((p) => p.service === c.service).map((port) => ({ project, port })) : [];
}

function setContainerMessage(text, kind = 'error') {
  setNote('container-message', text, kind);
}

async function containerAction(c, action) {
  if (!c.project || !c.service) return;
  const call = { stop: 'stopService', start: 'startService', remove: 'removeService' }[action];
  try {
    const res = await window.envhub[call](c.project, c.service);
    if (res && res.ok === false) setContainerMessage(res.stderr || `Could not ${action} ${c.name}.`);
    else setContainerMessage('');
  } catch (err) {
    setContainerMessage(`Could not ${action} ${c.name}: ${ipcMessage(err)}`);
  }
}

function containerGroupRow(name, items) {
  const up = items.filter((c) => c.state === 'running').length;
  const collapsed = containersView.collapsed.has(name);
  const row = makeElement('tr', 'group-row');
  const checkCell = td('col-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.setAttribute('aria-label', `Select ${name}`);
  check.checked = items.length > 0 && items.every((c) => containersView.selected.has(containerKey(c)));
  check.addEventListener('change', () => {
    for (const c of items) {
      if (check.checked) containersView.selected.add(containerKey(c));
      else containersView.selected.delete(containerKey(c));
    }
    renderContainers();
  });
  checkCell.appendChild(check);
  const cell = td();
  cell.colSpan = 6;
  const wrap = makeElement('div', 'group-head');
  const chevron = rowIconButton(collapsed ? ROW_ICONS.chevronRight : ROW_ICONS.chevronDown, `${collapsed ? 'Expand' : 'Collapse'} ${name}`, () => {
    if (containersView.collapsed.has(name)) containersView.collapsed.delete(name);
    else containersView.collapsed.add(name);
    renderContainers();
  }, 'chev');
  const icon = makeElement('span', 'stack-ico sm');
  icon.innerHTML = ROW_ICONS.stack;
  const link = makeElement('button', 'name-link strong');
  link.type = 'button';
  link.textContent = name;
  link.addEventListener('click', () => {
    if (projectsView.list.some((p) => p.name === name)) openDetail(name);
  });
  const meta = makeElement('span', 'muted small');
  meta.textContent = `Compose project · ${items.length} container${items.length === 1 ? '' : 's'}`;
  const state = up === items.length ? 'running' : up ? 'partly' : 'stopped';
  const word = up === items.length ? 'Running' : up ? 'Partly running' : 'Stopped';
  const status = statusCell(state, `${word} (${up}/${items.length})`, true);
  status.classList.add('small');
  wrap.append(chevron, icon, link, meta, status);
  cell.appendChild(wrap);
  row.append(checkCell, cell);
  return row;
}

function containerTableRow(c) {
  const up = c.state === 'running';
  const key = containerKey(c);
  const row = makeElement('tr', 'trow');
  row.classList.toggle('selected', containersView.selected.has(key));
  const checkCell = td('col-check');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = containersView.selected.has(key);
  check.setAttribute('aria-label', `Select ${c.name}`);
  check.addEventListener('change', () => {
    if (check.checked) containersView.selected.add(key);
    else containersView.selected.delete(key);
    renderContainers();
  });
  checkCell.appendChild(check);

  const name = td('c-indent');
  const wrap = makeElement('div', 'c-two');
  const boxIcon = makeElement('span', 'c-box');
  boxIcon.innerHTML = ROW_ICONS.box;
  const text = makeElement('div', 'c-two-text');
  const svc = makeElement('span', 'c-svc');
  svc.textContent = c.service || c.name;
  const full = makeElement('span', 'c-full mono');
  full.textContent = c.name;
  text.append(svc, full);
  wrap.append(boxIcon, text);
  name.appendChild(wrap);

  const image = td('mono c-image link-ish');
  image.textContent = c.image;
  const status = td();
  status.appendChild(containerStatusCell(c, c.project));
  const ports = td('c-ports');
  const own = containerPorts(c);
  if (own.length) for (const { project, port } of own) ports.appendChild(openPortLink(project, port));
  else {
    ports.textContent = '—';
    ports.classList.add('muted');
  }
  const uptime = td('fg2');
  uptime.textContent = c.status || '';

  const actionsCell = td('col-actions');
  const actions = makeElement('div', 'row-icons');
  if (c.project && c.service) {
    actions.appendChild(rowIconButton(up ? ROW_ICONS.stop : ROW_ICONS.play, `${up ? 'Stop' : 'Start'} ${c.name}`, async () => {
      await containerAction(c, up ? 'stop' : 'start');
      refreshContainers();
    }, 'sm'));
    actions.appendChild(rowIconButton(ROW_ICONS.logs, `View logs for ${c.name}`, () => {
      if (projectsView.list.some((p) => p.name === c.project)) openDetailTab(c.project, 'logs');
    }, 'sm'));
    const shell = rowIconButton(ROW_ICONS.terminal, `Open shell in ${c.name}`, () => openShell(c.project, c.service), 'sm');
    shell.disabled = !up;
    actions.appendChild(shell);
    actions.appendChild(rowIconButton(ROW_ICONS.trash, `Delete ${c.name}`, () => deleteContainers([c]), 'sm danger-hover'));
  }
  actionsCell.appendChild(actions);
  row.append(checkCell, name, image, status, ports, uptime, actionsCell);
  return row;
}

// Deletes containers only (docker rm -f). Named data volumes stay, and starting the project makes them again.
async function deleteContainers(list) {
  if (!list.length) return;
  const names = list.map((c) => c.name).join(', ');
  const ok = await confirmDialog({
    title: list.length === 1 ? 'Delete container?' : `Delete ${list.length} containers?`,
    body: `${names}\n\nOnly the container is removed. Database data in named volumes stays. Start the project to create the container again.`,
    okLabel: list.length === 1 ? 'Delete container' : 'Delete containers',
  });
  if (!ok) return;
  for (const c of list) await containerAction(c, 'remove');
  for (const c of list) containersView.selected.delete(containerKey(c));
  refreshContainers();
  loadProjects();
}

function selectedContainers() {
  return containersView.items.filter((c) => containersView.selected.has(containerKey(c)));
}

function renderContainers() {
  const items = containersView.items;
  const running = items.filter((c) => c.state === 'running').length;
  setText('cs-total', String(items.length));
  setText('cs-running', String(running));
  setText('cs-exited', String(items.length - running));
  setText('nav-ccount', String(items.length));

  const needle = containersView.query.trim().toLowerCase();
  const shown = items.filter((c) => {
    if (containersView.onlyRunning && c.state !== 'running') return false;
    if (!needle) return true;
    const ports = containerPorts(c).map(({ port }) => `${port.host}:${port.container}`).join(' ');
    return `${c.name} ${c.image} ${c.project || ''} ${c.service || ''} ${ports}`.toLowerCase().includes(needle);
  });

  const groups = new Map();
  for (const c of shown) {
    const key = c.project || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  const body = el.containerList;
  body.textContent = '';
  if (!shown.length) {
    const empty = makeElement('p', 'muted');
    empty.textContent = items.length
      ? 'No container matches this search.'
      : containersView.error ? 'Could not read the containers from Docker.' : 'No ProjectDockHub containers yet. Start a project to create them.';
    body.appendChild(emptyTableRow(empty));
  }
  for (const [name, list] of groups) {
    body.appendChild(containerGroupRow(name, list));
    if (!containersView.collapsed.has(name)) for (const c of list) body.appendChild(containerTableRow(c));
  }

  const picked = selectedContainers();
  byId('stop-selected').disabled = !picked.some((c) => c.state === 'running');
  byId('delete-selected').disabled = picked.length === 0;
  byId('select-all-containers').checked = items.length > 0 && picked.length === items.length;
  setText('container-foot', `Showing ${shown.length} item${shown.length === 1 ? '' : 's'}`);
}

async function refreshContainers() {
  try {
    containersView.items = await window.envhub.listContainers();
    containersView.error = '';
    setContainerMessage('');
  } catch (err) {
    containersView.items = [];
    containersView.error = dockerErrorText(err);
    setContainerMessage(`Could not load containers. ${containersView.error}`);
  }
  // Drop selections of containers that are gone.
  const keys = new Set(containersView.items.map(containerKey));
  for (const key of [...containersView.selected]) if (!keys.has(key)) containersView.selected.delete(key);
  renderContainers();
}

function bindContainersPage() {
  byId('container-search').addEventListener('input', (event) => {
    containersView.query = event.target.value;
    renderContainers();
  });
  byId('only-running-containers').addEventListener('change', (event) => {
    containersView.onlyRunning = event.target.checked;
    renderContainers();
  });
  byId('select-all-containers').addEventListener('change', (event) => {
    containersView.selected.clear();
    if (event.target.checked) for (const c of containersView.items) containersView.selected.add(containerKey(c));
    renderContainers();
  });
  byId('stop-selected').addEventListener('click', async () => {
    for (const c of selectedContainers()) if (c.state === 'running') await containerAction(c, 'stop');
    containersView.selected.clear();
    refreshContainers();
    loadProjects();
  });
  byId('delete-selected').addEventListener('click', () => deleteContainers(selectedContainers()));
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
  el.dockerMark = byId('docker-mark');
  el.dockerArt = byId('docker-art');
  el.detail = byId('docker-detail');
  el.guidance = byId('docker-guidance');
  el.button = byId('check-again');
  el.dockerStart = byId('docker-start');
  el.dockerDownload = byId('docker-download');

  el.stageItems = [...document.querySelectorAll('#stages li')];
  el.stageName = byId('stage-name');
  el.stageSetup = byId('stage-setup');
  el.stageCreate = byId('stage-create');
  el.newName = byId('new-name');
  el.credCard = byId('cred-card');
  el.volumesCard = byId('volumes-card');
  el.volumesBody = byId('volumes-body');
  el.volumesTitle = byId('volumes-title');
  el.credBody = byId('cred-body');
  el.credTitle = byId('cred-title');
  el.projectsDirRow = byId('projects-dir-row');
  el.projectsDirNote = byId('projects-dir-note');
  el.projectsDir = byId('projects-dir');
  el.resetProjectsDir = byId('reset-projects-dir');
  el.keepPackagesRow = byId('keep-packages-row');
  el.keepPackages = byId('keep-packages');
  el.keepPackagesText = byId('keep-packages-text');
  el.editKeepPackagesText = byId('edit-keep-packages-text');
  el.editPython = byId('edit-python');
  el.editVendorRow = byId('edit-vendor-row');
  el.editSlowTip = byId('edit-slow-tip');
  el.editComposerHelp = byId('edit-composer-help');
  el.editVendorVolume = byId('edit-vendor-volume');
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
  el.editPhp = byId('edit-php');
  el.editPhpExt = byId('edit-php-ext');
  el.editPhpNote = byId('edit-php-note');
  el.editRebuild = byId('edit-rebuild');
  el.editPhpIni = byId('edit-php-ini');
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
  el.logViewCard = byId('logview-card');
  el.mailViewCard = byId('mailview-card');
  el.dataViewCard = byId('dataview-card');
  el.reqViewCard = byId('reqview-card');
  el.redisViewCard = byId('redisview-card');
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
  el.dockerStart.addEventListener('click', startDocker);
  byId('df-generate').addEventListener('click', generateDockerFilesNow);
  byId('df-open-folder').addEventListener('click', () => {
    const name = byId('edit-docker-files').dataset.project;
    if (name) runProjectAction('Folder', 'openFolder', name);
  });
  el.dockerDownload.addEventListener('click', async () => {
    try {
      await window.envhub.downloadDocker();
      showGuidance([
        'The download page is open in your browser. Install Docker Desktop, open it and wait until it says it is running.',
        'On Windows, if it asks to turn on WSL 2, accept it and restart the computer when asked.',
        'Then come back here and click Check again.',
      ]);
    } catch (err) {
      showGuidance(['Could not open the browser. Download Docker Desktop from https://www.docker.com/products/docker-desktop/']);
    }
  });
  el.stageName.addEventListener('submit', submitName);
  for (const radio of document.querySelectorAll('input[name="project-source"]')) radio.addEventListener('change', syncSourceForm);
  byId('pick-folder').addEventListener('click', pickFolder);
  byId('change-projects-dir').addEventListener('click', () => changeProjectsDir(false));
  el.resetProjectsDir.addEventListener('click', () => changeProjectsDir(true));
  byId('settings-stop-docker').addEventListener('change', changeStopDockerOnExit);
  loadProjectsDir();
  el.stageSetup.addEventListener('submit', submitSetup);
  byId('setup-back').addEventListener('click', () => showStage('name'));
  el.dockerImage.addEventListener('input', syncPythonRow);
  el.dockerTag.addEventListener('change', syncPythonRow);
  el.newStack.addEventListener('change', syncStackForm);
  renderStackCards();
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
  el.editRebuild.addEventListener('click', () => saveEdit(true, true));
  byId('close-start').addEventListener('click', () => { el.startCard.hidden = true; });
  byId('close-logs').addEventListener('click', () => { el.logsCard.hidden = true; });
  byId('cred-close').addEventListener('click', () => { el.credCard.hidden = true; });
  byId('volumes-close').addEventListener('click', () => { el.volumesCard.hidden = true; });
  byId('volumes-refresh').addEventListener('click', () => { if (volumesName) showVolumes(volumesName); });
  byId('logs-refresh').addEventListener('click', () => { if (logsName) showLogs(logsName); });
  byId('logs-copy').addEventListener('click', (event) => copyWithFeedback(el.logsOutput.textContent, event.currentTarget));
  el.writeEnvDocker.addEventListener('click', () => writeEnvToFolder('docker'));
  el.writeEnvHost.addEventListener('click', () => writeEnvToFolder('host'));
  el.copyEnvDocker.addEventListener('click', () => copyEnvFile(el.copyEnvDocker, 'docker', 'Copy .env (Docker)'));
  el.copyEnvHost.addEventListener('click', () => copyEnvFile(el.copyEnvHost, 'host', 'Copy .env (my computer)'));
  byId('refresh-containers').addEventListener('click', refreshContainers);

  window.envhub.onContainersChanged((change) => {
    rememberEvent(change);
    notifyDockerEvent(change);
    // What was cached for that project is old now. The open project is read again by the refresh below.
    if (change && change.project && change.project !== detailState.name && overviewCache.has(change.project)) refreshProjectCache(change.project, 1500);
    scheduleRefreshContainers();
    scheduleLinksRefresh();
    // Keeps the On / Stopped badge right when a container starts or stops outside ProjectDockHub too.
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
    } else if (typeof action === 'string' && action.startsWith('open-project:')) {
      ensureProjectsView();
      openDetail(action.slice('open-project:'.length));
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

  el.versionsFileBtn.addEventListener('click', openVersionsFile);

  // The name prefix first: the saved theme and the Docker names on every page use it.
  let appInfo = null;
  try {
    appInfo = await window.envhub.getAppInfo();
    if (appInfo && appInfo.prefix) NAME_PREFIX = appInfo.prefix;
  } catch (err) {
    // The default prefix is used.
  }
  byId('name-example').textContent = dockerName('shop', 'php');
  bindProjectsPage();
  bindContainersPage();
  bindNotifications();
  bindDataTabs();
  bindWhyModal();
  bindCleanupPage();
  bindRequestsView();
  // Every message bar closes with its x button.
  document.addEventListener('click', (event) => {
    const close = event.target.closest('.note-close');
    if (close) close.closest('.note-line').hidden = true;
  });
  bindLogView();
  await loadRegistry();
  syncStackForm();
  showStage('name');

  try {
    const info = appInfo || (await window.envhub.getAppInfo());
    el.appInfo.textContent = `${info.name} ${info.version}`;
    setText('brand-ver', `v${info.version}`);
    setText('sb-app', `${info.name} ${info.version}`);
    setText('settings-about-name', `${info.name} ${info.version}`);
    byId('settings-about').textContent = 'Everything runs in Docker on this computer.';
  } catch (err) {
    el.appInfo.textContent = '';
  }

  loadProjectsDir();
  checkDocker();
  // Docker can be closed and opened while ProjectDockHub runs, so the card keeps looking: every few seconds while the
  // window is visible, when the window gets the focus, and when the main process says the Docker stream ended.
  setInterval(() => {
    if (document.visibilityState === 'visible') quietCheckDocker();
  }, DOCKER_RECHECK_MS);
  window.addEventListener('focus', quietCheckDocker);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') quietCheckDocker();
  });
  window.envhub.onDockerState(() => quietCheckDocker());
  renderProjectsLoading();
  loadProjects();
  refreshContainers();
});

document.querySelectorAll('#winbar [data-menu]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const r = btn.getBoundingClientRect();
    window.envhub.windowMenu(btn.dataset.menu, r.left, r.bottom);
  });
});
document.querySelectorAll('#winbar [data-win]').forEach((btn) => {
  btn.addEventListener('click', () => window.envhub.windowControl(btn.dataset.win));
});
