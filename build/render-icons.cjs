'use strict';
// Renders the icon SVGs to PNG with Electron's own renderer (no extra tools):
//   npx electron build/render-icons.cjs
// build/icon.png      1024  Windows .exe icon (electron-builder makes the .ico)
// build/icon-mac.png  1024  macOS .icns (Apple grid, with margin and shadow)
// src/assets/icon.png  256  the launcher's window icon
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const jobs = [
  ['build/icon.svg', 'build/icon.png', 1024],
  ['build/icon-mac.svg', 'build/icon-mac.png', 1024],
  ['build/icon.svg', 'src/assets/icon.png', 256],
];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [src, out, size] of jobs) {
    const svg = fs.readFileSync(path.join(root, src), 'utf8');
    const png = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
      await img.decode();
      const c = document.querySelector('canvas'); c.width = c.height = ${size};
      const g = c.getContext('2d'); g.clearRect(0, 0, ${size}, ${size});
      g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, ${size}, ${size});
      return c.toDataURL('image/png');
    })()`);
    fs.mkdirSync(path.dirname(path.join(root, out)), { recursive: true });
    fs.writeFileSync(path.join(root, out), Buffer.from(png.split(',')[1], 'base64'));
    console.log(out, size);
  }
  app.quit();
});
