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

// Listas y canales de YouTube: se descargan video por video.
const YT_PLAYLIST = /^(https?:\/\/)?(www\.|m\.|music\.)?youtube\.com\/playlist\?(.*&)?list=[\w-]+/i;
const YT_CHANNEL = /^(https?:\/\/)?(www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w.-]+|user\/[\w.-]+)(\/(videos|shorts|streams|featured))?\/?(\?.*)?$/i;
const LIST_PARAM = /[?&]list=([\w-]+)/;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Plataforma del enlace o null si no es de un sitio admitido:
 * { id, name, kind: 'video'|'playlist', listUrl? }. listUrl aparece cuando un video de
 * YouTube forma parte de una lista (watch?v=...&list=...), para ofrecer la lista completa.
 */
function detectPlatform(url) {
  if (typeof url !== 'string') return null;
  const text = url.trim();
  if (YT_PLAYLIST.test(text) || YT_CHANNEL.test(text)) return { id: 'youtube', name: 'YouTube', kind: 'playlist' };
  const found = PLATFORMS.find((p) => p.pattern.test(text));
  if (!found) return null;
  const result = { id: found.id, name: found.name, kind: 'video' };
  const list = found.id === 'youtube' && LIST_PARAM.exec(text);
  // Las listas "RD..." son mixes automáticos e infinitos de YouTube: no se ofrecen.
  if (list && !list[1].startsWith('RD')) result.listUrl = `https://www.youtube.com/playlist?list=${list[1]}`;
  return result;
}

const isSupportedUrl = (url) => detectPlatform(url) !== null;

/**
 * Enlace que se le pasa a yt-dlp para listar. Un canal sin pestaña se lista desde
 * "/videos": si no, yt-dlp devuelve las pestañas (Videos, Shorts, En vivo) y no los videos.
 */
function listingUrl(url) {
  const text = url.trim();
  const m = YT_CHANNEL.exec(text);
  if (m && !m[4]) return `https://www.youtube.com/${m[3]}/videos`;
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

/** Separa un texto pegado en enlaces (uno por línea o separados por espacios), sin repetidos. */
function splitLinks(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  return text.split(/[\s,]+/).map((t) => t.trim()).filter((t) => {
    if (!t || seen.has(t) || !isSupportedUrl(t)) return false;
    seen.add(t);
    return true;
  });
}

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

module.exports = { PLATFORMS, detectPlatform, isSupportedUrl, listingUrl, splitLinks, sanitizeFilename };
