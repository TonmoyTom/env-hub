'use strict';

// Container health: the health word in `docker ps` ("Up 5 minutes (unhealthy)"), and "Why?" for one service:
// docker inspect plus the last log lines, turned into plain findings (what went wrong and what to do).
// explainState is pure, so the rules are tested without Docker.

const { MANAGED_FILTER, projectFilter, serviceFilter } = require('../naming');
const { runDocker, firstLine } = require('./exec');
const { NAME_RE } = require('../compose/generate');

const ID_RE = /^[a-f0-9]{12,64}$/;
const LOG_LINES = 30;

// "Up 5 minutes (healthy)" -> 'healthy'. null when the image has no health check.
function healthOf(status) {
  const m = /\((healthy|unhealthy|health: starting)\)/i.exec(String(status || ''));
  if (!m) return null;
  return m[1].toLowerCase() === 'health: starting' ? 'starting' : m[1].toLowerCase();
}

const SHELLS = new Set(['sh', 'bash', 'ash', 'zsh', 'dash', 'fish']);
// Programs that wait for typed input when they get no script: the same "ends at once" problem as a shell.
const REPLS = new Set(['python', 'python3', 'node', 'irb', 'php', 'ruby', 'ghci', 'iex', 'jshell', 'psql', 'mysql']);

function baseName(arg) {
  return String(arg || '').split(/[\\/]/).pop().toLowerCase();
}

// The command the container runs: entry point plus command, as one list.
function commandOf(config) {
  const entry = Array.isArray(config.Entrypoint) ? config.Entrypoint : [];
  const cmd = Array.isArray(config.Cmd) ? config.Cmd : [];
  return [...entry, ...cmd].map(String);
}

// True when the command is only an interactive shell or interpreter (bash, sh, python with no script).
function waitsForInput(command) {
  if (command.length === 0) return false;
  const first = baseName(command[0]);
  if (SHELLS.has(first)) return command.length === 1 || (command.length === 2 && /^-(l|i|il|li)$/.test(command[1]));
  return REPLS.has(first.replace(/[\d.]+$/, '')) && command.length === 1;
}

const LOG_HINTS = [
  [/address already in use|port is already allocated|bind: .*in use/i, 'A port it wants is already used by another program or container.', 'Change the port in the project\'s Settings tab, or stop the other program.'],
  [/permission denied/i, 'It was refused access to a file or folder (permission denied).', 'Check the owner of the mounted folder or volume, or the user the image runs as.'],
  [/exec format error/i, 'The image was built for another processor type (for example ARM instead of x86).', 'Use an image tag made for this computer (amd64 on most Windows PCs).'],
  [/no such file or directory/i, 'A file or program it needs was not found.', 'Check the start command and the mounted folders.'],
  [/host not found|could not resolve host|temporary failure in name resolution|no such host|bad address/i, 'It looks for a service name that does not exist or does not run (for example "php" or "mysql").', 'Check the name in its settings, and that the service it names is started.'],
  [/connection refused|could not connect|getaddrinfo|name or service not known|ENOTFOUND/i, 'It could not reach another service (a database, cache or API).', 'Make sure that service runs, and use its service name as the host (for example mysql, not 127.0.0.1).'],
  [/out of memory|cannot allocate memory|javascript heap out of memory/i, 'It ran out of memory.', 'Give Docker more memory (Docker Desktop > Settings > Resources), or lower what the app uses.'],
  [/access denied for user|authentication failed|password authentication failed|WRONGPASS|NOAUTH/i, 'A login (user and password) was refused.', 'Compare the password the app uses with the one in the Credentials tab.'],
  [/database .* does not exist|unknown database/i, 'The database the app asks for does not exist.', 'Create it, or use the database name shown in the Credentials tab.'],
];

const EXIT_CODES = {
  1: ['The program stopped with an error (exit code 1).', 'The last log lines below usually say why.'],
  2: ['The program was started the wrong way (exit code 2, often a wrong option).', 'Check the start command.'],
  125: ['Docker could not start the container (exit code 125).', 'Look at the error below; often a bad option or a port problem.'],
  126: ['The start command exists but cannot be run (exit code 126, not executable).', 'Check the start command, or make the script executable (chmod +x).'],
  127: ['The start command was not found in the image (exit code 127).', 'Check the spelling of the start command; the program may not be in this image.'],
  137: ['It was killed (exit code 137): out of memory, or it did not stop in time.', 'If it happens on its own, give Docker more memory.'],
  139: ['The program crashed (exit code 139, segmentation fault).', 'Try another image version.'],
  143: ['It was stopped (exit code 143). This is normal after Stop.', ''],
};

// inspect: one object from `docker inspect`. logs: the last log lines as text.
// Returns { state, health, exitCode, restartCount, command, findings: [{ level, text, fix }], logs }.
function explainState(inspect, logs = '') {
  const state = inspect.State || {};
  const config = inspect.Config || {};
  const health = state.Health || null;
  const command = commandOf(config);
  const status = String(state.Status || '').toLowerCase();
  const exitCode = Number(state.ExitCode) || 0;
  const restartCount = Number(inspect.RestartCount) || 0;
  const findings = [];
  const add = (level, text, fix = '') => findings.push({ level, text, fix });
  const notRunning = status !== 'running' || state.Restarting === true;

  if (state.OOMKilled) {
    add('error', 'Docker stopped it because it ran out of memory.', 'Give Docker more memory (Docker Desktop > Settings > Resources), or lower what the app uses.');
  }
  if (state.Error) {
    const port = /port is already allocated|address already in use/i.test(state.Error);
    add('error', `Docker said: ${state.Error}`, port ? 'Another program or container uses this port. Change the port in the project\'s Settings tab.' : '');
  }

  if (status === 'created') {
    add('info', 'The container was created but never started.', 'Start the project.');
  } else if (notRunning && exitCode === 0 && waitsForInput(command) && !config.Tty) {
    add('error',
      `The image only starts "${command.join(' ')}", which waits for typed input. In a container nothing is typed, so it ends at once${status === 'restarting' || restartCount > 0 ? ' and Docker starts it again and again' : ''}.`,
      'Give the service a start command that keeps running (its server program), in the project\'s Settings tab > Extra services.');
  } else if (notRunning && exitCode === 0 && status !== 'paused') {
    add('info', 'Its program finished normally (exit code 0). A container stops when its main program ends.', 'If it should keep running, its start command must run a server, not a one-off task.');
  } else if (notRunning && exitCode !== 0 && !state.OOMKilled) {
    const known = EXIT_CODES[exitCode];
    if (known) add(exitCode === 143 ? 'info' : 'error', known[0], known[1]);
    else add('error', `The program stopped with an error (exit code ${exitCode}).`, 'The last log lines below usually say why.');
  }

  if (restartCount >= 3 || status === 'restarting') {
    add('warn', `It restarted ${restartCount} time${restartCount === 1 ? '' : 's'}. It keeps stopping, so Docker keeps starting it again.`, '');
  }

  if (health && health.Status === 'unhealthy') {
    const last = (health.Log || []).slice(-1)[0];
    const output = last && last.Output ? String(last.Output).trim().split('\n').slice(-2).join(' ') : '';
    add('error', `Its health check fails (${health.FailingStreak || 0} times in a row)${output ? `: ${output.slice(0, 300)}` : '.'}`, 'The service runs but does not answer as expected. Check the logs.');
  } else if (health && health.Status === 'starting') {
    add('info', 'It is starting; the health check has not passed yet.', 'Wait a moment.');
  }

  // Known messages in the logs, each at most once. Only when something is wrong.
  if (notRunning || (health && health.Status === 'unhealthy')) {
    for (const [re, text, fix] of LOG_HINTS) {
      if (re.test(logs) && !findings.some((f) => f.text === text)) add('warn', `In the logs: ${text}`, fix);
    }
  }

  if (findings.length === 0) {
    add('ok', status === 'running' ? `It is running${health ? ` and ${health.Status}` : ''}. Nothing looks wrong.` : `State: ${status || 'unknown'}.`, '');
  }

  return {
    state: status,
    health: health ? health.Status : null,
    exitCode,
    restartCount,
    oomKilled: state.OOMKilled === true,
    command: command.join(' '),
    image: config.Image || '',
    finishedAt: state.FinishedAt && !String(state.FinishedAt).startsWith('0001') ? state.FinishedAt : null,
    findings,
    logs: String(logs || '').split('\n').filter((l) => l.trim()).slice(-LOG_LINES).join('\n'),
  };
}

// "Why?" for one service of a project: found by ProjectDockHub labels, so nothing else is read.
async function diagnoseContainer(projectName, serviceName, run = runDocker) {
  if (typeof projectName !== 'string' || !NAME_RE.test(projectName)) throw new Error('Invalid project name');
  if (typeof serviceName !== 'string' || !NAME_RE.test(serviceName)) throw new Error('Invalid service name');
  const found = await run(['ps', '-a', '-q', '--filter', MANAGED_FILTER, '--filter', projectFilter(projectName), '--filter', serviceFilter(serviceName)]);
  if (!found.ok) throw new Error(firstLine(found.stderr) || 'Could not find the container');
  const id = found.stdout.split('\n').map((s) => s.trim()).find((s) => ID_RE.test(s));
  if (!id) {
    return {
      state: 'missing', health: null, exitCode: 0, restartCount: 0, command: '', image: '', logs: '',
      findings: [{ level: 'info', text: `${serviceName} has no container.`, fix: 'Start the project to create it.' }],
    };
  }
  const inspected = await run(['inspect', id]);
  if (!inspected.ok) throw new Error(firstLine(inspected.stderr) || 'Could not read the container');
  let data;
  try {
    data = JSON.parse(inspected.stdout)[0];
  } catch (err) {
    throw new Error('Docker gave an answer that could not be read');
  }
  const logs = await run(['logs', '--tail', String(LOG_LINES), id], { timeout: 15000 });
  return { service: serviceName, container: data.Name ? String(data.Name).replace(/^\//, '') : id.slice(0, 12), ...explainState(data, `${logs.stdout || ''}\n${logs.stderr || ''}`) };
}

module.exports = { healthOf, explainState, diagnoseContainer, waitsForInput, commandOf };
