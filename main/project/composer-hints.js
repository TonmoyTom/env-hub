'use strict';

// Composer prints long, technical errors. When ProjectDockHub runs Composer itself and it fails, the last lines
// are checked for the common causes and a short plain sentence is added. Returns '' when nothing is known.
const HINTS = [
  {
    test: /security advisories|policy\.advisories/i,
    text: 'Composer refused old package versions because of known security problems. Save and apply the project (so the container gets the new settings) and run the command again.',
  },
  {
    test: /your php version \(([\d.]+)\) does not satisfy/i,
    text: (m) => `A package is too old for PHP ${m[1]}, the PHP of this project. Update that package (or Laravel). See "Composer problems?" in the project's Settings tab.`,
  },
  {
    test: /facade\/ignition|fruitcake\/laravel-cors|cannot coexist with it/i,
    text: 'These packages do not work with the new Laravel version. See "Composer problems?" in the project\'s Settings tab.',
  },
  {
    test: /allowed memory size|out of memory/i,
    text: 'Composer ran out of memory. Run it again as: COMPOSER_MEMORY_LIMIT=-1 composer update',
  },
  {
    test: /could not resolve host|failed to download|curl error|timed out/i,
    text: 'Composer could not reach the internet. Check the connection and try again.',
  },
];

function composerHint(output) {
  const text = Array.isArray(output) ? output.join('\n') : String(output || '');
  for (const hint of HINTS) {
    const match = hint.test.exec(text);
    if (match) return typeof hint.text === 'function' ? hint.text(match) : hint.text;
  }
  return '';
}

module.exports = { composerHint };
