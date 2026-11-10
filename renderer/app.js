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

// The Docker icon is blue when Docker runs, amber when it does not, grey while it is being checked.
function paintDockerMark() {
  el.dockerMark.dataset.state = el.title.textContent === 'Docker is running' ? 'ok' : 'bad';
  // The picture of the sleeping whale shows only when Docker is not running.
  el.dockerArt.hidden = el.dockerMark.dataset.state !== 'bad';
}

async function checkDocker() {
  el.button.disabled = true;
  el.dockerMark.dataset.state = 'checking';
  el.dockerArt.hidden = true;
  el.title.textContent = 'Checking Docker...';
  el.detail.textContent = '';
  clearGuidance();

  try {
    renderStatus(await window.envhub.checkDocker());
    paintDockerMark();
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
  for (const card of document.querySelectorAll('.pcard')) {
    if (card.dataset.project !== name) continue;
    let box = card.querySelector('.note-box');
    if (!notes.has(name)) {
      if (box) box.remove();
      continue;
    }
    if (!box) {
      box = makeElement('div', 'note-box');
      box.setAttribute('role', 'status');
      card.insertBefore(box, card.querySelector('.pcard-foot'));
    }
    paintNote(box, name);
  }
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
    if (kind !== 'error' && kind !== 'busy') noteTimers.set(name, setTimeout(() => clearNote(name), NOTE_MS));
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
async function runProjectAction(label, method, name, texts = {}) {
  setActionStatus(texts.busy || `${label} ${name}...`, name, 'busy');
  try {
    const res = await window.envhub[method](name);
    const failed = res && res.ok === false;
    setActionStatus(texts.done && !failed ? texts.done : describeResult(label, name, res), name);
  } catch (err) {
    setActionStatus(`${label} failed: ${ipcMessage(err)}`, name, 'error');
  }
  await loadProjects();
  scheduleRefreshContainers();
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

async function showLogs(name) {
  logsName = name;
  showPanel(`Logs: ${name}`, 'Loading...');
  try {
    const text = await window.envhub.projectLogs(name);
    el.logsOutput.textContent = text.trim() ? text : 'No logs yet.';
    el.logsOutput.scrollTop = el.logsOutput.scrollHeight;
  } catch (err) {
    el.logsOutput.textContent = `Could not load logs: ${err.message}`;
  }
}

// ---------- Small icons and copy buttons ----------

// Fixed SVG markup from this file only (never text from a project), so innerHTML is safe here.
const ICONS = {
  play: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"></path></svg>',
  external: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a2 2 0 0 1 2-2h9"></path></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"></path></svg>',
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
function codeRow(label, text) {
  const row = makeElement('div', 'code-row');
  const key = makeElement('span', 'code-label');
  key.textContent = label;
  const box = makeElement('div', 'code-box');
  const code = makeElement('code', '');
  code.textContent = text;
  box.append(code, iconButton('copy', `Copy ${label.toLowerCase()}`, (event) => copyWithFeedback(text, event.currentTarget)));
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
  ['docker', 'App runs in Docker', 'The host is the service name (for example DB_HOST=mysql). Use these in the project .env. Do not use them in a database tool.'],
  ['host', 'App runs on this computer', 'The host is localhost and the port is the one Docker published. For an app you start outside Docker.'],
];

function renderCredentials(name, data) {
  const body = el.credBody;
  body.textContent = '';
  const status = makeElement('p', 'muted small cred-status');
  status.setAttribute('aria-live', 'polite');

  // .env, for the app
  if (data.env.docker.trim() || data.env.host.trim()) {
    const section = credSection('.env file', 'Paste these lines into the .env of your app, or let envhub write them into the project folder (an old .env is backed up first).');
    let target = 'docker';
    const seg = makeElement('div', 'seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Where the app runs');
    const explain = makeElement('p', 'muted small cred-explain');
    const code = makeElement('pre', 'code-block');
    const choices = ENV_TARGETS.map(([value, label]) => {
      const button = addButton(seg, label, () => pick(value));
      button.dataset.value = value;
      return button;
    });
    function pick(value) {
      target = value;
      for (const button of choices) button.setAttribute('aria-pressed', button.dataset.value === value ? 'true' : 'false');
      explain.textContent = ENV_TARGETS.find((t) => t[0] === value)[2];
      code.textContent = data.env[value].trim() || '# Nothing to add for this project.';
    }
    const actions = makeElement('div', 'row-actions');
    const copyButton = addButton(actions, 'Copy', () => copyWithFeedback(data.env[target], copyButton));
    addButton(actions, 'Write to project folder', async () => {
      try {
        const res = await window.envhub.writeEnv(name, target);
        const word = { created: 'Created', updated: 'Updated', unchanged: 'Already up to date:' }[res.status];
        status.textContent = `${word} ${res.file}${res.backup ? `. The old .env was saved as ${res.backup}` : ''}`;
      } catch (err) {
        status.textContent = `Could not write .env: ${ipcMessage(err)}`;
      }
    });
    const top = makeElement('div', 'cred-env-top');
    top.append(seg, actions);
    section.append(top, explain, code);
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

  // Services the user added by hand
  if (data.extras.length > 0) {
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
  body.appendChild(status);
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

const projectsView = { list: [], filter: 'all', query: '' };

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

function buildProjectCard(project) {
  const state = STATUS_TEXT[project.state] ? project.state : 'stopped';
  const running = state !== 'stopped';
  const mark = STACK_MARKS[project.stack] || { text: project.name.slice(0, 2), color: '#64748B' };

  const card = makeElement('article', 'pcard');
  card.dataset.project = project.name;
  card.style.setProperty('--brand', mark.color);

  const head = makeElement('div', 'pcard-head');
  const badgeMark = makeElement('div', 'pcard-mark');
  badgeMark.setAttribute('aria-hidden', 'true');
  badgeMark.textContent = mark.text;
  const title = makeElement('div', 'pcard-title');
  const heading = makeElement('h3', '');
  const nameButton = makeElement('button', 'link-name');
  nameButton.type = 'button';
  nameButton.textContent = project.name;
  nameButton.title = 'Open the project details';
  nameButton.addEventListener('click', () => openDetail(project.name));
  heading.appendChild(nameButton);
  const stack = makeElement('p', 'pcard-stack');
  stack.textContent = project.label;
  title.append(heading, stack);
  const badge = makeElement('span', `status status-${state}`);
  badge.textContent = `● ${STATUS_TEXT[state]}`;
  head.append(badgeMark, title, badge);

  const body = makeElement('div', 'pcard-body');
  const ports = makeElement('div', 'pcard-ports');
  for (const port of project.ports) {
    const line = makeElement('span', running ? 'live' : 'muted');
    line.textContent = `${port.service}  localhost:${port.host}`;
    ports.appendChild(line);
  }
  if (project.ports.length > 0) {
    body.appendChild(ports);
  } else {
    const note = makeElement('p', 'pcard-note');
    note.textContent = 'No web address yet. Start the project to see one.';
    body.appendChild(note);
  }

  if (project.services.length > 0) {
    const chips = makeElement('div', 'chips');
    for (const service of project.services) {
      const chip = makeElement('span', 'svc-chip');
      chip.textContent = service;
      chips.appendChild(chip);
    }
    body.appendChild(chips);
  }

  const foot = makeElement('div', 'pcard-foot');
  const actions = makeElement('div', 'pcard-actions');
  if (running) {
    const openButton = addButton(actions, 'Open', () => runProjectAction('Open', 'openProject', project.name));
    openButton.classList.add('primary');
    addButton(actions, 'Stop', () => runProjectAction('Stop', 'stopProject', project.name));
  } else {
    const startButton = addButton(actions, 'Start', () => startFromList(project.name));
    startButton.classList.add('primary');
  }

  // Everything else is in a floating menu behind the "..." button, so the card never grows.
  actions.appendChild(moreButton(project));

  foot.appendChild(actions);
  card.append(head, body, foot);
  if (notes.has(project.name)) {
    const box = makeElement('div', 'note-box');
    box.setAttribute('role', 'status');
    card.insertBefore(box, foot);
    paintNote(box, project.name);
  }
  return card;
}

// Counts for the stat tiles, the filter buttons and the sidebar.
function renderProjectCounts(list) {
  const counts = { running: 0, partly: 0, stopped: 0 };
  for (const project of list) {
    const key = counts[project.state] !== undefined ? project.state : 'stopped';
    counts[key] += 1;
  }
  setText('stat-total', String(list.length));
  setText('stat-running', String(counts.running));
  setText('stat-partly', String(counts.partly));
  setText('stat-stopped', String(counts.stopped));
  setText('nav-count', String(list.length));
  setText('filter-all', `All ${list.length}`);
  setText('filter-active', `Active ${counts.running + counts.partly}`);
  setText('filter-stopped', `Stopped ${counts.stopped}`);
}

function renderProjects() {
  const { list, filter, query } = projectsView;
  const needle = query.trim().toLowerCase();
  renderProjectCounts(list);

  const shown = list.filter((project) => {
    if (filter === 'active' && !isActiveProject(project)) return false;
    if (filter === 'stopped' && isActiveProject(project)) return false;
    if (needle && !`${project.name} ${project.label}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  el.projectList.textContent = '';
  if (list.length === 0) {
    const empty = makeElement('div', 'empty empty-hero');
    const art = makeElement('img', 'empty-art');
    art.src = 'assets/empty-projects.png';
    art.alt = '';
    const title = makeElement('strong', '');
    title.textContent = 'No projects yet';
    const text = makeElement('p', 'muted');
    text.textContent = 'Make your first project and everything it needs runs in Docker.';
    const make = addButton(empty, '+ New project', () => el.newProjectBtn.click());
    make.classList.add('primary');
    empty.prepend(art, title, text);
    el.projectList.appendChild(empty);
    return;
  }
  if (shown.length === 0) {
    const empty = makeElement('div', 'empty');
    empty.textContent = 'No project matches this filter or search.';
    el.projectList.appendChild(empty);
    return;
  }
  for (const project of shown) {
    el.projectList.appendChild(buildProjectCard(project));
  }
}

// Placeholder cards and a spinner while the project list is read for the first time.
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
  el.projectList.appendChild(note);
  for (let i = 0; i < 3; i += 1) {
    const card = makeElement('div', 'pcard pcard-skel');
    const head = makeElement('div', 'pcard-head');
    const mark = makeElement('div', 'skeleton skel-mark');
    const title = makeElement('div', 'pcard-title');
    title.append(makeElement('div', 'skeleton skel-short'), makeElement('div', 'skeleton skel-line'));
    head.append(mark, title);
    const body = makeElement('div', 'pcard-body');
    body.appendChild(makeElement('div', 'skeleton skel-line'));
    const foot = makeElement('div', 'pcard-foot');
    foot.appendChild(makeElement('div', 'skeleton skel-row'));
    card.append(head, body, foot);
    el.projectList.appendChild(card);
  }
}

function renderProjectsError(err) {
  el.projectList.textContent = '';
  const box = makeElement('div', 'empty');
  const text = makeElement('p', 'error');
  text.textContent = `Could not load the projects: ${ipcMessage(err)}`;
  const retry = addButton(box, 'Try again', () => {
    renderProjectsLoading();
    loadProjects();
  });
  retry.classList.add('primary');
  box.prepend(text);
  el.projectList.appendChild(box);
}

async function loadProjects() {
  try {
    projectsView.list = await window.envhub.listProjects();
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
  const card = [...document.querySelectorAll('.pcard')].find((c) => c.dataset.project === name);
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
  if (view !== 'detail') stopOverviewRefresh();
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

function readTheme() {
  try {
    const saved = localStorage.getItem('envhub-theme');
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
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', button.dataset.themeChoice === theme ? 'true' : 'false');
  }
  try {
    localStorage.setItem('envhub-theme', theme);
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
  byId('project-search').addEventListener('input', (event) => {
    projectsView.query = event.target.value;
    renderProjects();
  });

  byId('nav-settings').addEventListener('click', () => {
    showView('settings');
    loadProjectsDir();
  });
  for (const button of document.querySelectorAll('[data-theme-choice]')) {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  }
  byId('settings-change-dir').addEventListener('click', () => changeProjectsDir(false));
  byId('settings-reset-dir').addEventListener('click', () => changeProjectsDir(true));
  byId('settings-versions-btn').addEventListener('click', openVersionsFile);

  byId('detail-back').addEventListener('click', backToProjects);
  byId('detail-primary').addEventListener('click', detailPrimary);
  byId('detail-stop').addEventListener('click', () => runProjectAction('Stop', 'stopProject', detailState.name));
  byId('detail-restart').addEventListener('click', () => runProjectAction('Restart', 'restartProject', detailState.name));
  for (const tab of document.querySelectorAll('.tab[data-tab]')) {
    tab.addEventListener('click', () => setDetailTab(tab.dataset.tab));
  }
  byId('detail-url').addEventListener('click', () => runProjectAction('Open', 'openProject', detailState.name));
  byId('detail-lan-url').addEventListener('click', (event) => copyWithFeedback(event.currentTarget.textContent, event.currentTarget));
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
  showLanAddress('');
  showView('detail');
  renderDetail();
  setDetailTab('overview');
  renderOverviewLoading();
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
  const mark = STACK_MARKS[project.stack] || { text: project.name.slice(0, 2), color: '#64748B' };
  const markBox = byId('detail-mark');
  markBox.textContent = mark.text;
  markBox.style.setProperty('--brand', mark.color);
  setText('detail-name', project.name);
  setText('detail-stack', project.label);
  const status = byId('detail-status');
  status.className = `status status-${state}`;
  status.textContent = `● ${STATUS_TEXT[state]}`;
  const url = byId('detail-url');
  url.hidden = project.ports.length === 0;
  url.textContent = project.ports.length ? `http://localhost:${project.ports[0].host}` : '';
  setIconLabel(byId('detail-primary'), running ? 'external' : 'play', running ? 'Open site' : 'Start');
  byId('detail-stop').hidden = !running;
  document.querySelector('.tab[data-tab="settings"]').hidden = !project.editable;
  paintNote(byId('detail-note'), project.name);
}

// ---------- Details: overview data ----------

const overviewState = { name: '', links: null, containers: [], logs: '', details: null, stats: null, disk: null, diskAt: 0 };
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
async function loadOverviewData(name) {
  if (!name) return;
  stopOverviewRefresh();
  const first = overviewState.name !== name;
  const diskDue = first || Date.now() - overviewState.diskAt > DISK_REFRESH_MS;
  const results = await Promise.allSettled([
    window.envhub.projectLinks(name),
    window.envhub.listContainers(name),
    window.envhub.projectLogs(name),
    window.envhub.projectDetails(name),
    window.envhub.projectStats(name),
    diskDue ? window.envhub.projectDisk(name) : Promise.resolve(overviewState.disk),
  ]);
  if (detailState.name !== name || document.body.dataset.view !== 'detail') return;
  const value = (r) => (r.status === 'fulfilled' ? r.value : null);
  overviewState.name = name;
  overviewState.links = value(results[0]);
  overviewState.containers = value(results[1]) || [];
  overviewState.logs = value(results[2]) || '';
  overviewState.details = value(results[3]);
  overviewState.stats = value(results[4]);
  if (diskDue) {
    overviewState.disk = value(results[5]);
    overviewState.diskAt = Date.now();
  }
  const project = projectsView.list.find((p) => p.name === name);
  if (project) renderOverview(project);
  // Keep the CPU and memory numbers moving while the page is open.
  overviewTimer = setTimeout(() => loadOverviewData(name), OVERVIEW_REFRESH_MS);
}

// Opens a terminal window with a shell in one service of the open project.
async function openTerminal(service) {
  try {
    await window.envhub.projectShell(detailState.name, service);
    setActionStatus(`Opened a terminal for ${service}.`, detailState.name);
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
  const main = project && project.ports[0] ? project.ports[0].service : null;
  const mainService = services.find((svc) => svc.name === main && up(svc));
  return mainService ? mainService.name : (services.find(up) || {}).name || null;
}

// Placeholder shown until the first numbers of a project arrive (spinner plus grey bars).
function skeletonCard(rows) {
  const card = makeElement('section', 'ov-card');
  card.appendChild(makeElement('div', 'skeleton skel-short'));
  for (let i = 0; i < rows; i += 1) {
    card.appendChild(makeElement('div', 'skeleton skel-row'));
  }
  return card;
}

function renderOverviewLoading() {
  const stats = byId('detail-stats');
  stats.textContent = '';
  for (let i = 0; i < 4; i += 1) {
    const tile = makeElement('div', 'stat stat-wide');
    tile.append(makeElement('div', 'skeleton skel-short'), makeElement('div', 'skeleton skel-line'));
    stats.appendChild(tile);
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
  const main = makeElement('div', 'ov-col');
  main.append(skeletonCard(4), skeletonCard(2));
  const side = makeElement('div', 'ov-col');
  side.append(skeletonCard(3), skeletonCard(3));
  box.append(note, main, side);
}

function overviewTile(value, label, percent = null) {
  const tile = makeElement('div', 'stat stat-wide');
  const text = makeElement('span', 'stat-text');
  const strong = makeElement('span', 'stat-value');
  strong.textContent = value;
  const caption = makeElement('span', 'stat-label');
  caption.textContent = label;
  text.append(strong, document.createElement('br'), caption);
  tile.appendChild(text);
  if (percent !== null) {
    const track = makeElement('div', 'track stat-bar');
    const fill = makeElement('div', 'fill');
    fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    track.appendChild(fill);
    tile.appendChild(track);
  }
  return tile;
}

function ovCard(title) {
  const card = makeElement('section', 'ov-card');
  const head = makeElement('div', 'ov-head');
  const heading = makeElement('h3', 'ov-title');
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
  byId('detail-lan').hidden = !address;
  byId('detail-lan-url').textContent = address;
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

  const liveStats = fresh && overviewState.stats ? overviewState.stats : null;
  const disk = fresh && overviewState.disk ? overviewState.disk : null;
  const stats = byId('detail-stats');
  stats.textContent = '';
  stats.append(
    overviewTile(liveStats ? `${liveStats.cpuPercent.toFixed(1)}%` : '–', 'CPU', liveStats ? liveStats.cpuPercent : null),
    overviewTile(liveStats ? formatBytes(liveStats.memBytes) : '–', 'Memory', liveStats ? liveStats.memPercent : null),
    overviewTile(disk ? formatBytes(disk.bytes) : '–', disk ? `Disk (${disk.volumes.length} ${disk.volumes.length === 1 ? 'volume' : 'volumes'})` : 'Disk (volumes)'),
    overviewTile(fresh && links ? `${runningNow} / ${services.length}` : '–', 'Containers running'),
  );

  box.textContent = '';
  const main = makeElement('div', 'ov-col');
  const side = makeElement('div', 'ov-col');

  // Services
  const svc = ovCard(links ? `Services · ${runningNow} of ${services.length} running` : 'Services');
  if (!links) {
    const note = makeElement('p', 'pcard-note');
    note.textContent = fresh ? 'Could not read the services. Check that Docker is running.' : 'Loading...';
    svc.card.appendChild(note);
  } else if (services.length === 0) {
    const note = makeElement('p', 'pcard-note');
    note.textContent = 'This project has no containers yet.';
    svc.card.appendChild(note);
  } else {
    for (const item of services) {
      const row = makeElement('div', 'svc-row');
      const badgeMark = makeElement('span', 'svc-mark');
      badgeMark.textContent = item.name.slice(0, 2);
      const info = makeElement('div', 'svc-info');
      const title = makeElement('strong', '');
      title.textContent = item.name;
      const image = makeElement('span', 'svc-image');
      image.textContent = item.image;
      info.append(title, image);
      const port = item.ports[0];
      const portText = makeElement('span', 'svc-port');
      portText.textContent = port ? `:${port.host}` : 'internal';
      const up = serviceRunning(item);
      const pill = makeElement('span', `status status-${up ? 'running' : 'stopped'}`);
      pill.textContent = up ? '● Running' : '● Stopped';
      const actions = makeElement('div', 'svc-actions');
      if (port) {
        addButton(actions, 'Open', () => openDetailPort(project.name, item.name, port.container));
      }
      const terminalButton = addButton(actions, 'Terminal', () => openTerminal(item.name));
      terminalButton.disabled = !up;
      addButton(actions, 'Copy shell', () => copyText(item.shell));
      row.append(badgeMark, info, portText, pill, actions);
      svc.card.appendChild(row);
    }
  }
  main.appendChild(svc.card);

  // Logs
  const logs = ovCard(`Logs · ${project.name}`);
  const live = makeElement('span', 'status status-' + (isRunningProject(project) ? 'running' : 'stopped'));
  live.textContent = isRunningProject(project) ? '● Live' : '● Stopped';
  logs.head.appendChild(live);
  const term = makeElement('pre', 'term');
  term.textContent = fresh ? (lastLines(overviewState.logs, 8) || 'No logs yet.') : 'Loading...';
  logs.card.appendChild(term);
  const more = makeElement('div', 'row-actions');
  addButton(more, 'Open full logs', () => setDetailTab('logs'));
  logs.card.appendChild(more);
  main.appendChild(logs.card);

  // Database
  const db = services.find((item) => ['mysql', 'postgres', 'mongodb'].includes(item.name));
  const dbCard = ovCard('Database');
  if (db) {
    const dbPort = db.ports[0];
    const details = fresh && overviewState.details ? overviewState.details : null;
    dbCard.head.appendChild(makeElement('span', 'muted small')).textContent = db.image;
    dbCard.card.appendChild(kvRow('Host', '127.0.0.1'));
    dbCard.card.appendChild(kvRow('Port', dbPort ? String(dbPort.host) : 'not published'));
    if (db.name !== 'mongodb') {
      dbCard.card.appendChild(kvRow('Database', details && details.dbName ? details.dbName : '–'));
      dbCard.card.appendChild(kvRow('User', details && details.dbUser ? details.dbUser : '–'));
    }
    dbCard.card.appendChild(kvRow('Password', 'Saved in Credentials & .env'));
    const actions = makeElement('div', 'row-actions');
    addButton(actions, 'Show credentials', () => setDetailTab('credentials'));
    if (project.services.includes('phpmyadmin')) {
      addButton(actions, 'Open phpMyAdmin', () => openService(project.name, 'phpmyadmin', 'phpMyAdmin'));
    }
    dbCard.card.appendChild(actions);
  } else {
    const note = makeElement('p', 'pcard-note');
    note.textContent = 'This project has no database.';
    dbCard.card.appendChild(note);
  }
  side.appendChild(dbCard.card);

  // Details
  const info = ovCard('Details');
  info.card.appendChild(kvRow('Runtime', project.label));
  const shared = Boolean(links && links.lanShare);
  info.card.appendChild(kvRow('Network', shared ? 'Shared on your network' : 'Local only (127.0.0.1)'));
  const note = makeElement('p', 'pcard-note');
  note.textContent = 'To share on your network or change services, use the Settings tab.';
  info.card.appendChild(note);
  const actions = makeElement('div', 'row-actions');
  addButton(actions, 'Open folder', () => runProjectAction('Folder', 'openFolder', project.name));
  if (['nestjs', 'nextjs', 'vue', 'nuxt'].includes(project.stack)) {
    const editorButton = addButton(actions, 'Packages for editor', () => runProjectAction('Install packages', 'installPackages', project.name, EDITOR_PACKAGES_TEXT));
    editorButton.title = 'Installs node_modules into the project folder so VS Code can find the types. The app itself keeps its own fast copy in Docker.';
  }
  info.card.appendChild(actions);
  side.appendChild(info.card);

  // Delete, kept out of the way
  const danger = makeElement('div', 'ov-danger');
  const deleteButton = addButton(danger, 'Delete project...', () => startDeleteProject(project.name));
  deleteButton.classList.add('danger');
  side.appendChild(danger);

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

  const name = detailState.name;
  if (tab === 'services') openLinks(name);
  else if (tab === 'volumes') showVolumes(name);
  else if (tab === 'logs') showLogs(name);
  else if (tab === 'credentials') showConnection(name);
  else if (tab === 'settings') openEdit(name);
}

// ---------- Volumes tab ----------

let volumesName = '';

const VOLUME_ICONS = {
  data: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"></ellipse><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path></svg>',
  cache: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21 8-9-5-9 5 9 5z"></path><path d="M3 8v8l9 5 9-5V8"></path><path d="M12 13v8"></path></svg>',
  other: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M3 10h18"></path></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>',
};

// A small line of "name  value" with a copy button, for the paths and names.
function volField(label, value) {
  const field = makeElement('div', 'vol-field');
  const key = makeElement('span', 'vol-key');
  key.textContent = label;
  const box = makeElement('div', 'vol-val');
  const code = makeElement('code', '');
  code.textContent = value;
  box.append(code, iconButton('copy', `Copy ${label.toLowerCase()}`, (event) => copyWithFeedback(value, event.currentTarget)));
  field.append(key, box);
  return field;
}

function volumeMark(kind) {
  const mark = makeElement('span', `vol-mark vol-${kind}`);
  mark.setAttribute('aria-hidden', 'true');
  mark.innerHTML = VOLUME_ICONS[kind] || VOLUME_ICONS.other;
  return mark;
}

function renderVolumes(name, data) {
  const body = el.volumesBody;
  body.textContent = '';

  // Totals
  const tiles = makeElement('div', 'vol-tiles');
  const addTile = (value, label) => {
    const tile = makeElement('div', 'vol-tile');
    const strong = makeElement('strong', '');
    strong.textContent = value;
    const small = makeElement('span', 'muted small');
    small.textContent = label;
    tile.append(strong, small);
    tiles.appendChild(tile);
  };
  const made = data.volumes.filter((v) => v.exists).length;
  addTile(String(data.volumes.length), data.volumes.length === 1 ? 'Docker volume' : 'Docker volumes');
  addTile('…', 'Size on disk');
  tiles.children[1].querySelector('strong').dataset.total = 'true';
  addTile(String(data.folders.length), data.folders.length === 1 ? 'Shared folder' : 'Shared folders');
  body.appendChild(tiles);

  // Docker volumes
  const section = credSection('Docker volumes', 'Docker keeps these on its own disk. They stay when you stop or restart the project. Deleting the project asks if they should go too.');
  if (data.volumes.length === 0) {
    const empty = makeElement('div', 'empty');
    const title = makeElement('strong', '');
    title.textContent = 'This project has no Docker volumes';
    const text = makeElement('p', 'muted small');
    text.textContent = 'Everything it needs is in the project folder. Add a database in the Settings tab and its data volume shows here.';
    empty.append(title, text);
    section.appendChild(empty);
  } else {
    const list = makeElement('div', 'vol-list');
    for (const v of data.volumes) {
      const card = makeElement('div', 'vol-card');
      const head = makeElement('div', 'vol-head');
      const info = makeElement('div', 'vol-info');
      const title = makeElement('strong', '');
      title.textContent = `${v.service} · ${v.label}`;
      const note = makeElement('span', 'muted small');
      note.textContent = v.note;
      info.append(title, note);
      const state = makeElement('span', `status status-${v.exists ? 'running' : 'stopped'}`);
      state.textContent = v.exists ? '● Created' : '● Not created yet';
      const size = makeElement('span', 'vol-size');
      size.textContent = v.exists ? '…' : '–';
      if (v.exists) size.dataset.volume = v.name;
      head.append(volumeMark(v.kind), info, size, state);
      card.append(head, volField('Volume name', v.name), volField('Inside the container', v.target));
      list.appendChild(card);
    }
    section.appendChild(list);
    if (made < data.volumes.length) {
      const hint = makeElement('p', 'muted small');
      hint.textContent = 'A volume is created the first time the project starts.';
      section.appendChild(hint);
    }
  }
  body.appendChild(section);

  // Folders shared from this computer
  if (data.folders.length > 0) {
    const shared = credSection('Shared folders', 'Folders and files from this computer that the containers see. Changes show on both sides at once.');
    const list = makeElement('div', 'vol-list');
    for (const f of data.folders) {
      const card = makeElement('div', 'vol-card');
      const head = makeElement('div', 'vol-head');
      const info = makeElement('div', 'vol-info');
      const title = makeElement('strong', '');
      title.textContent = f.service;
      const note = makeElement('span', 'muted small');
      note.textContent = 'On this computer, shared into the container';
      info.append(title, note);
      head.append(volumeMark('folder'), info);
      card.append(head, volField('On this computer', f.source), volField('Inside the container', f.target));
      list.appendChild(card);
    }
    shared.appendChild(list);
    const actions = makeElement('div', 'row-actions vol-actions');
    addButton(actions, 'Open project folder', () => runProjectAction('Folder', 'openFolder', name));
    shared.appendChild(actions);
    body.appendChild(shared);
  }
}

// The sizes come later (Docker is slow to count them): fill them into the list when they arrive.
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
    say(`Opened ${res.file}. Add versions, save it, then restart envhub.`);
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
  setText('settings-projects-dir', info.projectsDir);
  byId('settings-reset-dir').hidden = info.isDefault;
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
  el.editAddService.disabled = busy;
}

function renderEdit(details) {
  editState.name = details.name;
  editState.running = details.running === true;
  el.editTitle.textContent = `Edit services: ${details.name} · ${details.label}`;

  for (const label of el.editOptions.querySelectorAll('label')) label.remove();
  for (const key of details.optionKeys) {
    const label = makeElement('label', 'opt-tile');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.key = key;
    box.checked = details.options[key] === true;
    box.addEventListener('change', () => syncEditDependencies(key));
    const title = makeElement('span', 'opt-name');
    title.textContent = EDIT_LABELS[key] || key;
    label.append(box, title);
    if (registry && DB_VERSION_KEYS.includes(key)) {
      const select = document.createElement('select');
      select.className = 'ver-select';
      select.dataset.versionKey = key;
      select.setAttribute('aria-label', `${EDIT_LABELS[key]} version`);
      fillVersionSelect(select, key, (details.versions && details.versions[key]) || registry[key].default);
      label.append(select);
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
  ensureProjectsView();
  mountPanel(el.editCard);
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
  setActionStatus(describeResult('Apply', name, res), name);
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
    card.appendChild(codeRow('Shell', svc.shell));
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

// ---------- Containers ----------

// One row of the Containers list: project and service, the image, and whether it is running.
function containerRow(c) {
  const up = c.state === 'running';
  const li = makeElement('li', 'container-row');
  const main = makeElement('div', 'container-main');
  const title = makeElement('strong', '');
  title.textContent = c.project && c.service ? `${c.project} · ${c.service}` : c.name;
  const image = makeElement('span', 'container-image');
  image.textContent = c.image;
  main.append(title, image);
  const pill = makeElement('span', `status status-${up ? 'running' : 'stopped'}`);
  pill.textContent = `● ${up ? 'Running' : c.state.charAt(0).toUpperCase() + c.state.slice(1)}`;
  const detail = makeElement('span', 'container-status muted small');
  detail.textContent = c.status || '';
  li.append(main, pill, detail);
  return li;
}

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
      el.containerList.appendChild(containerRow(c));
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
  el.dockerMark = byId('docker-mark');
  el.dockerArt = byId('docker-art');
  el.detail = byId('docker-detail');
  el.guidance = byId('docker-guidance');
  el.button = byId('check-again');

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

  el.versionsFileBtn.addEventListener('click', openVersionsFile);

  bindProjectsPage();
  await loadRegistry();
  syncStackForm();
  showStage('name');

  try {
    const info = await window.envhub.getAppInfo();
    el.appInfo.textContent = `${info.name} ${info.version}`;
    byId('settings-about').textContent = `${info.name} ${info.version}. Everything runs in Docker on this computer.`;
  } catch (err) {
    el.appInfo.textContent = '';
  }

  checkDocker();
  renderProjectsLoading();
  loadProjects();
  refreshContainers();
});
