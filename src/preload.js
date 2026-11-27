'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Narrow bridge used by the splash and error pages only. The harness window is
 * created without a preload, so the application UI never sees this API.
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  info: () => ipcRenderer.invoke('desktop:info'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  copyLog: () => ipcRenderer.invoke('desktop:copy-log'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  platform: process.platform,
});
