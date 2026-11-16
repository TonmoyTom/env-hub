// Flips Electron fuses on the packaged app (Electron security checklist, item "Check which fuses you can change").
const path = require('node:path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context;
  const name = context.packager.appInfo.productFilename;
  const exe =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
      : electronPlatformName === 'win32'
        ? path.join(appOutDir, `${name}.exe`)
        : path.join(appOutDir, context.packager.executableName);

  await flipFuses(exe, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
};
