'use strict';

const net = require('net');
const { execFile } = require('child_process');

// "Why can't the other computer open my site?" Checks the usual causes one by one and says, in plain words,
// what is wrong and what fixes it. buildDiagnosis is pure (it only turns facts into steps); the probes below
// gather the facts.

const FIREWALL_PREFIX = 'EnvHub';

function ruleName(port) {
  return `${FIREWALL_PREFIX} ${port}`;
}

function validPort(port) {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

// facts: { running, lanShare, addresses[], port, localOk, lanOk, firewallRule (true|false|null), platform }
// A step is { id, ok, title, detail, fix } where fix is '' or the name of a button the window can offer:
// 'start', 'settings', 'restart', 'firewall'.
function buildDiagnosis(facts) {
  const steps = [];
  const add = (id, ok, title, detail, fix = '') => steps.push({ id, ok, title, detail: ok ? '' : detail, fix: ok ? '' : fix });

  add('running', facts.running, 'The project is running', 'The project is stopped, so nothing answers on its port. Start it first.', 'start');

  add(
    'share',
    facts.lanShare,
    'Sharing on the network is on',
    'The site is kept on this computer only (localhost). Turn on "Share the web page on my Wi-Fi / network" in Settings, then Save and restart.',
    'settings',
  );

  const hasAddress = Array.isArray(facts.addresses) && facts.addresses.length > 0;
  add('address', hasAddress, 'This computer has a network address', 'No Wi-Fi or cable address was found. Connect to your router, then check again.');

  if (facts.running && facts.lanShare && hasAddress) {
    if (facts.lanOk) {
      add('reach', true, `The site answers on ${facts.addresses[0]}:${facts.port}`, '');
    } else if (facts.localOk) {
      add(
        'reach',
        false,
        `The site does not answer on ${facts.addresses[0]}:${facts.port}`,
        'The site works on localhost but is not open to the network. The project was started before sharing was turned on. Restart it so the new setting is used.',
        'restart',
      );
    } else {
      add('reach', false, 'The site does not answer', 'Neither localhost nor the network address answers yet. The app inside may still be starting, or it crashed. Check the logs.');
    }
  }

  if (facts.platform === 'win32' && facts.lanShare && validPort(facts.port)) {
    if (facts.firewallRule === true) {
      add('firewall', true, 'Windows Firewall allows this port', '');
    } else {
      add(
        'firewall',
        false,
        'Windows Firewall may block other computers',
        `Windows blocks incoming connections from other computers by default. This test runs on this computer, so it cannot see the block. Add a rule for port ${facts.port} (it asks for administrator permission).`,
        'firewall',
      );
    }
  }

  const problems = steps.filter((s) => !s.ok);
  return {
    ok: problems.length === 0,
    steps,
    summary: problems.length === 0 ? 'Everything looks right. Other computers on the same network can open the address above.' : `${problems.length} thing${problems.length === 1 ? '' : 's'} to fix.`,
    // Said every time, because "public access" is the part people get wrong.
    notes: [
      'An address like 192.168.x.x only works for devices on the same Wi-Fi or router. It cannot be opened from the internet or on mobile data.',
      'Databases and admin tools are never shared. Only the web page is.',
    ],
  };
}

// Does something accept a TCP connection at host:port?
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!validPort(port)) return resolve(false);
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function runPowerShell(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// true / false on Windows, null where it cannot be told (other systems).
function firewallRuleExists(port) {
  if (process.platform !== 'win32' || !validPort(port)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${ruleName(port)}`], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
}

// Adds the inbound rule through a UAC prompt. Only the port number goes into the command, and it is checked first.
async function addFirewallRule(port) {
  if (process.platform !== 'win32') return { ok: false, error: 'Firewall rules are only added on Windows.' };
  if (!validPort(port)) return { ok: false, error: 'Invalid port.' };
  const netshArgs = `advfirewall firewall add rule name="${ruleName(port)}" dir=in action=allow protocol=TCP localport=${port} profile=any remoteip=LocalSubnet`;
  const script = `Start-Process -FilePath netsh -ArgumentList '${netshArgs}' -Verb RunAs -WindowStyle Hidden -Wait`;
  const run = await runPowerShell([script]);
  if (!run.ok) return { ok: false, error: 'Administrator permission was not given, so the rule was not added.' };
  const exists = await firewallRuleExists(port);
  return exists ? { ok: true } : { ok: false, error: 'The rule was not added. Try again and choose Yes in the Windows prompt.' };
}

async function gatherFacts({ running, lanShare, addresses, port }) {
  const first = addresses && addresses[0];
  const [localOk, lanOk, firewallRule] = await Promise.all([
    running ? probePort('127.0.0.1', port) : false,
    running && first ? probePort(first, port) : false,
    firewallRuleExists(port),
  ]);
  return { running, lanShare, addresses: addresses || [], port, localOk, lanOk, firewallRule, platform: process.platform };
}

module.exports = { buildDiagnosis, gatherFacts, addFirewallRule, firewallRuleExists, probePort, ruleName, validPort };
