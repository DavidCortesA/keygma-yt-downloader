/* Interfaz de Kerygma Downloader. Habla con el proceso principal solo a través de window.kerygma. */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.kerygma;

  /* ------------------------------------------------------------------ */
  /* Catálogo de opciones (lo que ofrece el panel lateral)               */
  /* ------------------------------------------------------------------ */
  const VIDEO_FORMATS = [
    { id: 'mp4', label: 'MP4', desc: 'H.264 + AAC. Se reproduce en todo: celulares, web, TV y redes sociales.' },
    { id: 'mkv', label: 'MKV', desc: 'Lo mejor disponible (hasta 4K). No lo abren todos los reproductores ni las redes sociales.' },
  ];
  const VIDEO_QUALITIES = [
    { id: 'best', label: 'Mejor' },
    { id: '1080', label: '1080p' },
    { id: '720', label: '720p' },
    { id: '480', label: '480p' },
  ];
  const AUDIO_FORMATS = [
    { id: 'mp3', label: 'MP3', lossy: true, desc: 'El formato de audio universal: funciona en cualquier reproductor, auto o celular.' },
    { id: 'm4a', label: 'M4A', lossy: true, desc: 'AAC en contenedor MP4: muy buena calidad, ideal para Apple y celulares.' },
    { id: 'aac', label: 'AAC', lossy: true, desc: 'AAC sin contenedor: archivos ligeros para reproductores compatibles.' },
    { id: 'wav', label: 'WAV', lossy: false, desc: 'Sin compresión: calidad máxima, pero los archivos pesan mucho.' },
    { id: 'flac', label: 'FLAC', lossy: false, desc: 'Sin pérdida y comprimido: ideal para archivar.' },
    { id: 'opus', label: 'OPUS', lossy: true, desc: 'Muy eficiente a tasas bajas: ideal para voz y streaming.' },
    { id: 'ogg', label: 'OGG', lossy: true, desc: 'Vorbis: formato abierto, común en juegos y Linux.' },
  ];
  const AUDIO_BITRATES = [128, 192, 256, 320];

  const TAB_TEXT = {
    video: {
      title: 'Descargar video',
      sub: 'Pega el enlace de un video de YouTube, Facebook, TikTok, Instagram o Vimeo.',
      button: 'Descargar video',
    },
    audio: {
      title: 'Descargar audio',
      sub: 'Saca solo el audio de un video: mensajes, podcasts, música.',
      button: 'Descargar audio',
    },
  };

  const el = {
    url: $('url'), pasteBtn: $('pasteBtn'), urlHint: $('urlHint'),
    previewLoading: $('previewLoading'), preview: $('preview'),
    thumb: $('thumb'), duration: $('duration'), title: $('title'), uploader: $('uploader'),
    dropzone: $('dropzone'), queue: $('queue'),
    pageTitle: $('pageTitle'), pageSub: $('pageSub'),
    listMeta: $('listMeta'), listCount: $('listCount'), clearList: $('clearList'),
    tabs: document.querySelectorAll('.tab'),
    formatGrid: $('formatGrid'), formatDesc: $('formatDesc'),
    qualitySection: $('qualitySection'), qualityLabel: $('qualityLabel'), qualityUnit: $('qualityUnit'),
    qualitySeg: $('qualitySeg'), qualityDesc: $('qualityDesc'),
    trimToggle: $('trimToggle'), trimFields: $('trimFields'),
    trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimHint: $('trimHint'),
    folderName: $('folderName'), openFolder: $('openFolder'), changeFolder: $('changeFolder'),
    statusText: $('statusText'), downloadBtn: $('downloadBtn'),
    engineError: $('engineError'), engineVersion: $('engineVersion'), updateBtn: $('updateBtn'),
    aboutLine: $('aboutLine'),
    settingsBtn: $('settingsBtn'), modal: $('modal'), modalClose: $('modalClose'),
    toast: $('toast'),
  };

  const state = {
    settings: null,
    info: null,
    infoRequest: 0,
    busy: false,
    engineOk: true,
    engineVersion: null,
    appVersion: '',
    electron: '',
    queue: [], // { id, kind, ext, title, status, percent, stage, speedEta, filePath, size, error, folder }
    nextId: 1,
  };

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '';
  // Filtro rápido mientras se escribe; la validación completa la hace el proceso principal.
  const looksSupported = (text) => /(youtube\.com|youtu\.be|facebook\.com|fb\.watch|tiktok\.com|instagram\.com|vimeo\.com)\//i.test(text);

  function formatDuration(sec) {
    if (!sec) return '';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function formatSpeed(bytesPerSec) {
    if (!bytesPerSec) return '';
    const mb = bytesPerSec / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;
  }

  const formatEta = (sec) => `${pad(Math.floor(sec / 60))}:${pad(Math.floor(sec % 60))}`;

  function cleanError(err) {
    return String(err?.message || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  let toastTimer = null;
  function toast(message, isError = false) {
    el.toast.textContent = message;
    el.toast.classList.toggle('error', isError);
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 4200);
  }

  /** Crea un elemento de forma segura (nunca se inserta HTML de fuentes externas). */
  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    children.flat().forEach((c) => c && node.append(c));
    return node;
  }

  const icon = (name) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };

  /** Actualiza la configuración local de inmediato y la guarda sin esperar respuesta. */
  function update(patch) {
    const s = state.settings;
    state.settings = {
      ...s,
      ...patch,
      video: { ...s.video, ...patch.video },
      audio: { ...s.audio, ...patch.audio },
    };
    api.saveSettings(patch);
  }

  /* ------------------------------------------------------------------ */
  /* Recorte                                                             */
  /* ------------------------------------------------------------------ */
  /** "90" → 90 · "1:30" → 90 · "1:02:05" → 3725. Devuelve null si el formato no es válido. */
  function parseTime(text) {
    const parts = text.trim().split(':');
    if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    const nums = parts.map(Number);
    if (nums.length > 1 && nums.slice(1).some((n) => n >= 60)) return null;
    return nums.reduce((acc, n) => acc * 60 + n, 0);
  }

  /** Lee y valida el recorte. `section` es null cuando está desactivado o es inválido. */
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

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  const tab = () => state.settings.tab;

  function renderTabs() {
    el.tabs.forEach((t) => {
      const active = t.dataset.tab === tab();
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
      t.disabled = state.busy;
    });
    el.pageTitle.textContent = TAB_TEXT[tab()].title;
    el.pageSub.textContent = TAB_TEXT[tab()].sub;
  }

  function chipButton(def, active, onClick) {
    return h('button', {
      class: `chip${active ? ' active' : ''}`,
      role: 'radio',
      'aria-checked': String(active),
      text: def.label,
      ...(state.busy ? { disabled: '' } : {}),
      onclick: onClick,
    });
  }

  function segButton(label, active, onClick) {
    return h('button', {
      class: `seg-item${active ? ' active' : ''}`,
      role: 'radio',
      'aria-checked': String(active),
      text: label,
      ...(state.busy ? { disabled: '' } : {}),
      onclick: onClick,
    });
  }

  function renderOptions() {
    const s = state.settings;
    el.formatGrid.replaceChildren();
    el.qualitySeg.replaceChildren();

    if (tab() === 'video') {
      VIDEO_FORMATS.forEach((f) =>
        el.formatGrid.append(chipButton(f, s.video.container === f.id, () => { update({ video: { container: f.id } }); renderOptions(); }))
      );
      el.formatDesc.textContent = VIDEO_FORMATS.find((f) => f.id === s.video.container).desc;

      el.qualitySection.classList.remove('hidden');
      el.qualityLabel.textContent = 'Calidad';
      el.qualityUnit.textContent = '';
      VIDEO_QUALITIES.forEach((q) =>
        el.qualitySeg.append(segButton(q.label, String(s.video.quality) === q.id, () => { update({ video: { quality: q.id } }); renderOptions(); }))
      );
      el.qualityDesc.textContent = 'Mejor usa la más alta disponible. Si el video no llega a esa resolución, se descarga la más cercana.';
    } else {
      AUDIO_FORMATS.forEach((f) =>
        el.formatGrid.append(chipButton(f, s.audio.format === f.id, () => { update({ audio: { format: f.id } }); renderOptions(); }))
      );
      const fmt = AUDIO_FORMATS.find((f) => f.id === s.audio.format);
      el.formatDesc.textContent = fmt.desc;

      el.qualitySection.classList.toggle('hidden', !fmt.lossy);
      el.qualityLabel.textContent = 'Calidad';
      el.qualityUnit.textContent = 'kbps';
      AUDIO_BITRATES.forEach((b) =>
        el.qualitySeg.append(segButton(String(b), Number(s.audio.bitrate) === b, () => { update({ audio: { bitrate: b } }); renderOptions(); }))
      );
      el.qualityDesc.textContent = '192 sirve para casi todo; 320 para música exigente.';
    }
  }

  function renderTrim() {
    const on = el.trimToggle.checked;
    el.trimFields.classList.toggle('hidden', !on);
    el.trimEnd.placeholder = state.info?.duration ? formatDuration(state.info.duration) : 'fin del video';
    el.trimToggle.disabled = state.busy;
    el.trimStart.disabled = state.busy;
    el.trimEnd.disabled = state.busy;

    const trim = readTrim();
    el.trimStart.classList.toggle('invalid', !!trim.startBad);
    el.trimEnd.classList.toggle('invalid', !!trim.endBad);

    let hint = '';
    let kind = '';
    if (on && trim.error) {
      // No molestar con errores mientras los campos están vacíos y el video aún no carga.
      const untouched = !el.trimStart.value.trim() && !el.trimEnd.value.trim();
      if (!(untouched && !state.info)) {
        hint = trim.error;
        kind = 'error';
      }
    } else if (on && trim.section) {
      const { start, end } = trim.section;
      hint = `Fragmento de ${formatDuration(end - start) || '0:00'} · del ${formatDuration(start) || '0:00'} al ${formatDuration(end)}`;
      kind = 'ok';
    }
    el.trimHint.textContent = hint;
    el.trimHint.classList.toggle('hidden', !hint);
    el.trimHint.classList.toggle('error', kind === 'error');
    el.trimHint.classList.toggle('ok', kind === 'ok');
  }

  function renderFolder() {
    const dir = state.settings.outputDir;
    el.folderName.textContent = basename(dir) || dir;
    el.openFolder.title = `Abrir ${dir}`;
    el.changeFolder.disabled = state.busy;
  }

  const activeItem = () => state.queue.find((i) => i.status === 'active');

  function renderStatus() {
    const trim = readTrim();
    const active = activeItem();
    let text;
    if (!state.engineOk) text = 'El motor de descarga no está disponible';
    else if (state.busy) text = `${active?.stage || 'Preparando'}… ${Math.floor(active?.percent || 0)}%`;
    else if (!el.url.value.trim()) text = 'Pega un enlace para empezar';
    else if (!state.info) text = el.previewLoading.classList.contains('hidden') ? 'Esperando un enlace válido' : 'Buscando video…';
    else if (trim.error) text = trim.error;
    else if (trim.section) text = `Listo · fragmento de ${formatDuration(trim.section.end - trim.section.start)}`;
    else text = `Listo para descargar${state.info.duration ? ` · ${formatDuration(state.info.duration)}` : ''}`;
    el.statusText.textContent = text;

    const btn = el.downloadBtn;
    btn.classList.toggle('cancel', state.busy);
    btn.textContent = state.busy ? 'Cancelar descarga' : TAB_TEXT[tab()].button;
    btn.disabled = state.busy ? false : !(state.engineOk && state.info && !trim.error);
  }

  function renderLeft() {
    const hasQueue = state.queue.length > 0;
    const loading = !el.previewLoading.classList.contains('hidden');
    el.preview.classList.toggle('hidden', !state.info);
    el.dropzone.classList.toggle('hidden', !!state.info || loading || hasQueue);
    el.queue.classList.toggle('hidden', !hasQueue);
    el.listMeta.classList.toggle('hidden', !hasQueue);
    el.listCount.textContent = `${state.queue.length} ${state.queue.length === 1 ? 'archivo' : 'archivos'}`;
    el.clearList.disabled = state.busy && state.queue.every((i) => i.status === 'active');
  }

  function itemMeta(item) {
    if (item.status === 'active') {
      return h('div', { class: 'item-meta', text: item.speedEta ? `${item.stage} · ${item.speedEta}` : item.stage });
    }
    if (item.status === 'done') {
      return h('div', { class: 'item-meta' }, 'Guardado en ', h('b', { text: item.folder }), item.size ? ` · ${formatSize(item.size)}` : '');
    }
    if (item.status === 'error') return h('div', { class: 'item-meta', text: item.error });
    return h('div', { class: 'item-meta', text: 'No se guardó ningún archivo.' });
  }

  function itemPill(item) {
    if (item.status === 'active') return h('span', { class: 'pill accent', text: `${Math.floor(item.percent)}%` });
    if (item.status === 'done') return h('span', { class: 'pill ok', text: 'Descargado' });
    if (item.status === 'error') return h('span', { class: 'pill err', text: 'Error' });
    return h('span', { class: 'pill', text: 'Cancelado' });
  }

  function renderItem(item) {
    const actions = h('div', { class: 'item-actions' }, itemPill(item));
    if (item.status === 'done') {
      actions.append(h('button', { class: 'mini-btn', title: 'Mostrar en carpeta', 'aria-label': 'Mostrar en carpeta', onclick: () => api.showItem(item.filePath) }, icon('folder')));
    }
    if (item.status === 'active') {
      actions.append(h('button', { class: 'mini-btn', title: 'Cancelar', 'aria-label': 'Cancelar descarga', onclick: cancelDownload }, icon('x')));
    } else {
      actions.append(h('button', {
        class: 'mini-btn', title: 'Quitar de la lista', 'aria-label': 'Quitar de la lista',
        onclick: () => { state.queue = state.queue.filter((i) => i !== item); renderQueue(); },
      }, icon('x')));
    }

    const name = item.status === 'done' ? basename(item.filePath) : item.title;
    const tile = item.thumbnail
      ? h('div', { class: 'item-tile thumb' },
        h('img', { src: item.thumbnail, alt: '', draggable: 'false', onerror: (e) => e.target.remove() }),
        h('span', { class: 'tile-badge', text: item.ext }))
      : h('div', { class: 'item-tile', text: item.ext });
    const li = h('li', { class: `item ${item.status}`, 'data-id': String(item.id) },
      tile,
      h('div', { class: 'item-body' }, h('div', { class: 'item-name', title: name, text: name }), itemMeta(item)),
      actions
    );
    if (item.status === 'active') {
      const fill = h('div', { class: 'bar-fill' });
      fill.style.width = `${item.percent}%`; // CSSOM: permitido por la CSP (a diferencia del atributo style)
      li.append(h('div', { class: 'bar' }, fill));
    }
    return li;
  }

  function renderQueue() {
    el.queue.replaceChildren(...state.queue.map(renderItem));
    renderLeft();
    renderStatus();
  }

  /** Durante la descarga solo se actualiza la fila activa (evita reconstruir la lista en cada aviso). */
  function updateActiveRow() {
    const item = activeItem();
    const li = item && el.queue.querySelector(`[data-id="${item.id}"]`);
    if (!li) return;
    li.querySelector('.pill').textContent = `${Math.floor(item.percent)}%`;
    li.querySelector('.item-meta').textContent = item.speedEta ? `${item.stage} · ${item.speedEta}` : item.stage;
    li.querySelector('.bar-fill').style.width = `${item.percent}%`;
    renderStatus();
  }

  function renderAll() {
    renderTabs();
    renderOptions();
    renderTrim();
    renderFolder();
    renderQueue();
  }

  function renderSettingsModal() {
    const s = state.settings;
    el.modal.querySelectorAll('[data-setting]').forEach((node) => {
      const key = node.dataset.setting;
      if (node.matches('input[type="checkbox"]')) node.checked = !!s[key];
      else node.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b.dataset.value === s[key]));
    });
    el.engineVersion.textContent = state.engineVersion || (state.engineVersion === null ? '…' : 'no disponible');
    el.aboutLine.textContent = `Versión ${state.appVersion} · yt-dlp ${state.engineVersion || '…'} · Electron ${state.electron}`;
  }

  /* ------------------------------------------------------------------ */
  /* Enlace e información del video                                      */
  /* ------------------------------------------------------------------ */
  function setHint(text, isError = false) {
    el.urlHint.textContent = text;
    el.urlHint.classList.toggle('error', isError);
  }

  function clearPreview() {
    state.info = null;
    el.previewLoading.classList.add('hidden');
    renderLeft();
    renderTrim();
    renderStatus();
  }

  function showPreview(info) {
    el.title.textContent = info.title;
    el.uploader.textContent = [info.platform, info.uploader].filter(Boolean).join(' · ');
    el.duration.textContent = formatDuration(info.duration);
    el.duration.classList.toggle('hidden', !info.duration);
    if (info.thumbnail) el.thumb.src = info.thumbnail;
    else el.thumb.removeAttribute('src');
    el.previewLoading.classList.add('hidden');
  }

  async function fetchInfo(url) {
    const request = ++state.infoRequest;
    el.previewLoading.classList.remove('hidden');
    renderLeft();
    renderStatus();
    setHint('');

    try {
      const info = await api.getInfo(url);
      if (request !== state.infoRequest) return; // llegó una respuesta vieja
      if (state.info?.id !== info.id) {
        el.trimStart.value = '';
        el.trimEnd.value = '';
      }
      state.info = info;
      showPreview(info);
    } catch (err) {
      if (request !== state.infoRequest) return;
      clearPreview();
      setHint(cleanError(err), true);
    }
    renderLeft();
    renderTrim();
    renderStatus();
  }

  let debounce = null;
  function onUrlChanged() {
    const url = el.url.value.trim();
    clearTimeout(debounce);
    state.infoRequest += 1; // invalida peticiones en curso
    clearPreview();

    if (!url) return setHint('');
    if (!looksSupported(url)) return setHint('Pega un enlace de YouTube, Facebook, TikTok, Instagram o Vimeo.', true);

    setHint('');
    debounce = setTimeout(() => fetchInfo(url), 450);
  }

  function setUrl(text) {
    el.url.value = text.trim();
    onUrlChanged();
  }

  async function pasteFromClipboard() {
    if (state.busy) return;
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return toast('El portapapeles está vacío.', true);
      setUrl(text);
    } catch {
      toast('No se pudo leer el portapapeles. Usa Ctrl/Cmd + V.', true);
    }
    el.url.focus();
  }

  /* ------------------------------------------------------------------ */
  /* Descarga                                                            */
  /* ------------------------------------------------------------------ */
  function setBusy(busy) {
    state.busy = busy;
    el.url.disabled = busy;
    el.pasteBtn.disabled = busy;
    renderTabs();
    renderOptions();
    renderTrim();
    renderFolder();
  }

  async function startDownload() {
    if (state.busy || !state.info) return;
    const { section, error } = readTrim();
    if (error) return toast(error, true);

    const s = state.settings;
    const mode = tab();
    const item = {
      id: state.nextId++,
      kind: mode,
      ext: (mode === 'audio' ? s.audio.format : s.video.container).toUpperCase(),
      title: state.info.title,
      thumbnail: state.info.thumbnail || '',
      status: 'active',
      percent: 0,
      stage: 'Preparando',
      speedEta: '',
      folder: basename(s.outputDir) || s.outputDir,
    };
    state.queue.unshift(item);
    setBusy(true);
    renderQueue();

    try {
      const result = await api.startDownload({
        url: el.url.value.trim(),
        title: state.info.title,
        mode,
        outputDir: s.outputDir,
        video: s.video,
        audio: s.audio,
        section,
      });
      if (result?.cancelled) {
        item.status = 'cancelled';
      } else {
        item.status = 'done';
        item.filePath = result.filePath;
        item.size = result.size;
        item.percent = 100;
      }
    } catch (err) {
      item.status = 'error';
      item.error = cleanError(err);
    } finally {
      setBusy(false);
      renderQueue();
    }
  }

  function cancelDownload() {
    const item = activeItem();
    if (item) {
      item.stage = 'Cancelando';
      item.speedEta = '';
      updateActiveRow();
    }
    api.cancelDownload();
  }

  api.onDownloadEvent((e) => {
    const item = activeItem();
    if (!item) return;
    if (e.type === 'progress') {
      item.percent = Math.max(0, Math.min(100, e.percent));
      const parts = [formatSpeed(e.speed), e.eta !== null && e.eta !== undefined ? `faltan ${formatEta(e.eta)}` : ''].filter(Boolean);
      item.speedEta = parts.join(' · ');
    } else if (e.type === 'stage') {
      item.stage = e.label;
      if (typeof e.percent === 'number') {
        item.percent = e.percent;
        item.speedEta = '';
      }
    }
    updateActiveRow();
  });

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */
  el.url.addEventListener('input', onUrlChanged);
  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.downloadBtn.disabled && !state.busy) startDownload();
  });
  el.pasteBtn.addEventListener('click', pasteFromClipboard);
  el.dropzone.addEventListener('click', pasteFromClipboard);
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pasteFromClipboard();
    }
  });

  // Arrastrar un enlace (o texto) desde el navegador hasta la ventana.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropzone.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) el.dropzone.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('dragging');
    if (state.busy) return;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) setUrl(text.split(/\r?\n/).find((l) => l && !l.startsWith('#')) || text);
  });

  el.tabs.forEach((t) =>
    t.addEventListener('click', () => {
      if (state.busy || t.dataset.tab === tab()) return;
      update({ tab: t.dataset.tab });
      renderTabs();
      renderOptions();
      renderStatus();
    })
  );

  el.trimToggle.addEventListener('change', () => { renderTrim(); renderStatus(); });
  [el.trimStart, el.trimEnd].forEach((input) => {
    input.addEventListener('input', () => { renderTrim(); renderStatus(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !el.downloadBtn.disabled && !state.busy) startDownload();
    });
  });

  el.changeFolder.addEventListener('click', async () => {
    const dir = await api.chooseFolder(state.settings.outputDir);
    if (dir) {
      update({ outputDir: dir });
      renderFolder();
    }
  });
  el.openFolder.addEventListener('click', () => api.openFolder(state.settings.outputDir));

  el.downloadBtn.addEventListener('click', () => (state.busy ? cancelDownload() : startDownload()));
  el.clearList.addEventListener('click', () => {
    state.queue = state.queue.filter((i) => i.status === 'active');
    renderQueue();
  });

  /* ---- Configuración ---- */
  const openSettings = () => { renderSettingsModal(); el.modal.classList.remove('hidden'); el.modalClose.focus(); };
  const closeSettings = () => { el.modal.classList.add('hidden'); el.settingsBtn.focus(); };

  el.settingsBtn.addEventListener('click', openSettings);
  el.modalClose.addEventListener('click', closeSettings);
  el.modal.addEventListener('mousedown', (e) => { if (e.target === el.modal) closeSettings(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) closeSettings();
  });

  el.modal.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-item[data-value]');
    if (!btn) return;
    const key = btn.closest('[data-setting]').dataset.setting;
    update({ [key]: btn.dataset.value });
    renderSettingsModal();
  });
  el.modal.querySelectorAll('input[type="checkbox"][data-setting]').forEach((box) =>
    box.addEventListener('change', () => update({ [box.dataset.setting]: box.checked }))
  );

  el.updateBtn.addEventListener('click', async () => {
    const label = el.updateBtn.querySelector('span');
    el.updateBtn.disabled = true;
    label.textContent = 'Actualizando…';
    try {
      const { message, engineVersion } = await api.updateEngine();
      state.engineVersion = engineVersion;
      renderSettingsModal();
      toast(message || 'Motor actualizado.');
    } catch (err) {
      toast(cleanError(err), true);
    } finally {
      label.textContent = 'Actualizar';
      el.updateBtn.disabled = false;
    }
  });

  /* ------------------------------------------------------------------ */
  /* Arranque                                                            */
  /* ------------------------------------------------------------------ */
  (async () => {
    const init = await api.init();
    document.body.classList.add(`platform-${init.platform}`);
    state.settings = init.settings;
    state.engineOk = !init.engineError;
    state.appVersion = init.version;
    state.electron = init.electron;

    if (init.engineError) {
      el.engineError.textContent = init.engineError;
      el.engineError.classList.remove('hidden');
    }

    renderAll();
    // La versión del motor puede tardar la primera vez: no bloquea la interfaz.
    api.engineVersion().then((v) => {
      state.engineVersion = v || false;
      renderSettingsModal();
    });
  })();
})();
