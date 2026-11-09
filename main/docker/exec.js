'use strict';

const { execFile, spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BUFFER = 10 * 1024 * 1024;

// Every docker call goes through here.
// Arguments are always an array of strings. No shell is ever involved.
function runDocker(args, options = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('docker arguments must be an array of strings');
  }

  const timeout = options.timeout || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    execFile('docker', args, { timeout, windowsHide: true, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      const out = String(stdout || '');
      const errText = String(stderr || '');
      if (err) {
        resolve({ ok: false, code: err.code, stdout: out, stderr: errText });
        return;
      }
      resolve({ ok: true, code: 0, stdout: out, stderr: errText });
    });
  });
}

// Runs docker and calls `onLine` for every line it prints, while it runs.
// Progress bars redraw with a carriage return, so those count as line breaks too.
// Resolves with { ok, code, tail } where tail holds the last lines, for error messages.
function streamDocker(args, onLine, options = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new TypeError('docker arguments must be an array of strings');
  }

  return new Promise((resolve) => {
    const child = spawn('docker', args, {
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
    });

    const tail = [];
    const pending = { out: '', err: '' };

    function handle(line) {
      const text = line.trim();
      if (!text) return;
      tail.push(text);
      if (tail.length > 30) tail.shift();
      onLine(text);
    }

    function feed(kind, chunk) {
      pending[kind] += chunk.toString();
      const parts = pending[kind].split(/\r\n|\n|\r/);
      pending[kind] = parts.pop();
      parts.forEach(handle);
    }

    const timer = setTimeout(() => child.kill(), options.timeout || DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => feed('out', chunk));
    child.stderr.on('data', (chunk) => feed('err', chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: err.code, tail: [String(err.message)] });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      handle(pending.out);
      handle(pending.err);
      resolve({ ok: code === 0, code, tail });
    });
  });
}

function firstLine(text) {
  return String(text || '').split('\n').find((line) => line.trim()) || '';
}

module.exports = { runDocker, streamDocker, firstLine };
