'use strict';
// The games' own icons (their favicons on GitHub Pages), kept in data/icons/ so the
// library shows them offline too. A game without an icon gets the launcher's placeholder.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 512 * 1024;
const TYPES = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };

// <link rel="...icon..." href=... sizes=...> from the page; the biggest bitmap first.
function iconCandidates(html, base) {
  const out = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const attr = name => (tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(1).find(v => v !== undefined);
    const rel = (attr('rel') || '').toLowerCase();
    const href = attr('href');
    if (!href || !/(^|\s)(icon|apple-touch-icon)(\s|$)/.test(rel)) continue;
    let url;
    try { url = new URL(href, base).href; } catch { continue; }
    const sizes = (attr('sizes') || '').split(/\s+/).map(s => parseInt(s, 10) || 0);
    const size = Math.max(rel.includes('apple-touch-icon') ? 180 : 0, ...sizes);
    const ico = /\.ico(\?|$)/i.test(url);
    out.push({ url, score: size + (ico ? -1000 : 0) });
  }
  return out.sort((a, b) => b.score - a.score);
}

class IconStore {
  constructor(dir, { net }) {
    this.dir = dir; this.net = net; this.cache = new Map();
  }
  file(id) {
    try { return fs.readdirSync(this.dir).find(f => f.startsWith(id + '.')) || null; } catch { return null; }
  }
  // data: URL (the launcher's CSP only allows data: images), or null.
  get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    let url = null;
    const f = this.file(id);
    if (f) {
      const ext = path.extname(f).slice(1);
      const type = Object.keys(TYPES).find(k => TYPES[k] === ext) || 'image/png';
      try { url = `data:${type};base64,${fs.readFileSync(path.join(this.dir, f)).toString('base64')}`; } catch {}
    }
    this.cache.set(id, url);
    return url;
  }
  // Looks for the game's icon on its page; true when it changed.
  async refresh(game) {
    const res = await this.net.fetch(game.url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    for (const c of iconCandidates(html, game.url)) {
      try {
        const r = await this.net.fetch(c.url);
        if (!r.ok) continue;
        const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const ext = TYPES[type];
        const bytes = Buffer.from(await r.arrayBuffer());
        if (!ext || !bytes.length || bytes.length > MAX_BYTES) continue;
        const name = `${game.id}.${ext}`;
        const old = this.file(game.id);
        if (old === name && fs.readFileSync(path.join(this.dir, old)).equals(bytes)) return false;
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(path.join(this.dir, name + '.tmp'), bytes);
        if (old) fs.rmSync(path.join(this.dir, old), { force: true });
        fs.renameSync(path.join(this.dir, name + '.tmp'), path.join(this.dir, name));
        this.cache.delete(game.id);
        return true;
      } catch {}
    }
    return false;   // no icon on the page: keep whatever was saved (or the placeholder)
  }
}

module.exports = { IconStore, iconCandidates };
