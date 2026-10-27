/**
 * Genera el ícono de la app (build/icon.png) renderizando un SVG con Electron.
 * electron-builder convierte ese PNG a .icns (macOS) y .ico (Windows).
 *
 * Uso:  npm run icon
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 1024;

const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffb347"/>
      <stop offset="1" stop-color="#ff6a00"/>
    </linearGradient>
    <radialGradient id="shine" cx="30%" cy="18%" r="75%">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#g)"/>
  <rect width="1024" height="1024" rx="230" fill="url(#shine)"/>
  <g fill="#0a0a0a">
    <path d="M452 210H572V490H690L512 690L334 490H452Z"/>
    <rect x="292" y="760" width="440" height="68" rx="34"/>
  </g>
</svg>`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: { offscreen: true },
  });

  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));

  let image = await win.webContents.capturePage();
  const { width } = image.getSize();
  if (width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: 'best' });

  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, image.toPNG());

  const small = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(small), { recursive: true });
  fs.writeFileSync(small, image.resize({ width: 512, height: 512, quality: 'best' }).toPNG());

  console.log(`Ícono generado: ${out}`);
  app.quit();
});
