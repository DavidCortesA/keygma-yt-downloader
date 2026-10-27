const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, nativeTheme, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { resolveBinaries, readVersion } = require('./src/core/binaries');
const ytdlp = require('./src/core/ytdlp');
const { isSupportedUrl, detectPlatform, listingUrl } = require('./src/core/validate');
const settingsSchema = require('./src/core/settings');
const { createHistory } = require('./src/core/history');
const updates = require('./src/core/updates');
const { KgError } = require('./src/core/errors');

const APP_NAME = 'Kerygma Downloader';
const IS_MAC = process.platform === 'darwin';
const ENGINE_CHECK_EVERY = 20 * 60 * 60 * 1000; // el motor se revisa como máximo una vez al día

/* ------------------------------------------------------------------ */
/* Modo portable: dónde guardar la configuración                       */
/* ------------------------------------------------------------------ */
// 1) .exe portable de Windows → carpeta "KerygmaData" junto al ejecutable.
// 2) Cualquier plataforma → si existe una carpeta "KerygmaData" junto a la app,
//    se usa (basta con crearla para tener la app 100 % autocontenida, ej. en un USB).
function configurePortableData() {
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push({ dir: process.env.PORTABLE_EXECUTABLE_DIR, create: true });
  }
  if (app.isPackaged) {
    const exe = app.getPath('exe');
    const appDir = IS_MAC ? path.resolve(exe, '..', '..', '..', '..') : path.dirname(exe);
    candidates.push({ dir: appDir, create: false });
  }

  for (const { dir, create } of candidates) {
    const dataDir = path.join(dir, 'KerygmaData');
    if (create || fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        app.setPath('userData', dataDir);
        return;
      } catch {
        /* carpeta de solo lectura: se usa la ubicación estándar */
      }
    }
  }
}
configurePortableData();

// Hasta la 1.0 la app se llamaba "Kerygma YT Downloader" y su carpeta de datos tenía ese
// nombre. Si la carpeta nueva aún no tiene configuración, se copia la anterior.
function migrateOldSettings() {
  const target = path.join(app.getPath('userData'), 'settings.json');
  const old = path.join(app.getPath('appData'), 'Kerygma YT Downloader', 'settings.json');
  if (fs.existsSync(target) || !fs.existsSync(old)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(old, target);
  } catch {
    /* sin migración: se usan los valores de fábrica */
  }
}

/* ------------------------------------------------------------------ */
/* Configuración persistente                                           */
/* ------------------------------------------------------------------ */
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

const defaultSettings = () => settingsSchema.defaults(path.join(app.getPath('downloads'), 'Kerygma'));

function readStored() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** Configuración tal como la usa la app (aplica la regla de "recordar opciones"). */
const loadSettings = () => settingsSchema.effective(readStored(), defaultSettings());

function saveSettings(patch) {
  const stored = settingsSchema.merge(settingsSchema.merge(defaultSettings(), settingsSchema.sanitize(readStored())), patch);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(stored, null, 2));
  nativeTheme.themeSource = stored.theme;
  if ('language' in patch) buildMenu();
  return loadSettings();
}

let history = null;

/* ------------------------------------------------------------------ */
/* Idioma de los textos del proceso principal                          */
/* ------------------------------------------------------------------ */
// El resto de la interfaz se traduce en src/renderer/i18n.js.
const TEXT = {
  es: {
    folderTitle: 'Carpeta de destino', done: 'Descarga completa',
    about: 'Acerca de', hide: 'Ocultar', quit: 'Salir', edit: 'Edición', undo: 'Deshacer', redo: 'Rehacer',
    cut: 'Cortar', copy: 'Copiar', paste: 'Pegar', selectAll: 'Seleccionar todo', window: 'Ventana', minimize: 'Minimizar', close: 'Cerrar',
  },
  en: {
    folderTitle: 'Destination folder', done: 'Download complete',
    about: 'About', hide: 'Hide', quit: 'Quit', edit: 'Edit', undo: 'Undo', redo: 'Redo',
    cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', window: 'Window', minimize: 'Minimize', close: 'Close',
  },
};

/** Idioma efectivo: el elegido, o el del sistema (español si empieza por "es"; si no, inglés). */
function language() {
  const choice = loadSettings().language;
  if (choice === 'es' || choice === 'en') return choice;
  return app.getLocale().toLowerCase().startsWith('es') ? 'es' : 'en';
}
const tx = () => TEXT[language()];

/* ------------------------------------------------------------------ */
/* Motor (yt-dlp + ffmpeg)                                             */
/* ------------------------------------------------------------------ */
let binsPromise = null;
const engineDir = () => path.join(app.getPath('cache'), APP_NAME, 'engine');

function loadBins(force = false) {
  if (!binsPromise || force) {
    binsPromise = resolveBinaries({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: __dirname,
      engineDir: engineDir(),
      appVersion: app.getVersion(),
    });
  }
  return binsPromise;
}

let versionPromise = null;
let versionFor = null;

/** La primera ejecución de yt-dlp puede tardar (se descomprime solo); por eso no bloquea el arranque. */
async function engineVersion(force = false) {
  const bins = await loadBins();
  if (force || !versionPromise || versionFor !== bins.ytdlp) {
    versionFor = bins.ytdlp;
    versionPromise = readVersion(bins.ytdlp);
  }
  return versionPromise;
}

let engineUpdating = null;

/** yt-dlp -U; devuelve { message, engineVersion, changed }. */
function updateEngineNow() {
  if (!engineUpdating) {
    engineUpdating = (async () => {
      const bins = await loadBins();
      const before = await engineVersion();
      const message = await ytdlp.updateEngine(bins);
      const after = await engineVersion(true);
      fs.writeFileSync(path.join(engineDir(), '.last-check'), String(Date.now()));
      return { message, engineVersion: after, changed: !!after && after !== before };
    })().finally(() => { engineUpdating = null; });
  }
  return engineUpdating;
}

/**
 * Los sitios cambian seguido y una versión vieja de yt-dlp deja de funcionar de un día
 * para otro: al abrir la app se actualiza sola, una vez al día y nunca durante una descarga.
 */
async function autoUpdateEngine() {
  if (!loadSettings().autoUpdateEngine) return;
  let last = 0;
  try {
    last = Number(fs.readFileSync(path.join(engineDir(), '.last-check'), 'utf8')) || 0;
  } catch {
    /* nunca se revisó */
  }
  if (Date.now() - last < ENGINE_CHECK_EVERY || jobs.size > 0) return;
  try {
    const result = await updateEngineNow();
    if (result.changed) send('engine:updated', { engineVersion: result.engineVersion });
  } catch {
    /* sin red o sin permisos: se reintenta la próxima vez */
  }
}

/* ------------------------------------------------------------------ */
/* Actualizaciones de la app                                           */
/* ------------------------------------------------------------------ */
let appUpdate = null; // { version, url?, ready? }
let autoUpdater = null;

/** Windows instalado: descarga e instala solo. macOS y portable: aviso con enlace a la Release. */
async function checkAppUpdates() {
  if (!app.isPackaged || !loadSettings().checkAppUpdates) return;
  const canInstall = process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_DIR;
  if (canInstall) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-downloaded', (info) => {
        appUpdate = { version: info.version, ready: true };
        send('app:update', appUpdate);
      });
      await autoUpdater.checkForUpdates();
      return;
    } catch {
      autoUpdater = null; // si falla, al menos se avisa
    }
  }
  const latest = await updates.checkLatest(app.getVersion());
  if (latest) {
    appUpdate = latest;
    send('app:update', appUpdate);
  }
}

/* ------------------------------------------------------------------ */
/* Ventana                                                             */
/* ------------------------------------------------------------------ */
let mainWindow = null;
const jobs = new Map(); // jobId -> { cancel }

const send = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

// En Windows y Linux los botones de la ventana se dibujan sobre la barra superior de la app
// (como en Kerygma Converter); deben coincidir con --bg y --muted de styles.css.
const TITLEBAR = {
  dark: { color: '#0e0e10', symbolColor: '#8e8e98', height: 60 },
  light: { color: '#f5f5f6', symbolColor: '#5f5f69', height: 60 },
};
const titlebarColors = () => TITLEBAR[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

nativeTheme.on('updated', () => {
  if (!mainWindow) return;
  mainWindow.setBackgroundColor(titlebarColors().color);
  if (!IS_MAC) mainWindow.setTitleBarOverlay(titlebarColors());
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: titlebarColors().color,
    icon: path.join(__dirname, 'src', 'renderer', 'assets', 'icon.png'),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
    ...(IS_MAC ? { trafficLightPosition: { x: 20, y: 22 } } : { titleBarOverlay: titlebarColors() }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  // La app solo muestra su propia interfaz: se bloquea cualquier navegación externa.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.webContents.on('context-menu', (_e, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const t = tx();
    Menu.buildFromTemplate([
      { label: t.cut, role: 'cut', enabled: params.editFlags.canCut },
      { label: t.copy, role: 'copy', enabled: params.editFlags.canCopy },
      { label: t.paste, role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: t.selectAll, role: 'selectAll' },
    ]).popup();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  const t = tx();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about', label: `${t.about} ${APP_NAME}` }, { type: 'separator' }, { role: 'hide', label: t.hide }, { role: 'quit', label: t.quit }] },
      { label: t.edit, submenu: [{ role: 'undo', label: t.undo }, { role: 'redo', label: t.redo }, { type: 'separator' }, { role: 'cut', label: t.cut }, { role: 'copy', label: t.copy }, { role: 'paste', label: t.paste }, { role: 'selectAll', label: t.selectAll }] },
      { label: t.window, submenu: [{ role: 'minimize', label: t.minimize }, { role: 'close', label: t.close }] },
    ])
  );
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('app:init', async () => {
    let engineError = null;
    try {
      await loadBins();
    } catch (err) {
      engineError = err.message;
    }
    return {
      name: APP_NAME,
      version: app.getVersion(),
      electron: process.versions.electron,
      platform: process.platform,
      language: language(),
      settings: loadSettings(),
      engineError,
      appUpdate,
    };
  });

  ipcMain.handle('engine:version', () => engineVersion().catch(() => null));

  ipcMain.handle('settings:save', (_e, patch) => {
    const saved = saveSettings(settingsSchema.sanitize(patch));
    return { settings: saved, language: language() };
  });

  ipcMain.handle('dialog:chooseFolder', async (_e, current) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: tx().folderTitle,
      defaultPath: typeof current === 'string' ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  // Un video o, si el enlace es una lista o un canal (o playlist: true), la lista completa.
  ipcMain.handle('video:info', async (_e, url, opts = {}) => {
    const platform = detectPlatform(url);
    if (!platform) throw new KgError('BAD_URL');
    const bins = await loadBins();
    const asList = platform.kind === 'playlist' || opts.playlist === true;
    const target = asList && platform.listUrl && opts.playlist ? platform.listUrl : url;
    const info = await ytdlp.getInfo(bins, asList ? listingUrl(target) : url.trim(), { playlist: asList });
    return { ...info, platform: platform.name, listUrl: info.type === 'video' ? platform.listUrl || null : null };
  });

  ipcMain.handle('download:start', async (e, req) => {
    if (jobs.size > 0) throw new KgError('BUSY');
    if (!isSupportedUrl(req?.url)) throw new KgError('BAD_URL');
    if (!['video', 'audio'].includes(req.mode)) throw new KgError('BAD_OPTION', 'mode');
    if (typeof req.outputDir !== 'string' || !req.outputDir) throw new KgError('NO_FOLDER');

    // Mismas reglas de validación que la configuración (formato, calidad, destino...).
    const opts = settingsSchema.sanitize({ video: req.video, audio: req.audio });

    let section = null;
    if (req.section) {
      const { start, end } = req.section;
      if (![start, end].every(Number.isFinite) || start < 0 || end - start < 1) throw new KgError('BAD_RANGE');
      section = { start, end };
    }

    const settings = loadSettings();
    const bins = await loadBins();
    const jobId = randomUUID();
    const emit = (payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('download:event', { jobId, ...payload });
    };

    const job = ytdlp.startDownload(
      bins,
      {
        url: req.url.trim(),
        title: String(req.title || 'video'),
        mode: req.mode,
        outputDir: req.outputDir,
        overwrite: settings.onExists === 'replace',
        duration: Number.isFinite(req.duration) ? req.duration : 0,
        video: opts.video,
        audio: opts.audio,
        section,
      },
      emit
    );
    jobs.set(jobId, job);

    try {
      const result = await job.promise;
      const ext = path.extname(result.filePath).slice(1).toUpperCase();
      history.add({
        title: req.title, url: req.url.trim(), platform: detectPlatform(req.url)?.name || '',
        kind: req.mode, ext, filePath: result.filePath, size: result.size, thumbnail: req.thumbnail,
      });
      if (settings.notify && !req.silent && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
        new Notification({ title: tx().done, body: path.basename(result.filePath) }).show();
      }
      if (settings.openFolder && !req.silent) shell.showItemInFolder(result.filePath);
      return result;
    } catch (err) {
      if (err instanceof ytdlp.CancelledError) return { cancelled: true };
      throw err;
    } finally {
      jobs.delete(jobId);
    }
  });

  ipcMain.handle('download:cancel', () => {
    jobs.forEach((job) => job.cancel());
  });

  ipcMain.handle('shell:showItem', (_e, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('shell:openFolder', async (_e, dir) => {
    if (typeof dir !== 'string') return;
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle('engine:update', async () => {
    if (jobs.size > 0) throw new KgError('BUSY');
    return updateEngineNow();
  });

  ipcMain.handle('history:list', () => history.list());
  ipcMain.handle('history:remove', (_e, id) => typeof id === 'string' && history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());

  // Solo se devuelve si parece un enlace admitido: la app no lee nada más del portapapeles.
  ipcMain.handle('clipboard:link', () => {
    const text = clipboard.readText().trim();
    return text.length < 4000 && text.split(/\s+/).some(isSupportedUrl) ? text : '';
  });

  ipcMain.handle('app:update-install', () => {
    if (appUpdate?.ready && autoUpdater) autoUpdater.quitAndInstall();
    else shell.openExternal(updates.RELEASES_URL);
  });
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setName(APP_NAME);

  app.whenReady().then(() => {
    app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() });
    migrateOldSettings();
    history = createHistory(path.join(app.getPath('userData'), 'history.json'));
    nativeTheme.themeSource = loadSettings().theme;
    buildMenu();
    registerIpc();
    createWindow();
    // Precalienta el motor; el error se informa desde app:init. Luego, revisiones en segundo plano.
    loadBins()
      .then(() => engineVersion())
      .then(() => autoUpdateEngine())
      .catch(() => {});
    mainWindow.webContents.once('did-finish-load', () => setTimeout(checkAppUpdates, 4000));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => jobs.forEach((job) => job.cancel()));
  app.on('window-all-closed', () => app.quit());
}
