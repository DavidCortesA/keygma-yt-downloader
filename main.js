const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { resolveBinaries } = require('./src/core/binaries');
const ytdlp = require('./src/core/ytdlp');
const { isValidYoutubeUrl } = require('./src/core/validate');
const { readVersion } = require('./src/core/binaries');
const settingsSchema = require('./src/core/settings');

const APP_NAME = 'Kerygma YT Downloader';
const IS_MAC = process.platform === 'darwin';

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
  return loadSettings();
}

/* ------------------------------------------------------------------ */
/* Motor (yt-dlp + ffmpeg)                                             */
/* ------------------------------------------------------------------ */
let binsPromise = null;

function loadBins(force = false) {
  if (!binsPromise || force) {
    binsPromise = resolveBinaries({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: __dirname,
      engineDir: path.join(app.getPath('cache'), APP_NAME, 'engine'),
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

/* ------------------------------------------------------------------ */
/* Ventana                                                             */
/* ------------------------------------------------------------------ */
let mainWindow = null;
const jobs = new Map(); // jobId -> { cancel }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e10' : '#f5f5f6',
    icon: path.join(__dirname, 'src', 'renderer', 'assets', 'icon.png'),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 20, y: 17 },
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
    Menu.buildFromTemplate([
      { label: 'Cortar', role: 'cut', enabled: params.editFlags.canCut },
      { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
      { label: 'Pegar', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Seleccionar todo', role: 'selectAll' },
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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about', label: `Acerca de ${APP_NAME}` }, { type: 'separator' }, { role: 'hide', label: 'Ocultar' }, { role: 'quit', label: 'Salir' }] },
      { label: 'Edición', submenu: [{ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' }, { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
      { label: 'Ventana', submenu: [{ role: 'minimize', label: 'Minimizar' }, { role: 'close', label: 'Cerrar' }] },
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
      settings: loadSettings(),
      engineError,
    };
  });

  ipcMain.handle('engine:version', () => engineVersion().catch(() => null));

  ipcMain.handle('settings:save', (_e, patch) => saveSettings(settingsSchema.sanitize(patch)));

  ipcMain.handle('dialog:chooseFolder', async (_e, current) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Carpeta de destino',
      defaultPath: typeof current === 'string' ? current : undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('video:info', async (_e, url) => {
    if (!isValidYoutubeUrl(url)) throw new Error('El enlace no parece ser de YouTube.');
    const bins = await loadBins();
    return ytdlp.getInfo(bins, url.trim());
  });

  ipcMain.handle('download:start', async (e, req) => {
    if (jobs.size > 0) throw new Error('Ya hay una descarga en curso.');
    if (!isValidYoutubeUrl(req?.url)) throw new Error('El enlace no parece ser de YouTube.');
    if (!['video', 'audio'].includes(req.mode)) throw new Error('Tipo de descarga inválido.');
    if (typeof req.outputDir !== 'string' || !req.outputDir) throw new Error('Elige una carpeta de destino.');

    // Mismas reglas de validación que la configuración (formato, calidad...).
    const opts = settingsSchema.sanitize({ video: req.video, audio: req.audio });

    let section = null;
    if (req.section) {
      const { start, end } = req.section;
      if (![start, end].every(Number.isFinite) || start < 0 || end - start < 1) {
        throw new Error('El rango de tiempo no es válido.');
      }
      section = { start, end };
    }

    const settings = loadSettings();
    const bins = await loadBins();
    const jobId = randomUUID();
    const send = (payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('download:event', { jobId, ...payload });
    };

    const job = ytdlp.startDownload(
      bins,
      {
        url: req.url.trim(),
        title: req.title,
        mode: req.mode,
        outputDir: req.outputDir,
        overwrite: settings.onExists === 'replace',
        video: opts.video,
        audio: opts.audio,
        section,
      },
      send
    );
    jobs.set(jobId, job);

    try {
      const result = await job.promise;
      if (settings.notify && mainWindow && !mainWindow.isFocused() && Notification.isSupported()) {
        new Notification({ title: 'Descarga completa', body: path.basename(result.filePath) }).show();
      }
      if (settings.openFolder) shell.showItemInFolder(result.filePath);
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
    if (jobs.size > 0) throw new Error('Espera a que termine la descarga en curso.');
    const bins = await loadBins();
    const message = await ytdlp.updateEngine(bins);
    return { message, engineVersion: await engineVersion(true) };
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
    nativeTheme.themeSource = loadSettings().theme;
    buildMenu();
    registerIpc();
    createWindow();
    loadBins().then(() => engineVersion()).catch(() => {}); // precalienta el motor; el error se informa desde app:init

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => jobs.forEach((job) => job.cancel()));
  app.on('window-all-closed', () => app.quit());
}
