'use strict';
// The launcher updates itself from GitHub Releases (the games need nothing: they load from
// GitHub Pages). Electron's own updater needs an installer on Windows and an Apple Developer
// signature on macOS, so this one works on the portable folder and on the ad-hoc signed .app:
//
//   check     the latest release (tagged v*; never a bare push) newer than this version
//   download  its zip for this system, verified against the SHA-256 that GitHub publishes
//   stage     unpacked into data/updates/<version>/ (inside the data folder, so never replaced)
//   apply     on "Restart": the new version is started from that folder in "apply" mode; it
//             waits for the launcher to close, moves the old program aside as a backup, copies
//             itself in (the data folder is never touched) and starts the installed copy.
//             If the new version does not open its window within 45 s, the backup is put back,
//             the old version starts again and that version is not offered any more.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { fileURLToPath } = require('node:url');

const REPO = 'johannruiz/arcade-launcher';
const ASSETS = { win32: /-win-x64-portable\.zip$/i, darwin: /-mac-arm64\.zip$/i };
const START_TIMEOUT_S = 45;

function parseVersion(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}
function isNewer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const run = (file, args) => new Promise((resolve, reject) =>
  execFile(file, args, { windowsHide: true, maxBuffer: 16 << 20 }, (err, _o, stderr) => err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve()));

class Updater extends EventEmitter {
  constructor({ app, net, dir, feed }) {
    super();
    this.app = app; this.net = net; this.dir = dir;
    this.feed = feed || `https://api.github.com/repos/${REPO}/releases/latest`;
    this.current = app.getVersion();
    this.target = this.findTarget();
    this.state = { status: this.target.reason ? 'unsupported' : 'idle', current: this.current, reason: this.target.reason || null };
    this.busy = null;
    this.failedNotice = this.readFailed();
  }

  set(patch) { this.state = { ...this.state, ...patch }; this.emit('state', this.state); }

  // What would be replaced: the portable folder (Windows) or the .app bundle (macOS).
  findTarget() {
    if (!this.app.isPackaged && !process.env.ARCADE_UPDATE_FEED) return { reason: 'dev' };
    const exe = process.execPath;
    let target;
    if (process.platform === 'win32') target = { kind: 'win', dir: path.dirname(exe), exe };
    else if (process.platform === 'darwin') {
      const bundle = path.resolve(exe, '..', '..', '..');
      if (!bundle.endsWith('.app')) return { reason: 'layout' };
      if (bundle.includes('/AppTranslocation/')) return { reason: 'translocated' };
      target = { kind: 'mac', dir: bundle, exe };
    } else return { reason: 'platform' };
    const probe = path.join(target.kind === 'mac' ? path.dirname(target.dir) : target.dir, `.update-probe-${process.pid}`);
    try { fs.writeFileSync(probe, ''); fs.rmSync(probe); } catch { return { reason: 'readonly' }; }
    return target;
  }

  marker(kind, version) { return path.join(this.dir, `${kind}-${version}`); }
  readFailed() {
    try {
      const f = fs.readdirSync(this.dir).filter(n => /^failed-\d/.test(n)).map(n => n.slice(7));
      const fresh = f.filter(v => !fs.existsSync(this.marker('failed-seen', v)));
      for (const v of fresh) fs.writeFileSync(this.marker('failed-seen', v), '');
      return fresh[0] || null;
    } catch { return null; }
  }
  failed(version) { return fs.existsSync(this.marker('failed', version)); }

  // Called once the launcher's window has loaded: tells a waiting update script that this
  // version starts. Also tidies old downloads.
  confirmStarted() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.marker('started', this.current), new Date().toISOString());
      // An update being applied right now runs from its folder: tidy up on a later start.
      const applying = fs.readdirSync(this.dir).some(n => /^apply-.*\.json$/.test(n) && Date.now() - fs.statSync(path.join(this.dir, n)).mtimeMs < 5 * 60e3);
      if (applying) return;
      for (const name of fs.readdirSync(this.dir)) {
        const full = path.join(this.dir, name);
        // Old downloads, the backup and the apply profile; a newer download stays unless it failed.
        if (fs.statSync(full).isDirectory() && (!isNewer(name, this.current) || this.failed(name))) fs.rmSync(full, { recursive: true, force: true });
      }
    } catch {}
  }

  async fetchRelease() {
    if (/^file:/i.test(this.feed)) return JSON.parse(fs.readFileSync(fileURLToPath(this.feed), 'utf8').replace(/^\uFEFF/, ''));
    const res = await this.net.fetch(this.feed, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Arcade-Launcher-Updater' }, cache: 'no-store' });
    if (res.status === 404) return null;   // no release yet
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.json();
  }

  async check({ download = true } = {}) {
    if (this.target.reason) return this.state;
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const keep = this.state.status === 'ready' ? this.state : null;
      this.set({ status: 'checking', error: null });
      try {
        const rel = await this.fetchRelease();
        const latest = rel && !rel.draft && !rel.prerelease ? String(rel.tag_name || '').replace(/^v/i, '') : null;
        const asset = rel?.assets?.find(a => ASSETS[process.platform]?.test(a.name));
        if (!latest || !isNewer(latest, this.current) || this.failed(latest) || !asset) {
          this.set({ status: 'upToDate', latest: latest || this.current, checkedAt: Date.now() });
          return this.state;
        }
        if (keep && keep.latest === latest) { this.set({ ...keep, checkedAt: Date.now() }); return this.state; }
        const staged = this.stagedApp(latest);
        if (staged) { this.set({ status: 'ready', latest, notes: rel.name || '', checkedAt: Date.now() }); return this.state; }
        this.release = { latest, asset, notes: rel.name || '' };
        this.set({ status: 'available', latest, size: asset.size, notes: rel.name || '', checkedAt: Date.now() });
        if (download) await this.download();
      } catch (e) {
        this.set({ status: keep ? 'ready' : 'error', ...(keep ? { latest: keep.latest } : {}), error: e.message });
      } finally { this.busy = null; }
      return this.state;
    })();
    return this.busy;
  }

  // The unpacked new program, if it is already there and complete.
  stagedApp(version) {
    const base = path.join(this.dir, version, 'app');
    const p = this.target.kind === 'win' ? path.join(base, 'Arcade Launcher') : path.join(base, 'Arcade Launcher.app');
    const ok = this.target.kind === 'win' ? fs.existsSync(path.join(p, 'Arcade Launcher.exe')) : fs.existsSync(path.join(p, 'Contents', 'Info.plist'));
    return ok && fs.existsSync(path.join(this.dir, version, 'verified')) ? p : null;
  }

  async download() {
    const { latest, asset } = this.release || {};
    if (!asset) return;
    const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (!want) throw new Error('the release has no checksum');
    const vdir = path.join(this.dir, latest);
    fs.rmSync(vdir, { recursive: true, force: true });
    fs.mkdirSync(vdir, { recursive: true });
    const zip = path.join(vdir, asset.name);
    this.set({ status: 'downloading', latest, progress: 0 });

    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(zip);
    let got = 0, lastEmit = 0;
    const onChunk = chunk => {
      hash.update(chunk); got += chunk.length;
      if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.set({ progress: asset.size ? got / asset.size : 0 }); }
      return new Promise((res, rej) => out.write(chunk, e => e ? rej(e) : res()));
    };
    try {
      if (/^file:/i.test(asset.browser_download_url)) {
        for await (const chunk of fs.createReadStream(fileURLToPath(asset.browser_download_url))) await onChunk(chunk);
      } else {
        const res = await this.net.fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Arcade-Launcher-Updater' } });
        if (!res.ok) throw new Error(`download ${res.status}`);
        const reader = res.body.getReader();
        for (;;) { const { done, value } = await reader.read(); if (done) break; await onChunk(Buffer.from(value)); }
      }
    } finally { await new Promise(r => out.end(r)); }
    const digest = hash.digest('hex');
    if (digest !== want[1].toLowerCase()) { fs.rmSync(vdir, { recursive: true, force: true }); throw new Error('the download is damaged (checksum)'); }

    this.set({ status: 'downloading', progress: 1 });
    const appDir = path.join(vdir, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    if (this.target.kind === 'win') {
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      try { await run(tar, ['-xf', zip, '-C', appDir]); }
      catch { await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${appDir.replace(/'/g, "''")}' -Force`]); }
    } else {
      await run('/usr/bin/ditto', ['-x', '-k', zip, appDir]);   // keeps the bundle's symlinks and permissions
    }
    fs.rmSync(zip, { force: true });
    fs.writeFileSync(path.join(vdir, 'verified'), digest);
    if (!this.stagedApp(latest)) { fs.rmSync(vdir, { recursive: true, force: true }); throw new Error('unexpected archive layout'); }
    this.set({ status: 'ready', latest, progress: 1 });
  }

  // Starts the downloaded version in "apply" mode and returns; the caller quits right after.
  // The new version itself puts its files in place (no script host needed: a detached
  // PowerShell does not survive on every Windows setup, a copy of the app does).
  apply() {
    if (this.state.status !== 'ready') throw new Error('No update is ready');
    const version = this.state.latest;
    const src = this.stagedApp(version);
    if (!src) throw new Error('The downloaded update is missing');
    const exe = this.target.kind === 'win' ? path.join(src, 'Arcade Launcher.exe') : path.join(src, 'Contents', 'MacOS', path.basename(this.target.exe));
    const job = {
      kind: this.target.kind, pid: process.pid, version, from: this.current,
      src, target: this.target.dir, exe: this.target.exe,
      backup: path.join(this.dir, `backup-${this.current}`),
      started: this.marker('started', version), failed: this.marker('failed', version),
      log: path.join(this.dir, 'update.log'), timeout: START_TIMEOUT_S,
    };
    try { fs.rmSync(job.started, { force: true }); } catch {}
    const jobFile = path.join(this.dir, `apply-${version}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
    spawn(exe, [APPLY_FLAG, jobFile], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
    return version;
  }
}

// ---------------------------------------------------------------------------
// Apply mode: runs in the NEW version, started from data/updates/<version>/app/ by the old one.
// ---------------------------------------------------------------------------
const APPLY_FLAG = '--arcade-apply-update';

async function runApplier(app, jobFile) {
  const { execFileSync } = require('node:child_process');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  const say = m => { try { fs.appendFileSync(job.log, `${new Date().toISOString()} ${m}\n`); } catch {} };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  // Retries while Windows still holds files of the closing app (GPU process, SDL3 bridge...).
  const retry = async (what, fn, seconds = 30) => {
    for (let i = 0; ; i++) {
      try { return fn(); } catch (e) {
        if (i >= seconds * 4 || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code)) throw new Error(`${what}: ${e.message}`);
        await wait(250);
      }
    }
  };
  const launch = (file, args, cwd) => spawn(file, args, { detached: true, stdio: 'ignore', cwd }).unref();
  const startOld = () => job.kind === 'win' ? launch(job.exe, [], job.target) : launch('/usr/bin/open', ['-n', job.target]);
  const KEEP = new Set(['data']);   // the portable data folder, never touched
  const done = () => { try { fs.rmSync(jobFile, { force: true }); } catch {} };
  const entries = dir => fs.readdirSync(dir).filter(n => !KEEP.has(n));

  say(`update ${job.from} -> ${job.version}: waiting for the launcher to close`);
  for (let i = 0; i < 240 && alive(job.pid); i++) await wait(250);

  // 1. Move the current program aside (same disk: a rename, nothing is copied).
  fs.rmSync(job.backup, { recursive: true, force: true });
  fs.mkdirSync(job.backup, { recursive: true });
  const moved = [];
  let copying = false;
  // Puts the backup back. Before copying began, the folder only holds what was not moved yet;
  // after, everything in it (but data) is new or half-copied and is removed first.
  const restore = async () => {
    if (job.kind === 'win') {
      if (copying) for (const n of entries(job.target)) await retry('remove ' + n, () => fs.rmSync(path.join(job.target, n), { recursive: true, force: true }));
      for (const n of moved) await retry('restore ' + n, () => fs.renameSync(path.join(job.backup, n), path.join(job.target, n)));
    } else if (fs.existsSync(path.join(job.backup, path.basename(job.target)))) {
      fs.rmSync(job.target, { recursive: true, force: true });
      fs.renameSync(path.join(job.backup, path.basename(job.target)), job.target);
    }
  };
  try {
    if (job.kind === 'win') {
      for (const n of entries(job.target)) { await retry('move ' + n, () => fs.renameSync(path.join(job.target, n), path.join(job.backup, n))); moved.push(n); }
    } else {
      fs.renameSync(job.target, path.join(job.backup, path.basename(job.target)));
    }
  } catch (e) {
    say(`could not move the current version (${e.message}): update cancelled`);
    try { await restore(); } catch (r) { say('restore failed: ' + r.message); }
    done(); startOld(); return app.exit(1);
  }

  // 2. Copy the new program in.
  copying = true;
  try {
    if (job.kind === 'win') {
      for (const n of entries(job.src)) await retry('copy ' + n, () => fs.cpSync(path.join(job.src, n), path.join(job.target, n), { recursive: true, force: true }));
    } else {
      execFileSync('/usr/bin/ditto', [job.src, job.target]);   // keeps the bundle's symlinks
      try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', job.target]); } catch {}
    }
  } catch (e) {
    say(`copy failed (${e.message}): restoring ${job.from}`);
    try { await restore(); } catch (r) { say('restore failed: ' + r.message); }
    fs.writeFileSync(job.failed, 'copy'); done(); startOld(); return app.exit(1);
  }

  // 3. Start it, and keep the backup until its window has opened.
  let child = null;
  if (job.kind === 'win') { child = spawn(job.exe, [], { detached: true, stdio: 'ignore', cwd: job.target }); child.unref(); }
  else launch('/usr/bin/open', ['-n', job.target]);
  for (let i = 0; i < job.timeout * 4 && !fs.existsSync(job.started); i++) await wait(250);
  if (!fs.existsSync(job.started)) {
    say(`${job.version} did not start: restoring ${job.from}`);
    // The whole tree: its GPU process and SDL3 bridge also hold files of the program folder.
    if (job.kind === 'win') { try { if (child?.pid) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    else { try { execFileSync('/usr/bin/pkill', ['-f', job.target + '/Contents/']); } catch {} }
    await wait(1500);
    try { await restore(); say(`restored ${job.from}`); } catch (r) { say('restore failed: ' + r.message); }
    fs.writeFileSync(job.failed, 'start'); done(); startOld(); return app.exit(1);
  }
  fs.rmSync(job.backup, { recursive: true, force: true });
  done();
  say(`updated to ${job.version}`);
  app.exit(0);   // the staging folder (where this copy runs from) is removed by the new version later
}

module.exports = { Updater, runApplier, APPLY_FLAG, isNewer, parseVersion };
