'use strict';
const T0 = Date.now();
const mark = label => { if (process.env.ARCADE_TIMING) process.stderr.write(`[t] ${String(Date.now() - T0).padStart(5)} ms (process ${Math.round(process.uptime() * 1000)} ms)  ${label}\n`); };
mark('main start');
const { app, BrowserWindow, ipcMain, shell, session, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { GAMES, gameForUrl } = require('./games.cjs');
const { installIsolation, isolationHeaders, PARTITION } = require('./remote.cjs');
const { OfflineStore, NETWORK_ERRORS } = require('./offline.cjs');
const { SdlBridge } = require('./sdl-bridge.cjs');
const { setupPortable } = require('./portable.cjs');

// Portable: all data in <exe folder>\data (falls back to %APPDATA% if that folder is read-only).
const portable = setupPortable(app);
mark(`data dir ${portable.dir}${portable.migrated ? ' (migrated)' : ''}`);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const DEFAULTS = {
  gpu: { forceDedicated: true, angle: process.platform === 'win32' ? 'd3d11' : 'default' },
  ffb: {
    enabled: true,
    strength: 0.8,       // master 0..1.5
    constantGain: 1.0,   // drive-board force / roll
    springGain: 1.0,     // game centring (Scud)
    damperGain: 1.0,     // resistance (D1) / weight
    frictionGain: 1.0,   // scrape (Scud)
    rumbleGain: 0.35,    // road/impact vibration translated to the wheel
    minSpring: 0.08,     // base centring spring while racing
    minForce: 0.05,      // overcomes the wheel's dead zone
    smoothing: 0.25,     // 0 = raw, 0.9 = very smooth
    deviceGain: 100,
    device: 0,           // 0 = auto (first wheel with constant force)
  },
  input: { sdlVirtualPad: true },
  window: { fullscreen: false },
  ui: { lang: 'en' },
  games: {
    d1: { invert: false },
    d2: { invert: false },
    scud: { invert: false },
  },
};
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
  return out;
}
let settings = DEFAULTS;
function loadSettings() {
  try { settings = merge(DEFAULTS, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); } catch { settings = merge(DEFAULTS, {}); }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2)); } catch (e) { console.warn(e); }
}

// ---------------------------------------------------------------------------
// Dedicated GPU: must be decided before the GPU process starts.
// ---------------------------------------------------------------------------
// Settings are read synchronously here because command-line switches only work before "ready".
const userDataEarly = app.getPath('userData');
try { settings = merge(DEFAULTS, JSON.parse(fs.readFileSync(path.join(userDataEarly, 'settings.json'), 'utf8'))); } catch {}

let gpuPreference = { state: 'off' };   // shown translated by the launcher
if (settings.gpu.forceDedicated) {
  // Chromium: pick the high-performance adapter on multi-GPU systems (ANGLE/D3D11 + WebGPU/Dawn).
  app.commandLine.appendSwitch('force_high_performance_gpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  // Windows per-app graphics preference (Settings > Display > Graphics) for this executable.
  // It is the same value Windows writes when you choose "High performance" for an app.
  // Only the first launch from a given path waits for reg.exe (it must be set before the GPU
  // process starts); later launches trust the saved flag and re-check in the background.
  if (process.platform === 'win32') {
    if (settings.gpu.registeredFor === process.execPath) gpuPreference = { state: 'already' };
    else {
      mark('reg sync start');
      gpuPreference = ensureGpuPreference(true);
      if (gpuPreference.state !== 'error') { settings.gpu.registeredFor = process.execPath; saveSettingsEarly(); }
    }
  }
}
function ensureGpuPreference(sync) {
  const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
  const query = ['query', key, '/v', process.execPath];
  const add = ['add', key, '/v', process.execPath, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f'];
  const opts = { encoding: 'utf8', windowsHide: true };
  if (sync) {
    try {
      let current = '';
      try { current = execFileSync('reg', query, opts); } catch {}
      if (/GpuPreference=2;/.test(current)) return { state: 'already' };
      execFileSync('reg', add, opts);
      return { state: 'set' };
    } catch (e) { return { state: 'error', detail: e.message }; }
  }
  // Background check: restores the preference (for the next launch) if it was removed in Windows.
  execFile('reg', query, opts, (_err, out) => {
    if (!/GpuPreference=2;/.test(out || '')) execFile('reg', add, opts, () => {});
  });
  return gpuPreference;
}
function saveSettingsEarly() {
  try { fs.mkdirSync(userDataEarly, { recursive: true }); fs.writeFileSync(path.join(userDataEarly, 'settings.json'), JSON.stringify(settings, null, 2)); } catch {}
}
// ANGLE backends that exist on each system (D3D only on Windows, Metal only on macOS).
const ANGLE_BACKENDS = { win32: ['d3d11', 'd3d11on12', 'vulkan', 'gl'], darwin: ['metal', 'gl'], linux: ['vulkan', 'gl'] }[process.platform] || [];
if (ANGLE_BACKENDS.includes(settings.gpu.angle)) app.commandLine.appendSwitch('use-angle', settings.gpu.angle);
// Games keep running at full speed while another window has focus (FFB is muted then).
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let launcherWin = null;
let gameWin = null;
let activeGame = null;
let gameSession = null;
let offline = null;        // OfflineStore (data/offline)
let offlineMode = false;   // the running game is served from its offline copy
const bridge = new SdlBridge();
let lastGameFfbAt = 0;
let testUntil = 0;
let lastTelemetry = null;

function gameList() {
  return GAMES.map(g => ({
    id: g.id, title: g.title, subtitle: g.subtitle, accent: g.accent,
    url: g.url, repo: g.repo, running: activeGame === g.id,
    offline: offline ? offline.status(g.id) : null, offlineMode: activeGame === g.id && offlineMode,
  }));
}
// Full GPU info takes ~300 ms: computed once in the background, the launcher gets it as an event.
let gpuInfoPromise = null, gpuInfoCache = null;
function gpuInfo() {
  gpuInfoPromise ||= collectGpuInfo().then(info => { gpuInfoCache = info; sendLauncher('gpu', info); return info; });
  return gpuInfoPromise;
}
async function collectGpuInfo() {
  try {
    mark('gpuInfo start');
    const info = await app.getGPUInfo('complete');
    mark('gpuInfo done');
    const devices = (info.gpuDevice || []).map(d => ({
      vendor: d.vendorId, device: d.deviceId, active: !!d.active,
      name: d.deviceString || d.driverVendor || `GPU ${Number(d.vendorId).toString(16)}:${Number(d.deviceId).toString(16)}`,
    }));
    return { devices, renderer: info.auxAttributes?.glRenderer || '', preference: gpuPreference, features: app.getGPUFeatureStatus() };
  } catch (e) { return { devices: [], renderer: '', preference: gpuPreference, error: e.message }; }
}
function sendLauncher(ch, data) { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.webContents.send(ch, data); }
function sendGame(ch, data) { if (gameWin && !gameWin.isDestroyed()) gameWin.webContents.send(ch, data); }

// ---------------------------------------------------------------------------
// SDL3 bridge wiring
// ---------------------------------------------------------------------------
let lastUiInput = 0;
bridge.on('status', st => sendLauncher('bridge:status', st));
bridge.on('opened', () => { bridge.setGain(settings.ffb.deviceGain); });
bridge.on('log', line => sendLauncher('bridge:log', line));
bridge.on('input', inp => {
  const dev = bridge.devices.find(d => d.id === inp.id);
  if (dev) { inp.name = dev.name; inp.vendor = dev.vendor; inp.product = dev.product; }
  if (settings.input.sdlVirtualPad) sendGame('sdl:input', inp);
  const now = Date.now();
  if (now - lastUiInput > 33) { lastUiInput = now; sendLauncher('bridge:input', inp); }
});

// Watchdog: never leave a force running if the game stops sending.
setInterval(() => {
  const now = Date.now();
  if (now < testUntil) return;
  if (testUntil) { testUntil = 0; bridge.zero(); }
  if (now - lastGameFfbAt > 300) bridge.zero();
}, 100);

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createLauncher() {
  launcherWin = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    backgroundColor: '#0b0d12', title: 'Arcade Launcher', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'launcher', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  mark('window created');
  launcherWin.webContents.once('did-finish-load', () => mark('page loaded'));
  launcherWin.once('ready-to-show', () => mark('ready-to-show'));
  launcherWin.loadFile(path.join(__dirname, 'launcher', 'index.html'));
  launcherWin.on('closed', () => { launcherWin = null; if (gameWin && !gameWin.isDestroyed()) gameWin.close(); });
}

// Self-test can simulate a missing connection.
const simulateOffline = !!process.env.ARCADE_SELFTEST_OFFLINE;
const isOnline = () => !simulateOffline && net.isOnline();

function setOfflineMode(on) {
  if (on === offlineMode) return;
  offlineMode = on;
  if (on) offline.enableServing(gameForUrl); else offline.disableServing();
}

async function playGame(id) {
  const game = GAMES.find(g => g.id === id);
  if (!game) throw new Error('Unknown game: ' + id);
  if (gameWin && !gameWin.isDestroyed()) {
    if (activeGame === id) { gameWin.focus(); return; }
    gameWin.close();
  }

  // No connection and a saved copy: serve it on the same address (ROMs and saves are found as usual).
  if (!isOnline() && offline.has(id)) setOfflineMode(true);
  else setOfflineMode(false);
  if (!isOnline() && !offline.has(id)) sendLauncher('launcher:error', { key: 'offline.unavailable', vars: { title: game.title } });

  activeGame = id;
  gameWin = new BrowserWindow({
    width: 1280, height: 960, backgroundColor: '#000000', title: game.title, autoHideMenuBar: true,
    fullscreen: !!settings.window.fullscreen,
    webPreferences: {
      preload: path.join(__dirname, 'game', 'preload.cjs'),
      partition: PARTITION,
      // sandbox off only so the preload can load adapter.js; the page itself stays context-isolated.
      contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  gameWin.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { gameWin.setFullScreen(!gameWin.isFullScreen()); e.preventDefault(); }
    if (input.key === 'F5' && input.control) { gameWin.webContents.reloadIgnoringCache(); e.preventDefault(); }
    if (input.key === 'F12' && input.control) { gameWin.webContents.toggleDevTools(); e.preventDefault(); }
  });
  // Pages of the same game (e.g. spectator.html) stay in the launcher; other links open in the browser.
  gameWin.webContents.setWindowOpenHandler(({ url }) => {
    if (gameForUrl(url)?.id !== id) { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'game', 'preload.cjs'), contextIsolation: true, sandbox: false, nodeIntegration: false } } };
  });
  gameWin.webContents.on('will-navigate', (e, url) => {
    if (gameForUrl(url)?.id !== id) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  gameWin.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return;
    // The connection failed: fall back to the offline copy if there is one.
    if (NETWORK_ERRORS.has(code) && !offlineMode && offline.has(id)) {
      setOfflineMode(true);
      sendLauncher('games', gameList());
      gameWin.loadURL(game.url);
      return;
    }
    sendLauncher('launcher:error', NETWORK_ERRORS.has(code) && !offline.has(id)
      ? { key: 'offline.unavailable', vars: { title: game.title } }
      : { key: 'game.loadFailed', vars: { title: game.title, url, desc } });
  });
  // Online: refresh the offline copy in the background once the game is up (cheap if unchanged).
  gameWin.webContents.on('did-finish-load', () => {
    if (offlineMode) return;
    const wc = gameWin.webContents;
    setTimeout(async () => {
      if (wc.isDestroyed() || offlineMode) return;
      let version = null;
      try { version = await wc.executeJavaScript(`(document.body.innerText.match(/v\\d+\\.\\d+\\.\\d+/) || [null])[0]`); } catch {}
      offline.sync(game, { version });
    }, 8000);
  });
  gameWin.on('blur', () => bridge.zero());
  gameWin.on('closed', () => {
    gameWin = null; activeGame = null; lastTelemetry = null;
    bridge.zero();
    setOfflineMode(false);
    sendLauncher('games', gameList());
  });
  sendLauncher('games', gameList());
  await gameWin.loadURL(game.url);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('launcher:state', async () => { mark('state requested'); const r = await launcherState(); mark('state sent'); return r; });
const launcherState = async () => ({
  games: gameList(), settings, bridge: bridge.status(), gpu: gpuInfoCache, version: app.getVersion(),
  electron: process.versions.electron, chrome: process.versions.chrome,
  platform: process.platform, angleBackends: ANGLE_BACKENDS,
  data: { dir: portable.dir, portable: portable.portable, reason: portable.reason || null, migratedFrom: portable.migratedFrom },
});
ipcMain.handle('launcher:play', async (_e, id) => { await playGame(id); return true; });
ipcMain.handle('launcher:setSettings', (_e, patch) => {
  const before = JSON.stringify(settings.gpu);
  settings = merge(settings, patch);
  saveSettings();
  if (patch?.ffb?.deviceGain !== undefined) bridge.setGain(settings.ffb.deviceGain);
  if (patch?.ffb?.device !== undefined) bridge.openDevice(settings.ffb.device);
  sendGame('settings', { ffb: settings.ffb, input: settings.input, game: settings.games[activeGame] || {} });
  return { settings, restartNeeded: JSON.stringify(settings.gpu) !== before };
});
ipcMain.handle('launcher:offlineSave', (_e, id) => { const g = GAMES.find(x => x.id === id); return g ? offline.sync(g) : null; });
ipcMain.handle('launcher:offlineDelete', async (_e, id) => { if (activeGame === id && offlineMode) return gameList(); await offline.remove(id); return gameList(); });
ipcMain.handle('launcher:openData', () => shell.openPath(portable.dir));
ipcMain.handle('launcher:openRepo', (_e, id) => { const g = GAMES.find(x => x.id === id); if (g) shell.openExternal(g.repo); });
// Drops the cached copy of the games (HTTP cache + service workers), keeping ROMs and saves.
ipcMain.handle('launcher:clearCache', async () => {
  await gameSession.clearCache();
  await gameSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  return true;
});
ipcMain.handle('launcher:refreshDevices', () => { bridge.send('list'); bridge.openDevice(settings.ffb.device); return true; });
ipcMain.handle('launcher:restart', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('launcher:test', (_e, kind) => {
  const s = Math.max(0.2, settings.ffb.strength);
  const tests = {
    left: [-0.6 * s, 0, 0, 0, 0], right: [0.6 * s, 0, 0, 0, 0],
    spring: [0, 0.8 * s, 0, 0, 0], damper: [0, 0, 0.9 * s, 0, 0], rumble: [0, 0, 0, 0, 0.7 * s],
    stop: [0, 0, 0, 0, 0],
  };
  const v = tests[kind] || tests.stop;
  testUntil = kind === 'stop' ? 0 : Date.now() + (kind === 'spring' || kind === 'damper' ? 3000 : 700);
  bridge.ffb(v);
  return true;
});

// Game window <-> main
ipcMain.on('game:init', e => {
  const game = gameForUrl(e.sender.getURL())?.id || (gameWin && e.sender === gameWin.webContents ? activeGame : null);
  e.returnValue = { game, ffb: settings.ffb, input: settings.input, settings: settings.games[game] || {} };
});
ipcMain.on('game:ffb', (e, v) => {
  if (!gameWin || e.sender !== gameWin.webContents || !Array.isArray(v)) return;
  lastGameFfbAt = Date.now();
  if (Date.now() < testUntil) return;
  bridge.ffb(v.map(Number));
});
ipcMain.on('game:telemetry', (e, t) => {
  if (!gameWin || e.sender !== gameWin.webContents) return;
  lastTelemetry = t;
  sendLauncher('game:telemetry', t);
});

// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  mark('app ready');
  loadSettings();
  // The games' own session (GitHub Pages): isolation headers for D2 / Scud.
  gameSession = session.fromPartition(PARTITION);
  installIsolation(gameSession);
  offline = new OfflineStore(path.join(app.getPath('userData'), 'offline'), { session: gameSession, net, isolationHeaders, strict: simulateOffline });
  offline.on('status', () => sendLauncher('games', gameList()));
  const allowed = ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'notifications', 'media'];
  for (const s of [session.defaultSession, gameSession]) s.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.includes(permission)));
  bridge.wantDevice = settings.ffb.device || 0;
  bridge.start();
  createLauncher();
  void gpuInfo();
  if (settings.gpu.forceDedicated && process.platform === 'win32' && gpuPreference.state === 'already') ensureGpuPreference(false);
  if (process.env.ARCADE_SELFTEST) selfTest(process.env.ARCADE_SELFTEST).catch(e => { console.error(e); app.exit(1); });
});

// Automated check: opens each GitHub version, verifies adapter, GPU and isolation, saves screenshots.
async function selfTest(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const report = { gpu: await gpuInfo(), bridge: null, games: {} };
  await wait(2500);
  report.bridge = bridge.status();
  fs.writeFileSync(path.join(outDir, 'launcher.png'), (await launcherWin.webContents.capturePage()).toPNG());
  // Both languages: screenshot + any text that is still a raw i18n key.
  const missingKeys = `[...document.querySelectorAll('body *')].filter(e => !e.children.length && /^[a-z]+(\\.[a-zA-Z0-9]+)+$/.test(e.textContent.trim())).map(e => e.textContent.trim())`;
  report.i18n = {};
  for (const lang of ['es', 'en']) {
    await launcherWin.webContents.executeJavaScript(`document.querySelector('[data-lang="${lang}"]').click()`);
    await wait(500);
    report.i18n[lang] = await launcherWin.webContents.executeJavaScript(`({ htmlLang: document.documentElement.lang, play: document.querySelector('.play').textContent, missing: ${missingKeys} })`);
    fs.writeFileSync(path.join(outDir, `launcher-${lang}.png`), (await launcherWin.webContents.capturePage()).toPNG());
  }
  report.i18n.saved = settings.ui.lang;
  if (process.env.ARCADE_SELFTEST_UI) { fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2)); app.exit(0); return; }
  if (simulateOffline) {
    // Save the copies while the network is still really there, then play with only the copy.
    report.offlineSave = {};
    for (const g of GAMES) { const t0 = Date.now(); report.offlineSave[g.id] = { ...(await offline.sync(g)), seconds: (Date.now() - t0) / 1000 }; }
  }
  for (const g of GAMES) {
    try {
      const consoleErrors = [];
      const started = playGame(g.id);
      gameWin.webContents.on('console-message', e => { if (e.level === 'error') consoleErrors.push(String(e.message).slice(0, 300)); });
      await started;
      await wait(8000);
      report.games[g.id] = await gameWin.webContents.executeJavaScript(`(async () => {
        const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
        const sw = navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1;
        return {
          url: location.href, adapter: !!window.__arcadeAdapter, engine: window.__arcadeAdapter && window.__arcadeAdapter.engineFound(), adapterGame: window.__arcadeAdapter && window.__arcadeAdapter.game,
          coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', serviceWorkers: sw,
          webgpu: a ? (a.info ? { vendor: a.info.vendor, arch: a.info.architecture } : 'sin info') : null,
          telemetry: window.__arcadeAdapter ? window.__arcadeAdapter.read() : null,
          message: document.getElementById('message')?.textContent || '',
          version: (document.body.innerText.match(/v\\d+\\.\\d+\\.\\d+[^\\n]*/) || [''])[0],
          title: document.title,
          offlineWasm: await (async () => { const f = { d1: 'daytona_engine.wasm', d2: 'daytona2.wasm', scud: 'scudplus.wasm' }[window.__arcadeAdapter && window.__arcadeAdapter.game];
            try { const r = await fetch(f); const b = await r.arrayBuffer(); return { file: f, status: r.status, mb: +(b.byteLength / 1048576).toFixed(1) }; } catch (e) { return { file: f, error: String(e) }; } })(),
        };
      })()`);
      report.games[g.id].consoleErrors = consoleErrors.slice(0, 10);
      report.games[g.id].offlineMode = offlineMode;
      // Memory per process (MB): which renderer is the launcher and which the game.
      const pids = { [launcherWin.webContents.getOSProcessId()]: 'launcher', [gameWin.webContents.getOSProcessId()]: 'game' };
      report.games[g.id].memoryMB = app.getAppMetrics().map(m => ({
        type: pids[m.pid] || m.type, mb: Math.round((m.memory?.workingSetSize || 0) / 1024),
        privateMb: Math.round((m.memory?.privateBytes || 0) / 1024),
      }));
      try { fs.writeFileSync(path.join(outDir, `${g.id}.png`), (await gameWin.webContents.capturePage()).toPNG()); }
      catch (e) { report.games[g.id].captureError = e.message; }
      gameWin.close();
      await wait(800);
    } catch (e) { report.games[g.id] = { error: e.message }; }
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  app.exit(0);
}
app.on('window-all-closed', () => { bridge.stop(); app.quit(); });
app.on('before-quit', () => bridge.stop());
