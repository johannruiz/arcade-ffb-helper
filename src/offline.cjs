'use strict';
// Offline copies of the games (data/offline/<game>/).
//
// Saving: the file list comes from the game's GitHub repo tree (the same files GitHub Pages
// serves). Each file is downloaded from Pages through the games' session (so it usually comes
// from the HTTP cache) and stored by its git blob SHA, which is also used to verify it. The
// manifest is written last, in one go, so a copy is either complete or not used.
//
// Playing offline: the games' session intercepts https and serves the copy on the same
// address (johannruiz.github.io/...), so the ROMs and saves the game keeps in IndexedDB
// for that origin are found exactly as online.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const SKIP_DIRS = ['docs/', 'tests/', 'test/', 'scripts/', 'bridge/', '.github/'];
const WEB_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.wasm', '.wgsl', '.glsl', '.json', '.webmanifest',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.ogg', '.wav', '.bin', '.txt', '.data']);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
  '.wgsl': 'text/plain; charset=utf-8', '.glsl': 'text/plain; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.bin': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.data': 'application/octet-stream',
};
// Chromium network errors that mean "no connection" (not "the page is broken").
const NETWORK_ERRORS = new Set([-7, -21, -100, -101, -102, -104, -105, -106, -109, -118, -130, -137]);

const gitBlobSha = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const wanted = p => !p.startsWith('.') && !SKIP_DIRS.some(d => p.startsWith(d)) && WEB_EXT.has(path.extname(p).toLowerCase())
  && !p.endsWith('.symbols');

class OfflineStore extends EventEmitter {
  constructor(baseDir, { session, net, isolationHeaders, strict = false }) {
    super();
    this.strict = strict;            // self-test: never touch the network while serving offline
    this.base = baseDir;
    this.session = session;          // the games' session (shares their HTTP cache)
    this.net = net;                  // default-session fetch for the GitHub API
    this.isolationHeaders = isolationHeaders;
    this.manifests = new Map();
    this.syncing = new Map();        // id -> { done, total }
    this.serving = false;
  }

  dir(id) { return path.join(this.base, id); }
  blob(id, sha) { return path.join(this.dir(id), 'blobs', sha); }

  manifest(id) {
    if (!this.manifests.has(id)) {
      let m = null;
      try { m = JSON.parse(fs.readFileSync(path.join(this.dir(id), 'manifest.json'), 'utf8')); } catch {}
      this.manifests.set(id, m);
    }
    return this.manifests.get(id);
  }
  has(id) { return !!this.manifest(id)?.complete; }

  status(id) {
    const m = this.manifest(id), s = this.syncing.get(id);
    return {
      available: !!m?.complete, version: m?.version || null, savedAt: m?.savedAt || null,
      sizeMB: m ? Math.round(Object.values(m.files).reduce((a, f) => a + f.size, 0) / 1048576) : 0,
      syncing: !!s, progress: s && s.total ? s.done / s.total : 0, error: this.lastError?.[id] || null,
    };
  }

  // Saves or updates the copy of a game. Cheap when nothing changed (one GitHub API call).
  async sync(game, { version } = {}) {
    if (this.syncing.has(game.id)) return this.status(game.id);
    const progress = { done: 0, total: 0 };
    this.syncing.set(game.id, progress);
    this.lastError = { ...this.lastError, [game.id]: null };
    this.emit('status', game.id);
    try {
      const [, owner, repo] = new URL(game.repo).pathname.split('/');
      const res = await this.net.fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
        headers: { 'User-Agent': 'arcade-launcher', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const tree = await res.json();
      const old = this.manifest(game.id);
      if (old?.complete && old.treeSha === tree.sha) {
        if (version && old.version !== version) await this.writeManifest(game.id, { ...old, version });
        return this.status(game.id);
      }
      const files = tree.tree.filter(e => e.type === 'blob' && wanted(e.path));
      progress.total = files.length;
      await fsp.mkdir(path.join(this.dir(game.id), 'blobs'), { recursive: true });
      const basePath = new URL(game.url).pathname;
      const entries = {};
      let mismatched = 0;
      const queue = files.slice();
      const worker = async () => {
        for (let e; (e = queue.shift());) {
          const key = basePath + e.path;
          const file = this.blob(game.id, e.sha);
          if (!fs.existsSync(file)) {
            const r = await this.session.fetch(new URL(e.path, game.url).href, { cache: 'no-cache' });
            if (!r.ok) throw new Error(`${e.path}: HTTP ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            // Pages may still be deploying an older version: keep it, but do not call the copy complete.
            const sha = gitBlobSha(buf);
            if (sha !== e.sha) mismatched++;
            const target = this.blob(game.id, sha);
            if (!fs.existsSync(target)) { await fsp.writeFile(target + '.tmp', buf); await fsp.rename(target + '.tmp', target); }
            entries[key] = { blob: sha, size: buf.length, type: TYPES[path.extname(e.path).toLowerCase()] || 'application/octet-stream' };
          } else {
            entries[key] = { blob: e.sha, size: e.size, type: TYPES[path.extname(e.path).toLowerCase()] || 'application/octet-stream' };
          }
          progress.done++;
          if (progress.done % 5 === 0) this.emit('status', game.id);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      await this.writeManifest(game.id, {
        game: game.id, url: game.url, treeSha: mismatched ? null : tree.sha, complete: true,
        version: version || old?.version || null, savedAt: new Date().toISOString(), files: entries,
      });
      await this.gc(game.id);
    } catch (e) {
      this.lastError = { ...this.lastError, [game.id]: e.message };
    } finally {
      this.syncing.delete(game.id);
      this.emit('status', game.id);
    }
    return this.status(game.id);
  }

  async writeManifest(id, m) {
    const file = path.join(this.dir(id), 'manifest.json');
    await fsp.writeFile(file + '.tmp', JSON.stringify(m));
    await fsp.rename(file + '.tmp', file);
    this.manifests.set(id, m);
  }

  async gc(id) {
    const used = new Set(Object.values(this.manifest(id)?.files || {}).map(f => f.blob));
    const dir = path.join(this.dir(id), 'blobs');
    for (const name of await fsp.readdir(dir).catch(() => [])) if (!used.has(name)) await fsp.rm(path.join(dir, name), { force: true });
  }

  async remove(id) {
    await fsp.rm(this.dir(id), { recursive: true, force: true });
    this.manifests.set(id, null);
    this.emit('status', id);
  }

  // --- offline serving -------------------------------------------------------
  enableServing(gameForUrl) {
    if (this.serving) return;
    this.serving = true;
    this.session.protocol.handle('https', async req => {
      const game = gameForUrl(req.url);
      if (!game) {
        // Not a game file (Firebase, PeerJS...): try the network, fail fast when offline.
        if (this.strict) return new Response('offline (simulated)', { status: 503 });
        try { return await this.session.fetch(req, { bypassCustomProtocolHandlers: true }); }
        catch { return new Response('offline', { status: 503 }); }
      }
      const headers = { 'cache-control': 'no-cache', ...this.isolationHeaders(game) };
      let key = new URL(req.url).pathname;
      if (key.endsWith('/')) key += 'index.html';
      const entry = this.manifest(game.id)?.files[key];
      if (!entry) return new Response('Not in the offline copy', { status: 404, headers: { ...headers, 'content-type': 'text/plain' } });
      const file = this.blob(game.id, entry.blob);
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { ...headers, 'content-type': entry.type, 'content-length': String(entry.size) } });
      return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'content-type': entry.type, 'content-length': String(entry.size) } });
    });
  }
  disableServing() {
    if (!this.serving) return;
    this.session.protocol.unhandle('https');
    this.serving = false;
  }
}

module.exports = { OfflineStore, NETWORK_ERRORS };
