/**
 * electron-builder lo ejecuta tras empaquetar y ANTES de firmar.
 *
 * 1. Revisa que la app lleve yt-dlp y ffmpeg de SU arquitectura. Si falta bin/<os>-<arch>,
 *    electron-builder no se queja y sale una app que no puede descargar nada; aquí el
 *    build falla con un mensaje claro.
 * 2. En carpetas sincronizadas con iCloud (Documentos/Escritorio) macOS agrega atributos
 *    extendidos a los archivos y `codesign` falla con "resource fork, Finder information,
 *    or similar detritus not allowed". Se eliminan antes de firmar.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Arch } = require('electron-builder');

// Nombre que usa `lipo -archs` para cada arquitectura de electron-builder.
const LIPO_ARCH = { x64: 'x86_64', arm64: 'arm64' };

function checkBinaries(context) {
  const arch = Arch[context.arch];
  const isWin = context.electronPlatformName === 'win32';
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const binDir = path.join(resources, 'bin');

  for (const name of isWin ? ['yt-dlp.exe', 'ffmpeg.exe'] : ['yt-dlp', 'ffmpeg']) {
    if (!fs.existsSync(path.join(binDir, name))) {
      throw new Error(
        `La app de ${arch} no lleva ${name}. Corre antes: node scripts/fetch-binaries.js ` +
        `${isWin ? 'win' : 'mac'}-${arch}`
      );
    }
  }

  // ffmpeg es de una sola arquitectura; si no coincide, se empaquetó la carpeta equivocada.
  if (context.electronPlatformName === 'darwin') {
    const archs = execFileSync('lipo', ['-archs', path.join(binDir, 'ffmpeg')]).toString().trim().split(/\s+/);
    if (!archs.includes(LIPO_ARCH[arch])) {
      throw new Error(`El ffmpeg empaquetado es ${archs.join('+')}, pero la app es ${arch}.`);
    }
  }
}

exports.default = async function afterPack(context) {
  checkBinaries(context);
  if (context.electronPlatformName !== 'darwin') return;
  execFileSync('xattr', ['-cr', context.appOutDir]);
};
