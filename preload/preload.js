'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Allowlist: the renderer can only call these channels.
const INVOKE = {
  getAppInfo: 'app:getInfo',
  dockerCheck: 'docker:check',
  dockerStart: 'docker:start',
  windowControl: 'window:control',
  windowMenu: 'window:menu',
  dockerDownload: 'docker:download',
  listContainers: 'containers:list',
  listProjects: 'projects:list',
  createProject: 'project:create',
  startProject: 'project:start',
  stopProject: 'project:stop',
  restartProject: 'project:restart',
  stopService: 'service:stop',
  startService: 'service:start',
  openProject: 'project:open',
  openFolder: 'project:openFolder',
  projectLogs: 'project:logs',
  deleteProject: 'project:delete',
  projectConnection: 'project:connection',
  projectConnectionData: 'project:connectionData',
  projectEnv: 'project:env',
  writeEnv: 'project:writeEnv',
  getVersions: 'registry:get',
  openVersionsFile: 'registry:openFile',
  hubSearch: 'hub:search',
  hubTags: 'hub:tags',
  hubCheck: 'hub:check',
  checkName: 'project:checkName',
  projectDetails: 'project:details',
  updateProject: 'project:update',
  projectLinks: 'project:links',
  testAccess: 'project:testAccess',
  allowFirewall: 'project:allowFirewall',
  openPort: 'project:openPort',
  projectStats: 'project:stats',
  projectDisk: 'project:disk',
  projectVolumes: 'project:volumes',
  projectShell: 'project:shell',
  installPackages: 'project:installPackages',
  pickFolder: 'project:pickFolder',
  dockerFiles: 'project:dockerFiles',
  generateDockerFiles: 'project:generateDockerFiles',
  getSettings: 'settings:get',
  chooseProjectsDir: 'settings:chooseProjectsDir',
  resetProjectsDir: 'settings:resetProjectsDir',
  setStopDockerOnExit: 'settings:setStopDockerOnExit',
  detectProject: 'project:detect',
  importProject: 'project:import',
};

// Allowlist: the only events the renderer can subscribe to.
const EVENTS = {
  containersChanged: 'containers:changed',
  dockerState: 'docker:state',
  projectProgress: 'project:progress',
  projectLog: 'project:log',
  menuAction: 'menu:action',
};

contextBridge.exposeInMainWorld('envhub', {
  getAppInfo: () => ipcRenderer.invoke(INVOKE.getAppInfo),
  checkDocker: () => ipcRenderer.invoke(INVOKE.dockerCheck),
  windowMenu: (label, x, y) => ipcRenderer.invoke(INVOKE.windowMenu, label, x, y),
  windowControl: (action) => ipcRenderer.invoke(INVOKE.windowControl, action),
  startDocker: () => ipcRenderer.invoke(INVOKE.dockerStart),
  downloadDocker: () => ipcRenderer.invoke(INVOKE.dockerDownload),
  listContainers: (projectName) => ipcRenderer.invoke(INVOKE.listContainers, projectName ?? null),
  listProjects: () => ipcRenderer.invoke(INVOKE.listProjects),
  createProject: (input) => ipcRenderer.invoke(INVOKE.createProject, input),
  startProject: (name, options) => ipcRenderer.invoke(INVOKE.startProject, name, options ?? null),
  stopProject: (name) => ipcRenderer.invoke(INVOKE.stopProject, name),
  restartProject: (name) => ipcRenderer.invoke(INVOKE.restartProject, name),
  stopService: (name, service) => ipcRenderer.invoke(INVOKE.stopService, name, service),
  startService: (name, service) => ipcRenderer.invoke(INVOKE.startService, name, service),
  openProject: (name, service) => ipcRenderer.invoke(INVOKE.openProject, name, service ?? null),
  openFolder: (name) => ipcRenderer.invoke(INVOKE.openFolder, name),
  projectLogs: (name) => ipcRenderer.invoke(INVOKE.projectLogs, name),
  deleteProject: (name, options) => ipcRenderer.invoke(INVOKE.deleteProject, name, options),
  projectConnection: (name) => ipcRenderer.invoke(INVOKE.projectConnection, name),
  projectConnectionData: (name) => ipcRenderer.invoke(INVOKE.projectConnectionData, name),
  getVersions: () => ipcRenderer.invoke(INVOKE.getVersions),
  openVersionsFile: () => ipcRenderer.invoke(INVOKE.openVersionsFile),
  writeEnv: (name, target) => ipcRenderer.invoke(INVOKE.writeEnv, name, target ?? 'docker'),
  projectEnv: (name, target) => ipcRenderer.invoke(INVOKE.projectEnv, name, target ?? 'docker'),
  hubSearch: (query) => ipcRenderer.invoke(INVOKE.hubSearch, query),
  hubTags: (image) => ipcRenderer.invoke(INVOKE.hubTags, image),
  hubCheck: (image) => ipcRenderer.invoke(INVOKE.hubCheck, image),
  checkName: (name) => ipcRenderer.invoke(INVOKE.checkName, name),
  projectDetails: (name) => ipcRenderer.invoke(INVOKE.projectDetails, name),
  updateProject: (name, input) => ipcRenderer.invoke(INVOKE.updateProject, name, input),
  projectLinks: (name) => ipcRenderer.invoke(INVOKE.projectLinks, name),
  pickFolder: () => ipcRenderer.invoke(INVOKE.pickFolder),
  dockerFiles: (name) => ipcRenderer.invoke(INVOKE.dockerFiles, name),
  generateDockerFiles: (name) => ipcRenderer.invoke(INVOKE.generateDockerFiles, name),
  getSettings: () => ipcRenderer.invoke(INVOKE.getSettings),
  chooseProjectsDir: () => ipcRenderer.invoke(INVOKE.chooseProjectsDir),
  resetProjectsDir: () => ipcRenderer.invoke(INVOKE.resetProjectsDir),
  setStopDockerOnExit: (value) => ipcRenderer.invoke(INVOKE.setStopDockerOnExit, value === true),
  detectProject: (folder) => ipcRenderer.invoke(INVOKE.detectProject, folder),
  importProject: (input) => ipcRenderer.invoke(INVOKE.importProject, input),
  installPackages: (name) => ipcRenderer.invoke(INVOKE.installPackages, name),
  openPort: (name, service, container) => ipcRenderer.invoke(INVOKE.openPort, name, service, container),
  projectStats: (name) => ipcRenderer.invoke(INVOKE.projectStats, name),
  projectDisk: (name) => ipcRenderer.invoke(INVOKE.projectDisk, name),
  projectVolumes: (name) => ipcRenderer.invoke(INVOKE.projectVolumes, name),
  projectShell: (name, service) => ipcRenderer.invoke(INVOKE.projectShell, name, service),
  onMenuAction: (callback) => {
    const listener = (_event, name) => callback(name);
    ipcRenderer.on(EVENTS.menuAction, listener);
    return () => ipcRenderer.removeListener(EVENTS.menuAction, listener);
  },
  onProjectProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(EVENTS.projectProgress, listener);
    return () => ipcRenderer.removeListener(EVENTS.projectProgress, listener);
  },
  onProjectLog: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(EVENTS.projectLog, listener);
    return () => ipcRenderer.removeListener(EVENTS.projectLog, listener);
  },
  onDockerState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on(EVENTS.dockerState, listener);
    return () => ipcRenderer.removeListener(EVENTS.dockerState, listener);
  },
  onContainersChanged: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(EVENTS.containersChanged, listener);
    return () => ipcRenderer.removeListener(EVENTS.containersChanged, listener);
  },
});
