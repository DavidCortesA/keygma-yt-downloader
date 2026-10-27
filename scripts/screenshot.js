/**
 * Captura la interfaz real (HTML/CSS/JS + preload) con datos simulados, sin
 * tocar yt-dlp ni la red. Sirve para revisar el diseño y para regresiones visuales.
 *
 * Uso:  npx electron scripts/screenshot.js [carpeta-de-salida]
 * Genera: 1-inicio, 2-recorte, 3-progreso, 4-lista-audio, 5-configuracion, 6-claro (.png)
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THUMB =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a5c"/><stop offset="1" stop-color="#3a1608"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>'
  );

let settings = {
  theme: 'dark', onExists: 'copy', remember: true, notify: true, openFolder: false,
  tab: 'video', outputDir: '/Users/demo/Downloads/Kerygma',
  video: { container: 'mp4', quality: 'best' },
  audio: { format: 'mp3', bitrate: 192 },
};
let downloadCalls = 0;
let releaseFirst = null;

ipcMain.handle('app:init', () => ({
  name: 'Kerygma Downloader', version: '1.1.0', electron: process.versions.electron,
  platform: process.platform, settings, engineError: null,
}));
ipcMain.handle('engine:version', () => '2026.10.26');
ipcMain.handle('settings:save', (_e, patch) => {
  settings = { ...settings, ...patch, video: { ...settings.video, ...patch.video }, audio: { ...settings.audio, ...patch.audio } };
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  return settings;
});
ipcMain.handle('video:info', async () => {
  await sleep(150);
  return { id: 'x', title: 'Predicación: El mensaje del Reino — Serie completa', uploader: 'Canal Kerygma', platform: 'YouTube', duration: 3725, thumbnail: THUMB };
});
ipcMain.handle('download:start', async (e, req) => {
  downloadCalls += 1;
  const ext = req.mode === 'audio' ? req.audio.format : req.video.container;
  if (downloadCalls === 1) {
    e.sender.send('download:event', { type: 'stage', label: 'Descargando video' });
    e.sender.send('download:event', { type: 'progress', percent: 38, speed: 4.2 * 1024 * 1024, eta: 42 });
    await new Promise((resolve) => (releaseFirst = resolve));
    return { filePath: `/Users/demo/Downloads/Kerygma/${req.title}.${ext}`, size: 248 * 1024 * 1024 };
  }
  if (downloadCalls === 2) return { filePath: `/Users/demo/Downloads/Kerygma/${req.title} (1m30s a 3m45s).${ext}`, size: 3.4 * 1024 * 1024 };
  throw new Error('El video no está disponible (privado, eliminado o restringido en tu región).');
});
ipcMain.handle('download:cancel', () => {});
ipcMain.handle('dialog:chooseFolder', () => null);
ipcMain.handle('shell:showItem', () => {});
ipcMain.handle('shell:openFolder', () => {});
ipcMain.handle('engine:update', () => ({ message: 'Ya tienes la última versión', engineVersion: '2026.10.26' }));

async function shot(win, name) {
  // Fuerza un repintado: con la ventana en segundo plano, capturePage puede devolver el cuadro anterior.
  win.webContents.invalidate();
  await sleep(600);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, name), image.toPNG());
  console.log(`✔ ${name}`);
}
const run = (win, code) => win.webContents.executeJavaScript(code);
const typeInto = (win, id, value) =>
  run(win, `(() => { const i = document.getElementById('${id}'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1120, height: 820, show: true,
    backgroundColor: '#0e0e10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#0e0e10', symbolColor: '#8e8e98', height: 60 } }),
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(500);
  await shot(win, '1-inicio.png');

  // Video cargado + recorte
  await typeInto(win, 'url', 'https://youtu.be/06LjLWnkO0M?si=gw1naXB7VqMivS7J');
  await sleep(1100);
  await run(win, `document.getElementById('trimToggle').click()`);
  await typeInto(win, 'trimStart', '1:30');
  await typeInto(win, 'trimEnd', '3:45');
  await shot(win, '2-recorte.png');

  // Descarga en curso (se quita el recorte para este paso)
  await run(win, `document.getElementById('trimToggle').click()`);
  await run(win, `document.getElementById('downloadBtn').click()`);
  await sleep(300);
  await shot(win, '3-progreso.png');

  // Termina la 1.ª, descarga de audio con recorte (2.ª) y una que falla (3.ª)
  releaseFirst();
  await sleep(300);
  await run(win, `document.querySelector('[data-tab="audio"]').click()`);
  await run(win, `document.getElementById('trimToggle').click()`);
  await typeInto(win, 'trimStart', '1:30');
  await typeInto(win, 'trimEnd', '3:45');
  await run(win, `document.getElementById('downloadBtn').click()`);
  await sleep(300);
  await run(win, `document.getElementById('trimToggle').click()`);
  await run(win, `document.getElementById('downloadBtn').click()`);
  await sleep(300);
  await shot(win, '4-lista-audio.png');

  // Configuración
  await run(win, `document.getElementById('settingsBtn').click()`);
  await shot(win, '5-configuracion.png');

  // Tema claro
  await run(win, `document.querySelector('[data-setting="theme"] [data-value="light"]').click()`);
  await sleep(300);
  await run(win, `document.getElementById('modalClose').click()`);
  await shot(win, '6-claro.png');

  app.quit();
});
