const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeFilename } = require('./validate');
const { KgError } = require('./errors');
const post = require('./postprocess');

/**
 * Servicio que habla con yt-dlp. Es la única capa que conoce los flags del
 * motor: si cambia la herramienta, solo se toca este archivo.
 *
 * No depende de Electron (salvo detectar `process.versions.electron`), por lo
 * que también se puede probar con Node plano (ver scripts/smoke-test.js).
 *
 * Los errores son KgError con código (la interfaz los traduce) y las etapas de la
 * descarga se informan como códigos: video, audio, section, merge, extract, subs,
 * cover, normalize, preset.
 */

const VIDEO_CONTAINERS = ['mp4', 'mkv'];
const VIDEO_QUALITIES = ['best', '1080', '720', '480'];
const VIDEO_PRESETS = ['manual', ...Object.keys(post.VIDEO_PRESETS)];
const SUBTITLE_LANGS = ['none', 'es', 'en'];

// Formato de audio de la interfaz → { argumento de yt-dlp, extensión del archivo, ¿con pérdida?, ¿admite portada? }
const AUDIO_FORMATS = {
  mp3: { arg: 'mp3', ext: 'mp3', lossy: true, cover: true },
  m4a: { arg: 'm4a', ext: 'm4a', lossy: true, cover: true },
  aac: { arg: 'aac', ext: 'aac', lossy: true, cover: false },
  wav: { arg: 'wav', ext: 'wav', lossy: false, cover: false },
  flac: { arg: 'flac', ext: 'flac', lossy: false, cover: true },
  opus: { arg: 'opus', ext: 'opus', lossy: true, cover: true },
  ogg: { arg: 'vorbis', ext: 'ogg', lossy: true, cover: true },
};
const AUDIO_BITRATES = [128, 192, 256, 320];

/** Selector de formato de yt-dlp para video. Los "b" del final cubren los sitios que
 *  entregan video y audio en un solo archivo (TikTok, Facebook, Instagram, Vimeo). */
const videoSelector = (container) => (container === 'mkv'
  ? 'bv*+ba/b'
  : 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');

/**
 * Orden de preferencia de formatos (-S). "res:N" usa el lado corto del video, así un tope
 * de 1080p sirve igual para videos horizontales y verticales (TikTok, Shorts, Reels).
 * MP4 prefiere H.264 + AAC: si no, YouTube puede elegir AV1 y TikTok HEVC, que no abren
 * en todos los equipos.
 */
function videoSort(container, quality) {
  const sort = container === 'mp4' ? ['vcodec:h264'] : [];
  if (quality && quality !== 'best') sort.push(`res:${quality}`);
  if (container === 'mp4') sort.push('acodec:aac');
  return sort.join(',');
}

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

/** Traduce los errores típicos de yt-dlp a un código (la interfaz pone el texto). */
function friendlyError(stderr, code) {
  const text = String(stderr || '');
  const line =
    text.split(/\r?\n/).filter((l) => l.includes('ERROR:')).pop() || text.trim().split(/\r?\n/).pop() || '';

  if (/sign in to confirm|not a bot/i.test(line)) return new KgError('VERIFY');
  // Facebook, Instagram y Vimeo piden iniciar sesión para lo privado o restringido.
  if (/login required|log in|logged-in|cookies|registered users|requires authentication|private/i.test(line)) return new KgError('LOGIN');
  if (/not available|unavailable|removed|does not exist|no video/i.test(line)) return new KgError('UNAVAILABLE');
  if (/unsupported url/i.test(line)) return new KgError('UNSUPPORTED');
  if (/403|forbidden/i.test(line)) return new KgError('BLOCKED');
  if (/unable to download|timed out|network|resolve|connection/i.test(line)) return new KgError('NETWORK');
  if (/ffmpeg|ffprobe/i.test(line)) return new KgError('FFMPEG', line);
  return new KgError('ENGINE', line.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') || `yt-dlp ${code}`);
}

/** Miniatura más grande de una entrada de yt-dlp. */
const bestThumbnail = (j) => j.thumbnail || (Array.isArray(j.thumbnails) && j.thumbnails.length ? j.thumbnails[j.thumbnails.length - 1].url : null);

/**
 * Metadatos sin descargar. Con playlist: true lista una lista o un canal de forma rápida
 * (--flat-playlist: solo título, enlace, duración y miniatura de cada video).
 */
async function getInfo(bins, url, { playlist = false } = {}) {
  const args = [...commonArgs(bins), '--dump-single-json', '--skip-download'];
  args.push(...(playlist ? ['--yes-playlist', '--flat-playlist'] : ['--no-playlist']));
  args.push(url);
  const child = spawn(bins.ytdlp, args, { env: childEnv(), windowsHide: true });
  const { code, stdout, stderr } = await collect(child);
  if (code !== 0) throw friendlyError(stderr, code);

  const j = JSON.parse(stdout);
  if (playlist || j._type === 'playlist') {
    const entries = (j.entries || [])
      .filter((e) => e && (e.url || e.webpage_url || e.id))
      .map((e) => ({
        url: e.webpage_url || (/^https?:/.test(e.url || '') ? e.url : `https://www.youtube.com/watch?v=${e.id}`),
        title: e.title || e.id,
        duration: e.duration || null,
        thumbnail: bestThumbnail(e),
      }));
    return {
      type: 'playlist',
      id: j.id,
      title: j.title || '',
      uploader: j.uploader || j.channel || '',
      count: entries.length,
      thumbnail: bestThumbnail(j) || entries[0]?.thumbnail || null,
      entries,
    };
  }
  return {
    type: 'video',
    id: j.id,
    title: j.title,
    uploader: j.uploader || j.channel || '',
    duration: j.duration || null,
    thumbnail: bestThumbnail(j),
  };
}

function parseNumber(v) {
  if (v === undefined || v === '' || v === 'NA' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Borra restos de una descarga interrumpida (.part, .ytdl, pistas intermedias, temporales). */
function cleanupPartials(finalPath) {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath, path.extname(finalPath));
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.(f[\\w-]+\\..*|.*\\.part.*|.*\\.ytdl|.*\\.temp\\..*|kg-tmp\\..*)$`);
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

/** Completa y valida las opciones de una descarga (lanza KgError si algo no es válido). */
function normalizeJob(job) {
  const video = { container: 'mp4', quality: 'best', preset: 'manual', subtitles: 'none', subMode: 'embed', ...job.video };
  const audio = { format: 'mp3', bitrate: 192, normalize: false, cover: true, ...job.audio };
  if (!VIDEO_CONTAINERS.includes(video.container)) throw new KgError('BAD_OPTION', 'container');
  if (!VIDEO_QUALITIES.includes(String(video.quality))) throw new KgError('BAD_OPTION', 'quality');
  if (!VIDEO_PRESETS.includes(video.preset)) throw new KgError('BAD_OPTION', 'preset');
  if (!SUBTITLE_LANGS.includes(video.subtitles) || !['embed', 'file'].includes(video.subMode)) throw new KgError('BAD_OPTION', 'subtitles');
  if (!AUDIO_FORMATS[audio.format]) throw new KgError('BAD_OPTION', 'format');
  if (!AUDIO_BITRATES.includes(Number(audio.bitrate))) throw new KgError('BAD_OPTION', 'bitrate');
  // Un destino siempre entrega MP4.
  if (video.preset !== 'manual') video.container = 'mp4';
  return { ...job, video, audio };
}

/**
 * Argumentos de yt-dlp para una descarga (función pura: se prueba sin red).
 * `base` es la ruta final sin extensión.
 */
function buildArgs(bins, job, base) {
  const { url, mode, section, overwrite = false, video, audio } = job;
  const audioInfo = AUDIO_FORMATS[audio.format];
  const args = [
    ...commonArgs(bins),
    '--no-playlist',
    '--newline',
    '--concurrent-fragments', '4',
    '--progress-template', PROGRESS_TEMPLATE,
    '--output', `${base.replace(/%/g, '%%')}.%(ext)s`,
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
    // Portada del video dentro del archivo (se ve en el celular, el auto o la app de música).
    if (audio.cover && audioInfo.cover) args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
  } else {
    // Con un destino se baja hasta 1080p (lado corto) y luego ffmpeg lo ajusta.
    const quality = video.preset !== 'manual' ? '1080' : String(video.quality);
    args.push('-f', videoSelector(video.container), '-S', videoSort(video.container, quality));
    args.push('--merge-output-format', video.container, '--embed-metadata');
    if (video.subtitles !== 'none') {
      // Subtítulos subidos por el autor y, si no hay, los automáticos de YouTube.
      args.push('--write-subs', '--write-auto-subs', '--sub-langs', `${video.subtitles}.*,${video.subtitles}`, '--convert-subs', 'srt');
      if (video.subMode === 'embed') args.push('--embed-subs');
    }
  }
  args.push(url);
  return args;
}

// Archivos que yt-dlp anuncia con "Destination" pero que no son el video ni el audio.
const SIDE_FILE = /\.(vtt|srt|ass|json3|srv\d|ttml|jpe?g|webp|png)$/i;

/**
 * Inicia una descarga. Devuelve { promise, cancel, finalPath }.
 *
 * @param {object} bins  rutas de resolveBinaries()
 * @param {object} job   { url, title, mode: 'video'|'audio', outputDir, overwrite?, duration?,
 *                         video?: { container, quality, preset, subtitles: 'none'|'es'|'en', subMode: 'embed'|'file' },
 *                         audio?: { format, bitrate, normalize: boolean, cover: boolean },
 *                         section?: { start: number, end: number } }   (segundos; recorte opcional)
 * @param {(e: object) => void} onEvent  eventos { type: 'stage', stage, percent? } y { type: 'progress', percent, speed, eta }
 */
function startDownload(bins, rawJob, onEvent = () => {}) {
  const job = normalizeJob(rawJob);
  const { title, mode, outputDir, section, overwrite = false, video, audio } = job;
  const preset = mode === 'video' && video.preset !== 'manual' ? video.preset : null;
  const normalize = mode === 'audio' && audio.normalize;
  const clipLength = section ? section.end - section.start : job.duration || 0;

  // Un video demasiado largo para el límite del destino se avisa antes de descargar nada.
  const maxSec = preset && post.maxSeconds(preset);
  if (maxSec && clipLength > maxSec) throw new KgError('TOO_LONG', maxSec);

  fs.mkdirSync(outputDir, { recursive: true });

  const audioInfo = AUDIO_FORMATS[audio.format];
  const suffix = section ? ` (${timeTag(section.start)} a ${timeTag(section.end)})` : '';
  const safeTitle = sanitizeFilename(title).slice(0, 120 - suffix.length);
  const ext = mode === 'audio' ? audioInfo.ext : video.container;
  const wanted = path.join(outputDir, `${safeTitle}${suffix}.${ext}`);
  const finalPath = overwrite ? wanted : uniquePath(wanted);
  const base = finalPath.slice(0, -path.extname(finalPath).length);

  // Reparto de la barra de progreso entre la descarga y el paso de ffmpeg posterior.
  const dlSpan = preset ? 50 : normalize ? 85 : 95;
  const expectedStreams = mode === 'audio' ? 1 : 2;
  let streamIdx = 0;
  let cancelled = false;
  let current = null;
  let stderr = '';

  const handleLine = (line) => {
    // Recorte: yt-dlp no informa progreso, pero ffmpeg imprime "time=HH:MM:SS.xx".
    if (section) {
      const t = line.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        const elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        onEvent({ type: 'progress', percent: Math.min(dlSpan, (elapsed / clipLength) * dlSpan), speed: null, eta: null });
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
      const percent = Math.min(dlSpan, ((slot + frac) / expectedStreams) * dlSpan);
      onEvent({ type: 'progress', percent, speed: parseNumber(speed), eta: parseNumber(eta) });
    } else if (line.startsWith('[download] Destination:')) {
      if (SIDE_FILE.test(line.trim())) return;
      streamIdx = Math.min(streamIdx + 1, expectedStreams);
      let stage;
      if (section) stage = 'section';
      else if (mode === 'audio') stage = 'audio';
      else stage = streamIdx === 1 ? 'video' : 'audio';
      onEvent({ type: 'stage', stage });
    } else if (line.startsWith('[Merger]')) {
      onEvent({ type: 'stage', stage: 'merge', percent: dlSpan + 1 });
    } else if (line.startsWith('[ExtractAudio]')) {
      onEvent({ type: 'stage', stage: 'extract', format: audio.format, percent: dlSpan + 1 });
    } else if (line.startsWith('[EmbedSubtitle]')) {
      onEvent({ type: 'stage', stage: 'subs', percent: dlSpan + 2 });
    } else if (line.startsWith('[EmbedThumbnail]')) {
      onEvent({ type: 'stage', stage: 'cover', percent: dlSpan + 2 });
    }
  };

  function runYtDlp() {
    return new Promise((resolve, reject) => {
      const child = spawn(bins.ytdlp, buildArgs(bins, job, base), { env: childEnv(), windowsHide: true });
      current = child;
      const out = lineSplitter(handleLine);
      const err = lineSplitter((line) => {
        stderr += `${line}\n`;
        handleLine(line);
      });
      child.stdout.on('data', (c) => out.push(String(c)));
      child.stderr.on('data', (c) => err.push(String(c)));
      child.on('error', reject);
      child.on('close', (code) => {
        out.flush();
        err.flush();
        if (cancelled) reject(new CancelledError());
        else if (code !== 0) reject(friendlyError(stderr, code));
        else if (!fs.existsSync(finalPath)) reject(new KgError('NO_FILE'));
        else resolve();
      });
    });
  }

  // Contexto de los pasos de ffmpeg: la barra avanza de dlSpan a 99 y cancelar los detiene.
  const ffmpegCtx = (stage, duration, extra = {}) => {
    onEvent({ type: 'stage', stage, ...extra, percent: dlSpan + 2 });
    return {
      ffmpeg: bins.ffmpeg,
      duration,
      onProgress: (p) => onEvent({ type: 'progress', percent: dlSpan + 2 + (p / 100) * (97 - dlSpan), speed: null, eta: null }),
      track: (child) => { current = child; if (cancelled) killTree(child); },
    };
  };

  const promise = (async () => {
    try {
      await runYtDlp();
      // Algunos sitios no informan la duración: se lee del archivo ya descargado.
      const duration = normalize || preset ? clipLength || (await post.probeDuration(bins.ffmpeg, finalPath)) : 0;
      if (normalize) await post.normalizeAudio(ffmpegCtx('normalize', duration), finalPath, audio.format, Number(audio.bitrate));
      if (preset) await post.applyPreset(ffmpegCtx('preset', duration, { preset }), finalPath, preset);
      if (cancelled) throw new CancelledError();
      return { filePath: finalPath, size: fs.statSync(finalPath).size };
    } catch (err) {
      cleanupPartials(finalPath);
      // Un paso de ffmpeg interrumpido deja el archivo a medias: se quita.
      if (cancelled || err instanceof CancelledError) {
        if (preset || normalize) fs.rmSync(finalPath, { force: true });
        throw new CancelledError();
      }
      throw err;
    }
  })();

  return {
    finalPath,
    promise,
    cancel: () => {
      cancelled = true;
      killTree(current);
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
  if (code !== 0) throw friendlyError(stderr || stdout, code);
  return stdout.trim().split(/\r?\n/).pop();
}

module.exports = {
  getInfo,
  startDownload,
  updateEngine,
  buildArgs,
  normalizeJob,
  videoSort,
  CancelledError,
  VIDEO_CONTAINERS,
  VIDEO_QUALITIES,
  VIDEO_PRESETS,
  AUDIO_FORMATS,
  AUDIO_BITRATES,
};
