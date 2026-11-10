'use strict';

const { Menu } = require('electron');

// The application menu. It only builds the template: every action is a function that main.js passes in,
// so this file has nothing to do with Docker or files and is easy to read.
//   actions.sendToWindow(name)   tells the window to do something (new-project, existing-project, refresh...)
//   actions.chooseProjectsDir()  File > Projects folder...
//   actions.openProjectsDir()    File > Open projects folder
//   actions.openDataDir()        File > Open envhub data folder
//   actions.exportProjects()     Tools > Sync > Export projects...
//   actions.importProjects()     Tools > Sync > Import projects...
//   actions.refreshDocker()      Tools > Sync > Refresh Docker state
//   actions.refreshVersions()    Tools > Sync > Refresh version lists from Docker Hub
//   actions.showDoc(name)        Help > Planning / Handover notes
//   actions.openVersionsFile()   Tools > Edit versions.json
//   actions.about()              Help > About
function buildTemplate(actions, isMac = process.platform === 'darwin') {
  const file = [
    { label: 'New project', accelerator: 'CmdOrCtrl+N', click: () => actions.sendToWindow('new-project') },
    { label: 'Open existing project...', accelerator: 'CmdOrCtrl+O', click: () => actions.sendToWindow('existing-project') },
    { type: 'separator' },
    { label: 'Projects folder...', click: () => actions.chooseProjectsDir() },
    { label: 'Open projects folder', click: () => actions.openProjectsDir() },
    { label: 'Open envhub data folder', click: () => actions.openDataDir() },
    { type: 'separator' },
    { label: 'Close window (envhub keeps running in the tray)', role: 'close' },
    { label: isMac ? 'Quit envhub' : 'Exit', role: 'quit' },
  ];

  const tools = [
    {
      label: 'Sync',
      submenu: [
        { label: '1. Export projects to a file...', click: () => actions.exportProjects() },
        { label: '1. Import projects from a file...', click: () => actions.importProjects() },
        { type: 'separator' },
        { label: '2. Refresh Docker state', accelerator: 'F5', click: () => actions.refreshDocker() },
        { type: 'separator' },
        { label: '3. Refresh version lists (Docker Hub)', click: () => actions.refreshVersions() },
      ],
    },
    { label: 'Edit versions.json', click: () => actions.openVersionsFile() },
  ];

  const help = [
    { label: 'Planning', click: () => actions.showDoc('planning') },
    { label: 'Handover notes', click: () => actions.showDoc('handover') },
    { type: 'separator' },
    { label: 'About envhub', click: () => actions.about() },
  ];

  return [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: file },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { label: 'Tools', submenu: tools },
    { role: 'windowMenu' },
    { label: 'Help', submenu: help },
  ];
}

function installMenu(actions) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildTemplate(actions)));
}

module.exports = { buildTemplate, installMenu };
