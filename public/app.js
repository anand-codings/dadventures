const $ = (id) => document.getElementById(id);
const els = {
  prompt: $('prompt'), notes: $('notes'), enhance: $('enhance'), enhancedWrap: $('enhanced-wrap'), enhanced: $('enhanced'),
  enhanceMeta: $('enhance-meta'), useEnhanced: $('use-enhanced'), useOriginal: $('use-original'),
  model: $('model'), quality: $('quality'), preset: $('preset'), customSize: $('custom-size'), width: $('width'), height: $('height'),
  format: $('format'), background: $('background'), count: $('count'), genTags: $('gen-tags'), sizeNote: $('size-note'),
  basedOn: $('based-on'), basedOnTitle: $('based-on-title'), basedOnClear: $('based-on-clear'),
  generate: $('generate'), status: $('status'), topbar: $('topbar-meta'),
  library: $('library'), savePrompt: $('save-prompt'), deletePrompt: $('delete-prompt'),
  empty: $('empty'), figure: $('figure'), resultLink: $('result-link'), resultImg: $('result-img'), resultMeta: $('result-meta'),
  missingBanner: $('missing-banner'), related: $('related'), relatedRow: $('related-row'),
  editTitle: $('edit-title'), fav: $('fav'), editTags: $('edit-tags'), editNotes: $('edit-notes'), saveDetails: $('save-details'), detailStatus: $('detail-status'),
  resultPrompt: $('result-prompt'), resultOriginalBlock: $('result-original-block'), resultOriginal: $('result-original'),
  resultEnhanceNotesBlock: $('result-enhance-notes-block'), resultEnhanceNotes: $('result-enhance-notes'),
  copyUsed: $('copy-used'), copyOriginal: $('copy-original'), reuse: $('reuse'), download: $('download'), reveal: $('reveal'),
  del: $('delete'), restore: $('restore'), purge: $('purge'),
  gallery: $('gallery'), galleryEmpty: $('gallery-empty'), historyCount: $('history-count'),
  kindBadge: $('kind-badge'), upscaleBox: $('upscale-box'), upscaleNote: $('upscale-note'), upscaleModel: $('upscale-model'), upscaleScale: $('upscale-scale'), upscaleBtn: $('upscale'), upscaleStatus: $('upscale-status'),
  addToChar: $('add-to-char'), filterUpscaled: $('filter-upscaled'),
  charChips: $('char-chips'), newCharacter: $('new-character'), charEditor: $('char-editor'), charName: $('char-name'), charFiles: $('char-files'), charDesc: $('char-desc'), charRefs: $('char-refs'), charSave: $('char-save'), charCancel: $('char-cancel'), charDelete: $('char-delete'), charStatus: $('char-status'),
  charOutfit: $('char-outfit'), charPalette: $('char-palette'), charStyle: $('char-style'), charPersonality: $('char-personality'), charDescribe: $('char-describe'), charSheet: $('char-sheet'),
  blockPreview: $('block-preview'), blockMeta: $('block-meta'), blockText: $('block-text'),
  search: $('search'), filterModel: $('filter-model'), filterSize: $('filter-size'), sort: $('sort'), filterFav: $('filter-fav'), viewTrash: $('view-trash'), reindex: $('reindex'),
};

let config = null;
let history = [];      // all records, newest first
let library = [];
let current = null;
let basedOn = null;    // record the next generation will be linked to
let timer = null;
let characters = [];
const selectedChars = new Set();
let editingChar = null;   // null | 'new' | character object
let pendingUploads = [];  // [{ filename, dataUrl }]
const view = { q: '', model: '', size: '', sort: 'newest', fav: false, trash: false, upscaled: false };

// ---------- persistence of UI state ----------
const PREFS_KEY = 'dadventures.prefs';
const DRAFT_KEY = 'dadventures.draft';
function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadJson(PREFS_KEY), model: els.model.value, quality: els.quality.value, preset: els.preset.value, width: els.width.value, height: els.height.value, format: els.format.value, background: els.background.value, count: els.count.value, genTags: els.genTags.value }));
  syncUrl();
}
const loadJson = (key) => { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; } };
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => localStorage.setItem(DRAFT_KEY, JSON.stringify({
    prompt: els.prompt.value, notes: els.notes.value, enhanced: els.enhanced.value, enhancedVisible: !els.enhancedWrap.hidden,
    useEnhanced: els.useEnhanced.checked, enhanceMeta: els.enhanceMeta.textContent, basedOnId: basedOn?.id || null,
    characterIds: [...selectedChars],
  })), 250);
}
function restoreDraft(fromLink) {   // a link carries its own characters and "linked to" image

  const d = loadJson(DRAFT_KEY);
  if (d.prompt) els.prompt.value = d.prompt;
  if (d.notes) els.notes.value = d.notes;
  if (d.enhanced) { els.enhanced.value = d.enhanced; els.enhancedWrap.hidden = !d.enhancedVisible; els.enhanceMeta.textContent = d.enhanceMeta || ''; }
  if (d.useEnhanced === false) els.useOriginal.checked = true;
  if (fromLink) return;
  if (d.basedOnId) setBasedOn(history.find((r) => r.id === d.basedOnId) || null);
  for (const id of d.characterIds || []) if (characters.some((c) => c.id === id)) selectedChars.add(id);
  renderCharacters();
}

// ---------- URL state: the shown image, the filters and every setting live in the link ----------
// A bare "/" resumes where this browser left off. A link with parameters describes the page completely:
// anything it leaves out is at the app default, so the same link shows the same thing everywhere.
let ready = false;      // nothing is written to the URL until the page has read it
let applying = false;
const defaultUpscaler = () => (config.upscale?.local?.available ? 'realesrgan-x4plus-anime' : 'fal-seedvr2');
const genDefaults = () => ({ model: config.defaultImageModel, quality: config.defaultQuality, size: config.defaultSize, format: 'png', bg: 'auto', n: '1', tags: '' });
const pick = (sel, value, fallback) => { sel.value = [...sel.options].some((o) => o.value === value) ? value : fallback; };
function syncUrl() {
  if (!ready || applying) return;
  const custom = els.width.value && els.height.value ? `${els.width.value}x${els.height.value}` : '';
  urlState.set({
    image: current?.id, linked: basedOn?.id, chars: [...selectedChars], character: editingChar === 'new' ? 'new' : editingChar?.id,
    model: els.model.value, quality: els.quality.value, size: els.preset.value !== 'custom' ? els.preset.value : custom,
    format: els.format.value, bg: els.background.value, n: els.count.value, tags: els.genTags.value,
    q: view.q, fmodel: view.model, fsize: view.size, sort: view.sort, fav: view.fav, trash: view.trash, upscaled: view.upscaled,
    upscaler: els.upscaleModel.value, scale: els.upscaleScale.value,
  }, { defaults: { ...genDefaults(), sort: 'newest', upscaler: defaultUpscaler(), scale: '4' }, pushOn: urlState.get('image') && current ? ['image'] : [] });
}
function applyUrl() {
  if (!urlState.any()) return;
  applying = true;
  try {
    const d = genDefaults(), g = (k) => urlState.get(k) ?? d[k];
    pick(els.model, g('model'), d.model); pick(els.quality, g('quality'), d.quality); pick(els.format, g('format'), d.format); pick(els.background, g('bg'), d.bg);
    const size = g('size'), wh = /^(\d+)x(\d+)$/.exec(size);
    if (size !== 'custom' && [...els.preset.options].some((o) => o.value === size)) els.preset.value = size;
    else if (wh) { els.preset.value = 'custom'; els.width.value = wh[1]; els.height.value = wh[2]; }
    else els.preset.value = d.size;
    els.count.value = Math.min(4, Math.max(1, Math.floor(Number(g('n'))) || 1));
    els.genTags.value = g('tags');
    onPresetChange();
    const known = (key, v) => (v && history.some((r) => r[key] === v) ? v : '');
    const sort = urlState.get('sort');
    Object.assign(view, {
      q: urlState.get('q') || '', model: known('model', urlState.get('fmodel')), size: known('size', urlState.get('fsize')),
      sort: ['newest', 'oldest', 'cost', 'title'].includes(sort) ? sort : 'newest',
      fav: urlState.get('fav') === '1', trash: urlState.get('trash') === '1', upscaled: urlState.get('upscaled') === '1',
    });
    els.search.value = view.q; els.sort.value = view.sort;
    selectedChars.clear();
    for (const id of urlState.list('chars')) if (characters.some((c) => c.id === id)) selectedChars.add(id);
    setBasedOn(history.find((r) => r.id === urlState.get('linked')) || null);
    if (config.upscale?.available) {
      pick(els.upscaleModel, urlState.get('upscaler') || defaultUpscaler(), els.upscaleModel.value);
      fillSelect(els.upscaleScale, upscaleOption().scales.map((x) => ({ id: String(x), label: `×${x}` })), urlState.get('scale') || '4');
    }
    const ch = urlState.get('character'), target = ch === 'new' ? 'new' : characters.find((c) => c.id === ch) || null;
    if (target === 'new') { if (editingChar !== 'new') openCharEditor(null); }
    else if (target) { if (editingChar?.id !== target.id) openCharEditor(target); }
    else if (editingChar) closeCharEditor();
    renderCharacters(); renderGallery();
    const rec = history.find((r) => r.id === urlState.get('image')) || history.find((r) => !r.deletedAt);
    if (rec) showRecord(rec);
  } finally { applying = false; }
}

// ---------- small utils ----------
function fillSelect(sel, items, selected, keepFirst = false) {
  const first = keepFirst ? sel.options[0] : null;
  sel.innerHTML = '';
  if (first) sel.appendChild(first);
  for (const it of items) {
    const o = document.createElement('option');
    o.value = typeof it === 'string' ? it : it.id;
    o.textContent = typeof it === 'string' ? it : it.label;
    sel.appendChild(o);
  }
  if (selected != null && [...sel.options].some((o) => o.value === selected)) sel.value = selected;
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtCost = (v) => (v == null ? '' : `$${v.toFixed(3)}`);
const fmtDuration = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);
const labelOf = (rec) => rec.title || rec.originalPrompt;
function setStatus(text, kind = '') { els.status.className = `status ${kind}`; els.status.innerHTML = text; }
function setDetailStatus(text, kind = '') { els.detailStatus.className = `status ${kind}`; els.detailStatus.textContent = text; if (text) setTimeout(() => { if (els.detailStatus.textContent === text) els.detailStatus.textContent = ''; }, 3000); }
function startTimer(label) {
  const t0 = Date.now();
  clearInterval(timer);
  const tick = () => setStatus(`<span class="spinner"></span>${escapeHtml(label)} — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  tick(); timer = setInterval(tick, 1000);
}
function stopTimer() { clearInterval(timer); timer = null; }
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1200); } catch { /* ignore */ }
}
function upsert(rec) {
  const i = history.findIndex((r) => r.id === rec.id);
  if (i >= 0) history[i] = rec; else history.unshift(rec);
  if (current && current.id === rec.id) current = rec;
  if (basedOn && basedOn.id === rec.id) basedOn = rec;
}

// ---------- size handling ----------
function currentSize() { return els.preset.value !== 'custom' ? els.preset.value : `${els.width.value}x${els.height.value}`; }
function sizeProblem(size) {
  if (size === 'auto') return null;
  const m = /^(\d+)x(\d+)$/.exec(size);
  if (!m) return 'Enter both width and height.';
  const w = +m[1], h = +m[2];
  if (w % 16 || h % 16) return 'Width and height must be multiples of 16.';
  if (Math.max(w, h) > 3840) return 'Neither edge may exceed 3840 px.';
  if (Math.max(w, h) / Math.min(w, h) > 3) return 'Aspect ratio must be between 1:3 and 3:1.';
  const px = w * h;
  if (px < 655360) return 'Total pixels must be at least 655,360.';
  if (px > 8294400) return 'Total pixels must not exceed 8,294,400 (4K).';
  return null;
}
function updateSizeNote() {
  const size = currentSize();
  const problem = sizeProblem(size);
  const m = /^(\d+)x(\d+)$/.exec(size);
  const mp = m ? ((+m[1] * +m[2]) / 1e6).toFixed(1) : null;
  const exp = m && (+m[1] > 2560 || +m[2] > 2560) ? ' · above 2560 px is experimental' : '';
  els.sizeNote.textContent = problem ? `⚠ ${problem}` : mp ? `${mp} MP${exp}` : '';
  els.sizeNote.style.color = problem ? 'var(--danger)' : '';
  return !problem;
}
function onPresetChange() { els.customSize.hidden = els.preset.value !== 'custom'; updateSizeNote(); }

// ---------- lineage ----------
function setBasedOn(rec) {
  basedOn = rec;
  els.basedOn.hidden = !rec;
  els.basedOnTitle.textContent = rec ? labelOf(rec).slice(0, 80) : '';
  saveDraft(); syncUrl();
}

// ---------- detail view ----------
function thumbEl(rec, small = false) {
  const d = document.createElement('div');
  d.className = 'thumb' + (current && current.id === rec.id ? ' active' : '') + (rec.missing ? ' missing' : '') + (rec.deletedAt ? ' trashed' : '');
  d.dataset.id = rec.id;
  d.title = `${labelOf(rec)}\n${new Date(rec.createdAt).toLocaleString()} · ${rec.size} · ${rec.quality}`;
  const tags = !small && rec.tags?.length ? `<div class="tags">${rec.tags.slice(0, 3).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : '';
  const up = rec.kind === 'upscaled' ? `<span class="badge up">⬆ ×${rec.upscale?.scale || '?'} · ${rec.width && rec.height ? `${rec.width}×${rec.height}` : 'upscaled'}</span>` : '';
  const ch = rec.characters?.length ? `<span class="badge char" title="${escapeHtml(rec.characters.map((c) => c.name).join(', '))}">👤 ${rec.characters.length > 1 ? rec.characters.length : escapeHtml(rec.characters[0].name.slice(0, 14))}</span>` : '';
  d.innerHTML = `<img loading="lazy" src="${rec.thumbUrl || rec.url}" alt="">${tags}${rec.favorite ? '<span class="badge">★</span>' : ''}${up}${ch}<div class="cap">${escapeHtml(labelOf(rec))}</div>`;
  d.addEventListener('click', () => { showRecord(rec); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  return d;
}

function showRecord(rec) {
  current = rec;
  els.empty.hidden = true;
  els.figure.hidden = false;
  els.resultImg.src = rec.url;
  els.resultLink.href = rec.url;
  els.download.href = rec.url;
  els.download.download = rec.file;
  els.missingBanner.hidden = !rec.missing;
  els.editTitle.value = rec.title || '';
  els.editTags.value = (rec.tags || []).join(', ');
  els.editNotes.value = rec.notes || '';
  els.fav.textContent = rec.favorite ? '★' : '☆';
  els.fav.style.color = rec.favorite ? '#ffd166' : '';
  const parent = rec.parentId ? history.find((r) => r.id === rec.parentId) : null;
  const isUp = rec.kind === 'upscaled';
  els.kindBadge.hidden = !isUp && !rec.characters?.length;
  els.kindBadge.className = 'kind-badge' + (isUp ? '' : ' char');
  els.kindBadge.textContent = isUp ? `UPSCALED ×${rec.upscale?.scale}` : rec.characters?.length ? `👤 ${rec.characters.map((c) => c.name).join(', ')}` : '';
  const upscales = history.filter((r) => r.upscaleOf === rec.id && !r.deletedAt);
  const chips = [
    rec.model.replace('gpt-image-', 'GPT Image '),
    rec.width && rec.height ? `${rec.width} × ${rec.height}` : rec.size,
    `quality: ${rec.quality}`, rec.format,
    rec.background !== 'auto' ? `bg: ${rec.background}` : null,
    isUp ? (rec.upscale?.provider === 'fal' ? `fal.ai ≈ ${fmtCost(rec.costUsd || 0)}` : 'local, free') : rec.costUsd != null ? `≈ ${fmtCost(rec.costUsd)}` : null,
    rec.durationMs ? fmtDuration(rec.durationMs) : null,
    new Date(rec.createdAt).toLocaleString(),
    rec.deletedAt ? `in trash since ${new Date(rec.deletedAt).toLocaleString()}` : null,
  ].filter(Boolean);
  const source = isUp ? history.find((r) => r.id === rec.upscaleOf) : null;
  els.resultMeta.innerHTML = chips.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join('')
    + (isUp ? `<span class="chip up">${rec.upscale?.provider === 'fal' ? '☁' : '⬆'} ${escapeHtml(rec.upscale?.label || rec.upscale?.model || 'Real-ESRGAN')} ×${rec.upscale?.scale} from ${rec.upscale?.sourceWidth} × ${rec.upscale?.sourceHeight} in ${fmtDuration(rec.upscale?.durationMs)}</span>` : '')
    + (isUp ? (source ? `<span class="chip link" data-goto="${source.id}">↑ source: ${escapeHtml(labelOf(source).slice(0, 40))}</span>` : '<span class="chip">↑ source image no longer in history</span>') : '')
    + (!isUp && parent ? `<span class="chip link" data-goto="${parent.id}">↑ based on: ${escapeHtml(labelOf(parent).slice(0, 40))}</span>` : !isUp && rec.parentId ? '<span class="chip">↑ based on an image no longer in history</span>' : '')
    + upscales.map((u) => `<span class="chip up link" data-goto="${u.id}">⬆ upscaled ×${u.upscale?.scale} → ${u.width} × ${u.height}</span>`).join('')
    + (rec.characters || []).map((c) => `<span class="chip char">👤 ${escapeHtml(c.name)} (${c.refs} ref${c.refs === 1 ? '' : 's'})</span>`).join('');
  for (const el of els.resultMeta.querySelectorAll('[data-goto]')) el.addEventListener('click', () => { const t = history.find((r) => r.id === el.dataset.goto); if (t) showRecord(t); });
  // upscale box
  const canUpscale = config.upscale?.available && !rec.deletedAt && !rec.missing;
  els.upscaleBox.hidden = !canUpscale;
  if (canUpscale) updateUpscaleNote();
  els.addToChar.value = '';
  els.resultPrompt.textContent = rec.prompt;
  const hasOriginal = rec.originalPrompt && rec.originalPrompt !== rec.prompt;
  els.resultOriginalBlock.hidden = !hasOriginal;
  els.resultOriginal.textContent = hasOriginal ? rec.originalPrompt : '';
  els.resultEnhanceNotesBlock.hidden = !rec.enhanceNotes;
  els.resultEnhanceNotes.textContent = rec.enhanceNotes || '';
  els.del.hidden = Boolean(rec.deletedAt);
  els.restore.hidden = !rec.deletedAt;
  els.purge.hidden = !rec.deletedAt;
  els.reveal.hidden = config.platform !== 'darwin' || rec.missing;
  els.download.hidden = rec.missing;
  // related: parent, siblings (same batch or same parent), children
  const related = history.filter((r) => r.id !== rec.id && !r.deletedAt && (
    r.id === rec.parentId || r.parentId === rec.id || r.id === rec.upscaleOf || r.upscaleOf === rec.id || (rec.parentId && r.parentId === rec.parentId) || (rec.batchId && r.batchId === rec.batchId)));
  els.related.hidden = !related.length;
  els.relatedRow.innerHTML = '';
  for (const r of related.slice(0, 12)) els.relatedRow.appendChild(thumbEl(r, true));
  for (const t of els.gallery.querySelectorAll('.thumb')) t.classList.toggle('active', t.dataset.id === rec.id);
  syncUrl();
}

// ---------- gallery ----------
function visibleRecords() {
  const q = view.q.trim().toLowerCase();
  let list = history.filter((r) => Boolean(r.deletedAt) === view.trash);
  if (view.fav) list = list.filter((r) => r.favorite);
  if (view.upscaled) list = list.filter((r) => r.kind === 'upscaled');
  if (view.model) list = list.filter((r) => r.model === view.model);
  if (view.size) list = list.filter((r) => r.size === view.size);
  if (q) list = list.filter((r) => [r.title, r.originalPrompt, r.enhancedPrompt, r.prompt, r.notes, (r.tags || []).join(' '), r.file].join('\n').toLowerCase().includes(q));
  const sorters = {
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    cost: (a, b) => (b.costUsd || 0) - (a.costUsd || 0),
    title: (a, b) => labelOf(a).localeCompare(labelOf(b)),
  };
  return list.sort(sorters[view.sort] || sorters.newest);
}

function renderGallery() {
  const list = visibleRecords();
  els.gallery.innerHTML = '';
  for (const rec of list) els.gallery.appendChild(thumbEl(rec));
  els.galleryEmpty.hidden = list.length > 0;
  const active = history.filter((r) => !r.deletedAt).length, trashed = history.length - active;
  const cost = history.reduce((s, r) => s + (r.costUsd || 0), 0);
  els.historyCount.textContent = `(${view.trash ? `${list.length} in trash` : `${list.length} of ${active}`}${trashed && !view.trash ? ` · ${trashed} in trash` : ''} · total spend ≈ ${fmtCost(cost)})`;
  const models = [...new Set(history.map((r) => r.model))].sort();
  const sizes = [...new Set(history.map((r) => r.size))].sort();
  fillSelect(els.filterModel, models.map((m) => ({ id: m, label: m.replace('gpt-image-', 'GPT Image ') })), view.model, true);
  fillSelect(els.filterSize, sizes, view.size, true);
  els.filterFav.classList.toggle('on', view.fav);
  els.filterUpscaled.classList.toggle('on', view.upscaled);
  els.viewTrash.classList.toggle('on', view.trash);
  syncUrl();
}

async function loadHistory() {
  history = await api('GET', '/api/history');
  renderGallery();
}

// ---------- prompt library ----------
function renderLibrary() {
  fillSelect(els.library, library.map((p) => ({ id: p.id, label: p.name })), '', true);
  els.library.value = '';
}
async function loadLibrary() { library = await api('GET', '/api/prompts'); renderLibrary(); }
async function savePromptToLibrary() {
  const original = els.prompt.value.trim();
  if (!original) { setStatus('Enter a prompt first.', 'error'); return; }
  const name = prompt('Name for this saved prompt:', original.slice(0, 60));
  if (name === null) return;
  try {
    const entry = await api('POST', '/api/prompts', { name, original, enhanced: !els.enhancedWrap.hidden ? els.enhanced.value.trim() : null, notes: els.notes.value.trim() });
    library.unshift(entry); renderLibrary();
    setStatus(`Saved "${entry.name}" to the prompt library.`, 'ok');
  } catch (e) { setStatus(`Save failed: ${e.message}`, 'error'); }
}
function loadFromLibrary() {
  const entry = library.find((p) => p.id === els.library.value);
  if (!entry) return;
  els.prompt.value = entry.original;
  els.notes.value = entry.notes || '';
  if (entry.enhanced) { els.enhanced.value = entry.enhanced; els.enhancedWrap.hidden = false; els.useEnhanced.checked = true; els.enhanceMeta.textContent = 'from library'; }
  else { els.enhancedWrap.hidden = true; els.enhanced.value = ''; }
  saveDraft();
  setStatus(`Loaded "${entry.name}".`, 'ok');
}
async function deleteFromLibrary() {
  const entry = library.find((p) => p.id === els.library.value);
  if (!entry) { setStatus('Select a saved prompt to delete.', 'error'); return; }
  if (!confirm(`Delete saved prompt "${entry.name}"?`)) return;
  try { await api('DELETE', `/api/prompts/${entry.id}`); library = library.filter((p) => p.id !== entry.id); renderLibrary(); setStatus('Saved prompt deleted.', 'ok'); }
  catch (e) { setStatus(`Delete failed: ${e.message}`, 'error'); }
}

// ---------- actions ----------
async function enhance() {
  const prompt = els.prompt.value.trim();
  if (!prompt) { setStatus('Enter a prompt first.', 'error'); els.prompt.focus(); return; }
  els.enhance.disabled = true;
  startTimer(`Enhancing with ${config.enhanceModel}`);
  try {
    const r = await api('POST', '/api/enhance', { prompt, notes: els.notes.value.trim(), characterIds: [...selectedChars] });
    els.enhanced.value = r.enhanced;
    els.enhancedWrap.hidden = false;
    els.useEnhanced.checked = true;
    els.enhanceMeta.textContent = `${r.model} · ${fmtDuration(r.durationMs)}`;
    saveDraft();
    stopTimer();
    setStatus('Enhanced. Edit it if you like, then Generate.', 'ok');
  } catch (e) { stopTimer(); setStatus(`Enhance failed: ${e.message}`, 'error'); }
  finally { els.enhance.disabled = false; }
}

async function generate() {
  const original = els.prompt.value.trim();
  if (!original) { setStatus('Enter a prompt first.', 'error'); els.prompt.focus(); return; }
  if (!updateSizeNote()) { setStatus('Fix the size before generating.', 'error'); return; }
  const useEnhanced = !els.enhancedWrap.hidden && els.useEnhanced.checked && els.enhanced.value.trim();
  const body = {
    prompt: useEnhanced ? els.enhanced.value.trim() : original, originalPrompt: original,
    enhancedPrompt: !els.enhancedWrap.hidden && els.enhanced.value.trim() ? els.enhanced.value.trim() : null,
    enhanceNotes: els.notes.value.trim() || null,
    model: els.model.value, size: currentSize(), quality: els.quality.value, format: els.format.value,
    background: els.background.value, n: Number(els.count.value) || 1, parentId: basedOn?.id || null, tags: els.genTags.value,
    characterIds: [...selectedChars],
  };
  const charNames = characters.filter((c) => selectedChars.has(c.id)).map((c) => c.name);
  els.generate.disabled = true; els.enhance.disabled = true;
  startTimer(`Generating ${body.n > 1 ? body.n + ' images' : 'image'} at ${body.size} (${body.quality}) with ${body.model}${charNames.length ? ` · characters: ${charNames.join(', ')}` : ''}`);
  try {
    const r = await api('POST', '/api/generate', body);
    stopTimer();
    for (const rec of r.images.slice().reverse()) upsert(rec);
    showRecord(r.images[0]);
    renderGallery();
    setBasedOn(null);
    const cost = r.batchCostUsd != null ? ` · ≈ ${fmtCost(r.batchCostUsd)}` : '';
    const tokens = r.usage ? ` · ${r.usage.output_tokens} output tokens` : '';
    setStatus(`Done in ${fmtDuration(r.durationMs)}${cost}${tokens}. Saved to ${config.outputDir}`, 'ok');
    window.dvShell?.flyby?.(r.images.length > 1 ? `${r.images.length} pictures landed` : 'Fridge-worthy!');
  } catch (e) { stopTimer(); setStatus(`Generation failed: ${e.message}. Your prompts were kept in the prompt log.`, 'error'); }
  finally { els.generate.disabled = false; els.enhance.disabled = false; }
}

function reuse() {
  if (!current) return;
  els.prompt.value = current.originalPrompt;
  els.notes.value = current.enhanceNotes || '';
  if (current.enhancedPrompt) {
    els.enhanced.value = current.enhancedPrompt; els.enhancedWrap.hidden = false;
    els.useEnhanced.checked = current.prompt === current.enhancedPrompt; els.useOriginal.checked = !els.useEnhanced.checked;
    els.enhanceMeta.textContent = 'restored from history';
  } else { els.enhancedWrap.hidden = true; els.enhanced.value = ''; }
  if ([...els.model.options].some((o) => o.value === current.model)) els.model.value = current.model;
  els.quality.value = current.quality; els.format.value = current.format; els.background.value = current.background;
  els.genTags.value = (current.tags || []).join(', ');
  if ([...els.preset.options].some((o) => o.value === current.size)) els.preset.value = current.size;
  else { els.preset.value = 'custom'; const [w, h] = current.size.split('x'); els.width.value = w; els.height.value = h; }
  selectedChars.clear();
  for (const c of current.characters || []) if (characters.some((x) => x.id === c.id)) selectedChars.add(c.id);
  renderCharacters();
  onPresetChange(); savePrefs(); saveDraft();
  setBasedOn(current);
  setStatus('Prompts and settings restored. The next generation will be linked to this image.', 'ok');
  els.prompt.focus();
}

async function saveDetails() {
  if (!current) return;
  try {
    const rec = await api('PATCH', `/api/history/${current.id}`, { title: els.editTitle.value, tags: els.editTags.value, notes: els.editNotes.value });
    upsert(rec); showRecord(rec); renderGallery(); setDetailStatus('Saved.', 'ok');
  } catch (e) { setDetailStatus(`Save failed: ${e.message}`, 'error'); }
}
async function toggleFavorite() {
  if (!current) return;
  try { const rec = await api('PATCH', `/api/history/${current.id}`, { favorite: !current.favorite }); upsert(rec); showRecord(rec); renderGallery(); }
  catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}
async function trashCurrent() {
  if (!current) return;
  try { const rec = await api('DELETE', `/api/history/${current.id}`); upsert(rec); renderGallery(); showRecord(rec); setDetailStatus('Moved to trash. Restore any time from the Trash view.', 'ok'); }
  catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}
async function restoreCurrent() {
  if (!current) return;
  try { const rec = await api('POST', `/api/history/${current.id}/restore`); upsert(rec); renderGallery(); showRecord(rec); setDetailStatus('Restored.', 'ok'); }
  catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}
async function purgeCurrent() {
  if (!current) return;
  if (!confirm('Permanently delete this image and its metadata? The prompts stay in the prompt log, but the image cannot be recovered.')) return;
  try {
    await api('DELETE', `/api/history/${current.id}/permanent`);
    history = history.filter((r) => r.id !== current.id); current = null;
    els.figure.hidden = true; els.empty.hidden = false; renderGallery();
  } catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}
async function revealCurrent() {
  if (!current) return;
  try { await api('POST', `/api/history/${current.id}/reveal`); } catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}
async function reindex() {
  els.reindex.disabled = true;
  try {
    const r = await api('POST', '/api/history/reindex');
    await loadHistory();
    if (current) { const rec = history.find((x) => x.id === current.id); if (rec) showRecord(rec); }
    setStatus(`Reindexed: ${r.total} images, ${r.added} recovered from sidecars, ${r.missing} missing files, ${r.thumbsCreated} thumbnails created.`, 'ok');
  } catch (e) { setStatus(`Reindex failed: ${e.message}`, 'error'); }
  finally { els.reindex.disabled = false; }
}

// ---------- upscale ----------
const upscaleOption = () => config.upscale.options.find((x) => x.id === els.upscaleModel.value) || config.upscale.options[0];
const upscaleName = (opt) => opt.label.split(' — ')[0];
// Mirrors estimateUpscaleCost() on the server: per-megapixel or per-started-block pricing; local is free.
function estimateUpscaleCost(opt, w, h) {
  if (!opt.price || !w || !h) return 0;
  const mp = (w * h) / 1e6;
  return opt.price.perMp ? mp * opt.price.perMp : Math.ceil(mp / opt.price.blockMp) * opt.price.perBlock;
}
function fillUpscaleOptions(selected) {
  els.upscaleModel.innerHTML = '';
  const groups = [['local', 'Local — Real-ESRGAN (free)'], ['fal', 'Cloud — fal.ai (billed per output megapixel)']];
  for (const [provider, label] of groups) {
    const items = config.upscale.options.filter((o) => o.provider === provider);
    if (!items.length) continue;
    const g = document.createElement('optgroup'); g.label = label;
    for (const o of items) { const el = document.createElement('option'); el.value = o.id; el.textContent = o.label; g.appendChild(el); }
    els.upscaleModel.appendChild(g);
  }
  if (selected && [...els.upscaleModel.options].some((o) => o.value === selected)) els.upscaleModel.value = selected;
}
function updateUpscaleNote() {
  if (!current) return;
  const m = upscaleOption();
  fillSelect(els.upscaleScale, m.scales.map((s) => ({ id: String(s), label: `×${s}` })), els.upscaleScale.value || '4');
  if (!m.scales.includes(Number(els.upscaleScale.value))) els.upscaleScale.value = String(m.scales.includes(4) ? 4 : m.scales[m.scales.length - 1]);
  const s = Number(els.upscaleScale.value) || 4;
  const w = current.width, h = current.height;
  const tooBig = w && h && Math.max(w, h) * s > config.upscale.maxEdge;
  const cost = estimateUpscaleCost(m, w * s, h * s);
  const price = m.provider === 'fal' ? ` · ≈ $${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}` : ' · free';
  els.upscaleNote.textContent = w && h ? `${w} × ${h} → ${w * s} × ${h * s}${price} · ${m.hint}${tooBig ? ` (over the ${config.upscale.maxEdge} px limit)` : ''}` : '';
  els.upscaleBtn.textContent = m.provider === 'fal' ? '☁ Upscale on fal' : '⬆ Upscale';
  els.upscaleBtn.disabled = Boolean(tooBig);
  syncUrl();
}
let upTimer = null;
async function upscaleCurrent() {
  if (!current) return;
  const rec = current;
  const opt = upscaleOption();
  const model = opt.id, scale = Number(els.upscaleScale.value);
  els.upscaleBtn.disabled = true;
  const t0 = Date.now();
  clearInterval(upTimer);
  const where = opt.provider === 'fal' ? ' on fal.ai' : ' locally';
  const tick = () => { els.upscaleStatus.className = 'status'; els.upscaleStatus.innerHTML = `<span class="spinner"></span>Upscaling ×${scale} with ${escapeHtml(upscaleName(opt))}${where} — ${((Date.now() - t0) / 1000).toFixed(0)}s`; };
  tick(); upTimer = setInterval(tick, 1000);
  try {
    const out = await api('POST', `/api/history/${rec.id}/upscale`, { model, scale });
    clearInterval(upTimer);
    upsert(out); renderGallery(); showRecord(out);
    els.upscaleStatus.className = 'status ok';
    const costNote = out.upscale?.provider === 'fal' ? ` for ≈ ${fmtCost(out.costUsd)}` : '';
    setStatus(`Upscaled to ${out.width} × ${out.height} with ${escapeHtml(upscaleName(opt))} in ${fmtDuration(out.upscale.durationMs)}${costNote}. Saved as ${escapeHtml(out.file)}`, 'ok');
  } catch (e) {
    clearInterval(upTimer);
    els.upscaleStatus.className = 'status error'; els.upscaleStatus.textContent = `Upscale failed: ${e.message}`;
  } finally { els.upscaleBtn.disabled = false; }
}

// ---------- characters ----------
let blockReq = 0;
async function refreshBlockPreview() {
  const ids = [...selectedChars];
  const mine = ++blockReq;
  if (!ids.length) { els.blockPreview.hidden = true; return; }
  try {
    const r = await api('POST', '/api/characters/block', { characterIds: ids });
    if (mine !== blockReq) return;
    els.blockPreview.hidden = !r.block;
    els.blockText.textContent = r.block;
    els.blockMeta.textContent = `(${r.images} reference image${r.images === 1 ? '' : 's'} attached · ≈ $${(r.images * 0.012).toFixed(2)} input)`;
  } catch { els.blockPreview.hidden = true; }
}
function renderCharacters() {
  for (const id of [...selectedChars]) if (!characters.some((c) => c.id === id)) selectedChars.delete(id);
  refreshBlockPreview();
  els.charChips.innerHTML = '';
  if (!characters.length) els.charChips.innerHTML = '<span class="hint">No characters yet. Save one from any generated image, or create one from your own reference photos.</span>';
  for (const c of characters) {
    const chip = document.createElement('span');
    chip.className = 'char-chip' + (selectedChars.has(c.id) ? ' on' : '');
    chip.title = `${[c.description, c.outfit && `Outfit: ${c.outfit}`, c.palette && `Colors: ${c.palette}`, c.style && `Style: ${c.style}`].filter(Boolean).join('\n')}\n${c.refs.length} reference image${c.refs.length === 1 ? '' : 's'} — click to ${selectedChars.has(c.id) ? 'deselect' : 'use in the next generation'}`;
    const img = c.refs[0] ? `<img src="${c.refs[0].thumbUrl}" alt="">` : '<img alt="">';
    chip.innerHTML = `${img}<span>${escapeHtml(c.name)}</span><span class="hint">${c.refs.length}</span><span class="edit" title="Edit">✎</span>`;
    chip.querySelector('.edit').addEventListener('click', (e) => { e.stopPropagation(); openCharEditor(c); });
    chip.addEventListener('click', () => { if (selectedChars.has(c.id)) selectedChars.delete(c.id); else selectedChars.add(c.id); renderCharacters(); saveDraft(); });
    els.charChips.appendChild(chip);
  }
  // detail "add to character" select
  const keep = els.addToChar.value;
  els.addToChar.innerHTML = '<option value="">Add this image to a character…</option><option value="__new__">New character from this image…</option>';
  for (const c of characters) { const o = document.createElement('option'); o.value = c.id; o.textContent = `Add to “${c.name}”`; els.addToChar.appendChild(o); }
  els.addToChar.value = keep && [...els.addToChar.options].some((o) => o.value === keep) ? keep : '';
  syncUrl();
}
async function loadCharacters() { characters = await api('GET', '/api/characters'); renderCharacters(); }

const STORY_NOTE_FIELDS = ['loves', 'worries', 'voice', 'quirks', 'world'];
function openCharEditor(c) {
  editingChar = c || 'new';
  pendingUploads = [];
  els.charEditor.hidden = false;
  els.charName.value = c ? c.name : '';
  els.charDesc.value = c ? c.description || '' : '';
  els.charOutfit.value = c ? c.outfit || '' : '';
  els.charPalette.value = c ? c.palette || '' : '';
  els.charStyle.value = c ? c.style || '' : '';
  els.charPersonality.value = c ? c.personality || '' : '';
  for (const k of STORY_NOTE_FIELDS) document.getElementById(`char-${k}`).value = c ? c[k] || '' : '';
  document.querySelector('.char-story').open = !!c && STORY_NOTE_FIELDS.some((k) => c[k]);
  els.charFiles.value = '';
  els.charDelete.hidden = !c;
  els.charSheet.hidden = !c || !c.refs.length;
  document.getElementById('char-describe-instead').hidden = !!c;
  els.charSave.textContent = c ? 'Save changes' : 'Save character';
  els.charStatus.textContent = '';
  renderCharRefs();
  els.charName.focus();
  syncUrl();
}
function closeCharEditor() { editingChar = null; pendingUploads = []; els.charEditor.hidden = true; syncUrl(); }
const removeRefIds = new Set();
const refRoles = {};
let primaryRef = null;
function roleSelect(value) {
  const s = document.createElement('select');
  for (const [k, label] of Object.entries(config.characters.roles)) { const o = document.createElement('option'); o.value = k; o.textContent = label; s.appendChild(o); }
  s.value = config.characters.roles[value] ? value : 'identity';
  return s;
}
function renderCharRefs() {
  els.charRefs.innerHTML = '';
  removeRefIds.clear();
  for (const k of Object.keys(refRoles)) delete refRoles[k];
  primaryRef = null;
  if (editingChar && editingChar !== 'new') {
    editingChar.refs.forEach((r, i) => {
      const d = document.createElement('div'); d.className = 'ref'; d.dataset.id = r.id;
      d.innerHTML = `<img src="${r.thumbUrl}" alt="">${i === 0 ? '<span class="primary">PRIMARY</span>' : '<button type="button" class="make-primary" title="Use as the primary anchor (sent first)">make primary</button>'}<button type="button" class="rm" title="Remove">✕</button>`;
      d.querySelector('.rm').addEventListener('click', () => { removeRefIds.add(r.id); d.remove(); });
      d.querySelector('.make-primary')?.addEventListener('click', () => { primaryRef = r.id; els.charStatus.className = 'status'; els.charStatus.textContent = 'Will become the primary anchor when you save.'; });
      const sel = roleSelect(r.role); sel.title = 'What this image is for';
      sel.addEventListener('change', () => { refRoles[r.id] = sel.value; });
      d.appendChild(sel);
      els.charRefs.appendChild(d);
    });
  }
  for (const [i, u] of pendingUploads.entries()) {
    const d = document.createElement('div'); d.className = 'ref pending';
    d.innerHTML = `<img src="${u.dataUrl}" alt=""><button type="button" class="rm" title="Remove">✕</button>`;
    d.querySelector('.rm').addEventListener('click', () => { pendingUploads.splice(i, 1); renderCharRefs(); });
    const sel = roleSelect(u.role || 'identity');
    sel.addEventListener('change', () => { u.role = sel.value; });
    d.appendChild(sel);
    els.charRefs.appendChild(d);
  }
}
function charFields() {
  return { description: els.charDesc.value, outfit: els.charOutfit.value, palette: els.charPalette.value, style: els.charStyle.value, personality: els.charPersonality.value, ...Object.fromEntries(STORY_NOTE_FIELDS.map((k) => [k, document.getElementById(`char-${k}`).value])) };
}
async function describeCharacter() {
  els.charDescribe.disabled = true;
  els.charStatus.className = 'status'; els.charStatus.innerHTML = '<span class="spinner"></span>Looking at the reference images…';
  try {
    const body = { name: els.charName.value.trim(), refs: pendingUploads.slice(0, 4) };
    if (editingChar && editingChar !== 'new') body.characterId = editingChar.id;
    const d = await api('POST', '/api/characters/describe', body);
    els.charDesc.value = d.description || els.charDesc.value;
    els.charOutfit.value = d.outfit || els.charOutfit.value;
    els.charPalette.value = d.palette || els.charPalette.value;
    els.charStyle.value = d.style || els.charStyle.value;
    els.charPersonality.value = d.personality || els.charPersonality.value;
    els.charStatus.className = 'status ok'; els.charStatus.textContent = 'Filled from the references. Edit anything that is wrong, then save.';
  } catch (e) { els.charStatus.className = 'status error'; els.charStatus.textContent = `Describe failed: ${e.message}`; }
  finally { els.charDescribe.disabled = false; }
}
async function generateSheet() {
  if (!editingChar || editingChar === 'new') return;
  if (!confirm(`Generate the character sheets for “${editingChar.name}”?\n\nTwo paid pictures (about 90 seconds, ≈ $0.20–0.35): a clean turnaround sheet, added as a reference, and a detailed character bible (profile, annotated portrait, design breakdown, expressions, palette, on-model rules).`)) return;
  const c = editingChar;
  els.charSheet.disabled = true;
  const t0 = Date.now();
  const tick = () => { els.charStatus.className = 'status'; els.charStatus.innerHTML = `<span class="spinner"></span>Drawing the clean sheet, then the character bible — ${((Date.now() - t0) / 1000).toFixed(0)}s`; };
  tick(); const t = setInterval(tick, 1000);
  try {
    const r = await api('POST', `/api/characters/${c.id}/sheet`, { model: els.model.value, quality: 'high' });
    // The detailed bible follows every new sheet; if it fails the clean sheet is still kept.
    const bible = await api('POST', `/api/cards/characters/${c.id}/bible`, {}).catch((e) => ({ error: e.message }));
    clearInterval(t);
    characters = characters.map((x) => (x.id === r.character.id ? r.character : x));
    editingChar = r.character;
    upsert(r.record); if (bible.record) upsert(bible.record);
    renderGallery(); renderCharacters(); renderCharRefs();
    els.charStatus.className = bible.error ? 'status error' : 'status ok';
    els.charStatus.innerHTML = `Clean sheet added as a reference (${r.character.refs.length} now). ${bible.record ? `<a href="${bible.record.url}" target="_blank">Open the character bible</a>. Both are in your history.` : `The detailed sheet failed: ${escapeHtml(bible.error)}`}`;
  } catch (e) { clearInterval(t); els.charStatus.className = 'status error'; els.charStatus.textContent = `Sheet failed: ${e.message}`; }
  finally { els.charSheet.disabled = false; }
}
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); });
}
async function onCharFiles() {
  for (const f of els.charFiles.files) {
    if (f.size > config.characters.maxRefBytes) { els.charStatus.className = 'status error'; els.charStatus.textContent = `${f.name} is over ${Math.round(config.characters.maxRefBytes / 1048576)} MB.`; continue; }
    pendingUploads.push({ filename: f.name, dataUrl: await readFileAsDataUrl(f) });
  }
  els.charFiles.value = '';
  renderCharRefs();
}
async function saveCharacter() {
  const name = els.charName.value.trim();
  if (!name) { els.charStatus.className = 'status error'; els.charStatus.textContent = 'Name is required.'; return; }
  els.charSave.disabled = true;
  try {
    let c;
    if (editingChar === 'new') {
      if (!pendingUploads.length) { els.charStatus.className = 'status error'; els.charStatus.textContent = 'Add at least one reference image.'; return; }
      c = await api('POST', '/api/characters', { name, ...charFields(), refs: pendingUploads });
      characters.unshift(c); selectedChars.add(c.id);
    } else {
      c = await api('PATCH', `/api/characters/${editingChar.id}`, { name, ...charFields(), addRefs: pendingUploads, removeRefs: [...removeRefIds], refRoles, primaryRef });
      characters = characters.map((x) => (x.id === c.id ? c : x));
    }
    closeCharEditor(); renderCharacters(); saveDraft();
    setStatus(`Character “${c.name}” saved with ${c.refs.length} reference image${c.refs.length === 1 ? '' : 's'}.`, 'ok');
  } catch (e) { els.charStatus.className = 'status error'; els.charStatus.textContent = e.message; }
  finally { els.charSave.disabled = false; }
}
async function deleteCharacter() {
  if (!editingChar || editingChar === 'new') return;
  if (!confirm(`Delete character “${editingChar.name}” and its reference images? Images already generated with it are kept.`)) return;
  try {
    await api('DELETE', `/api/characters/${editingChar.id}`);
    characters = characters.filter((c) => c.id !== editingChar.id);
    closeCharEditor(); renderCharacters(); saveDraft();
  } catch (e) { els.charStatus.className = 'status error'; els.charStatus.textContent = e.message; }
}
async function addCurrentToCharacter() {
  const v = els.addToChar.value;
  if (!current || !v) return;
  els.addToChar.value = '';
  try {
    let c;
    if (v === '__new__') {
      const name = prompt('Character name:', current.title || '');
      if (!name) return;
      setDetailStatus('Describing the character from this image…');
      let fields = {};
      try { fields = await api('POST', '/api/characters/describe', { name, refs: [{ recordId: current.id }] }); } catch { /* fall back to empty fields */ }
      c = await api('POST', '/api/characters', { name, ...fields, refs: [{ recordId: current.id }] });
      characters.unshift(c); selectedChars.add(c.id);
      openCharEditor(c);
    } else {
      c = await api('PATCH', `/api/characters/${v}`, { addRefs: [{ recordId: current.id }] });
      characters = characters.map((x) => (x.id === c.id ? c : x));
    }
    renderCharacters(); saveDraft();
    setDetailStatus(`Added as a reference for “${c.name}” (${c.refs.length} total).`, 'ok');
  } catch (e) { setDetailStatus(`Failed: ${e.message}`, 'error'); }
}

// ---------- init ----------
async function init() {
  config = await api('GET', '/api/config');
  const prefs = loadJson(PREFS_KEY);
  // One-time: move a remembered 2.5 choice to its 2.6 counterpart (2.5 stays selectable afterwards).
  if (!prefs.model26) {
    const next = String(prefs.model || '').replace('gpt-image-2.5-', 'gpt-image-2.6-');
    if (config.imageModels.some((m) => m.id === next)) prefs.model = next;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs, model26: true }));
  }
  fillSelect(els.model, config.imageModels, prefs.model || config.defaultImageModel);
  fillSelect(els.quality, config.qualities, prefs.quality || config.defaultQuality);
  fillSelect(els.preset, [...config.sizePresets, { id: 'custom', label: 'Custom…' }], prefs.preset || config.defaultSize);
  fillSelect(els.format, config.formats, prefs.format || 'png');
  fillSelect(els.background, config.backgrounds, prefs.background || 'auto');
  if (prefs.width) els.width.value = prefs.width;
  if (prefs.height) els.height.value = prefs.height;
  if (prefs.count) els.count.value = prefs.count;
  if (prefs.genTags) els.genTags.value = prefs.genTags;
  onPresetChange();
  // The status line says what a person needs in plain words; the technical detail is in its tooltip.
  const local = config.upscale?.local?.available, fal = config.upscale?.fal?.available;
  const upscaling = local ? 'free upscaling on this Mac' : fal ? 'upscaling in the cloud' : 'upscaling not set up';
  const folder = String(config.outputDir || '').replace(/^\/(Users|home)\/[^/]+\//, '~/');
  els.topbar.textContent = config.hasApiKey ? `Saved in ${folder} · ${upscaling}` : '⚠ Add your OpenAI key to .env, then restart';
  els.topbar.title = [`Prompt helper: ${config.enhanceModel}`, `Pictures are saved in ${config.outputDir}`, `Real-ESRGAN (free, local): ${local ? 'ready' : 'not found'}`, `fal.ai (cloud): ${fal ? 'ready' : 'off, no FAL_KEY in .env'}`].join('\n');
  if (config.upscale?.available) {
    fillUpscaleOptions(prefs.upscaleModel || (config.upscale.local.available ? 'realesrgan-x4plus-anime' : 'fal-seedvr2'));
    els.upscaleModel.addEventListener('change', () => { updateUpscaleNote(); localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadJson(PREFS_KEY), upscaleModel: els.upscaleModel.value })); });
    els.upscaleScale.addEventListener('change', updateUpscaleNote);
    els.upscaleBtn.addEventListener('click', upscaleCurrent);
  }
  els.addToChar.addEventListener('change', addCurrentToCharacter);
  els.newCharacter.addEventListener('click', () => openCharEditor(null));
  els.charCancel.addEventListener('click', closeCharEditor);
  els.charSave.addEventListener('click', saveCharacter);
  els.charDelete.addEventListener('click', deleteCharacter);
  els.charFiles.addEventListener('change', onCharFiles);
  els.charDescribe.addEventListener('click', describeCharacter);
  els.charSheet.addEventListener('click', generateSheet);
  els.filterUpscaled.addEventListener('click', () => { view.upscaled = !view.upscaled; renderGallery(); });
  if (!config.hasApiKey) setStatus('OPENAI_API_KEY is not set. Copy .env.example to .env, add your key, and restart the server.', 'error');

  els.enhance.addEventListener('click', enhance);
  els.generate.addEventListener('click', generate);
  els.reuse.addEventListener('click', reuse);
  els.del.addEventListener('click', trashCurrent);
  els.restore.addEventListener('click', restoreCurrent);
  els.purge.addEventListener('click', purgeCurrent);
  els.reveal.addEventListener('click', revealCurrent);
  els.saveDetails.addEventListener('click', saveDetails);
  els.fav.addEventListener('click', toggleFavorite);
  els.reindex.addEventListener('click', reindex);
  els.basedOnClear.addEventListener('click', () => setBasedOn(null));
  els.savePrompt.addEventListener('click', savePromptToLibrary);
  els.deletePrompt.addEventListener('click', deleteFromLibrary);
  els.library.addEventListener('change', loadFromLibrary);
  els.preset.addEventListener('change', () => { onPresetChange(); savePrefs(); });
  for (const el of [els.width, els.height]) el.addEventListener('input', () => { updateSizeNote(); savePrefs(); });
  for (const el of [els.model, els.quality, els.format, els.background, els.count, els.genTags]) el.addEventListener('change', savePrefs);
  for (const el of [els.prompt, els.notes, els.enhanced]) el.addEventListener('input', saveDraft);
  for (const el of [els.useEnhanced, els.useOriginal]) el.addEventListener('change', saveDraft);
  els.copyUsed.addEventListener('click', () => copy(els.resultPrompt.textContent, els.copyUsed));
  els.copyOriginal.addEventListener('click', () => copy(els.resultOriginal.textContent, els.copyOriginal));
  els.search.addEventListener('input', () => { view.q = els.search.value; renderGallery(); });
  els.filterModel.addEventListener('change', () => { view.model = els.filterModel.value; renderGallery(); });
  els.filterSize.addEventListener('change', () => { view.size = els.filterSize.value; renderGallery(); });
  els.sort.addEventListener('change', () => { view.sort = els.sort.value; renderGallery(); });
  els.filterFav.addEventListener('click', () => { view.fav = !view.fav; renderGallery(); });
  els.viewTrash.addEventListener('click', () => { view.trash = !view.trash; renderGallery(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.generate.disabled && !['edit-notes', 'edit-title', 'edit-tags', 'char-name', 'char-desc', 'char-outfit', 'char-palette', 'char-style', 'char-personality', 'char-loves', 'char-worries', 'char-voice', 'char-quirks', 'char-world'].includes(document.activeElement?.id)) { e.preventDefault(); generate(); }
  });
  await Promise.all([loadHistory(), loadLibrary(), loadCharacters()]);
  const fromLink = urlState.any();
  restoreDraft(fromLink);
  const first = history.find((r) => !r.deletedAt);
  if (fromLink) applyUrl(); else if (first) showRecord(first);
  ready = true; syncUrl();
  urlState.onChange(applyUrl);
}

init().catch((e) => setStatus(`Failed to load: ${e.message}`, 'error'));
