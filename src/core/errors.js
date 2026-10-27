/**
 * Errores con código. El mensaje viaja por IPC como "KG:CODIGO|detalle" y la interfaz lo
 * traduce al idioma elegido (ver ERRORS en src/renderer/i18n.js).
 */
class KgError extends Error {
  constructor(code, detail = '') {
    super(`KG:${code}${detail !== '' && detail !== undefined ? `|${detail}` : ''}`);
    this.name = 'KgError';
    this.code = code;
    this.detail = detail;
  }
}

module.exports = { KgError };
