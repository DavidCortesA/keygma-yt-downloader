const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { resolveBinaries } = require('./src/core/binaries');
const ytdlp = require('./src/core/ytdlp');
const { isValidYoutubeUrl } = require('./src/core/validate');

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

function defaultSettings() {
  return {
    outputDir: path.join(app.getPath('downloads'), 'Kerygma'),
    mode: 'video',
    audioFormat: 'mp3',
  };
}

function loadSettings() {
  try {
    return { ...defaultSettings(), ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
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

/* ------------------------------------------------------------------ */
/* Ventana                                                             */
/* ------------------------------------------------------------------ */
let mainWindow = null;
const jobs = new Map(); // jobId -> { cancel }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 780,
    minWidth: 700,
    minHeight: 660,
    title: APP_NAME,
    backgroundColor: '#0a0a0a',
    icon: path.join(__dirname, 'src', 'renderer', 'assets', 'icon.png'),
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 18 },
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
    const base = {
      name: APP_NAME,
      version: app.getVersion(),
      platform: process.platform,
      settings: loadSettings(),
    };
    try {
      const bins = await loadBins();
      return { ...base, engineVersion: bins.version, engineError: null };
    } catch (err) {
      return { ...base, engineVersion: null, engineError: err.message };
    }
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const allowed = {};
    if (typeof patch?.outputDir === 'string' && patch.outputDir) allowed.outputDir = patch.outputDir;
    if (['video', 'audio'].includes(patch?.mode)) allowed.mode = patch.mode;
    if (['mp3', 'm4a'].includes(patch?.audioFormat)) allowed.audioFormat = patch.audioFormat;
    return saveSettings(allowed);
  });

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
    const audioFormat = ['mp3', 'm4a'].includes(req.audioFormat) ? req.audioFormat : 'mp3';
    if (typeof req.outputDir !== 'string' || !req.outputDir) throw new Error('Elige una carpeta de destino.');

    let section = null;
    if (req.section) {
      const { start, end } = req.section;
      if (![start, end].every(Number.isFinite) || start < 0 || end - start < 1) {
        throw new Error('El rango de tiempo no es válido.');
      }
      section = { start, end };
    }

    const bins = await loadBins();
    const jobId = randomUUID();
    const send = (payload) => {
      if (!e.sender.isDestroyed()) e.sender.send('download:event', { jobId, ...payload });
    };

    const job = ytdlp.startDownload(
      bins,
      { url: req.url.trim(), title: req.title, mode: req.mode, audioFormat, outputDir: req.outputDir, section },
      send
    );
    jobs.set(jobId, job);

    try {
      return await job.promise;
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
    const fresh = await loadBins(true);
    return { message, engineVersion: fresh.version };
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
    buildMenu();
    registerIpc();
    createWindow();
    loadBins().catch(() => {}); // precalienta; el error se informa desde app:init

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => jobs.forEach((job) => job.cancel()));
  app.on('window-all-closed', () => app.quit());
}
