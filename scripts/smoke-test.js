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

const vm = require('vm');
const { execFileSync, spawnSync } = require('child_process');

const { detectPlatform, isSupportedUrl, listingUrl, splitLinks, sanitizeFilename } = require('../src/core/validate');
const { resolveBinaries, readVersion, platformDirName, FFMPEG_NAME } = require('../src/core/binaries');
const settings = require('../src/core/settings');
const ytdlp = require('../src/core/ytdlp');
const post = require('../src/core/postprocess');
const { createHistory } = require('../src/core/history');
const { isNewer } = require('../src/core/updates');

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
  // Enlace → plataforma esperada.
  const valid = {
    'https://youtu.be/06LjLWnkO0M?si=gw1naXB7VqMivS7J': 'youtube',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'youtube',
    'https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ': 'youtube',
    'https://m.youtube.com/shorts/abcdefghijk': 'youtube',
    'youtube.com/watch?v=dQw4w9WgXcQ': 'youtube',
    'https://www.facebook.com/watch/?v=1234567890': 'facebook',
    'https://www.facebook.com/reel/1234567890123': 'facebook',
    'https://www.facebook.com/share/v/1AbCdEfGhI/': 'facebook',
    'https://fb.watch/abcDEF123/': 'facebook',
    'https://www.facebook.com/IglesiaKerygma/videos/1234567890/': 'facebook',
    'https://www.tiktok.com/@usuario.oficial/video/7300000000000000000': 'tiktok',
    'https://vm.tiktok.com/ZMabc123/': 'tiktok',
    'https://www.tiktok.com/t/ZTabc123/': 'tiktok',
    'https://www.instagram.com/reel/C1a2B3c4D5e/': 'instagram',
    'https://www.instagram.com/p/C1a2B3c4D5e/?igsh=abc': 'instagram',
    'https://vimeo.com/123456789': 'vimeo',
    'https://player.vimeo.com/video/123456789?h=abc': 'vimeo',
    'https://vimeo.com/channels/staffpicks/123456789': 'vimeo',
  };
  const invalid = [
    '', 'hola', null, 'https://example.com/video/123', 'https://youtube.com/watch?v=corto',
    'https://www.facebook.com/IglesiaKerygma', 'https://www.tiktok.com/@usuario', 'https://www.instagram.com/usuario/',
    'https://vimeo.com/usuario', 'https://notyoutube.com.evil.com/watch?v=dQw4w9WgXcQ',
  ];
  Object.entries(valid).forEach(([u, id]) => assert.strictEqual(detectPlatform(u)?.id, id, `debería ser de ${id}: ${u}`));
  invalid.forEach((u) => assert.ok(!isSupportedUrl(u), `debería ser inválida: ${u}`));

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

  // Configuración nueva: destinos, subtítulos, audio y opciones generales.
  assert.deepStrictEqual(
    settings.sanitize({ language: 'en', watchClipboard: false, autoUpdateEngine: 'no', video: { preset: 'whatsapp', subtitles: 'fr', subMode: 'file' }, audio: { normalize: true, cover: 1 } }),
    { language: 'en', watchClipboard: false, video: { preset: 'whatsapp', subMode: 'file' }, audio: { normalize: true } }
  );
  assert.strictEqual(base.language, 'system');
  assert.strictEqual(base.video.preset, 'manual');
  console.log('✔ configuración nueva OK');

  // Opciones inválidas deben rechazarse antes de lanzar yt-dlp.
  const bins = { ytdlp: 'x', ffmpeg: 'x' };
  const base2 = { url: 'u', title: 't', mode: 'audio', outputDir: os.tmpdir() };
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, audio: { format: 'exe' } }), /KG:BAD_OPTION\|format/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, audio: { bitrate: 1 } }), /KG:BAD_OPTION\|bitrate/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, video: { container: 'avi' } }), /KG:BAD_OPTION\|container/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, video: { quality: '9999' } }), /KG:BAD_OPTION\|quality/);
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, video: { preset: 'tv' } }), /KG:BAD_OPTION\|preset/);
  // Un video de 15 min no cabe en WhatsApp: se avisa antes de descargar nada.
  assert.throws(() => ytdlp.startDownload(bins, { ...base2, mode: 'video', duration: 900, video: { preset: 'whatsapp' } }), /KG:TOO_LONG\|\d+/);
  console.log('✔ opciones inválidas rechazadas');
}

/** Listas, varios enlaces, argumentos de yt-dlp, destinos, historial, versiones e idiomas. */
function features() {
  // Listas y canales de YouTube
  assert.strictEqual(detectPlatform('https://www.youtube.com/playlist?list=PLabc123').kind, 'playlist');
  assert.strictEqual(detectPlatform('https://www.youtube.com/@IglesiaKerygma').kind, 'playlist');
  assert.strictEqual(detectPlatform('https://www.youtube.com/@IglesiaKerygma/shorts').kind, 'playlist');
  const inList = detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123&index=2');
  assert.strictEqual(inList.kind, 'video');
  assert.strictEqual(inList.listUrl, 'https://www.youtube.com/playlist?list=PLabc123');
  assert.strictEqual(detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ').listUrl, undefined); // mix infinito
  assert.strictEqual(listingUrl('https://www.youtube.com/@IglesiaKerygma'), 'https://www.youtube.com/@IglesiaKerygma/videos');
  assert.strictEqual(listingUrl('youtube.com/@IglesiaKerygma/shorts'), 'https://youtube.com/@IglesiaKerygma/shorts');

  // Varios enlaces pegados juntos (saltos de línea, espacios o comas; sin repetidos)
  assert.deepStrictEqual(
    splitLinks('https://youtu.be/06LjLWnkO0M\n https://vimeo.com/123456789, hola https://youtu.be/06LjLWnkO0M'),
    ['https://youtu.be/06LjLWnkO0M', 'https://vimeo.com/123456789']
  );
  console.log('✔ listas y varios enlaces OK');

  // Argumentos de yt-dlp (sin red)
  const bins = { ytdlp: 'x', ffmpeg: 'ffmpeg' };
  const args = (job) => ytdlp.buildArgs(bins, ytdlp.normalizeJob({ url: 'u', mode: 'video', ...job }), '/tmp/x');
  const after = (list, flag) => list[list.indexOf(flag) + 1];
  let a = args({ video: { container: 'mp4', quality: '720' } });
  assert.strictEqual(after(a, '-S'), 'vcodec:h264,res:720,acodec:aac'); // lado corto ≤ 720 y H.264
  assert.ok(!a.includes('--write-subs'));
  a = args({ video: { container: 'mkv', quality: 'best' } });
  assert.strictEqual(after(a, '-S'), '');
  a = args({ video: { subtitles: 'es', subMode: 'embed' } });
  assert.strictEqual(after(a, '--sub-langs'), 'es.*,es');
  assert.ok(a.includes('--embed-subs') && a.includes('--write-auto-subs'));
  assert.ok(!args({ video: { subtitles: 'en', subMode: 'file' } }).includes('--embed-subs'));
  a = args({ video: { preset: 'whatsapp', container: 'mkv', quality: '480' } });
  assert.strictEqual(after(a, '--merge-output-format'), 'mp4'); // un destino siempre es MP4
  assert.strictEqual(after(a, '-S'), 'vcodec:h264,res:1080,acodec:aac');
  a = args({ mode: 'audio', audio: { format: 'mp3', cover: true } });
  assert.ok(a.includes('--embed-thumbnail'));
  assert.ok(!args({ mode: 'audio', audio: { format: 'wav', cover: true } }).includes('--embed-thumbnail')); // WAV no guarda portada
  console.log('✔ argumentos del motor OK');

  // Destinos: límites de tamaño
  assert.ok(post.maxSeconds('whatsapp') > 540 && post.maxSeconds('whatsapp') < 660, `WhatsApp: ${post.maxSeconds('whatsapp')} s`);
  assert.strictEqual(post.maxSeconds('instagram'), null);
  assert.throws(() => post.presetArgs('whatsapp', { duration: 900 }), /KG:TOO_LONG/);
  const wa = post.presetArgs('whatsapp', { duration: 120 });
  assert.ok(wa.includes('-maxrate') && wa.includes('-fpsmax'));
  const na = post.normalizeArgs('mp3', 192);
  assert.ok(na.join(' ').includes('loudnorm=I=-16') && na.includes('0:v?'), 'MP3 normalizado debe conservar la portada');
  console.log('✔ destinos y normalización OK');

  // Historial
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-hist-'));
  const file = path.join(dir, 'history.json');
  const real = path.join(dir, 'video.mp4');
  fs.writeFileSync(real, 'x');
  const hist = createHistory(file);
  hist.add({ title: 'Uno', url: 'https://youtu.be/a', kind: 'video', ext: 'MP4', filePath: real, size: 10, thumbnail: 'javascript:alert(1)' });
  hist.add({ title: 'Dos', url: 'https://youtu.be/b', kind: 'audio', ext: 'MP3', filePath: path.join(dir, 'borrado.mp3') });
  let list = createHistory(file).list(); // se relee desde el disco
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].title, 'Dos'); // más reciente primero
  assert.strictEqual(list[0].exists, false);
  assert.strictEqual(list[1].exists, true);
  assert.strictEqual(list[1].thumbnail, ''); // solo miniaturas http(s)
  hist.remove(list[0].id);
  assert.strictEqual(hist.list().length, 1);
  hist.clear();
  assert.strictEqual(hist.list().length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✔ historial OK');

  // Versiones
  assert.ok(isNewer('1.10.0', '1.9.3'));
  assert.ok(isNewer('v1.2.0', '1.1.0'));
  assert.ok(!isNewer('1.2.0', '1.2.0'));
  assert.ok(!isNewer('1.1.9', '1.2.0'));
  console.log('✔ comparación de versiones OK');

  // Idiomas: español e inglés con las mismas claves (y los mismos errores).
  const sandbox = { window: {}, document: { documentElement: {}, querySelectorAll: () => [] } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js'), 'utf8'), sandbox);
  const { STRINGS, ERRORS } = sandbox.window.i18n;
  const diff = (a2, b2) => Object.keys(a2).filter((k) => !(k in b2));
  assert.deepStrictEqual(diff(STRINGS.es, STRINGS.en), [], 'faltan textos en inglés');
  assert.deepStrictEqual(diff(STRINGS.en, STRINGS.es), [], 'faltan textos en español');
  assert.deepStrictEqual(diff(ERRORS.es, ERRORS.en), [], 'faltan errores en inglés');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const used = [...html.matchAll(/data-i18n(?:-html|-placeholder|-title|-aria)?="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(used.filter((k) => !(k in STRINGS.es)), [], 'index.html usa claves que no existen');
  sandbox.window.i18n.setLanguage('en');
  assert.strictEqual(sandbox.window.i18n.errorText("Error invoking remote method 'x': Error: KG:LOGIN"), ERRORS.en.LOGIN);
  console.log('✔ textos en español e inglés OK');
}

/** Pasos de ffmpeg con archivos generados localmente (necesita ffmpeg en ./bin). */
async function postprocessChecks() {
  const ffmpeg = path.join(__dirname, '..', 'bin', platformDirName(), FFMPEG_NAME);
  if (!fs.existsSync(ffmpeg)) return console.log('· ffmpeg no está en ./bin: se omiten las pruebas de normalizar y destinos');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyd-post-'));
  const gen = (name, args) => { execFileSync(ffmpeg, ['-v', 'quiet', '-y', ...args, path.join(dir, name)], { stdio: 'pipe' }); return path.join(dir, name); };
  const ctx = (duration) => ({ ffmpeg, duration });

  // Audio bajito (−30 dB) con portada → −16 LUFS y la portada sigue ahí.
  const cover = gen('cover.jpg', ['-f', 'lavfi', '-i', 'color=c=orange:s=300x300', '-frames:v', '1']);
  const mp3 = gen('voz.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=300:duration=20,volume=-30dB', '-i', cover,
    '-map', '0:a', '-map', '1:v', '-c:a', 'libmp3lame', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic']);
  await post.normalizeAudio(ctx(20), mp3, 'mp3', 192);
  const probe = (f) => spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr;
  assert.ok(/Video: mjpeg/.test(probe(mp3)), 'la portada se perdió al normalizar');
  const r = measureLufs(ffmpeg, mp3);
  assert.ok(Math.abs(r + 16) < 1.5, `volumen ${r} LUFS (se esperaba −16)`);
  console.log(`✔ normalizar: ${r} LUFS con portada`);

  // Video con mucho movimiento → WhatsApp: menos de 16 MB y MP4 H.264.
  const video = gen('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=60,noise=alls=35:allf=t',
    '-f', 'lavfi', '-i', 'sine=duration=60', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-c:a', 'aac']);
  await post.applyPreset(ctx(60), video, 'whatsapp');
  const size = fs.statSync(video).size;
  assert.ok(size <= 16 * 1024 * 1024, `WhatsApp: ${(size / 1048576).toFixed(1)} MB`);
  assert.ok(/Video: h264/.test(probe(video)));
  console.log(`✔ destino WhatsApp: ${(size / 1048576).toFixed(1)} MB`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Volumen integrado (LUFS) medido con el filtro ebur128 de ffmpeg. */
function measureLufs(ffmpeg, file) {
  const out = spawnSync(ffmpeg, ['-hide_banner', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(/Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(out.stderr)?.[1]);
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
  features();
  await postprocessChecks();
  const args = process.argv.slice(2);
  if (args.includes('--online')) await online(args.find((a) => a.startsWith('http')) || DEFAULT_URL);
  console.log('\nTodo OK');
})().catch((err) => {
  console.error('\n✖', err.stack || err.message);
  process.exit(1);
});
