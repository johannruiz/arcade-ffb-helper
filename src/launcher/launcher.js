'use strict';
const api = window.launcher;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let state = null;
let selected = 0;          // index in state.games
let view = 'library';      // library | settings
let sheetOpen = false;

// ---------------------------------------------------------------------------
// i18n (English default, Spanish optional)
// ---------------------------------------------------------------------------
let lang = 'en';
function t(key, vars) {
  const s = (window.I18N[lang] && window.I18N[lang][key]) ?? window.I18N.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m)) : s;
}
function applyStaticText() {
  document.documentElement.lang = lang;
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
  for (const e of document.querySelectorAll('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle);
  for (const e of document.querySelectorAll('[data-i18n-aria]')) e.setAttribute('aria-label', t(e.dataset.i18nAria));
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}
function renderAll() {
  applyStaticText();
  renderUpdate();
  renderLibrary();
  renderStatus();
  renderSettings();
  renderSheet();
  renderHints();
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

function toast(msg, kind = 'error') {
  const e = $('toast');
  e.textContent = msg; e.className = 'toast' + (kind === 'info' ? ' info' : ''); e.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { e.hidden = true; }, 5000);
}
const errMsg = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function set(patch) {
  const r = await api.setSettings(patch);
  state.settings = r.settings;
  if (r.restartNeeded) $('restartRow').hidden = false;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------
const game = () => state.games[selected];

// Icons with transparent edges sit on a white tile; full-bleed ones fill it.
// Each icon is shown as it is: the tile takes the icon's own shape (its opaque area and the
// rounding of its corners), so the selection ring follows the icon instead of cutting it.
// An icon that is a free-form logo (no plate) sits on a white tile with the default rounding.
const iconFit = new Map();   // src -> { plate, radius (fraction of the width), crop (CSS inset) }
function measureIcon(src) {
  return new Promise(resolve => {
    if (iconFit.has(src)) return resolve(iconFit.get(src));
    const done = fit => { iconFit.set(src, fit); resolve(fit); };
    const img = new Image();
    img.onload = () => {
      try {
        const W = Math.min(256, img.naturalWidth || 256), H = Math.min(256, img.naturalHeight || 256);
        const c = document.createElement('canvas'); c.width = W; c.height = H;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
        const px = g.getImageData(0, 0, W, H).data;
        const a = (x, y) => px[(y * W + x) * 4 + 3];
        // The opaque area (transparent margins are not part of the icon's shape).
        let x0 = W, y0 = H, x1 = -1, y1 = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (a(x, y) > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) return done({ plate: false });
        const mx = (x0 + x1) >> 1, my = (y0 + y1) >> 1;
        const plate = [a(mx, y0), a(mx, y1), a(x0, my), a(x1, my)].every(v => v > 200);
        if (!plate) return done({ plate: false });
        // Corner rounding: how far along the diagonal the corner is transparent (a circle of
        // radius r leaves r * (1 - 1/sqrt 2) uncovered there).
        let d = 0; while (d < (x1 - x0) / 2 && a(x0 + d, y0 + d) <= 128) d++;
        const bw = x1 - x0 + 1;
        const radius = Math.min(0.5, d / (1 - Math.SQRT1_2) / bw);
        const pct = (v, total) => `${(v / total * 100).toFixed(2)}%`;
        const crop = `inset(${pct(y0, H)} ${pct(W - 1 - x1, W)} ${pct(H - 1 - y1, H)} ${pct(x0, W)})`;
        done({ plate: true, radius, crop });
      } catch { done({ plate: false }); }
    };
    img.onerror = () => done({ plate: false });
    img.src = src;
  });
}

function renderLibrary() {
  const shelf = $('shelf');
  shelf.replaceChildren(...state.games.map((g, i) => {
    const tile = el('button', 'tile');
    tile.type = 'button';
    tile.setAttribute('role', 'option');
    tile.setAttribute('aria-selected', String(i === selected));
    tile.setAttribute('aria-label', g.title);
    tile.title = g.title;
    tile.style.setProperty('--c', g.accent);
    tile.tabIndex = i === selected ? 0 : -1;
    if (g.icon) {
      const img = el('img'); img.alt = ''; img.src = g.icon; img.draggable = false;
      tile.append(img);
      measureIcon(g.icon).then(f => {
        tile.classList.toggle('padded', !f.plate);
        tile.classList.toggle('plate', !!f.plate);
        if (f.plate) { tile.style.setProperty('--r', f.radius.toFixed(4)); img.style.objectViewBox = f.crop; }
      });
    } else {
      // Reserved for games that do not publish an icon yet.
      tile.classList.add('placeholder');
      tile.insertAdjacentHTML('beforeend', '<svg class="ico"><use href="#i-cabinet"/></svg>');
      tile.append(el('span', 'name', g.title));
    }
    if (g.running) tile.append(el('i', 'badge' + (g.offlineMode ? ' offline' : '')));
    tile.onclick = () => select(i);
    tile.ondblclick = () => play();
    return tile;
  }));
  renderHero();
}

function select(i, focus) {
  if (!state.games.length) return;
  selected = (i + state.games.length) % state.games.length;
  store.set('arcade.selected', game().id);
  for (const [j, tile] of [...$('shelf').children].entries()) {
    tile.setAttribute('aria-selected', String(j === selected));
    tile.tabIndex = j === selected ? 0 : -1;
  }
  const tile = $('shelf').children[selected];
  tile?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  if (focus) tile?.focus();
  renderHero();
}

function fmtPlayed(ms) {
  if (!ms) return t('fact.never');
  const m = Math.floor(ms / 60000);
  if (m < 1) return t('time.lt');
  return m < 60 ? t('time.m', { m }) : t('time.hm', { h: Math.floor(m / 60), m: m % 60 });
}

function offlineText(o) {
  if (!o) return [t('offline.none'), ''];
  if (o.syncing) return [t('offline.saving', { pct: Math.round((o.progress || 0) * 100) }), ''];
  if (o.available) return [`${t('offline.ready')} · ${o.sizeMB} MB`, ''];
  if (o.error) return [t('offline.failed', { error: o.error }), 'warn'];
  return [t('offline.none'), ''];
}

function renderHero() {
  const g = game();
  if (!g) return;
  document.body.style.setProperty('--accent', g.accent);
  const art = $('art');
  art.style.backgroundImage = g.icon ? `url("${g.icon}")` : 'none';
  $('gTitle').textContent = g.title;
  $('gVersion').textContent = g.offline?.version || '';
  $('gDesc').textContent = t('game.desc.' + g.id);
  $('playBtn').querySelector('span').textContent = t(g.running ? 'game.focus' : 'game.play');
  const run = $('gRunning');
  run.hidden = !g.running;
  run.textContent = t(g.offlineMode ? 'game.runningOffline' : 'game.running');
  run.classList.toggle('offline', !!g.offlineMode);
  $('gNote').hidden = !!(g.stats || g.running);
  $('gNote').textContent = t('game.firstRun');

  const [offText, offCls] = offlineText(g.offline);
  const facts = [
    [t('fact.system'), g.subtitle, ''],
    [t('fact.played'), fmtPlayed(g.stats?.playMs), ''],
    [t('fact.offline'), offText, offCls],
  ];
  $('gFacts').replaceChildren(...facts.flatMap(([k, v, cls]) => [el('dt', '', k), el('dd', cls, v)]));
  renderLive();
}

async function play() {
  const g = game();
  if (!g) return;
  const b = $('playBtn');
  b.disabled = true;
  try { await api.play(g.id); } catch (e) { toast(errMsg(e)); }
  b.disabled = false;
}

// ---------------------------------------------------------------------------
// Top bar status: the GPU in use and the controller (opens the sheet)
// ---------------------------------------------------------------------------
const cleanGpu = n => String(n || '').replace(/\((R|TM)\)/gi, '').replace(/\s+/g, ' ').trim();
const isBasicDriver = d => /microsoft basic render/i.test(d.name);
const isIntegrated = name => /intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics/i.test(name) && !/arc a/i.test(name);

function renderStatus() {
  const gpu = state.gpu;
  const gs = $('gpuStat');
  if (!gpu) { $('gpuLabel').textContent = t('status.gpuUnknown'); gs.className = 'stat'; }
  else {
    const real = gpu.devices.filter(d => !isBasicDriver(d));
    const active = real.find(d => d.active) || real[0] || gpu.devices[0];
    const name = cleanGpu(active?.name || gpu.renderer) || t('gfx.unknown');
    const integrated = isIntegrated(name) && real.length > 1;
    $('gpuLabel').textContent = name;
    gs.className = 'stat' + (integrated ? ' warn' : '');
    gs.title = integrated ? `${t('status.integrated')}\n${gpu.renderer}` : gpu.renderer;
  }

  const st = state.bridge;
  const dot = $('deviceDot'), label = $('deviceLabel');
  if (st.missing || !st.running) { dot.className = 'dot bad'; label.textContent = t('device.bridgeDown'); }
  else if (!st.opened) { dot.className = 'dot'; label.textContent = t('device.none'); }
  else { dot.className = 'dot ' + (st.opened.haptic ? 'ok' : 'warn'); label.textContent = st.opened.name; }
}

// ---------------------------------------------------------------------------
// Controller sheet
// ---------------------------------------------------------------------------
const SLIDERS_MAIN = [['strength', 0, 1.5, 0.05], ['minSpring', 0, 0.6, 0.01], ['deviceGain', 0, 100, 1]];
const SLIDERS_FINE = [
  ['constantGain', 0, 2, 0.05], ['springGain', 0, 2, 0.05], ['damperGain', 0, 2, 0.05], ['frictionGain', 0, 2, 0.05],
  ['rumbleGain', 0, 1, 0.05], ['minForce', 0, 0.4, 0.01], ['smoothing', 0, 0.9, 0.05],
];

function openSheet() {
  sheetOpen = true;
  $('sheet').hidden = false; $('scrim').hidden = false;
  renderSheet(); renderHints();
  if (lastInput) renderInput(lastInput);
  $('closeSheet').focus();
}
function closeSheet() {
  sheetOpen = false;
  $('sheet').hidden = true; $('scrim').hidden = true;
  renderHints();
  $('deviceStat').focus();
}

function renderSheet() {
  renderDevice();
  renderSliders('slidersMain', SLIDERS_MAIN);
  renderSliders('slidersFine', SLIDERS_FINE);
  $('perGame').replaceChildren(...state.games.map(g => {
    const row = el('label', 'row');
    const text = el('div'); text.append(el('b', '', g.title), el('small', '', t('ffb.invert')));
    const box = el('input', 'switch'); box.type = 'checkbox';
    box.checked = !!state.settings.games[g.id]?.invert;
    box.onchange = () => set({ games: { [g.id]: { invert: box.checked } } });
    row.append(text, box);
    return row;
  }));
  renderTelemetry(state.telemetry);
}

function renderDevice() {
  const st = state.bridge;
  const opened = st.opened;
  $('sheetTitle').textContent = opened ? opened.name : t(st.running && !st.missing ? 'device.none' : 'device.bridgeDown');
  $('deviceSummary').textContent = st.missing ? t('sdl.missing', { path: st.missing })
    : !opened ? (st.devices.length ? t('device.opening') : t('device.connect'))
    : [t('device.summary', { axes: opened.axes, buttons: opened.buttons, hats: opened.hats }), st.version && t('sdl.version', { version: st.version })].filter(Boolean).join(' · ');

  const sel = $('deviceSelect');
  const want = state.settings.ffb.device || 0;
  sel.replaceChildren(new Option(t('device.auto'), '0'),
    ...st.devices.map(d => new Option(`${d.name}${d.haptic ? ' · FFB' : ''}`, String(d.id))));
  sel.value = st.devices.some(d => d.id === want) ? String(want) : '0';

  const tags = $('fxTags');
  tags.replaceChildren();
  if (opened) {
    const fx = opened.effects || {};
    for (const k of ['constant', 'spring', 'damper', 'friction', 'sine', 'rumble']) if (fx[k]) tags.append(el('span', '', t('fx.' + k)));
    if (!tags.children.length) tags.append(el('span', 'none', t(opened.haptic ? 'device.noEffects' : 'device.noHaptics')));
  }
  // Force feedback settings only for a device that has it (a wheel); a gamepad's vibration is the game's.
  const wheel = !!(opened && opened.haptic && ['constant', 'spring', 'damper', 'friction', 'sine'].some(k => opened.effects?.[k]));
  $('steer').hidden = !opened;
  for (const id of ['fxTags', 'tests', 'ffbGroup', 'perGameGroup', 'liveGroup']) $(id).hidden = !wheel;
  $('noFfb').hidden = wheel;
  $('noFfb').textContent = t(opened ? 'device.noFfbNote' : 'device.connectFfb');
}

function renderSliders(boxId, list) {
  $(boxId).replaceChildren(...list.map(([key, min, max, step]) => {
    const row = el('div', 'slider');
    const id = 's_' + key;
    row.innerHTML = `<div class="top"><label for="${id}"></label><output></output></div><small></small><input type="range" id="${id}" min="${min}" max="${max}" step="${step}">`;
    row.querySelector('label').textContent = t('slider.' + key);
    row.querySelector('small').textContent = t('slider.' + key + '.help');
    const input = row.querySelector('input'), out = row.querySelector('output');
    const fmt = v => key === 'deviceGain' ? `${Math.round(v)}%` : `${Math.round(v * 100)}%`;
    input.value = state.settings.ffb[key]; out.textContent = fmt(Number(input.value));
    let pending;
    input.oninput = () => {
      out.textContent = fmt(Number(input.value));
      clearTimeout(pending); pending = setTimeout(() => set({ ffb: { [key]: Number(input.value) } }), 60);
    };
    return row;
  }));
}

// Wheel position in the sheet, and the wheel's d-pad / first button in the library.
let lastHat = 0, lastBtn0 = false, lastInput = null;
function renderInput(inp) {
  lastInput = inp;
  if (sheetOpen) {
    const steer = inp.axes[0] ?? 0;
    $('steerDot').style.left = `calc(${(steer + 1) * 50}% - 8px)`;
    const axes = $('axes');
    if (axes.children.length !== inp.axes.length || axes.dataset.lang !== lang) {
      axes.dataset.lang = lang;
      axes.replaceChildren(...inp.axes.map((_, i) => {
        const d = el('div', 'axis', t('device.axis', { n: i }));
        d.append(Object.assign(el('i'), { innerHTML: '<b></b>' }));
        return d;
      }));
    }
    inp.axes.forEach((v, i) => { axes.children[i].querySelector('b').style.width = `${(v + 1) * 50}%`; });
  }
  const hat = inp.hats[0] || 0, btn0 = !!inp.buttons[0];
  if (document.hasFocus() && !sheetOpen && view === 'library') {
    if ((hat & 8) && !(lastHat & 8)) select(selected - 1);
    if ((hat & 2) && !(lastHat & 2)) select(selected + 1);
    if (btn0 && !lastBtn0) play();
  }
  lastHat = hat; lastBtn0 = btn0;
}

const METERS = [['constant', true], ['spring'], ['damper'], ['friction'], ['rumble']];
const OUT_IDX = { constant: 0, spring: 1, damper: 2, friction: 3, rumble: 4 };
function telemetryMode(tel) { return tel.active ? t(tel.live ? 'live.racing' : 'live.menu') : t('live.unfocused'); }
function renderTelemetry(tel) {
  state.telemetry = tel || null;
  renderLive();
  if (!sheetOpen) return;
  const box = $('meters');
  if (!tel) { $('telState').textContent = t('live.idle'); box.replaceChildren(); return; }
  const g = state.games.find(x => x.id === tel.game);
  $('telState').textContent = `${g?.title || tel.game} · ${telemetryMode(tel)}${tel.speed != null ? ` · ${Math.round(tel.speed)} km/h` : ''}`;
  if (box.children.length !== METERS.length || box.dataset.lang !== lang) {
    box.dataset.lang = lang;
    box.replaceChildren(...METERS.map(([k, signed]) => {
      const m = el('div', 'meter');
      m.append(el('div', '', t('meter.' + k)), Object.assign(el('div', 'bar' + (signed ? ' signed' : '')), { innerHTML: '<b></b>' }), el('span'));
      m.dataset.k = k; m.dataset.signed = signed ? '1' : '';
      return m;
    }));
  }
  for (const m of box.children) {
    const v = tel.out[OUT_IDX[m.dataset.k]] || 0;
    const b = m.querySelector('b');
    if (m.dataset.signed) { b.style.left = `${50 + Math.min(0, v) * 50}%`; b.style.width = `${Math.abs(v) * 50}%`; }
    else { b.style.left = '0'; b.style.width = `${v * 100}%`; }
    m.querySelector('span').textContent = v.toFixed(2);
  }
}
// The selected game's force, under its Play button while it runs.
function renderLive() {
  const tel = state.telemetry, g = game();
  const on = !!(tel && g && g.running && tel.game === g.id);
  $('live').hidden = !on;
  if (!on) return;
  $('liveLabel').textContent = `${t('meter.constant')} · ${telemetryMode(tel)}${tel.speed != null ? ` · ${Math.round(tel.speed)} km/h` : ''}`;
  const v = tel.out[0] || 0, b = $('liveForce');
  b.style.left = `${50 + Math.min(0, v) * 50}%`; b.style.width = `${Math.abs(v) * 50}%`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function renderSettings() {
  const gpu = state.gpu;
  if (gpu) {
    const list = gpu.devices.filter(d => !isBasicDriver(d));
    $('gpuList').replaceChildren(...(list.length ? list : gpu.devices).map(d => {
      const e = el('div', d.active ? 'active' : '', cleanGpu(d.name));
      if (d.active) e.append(el('em', '', t('gfx.active')));
      return e;
    }));
    const pref = gpu.preference || {};
    $('gpuNote').textContent = pref.state ? t('gpu.' + pref.state, { detail: pref.detail || '' }) : '';
  }
  $('offlineList').replaceChildren(...state.games.map(g => {
    const o = g.offline || {};
    const row = el('div', 'row');
    const text = el('div'); text.append(el('b', '', g.title));
    const [offText] = offlineText(o);
    const date = o.available && o.savedAt ? new Date(o.savedAt).toLocaleDateString(lang) : '';
    text.append(el('small', '', [o.available && o.version, offText, date].filter(Boolean).join(' · ')));
    const right = el('div', 'right');
    const dot = el('span', 'state'); dot.append(el('i', 'dot ' + (o.available ? 'ok' : o.error ? 'warn' : '')));
    right.append(dot);
    if (!o.syncing && !(o.available && g.offlineMode)) {
      const b = el('button', '', t(o.available ? 'offline.delete' : 'offline.save'));
      b.onclick = async () => {
        b.disabled = true;
        try {
          if (o.available) { state.games = await api.offlineDelete(g.id); renderLibrary(); renderSettings(); }
          else await api.offlineSave(g.id);
        } catch (e) { toast(errMsg(e)); }
        b.disabled = false;
      };
      right.append(b);
    }
    row.append(text, right);
    return row;
  }));
  $('repoList').replaceChildren(...state.games.map(g => {
    const row = el('div', 'row');
    const text = el('div'); text.append(el('b', '', g.title), el('small', '', g.url.replace(/^https:\/\//, '')));
    const b = el('button', '', t('about.source'));
    b.onclick = () => api.openRepo(g.id).catch(e => toast(errMsg(e)));
    row.append(text, b);
    return row;
  }));
  $('versions').textContent = t('versions', { version: state.version, electron: state.electron, chrome: state.chrome });
  $('dataKind').textContent = t(state.data.portable ? 'data.portable' : state.data.reason === 'installed' ? 'data.installed' : 'data.appdata');
  $('dataDir').textContent = state.data.dir;
}

// ---------------------------------------------------------------------------
// Launcher updates (GitHub Releases): a pill in the top bar once one is ready, details in Settings
// ---------------------------------------------------------------------------
function renderUpdate() {
  const u = state.update;
  const pill = $('updatePill'), btn = $('updateBtn'), status = $('updateStatus');
  if (!u) { pill.hidden = true; btn.hidden = true; status.textContent = ''; $('updateAutoRow').hidden = true; return; }
  const vars = { current: u.current, latest: u.latest, pct: Math.round((u.progress || 0) * 100), mb: Math.round((u.size || 0) / 1048576), error: u.error || '' };
  status.textContent = u.status === 'unsupported' ? t('update.reason.' + u.reason) : t('update.status.' + u.status, vars);
  $('updateAutoRow').hidden = u.status === 'unsupported';
  pill.hidden = u.status !== 'ready';
  $('updatePillText').textContent = t('update.pill', vars);
  pill.title = t('update.pillTitle', vars);
  const action = { idle: 'check', upToDate: 'check', error: 'check', available: 'download', ready: 'restart' }[u.status];
  btn.hidden = u.status === 'unsupported';
  btn.disabled = !action;
  btn.className = u.status === 'ready' ? 'primary' : '';
  btn.textContent = action ? t('update.' + action) : u.status === 'unsupported' ? '' : t('update.status.' + u.status, vars);
  btn.dataset.action = action || '';
}
async function updateAction(action) {
  try {
    if (action === 'check') await api.updateCheck();
    else if (action === 'download') await api.updateDownload();
    else if (action === 'restart') await api.updateApply();
  } catch (e) { toast(errMsg(e)); }
}

// ---------------------------------------------------------------------------
// Views, hints, keyboard
// ---------------------------------------------------------------------------
function showView(v) {
  view = v;
  document.body.dataset.view = v;
  $('view-library').hidden = v !== 'library';
  $('view-settings').hidden = v !== 'settings';
  for (const b of document.querySelectorAll('.tabs [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  renderHints();
}

function renderHints() {
  const items = sheetOpen ? [['Esc', 'hint.close']]
    : view === 'settings' ? [['Esc', 'hint.back']]
    : [['← →', 'hint.choose'], ['Enter', 'hint.play'], ['C', 'hint.device'], ['S', 'hint.settings']];
  $('hints').replaceChildren(...items.map(([k, key]) => {
    const h = el('span', 'hint'); h.append(el('kbd', '', k), t(key)); return h;
  }));
}

document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = e.target?.tagName;
  const typing = tag === 'SELECT' || (tag === 'INPUT' && e.target.type === 'range');
  if (e.key === 'Escape') {
    if (sheetOpen) closeSheet(); else if (view !== 'library') showView('library');
    return;
  }
  if (sheetOpen || typing) return;
  if (view === 'library') {
    if (e.key === 'ArrowLeft') { select(selected - 1, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { select(selected + 1, true); e.preventDefault(); }
    else if (e.key === 'Enter' && (tag === 'BODY' || e.target.classList?.contains('tile'))) { play(); e.preventDefault(); }
  }
  if (e.key === 'c' || e.key === 'C') openSheet();
  else if (e.key === 's' || e.key === 'S') showView(view === 'settings' ? 'library' : 'settings');
});

// ---------------------------------------------------------------------------
async function init() {
  state = await api.state();
  lang = state.settings.ui?.lang === 'es' ? 'es' : 'en';
  const saved = state.games.findIndex(g => g.id === store.get('arcade.selected'));
  selected = saved >= 0 ? saved : 0;
  renderAll();
  showView('library');

  const bind = (id, get, patch) => { const e = $(id); get(e); e.onchange = () => set(patch(e)); };
  bind('ffbEnabled', e => { e.checked = state.settings.ffb.enabled; }, e => ({ ffb: { enabled: e.checked } }));
  bind('sdlVirtualPad', e => { e.checked = !!state.settings.input.sdlVirtualPad; }, e => ({ input: { sdlVirtualPad: e.checked } }));
  bind('fullscreen', e => { e.checked = state.settings.window.fullscreen; }, e => ({ window: { fullscreen: e.checked } }));
  bind('updateAuto', e => { e.checked = state.settings.update?.auto !== false; }, e => ({ update: { auto: e.checked } }));
  $('updateBtn').onclick = () => updateAction($('updateBtn').dataset.action);
  $('updatePill').onclick = () => updateAction('restart');
  api.onUpdate(u => { state.update = { ...state.update, ...u }; renderUpdate(); });
  if (state.update?.failedNotice) toast(t('update.failed', { version: state.update.failedNotice }));
  bind('forceDedicated', e => { e.checked = state.settings.gpu.forceDedicated; }, e => ({ gpu: { forceDedicated: e.checked } }));
  $('deviceSelect').onchange = e => set({ ffb: { device: Number(e.target.value) } });
  $('refreshDevices').onclick = () => api.refreshDevices();
  $('restartBtn').onclick = () => api.restart();
  $('openData').onclick = () => api.openData();
  $('playBtn').onclick = play;
  $('deviceStat').onclick = openSheet;
  $('closeSheet').onclick = closeSheet;
  $('scrim').onclick = closeSheet;
  for (const b of document.querySelectorAll('.tabs [data-view]')) b.onclick = () => showView(b.dataset.view);
  for (const b of document.querySelectorAll('[data-test]')) b.onclick = () => api.test(b.dataset.test);
  for (const b of document.querySelectorAll('[data-lang]')) {
    b.onclick = async () => {
      if (b.dataset.lang === lang) return;
      lang = b.dataset.lang;
      renderAll();
      await set({ ui: { lang } });
    };
  }
  $('clearCache').onclick = async () => {
    try { await api.clearCache(); toast(t('games.cacheCleared'), 'info'); }
    catch (e) { toast(errMsg(e)); }
  };
  if (state.data.migratedFrom) toast(t('data.migrated', { from: state.data.migratedFrom }), 'info');

  api.onError(err => toast(err?.key ? t(err.key, err.vars) : String(err)));
  api.onBridgeStatus(st => { state.bridge = st; renderStatus(); if (sheetOpen) renderDevice(); });
  api.onGpu(gpu => { state.gpu = gpu; renderStatus(); renderSettings(); });
  api.onBridgeInput(renderInput);
  api.onGames(games => {
    const id = game()?.id;
    state.games = games;
    selected = Math.max(0, games.findIndex(g => g.id === id));
    if (!games.some(g => g.running)) state.telemetry = null;
    renderLibrary(); renderSettings();
    if (sheetOpen) renderTelemetry(state.telemetry);
  });
  api.onTelemetry(renderTelemetry);
  api.onBridgeLog(line => { if (/^error/.test(line) && !/no joystick/.test(line)) toast(t('sdl.errorPrefix') + line); console.log('[sdl]', line); });
}
init().catch(e => toast(errMsg(e)));
