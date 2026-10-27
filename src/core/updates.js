/**
 * Versiones nuevas de la app, consultadas en las Releases de GitHub.
 * En Windows (instalada) main.js además la descarga e instala con electron-updater;
 * en macOS y en la versión portable se avisa y se abre la página de la Release.
 */

const REPO = 'DavidCortesA/keygma-yt-downloader';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

/** "1.10.0" > "1.9.3". Ignora una "v" inicial y sufijos como "-beta". */
function isNewer(latest, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number(n) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

/** { version, url } si hay una versión más nueva que `current`; null si no (o si no hay red). */
async function checkLatest(current) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Kerygma-Downloader' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const release = await res.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    return version && isNewer(version, current) ? { version, url: release.html_url || RELEASES_URL } : null;
  } catch {
    return null;
  }
}

module.exports = { isNewer, checkLatest, RELEASES_URL };
