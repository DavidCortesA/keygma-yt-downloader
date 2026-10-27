/* Interfaz de Kerygma Downloader. Habla con el proceso principal solo a través de window.kerygma. */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.kerygma;
  const { t } = window.i18n;

  /* ------------------------------------------------------------------ */
  /* Catálogo de opciones (lo que ofrece el panel lateral)               */
  /* ------------------------------------------------------------------ */
  const PRESETS = ['manual', 'whatsapp', 'email', 'instagram'];
  const VIDEO_FORMATS = ['mp4', 'mkv'];
  const VIDEO_QUALITIES = ['best', '1080', '720', '480'];
  const AUDIO_FORMATS = [
    { id: 'mp3', lossy: true, cover: true },
    { id: 'm4a', lossy: true, cover: true },
    { id: 'aac', lossy: true, cover: false },
    { id: 'wav', lossy: false, cover: false },
    { id: 'flac', lossy: false, cover: true },
    { id: 'opus', lossy: true, cover: true },
    { id: 'ogg', lossy: true, cover: true },
  ];
  const AUDIO_BITRATES = [128, 192, 256, 320];
  const SUBTITLES = ['none', 'es', 'en'];
  const SUB_MODES = ['embed', 'file'];

  const el = {
    url: $('url'), pasteBtn: $('pasteBtn'), urlHint: $('urlHint'),
    clipOffer: $('clipOffer'), clipUrl: $('clipUrl'), clipUse: $('clipUse'), clipDismiss: $('clipDismiss'),
    previewLoading: $('previewLoading'), preview: $('preview'),
    thumb: $('thumb'), duration: $('duration'), listBadge: $('listBadge'), title: $('title'), uploader: $('uploader'),
    previewExtra: $('previewExtra'), previewExtraText: $('previewExtraText'), previewExtraBtn: $('previewExtraBtn'),
    dropzone: $('dropzone'), queue: $('queue'),
    pageTitle: $('pageTitle'), pageSub: $('pageSub'),
    listMeta: $('listMeta'), listCount: $('listCount'), clearList: $('clearList'),
    tabs: document.querySelectorAll('.tab'),
    presetSection: $('presetSection'), presetGrid: $('presetGrid'), presetDesc: $('presetDesc'),
    formatSection: $('formatSection'), formatGrid: $('formatGrid'), formatDesc: $('formatDesc'),
    qualitySection: $('qualitySection'), qualityUnit: $('qualityUnit'), qualitySeg: $('qualitySeg'), qualityDesc: $('qualityDesc'),
    subsSection: $('subsSection'), subsSeg: $('subsSeg'), subModeSeg: $('subModeSeg'),
    audioExtras: $('audioExtras'), normalizeToggle: $('normalizeToggle'), coverToggle: $('coverToggle'), coverDesc: $('coverDesc'),
    trimSection: $('trimSection'), trimToggle: $('trimToggle'), trimFields: $('trimFields'),
    trimStart: $('trimStart'), trimEnd: $('trimEnd'), trimHint: $('trimHint'),
    folderName: $('folderName'), openFolder: $('openFolder'), changeFolder: $('changeFolder'),
    statusText: $('statusText'), downloadBtn: $('downloadBtn'), stopBtn: $('stopBtn'),
    engineError: $('engineError'), engineVersion: $('engineVersion'), updateBtn: $('updateBtn'),
    updateBanner: $('updateBanner'), updateText: $('updateText'), updateAction: $('updateAction'),
    aboutLine: $('aboutLine'),
    settingsBtn: $('settingsBtn'), modal: $('modal'), modalClose: $('modalClose'),
    historyBtn: $('historyBtn'), historyModal: $('historyModal'), historyClose: $('historyClose'),
    histSearch: $('histSearch'), histList: $('histList'), histCount: $('histCount'), histClear: $('histClear'),
    toast: $('toast'),
  };

  const state = {
    settings: null,
    info: null, // vista previa: { type: 'video'|'playlist'|'multi', ... }
    singleInfo: null, // el video original cuando se abre su lista completa
    infoRequest: 0,
    running: false,
    stopAll: false,
    batch: { done: 0, total: 0 },
    engineOk: true,
    engineVersion: null,
    appVersion: '',
    electron: '',
    appUpdate: null,
    queue: [], // { id, url, title, thumbnail, duration, platform, mode, ext, opts, status, percent, stage, ... }
    nextId: 1,
    clipSeen: '',
    history: [],
  };

  /* ------------------------------------------------------------------ */
  /* Utilidades                                                          */
  /* ------------------------------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '';
  // Filtro rápido; la validación completa (y el tipo de enlace) la hace el proceso principal.
  const looksSupported = (text) => /(youtube\.com|youtu\.be|facebook\.com|fb\.watch|tiktok\.com|instagram\.com|vimeo\.com)\//i.test(text);
  const splitLinks = (text) => [...new Set(String(text).split(/[\s,]+/).filter(looksSupported))];

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

  /** Texto de un error (los códigos "KG:..." se traducen; TOO_LONG trae segundos). */
  const errorText = (err) =>
    window.i18n.errorText(err?.message || err, (code, detail) => (code === 'TOO_LONG' ? formatDuration(Number(detail)) : detail));

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

  /** Actualiza la configuración local de inmediato y la guarda (devuelve la respuesta). */
  function update(patch) {
    const s = state.settings;
    state.settings = {
      ...s,
      ...patch,
      video: { ...s.video, ...patch.video },
      audio: { ...s.audio, ...patch.audio },
    };
    return api.saveSettings(patch);
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

  const trimAvailable = () => !state.info || state.info.type === 'video';

  /** Lee y valida el recorte. `section` es null cuando está desactivado o es inválido. */
  function readTrim() {
    if (!el.trimToggle.checked || !trimAvailable()) return { section: null, error: null };

    const duration = state.info?.duration || null;
    const startText = el.trimStart.value.trim();
    const endText = el.trimEnd.value.trim();

    const start = startText ? parseTime(startText) : 0;
    if (start === null) return { section: null, error: t('trim.err.start'), startBad: true };

    let end = endText ? parseTime(endText) : duration;
    if (endText && end === null) return { section: null, error: t('trim.err.end'), endBad: true };
    if (end === null) return { section: null, error: t('trim.err.needEnd'), endBad: true };

    if (duration && start >= duration) {
      return { section: null, error: t('trim.err.after', { d: formatDuration(duration) }), startBad: true };
    }
    if (duration && end > duration) end = duration;
    if (end - start < 1) return { section: null, error: t('trim.err.order'), endBad: true };

    return { section: { start, end }, error: null };
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  const tab = () => state.settings.tab;

  function renderTabs() {
    el.tabs.forEach((tb) => {
      const active = tb.dataset.tab === tab();
      tb.classList.toggle('active', active);
      tb.setAttribute('aria-selected', String(active));
    });
    el.pageTitle.textContent = t(`page.${tab()}.title`);
    el.pageSub.textContent = t(`page.${tab()}.sub`);
  }

  function chipButton(label, active, onClick) {
    return h('button', { class: `chip${active ? ' active' : ''}`, role: 'radio', 'aria-checked': String(active), text: label, onclick: onClick });
  }

  function segButton(label, active, onClick) {
    return h('button', { class: `seg-item${active ? ' active' : ''}`, role: 'radio', 'aria-checked': String(active), text: label, onclick: onClick });
  }

  /** Cambia una opción y vuelve a pintar el panel. */
  const setOpt = (patch) => {
    update(patch);
    renderOptions();
    renderTrim();
    renderStatus();
  };

  function renderOptions() {
    const s = state.settings;
    const isVideo = tab() === 'video';
    [el.presetGrid, el.formatGrid, el.qualitySeg, el.subsSeg, el.subModeSeg].forEach((n) => n.replaceChildren());

    el.presetSection.classList.toggle('hidden', !isVideo);
    el.subsSection.classList.toggle('hidden', !isVideo);
    el.audioExtras.classList.toggle('hidden', isVideo);

    if (isVideo) {
      const preset = s.video.preset || 'manual';
      PRESETS.forEach((p) => el.presetGrid.append(chipButton(t(`preset.${p}`), preset === p, () => setOpt({ video: { preset: p } }))));
      el.presetDesc.textContent = t(`preset.desc.${preset}`);

      // Con un destino, formato y calidad los decide el destino.
      const manual = preset === 'manual';
      el.formatSection.classList.toggle('hidden', !manual);
      el.qualitySection.classList.toggle('hidden', !manual);

      VIDEO_FORMATS.forEach((f) => el.formatGrid.append(chipButton(f.toUpperCase(), s.video.container === f, () => setOpt({ video: { container: f } }))));
      el.formatDesc.textContent = t(`fmt.${s.video.container}`);

      el.qualityUnit.textContent = '';
      VIDEO_QUALITIES.forEach((q) =>
        el.qualitySeg.append(segButton(q === 'best' ? t('q.best') : `${q}p`, String(s.video.quality) === q, () => setOpt({ video: { quality: q } })))
      );
      el.qualityDesc.textContent = t('q.video.desc');

      const subs = s.video.subtitles || 'none';
      SUBTITLES.forEach((l) => el.subsSeg.append(segButton(t(`subs.${l}`), subs === l, () => setOpt({ video: { subtitles: l } }))));
      el.subModeSeg.classList.toggle('hidden', subs === 'none');
      SUB_MODES.forEach((m) => el.subModeSeg.append(segButton(t(`subs.${m}`), (s.video.subMode || 'embed') === m, () => setOpt({ video: { subMode: m } }))));
    } else {
      el.formatSection.classList.remove('hidden');
      AUDIO_FORMATS.forEach((f) => el.formatGrid.append(chipButton(f.id.toUpperCase(), s.audio.format === f.id, () => setOpt({ audio: { format: f.id } }))));
      const fmt = AUDIO_FORMATS.find((f) => f.id === s.audio.format);
      el.formatDesc.textContent = t(`fmt.${fmt.id}`);

      el.qualitySection.classList.toggle('hidden', !fmt.lossy);
      el.qualityUnit.textContent = 'kbps';
      AUDIO_BITRATES.forEach((b) =>
        el.qualitySeg.append(segButton(String(b), Number(s.audio.bitrate) === b, () => setOpt({ audio: { bitrate: b } })))
      );
      el.qualityDesc.textContent = t('q.audio.desc');

      el.normalizeToggle.checked = !!s.audio.normalize;
      el.coverToggle.checked = fmt.cover && s.audio.cover !== false;
      el.coverToggle.disabled = !fmt.cover;
      el.coverDesc.textContent = fmt.cover ? t('cover.desc') : t('cover.na');
    }
  }

  function renderTrim() {
    el.trimSection.classList.toggle('hidden', !trimAvailable());
    const on = el.trimToggle.checked;
    el.trimFields.classList.toggle('hidden', !on);
    el.trimEnd.placeholder = state.info?.duration ? formatDuration(state.info.duration) : t('trim.end');

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
      hint = t('trim.ok', { len: formatDuration(end - start) || '0:00', a: formatDuration(start) || '0:00', b: formatDuration(end) });
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
    el.openFolder.title = t('g.openFolder', { dir });
  }

  const activeItem = () => state.queue.find((i) => i.status === 'active');
  const pendingCount = () => state.queue.filter((i) => i.status === 'queued' || i.status === 'active').length;

  /** Cuántos videos agrega el botón principal con la vista previa actual. */
  function previewCount() {
    if (!state.info) return 0;
    return state.info.type === 'video' ? 1 : state.info.count;
  }

  function renderStatus() {
    const trim = readTrim();
    const info = state.info;
    let text;
    if (!state.engineOk) text = t('status.engine');
    else if (state.running && !info) {
      const done = state.batch.total - pendingCount();
      text = t('status.running', { i: Math.min(done + 1, state.batch.total), n: state.batch.total });
    } else if (!el.url.value.trim()) text = t('status.empty');
    else if (!info) text = el.previewLoading.classList.contains('hidden') ? t('status.waiting') : t('status.searching');
    else if (trim.error) text = trim.error;
    else if (info.type === 'playlist') text = t('status.playlist', { n: info.count });
    else if (info.type === 'multi') text = t('status.multi', { n: info.count });
    else if (trim.section) text = t('status.fragment', { d: formatDuration(trim.section.end - trim.section.start) });
    else text = info.duration ? `${t('status.ready')} · ${formatDuration(info.duration)}` : t('status.ready');
    el.statusText.textContent = text;

    const count = previewCount();
    let label;
    if (state.running && info) label = t('btn.addQueue');
    else if (count > 1) label = t('btn.downloadN', { n: count });
    else label = t(`page.${tab()}.button`);
    el.downloadBtn.textContent = label;
    el.downloadBtn.disabled = !(state.engineOk && info && count > 0 && !trim.error);
    el.stopBtn.classList.toggle('hidden', !state.running);
  }

  function renderLeft() {
    const hasQueue = state.queue.length > 0;
    const loading = !el.previewLoading.classList.contains('hidden');
    el.preview.classList.toggle('hidden', !state.info);
    el.dropzone.classList.toggle('hidden', !!state.info || loading || hasQueue);
    el.queue.classList.toggle('hidden', !hasQueue);
    el.listMeta.classList.toggle('hidden', !hasQueue);
    el.listCount.textContent = t('list.count', { n: state.queue.length });
    el.clearList.disabled = state.queue.every((i) => i.status === 'active' || i.status === 'queued');
  }

  function stageText(item) {
    const preset = item.stagePreset ? t(`preset.${item.stagePreset}`) : '';
    return t(`stage.${item.stage || 'prepare'}`, { format: (item.stageFormat || '').toUpperCase(), preset });
  }

  // Se arma al pintar (no al recibir el evento) para que un cambio de idioma se vea al instante.
  function activeMeta(item) {
    const { speed, eta } = item.rate || {};
    const left = eta !== null && eta !== undefined ? t('item.left', { t: formatEta(eta) }) : '';
    return [stageText(item), item.rate && formatSpeed(speed), left].filter(Boolean).join(' · ');
  }

  function itemMeta(item) {
    if (item.status === 'active') return h('div', { class: 'item-meta', text: activeMeta(item) });
    if (item.status === 'queued') return h('div', { class: 'item-meta', text: [item.platform, formatDuration(item.duration)].filter(Boolean).join(' · ') || item.url });
    if (item.status === 'done') {
      return h('div', { class: 'item-meta' }, `${t('item.savedIn')} `, h('b', { text: item.folder }), item.size ? ` · ${formatSize(item.size)}` : '');
    }
    if (item.status === 'error') return h('div', { class: 'item-meta', text: errorText(item.error) });
    return h('div', { class: 'item-meta', text: t('item.noFile') });
  }

  function itemPill(item) {
    if (item.status === 'active') return h('span', { class: 'pill accent', text: `${Math.floor(item.percent)}%` });
    if (item.status === 'queued') return h('span', { class: 'pill', text: t('item.queued') });
    if (item.status === 'done') return h('span', { class: 'pill ok', text: t('item.done') });
    if (item.status === 'error') return h('span', { class: 'pill err', text: t('item.error') });
    return h('span', { class: 'pill', text: t('item.cancelled') });
  }

  function renderItem(item) {
    const actions = h('div', { class: 'item-actions' }, itemPill(item));
    if (item.status === 'done') {
      actions.append(h('button', { class: 'mini-btn', title: t('item.show'), 'aria-label': t('item.show'), onclick: () => api.showItem(item.filePath) }, icon('folder')));
    }
    if (item.status === 'active') {
      actions.append(h('button', { class: 'mini-btn', title: t('item.cancel'), 'aria-label': t('item.cancel'), onclick: cancelCurrent }, icon('x')));
    } else {
      actions.append(h('button', {
        class: 'mini-btn', title: t('item.remove'), 'aria-label': t('item.remove'),
        onclick: () => { state.queue = state.queue.filter((i) => i !== item); renderQueue(); },
      }, icon('x')));
    }

    const name = item.status === 'done' ? basename(item.filePath) : item.title || item.url;
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
    const name = item.title || item.url;
    li.querySelector('.item-name').textContent = name;
    li.querySelector('.pill').textContent = `${Math.floor(item.percent)}%`;
    li.querySelector('.item-meta').textContent = activeMeta(item);
    li.querySelector('.bar-fill').style.width = `${item.percent}%`;
    renderStatus();
  }

  function renderPreview() {
    const info = state.info;
    if (!info) return;
    el.listBadge.classList.toggle('hidden', info.type === 'video');
    el.duration.classList.toggle('hidden', info.type !== 'video' || !info.duration);
    el.previewExtra.classList.add('hidden');
    el.thumb.classList.toggle('hidden', !info.thumbnail);
    if (info.thumbnail) el.thumb.src = info.thumbnail;
    else el.thumb.removeAttribute('src');

    if (info.type === 'video') {
      el.title.textContent = info.title;
      el.uploader.textContent = [info.platform, info.uploader].filter(Boolean).join(' · ');
      el.duration.textContent = formatDuration(info.duration);
      if (info.listUrl) {
        el.previewExtraText.textContent = t('preview.list');
        el.previewExtraBtn.textContent = t('preview.listLoad');
        el.previewExtra.classList.remove('hidden');
      }
    } else if (info.type === 'playlist') {
      el.title.textContent = info.title;
      el.uploader.textContent = [t('preview.playlist', { n: info.count }), info.uploader].filter(Boolean).join(' · ');
      if (state.singleInfo) {
        el.previewExtraText.textContent = '';
        el.previewExtraBtn.textContent = t('preview.single');
        el.previewExtra.classList.remove('hidden');
      }
    } else {
      el.title.textContent = t('preview.multi', { n: info.count });
      el.uploader.textContent = info.sites.join(' · ');
      el.previewExtraText.textContent = t('preview.multiSub');
      el.previewExtraBtn.textContent = '';
      el.previewExtra.classList.remove('hidden');
    }
    el.previewExtraBtn.classList.toggle('hidden', !el.previewExtraBtn.textContent);
  }

  function renderSettingsModal() {
    const s = state.settings;
    el.modal.querySelectorAll('[data-setting]').forEach((node) => {
      const key = node.dataset.setting;
      if (node.matches('input[type="checkbox"]')) node.checked = !!s[key];
      else node.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b.dataset.value === s[key]));
    });
    el.engineVersion.textContent = state.engineVersion || (state.engineVersion === null ? '…' : t('s.engine.unavailable'));
    el.aboutLine.textContent = t('s.version', { v: state.appVersion, e: state.engineVersion || '…', el: state.electron });
  }

  function renderUpdateBanner() {
    const u = state.appUpdate;
    el.updateBanner.classList.toggle('hidden', !u);
    if (!u) return;
    el.updateText.textContent = t(u.ready ? 'update.ready' : 'update.available', { v: u.version });
    el.updateAction.textContent = t(u.ready ? 'update.install' : 'update.download');
  }

  function renderAll() {
    window.i18n.applyStatic();
    renderTabs();
    renderOptions();
    renderTrim();
    renderFolder();
    renderPreview();
    renderQueue();
    renderUpdateBanner();
    if (!el.historyModal.classList.contains('hidden')) renderHistory();
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
    state.singleInfo = null;
    el.previewLoading.classList.add('hidden');
    renderLeft();
    renderTrim();
    renderStatus();
  }

  function showInfo(info) {
    state.info = info;
    el.previewLoading.classList.add('hidden');
    renderPreview();
    renderLeft();
    renderTrim();
    renderStatus();
  }

  async function fetchInfo(url, opts) {
    const request = ++state.infoRequest;
    el.previewLoading.classList.remove('hidden');
    el.preview.classList.add('hidden');
    renderLeft();
    renderStatus();
    setHint('');

    try {
      const info = await api.getInfo(url, opts);
      if (request !== state.infoRequest) return; // llegó una respuesta vieja
      if (state.info?.id !== info.id) {
        el.trimStart.value = '';
        el.trimEnd.value = '';
      }
      showInfo(info);
    } catch (err) {
      if (request !== state.infoRequest) return;
      clearPreview();
      setHint(errorText(err), true);
    }
  }

  let debounce = null;
  function onUrlChanged() {
    const text = el.url.value.trim();
    clearTimeout(debounce);
    state.infoRequest += 1; // invalida peticiones en curso
    clearPreview();

    if (!text) return setHint('');
    const links = splitLinks(text);
    if (!links.length) return setHint(t('url.notSupported'), true);
    setHint('');

    if (links.length > 1) {
      // Varios enlaces: cada uno se resuelve al llegar su turno en la cola.
      const sites = [...new Set(links.map((l) => /youtu/i.test(l) ? 'YouTube' : /facebook|fb\.watch/i.test(l) ? 'Facebook' : /tiktok/i.test(l) ? 'TikTok' : /instagram/i.test(l) ? 'Instagram' : 'Vimeo'))];
      return showInfo({ type: 'multi', count: links.length, links, sites, thumbnail: null });
    }
    debounce = setTimeout(() => fetchInfo(links[0]), 450);
  }

  function setUrl(text) {
    el.url.value = text.trim();
    state.clipSeen = el.url.value;
    hideClipOffer();
    onUrlChanged();
  }

  async function pasteFromClipboard() {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return toast(t('toast.clipEmpty'), true);
      setUrl(text);
    } catch {
      toast(t('toast.clipFail'), true);
    }
    el.url.focus();
  }

  /* ---- Enlace copiado: se ofrece al volver a la app ---- */
  function hideClipOffer() {
    el.clipOffer.classList.add('hidden');
  }

  async function checkClipboard() {
    if (!state.settings?.watchClipboard || document.hidden) return;
    const text = await api.clipboardLink().catch(() => '');
    if (!text || text === state.clipSeen || text === el.url.value.trim()) return;
    const links = splitLinks(text);
    if (!links.length) return;
    el.clipUrl.textContent = links.length > 1 ? `${links[0]}  (+${links.length - 1})` : links[0];
    el.clipUrl.title = links.join('\n');
    el.clipOffer.dataset.text = text;
    el.clipOffer.classList.remove('hidden');
  }

  /* ------------------------------------------------------------------ */
  /* Cola de descargas                                                   */
  /* ------------------------------------------------------------------ */
  /** Opciones con las que se descargará lo que se agrega ahora (cambiarlas después no lo afecta). */
  function snapshotOptions() {
    const s = state.settings;
    const mode = tab();
    const preset = mode === 'video' ? s.video.preset || 'manual' : 'manual';
    const ext = mode === 'audio' ? s.audio.format : preset !== 'manual' ? 'mp4' : s.video.container;
    return {
      mode,
      ext: ext.toUpperCase(),
      outputDir: s.outputDir,
      video: { ...s.video },
      audio: { ...s.audio, cover: s.audio.cover !== false },
      folder: basename(s.outputDir) || s.outputDir,
    };
  }

  function makeItem(entry, opts, section = null) {
    return {
      id: state.nextId++,
      url: entry.url,
      title: entry.title || '',
      thumbnail: entry.thumbnail || '',
      duration: entry.duration || null,
      platform: entry.platform || '',
      needsInfo: !!entry.needsInfo,
      mode: opts.mode,
      ext: opts.ext,
      opts,
      section,
      status: 'queued',
      percent: 0,
      stage: 'prepare',
      rate: null,
      folder: opts.folder,
    };
  }

  function enqueue() {
    const info = state.info;
    if (!info) return;
    const { section, error } = readTrim();
    if (error) return toast(error, true);

    const opts = snapshotOptions();
    let items;
    if (info.type === 'video') {
      items = [makeItem({ url: splitLinks(el.url.value)[0], ...info }, opts, section)];
    } else if (info.type === 'playlist') {
      items = info.entries.map((e) => makeItem({ ...e, platform: info.platform }, opts));
    } else {
      items = info.links.map((url) => makeItem({ url, needsInfo: true }, opts));
    }

    state.queue.push(...items);
    if (state.running) state.batch.total += items.length;
    if (items.length > 1) toast(t('toast.queued', { n: items.length }));

    // El campo queda libre para el siguiente enlace.
    el.url.value = '';
    el.trimToggle.checked = false;
    clearPreview();
    setHint('');
    renderTrim();
    renderQueue();
    processQueue();
  }

  async function processQueue() {
    if (state.running) return;
    state.running = true;
    state.stopAll = false;
    state.batch = { done: 0, total: state.queue.filter((i) => i.status === 'queued').length };
    renderStatus();

    let item;
    while (!state.stopAll && (item = state.queue.find((i) => i.status === 'queued'))) {
      Object.assign(item, { status: 'active', percent: 0, stage: 'prepare', rate: null });
      renderQueue();
      try {
        if (item.needsInfo) {
          item.stage = 'info';
          updateActiveRow();
          const info = await api.getInfo(item.url);
          if (info.type === 'playlist') {
            // Un enlace de lista dentro de varios enlaces: se reemplaza por sus videos.
            const idx = state.queue.indexOf(item);
            const entries = info.entries.map((e) => makeItem({ ...e, platform: info.platform }, item.opts));
            state.queue.splice(idx, 1, ...entries);
            state.batch.total += entries.length - 1;
            renderQueue();
            continue;
          }
          Object.assign(item, { title: info.title, thumbnail: info.thumbnail || '', duration: info.duration, platform: info.platform, needsInfo: false });
          renderQueue();
        }
        const more = state.queue.some((i) => i !== item && i.status === 'queued');
        const result = await api.startDownload({
          url: item.url,
          title: item.title,
          thumbnail: item.thumbnail,
          duration: item.duration || undefined,
          mode: item.mode,
          outputDir: item.opts.outputDir,
          video: item.opts.video,
          audio: item.opts.audio,
          section: item.section,
          silent: more, // en una tanda, avisa solo al terminar la última
        });
        if (result?.cancelled) {
          item.status = 'cancelled';
        } else {
          Object.assign(item, { status: 'done', filePath: result.filePath, size: result.size, percent: 100 });
          state.batch.done += 1;
        }
      } catch (err) {
        item.status = 'error';
        item.error = err?.message || String(err);
      }
      renderQueue();
    }

    if (state.stopAll) state.queue.forEach((i) => { if (i.status === 'queued') i.status = 'cancelled'; });
    state.running = false;
    if (state.batch.total > 1 && state.batch.done) toast(t('toast.done', { n: state.batch.done }));
    renderQueue();
    if (!el.historyModal.classList.contains('hidden')) loadHistory();
  }

  function cancelCurrent() {
    const item = activeItem();
    if (item) {
      item.stage = 'cancelling';
      item.rate = null;
      updateActiveRow();
    }
    api.cancelDownload();
  }

  function stopAll() {
    state.stopAll = true;
    state.queue.forEach((i) => { if (i.status === 'queued') i.status = 'cancelled'; });
    cancelCurrent();
    renderQueue();
  }

  api.onDownloadEvent((e) => {
    const item = activeItem();
    if (!item) return;
    if (e.type === 'progress') {
      item.percent = Math.max(0, Math.min(100, e.percent));
      item.rate = { speed: e.speed, eta: e.eta };
    } else if (e.type === 'stage') {
      item.stage = e.stage;
      item.stageFormat = e.format;
      item.stagePreset = e.preset;
      if (typeof e.percent === 'number') {
        item.percent = e.percent;
        item.rate = null;
      }
    }
    updateActiveRow();
  });

  /* ------------------------------------------------------------------ */
  /* Historial                                                           */
  /* ------------------------------------------------------------------ */
  const dateFormat = () => new Intl.DateTimeFormat(window.i18n.lang, { dateStyle: 'medium', timeStyle: 'short' });

  async function loadHistory() {
    state.history = await api.historyList().catch(() => []);
    renderHistory();
  }

  function renderHistory() {
    const q = el.histSearch.value.trim().toLowerCase();
    const all = state.history;
    const list = q ? all.filter((e) => `${e.title} ${e.platform} ${e.url}`.toLowerCase().includes(q)) : all;
    const fmt = dateFormat();

    el.histCount.textContent = t('hist.count', { n: all.length });
    el.histClear.disabled = !all.length;
    if (!list.length) {
      el.histList.replaceChildren(h('li', { class: 'hist-empty', text: all.length ? t('hist.noMatch') : t('hist.empty') }));
      return;
    }
    el.histList.replaceChildren(...list.map((e) => {
      const meta = [e.platform, fmt.format(new Date(e.date)), e.ext, formatSize(e.size)].filter(Boolean).join(' · ');
      const tile = e.thumbnail
        ? h('div', { class: 'item-tile thumb' }, h('img', { src: e.thumbnail, alt: '', draggable: 'false', onerror: (ev) => ev.target.remove() }), h('span', { class: 'tile-badge', text: e.ext }))
        : h('div', { class: 'item-tile', text: e.ext });
      const actions = h('div', { class: 'item-actions' });
      if (e.exists) actions.append(h('button', { class: 'mini-btn', title: t('item.show'), 'aria-label': t('item.show'), onclick: () => api.showItem(e.filePath) }, icon('folder')));
      if (e.url) {
        actions.append(h('button', {
          class: 'mini-btn', title: t('hist.redownload'), 'aria-label': t('hist.redownload'),
          onclick: () => { closeHistory(); setUrl(e.url); },
        }, icon('download')));
      }
      actions.append(h('button', {
        class: 'mini-btn', title: t('item.remove'), 'aria-label': t('item.remove'),
        onclick: async () => { await api.historyRemove(e.id); loadHistory(); },
      }, icon('x')));
      return h('li', { class: `hist-item${e.exists ? '' : ' missing'}` },
        tile,
        h('div', { class: 'item-body' },
          h('div', { class: 'item-name', title: e.title, text: e.title || basename(e.filePath) }),
          h('div', { class: 'item-meta', text: e.exists ? meta : `${meta} · ${t('hist.missing')}` })),
        actions);
    }));
  }

  function openHistory() {
    el.histSearch.value = '';
    el.historyModal.classList.remove('hidden');
    loadHistory();
    el.histSearch.focus();
  }
  const closeHistory = () => { el.historyModal.classList.add('hidden'); el.historyBtn.focus(); };

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */
  el.url.addEventListener('input', onUrlChanged);
  el.url.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.downloadBtn.disabled) enqueue();
  });
  el.pasteBtn.addEventListener('click', pasteFromClipboard);
  el.dropzone.addEventListener('click', pasteFromClipboard);
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pasteFromClipboard();
    }
  });

  el.previewExtraBtn.addEventListener('click', () => {
    const info = state.info;
    if (info?.type === 'video' && info.listUrl) {
      state.singleInfo = info;
      fetchInfo(splitLinks(el.url.value)[0], { playlist: true }).then(() => {
        if (state.info?.type === 'playlist') state.singleInfo = info;
        renderPreview();
      });
    } else if (info?.type === 'playlist' && state.singleInfo) {
      const single = state.singleInfo;
      state.singleInfo = null;
      showInfo(single);
    }
  });

  el.clipUse.addEventListener('click', () => setUrl(el.clipOffer.dataset.text || ''));
  el.clipDismiss.addEventListener('click', () => {
    state.clipSeen = el.clipOffer.dataset.text || '';
    hideClipOffer();
  });
  window.addEventListener('focus', checkClipboard);

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
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) setUrl(text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).join('\n') || text);
  });

  el.tabs.forEach((tb) =>
    tb.addEventListener('click', () => {
      if (tb.dataset.tab === tab()) return;
      update({ tab: tb.dataset.tab });
      renderTabs();
      renderOptions();
      renderStatus();
    })
  );

  el.normalizeToggle.addEventListener('change', () => setOpt({ audio: { normalize: el.normalizeToggle.checked } }));
  el.coverToggle.addEventListener('change', () => setOpt({ audio: { cover: el.coverToggle.checked } }));

  el.trimToggle.addEventListener('change', () => { renderTrim(); renderStatus(); });
  [el.trimStart, el.trimEnd].forEach((input) => {
    input.addEventListener('input', () => { renderTrim(); renderStatus(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !el.downloadBtn.disabled) enqueue();
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

  el.downloadBtn.addEventListener('click', enqueue);
  el.stopBtn.addEventListener('click', stopAll);
  el.clearList.addEventListener('click', () => {
    state.queue = state.queue.filter((i) => i.status === 'active' || i.status === 'queued');
    renderQueue();
  });

  el.updateAction.addEventListener('click', () => api.installUpdate());

  /* ---- Historial ---- */
  el.historyBtn.addEventListener('click', openHistory);
  el.historyClose.addEventListener('click', closeHistory);
  el.historyModal.addEventListener('mousedown', (e) => { if (e.target === el.historyModal) closeHistory(); });
  el.histSearch.addEventListener('input', renderHistory);
  el.histClear.addEventListener('click', async () => {
    if (!window.confirm(t('hist.clearConfirm'))) return;
    await api.historyClear();
    loadHistory();
  });

  /* ---- Configuración ---- */
  const openSettings = () => { renderSettingsModal(); el.modal.classList.remove('hidden'); el.modalClose.focus(); };
  const closeSettings = () => { el.modal.classList.add('hidden'); el.settingsBtn.focus(); };

  el.settingsBtn.addEventListener('click', openSettings);
  el.modalClose.addEventListener('click', closeSettings);
  el.modal.addEventListener('mousedown', (e) => { if (e.target === el.modal) closeSettings(); });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.modal.classList.contains('hidden')) closeSettings();
    else if (!el.historyModal.classList.contains('hidden')) closeHistory();
  });

  el.modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('.seg-item[data-value]');
    if (!btn) return;
    const key = btn.closest('[data-setting]').dataset.setting;
    const pending = update({ [key]: btn.dataset.value });
    renderSettingsModal();
    if (key === 'language') {
      const { language } = await pending;
      window.i18n.setLanguage(language);
      renderAll();
      renderSettingsModal();
    }
  });
  el.modal.querySelectorAll('input[type="checkbox"][data-setting]').forEach((box) =>
    box.addEventListener('change', () => update({ [box.dataset.setting]: box.checked }))
  );

  el.updateBtn.addEventListener('click', async () => {
    const label = el.updateBtn.querySelector('span');
    el.updateBtn.disabled = true;
    label.textContent = t('s.engine.updating');
    try {
      const { engineVersion, changed } = await api.updateEngine();
      state.engineVersion = engineVersion;
      renderSettingsModal();
      toast(t(changed ? 'toast.engineUpdated' : 'toast.engineLatest', { v: engineVersion || '' }));
    } catch (err) {
      toast(errorText(err), true);
    } finally {
      label.textContent = t('s.engine.update');
      el.updateBtn.disabled = false;
    }
  });

  api.onEngineUpdated(({ engineVersion }) => {
    state.engineVersion = engineVersion;
    renderSettingsModal();
    toast(t('toast.engineUpdated', { v: engineVersion }));
  });

  api.onAppUpdate((u) => {
    state.appUpdate = u;
    renderUpdateBanner();
  });

  /* ------------------------------------------------------------------ */
  /* Arranque                                                            */
  /* ------------------------------------------------------------------ */
  (async () => {
    const init = await api.init();
    document.body.classList.add(`platform-${init.platform}`);
    window.i18n.setLanguage(init.language);
    state.settings = init.settings;
    state.engineOk = !init.engineError;
    state.appVersion = init.version;
    state.electron = init.electron;
    state.appUpdate = init.appUpdate;

    if (init.engineError) {
      el.engineError.textContent = init.engineError;
      el.engineError.classList.remove('hidden');
    }

    renderAll();
    checkClipboard();
    // La versión del motor puede tardar la primera vez: no bloquea la interfaz.
    api.engineVersion().then((v) => {
      state.engineVersion = v || false;
      renderSettingsModal();
    });
  })();
})();
