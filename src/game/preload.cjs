'use strict';
// Game window preload (runs before any page script of the GitHub Pages version).
// Exposes the launcher API to the page and installs the adapter in the main world.
const { contextBridge, ipcRenderer } = require('electron');
const arcadeAdapter = require('./adapter.js');

const init = ipcRenderer.sendSync('game:init');

contextBridge.exposeInMainWorld('arcadeLauncher', {
  init,
  ffb: values => ipcRenderer.send('game:ffb', Array.from(values, Number)),
  telemetry: t => ipcRenderer.send('game:telemetry', t),
  onInput: cb => { ipcRenderer.on('sdl:input', (_e, data) => cb(data)); },
  onSettings: cb => { ipcRenderer.on('settings', (_e, data) => cb(data)); },
});

if (init.game) contextBridge.executeInMainWorld({ func: arcadeAdapter });
