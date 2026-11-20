'use strict';
// Copies the packaged app (dist/win-unpacked) into the portable folder release/Arcade Launcher.
// Replaces the program files but never touches the user's data folder (settings, ROMs, saves, cache).
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'dist', 'win-unpacked');
const dest = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'Arcade Launcher');
const KEEP = new Set(['data']);

if (!fs.existsSync(path.join(src, 'Arcade Launcher.exe'))) {
  console.error(`No build found at ${src}. Run "npx electron-builder --win dir" first.`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });
for (const name of fs.readdirSync(dest)) {
  if (!KEEP.has(name)) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(src)) {
  if (KEEP.has(name)) continue;   // never ship a data folder from the build machine
  fs.cpSync(path.join(src, name), path.join(dest, name), { recursive: true });
}
console.log(`Portable launcher ready: ${dest}`);
console.log('Data (settings, ROMs, saves, cache) lives in its "data" folder and was kept.');
