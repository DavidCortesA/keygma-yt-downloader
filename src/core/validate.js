/**
 * Sitios admitidos y la forma de sus enlaces de video. Solo filtran lo evidente
 * (un perfil, la portada, otro dominio); la validación real (existe, es público...)
 * la hace yt-dlp. Admiten parámetros como ?si=... o ?igsh=...
 */
const PLATFORMS = [
  {
    id: 'youtube',
    name: 'YouTube',
    // watch?v=, shorts/, embed/, live/ y youtu.be con el id de 11 caracteres.
    pattern: /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{11}/i,
  },
  {
    id: 'facebook',
    name: 'Facebook',
    // watch?v=, reel/, videos/, share/v/ o share/r/, story.php y los cortos fb.watch.
    pattern: /^(https?:\/\/)?((www|m|web|mbasic)\.)?(facebook\.com\/(watch\/?\?(.*&)?v=\d|reel\/\d|share\/[vr]\/\w|story\.php\?|[\w.-]+\/videos\/|groups\/[\w.-]+\/(permalink|posts)\/)|fb\.watch\/\w)/i,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    // @usuario/video/123, los cortos vm./vt.tiktok.com y tiktok.com/t/.
    pattern: /^(https?:\/\/)?((www|m)\.)?(tiktok\.com\/(@[\w.-]+\/(video|photo)\/\d|t\/\w|v\/\d)|(vm|vt)\.tiktok\.com\/\w)/i,
  },
  {
    id: 'instagram',
    name: 'Instagram',
    // Publicaciones, reels e IGTV (no perfiles).
    pattern: /^(https?:\/\/)?(www\.)?instagram\.com\/([\w.]+\/)?(p|reels?|tv)\/[\w-]+/i,
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    // vimeo.com/123, canales, grupos, showcase y el reproductor embebido.
    pattern: /^(https?:\/\/)?(www\.|player\.)?vimeo\.com\/(\S+\/)?(video\/)?\d{6,}/i,
  },
];

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Plataforma del enlace ({ id, name }) o null si no es de un sitio admitido. */
function detectPlatform(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  const found = PLATFORMS.find((p) => p.pattern.test(text));
  return found ? { id: found.id, name: found.name } : null;
}

const isSupportedUrl = (url) => detectPlatform(url) !== null;

/**
 * Convierte un título en un nombre de archivo válido en Windows y macOS.
 */
function sanitizeFilename(name) {
  let safe = String(name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '') // Windows no admite puntos/espacios al final
    .slice(0, 120)
    .trim();

  if (!safe || WINDOWS_RESERVED.test(safe)) safe = `video ${safe}`.trim();
  return safe;
}

module.exports = { PLATFORMS, detectPlatform, isSupportedUrl, sanitizeFilename };
