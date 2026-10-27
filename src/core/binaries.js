const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Prepara los binarios externos (yt-dlp y ffmpeg) que viajan dentro de la app.
 *
 *  - Origen empaquetado:  <resources>/bin/
 *  - Origen desarrollo:   <proyecto>/bin/<os>-<arch>/   (lo llena `npm run fetch-bins`)
 *
 * Los binarios NO se ejecutan desde donde está la app: se copian una sola vez a
 * una carpeta local de caché (`engineDir`) y se ejecutan desde ahí. Motivos:
 *   1. Una app portable puede estar en el Escritorio/Documentos o en un USB; en macOS
 *      las carpetas sincronizadas con iCloud pueden dejar colgado a yt-dlp al arrancar.
 *   2. La caché siempre es escribible, así que `yt-dlp -U` puede actualizarse en sitio
 *      (YouTube cambia seguido) sin tocar la app ni pedir permisos.
 * Al instalar una versión nueva de la app se vuelven a copiar los binarios incluidos.
 */

const IS_WIN = process.platform === 'win32';
const YTDLP_NAME = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
const FFMPEG_NAME = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

function platformDirName() {
  const os = process.platform === 'darwin' ? 'mac' : IS_WIN ? 'win' : 'linux';
  return `${os}-${process.arch}`;
}

function bundledDir({ isPackaged, resourcesPath, projectRoot }) {
  return isPackaged
    ? path.join(resourcesPath, 'bin')
    : path.join(projectRoot, 'bin', platformDirName());
}

/**
 * macOS marca con "cuarentena" lo que viene de una descarga del navegador.
 * Se retira de los binarios copiados para que Gatekeeper no los bloquee.
 */
function clearQuarantine(dir) {
  if (process.platform !== 'darwin') return;
  execFile('xattr', ['-dr', 'com.apple.quarantine', dir], () => {});
}

function copyAtomic(src, dest) {
  const tmp = `${dest}.tmp`;
  fs.copyFileSync(src, tmp);
  if (!IS_WIN) fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
}

/** yt-dlp se descomprime solo en cada arranque; en equipos lentos o cargados puede tardar bastante. */
function readVersion(binPath) {
  return new Promise((resolve) => {
    execFile(binPath, ['--version'], { timeout: 120000, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim());
    });
  });
}

/**
 * @param {object} ctx
 * @param {boolean} ctx.isPackaged
 * @param {string}  ctx.resourcesPath
 * @param {string}  ctx.projectRoot
 * @param {string}  ctx.engineDir   carpeta local donde viven los binarios en uso
 * @param {string}  ctx.appVersion  al cambiar, se vuelven a copiar los binarios incluidos
 */
async function resolveBinaries(ctx) {
  const srcDir = bundledDir(ctx);
  const srcYtDlp = path.join(srcDir, YTDLP_NAME);
  const srcFfmpeg = path.join(srcDir, FFMPEG_NAME);

  if (!fs.existsSync(srcYtDlp) || !fs.existsSync(srcFfmpeg)) {
    throw new Error(
      `Faltan los binarios internos en ${srcDir}. Ejecuta "npm run fetch-bins" (modo desarrollo) o reinstala la app.`
    );
  }

  fs.mkdirSync(ctx.engineDir, { recursive: true });
  const ytdlp = path.join(ctx.engineDir, YTDLP_NAME);
  const ffmpeg = path.join(ctx.engineDir, FFMPEG_NAME);
  const stampFile = path.join(ctx.engineDir, '.stamp');

  const stamp = [ctx.appVersion, fs.statSync(srcYtDlp).size, fs.statSync(srcFfmpeg).size].join('|');
  let current = '';
  try {
    current = fs.readFileSync(stampFile, 'utf8');
  } catch {
    /* primera ejecución */
  }

  if (current !== stamp || !fs.existsSync(ytdlp) || !fs.existsSync(ffmpeg)) {
    copyAtomic(srcYtDlp, ytdlp);
    copyAtomic(srcFfmpeg, ffmpeg);
    fs.writeFileSync(stampFile, stamp);
    clearQuarantine(ctx.engineDir);
  }

  return { ytdlp, ffmpeg };
}

module.exports = { resolveBinaries, readVersion, platformDirName, YTDLP_NAME, FFMPEG_NAME };
