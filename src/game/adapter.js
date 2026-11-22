// Arcade Launcher game adapter. The game preload runs it in the page's main world
// with contextBridge.executeInMainWorld, before any game script (needed to hook
// Daytona's module factory). It is serialized with toString(): keep it self-contained.
//
// 1. Forces the high-performance GPU in WebGPU / WebGL requests.
// 2. Reads each game's drive-board force feedback and sends it to the SDL3 bridge.
// 3. Optionally exposes the SDL3 wheel as an extra gamepad (raw mapping) so the
//    game's own wheel menu can bind wheels that Chromium reads badly.
module.exports = function arcadeAdapter() {
  'use strict';
  const L = window.arcadeLauncher;
  if (!L || window.__arcadeAdapter) return;
  const GAME = L.init.game;
  let ffbCfg = L.init.ffb || {};
  let inputCfg = L.init.input || {};
  let gameCfg = L.init.settings || {};
  L.onSettings(s => { ffbCfg = s.ffb || ffbCfg; inputCfg = s.input || inputCfg; gameCfg = s.game || gameCfg; });

  // -------------------------------------------------------------------------
  // 1. High-performance GPU
  // -------------------------------------------------------------------------
  if (navigator.gpu?.requestAdapter) {
    const req = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = (opts = {}) => req({ ...opts, powerPreference: 'high-performance' });
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (typeof type === 'string' && /^(webgl2?|experimental-webgl)$/.test(type)) attrs = { ...(attrs || {}), powerPreference: 'high-performance' };
    return getContext.call(this, type, attrs);
  };

  // -------------------------------------------------------------------------
  // 2. Telemetry per game -> { constant, spring, damper, friction, rumble, speed, live }
  // -------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : 0));
  const overlayOpen = () => { const o = document.getElementById('overlay'); return !!o && !o.hidden; };
  const idle = { constant: 0, spring: 0, damper: 0, friction: 0, rumble: 0, speed: null, live: false };

  // Daytona USA: capture the Emscripten module from its global factory.
  let d1Module = null;
  if (GAME === 'd1') {
    let factory;
    Object.defineProperty(window, 'createDaytonaModule', {
      configurable: true, enumerable: true,
      get: () => factory,
      set: f => {
        factory = typeof f !== 'function' ? f : async function (...args) {
          const m = await f.apply(this, args);
          d1Module = m;
          return m;
        };
      },
    });
  }
  let boardSeen = false;   // the page runs its drive board program (Daytona USA 2, Scud Race)
  const readers = {
    d1() {
      const m = d1Module;
      if (!m || typeof m._daytona_wheel_force !== 'function') return idle;
      const force = m._daytona_wheel_force() || 0;
      const resistance = m._daytona_wheel_resistance?.() || 0;
      const rumble = Math.max(m._daytona_rumble_strong?.() || 0, m._daytona_rumble_weak?.() || 0);
      return { constant: clamp(force, -1, 1), spring: 0, damper: clamp(resistance, 0, 1), friction: 0, rumble: clamp(rumble, 0, 1), speed: null, live: !overlayOpen() };
    },
    d2() {
      // Since the Daytona USA 2 web page runs its drive board's Z80 program (2026-11-21), the page
      // gives that board's own forces, as Scud: window.arcadeForceFeedback.read() (constant -1..1,
      // + = right; spring, damper, friction, rumble 0..1; live false and all 0 in pause and menus).
      // This board centres the wheel with its torque: spring stays 0 (the base spring applies).
      // The API is used once the board's program has been seen running (host.ffb[7] = 1): a ROM set
      // without that program never makes it live, and then the older reading below still works.
      const h = window.__d2?.host;
      const api = window.arcadeForceFeedback;
      if (h?.ffb?.[7] === 1) boardSeen = true;
      if (boardSeen && api?.version >= 1 && api.game === 'd2' && typeof api.read === 'function') {
        const f = api.read();
        return { constant: clamp(f.constant, -1, 1), spring: clamp(f.spring, 0, 1), damper: clamp(f.damper, 0, 1), friction: clamp(f.friction, 0, 1), rumble: clamp(f.rumble, 0, 1), speed: null, live: !!f.live };
      }
      // Older pages (or no drive board program): the control block's word 14, a reading of the
      // game's commands, and the pad's rumble.
      if (!h?.ctlF) return idle;
      const force = h.module?._dayto_web_wheel_force ? h.module._dayto_web_wheel_force() : h.ctlF[14];
      const rumble = Math.max(h.ctlF[12] || 0, h.ctlF[13] || 0);
      return { constant: clamp(force, -1, 1), spring: 0, damper: 0, friction: 0, rumble: clamp(rumble, 0, 1), speed: null, live: !overlayOpen() };
    },
    scud() {
      const h = window.__scud?.host || window.__d2?.host;
      if (!h?.ctl) return idle;
      // Since Scud Race Plus web 0.11 (2026-11-21) the page gives the drive board's own forces,
      // from the board's Z80 program: window.arcadeForceFeedback.read() (constant -1..1, + = right;
      // spring, damper, friction, rumble 0..1; live false and all 0 in pause and menus).
      // Older pages: the control block's words 14-18, a reading of the game's commands.
      // As for Daytona USA 2: the API once the board's program has been seen running.
      const api = window.arcadeForceFeedback;
      if (h.ffb?.[7] === 1) boardSeen = true;
      let t;
      if (boardSeen && api?.version >= 1 && api.game === 'scud' && typeof api.read === 'function') {
        const f = api.read();
        t = { constant: clamp(f.constant, -1, 1), spring: clamp(f.spring, 0, 1), damper: clamp(f.damper, 0, 1), friction: clamp(f.friction, 0, 1), rumble: clamp(f.rumble, 0, 1), board: true, boardLive: !!f.live };
      } else {
        const valid = h.ctl[18];
        t = valid
          ? { constant: clamp(h.ctl[17] / 15, -1, 1), spring: clamp(h.ctl[14] / 15, 0, 1), damper: 0, friction: clamp(h.ctl[15] / 15, 0, 1), rumble: clamp(h.ctl[16] / 15, 0, 1) }
          : { constant: 0, spring: 0, damper: 0, friction: 0, rumble: 0 };
      }
      // Player car speed (Scud RAM): pointer at 0x1045A0, float at car+52, 1.5 ~ 320 km/h.
      let speed = null;
      try {
        const ram = h.ramPtr;
        if (ram) {
          const dv = new DataView(h.ctl.buffer);
          if (dv.getUint8(ram + 0x104005) !== 0x04) {
            const car = dv.getUint32(ram + 0x1045A0, false) & 0xFFFFFF;
            if (car >= 0x100000 && car <= 0x7F0000) {
              const v = dv.getFloat32(ram + car + 52, false);
              if (v > 0 && v < 10) speed = v / 1.5 * 320;
            }
          }
        }
      } catch {}
      const { board, boardLive, ...forces } = t;
      return { ...forces, speed, live: board ? boardLive : !overlayOpen() };
    },
  };
  const read = readers[GAME] || (() => idle);

  // -------------------------------------------------------------------------
  // Shaping + send loop (125 Hz, independent of the game's frame rate)
  // -------------------------------------------------------------------------
  let smoothed = 0, lastTel = 0;
  function tick() {
    let t;
    try { t = read(); } catch { t = idle; }
    const c = ffbCfg;
    const active = c.enabled !== false && document.hasFocus() && !document.hidden;
    let out = [0, 0, 0, 0, 0, 0];
    if (active) {
      const s = clamp(c.strength ?? 0.8, 0, 1.5);
      let k = t.constant * (c.constantGain ?? 1) * (gameCfg.invert ? -1 : 1);
      const mf = clamp(c.minForce ?? 0, 0, 0.5);
      if (Math.abs(k) > 0.003 && mf > 0) k = Math.sign(k) * (mf + (1 - mf) * Math.min(1, Math.abs(k)));
      const a = clamp(c.smoothing ?? 0.25, 0, 0.95);
      smoothed += (k - smoothed) * (1 - a);
      // Speed-sensitive base spring when the game reports speed; otherwise a fixed base while racing.
      const speedFactor = t.speed == null ? 1 : 0.4 + 0.6 * clamp(t.speed / 200, 0, 1);
      const base = t.live ? clamp(c.minSpring ?? 0, 0, 1) * speedFactor : 0;
      out = [
        clamp(smoothed * s, -1, 1),
        clamp(Math.max(t.spring * (c.springGain ?? 1), base) * s, 0, 1),
        clamp(t.damper * (c.damperGain ?? 1) * s, 0, 1),
        clamp(t.friction * (c.frictionGain ?? 1) * s, 0, 1),
        clamp(t.rumble * (c.rumbleGain ?? 0) * s, 0, 1),
        0,
      ];
    } else smoothed = 0;
    L.ffb(out);
    const now = performance.now();
    if (now - lastTel > 50) {
      lastTel = now;
      L.telemetry({ game: GAME, raw: { constant: t.constant, spring: t.spring, damper: t.damper, friction: t.friction, rumble: t.rumble }, speed: t.speed, live: t.live, active, out });
    }
  }
  setInterval(tick, 8);

  // -------------------------------------------------------------------------
  // 3. SDL3 wheel as an extra raw gamepad
  // -------------------------------------------------------------------------
  const VPAD_INDEX = 4;
  let vpad = null, announced = false;
  const hex = n => ((n || 0) >>> 0).toString(16).padStart(4, '0');
  L.onInput(inp => {
    if (!inputCfg.sdlVirtualPad) return;
    const buttons = inp.buttons.map(p => ({ pressed: p, touched: p, value: p ? 1 : 0 }));
    // Hats -> 4 extra buttons each (up, right, down, left)
    for (const h of inp.hats) for (const bit of [1, 2, 4, 8]) { const p = !!(h & bit); buttons.push({ pressed: p, touched: p, value: p ? 1 : 0 }); }
    vpad = {
      id: `SDL3 ${inp.name || 'Wheel'} (Arcade Launcher) (Vendor: ${hex(inp.vendor)} Product: ${hex(inp.product)})`,
      index: VPAD_INDEX, connected: true, mapping: '', timestamp: performance.now(),
      axes: Object.freeze(inp.axes.slice()), buttons: Object.freeze(buttons), vibrationActuator: null, hapticActuators: [],
    };
    if (!announced) {
      announced = true;
      const ev = new Event('gamepadconnected');
      Object.defineProperty(ev, 'gamepad', { value: vpad });
      window.dispatchEvent(ev);
    }
  });
  const getGamepads = navigator.getGamepads?.bind(navigator);
  if (getGamepads) {
    navigator.getGamepads = function () {
      const list = Array.from(getGamepads());
      if (vpad && inputCfg.sdlVirtualPad) { while (list.length < VPAD_INDEX) list.push(null); list[VPAD_INDEX] = vpad; }
      return list;
    };
  }

  const engineFound = () => GAME === 'd1' ? !!(d1Module && typeof d1Module._daytona_wheel_force === 'function') : !!(window.__d2?.host);
  window.__arcadeAdapter = { game: GAME, read, engineFound, get settings() { return { ffbCfg, inputCfg, gameCfg }; } };
};
