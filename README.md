# Kerygma YT Downloader

App de escritorio **portable** (Windows y macOS) para descargar videos de YouTube. Su diseño comparte el lenguaje
visual de Kerygma Converter: fondo casi negro, acento naranja coral, íconos de línea y panel de opciones lateral.

- **Pestaña Video**: MP4 (H.264 + AAC, compatible con todo) o MKV (lo mejor disponible, hasta 4K), con tope de calidad
  Mejor / 1080p / 720p / 480p.
- **Pestaña Audio**: MP3, M4A, AAC, WAV, FLAC, OPUS u OGG; calidad 128 / 192 / 256 / 320 kbps en los formatos con compresión.
- **Recortar fragmento**: descarga solo de un minuto a otro (`mm:ss` o `h:mm:ss`), en video o audio, con cortes exactos.
- Pega el enlace, arrástralo a la ventana o usa el botón **Pegar**; vista previa con miniatura, título y duración.
- Lista de descargas con progreso, velocidad y tiempo restante, cancelación limpia y acceso directo a la carpeta.
- **Configuración**: tema (sistema / claro / oscuro), crear copia o reemplazar si el archivo existe, recordar opciones,
  notificación del sistema al terminar, abrir la carpeta de destino y **actualizar el motor** (`yt-dlp`) cuando YouTube cambie algo.

> Descarga solo contenido que tengas derecho a descargar y respeta los Términos de Servicio de YouTube.

## Descargar la app

Ve a la pestaña **Releases** del repositorio:

| Sistema | Archivo | Cómo usarlo |
|---|---|---|
| Windows | `Kerygma-YT-Downloader-<versión>-portable.exe` | Doble clic. No instala nada. |
| macOS Intel | `...-mac-x64.zip` | Descomprime y abre `Kerygma YT Downloader.app`. |
| macOS Apple Silicon | `...-mac-arm64.zip` | Descomprime y abre `Kerygma YT Downloader.app`. |

**macOS:** la app no está firmada con un certificado de Apple. La primera vez, clic derecho → **Abrir** → **Abrir**
(o `xattr -cr "Kerygma YT Downloader.app"` en la Terminal). **Windows:** SmartScreen puede avisar; "Más información" → "Ejecutar de todas formas".

### Modo 100 % portable

Por defecto la configuración se guarda en la carpeta de datos del sistema. Para llevarla contigo (ej. en un USB),
crea una carpeta llamada `KerygmaData` junto a la app: si existe, ahí se guardará todo. En el `.exe` de Windows
esa carpeta se crea automáticamente junto al ejecutable.

## Desarrollo

Requisitos: Node.js ≥ 20.

```bash
npm install
npm run fetch-bins   # descarga yt-dlp y ffmpeg de tu plataforma a ./bin (verifica SHA-256 de yt-dlp)
npm start            # abre la app
npm test             # pruebas offline (validaciones, configuración, opciones inválidas)
node scripts/smoke-test.js --online   # pruebas reales: formatos, copia/reemplazo, recortes y cancelación (tarda unos minutos)
npm run screenshot   # captura la interfaz con datos simulados (dist/screenshots)
npm run icon         # regenera build/icon.png (el logo)
```

> Evita desarrollar dentro de carpetas sincronizadas con iCloud (Documentos/Escritorio): `codesign` y algunos binarios
> se comportan mal ahí. La app ya se protege copiando el motor a la caché local, pero conviene compilar en otra ruta.

## Compilar los portables

```bash
npm run dist:mac   # zips x64 + arm64 (en macOS)
npm run dist:win   # .exe portable (idealmente en Windows)
```

La forma recomendada es **GitHub Actions** (`.github/workflows/build.yml`): compila nativamente en Windows y macOS.
Para publicar un Release con los tres archivos:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Arquitectura

```
main.js                     Proceso principal: ventana, IPC, configuración, modo portable
preload.js                  Puente seguro (contextBridge) hacia la interfaz
src/core/
  binaries.js               Copia yt-dlp/ffmpeg a una caché local y devuelve sus rutas
  ytdlp.js                  Único módulo que conoce los flags de yt-dlp (info, formatos, calidad, recorte, progreso, update)
  settings.js               Esquema de la configuración: valores de fábrica, validación y regla de "recordar opciones"
  validate.js               Validación de enlaces y nombres de archivo válidos en Windows/macOS
src/renderer/               Interfaz (HTML + CSS + JS, sin frameworks, con CSP estricta)
scripts/                    fetch-binaries, smoke-test, make-icon, screenshot, after-pack
```

Decisiones clave:

- **yt-dlp + ffmpeg incluidos** en la app (no se necesita instalar nada). Las librerías npm de YouTube se rompen
  seguido; `yt-dlp` se actualiza casi a diario y la app puede actualizarlo en sitio.
- **El motor se ejecuta desde la caché local**, no desde donde esté la app (USB, Escritorio con iCloud, carpeta de solo lectura).
- **Recorte**: `--download-sections` con `--force-keyframes-at-cuts` en video **y audio** (sin él, el audio salía con
  segundos de más: 10 s en vez de 7 s); re-codifica solo el tramo. El progreso se lee de la salida de ffmpeg porque yt-dlp
  no lo informa en recortes.
- **Seguridad**: `contextIsolation`, `sandbox`, sin `nodeIntegration`, navegación externa bloqueada y validación de todo lo que llega por IPC.

## Licencia

MIT. `yt-dlp` (Unlicense) y `ffmpeg` (LGPL/GPL) se distribuyen con sus propias licencias.
