/**
 * Captura la interfaz real (HTML/CSS/JS + preload) con datos simulados, sin
 * tocar yt-dlp ni la red. Sirve para revisar el diseño y para regresiones visuales.
 *
 * Uso:  npx electron scripts/screenshot.js [carpeta-de-salida]
 * Genera: 1-inicio, 2-recorte, 3-lista, 4-cola, 5-audio, 6-historial, 7-configuracion,
 *         8-claro, 9-ingles (.png)
 */
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'screenshots'));
fs.mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const thumb = (a, b) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/></svg>`
  );
const THUMBS = [thumb('#ff8a5c', '#3a1608'), thumb('#3dd68c', '#123024'), thumb('#7aa7ff', '#141c33'), thumb('#f5b83d', '#33240a'), thumb('#ff6a9a', '#33101e')];

let language = 'es';
let settings = {
  theme: 'dark', language: 'es', onExists: 'copy', remember: true, notify: true, openFolder: false,
  autoUpdateEngine: true, checkAppUpdates: true, watchClipboard: true,
  tab: 'video', outputDir: '/Users/demo/Downloads/Kerygma',
  video: { container: 'mp4', quality: 'best', preset: 'manual', subtitles: 'none', subMode: 'embed' },
  audio: { format: 'mp3', bitrate: 192, normalize: false, cover: true },
};
let clipboard = '';
let releaseCurrent = null;

const VIDEO = { type: 'video', id: 'x', title: 'Predicación: El mensaje del Reino — Serie completa', uploader: 'Canal Kerygma', platform: 'YouTube', duration: 3725, thumbnail: THUMBS[0], listUrl: 'https://www.youtube.com/playlist?list=PLkerygma' };
const PLAYLIST = {
  type: 'playlist', id: 'PLkerygma', title: 'Serie: El mensaje del Reino', uploader: 'Canal Kerygma', platform: 'YouTube', thumbnail: THUMBS[1],
  entries: ['El Reino que viene', 'Parábolas del Reino', 'El Reino entre nosotros', 'Vivir el Reino', 'El Rey y su Reino']
    .map((title, i) => ({ url: `https://www.youtube.com/watch?v=kerygma000${i}`, title: `Parte ${i + 1}: ${title}`, duration: 2400 + i * 137, thumbnail: THUMBS[i] })),
};
PLAYLIST.count = PLAYLIST.entries.length;

const HISTORY = [
  { id: 'h1', date: Date.now() - 3.6e6, title: 'Predicación: El mensaje del Reino — Serie completa', url: 'https://youtu.be/x', platform: 'YouTube', kind: 'video', ext: 'MP4', filePath: '/Users/demo/Downloads/Kerygma/Predicación.mp4', size: 248e6, thumbnail: THUMBS[0], exists: true },
  { id: 'h2', date: Date.now() - 8.6e7, title: 'Alabanza en vivo — Domingo', url: 'https://www.facebook.com/watch/?v=1', platform: 'Facebook', kind: 'audio', ext: 'MP3', filePath: '/Users/demo/Downloads/Kerygma/Alabanza.mp3', size: 9.8e6, thumbnail: THUMBS[3], exists: true },
  { id: 'h3', date: Date.now() - 2.6e8, title: 'Testimonio de fe (Reel)', url: 'https://www.instagram.com/reel/abc/', platform: 'Instagram', kind: 'video', ext: 'MP4', filePath: '/Users/demo/Downloads/Kerygma/Testimonio.mp4', size: 12.1e6, thumbnail: THUMBS[4], exists: false },
  { id: 'h4', date: Date.now() - 6e8, title: 'Anuncios de la semana', url: 'https://www.tiktok.com/@kerygma/video/1', platform: 'TikTok', kind: 'video', ext: 'MP4', filePath: '/Users/demo/Downloads/Kerygma/Anuncios.mp4', size: 6.2e6, thumbnail: THUMBS[2], exists: true },
];

ipcMain.handle('app:init', () => ({
  name: 'Kerygma Downloader', version: '1.2.0', electron: process.versions.electron,
  platform: process.platform, language, settings, engineError: null, appUpdate: null,
}));
ipcMain.handle('engine:version', () => '2026.10.26');
ipcMain.handle('settings:save', (_e, patch) => {
  settings = { ...settings, ...patch, video: { ...settings.video, ...patch.video }, audio: { ...settings.audio, ...patch.audio } };
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  if (patch.language) language = patch.language === 'en' ? 'en' : 'es';
  return { settings, language };
});
ipcMain.handle('video:info', async (_e, url, opts = {}) => {
  await sleep(150);
  return opts.playlist || /playlist/.test(url) ? PLAYLIST : VIDEO;
});
// Cada descarga queda "en curso" hasta que el script la libera: así se ve la cola.
ipcMain.handle('download:start', async (e, req) => {
  const ext = req.mode === 'audio' ? req.audio.format : req.video.container;
  e.sender.send('download:event', { type: 'stage', stage: req.mode === 'audio' ? 'audio' : 'video' });
  e.sender.send('download:event', { type: 'progress', percent: 38, speed: 4.2 * 1024 * 1024, eta: 42 });
  await new Promise((resolve) => (releaseCurrent = resolve));
  return { filePath: `/Users/demo/Downloads/Kerygma/${req.title}.${ext}`, size: (req.mode === 'audio' ? 9.4 : 248) * 1024 * 1024 };
});
ipcMain.handle('download:cancel', () => releaseCurrent?.());
ipcMain.handle('dialog:chooseFolder', () => null);
ipcMain.handle('shell:showItem', () => {});
ipcMain.handle('shell:openFolder', () => {});
ipcMain.handle('engine:update', () => ({ message: '', engineVersion: '2026.10.26', changed: false }));
ipcMain.handle('history:list', () => HISTORY);
ipcMain.handle('history:remove', () => {});
ipcMain.handle('history:clear', () => {});
ipcMain.handle('clipboard:link', () => clipboard);
ipcMain.handle('app:update-install', () => {});

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
const click = (win, selector) => run(win, `document.querySelector(${JSON.stringify(selector)}).click()`);

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

  // 1. Inicio, con un enlace recién copiado
  clipboard = 'https://www.tiktok.com/@kerygma/video/7300000000000000000';
  await run(win, `window.dispatchEvent(new Event('focus'))`);
  await shot(win, '1-inicio.png');

  // 2. Video que es parte de una lista, con recorte y subtítulos
  await click(win, '#clipDismiss');
  await typeInto(win, 'url', 'https://youtu.be/06LjLWnkO0M?list=PLkerygma');
  await sleep(900);
  await click(win, '[data-tab="video"]');
  await run(win, `document.querySelectorAll('#subsSeg .seg-item')[1].click()`);
  await click(win, '#trimToggle');
  await typeInto(win, 'trimStart', '1:30');
  await typeInto(win, 'trimEnd', '3:45');
  await shot(win, '2-recorte.png');

  // 3. Lista completa → se descarga en cola (para WhatsApp)
  await click(win, '#trimToggle');
  await click(win, '#previewExtraBtn');
  await sleep(500);
  await run(win, `document.querySelectorAll('#presetGrid .chip')[1].click()`);
  await shot(win, '3-lista.png');
  await click(win, '#downloadBtn');
  await sleep(300);
  releaseCurrent();
  await sleep(300);
  await shot(win, '4-cola.png');

  // 5. Audio normalizado con portada (mientras la cola sigue)
  await click(win, '[data-tab="audio"]');
  await click(win, '#normalizeToggle');
  await typeInto(win, 'url', 'https://www.facebook.com/watch/?v=1234567890');
  await sleep(700);
  await shot(win, '5-audio.png');

  // 6. Historial
  await click(win, '#historyBtn');
  await sleep(400);
  await shot(win, '6-historial.png');
  await click(win, '#historyClose');

  // 7. Configuración
  await click(win, '#settingsBtn');
  await shot(win, '7-configuracion.png');

  // 8. Tema claro (con aviso de versión nueva)
  await click(win, '[data-setting="theme"] [data-value="light"]');
  await sleep(300);
  await click(win, '#modalClose');
  win.webContents.send('app:update', { version: '1.3.0', ready: true });
  await shot(win, '8-claro.png');

  // 9. En inglés
  await click(win, '#settingsBtn');
  await click(win, '[data-setting="theme"] [data-value="dark"]');
  await click(win, '[data-setting="language"] [data-value="en"]');
  await sleep(400);
  await click(win, '#modalClose');
  await click(win, '[data-tab="video"]');
  await shot(win, '9-ingles.png');

  app.quit();
});
