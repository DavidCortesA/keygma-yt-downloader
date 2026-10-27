/**
 * Historial de descargas, guardado en history.json dentro de la carpeta de datos.
 * Sin dependencias de Electron (se prueba con Node plano).
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MAX_ENTRIES = 300;
const KINDS = ['video', 'audio'];
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Solo campos conocidos y con el tipo correcto (el archivo pudo editarse a mano). */
function clean(entry) {
  if (!entry || typeof entry !== 'object' || !str(entry.filePath)) return null;
  return {
    id: str(entry.id, 64) || randomUUID(),
    date: Number.isFinite(entry.date) ? entry.date : Date.now(),
    title: str(entry.title, 300),
    url: str(entry.url),
    platform: str(entry.platform, 40),
    kind: KINDS.includes(entry.kind) ? entry.kind : 'video',
    ext: str(entry.ext, 10),
    filePath: str(entry.filePath),
    size: Number.isFinite(entry.size) ? entry.size : 0,
    thumbnail: /^https?:\/\//.test(entry.thumbnail || '') ? str(entry.thumbnail) : '',
  };
}

function createHistory(file) {
  let cache = null;

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = (Array.isArray(raw) ? raw : []).map(clean).filter(Boolean);
    } catch {
      cache = [];
    }
    return cache;
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  }

  return {
    /** Más recientes primero; exists indica si el archivo sigue en su lugar. */
    list() {
      return load().map((e) => ({ ...e, exists: fs.existsSync(e.filePath) }));
    },
    add(entry) {
      const item = clean({ ...entry, id: randomUUID(), date: Date.now() });
      if (!item) return null;
      cache = [item, ...load().filter((e) => e.filePath !== item.filePath)].slice(0, MAX_ENTRIES);
      save();
      return item;
    },
    remove(id) {
      cache = load().filter((e) => e.id !== id);
      save();
    },
    clear() {
      cache = [];
      save();
    },
  };
}

module.exports = { createHistory, MAX_ENTRIES };
