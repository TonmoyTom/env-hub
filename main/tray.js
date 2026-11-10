'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

// The icon next to the clock. Closing the window only hides it: ProjectDockHub keeps running here,
// like Docker Desktop or WhatsApp. Right click > Exit really quits.
// `actions` = { show(), quit() }.
// Windows and Linux get the colored icon (build/tray.png, with tray@2x.png next to it for sharp screens).
// macOS gets a one color shape that the menu bar tints itself (a "template" image).
const BUILD_DIR = path.join(__dirname, '..', 'build');
const ICON_PATH = path.join(BUILD_DIR, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');

// The menu, as a plain template, so a test can read it without Electron.
function trayTemplate(actions) {
  return [
    { label: 'Open ProjectDockHub', click: () => actions.show() },
    { type: 'separator' },
    { label: 'Exit', click: () => actions.quit() },
  ];
}

function createTray(actions) {
  const image = nativeImage.createFromPath(ICON_PATH);
  if (process.platform === 'darwin') image.setTemplateImage(true);
  const tray = new Tray(image);
  tray.setToolTip('ProjectDockHub');
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(actions)));
  // A left click opens the window, as most tray apps do on Windows.
  tray.on('click', () => actions.show());
  tray.on('double-click', () => actions.show());
  return tray;
}

module.exports = { createTray, trayTemplate };
