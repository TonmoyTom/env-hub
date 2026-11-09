'use strict';

// On Linux, Docker runs containers as root, so files they write into the project folder
// (a generated app, package-lock.json, .next) would belong to root and the user could not edit them.
// Windows and Mac (Docker Desktop) map the owner by themselves, so nothing is needed there.
// Returns "uid:gid" of the current user on Linux, else null. Running as root needs no change either.
function hostUser(platform = process.platform, getuid = process.getuid, getgid = process.getgid) {
  if (platform !== 'linux' || typeof getuid !== 'function' || typeof getgid !== 'function') return null;
  const uid = getuid.call(process);
  const gid = getgid.call(process);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) return null;
  return `${uid}:${gid}`;
}

// A user other than root has no home folder inside the image, so npm and composer need a writable one.
const USER_ENV = { HOME: '/tmp', npm_config_cache: '/tmp/.npm', COMPOSER_HOME: '/tmp/composer' };

// A new named volume is owned by root, so a service that runs as the user could not write to it
// (node_modules). These docker commands create each such volume and give it to the user. Pure.
function volumeOwnerCommands(config, projectName) {
  const commands = [];
  for (const svc of config.services) {
    if (!svc.user) continue;
    for (const v of svc.dataVolumes || []) {
      const volume = `envhub-${projectName}-${svc.name}-${v.name}`;
      commands.push(
        ['volume', 'create', '--label', 'com.envhub.managed=true', '--label', `com.envhub.project=${projectName}`, '--label', `com.envhub.service=${svc.name}`, volume],
        ['run', '--rm', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/v`, '--entrypoint', 'chown', svc.image, svc.user, '/v'],
      );
    }
  }
  return commands;
}

module.exports = { hostUser, USER_ENV, volumeOwnerCommands };
