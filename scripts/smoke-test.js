#!/usr/bin/env node
/**
 * Pruebas rápidas del núcleo (sin abrir la interfaz).
 *
 *   npm test                       → pruebas offline (validaciones)
 *   node scripts/smoke-test.js --online [url]
 *                                  → además consulta y descarga de verdad (video y audio)
 *
 * Para reproducir exactamente el entorno de la app (Electron actuando como Node):
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-test.js --online
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { isValidYoutubeUrl, sanitizeFilename } = require('../src/core/validate');
const { resolveBinaries } = require('../src/core/binaries');
const ytdlp = require('../src/core/ytdlp');

const DEFAULT_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'; // video público de 19 s

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
}

async function online(url) {
  const bins = await resolveBinaries({
    isPackaged: false,
    resourcesPath: '',
    projectRoot: path.join(__dirname, '..'),
    engineDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-engine-')),
    appVersion: 'test',
  });
  console.log(`✔ motor yt-dlp ${bins.version} (${bins.ytdlp})`);

  const info = await ytdlp.getInfo(bins, url);
  assert.ok(info.title, 'sin título');
  console.log(`✔ info: "${info.title}" · ${info.duration}s`);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-out-'));
  for (const job of [
    { mode: 'audio', audioFormat: 'mp3' },
    { mode: 'video', audioFormat: 'mp3' },
  ]) {
    let lastPercent = 0;
    const run = ytdlp.startDownload(bins, { url, title: info.title, outputDir, ...job }, (e) => {
      if (e.type === 'progress') lastPercent = e.percent;
    });
    const { filePath } = await run.promise;
    const size = fs.statSync(filePath).size;
    assert.ok(size > 10_000, `archivo muy pequeño: ${filePath}`);
    console.log(`✔ ${job.mode}: ${path.basename(filePath)} (${(size / 1024).toFixed(0)} KB, progreso máx. ${lastPercent.toFixed(0)}%)`);
  }

  // Recorte: del segundo 3 al 10 → el archivo debe durar ~7 s (audio y video).
  for (const mode of ['audio', 'video']) {
    const events = [];
    const run = ytdlp.startDownload(
      bins,
      { url, title: info.title, outputDir, mode, audioFormat: 'mp3', section: { start: 3, end: 10 } },
      (e) => e.type === 'progress' && events.push(e.percent)
    );
    const { filePath } = await run.promise;
    assert.ok(/\(0m03s a 0m10s\)/.test(filePath), `sin sufijo de recorte: ${filePath}`);
    const secs = await probeDuration(bins.ffmpeg, filePath);
    assert.ok(Math.abs(secs - 7) < 0.6, `duración inesperada (${secs}s) en ${filePath}`);
    console.log(`✔ recorte ${mode}: ${path.basename(filePath)} → ${secs.toFixed(2)} s (${events.length} avisos de progreso)`);
  }

  // Cancelación: debe terminar rechazando con CancelledError y sin dejar restos.
  const cancelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-cancel-'));
  const run = ytdlp.startDownload(bins, { url, title: info.title, outputDir: cancelDir, mode: 'video', audioFormat: 'mp3' });
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
