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

// Turns the container list into the running projects: [{ name, services: [{ name, running }] }].
// A project is listed when at least one of its containers runs. Its stopped services are listed too, as stopped.
function runningProjects(containers) {
  const byProject = new Map();
  for (const c of containers || []) {
    if (!c.project) continue;
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push({ name: c.service || c.name || '?', running: c.state === 'running' });
  }
  return [...byProject.entries()]
    .filter(([, services]) => services.some((s) => s.running))
    .map(([name, services]) => ({ name, services: services.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The menu, as a plain template, so a test can read it without Electron.
// `projects` = the result of runningProjects(). Each project is a sub menu with its services.
function trayTemplate(actions, projects = []) {
  const list = projects.length > 0
    ? projects.map((project) => {
      const up = project.services.filter((s) => s.running).length;
      return {
        label: `${project.name}  (${up} of ${project.services.length} running)`,
        submenu: [
          ...project.services.map((s) => ({ label: `${s.running ? '\u25CF' : '\u25CB'}  ${s.name}`, enabled: false })),
          { type: 'separator' },
          { label: 'Open project', click: () => actions.openProject(project.name) },
        ],
      };
    })
    : [{ label: 'No project is running', enabled: false }];

  return [
    { label: 'Open ProjectDockHub', click: () => actions.show() },
    { type: 'separator' },
    { label: 'Running projects', enabled: false },
    ...list,
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
  // The list of running projects is renewed from main.js when containers change.
  tray.updateProjects = (projects) => tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(actions, projects)));
  // A left click opens the window, as most tray apps do on Windows.
  tray.on('click', () => actions.show());
  tray.on('double-click', () => actions.show());
  return tray;
}

module.exports = { createTray, trayTemplate, runningProjects };
