/**
 * Captura la interfaz real (HTML/CSS/JS + preload) con datos simulados, sin
 * tocar yt-dlp ni la red. Sirve para revisar el diseño y para regresiones visuales.
 *
 * Uso:  npx electron scripts/screenshot.js [carpeta-de-salida]
 * Genera: 1-inicio, 2-vista-previa, 2b-recorte, 2c-recorte-error, 3-progreso, 4-audio (.png)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THUMB =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb347"/><stop offset="1" stop-color="#7a2e00"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>'
  );

let settings = { outputDir: '/Users/demo/Downloads/Kerygma', mode: 'video', audioFormat: 'mp3' };
let finishDownload = null;

ipcMain.handle('app:init', () => ({
  name: 'Kerygma YT Downloader',
  version: '1.0.0',
  platform: process.platform,
  settings,
  engineVersion: '2026.10.26',
  engineError: null,
}));
ipcMain.handle('settings:save', (_e, patch) => (settings = { ...settings, ...patch }));
ipcMain.handle('video:info', async () => {
  await sleep(150);
  return { id: 'x', title: 'Predicación: El mensaje del Reino — Serie completa', uploader: 'Canal Kerygma', duration: 3725, thumbnail: THUMB };
});
ipcMain.handle('download:start', (e) => {
  e.sender.send('download:event', { type: 'stage', label: 'Descargando video' });
  e.sender.send('download:event', { type: 'progress', percent: 38, speed: 4.2 * 1024 * 1024, eta: 42 });
  return new Promise((resolve) => (finishDownload = resolve));
});
ipcMain.handle('download:cancel', () => finishDownload && finishDownload({ cancelled: true }));
ipcMain.handle('dialog:chooseFolder', () => null);
ipcMain.handle('shell:showItem', () => {});
ipcMain.handle('shell:openFolder', () => {});
ipcMain.handle('engine:update', () => ({ message: 'Ya tienes la última versión', engineVersion: '2026.10.26' }));

async function shot(win, name) {
  await sleep(350);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`✔ ${name}`);
}

const run = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 860,
    height: 900,
    show: true,
    backgroundColor: '#0a0a0a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(500);
  await shot(win, '1-inicio.png');

  await run(win, `
    const u = document.getElementById('url');
    u.value = 'https://youtu.be/06LjLWnkO0M?si=gw1naXB7VqMivS7J';
    u.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(1100);
  await shot(win, '2-vista-previa.png');

  await run(win, `
    document.getElementById('trimToggle').click();
    const set = (id, v) => { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('trimStart', '1:30');
    set('trimEnd', '3:45');
  `);
  await sleep(200);
  await shot(win, '2b-recorte.png');

  await run(win, `
    const e = document.getElementById('trimEnd'); e.value = '1:00'; e.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(200);
  await shot(win, '2c-recorte-error.png');
  await run(win, `
    const e2 = document.getElementById('trimEnd'); e2.value = '3:45'; e2.dispatchEvent(new Event('input', { bubbles: true }));
  `);

  await run(win, `document.getElementById('downloadBtn').click()`);
  await sleep(300);
  await shot(win, '3-progreso.png');

  await run(win, `document.getElementById('cancelBtn').click()`);
  await sleep(300);
  await run(win, `document.querySelector('[data-mode="audio"]').click()`);
  await sleep(300);
  await shot(win, '4-audio.png');

  app.quit();
});
