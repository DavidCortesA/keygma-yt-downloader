#!/usr/bin/env node
/**
 * Descarga los binarios que se empaquetan dentro de la app para cada plataforma:
 *
 *   - yt-dlp  → releases oficiales de https://github.com/yt-dlp/yt-dlp
 *               (se verifica el SHA-256 contra el archivo SHA2-256SUMS de la misma release)
 *   - ffmpeg  → los mismos builds que usa el paquete npm `ffmpeg-static`
 *               (https://github.com/eugeneware/ffmpeg-static)
 *
 * Uso:   node scripts/fetch-binaries.js [mac-x64] [mac-arm64] [win-x64] [--force]
 * Sin argumentos descarga solo la plataforma actual.
 * Resultado: bin/<plataforma>/{yt-dlp,ffmpeg}  (carpeta ignorada por git)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const FFMPEG_TAG = process.env.FFMPEG_BINARY_RELEASE || 'b6.1.1';
const YTDLP_BASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}`;

const TARGETS = {
  'mac-x64': { ytdlpAsset: 'yt-dlp_macos', ytdlpOut: 'yt-dlp', ffmpegAsset: 'ffmpeg-darwin-x64', ffmpegOut: 'ffmpeg' },
  'mac-arm64': { ytdlpAsset: 'yt-dlp_macos', ytdlpOut: 'yt-dlp', ffmpegAsset: 'ffmpeg-darwin-arm64', ffmpegOut: 'ffmpeg' },
  'win-x64': { ytdlpAsset: 'yt-dlp.exe', ytdlpOut: 'yt-dlp.exe', ffmpegAsset: 'ffmpeg-win32-x64', ffmpegOut: 'ffmpeg.exe' },
};

function currentTarget() {
  const os = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
  return `${os}-${process.arch}`;
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

const mb = (buf) => `${(buf.length / 1024 / 1024).toFixed(1)} MB`;
let checksums = null;
const ytdlpCache = new Map();

async function getYtDlp(asset) {
  if (ytdlpCache.has(asset)) return ytdlpCache.get(asset);

  if (!checksums) {
    const text = (await download(`${YTDLP_BASE}/SHA2-256SUMS`)).toString('utf8');
    checksums = new Map(
      text.split('\n').filter(Boolean).map((l) => {
        const [hash, name] = l.trim().split(/\s+/);
        return [name, hash];
      })
    );
  }

  const buf = await download(`${YTDLP_BASE}/${asset}`);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== checksums.get(asset)) {
    throw new Error(`SHA-256 de ${asset} no coincide con el publicado. Se aborta por seguridad.`);
  }
  console.log(`  ✔ ${asset} (${mb(buf)}) — SHA-256 verificado`);
  ytdlpCache.set(asset, buf);
  return buf;
}

async function fetchTarget(name, force) {
  const t = TARGETS[name];
  if (!t) throw new Error(`Plataforma desconocida: ${name}. Opciones: ${Object.keys(TARGETS).join(', ')}`);

  const dir = path.join(ROOT, 'bin', name);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n▶ ${name}`);

  const ytdlpPath = path.join(dir, t.ytdlpOut);
  if (force || !fs.existsSync(ytdlpPath)) {
    fs.writeFileSync(ytdlpPath, await getYtDlp(t.ytdlpAsset), { mode: 0o755 });
  } else {
    console.log(`  · ${t.ytdlpOut} ya existe (usa --force para reemplazar)`);
  }

  const ffmpegPath = path.join(dir, t.ffmpegOut);
  if (force || !fs.existsSync(ffmpegPath)) {
    const gz = await download(`${FFMPEG_BASE}/${t.ffmpegAsset}.gz`);
    const bin = zlib.gunzipSync(gz);
    fs.writeFileSync(ffmpegPath, bin, { mode: 0o755 });
    console.log(`  ✔ ${t.ffmpegAsset} (${mb(bin)})`);
  } else {
    console.log(`  · ${t.ffmpegOut} ya existe (usa --force para reemplazar)`);
  }
}

(async () => {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const names = args.filter((a) => !a.startsWith('--'));
  const targets = names.length ? names : [currentTarget()];

  for (const name of targets) await fetchTarget(name, force);
  console.log('\nListo.');
})().catch((err) => {
  console.error(`\n✖ ${err.message}`);
  process.exit(1);
});
