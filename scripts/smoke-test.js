#!/usr/bin/env node
/**
 * Pruebas rápidas del núcleo (sin abrir la interfaz).
 *
 *   npm test                       → pruebas offline (validaciones y configuración)
 *   node scripts/smoke-test.js --online [url]
 *                                  → además consulta y descarga de verdad (formatos, recortes, cancelación)
 *
 * Para reproducir exactamente el entorno de la app (Electron actuando como Node):
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-test.js --online
 *
 * Nota: cada arranque de yt-dlp puede tardar varios segundos (se descomprime solo),
 * así que la parte online toma unos minutos.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { isValidYoutubeUrl, sanitizeFilename } = require('../src/core/validate');
const { resolveBinaries, readVersion } = require('../src/core/binaries');
const settings = require('../src/core/settings');
const ytdlp = require('../src/core/ytdlp');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // video público de 19 s

/** Duración en segundos de un archivo multimedia, leída con ffmpeg. */
function probeDuration(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-i', file], (_err, _out, stderr) => {
      const m = String(stderr).match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      m ? resolve(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) : reject(new Error('sin duración'));
    });
  });
}

function offline() {
  const valid = [
    'https://youtu.be/06LjLWnkO0M?si=gw1naXB7VqMivS7J',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ',
    'https://m.youtube.com/shorts/abcdefghijk',
    'youtube.com/watch?v=dQw4w9WgXcQ',
  ];
  const invalid = ['', 'hola', 'https://vimeo.com/123456789', 'https://youtube.com/watch?v=corto', null];
  valid.forEach((u) => assert.ok(isValidYoutubeUrl(u), `debería ser válida: ${u}`));
  invalid.forEach((u) => assert.ok(!isValidYoutubeUrl(u), `debería ser inválida: ${u}`));

  assert.strictEqual(sanitizeFilename('A/B:C*D?"E<F>G|H'), 'ABCDEFGH');
  assert.strictEqual(sanitizeFilename('  hola.  '), 'hola');
  assert.strictEqual(sanitizeFilename('CON'), 'video CON');
  assert.strictEqual(sanitizeFilename(''), 'video');
  assert.ok(sanitizeFilename('x'.repeat(500)).length <= 120);
  console.log('✔ validaciones OK');

  // Configuración: solo pasa lo válido; "recordar" apagado vuelve a los valores de fábrica.
  const base = settings.defaults('/descargas');
  assert.deepStrictEqual(
    settings.sanitize({ theme: 'neón', notify: 'sí', tab: 'audio', video: { container: 'avi', quality: '720' }, audio: { format: 'flac', bitrate: 999 }, evil: 1 }),
    { tab: 'audio', video: { quality: '720' }, audio: { format: 'flac' } }
  );
  const stored = { tab: 'audio', outputDir: '/otra', audio: { format: 'wav', bitrate: 320 }, remember: true };
  const kept = settings.effective(stored, base);
  assert.strictEqual(kept.tab, 'audio');
  assert.strictEqual(kept.outputDir, '/otra');
  assert.strictEqual(kept.audio.format, 'wav');
  assert.strictEqual(kept.video.container, 'mp4'); // lo no guardado conserva el valor de fábrica
  const forgotten = settings.effective({ ...stored, remember: false, theme: 'light' }, base);
  assert.strictEqual(forgotten.tab, 'video');
  assert.strictEqual(forgotten.outputDir, '/descargas');
  assert.strictEqual(forgotten.audio.format, 'mp3');
  assert.strictEqual(forgotten.theme, 'light'); // los ajustes generales sí se conservan
  console.log('✔ configuración OK');

  // Opciones inválidas deben rechazarse antes de lanzar yt-dlp.
  const bins = { ytdlp: 'x', ffmpeg: 'x' };
  const base2 = { url: 'u', title: 't', mode: 'audio', outputDir: os.tmpdir() };
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, audio: { format: 'exe' } }), /Formato de audio/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, audio: { bitrate: 1 } }), /Calidad de audio/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, video: { container: 'avi' } }), /Formato de video/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, video: { quality: '9999' } }), /Calidad de video/);
  console.log('✔ opciones inválidas rechazadas');
}

async function online(url) {
  const bins = await resolveBinaries({
    isPackaged: false,
    resourcesPath: '',
    projectRoot: path.join(__dirname, '..'),
    engineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-engine-')),
    appVersion: 'test',
  });
  const version = await readVersion(bins.ytdlp);
  assert.ok(version, 'no se pudo leer la versión de yt-dlp');
  console.log(`✔ motor yt-dlp ${version}`);

  const info = await ytdlp.getInfo(bins, url);
  assert.ok(info.title, 'sin título');
  console.log(`✔ info: "${info.title}" · ${info.duration}s`);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-out-'));
  const download = async (job) => {
    let lastPercent = 0;
    const run = ytdlp.startDownload(bins, { url, title: info.title, outputDir, ...job }, (e) => {
      if (e.type === 'progress') lastPercent = e.percent;
    });
    const result = await run.promise;
    assert.ok(result.size > 10_000, `archivo muy pequeño: ${result.filePath}`);
    return { ...result, lastPercent };
  };

  // Formatos completos
  const cases = [
    { label: 'audio mp3 192k', job: { mode: 'audio', audio: { format: 'mp3', bitrate: 192 } }, ext: '.mp3' },
    { label: 'audio ogg', job: { mode: 'audio', audio: { format: 'ogg', bitrate: 128 } }, ext: '.ogg' },
    { label: 'audio wav', job: { mode: 'audio', audio: { format: 'wav', bitrate: 128 } }, ext: '.wav' },
    { label: 'video mp4', job: { mode: 'video', video: { container: 'mp4', quality: 'best' } }, ext: '.mp4' },
    { label: 'video mkv 360p', job: { mode: 'video', video: { container: 'mkv', quality: '480' } }, ext: '.mkv' },
  ];
  for (const c of cases) {
    const r = await download(c.job);
    assert.strictEqual(path.extname(r.filePath), c.ext, `extensión inesperada en ${r.filePath}`);
    console.log(`✔ ${c.label}: ${path.basename(r.filePath)} (${(r.size / 1024).toFixed(0)} KB)`);
  }

  // Copia vs. reemplazar: repetir un archivo existente
  const again = await download({ mode: 'audio', audio: { format: 'mp3', bitrate: 192 } });
  assert.ok(/ \(2\)\.mp3$/.test(again.filePath), `debía crear copia "(2)": ${again.filePath}`);
  const replaced = await download({ mode: 'audio', audio: { format: 'mp3', bitrate: 192 }, overwrite: true });
  assert.ok(!/ \(\d+\)\.mp3$/.test(replaced.filePath), `con overwrite debía reutilizar el nombre: ${replaced.filePath}`);
  console.log('✔ crear copia / reemplazar');

  // Recorte: del segundo 3 al 10 → ~7 s en audio y en video (el audio salía de 10 s sin cortes exactos)
  for (const mode of ['audio', 'video']) {
    const events = [];
    const run = ytdlp.startDownload(
      bins,
      { url, title: info.title, outputDir, mode, section: { start: 3, end: 10 } },
      (e) => e.type === 'progress' && events.push(e.percent)
    );
    const { filePath } = await run.promise;
    assert.ok(/\(0m03s a 0m10s\)/.test(filePath), `sin sufijo de recorte: ${filePath}`);
    const secs = await probeDuration(bins.ffmpeg, filePath);
    assert.ok(Math.abs(secs - 7) < 0.6, `duración inesperada (${secs}s) en ${filePath}`);
    console.log(`✔ recorte ${mode}: ${secs.toFixed(2)} s (${events.length} avisos de progreso)`);
  }

  // Cancelación: debe terminar rechazando con CancelledError y sin dejar restos.
  const cancelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-cancel-'));
  const run = ytdlp.startDownload(bins, { url, title: info.title, outputDir: cancelDir, mode: 'video' });
  setTimeout(() => run.cancel(), 1500);
  await assert.rejects(run.promise, (err) => err instanceof ytdlp.CancelledError);
  assert.deepStrictEqual(fs.readdirSync(cancelDir), [], 'quedaron archivos tras cancelar');
  console.log('✔ cancelación limpia');

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.rmSync(cancelDir, { recursive: true, force: true });
}

(async () => {
  offline();
  const args = process.argv.slice(2);
  if (args.includes('--online')) await online(args.find((a) => a.startsWith('http')) || DEFAULT_URL);
  console.log('\nTodo OK');
})().catch((err) => {
  console.error('\n✖', err.stack || err.message);
  process.exit(1);
});
