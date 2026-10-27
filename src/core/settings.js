/**
 * Esquema de la configuración: valores por defecto, validación de lo que llega desde la
 * interfaz y regla de "recordar opciones". Sin dependencias de Electron (se puede probar con Node).
 */

const CHOICES = {
  tab: ['video', 'audio'],
  theme: ['system', 'light', 'dark'],
  language: ['system', 'es', 'en'],
  onExists: ['copy', 'replace'],
  videoContainer: ['mp4', 'mkv'],
  videoQuality: ['best', '1080', '720', '480'],
  videoPreset: ['manual', 'whatsapp', 'email', 'instagram'],
  videoSubtitles: ['none', 'es', 'en'],
  videoSubMode: ['embed', 'file'],
  audioFormat: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg'],
  audioBitrate: [128, 192, 256, 320],
};

function defaults(downloadsDir) {
  return {
    // Generales
    theme: 'dark',
    language: 'system', // español si el sistema está en español; si no, inglés
    onExists: 'copy', // copy = guardar como "nombre (2)"; replace = sobrescribir
    remember: true, // recordar pestaña, formato, calidad y carpeta
    notify: true, // notificación del sistema al terminar
    openFolder: false, // mostrar el archivo en Finder/Explorador al terminar
    autoUpdateEngine: true, // actualizar yt-dlp solo, una vez al día
    checkAppUpdates: true, // buscar versiones nuevas de la app al abrir
    watchClipboard: true, // ofrecer el enlace copiado al volver a la app
    // Recordables
    tab: 'video',
    outputDir: downloadsDir,
    video: { container: 'mp4', quality: 'best', preset: 'manual', subtitles: 'none', subMode: 'embed' },
    audio: { format: 'mp3', bitrate: 192, normalize: false, cover: true },
  };
}

const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);

/** Deja solo los campos válidos de un parche (lo demás se descarta). */
function sanitize(patch = {}) {
  const out = {};
  const set = (obj, key, value) => value !== undefined && (obj[key] = value);

  set(out, 'theme', pick(patch.theme, CHOICES.theme));
  set(out, 'language', pick(patch.language, CHOICES.language));
  set(out, 'onExists', pick(patch.onExists, CHOICES.onExists));
  for (const key of ['remember', 'notify', 'openFolder', 'autoUpdateEngine', 'checkAppUpdates', 'watchClipboard']) {
    set(out, key, bool(patch[key]));
  }
  set(out, 'tab', pick(patch.tab, CHOICES.tab));
  if (typeof patch.outputDir === 'string' && patch.outputDir) out.outputDir = patch.outputDir;

  if (patch.video && typeof patch.video === 'object') {
    out.video = {};
    set(out.video, 'container', pick(patch.video.container, CHOICES.videoContainer));
    set(out.video, 'quality', pick(String(patch.video.quality), CHOICES.videoQuality));
    set(out.video, 'preset', pick(patch.video.preset, CHOICES.videoPreset));
    set(out.video, 'subtitles', pick(patch.video.subtitles, CHOICES.videoSubtitles));
    set(out.video, 'subMode', pick(patch.video.subMode, CHOICES.videoSubMode));
  }
  if (patch.audio && typeof patch.audio === 'object') {
    out.audio = {};
    set(out.audio, 'format', pick(patch.audio.format, CHOICES.audioFormat));
    set(out.audio, 'bitrate', pick(Number(patch.audio.bitrate), CHOICES.audioBitrate));
    set(out.audio, 'normalize', bool(patch.audio.normalize));
    set(out.audio, 'cover', bool(patch.audio.cover));
  }
  return out;
}

function merge(current, patch) {
  return {
    ...current,
    ...patch,
    video: { ...current.video, ...patch.video },
    audio: { ...current.audio, ...patch.audio },
  };
}

/** Con "recordar" desactivado, la app abre siempre con los valores de fábrica. */
function effective(stored, base) {
  const merged = merge(base, sanitize(stored));
  if (merged.remember) return merged;
  return { ...merged, tab: base.tab, outputDir: base.outputDir, video: base.video, audio: base.audio };
}

module.exports = { CHOICES, defaults, sanitize, merge, effective };
