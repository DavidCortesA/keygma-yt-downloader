/* Interfaz de Kerygma YT Downloader. Habla con el proceso principal solo a través de window.kerygma. */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.kerygma;

  const el = {
    url: $('url'),
    pasteBtn: $('pasteBtn'),
    urlHint: $('urlHint'),
    previewLoading: $('previewLoading'),
    preview: $('preview'),
    thumb: $('thumb'),
    duration: $('duration'),
    title: $('title'),
    uploader: $('uploader'),
    modeSwitch: $('modeSwitch'),
    trimToggle: $('trimToggle'),
    trimFields: $('trimFields'),
    trimStart: $('trimStart'),
    trimEnd: $('trimEnd'),
    trimHint: $('trimHint'),
    audioFormats: $('audioFormats'),
    folderPath: $('folderPath'),
    changeFolder: $('changeFolder'),
    openFolder: $('openFolder'),
    downloadBtn: $('downloadBtn'),
    progressCard: $('progressCard'),
    stage: $('stage'),
    percent: $('percent'),
    barFill: $('barFill'),
    speedEta: $('speedEta'),
    cancelBtn: $('cancelBtn'),
    resultCard: $('resultCard'),
    resultIcon: $('resultIcon'),
    resultTitle: $('resultTitle'),
    resultText: $('resultText'),
    showFileBtn: $('showFileBtn'),
    historyCard: $('historyCard'),
    historyList: $('historyList'),
    engineVersion: $('engineVersion'),
    engineError: $('engineError'),
    updateBtn: $('updateBtn'),
    toast: $('toast'),
  };

  const state = {
    settings: { outputDir: '', mode: 'video', audioFormat: 'mp3' },
    info: null,
    infoUrl: '',
    infoRequest: 0,
    busy: false,
    engineOk: true,
    lastFile: null,
  };

  /* ---------------- utilidades ---------------- */
  const pad = (n) => String(n).padStart(2, '0');

  function formatDuration(sec) {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return '';
    const mb = bytesPerSec / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  }

  function formatEta(sec) {
    if (sec === null || sec === undefined) return '';
    return `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;
  }

  /** "90" → 90 · "1:30" → 90 · "1:02:05" → 3725. Devuelve null si el formato no es válido. */
  function parseTime(text) {
    const parts = text.trim().split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    const nums = parts.map(Number);
    if (nums.length > 1 && nums.slice(1).some((n) => n >= 60)) return null;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
  }

  /**
   * Lee y valida el recorte. Devuelve { section, error, startBad, endBad }.
   * section es null cuando el recorte está desactivado.
   */
  function readTrim() {
    if (!el.trimToggle.checked) return { section: null, error: null };

    const duration = state.info?.duration || null;
    const startText = el.trimStart.value.trim();
    const endText = el.trimEnd.value.trim();

    const start = startText ? parseTime(startText) : 0;
    if (start === null) return { section: null, error: 'El inicio no es válido. Usa mm:ss o h:mm:ss.', startBad: true };

    let end = endText ? parseTime(endText) : duration;
    if (endText && end === null) return { section: null, error: 'El final no es válido. Usa mm:ss o h:mm:ss.', endBad: true };
    if (end === null) return { section: null, error: 'Escribe el tiempo final del fragmento.', endBad: true };

    if (duration && start >= duration) {
      return { section: null, error: `El inicio supera la duración del video (${formatDuration(duration)}).`, startBad: true };
    }
    if (duration && end > duration) end = duration;
    if (end - start < 1) return { section: null, error: 'El final debe ser mayor que el inicio (mínimo 1 segundo).', endBad: true };

    return { section: { start, end }, error: null };
  }

  const looksLikeYoutube = (text) => /(youtube\.com|youtu\.be)\//i.test(text);

  let toastTimer = null;
  function toast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', isError);
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4200);
  }

  function setHint(text, isError = false) {
    el.urlHint.textContent = text;
    el.urlHint.classList.toggle('error', isError);
  }

  function basename(filePath) {
    return filePath.split(/[\\/]/).pop();
  }

  /* ---------------- estado de la interfaz ---------------- */
  function refreshControls() {
    const trim = readTrim();
    const canDownload = state.engineOk && !state.busy && !!state.info && !trim.error;
    el.downloadBtn.disabled = !canDownload;
    el.url.disabled = state.busy;
    el.pasteBtn.disabled = state.busy;
    el.changeFolder.disabled = state.busy;
    el.updateBtn.disabled = state.busy;
    el.trimToggle.disabled = state.busy;
    el.trimStart.disabled = state.busy;
    el.trimEnd.disabled = state.busy;
    el.modeSwitch.querySelectorAll('.seg').forEach((b) => (b.disabled = state.busy));
    el.audioFormats.querySelectorAll('.chip').forEach((b) => (b.disabled = state.busy));
  }

  function renderTrim() {
    const on = el.trimToggle.checked;
    el.trimFields.classList.toggle('hidden', !on);
    el.trimEnd.placeholder = state.info?.duration ? formatDuration(state.info.duration) : 'fin del video';

    const trim = readTrim();
    el.trimStart.classList.toggle('invalid', !!trim.startBad);
    el.trimEnd.classList.toggle('invalid', !!trim.endBad);

    let hint = '';
    let isError = false;
    if (on && trim.error) {
      // No molestar con errores mientras los campos están vacíos y el video aún no carga.
      const untouched = !el.trimStart.value.trim() && !el.trimEnd.value.trim();
      if (!(untouched && !state.info)) {
        hint = trim.error;
        isError = true;
      }
    } else if (on && trim.section) {
      hint = `Fragmento de ${formatDuration(trim.section.end - trim.section.start) || '0:00'} · del ${formatDuration(trim.section.start) || '0:00'} al ${formatDuration(trim.section.end)}`;
    }
    el.trimHint.textContent = hint;
    el.trimHint.classList.toggle('error', isError);
    el.trimHint.classList.toggle('hidden', !hint);
    el.trimHint.classList.toggle('ok', !!hint && !isError);
    refreshControls();
  }

  function renderSettings() {
    el.folderPath.textContent = state.settings.outputDir;
    el.folderPath.title = state.settings.outputDir;

    el.modeSwitch.querySelectorAll('.seg').forEach((b) => {
      const active = b.dataset.mode === state.settings.mode;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
    el.audioFormats.classList.toggle('hidden', state.settings.mode !== 'audio');
    el.audioFormats.querySelectorAll('.chip').forEach((b) => {
      const active = b.dataset.fmt === state.settings.audioFormat;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', String(active));
    });
  }

  async function updateSettings(patch) {
    state.settings = await api.saveSettings(patch);
    renderSettings();
  }

  function clearPreview() {
    state.info = null;
    state.infoUrl = '';
    el.preview.classList.add('hidden');
    el.previewLoading.classList.add('hidden');
    renderTrim();
  }

  function showPreview(info) {
    el.title.textContent = info.title;
    el.uploader.textContent = info.uploader || '';
    el.duration.textContent = formatDuration(info.duration);
    el.duration.classList.toggle('hidden', !info.duration);
    if (info.thumbnail) el.thumb.src = info.thumbnail;
    else el.thumb.removeAttribute('src');
    el.previewLoading.classList.add('hidden');
    el.preview.classList.remove('hidden');
  }

  /* ---------------- obtener información del video ---------------- */
  async function fetchInfo(url) {
    const request = ++state.infoRequest;
    el.preview.classList.add('hidden');
    el.previewLoading.classList.remove('hidden');
    setHint('');

    try {
      const info = await api.getInfo(url);
      if (request !== state.infoRequest) return; // llegó una respuesta vieja
      if (state.info?.id !== info.id) {
        el.trimStart.value = '';
        el.trimEnd.value = '';
      }
      state.info = info;
      state.infoUrl = url;
      showPreview(info);
      renderTrim();
    } catch (err) {
      if (request !== state.infoRequest) return;
      clearPreview();
      setHint(cleanError(err), true);
    }
    refreshControls();
  }

  function cleanError(err) {
    return String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  let debounce = null;
  function onUrlChanged() {
    const url = el.url.value.trim();
    clearTimeout(debounce);
    state.infoRequest += 1; // invalida peticiones en curso
    clearPreview();
    hideResult();

    if (!url) return setHint('');
    if (!looksLikeYoutube(url)) return setHint('Pega un enlace de YouTube (youtube.com o youtu.be).', true);

    setHint('');
    debounce = setTimeout(() => fetchInfo(url), 450);
  }

  /* ---------------- descarga ---------------- */
  function showProgress(visible) {
    el.progressCard.classList.toggle('hidden', !visible);
    if (visible) setProgress(0, 'Preparando…');
  }

  function setProgress(percent, stage) {
    const p = Math.max(0, Math.min(100, percent));
    el.barFill.style.width = `${p}%`;
    el.percent.textContent = `${Math.floor(p)}%`;
    if (stage) el.stage.textContent = stage;
  }

  function hideResult() {
    el.resultCard.classList.add('hidden');
    state.lastFile = null;
  }

  function showResult({ ok, title, text, file }) {
    el.resultCard.classList.toggle('error', !ok);
    el.resultIcon.textContent = ok ? '✓' : '!';
    el.resultTitle.textContent = title;
    el.resultText.textContent = text;
    state.lastFile = file || null;
    el.showFileBtn.classList.toggle('hidden', !file);
    el.resultCard.classList.remove('hidden');
  }

  function addHistory(filePath, mode, audioFormat, trimmed) {
    const li = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'h-kind';
    kind.textContent = (mode === 'audio' ? audioFormat.toUpperCase() : 'MP4') + (trimmed ? ' ✂' : '');
    const name = document.createElement('span');
    name.className = 'h-name';
    name.textContent = basename(filePath);
    name.title = filePath;
    const btn = document.createElement('button');
    btn.className = 'btn ghost small';
    btn.textContent = 'Mostrar';
    btn.addEventListener('click', () => api.showItem(filePath));
    li.append(kind, name, btn);
    el.historyList.prepend(li);
    el.historyCard.classList.remove('hidden');
  }

  async function startDownload() {
    if (state.busy || !state.info) return;
    const { mode, audioFormat, outputDir } = state.settings;
    const url = el.url.value.trim();
    const { section, error } = readTrim();
    if (error) return toast(error, true);

    state.busy = true;
    hideResult();
    refreshControls();
    showProgress(true);

    try {
      const result = await api.startDownload({ url, title: state.info.title, mode, audioFormat, outputDir, section });
      if (result?.cancelled) {
        showResult({ ok: false, title: 'Descarga cancelada', text: 'No se guardó ningún archivo.' });
      } else {
        setProgress(100, 'Completado');
        showResult({
          ok: true,
          title: '¡Descarga completa!',
          text: basename(result.filePath),
          file: result.filePath,
        });
        addHistory(result.filePath, mode, audioFormat, !!section);
      }
    } catch (err) {
      showResult({ ok: false, title: 'No se pudo descargar', text: cleanError(err) });
    } finally {
      state.busy = false;
      showProgress(false);
      refreshControls();
    }
  }

  api.onDownloadEvent((e) => {
    if (e.type === 'progress') {
      setProgress(e.percent);
      const parts = [formatSpeed(e.speed), e.eta !== null ? `faltan ${formatEta(e.eta)}` : ''].filter(Boolean);
      el.speedEta.textContent = parts.join(' · ');
    } else if (e.type === 'stage') {
      el.stage.textContent = e.label;
      if (typeof e.percent === 'number') {
        setProgress(e.percent);
        el.speedEta.textContent = '';
      }
    }
  });

  /* ---------------- eventos ---------------- */
  el.url.addEventListener('input', onUrlChanged);
  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.downloadBtn.disabled) startDownload();
  });

  el.pasteBtn.addEventListener('click', async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return toast('El portapapeles está vacío.', true);
      el.url.value = text;
      onUrlChanged();
    } catch {
      toast('No se pudo leer el portapapeles. Usa Ctrl/Cmd + V.', true);
    }
    el.url.focus();
  });

  el.trimToggle.addEventListener('change', renderTrim);
  [el.trimStart, el.trimEnd].forEach((input) => {
    input.addEventListener('input', renderTrim);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !el.downloadBtn.disabled) startDownload();
    });
  });

  el.modeSwitch.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (btn && !state.busy) updateSettings({ mode: btn.dataset.mode });
  });

  el.audioFormats.addEventListener('click', (e) => {
    const btn = e.target.closest('.chip');
    if (btn && !state.busy) updateSettings({ audioFormat: btn.dataset.fmt });
  });

  el.changeFolder.addEventListener('click', async () => {
    const dir = await api.chooseFolder(state.settings.outputDir);
    if (dir) updateSettings({ outputDir: dir });
  });

  el.openFolder.addEventListener('click', () => api.openFolder(state.settings.outputDir));
  el.downloadBtn.addEventListener('click', startDownload);
  el.cancelBtn.addEventListener('click', () => {
    el.stage.textContent = 'Cancelando…';
    api.cancelDownload();
  });
  el.showFileBtn.addEventListener('click', () => state.lastFile && api.showItem(state.lastFile));

  el.updateBtn.addEventListener('click', async () => {
    el.updateBtn.disabled = true;
    const original = el.updateBtn.textContent;
    el.updateBtn.textContent = 'Actualizando…';
    try {
      const { message, engineVersion } = await api.updateEngine();
      el.engineVersion.textContent = `motor ${engineVersion || ''}`.trim();
      toast(message || 'Motor actualizado.');
    } catch (err) {
      toast(cleanError(err), true);
    } finally {
      el.updateBtn.textContent = original;
      el.updateBtn.disabled = state.busy;
    }
  });

  /* ---------------- arranque ---------------- */
  (async () => {
    const init = await api.init();
    document.body.classList.add(`platform-${init.platform}`);
    state.settings = init.settings;
    state.engineOk = !init.engineError;
    el.engineVersion.textContent = init.engineVersion ? `motor ${init.engineVersion}` : 'motor no disponible';

    if (init.engineError) {
      el.engineError.textContent = init.engineError;
      el.engineError.classList.remove('hidden');
    }

    renderSettings();
    renderTrim();
  })();
})();
