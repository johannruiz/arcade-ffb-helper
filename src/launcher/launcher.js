'use strict';
const api = window.launcher;
const $ = id => document.getElementById(id);
let state = null;

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
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const b of document.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
}
function renderAll() {
  applyStaticText();
  renderGames(state.games);
  renderSliders();
  renderBridge(state.bridge);
  renderGpu(state.gpu);
  $('meters').replaceChildren();
  if (state.telemetry) renderTelemetry(state.telemetry);
  $('versions').textContent = t('versions', { version: state.version, electron: state.electron, chrome: state.chrome });
  $('dataDir').textContent = t(state.data.portable ? 'data.portable' : state.data.reason === 'installed' ? 'data.installed' : 'data.appdata', { dir: state.data.dir });
  $('dataDir').title = state.data.dir;
}

const SLIDERS = [
  ['strength', 0, 1.5, 0.05], ['constantGain', 0, 2, 0.05], ['springGain', 0, 2, 0.05], ['minSpring', 0, 0.6, 0.01],
  ['damperGain', 0, 2, 0.05], ['frictionGain', 0, 2, 0.05], ['rumbleGain', 0, 1, 0.05], ['minForce', 0, 0.4, 0.01],
  ['smoothing', 0, 0.9, 0.05], ['deviceGain', 0, 100, 1],
];

function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg; el.className = 'toast' + (kind === 'info' ? ' info' : ''); el.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 5000);
}
const errMsg = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function set(patch) {
  const r = await api.setSettings(patch);
  state.settings = r.settings;
  if (r.restartNeeded) $('restartBtn').hidden = false;
}

// ---------------------------------------------------------------------------
function renderGames(games) {
  state.games = games;
  const grid = $('gameGrid');
  grid.replaceChildren(...games.map(g => {
    const card = document.createElement('article');
    card.className = 'game'; card.style.setProperty('--c', g.accent);
    const gs = state.settings.games[g.id] || {};
    card.innerHTML = `
      ${g.running ? '<span class="badge"></span>' : ''}
      <h3></h3><div class="sub"></div>
      <div class="ffb-src"></div>
      <div class="path"></div>
      <div class="offline"><span class="offline-text"></span><button class="link" data-act="offline"></button></div>
      <div class="opts">
        <label class="toggle"><input type="checkbox" data-k="invert"><span></span></label>
      </div>
      <div class="row">
        <button class="play"></button>
        <button class="ghost small" data-act="repo">GitHub</button>
      </div>`;
    const badge = card.querySelector('.badge'); if (badge) { badge.textContent = t(g.offlineMode ? 'game.runningOffline' : 'game.running'); badge.classList.toggle('off', !!g.offlineMode); }
    renderOffline(card, g);
    card.querySelector('h3').textContent = g.title;
    card.querySelector('.sub').textContent = g.subtitle;
    card.querySelector('.ffb-src').textContent = t('game.ffb.' + g.id);
    card.querySelector('.opts span').textContent = t('game.invert');
    const p = card.querySelector('.path'); p.textContent = g.url.replace(/^https:\/\//, ''); p.title = g.url;
    const play = card.querySelector('.play');
    play.textContent = t(g.running ? 'game.focus' : 'game.play');
    play.onclick = async () => {
      play.disabled = true;
      try { await api.play(g.id); } catch (e) { toast(errMsg(e)); }
      play.disabled = false;
    };
    for (const box of card.querySelectorAll('input[data-k]')) {
      box.checked = !!gs[box.dataset.k];
      box.onchange = () => set({ games: { [g.id]: { [box.dataset.k]: box.checked } } });
    }
    card.querySelector('[data-act="offline"]').onclick = async () => {
      const o = g.offline;
      try {
        if (o?.available && !o.syncing) renderGames(await api.offlineDelete(g.id));
        else if (!o?.syncing) await api.offlineSave(g.id);
      } catch (e) { toast(errMsg(e)); }
    };
    card.querySelector('[data-act="repo"]').onclick = () => api.openRepo(g.id).catch(e => toast(errMsg(e)));
    return card;
  }));
}

function renderOffline(card, g) {
  const o = g.offline || {};
  const text = card.querySelector('.offline-text'), btn = card.querySelector('[data-act="offline"]');
  const box = card.querySelector('.offline');
  box.dataset.state = o.syncing ? 'syncing' : o.available ? 'ready' : o.error ? 'error' : 'none';
  if (o.syncing) {
    text.textContent = t('offline.saving', { pct: Math.round((o.progress || 0) * 100) });
    btn.hidden = true;
  } else if (o.available) {
    const date = o.savedAt ? new Date(o.savedAt).toLocaleDateString(lang) : '';
    text.textContent = [t('offline.ready'), o.version, `${o.sizeMB} MB`, date].filter(Boolean).join(' · ');
    btn.hidden = !!g.offlineMode; btn.textContent = t('offline.delete');
  } else {
    text.textContent = o.error ? t('offline.failed', { error: o.error }) : t('offline.none');
    btn.hidden = false; btn.textContent = t('offline.save');
  }
}

// ---------------------------------------------------------------------------
function renderSliders() {
  const box = $('sliders');
  box.replaceChildren(...SLIDERS.map(([key, min, max, step]) => {
    const row = document.createElement('div');
    row.className = 'slider';
    const id = 's_' + key;
    row.innerHTML = `<label for="${id}"></label><output></output><input type="range" id="${id}" min="${min}" max="${max}" step="${step}"><small></small>`;
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

function renderBridge(st) {
  state.bridge = st;
  const chip = $('sdlChip');
  const opened = st.opened;
  if (st.missing) { chip.className = 'chip bad'; chip.textContent = t('sdl.stopped'); chip.title = t('sdl.missing', { path: st.missing }); }
  else if (!st.running) { chip.className = 'chip bad'; chip.textContent = t('sdl.stopped'); chip.title = ''; }
  else if (!opened) { chip.className = 'chip warn'; chip.textContent = t('sdl.noWheel', { version: st.version || '' }); chip.title = ''; }
  else { chip.className = 'chip ' + (opened.haptic ? 'ok' : 'warn'); chip.textContent = `${opened.name} · ${t(opened.haptic ? 'sdl.ffb' : 'sdl.noFfb')}`; chip.title = ''; }

  const sel = $('deviceSelect');
  const want = state.settings.ffb.device || 0;
  sel.replaceChildren(new Option(t('wheel.auto'), '0'),
    ...st.devices.map(d => new Option(`${d.name}${d.haptic ? ' · FFB' : ''}`, String(d.id))));
  sel.value = st.devices.some(d => d.id === want) ? String(want) : '0';

  const info = $('deviceInfo');
  if (!opened) { info.textContent = st.devices.length ? t('wheel.opening') : t('wheel.connect'); return; }
  const fx = opened.effects || {};
  info.replaceChildren(t('wheel.summary', { axes: opened.axes, buttons: opened.buttons, hats: opened.hats }));
  const tags = document.createElement('div'); tags.className = 'feature-tags';
  for (const k of ['constant', 'spring', 'damper', 'friction', 'sine', 'rumble']) {
    if (fx[k]) { const s = document.createElement('span'); s.textContent = t('fx.' + k); tags.append(s); }
  }
  if (!tags.children.length) { const s = document.createElement('span'); s.textContent = t(opened.haptic ? 'wheel.noEffects' : 'wheel.noHaptics'); tags.append(s); }
  info.append(tags);
}

function renderInput(inp) {
  const steer = inp.axes[0] ?? 0;
  $('steerDot').style.left = `calc(${(steer + 1) * 50}% - 8px)`;
  const axes = $('axes');
  if (axes.children.length !== inp.axes.length || axes.dataset.lang !== lang) {
    axes.dataset.lang = lang;
    axes.replaceChildren(...inp.axes.map((_, i) => {
      const d = document.createElement('div'); d.className = 'axis';
      d.append(t('wheel.axis', { n: i })); d.append(Object.assign(document.createElement('i'), { innerHTML: '<b></b>' }));
      return d;
    }));
  }
  inp.axes.forEach((v, i) => { axes.children[i].querySelector('b').style.width = `${(v + 1) * 50}%`; });
}

function renderGpu(gpu) {
  state.gpu = gpu;
  if (!gpu) return;   // arrives a moment later via api.onGpu
  const active = gpu.devices.find(d => d.active) || gpu.devices[0];
  const chip = $('gpuChip');
  const name = active?.name || gpu.renderer || t('gfx.unknown');
  const integrated = /intel|uhd|iris|radeon\(tm\) graphics|vega \d+ graphics/i.test(name) && !/arc a/i.test(name);
  chip.className = 'chip ' + (integrated ? 'warn' : 'ok');
  chip.textContent = name; chip.title = gpu.renderer;
  $('gpuList').replaceChildren(...gpu.devices.map(d => {
    const el = document.createElement('div'); el.className = 'gpu' + (d.active ? ' active' : '');
    el.textContent = d.name;
    if (d.active) { const em = document.createElement('em'); em.textContent = t('gfx.active'); el.append(em); }
    return el;
  }));
  const pref = gpu.preference || {};
  $('gpuNote').textContent = pref.state ? t('gpu.' + pref.state, { detail: pref.detail || '' }) : '';
}

const METERS = [['constant', true], ['spring'], ['damper'], ['friction'], ['rumble']];
function renderTelemetry(tel) {
  state.telemetry = tel;
  $('telemetryPanel').hidden = false;
  const game = state.games.find(g => g.id === tel.game);
  const mode = tel.active ? t(tel.live ? 'live.racing' : 'live.menu') : t('live.unfocused');
  $('telGame').textContent = `${game?.title || tel.game} · ${mode}${tel.speed != null ? ` · ${Math.round(tel.speed)} km/h` : ''}`;
  const box = $('meters');
  if (!box.children.length) {
    box.replaceChildren(...METERS.map(([k, signed]) => {
      const m = document.createElement('div'); m.className = 'meter';
      m.innerHTML = `<span></span><div class="bar${signed ? ' signed' : ''}"><b></b></div>`;
      m.prepend(t('meter.' + k));
      m.dataset.k = k; m.dataset.signed = signed ? '1' : '';
      return m;
    }));
  }
  const outIdx = { constant: 0, spring: 1, damper: 2, friction: 3, rumble: 4 };
  for (const m of box.children) {
    const v = tel.out[outIdx[m.dataset.k]] || 0;
    const b = m.querySelector('b');
    if (m.dataset.signed) { b.style.left = `${50 + Math.min(0, v) * 50}%`; b.style.width = `${Math.abs(v) * 50}%`; }
    else { b.style.left = '0'; b.style.width = `${v * 100}%`; }
    m.querySelector('span').textContent = v.toFixed(2);
  }
}

// ---------------------------------------------------------------------------
async function init() {
  state = await api.state();
  lang = state.settings.ui?.lang === 'es' ? 'es' : 'en';
  renderAll();

  const bind = (id, get, patch) => { const el = $(id); get(el); el.onchange = () => set(patch(el)); };
  bind('ffbEnabled', el => { el.checked = state.settings.ffb.enabled; }, el => ({ ffb: { enabled: el.checked } }));
  bind('sdlVirtualPad', el => { el.checked = state.settings.input.sdlVirtualPad; }, el => ({ input: { sdlVirtualPad: el.checked } }));
  bind('fullscreen', el => { el.checked = state.settings.window.fullscreen; }, el => ({ window: { fullscreen: el.checked } }));
  bind('forceDedicated', el => { el.checked = state.settings.gpu.forceDedicated; }, el => ({ gpu: { forceDedicated: el.checked } }));
  // Only the ANGLE backends this system has, plus Automatic.
  for (const o of [...$('angle').options]) if (o.value !== 'default' && !state.angleBackends.includes(o.value)) o.remove();
  bind('angle', el => { el.value = state.angleBackends.includes(state.settings.gpu.angle) ? state.settings.gpu.angle : 'default'; }, el => ({ gpu: { angle: el.value } }));
  $('deviceSelect').onchange = e => set({ ffb: { device: Number(e.target.value) } });
  $('refreshDevices').onclick = () => api.refreshDevices();
  $('restartBtn').onclick = () => api.restart();
  $('openData').onclick = () => api.openData();
  if (state.data.migratedFrom) toast(t('data.migrated', { from: state.data.migratedFrom }), 'info');
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

  api.onError(err => toast(err?.key ? t(err.key, err.vars) : String(err)));
  api.onBridgeStatus(renderBridge);
  api.onGpu(renderGpu);
  api.onBridgeInput(renderInput);
  api.onGames(games => {
    renderGames(games);
    if (!games.some(g => g.running)) { state.telemetry = null; $('telemetryPanel').hidden = true; $('meters').replaceChildren(); }
  });
  api.onTelemetry(renderTelemetry);
  api.onBridgeLog(line => { if (/^error/.test(line) && !/no joystick/.test(line)) toast(t('sdl.errorPrefix') + line); console.log('[sdl]', line); });
}
init().catch(e => toast(errMsg(e)));
