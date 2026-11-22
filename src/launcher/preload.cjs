'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = ch => cb => { ipcRenderer.on(ch, (_e, d) => cb(d)); };
contextBridge.exposeInMainWorld('launcher', {
  state: () => ipcRenderer.invoke('launcher:state'),
  play: id => ipcRenderer.invoke('launcher:play', id),
  setSettings: patch => ipcRenderer.invoke('launcher:setSettings', patch),
  offlineSave: id => ipcRenderer.invoke('launcher:offlineSave', id),
  offlineDelete: id => ipcRenderer.invoke('launcher:offlineDelete', id),
  openData: () => ipcRenderer.invoke('launcher:openData'),
  openRepo: id => ipcRenderer.invoke('launcher:openRepo', id),
  clearCache: () => ipcRenderer.invoke('launcher:clearCache'),
  onError: on('launcher:error'),
  refreshDevices: () => ipcRenderer.invoke('launcher:refreshDevices'),
  test: kind => ipcRenderer.invoke('launcher:test', kind),
  restart: () => ipcRenderer.invoke('launcher:restart'),
  updateCheck: () => ipcRenderer.invoke('launcher:updateCheck'),
  updateDownload: () => ipcRenderer.invoke('launcher:updateDownload'),
  updateApply: () => ipcRenderer.invoke('launcher:updateApply'),
  onUpdate: on('update'),
  onBridgeStatus: on('bridge:status'),
  onGpu: on('gpu'),
  onBridgeInput: on('bridge:input'),
  onBridgeLog: on('bridge:log'),
  onGames: on('games'),
  onTelemetry: on('game:telemetry'),
});
