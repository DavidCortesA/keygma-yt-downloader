const YOUTUBE_URL_PATTERN =
  /^(https?:\/\/)?(www\.|m\.|music\.)?(youtube\.com\/(watch\?(.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{11}/i;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Valida que el texto sea un enlace de YouTube reconocible
 * (youtube.com/watch, youtu.be, shorts, embed, live; admite parámetros como ?si=...).
 * La validación real (existe, no es privado...) la hace yt-dlp.
 */
function isValidYoutubeUrl(url) {
  return typeof url === 'string' && YOUTUBE_URL_PATTERN.test(url.trim());
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

module.exports = { isValidYoutubeUrl, sanitizeFilename };
