const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeFilename } = require('./validate');

/**
 * Servicio que habla con yt-dlp. Es la única capa que conoce los flags del
 * motor: si cambia la herramienta, solo se toca este archivo.
 *
 * No depende de Electron (salvo detectar `process.versions.electron`), por lo
 * que también se puede probar con Node plano (ver scripts/smoke-test.js).
 */

const VIDEO_CONTAINERS = ['mp4', 'mkv'];
const VIDEO_QUALITIES = ['best', '1080', '720', '480'];

// Formato de audio de la interfaz → { argumento de yt-dlp, extensión del archivo, ¿con pérdida? }
const AUDIO_FORMATS = {
  mp3: { arg: 'mp3', ext: 'mp3', lossy: true },
  m4a: { arg: 'm4a', ext: 'm4a', lossy: true },
  aac: { arg: 'aac', ext: 'aac', lossy: true },
  wav: { arg: 'wav', ext: 'wav', lossy: false },
  flac: { arg: 'flac', ext: 'flac', lossy: false },
  opus: { arg: 'opus', ext: 'opus', lossy: true },
  ogg: { arg: 'vorbis', ext: 'ogg', lossy: true },
};
const AUDIO_BITRATES = [128, 192, 256, 320];

/** Selector de formato de yt-dlp para video, con tope de altura opcional. */
function videoSelector(container, quality) {
  const h = quality && quality !== 'best' ? `[height<=${quality}]` : '';
  // MP4: prioriza H.264 + AAC (se reproduce en todo). MKV: lo mejor disponible (hasta 4K).
  // Los "b" del final cubren los sitios que entregan video y audio en un solo archivo
  // (TikTok, Facebook, Instagram, Vimeo).
  return container === 'mkv'
    ? `bv*${h}+ba/b${h}`
    : `bv*${h}[ext=mp4]+ba[ext=m4a]/b${h}[ext=mp4]/bv*${h}+ba/b${h}`;
}

// Orden de preferencia para MP4: H.264 y AAC primero. Sin esto, YouTube puede elegir AV1
// dentro de MP4 y TikTok HEVC, que no abren en todos los equipos.
const MP4_SORT = 'vcodec:h264,acodec:aac';
const PROGRESS_TEMPLATE =
  'download:[kg]%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

class CancelledError extends Error {
  constructor() {
    super('Descarga cancelada');
    this.name = 'CancelledError';
  }
}

function childEnv() {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  // Dentro de Electron, el propio ejecutable puede actuar como Node. yt-dlp
  // necesita un runtime de JavaScript para resolver los desafíos de YouTube.
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function commonArgs(bins) {
  return [
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--ffmpeg-location', bins.ffmpeg,
    '--js-runtimes', `node:${process.execPath}`,
  ];
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // El .exe de yt-dlp lanza un proceso hijo; /T lo termina también.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath;
  const ext = path.extname(filePath);
  const base = filePath.slice(0, -ext.length);
  let n = 2;
  while (fs.existsSync(`${base} (${n})${ext}`)) n += 1;
  return `${base} (${n})${ext}`;
}

/** Traduce los errores típicos de yt-dlp a mensajes comprensibles. */
function friendlyError(stderr, code) {
  const text = String(stderr || '');
  const line =
    text.split(/\r?\n/).filter((l) => l.includes('ERROR:')).pop() || text.trim().split(/\r?\n/).pop() || '';

  if (/sign in to confirm|not a bot/i.test(line))
    return 'El sitio pide verificar que no eres un robot. Prueba "Actualizar motor" e inténtalo de nuevo.';
  // Facebook, Instagram y Vimeo piden iniciar sesión para lo privado o restringido.
  if (/login required|log in|logged-in|cookies|registered users|requires authentication|private/i.test(line))
    return 'Este video requiere iniciar sesión (es privado o de acceso restringido). Por ahora solo se pueden descargar videos públicos.';
  if (/not available|unavailable|removed|does not exist|no video/i.test(line))
    return 'El video no está disponible (eliminado, privado o restringido en tu región).';
  if (/unsupported url/i.test(line))
    return 'Ese enlace no tiene un video que se pueda descargar.';
  if (/403|forbidden/i.test(line))
    return 'El sitio bloqueó la descarga (403). Presiona "Actualizar motor" e inténtalo de nuevo.';
  if (/unable to download|timed out|network|resolve|connection/i.test(line))
    return 'No se pudo conectar con el sitio. Revisa tu conexión a internet.';
  if (/ffmpeg|ffprobe/i.test(line)) return `Error al procesar el archivo con ffmpeg: ${line}`;
  return line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || `yt-dlp terminó con código ${code}.`;
}

/** Obtiene los metadatos del video sin descargarlo. */
async function getInfo(bins, url) {
  const child = spawn(bins.ytdlp, [...commonArgs(bins), '--dump-single-json', '--skip-download', url], {
    env: childEnv(),
    windowsHide: true,
  });
  const { code, stdout, stderr } = await collect(child);
  if (code !== 0) throw new Error(friendlyError(stderr, code));

  const j = JSON.parse(stdout);
  return {
    id: j.id,
    title: j.title,
    uploader: j.uploader || j.channel || '',
    duration: j.duration || null,
    thumbnail: j.thumbnail || null,
  };
}

function parseNumber(v) {
  if (v === undefined || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Borra restos de una descarga interrumpida (.part, .ytdl, pistas intermedias). */
function cleanupPartials(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath, path.extname(finalPath));
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.(f[\\w-]+\\..*|.*\\.part.*|.*\\.ytdl|.*\\.temp\\..*)$`);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (pattern.test(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    /* limpieza best-effort */
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Etiqueta compacta y válida como nombre de archivo: 75 → "1m15s", 3725 → "1h02m05s". */
function timeTag(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h${pad2(m)}m${pad2(s)}s` : `${m}m${pad2(s)}s`;
}

/** Divide un flujo de texto en líneas (yt-dlp y ffmpeg separan con \n o \r). */
function lineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop();
      lines.forEach(onLine);
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = '';
    },
  };
}

/**
 * Inicia una descarga. Devuelve { promise, cancel, finalPath }.
 *
 * @param {object} bins  rutas de resolveBinaries()
 * @param {object} job   { url, title, mode: 'video'|'audio', outputDir, overwrite?,
 *                         video?: { container: 'mp4'|'mkv', quality: 'best'|'1080'|'720'|'480' },
 *                         audio?: { format: 'mp3'|'m4a'|'aac'|'wav'|'flac'|'opus'|'ogg', bitrate: 128|192|256|320 },
 *                         section?: { start: number, end: number } }   (segundos; recorte opcional)
 * @param {(e: object) => void} onEvent  eventos { type: 'stage'|'progress', ... }
 */
function startDownload(bins, job, onEvent = () => {}) {
  const { url, title, mode, outputDir, section, overwrite = false } = job;
  const video = { container: 'mp4', quality: 'best', ...job.video };
  const audio = { format: 'mp3', bitrate: 192, ...job.audio };
  if (!VIDEO_CONTAINERS.includes(video.container)) throw new Error('Formato de video inválido.');
  if (!VIDEO_QUALITIES.includes(String(video.quality))) throw new Error('Calidad de video inválida.');
  if (!AUDIO_FORMATS[audio.format]) throw new Error('Formato de audio inválido.');
  if (!AUDIO_BITRATES.includes(Number(audio.bitrate))) throw new Error('Calidad de audio inválida.');

  fs.mkdirSync(outputDir, { recursive: true });

  const audioInfo = AUDIO_FORMATS[audio.format];
  const suffix = section ? ` (${timeTag(section.start)} a ${timeTag(section.end)})` : '';
  const safeTitle = sanitizeFilename(title).slice(0, 120 - suffix.length);
  const ext = mode === 'audio' ? audioInfo.ext : video.container;
  const wanted = path.join(outputDir, `${safeTitle}${suffix}.${ext}`);
  const finalPath = overwrite ? wanted : uniquePath(wanted);
  const template = `${finalPath.slice(0, -path.extname(finalPath).length).replace(/%/g, '%%')}.%(ext)s`;

  const args = [
    ...commonArgs(bins),
    '--newline',
    '--concurrent-fragments', '4',
    '--progress-template', PROGRESS_TEMPLATE,
    '--output', template,
  ];
  if (overwrite) args.push('--force-overwrites');

  if (section) {
    // yt-dlp delega el recorte en ffmpeg. Se fuerzan cortes exactos (re-codifica solo el tramo):
    // sin esto el corte cae en el punto de copia más cercano y el audio puede salir con segundos de más.
    args.push('--download-sections', `*${section.start}-${section.end}`, '--force-keyframes-at-cuts');
  }

  if (mode === 'audio') {
    args.push('-f', 'bestaudio/best', '-x', '--audio-format', audioInfo.arg);
    args.push('--audio-quality', audioInfo.lossy ? `${audio.bitrate}K` : '0');
    args.push('--embed-metadata');
  } else {
    args.push('-f', videoSelector(video.container, String(video.quality)), '--merge-output-format', video.container, '--embed-metadata');
    if (video.container === 'mp4') args.push('-S', MP4_SORT);
  }
  args.push(url);

  const sectionLength = section ? section.end - section.start : 0;
  const expectedStreams = mode === 'audio' ? 1 : 2;
  let streamIdx = 0;
  let cancelled = false;
  let stderr = '';

  const child = spawn(bins.ytdlp, args, { env: childEnv(), windowsHide: true });

  const handleLine = (line) => {
    // Recorte: yt-dlp no informa progreso, pero ffmpeg imprime "time=HH:MM:SS.xx".
    if (section) {
      const t = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        onEvent({ type: 'progress', percent: Math.min(95, (elapsed / sectionLength) * 95), speed: null, eta: null });
        return;
      }
    }

    if (line.startsWith('[kg]')) {
      if (section) return;
      const [, downloaded, total, estimate, speed, eta] = line.slice(4).split('|');
      const dl = parseNumber(downloaded);
      const size = parseNumber(total) || parseNumber(estimate);
      const frac = dl !== null && size ? Math.min(1, dl / size) : 0;
      const slot = Math.max(streamIdx, 1) - 1;
      const percent = Math.min(95, ((slot + frac) / expectedStreams) * 95);
      onEvent({ type: 'progress', percent, speed: parseNumber(speed), eta: parseNumber(eta) });
    } else if (line.startsWith('[download] Destination:')) {
      streamIdx = Math.min(streamIdx + 1, expectedStreams);
      let label;
      if (section) label = 'Descargando fragmento';
      else if (mode === 'audio') label = 'Descargando audio';
      else label = streamIdx === 1 ? 'Descargando video' : 'Descargando audio';
      onEvent({ type: 'stage', label });
    } else if (line.startsWith('[Merger]')) {
      onEvent({ type: 'stage', label: 'Uniendo video y audio', percent: 97 });
    } else if (line.startsWith('[ExtractAudio]')) {
      onEvent({ type: 'stage', label: `Convirtiendo a ${audio.format.toUpperCase()}`, percent: 97 });
    }
  };

  const out = lineSplitter(handleLine);
  const err = lineSplitter((line) => {
    stderr += `${line}\n`;
    handleLine(line);
  });
  child.stdout.on('data', (c) => out.push(String(c)));
  child.stderr.on('data', (c) => err.push(String(c)));

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      out.flush();
      err.flush();
      if (cancelled) {
        cleanupPartials(finalPath);
        reject(new CancelledError());
      } else if (code !== 0) {
        cleanupPartials(finalPath);
        reject(new Error(friendlyError(stderr, code)));
      } else if (!fs.existsSync(finalPath)) {
        reject(new Error('La descarga terminó pero no se encontró el archivo final.'));
      } else {
        resolve({ filePath: finalPath, size: fs.statSync(finalPath).size });
      }
    });
  });

  return {
    finalPath,
    promise,
    cancel: () => {
      cancelled = true;
      killTree(child);
    },
  };
}

/**
 * Actualiza yt-dlp en sitio. El motor vive en una carpeta de caché local y escribible
 * (ver binaries.js), así que no hace falta copiarlo ni pedir permisos.
 */
async function updateEngine(bins) {
  const child = spawn(bins.ytdlp, ['--ignore-config', '-U'], { env: childEnv(), windowsHide: true });
  const { code, stdout, stderr } = await collect(child);
  if (code !== 0) throw new Error(friendlyError(stderr || stdout, code));
  return stdout.trim().split(/\r?\n/).pop();
}

module.exports = {
  getInfo,
  startDownload,
  updateEngine,
  CancelledError,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
  AUDIO_FORMATS,
  AUDIO_BITRATES,
};
