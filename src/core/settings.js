/**
 * Esquema de la configuración: valores por defecto, validación de lo que llega desde la
 * interfaz y regla de "recordar opciones". Sin dependencias de Electron (se puede probar con Node).
 */

const CHOICES = {
  tab: ['video', 'audio'],
  theme: ['system', 'light', 'dark'],
  onExists: ['copy', 'replace'],
  videoContainer: ['mp4', 'mkv'],
  videoQuality: ['best', '1080', '720', '480'],
  audioFormat: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'opus', 'ogg'],
  audioBitrate: [128, 192, 256, 320],
};

function defaults(downloadsDir) {
  return {
    // Generales
    theme: 'dark',
    onExists: 'copy', // copy = guardar como "nombre (2)"; replace = sobrescribir
    remember: true, // recordar pestaña, formato, calidad y carpeta
    notify: true, // notificación del sistema al terminar
    openFolder: false, // mostrar el archivo en Finder/Explorador al terminar
    // Recordables
    tab: 'video',
    outputDir: downloadsDir,
    video: { container: 'mp4', quality: 'best' },
    audio: { format: 'mp3', bitrate: 192 },
  };
}

const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);

/** Deja solo los campos válidos de un parche (lo demás se descarta). */
function sanitize(patch = {}) {
  const out = {};
  const set = (obj, key, value) => value !== undefined && (obj[key] = value);

  set(out, 'theme', pick(patch.theme, CHOICES.theme));
  set(out, 'onExists', pick(patch.onExists, CHOICES.onExists));
  set(out, 'remember', bool(patch.remember));
  set(out, 'notify', bool(patch.notify));
  set(out, 'openFolder', bool(patch.openFolder));
  set(out, 'tab', pick(patch.tab, CHOICES.tab));
  if (typeof patch.outputDir === 'string' && patch.outputDir) out.outputDir = patch.outputDir;

  if (patch.video && typeof patch.video === 'object') {
    out.video = {};
    set(out.video, 'container', pick(patch.video.container, CHOICES.videoContainer));
    set(out.video, 'quality', pick(String(patch.video.quality), CHOICES.videoQuality));
  }
  if (patch.audio && typeof patch.audio === 'object') {
    out.audio = {};
    set(out.audio, 'format', pick(patch.audio.format, CHOICES.audioFormat));
    set(out.audio, 'bitrate', pick(Number(patch.audio.bitrate), CHOICES.audioBitrate));
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
