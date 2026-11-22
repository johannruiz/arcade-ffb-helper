'use strict';
// Runs native/ffb_bridge.exe (SDL3) and speaks its line protocol.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');

const EXE = process.platform === 'win32' ? 'ffb_bridge.exe' : 'ffb_bridge';

function bridgeExe() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', EXE),
    path.join(__dirname, '..', 'bin', EXE),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];
}

class SdlBridge extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.devices = [];
    this.opened = null;          // info of the opened device
    this.version = null;
    this.lastFfb = '';
    this.lastFfbAt = 0;
    this.wantDevice = 0;
    this.restarts = 0;
  }

  start() {
    if (this.proc) return;
    const exe = bridgeExe();
    if (!fs.existsSync(exe)) { this.missing = exe; this.emit('status', this.status()); return; }
    const proc = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    proc.stderr.on('data', d => this.emit('log', String(d).trim()));
    proc.on('exit', code => {
      this.proc = null; this.opened = null;
      this.emit('status', this.status());
      if (!this.stopping && this.restarts++ < 5) setTimeout(() => this.start(), 1000);
    });
    proc.stdin.on('error', () => {});
  }

  stop() {
    this.stopping = true;
    if (this.proc) { this.send('stop'); this.send('quit'); setTimeout(() => this.proc?.kill(), 500); }
  }

  send(line) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(line + '\n');
  }

  onLine(line) {
    const sp = line.indexOf(' ');
    const kind = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    switch (kind) {
      case 'ready':
        this.version = rest;
        this.send('list');
        this.send(`open ${this.wantDevice || 0}`);
        break;
      case 'devices':
        try { this.devices = JSON.parse(rest); } catch { this.devices = []; }
        // Hot-plug: open the wheel when it appears.
        if (!this.opened && this.devices.length) this.send(`open ${this.wantDevice || 0}`);
        if (this.opened && !this.devices.some(d => d.id === this.opened.id)) this.opened = null;
        this.emit('status', this.status());
        break;
      case 'opened': {
        const j = rest.indexOf(' ');
        try { this.opened = JSON.parse(rest.slice(j + 1)); } catch { this.opened = null; }
        this.lastFfb = '';
        this.emit('status', this.status());
        this.emit('opened', this.opened);
        break;
      }
      case 'input': this.emit('input', parseInput(rest)); break;
      case 'log': this.emit('log', rest); break;
      case 'error':
        this.emit('log', 'error: ' + rest);
        if (/no joystick/.test(rest)) { this.opened = null; this.emit('status', this.status()); }
        break;
      default: this.emit('log', line);
    }
  }

  status() {
    return { running: !!this.proc, version: this.version, devices: this.devices, opened: this.opened, missing: this.missing || null };
  }

  openDevice(id) { this.wantDevice = Number(id) || 0; this.send(`open ${this.wantDevice}`); }
  setGain(g) { this.send(`gain ${Math.round(Math.max(0, Math.min(100, g)))}`); }

  // values: constant, spring, damper, friction, rumble, center
  // A device with wheel effects. A plain gamepad gets nothing from here: the games drive its
  // vibration themselves, and a stream of zero rumble from SDL would cancel theirs.
  hasWheelFfb() {
    const o = this.opened;
    return !!(o && o.haptic && o.effects && ['constant', 'spring', 'damper', 'friction', 'sine'].some(k => o.effects[k]));
  }

  ffb(v) {
    if (!this.hasWheelFfb()) return;
    const f = x => (Number.isFinite(x) ? x : 0).toFixed(3);
    const line = `ffb ${f(v[0])} ${f(v[1])} ${f(v[2])} ${f(v[3])} ${f(v[4])} ${f(v[5] || 0)}`;
    const now = Date.now();
    if (line === this.lastFfb && now - this.lastFfbAt < 250) return;
    this.lastFfb = line; this.lastFfbAt = now;
    this.send(line);
  }
  zero() { this.ffb([0, 0, 0, 0, 0, 0]); }
}

// "<id> a:0.1,-1 b:0101 h:0"
function parseInput(rest) {
  const parts = rest.split(' ');
  const out = { id: Number(parts[0]), axes: [], buttons: [], hats: [] };
  for (const p of parts.slice(1)) {
    if (p.startsWith('a:')) out.axes = p.length > 2 ? p.slice(2).split(',').map(Number) : [];
    else if (p.startsWith('b:')) out.buttons = [...p.slice(2)].map(c => c === '1');
    else if (p.startsWith('h:')) out.hats = p.length > 2 ? p.slice(2).split(',').map(Number) : [];
  }
  return out;
}

module.exports = { SdlBridge, parseInput };
