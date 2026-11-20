'use strict';
// Portable mode: everything the launcher stores (settings, Chromium profile, HTTP cache,
// shader caches, IndexedDB where the games keep their ROMs and saves, crash dumps)
// goes to a "data" folder next to the executable instead of %APPDATA%.
// Must run before anything calls app.getPath('userData') and before "ready".
const fs = require('node:fs');
const path = require('node:path');

// Large caches that are rebuilt on their own: not worth copying when migrating.
const SKIP_ON_MIGRATE = new Set(['Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache', 'GPUPersistentCache',
  'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage', 'Shared Dictionary']);

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch { return false; }
}

// Where the portable data goes:
// - Windows: <folder of the .exe>\data
// - macOS:   "Arcade Launcher Data" next to the .app (never inside the bundle: that breaks its
//            signature). If the .app is in /Applications, or macOS runs it translocated from a
//            quarantined download, the standard ~/Library/Application Support is used instead.
function portableDir(app) {
  if (process.env.ARCADE_DATA_DIR) return process.env.ARCADE_DATA_DIR;
  if (!app.isPackaged) return path.join(__dirname, '..', 'portable-data');
  if (process.platform === 'darwin') {
    const bundle = path.resolve(process.execPath, '..', '..', '..');   // .../Arcade Launcher.app
    const parent = path.dirname(bundle);
    const home = require('node:os').homedir();
    if (/\/AppTranslocation\//.test(bundle) || parent === '/Applications' || parent === path.join(home, 'Applications')) return null;
    return path.join(parent, 'Arcade Launcher Data');
  }
  return path.join(path.dirname(process.execPath), 'data');
}

function setupPortable(app) {
  const base = portableDir(app);
  const previous = app.getPath('userData');   // %APPDATA% / Application Support (not created by calling this)
  if (!base) return { portable: false, dir: previous, reason: 'installed' };
  if (!writable(base)) return { portable: false, dir: previous, reason: 'not-writable' };

  // First portable launch: bring settings, ROMs and saves over from %APPDATA% (the original stays there).
  let migrated = false;
  const fresh = !fs.existsSync(path.join(base, 'settings.json')) && !fs.existsSync(path.join(base, 'Partitions'));
  if (fresh && path.resolve(previous) !== path.resolve(base) && fs.existsSync(previous)) {
    try {
      fs.cpSync(previous, base, {
        recursive: true, force: false, errorOnExist: false,
        filter: src => !SKIP_ON_MIGRATE.has(path.basename(src)),
      });
      migrated = true;
    } catch { /* partial copy is fine: Chromium recreates what is missing */ }
  }

  app.setPath('userData', base);
  app.setPath('sessionData', base);
  app.setPath('crashDumps', path.join(base, 'Crashpad'));
  app.setPath('logs', path.join(base, 'logs'));
  return { portable: true, dir: base, migrated, migratedFrom: migrated ? previous : null };
}

module.exports = { setupPortable };
