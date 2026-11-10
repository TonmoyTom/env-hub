'use strict';

// "Install a fresh app": runs the official generator of the stack inside a throw-away Docker
// container, writing into the (empty) project folder. Nothing is needed on the user's computer
// except Docker. Node projects use `node:<version>-alpine`, Laravel uses the `composer` image.

const { streamDocker } = require('../docker/exec');
const { hostUser, USER_ENV } = require('../docker/hostuser');

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

// Shell command per stack, run in /app (the project folder). $PROJECT_NAME holds the project name.
// Generators that cannot write into "." are run in a sub folder, then moved up.
// Dependencies are not installed here: the start command runs `npm install` anyway.
const INSTALL_COMMANDS = {
  laravel:
    'composer create-project laravel/laravel /tmp/app --prefer-dist --no-interaction --ignore-platform-req="ext-*" ' +
    '&& cp -a /tmp/app/. . ' +
    '&& chmod -R a+rwX storage bootstrap/cache database 2>/dev/null; true',
  nestjs:
    'npx --yes @nestjs/cli@latest new "$PROJECT_NAME" --package-manager npm --skip-git --skip-install ' +
    '&& cp -a "$PROJECT_NAME"/. . && rm -rf "$PROJECT_NAME"',
  nextjs: 'npx --yes create-next-app@latest . --yes --use-npm --skip-install --disable-git',
  vue:
    'npm create vue@latest "$PROJECT_NAME" -- --default ' +
    '&& cp -a "$PROJECT_NAME"/. . && rm -rf "$PROJECT_NAME"',
  nuxt: 'npx --yes nuxi@latest init . --template minimal --force --no-install --no-gitInit --no-modules --packageManager npm',
};

// Existing Laravel project without vendor/: install it in the container's own disk (a bind mount
// makes composer far too slow), copy vendor back, and make .env + APP_KEY when they are missing.
const COMPOSER_RESTORE =
  'mkdir -p /tmp/app && tar cf - --exclude=./node_modules --exclude=./.git --exclude=./vendor . | tar xf - -C /tmp/app ' +
  '&& cd /tmp/app && composer install --no-interaction --prefer-dist --ignore-platform-req="ext-*" ' +
  '&& rm -rf /app/vendor && cp -a vendor /app/vendor && cd /app ' +
  '&& { [ -f .env ] || { [ -f .env.example ] && cp .env.example .env; }; } ' +
  '&& { grep -qE "^APP_KEY=.+" .env 2>/dev/null || php artisan key:generate --force; } ' +
  '&& chmod -R a+rwX storage bootstrap/cache 2>/dev/null; true';

const INSTALLABLE_STACKS = Object.keys(INSTALL_COMMANDS);

function installImage(stack, { nodeVersion, phpVersion } = {}) {
  if (stack === 'laravel') return 'composer:2';
  return `node:${nodeVersion}-alpine`;
}

// Linux only: write files as the current user, with a writable home for npm and composer.
function userArgs(user) {
  if (!user) return [];
  return ['--user', user, ...Object.entries(USER_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`])];
}

// The docker arguments for one install. Pure, so it can be tested.
function installArgs({ stack, name, folder, nodeVersion, phpVersion, user = hostUser() }) {
  if (!INSTALLABLE_STACKS.includes(stack)) {
    throw new Error('This stack cannot be installed automatically');
  }
  return [
    'run', '--rm',
    '--mount', `type=bind,source=${folder},target=/app`,
    '-w', '/app',
    ...userArgs(user),
    '-e', 'CI=true',
    '-e', 'COMPOSER_NO_INTERACTION=1',
    '-e', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
    '-e', `PROJECT_NAME=${name}`,
    installImage(stack, { nodeVersion, phpVersion }),
    'sh', '-c', INSTALL_COMMANDS[stack],
  ];
}

// Runs the generator. Resolves { ok, tail }. `log` receives every output line.
async function installProject(opts, log = () => {}) {
  const args = installArgs(opts);
  log(`Installing a fresh ${opts.stack} app (this can take a few minutes)`);
  return streamDocker(args, log, { timeout: INSTALL_TIMEOUT_MS });
}

// Runs `composer install` for an existing Laravel folder. Resolves { ok, tail }.
function restoreLaravel({ folder }, log = () => {}) {
  const args = [
    'run', '--rm', '--mount', `type=bind,source=${folder},target=/app`, '-w', '/app',
    ...userArgs(hostUser()), '-e', 'COMPOSER_NO_INTERACTION=1', 'composer:2', 'sh', '-c', COMPOSER_RESTORE,
  ];
  log('Installing the PHP packages (composer install). The first time this can take a few minutes');
  return streamDocker(args, log, { timeout: INSTALL_TIMEOUT_MS });
}

// Merges the ProjectDockHub .env lines into an .env the generator already made (Laravel ships one).
// Keys ProjectDockHub defines replace the old lines; every other line is kept.
function mergeEnv(existing, ours) {
  const keyOf = (line) => {
    const m = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    return m ? m[1] : null;
  };
  const ourKeys = new Set(ours.split('\n').map(keyOf).filter(Boolean));
  const kept = String(existing || '')
    .split('\n')
    .filter((line) => {
      const key = keyOf(line);
      return !(key && ourKeys.has(key));
    });
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.join('\n') + (kept.length ? '\n\n' : '') + ours;
}

module.exports = { installProject, restoreLaravel, COMPOSER_RESTORE, installArgs, userArgs, mergeEnv, INSTALLABLE_STACKS, INSTALL_COMMANDS };
