/**
 * Pasos con ffmpeg después de que yt-dlp termina:
 *   - normalizeAudio: volumen estándar de podcasts y streaming (−16 LUFS).
 *   - applyPreset:    ajusta el video para WhatsApp, correo o Instagram (misma lógica que
 *                     Kerygma Converter: tamaño máximo con calidad constante y techo de bitrate).
 *
 * Se hacen aparte (y no con los argumentos de yt-dlp) porque yt-dlp copia el audio sin
 * recodificar cuando el códec ya coincide, y un filtro no se puede aplicar sobre una copia.
 * Cada paso escribe en un temporal y lo renombra al terminar: si falla, el archivo queda intacto.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { KgError } = require('./errors');

/* ------------------------------------------------------------------ */
/* Destinos                                                            */
/* ------------------------------------------------------------------ */
// limitMB: tamaño máximo; el bitrate se calcula con la duración y la resolución baja por la
// escalera [kbps mínimos de video, lado corto] hasta que la calidad sea razonable.
const VIDEO_PRESETS = {
  whatsapp: { limitMB: 16, audioK: 96, maxK: 2000, ladder: [[1200, 720], [500, 480], [0, 360]] },
  email: { limitMB: 20, audioK: 128, maxK: 4000, ladder: [[2500, 1080], [1200, 720], [500, 480], [0, 360]] },
  instagram: { crf: 20, audioK: 128, rate: 44100, shortSide: 1080, maxrateK: 8000 },
};
const MIN_VIDEO_K = 100; // por debajo el video no se ve: mejor pedir que se recorte
const SIZE_MARGIN = 0.92; // x264 puede pasarse unos puntos del objetivo
const EVEN_SIZE = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';

// Limita el lado corto (sirve igual para videos horizontales y verticales de celular).
const shortSideScale = (px) => `scale='if(gte(iw,ih),-2,min(${px},trunc(iw/2)*2))':'if(gte(iw,ih),min(${px},trunc(ih/2)*2),-2)'`;

const limitBytes = (preset) => (VIDEO_PRESETS[preset]?.limitMB || 0) * 1024 * 1024 || null;

/** Segundos que caben en el límite del destino con la calidad mínima (null si no hay límite). */
function maxSeconds(preset, hasAudio = true) {
  const p = VIDEO_PRESETS[preset];
  if (!p?.limitMB) return null;
  const audioK = hasAudio ? p.audioK : 0;
  return Math.floor((p.limitMB * 1024 * 1024 * 8 * SIZE_MARGIN) / ((MIN_VIDEO_K + audioK + 8) * 1000));
}

/** Argumentos de ffmpeg del destino; attempt > 0 reintenta con un 15 % menos de bitrate. */
function presetArgs(preset, { duration, hasAudio = true }, attempt = 0) {
  const p = VIDEO_PRESETS[preset];
  const args = ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  const audioK = hasAudio ? p.audioK : 0;
  let filter = EVEN_SIZE;

  if (p.limitMB) {
    const seconds = Math.max(duration || 1, 1);
    const budgetBits = p.limitMB * 1024 * 1024 * 8 * SIZE_MARGIN * 0.85 ** attempt;
    const videoK = Math.floor(budgetBits / seconds / 1000 - audioK - 8);
    if (videoK < MIN_VIDEO_K) throw new KgError('TOO_LONG', maxSeconds(preset, hasAudio));
    filter = shortSideScale(p.ladder.find(([k]) => videoK >= k)[1]);
    // Calidad constante con techo: un video simple sale liviano y uno complejo no pasa del límite.
    const capK = Math.min(videoK, p.maxK);
    args.push('-crf', '23', '-maxrate', `${capK}k`, '-bufsize', `${capK * 2}k`, '-fpsmax', '30');
  } else {
    args.push('-crf', String(p.crf));
    if (p.shortSide) filter = shortSideScale(p.shortSide);
    if (p.maxrateK) args.push('-maxrate', `${p.maxrateK}k`, '-bufsize', `${p.maxrateK * 2}k`, '-fpsmax', '30');
  }

  args.push('-vf', filter);
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', `${p.audioK}k`);
    if (p.rate) args.push('-ar', String(p.rate));
  }
  // Subtítulos incrustados (si los hay) se conservan en el formato de texto de MP4.
  args.push('-map', '0:s?', '-c:s', 'mov_text');
  args.push('-map_metadata', '0', '-movflags', '+faststart');
  return args;
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */
// Códec al recodificar; cover = el formato guarda la portada como pista de imagen.
const AUDIO_CODECS = {
  mp3: { args: (k) => ['-c:a', 'libmp3lame', '-b:a', `${k}k`, '-id3v2_version', '3'], cover: true },
  m4a: { args: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-movflags', '+faststart'], cover: true },
  aac: { args: (k) => ['-c:a', 'aac', '-b:a', `${k}k`, '-f', 'adts'] },
  wav: { args: () => ['-c:a', 'pcm_s16le'] },
  flac: { args: () => ['-c:a', 'flac'], cover: true },
  opus: { args: (k) => ['-c:a', 'libopus', '-b:a', `${k}k`] },
  ogg: { args: (k) => ['-c:a', 'libvorbis', '-b:a', `${k}k`] },
};

// loudnorm trabaja a 192 kHz internamente: se fija 48 kHz, que admiten todos los formatos.
const LOUDNORM = ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000'];

function normalizeArgs(format, bitrate) {
  const codec = AUDIO_CODECS[format];
  const args = ['-map', '0:a:0'];
  if (codec.cover) args.push('-map', '0:v?', '-c:v', 'copy', '-disposition:v', 'attached_pic');
  args.push(...LOUDNORM, ...codec.args(bitrate), '-map_metadata', '0');
  return args;
}

/* ------------------------------------------------------------------ */
/* Ejecución                                                           */
/* ------------------------------------------------------------------ */
/** Temporal junto al archivo, con la misma extensión (ffmpeg elige el formato por ella). */
const tempFor = (file) => {
  const ext = path.extname(file);
  return `${file.slice(0, -ext.length)}.kg-tmp${ext}`;
};

/**
 * Corre ffmpeg con progreso. ctx = { ffmpeg, duration, onProgress(percent), track(child) }:
 * track recibe el proceso para que la descarga pueda cancelarlo.
 */
function runFfmpeg(ctx, input, args, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(ctx.ffmpeg, ['-hide_banner', '-y', '-i', input, ...args, '-progress', 'pipe:1', '-nostats', output], { windowsHide: true });
    ctx.track?.(child);
    let stderr = '';
    let buffer = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdout.on('data', (d) => {
      buffer += d;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && ctx.duration) ctx.onProgress?.(Math.min(99, (Number(m[1]) / 1e6 / ctx.duration) * 100));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const last = stderr.trim().split(/\r?\n/).pop() || `ffmpeg ${code}`;
      reject(new KgError('FFMPEG', last));
    });
  });
}

async function replaceWith(ctx, file, args) {
  const temp = tempFor(file);
  try {
    await runFfmpeg(ctx, file, args, temp);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

async function normalizeAudio(ctx, file, format, bitrate) {
  await replaceWith(ctx, file, normalizeArgs(format, bitrate));
}

async function applyPreset(ctx, file, preset, { hasAudio = true } = {}) {
  const limit = limitBytes(preset);
  const temp = tempFor(file);
  try {
    for (let attempt = 0; attempt < (limit ? 3 : 1); attempt++) {
      await runFfmpeg(ctx, file, presetArgs(preset, { duration: ctx.duration, hasAudio }, attempt), temp);
      if (!limit || fs.statSync(temp).size <= limit) {
        fs.renameSync(temp, file);
        return;
      }
    }
    throw new KgError('TOO_LONG', maxSeconds(preset, hasAudio));
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

/** Duración en segundos leída por ffmpeg (0 si no se puede). */
function probeDuration(ffmpeg, file) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', () => resolve(0));
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0);
    });
  });
}

module.exports = { VIDEO_PRESETS, maxSeconds, presetArgs, normalizeArgs, normalizeAudio, applyPreset, limitBytes, probeDuration };
