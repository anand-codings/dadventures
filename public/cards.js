// Flash Cards page: Library (analyze existing cards) → Templates → Series (plan, write, illustrate, print).
const $ = (id) => document.getElementById(id);
const els = {
  topbar: $('topbar-meta'), tabs: $('tabs'),
  libSummary: $('lib-summary'), analyzeNew: $('analyze-new'), libFilter: $('lib-filter'), libSearch: $('lib-search'), selCount: $('sel-count'), selNone: $('sel-none'),
  tplInstructions: $('tpl-instructions'), makeTemplate: $('make-template'), analyzeSelected: $('analyze-selected'), suggestGroups: $('suggest-groups'),
  tplList: $('tpl-list'),
  seriesSelect: $('series-select'), newSeries: $('new-series'), deleteSeries: $('delete-series'), template: $('template'), styleTemplate: $('style-template'),
  premise: $('premise'), premiseLabel: $('premise-label'), topics: $('topics'), lesson: $('lesson'), foundation: $('foundation'), editorNotes: $('editor-notes'), logic: $('logic'), checkLogic: $('check-logic'), world: $('world'), audience: $('audience'), cardCount: $('card-count'), tone: $('tone'), notes: $('notes'), briefChars: $('brief-chars'),
  artSummary: $('art-summary'), imgModel: $('img-model'), imgQuality: $('img-quality'), imgSize: $('img-size'), textMode: $('text-mode'), redrawAll: $('redraw-all'), proof: $('proof'), draftAll: $('draft-all'), extras: $('extras'), makePlaces: $('make-places'), makeExtras: $('make-extras'), tidy: $('tidy'), useTemplateRef: $('use-template-ref'), chain: $('chain'), badge: $('badge'),
  stepper: $('stepper'), flowRow: $('flow-row'), next: $('next'), stop: $('stop'), upscale: $('upscale'), saveState: $('save-state'), status: $('status'), strip: $('strip'),
  progress: $('progress'), progressPhase: $('progress-phase'), progressTime: $('progress-time'), progressBar: $('progress-bar'), progressSnippet: $('progress-snippet'),
  viewLibrary: $('view-library'), groups: $('groups'), detail: $('detail'), library: $('library'), viewTemplates: $('view-templates'), viewSeries: $('view-series'),
  seriesEmpty: $('series-empty'), series: $('series'), title: $('title'), logline: $('logline'), styleGuide: $('style-guide'), storyBox: $('story-box'), spine: $('spine'), refrain: $('refrain'), hiddenFriend: $('hidden-friend'), script: $('script'), planInstructions: $('plan-instructions'), replan: $('replan'),
  addCast: $('add-cast'), cast: $('cast'), cardsMeta: $('cards-meta'), cards: $('cards'), addCard: $('add-card'),
};

let config = null;
let tab = 'library';
let sources = [];                 // library image groups
const images = new Map();         // image id → library image
const selected = new Set();       // selected library image ids
let groups = null;                // suggested template families
let templates = [];
let tpl = null;                   // template open in the editor
let seriesList = [];
let series = null;
let characters = [];
const briefChars = new Set();
const records = new Map();        // history records by id
let busy = false;
let stopRequested = false;
const LAST_SERIES = 'dadventures.lastCardSeries';
const LAST_TAB = 'dadventures.cardsTab';

// ---------- utils (same conventions as books.js) ----------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtCost = (v) => (v == null ? '' : `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);
const words = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
function setStatus(text, kind = '') { els.status.className = `status ${kind}`; els.status.innerHTML = text; }
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
async function streamApi(path, body, onProgress) {
  const res = await fetch(`${path}?stream=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', result;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.progress) onProgress(m.progress);
      else if (m.error) throw new Error(m.error);
      else if ('done' in m) result = m.done;
    }
  }
  if (result === undefined) throw new Error('The connection closed before the result arrived.');
  return result;
}
function fillSelect(sel, items, value) {
  sel.innerHTML = '';
  for (const it of items) { const o = document.createElement('option'); o.value = typeof it === 'string' ? it : it.id; o.textContent = typeof it === 'string' ? it : it.label; sel.appendChild(o); }
  if (value != null && [...sel.options].some((o) => o.value === value)) sel.value = value;
}
const archetypeLabel = (id) => (id || '').replace(/-/g, ' ');
const thumbOf = (imageId) => images.get(imageId)?.thumbUrl || '';
const recThumb = (id) => { const r = records.get(id); return r ? r.thumbUrl || r.url : ''; };
function estimateImageCost(model, size, quality) {
  const same = [...records.values()].filter((r) => r.kind === 'generated' && r.model === model && r.size === size && r.quality === quality && r.costUsd);
  return same.length ? same.reduce((s, r) => s + r.costUsd, 0) / same.length : null;
}

// ---------- progress ----------
let progTimer = null;
function showProgress(label) {
  const t0 = Date.now();
  els.progress.hidden = false;
  els.progressPhase.textContent = label; els.progressSnippet.textContent = ''; els.progressBar.style.width = '0%'; els.progressBar.parentElement.hidden = true;
  clearInterval(progTimer);
  const tick = () => { els.progressTime.textContent = `${Math.round((Date.now() - t0) / 1000)}s`; };
  tick(); progTimer = setInterval(tick, 1000);
  setStatus('');
  return (p) => {
    if (p.phase) els.progressPhase.textContent = p.phase;
    els.progressSnippet.textContent = p.snippet ? `“${p.snippet}”` : '';
    if (p.total) { els.progressBar.parentElement.hidden = false; els.progressBar.style.width = `${Math.round((100 * (p.done || 0)) / p.total)}%`; }
  };
}
function hideProgress() { clearInterval(progTimer); els.progress.hidden = true; }
// Run one long action at a time; errors land in the status line.
async function run(label, fn) {
  if (busy) return;
  busy = true; refreshButtons();
  const onProgress = showProgress(label);
  try { await fn(onProgress); }
  catch (e) { setStatus(escapeHtml(e.message), 'error'); }
  finally { busy = false; hideProgress(); refreshButtons(); }
}

// ---------- URL state: the tab, the open series and template, the library filter and a card all have their own link ----------
// A bare /cards.html reopens the last tab and series. A link with parameters says exactly what is open.
let ready = false, started = false, applying = false;
let focusCard = null;             // card number the link points at
function syncUrl() {
  if (!ready || applying) return;
  urlState.set(
    { tab, series: series?.id, template: tpl?.id, filter: els.libFilter.value, q: els.libSearch.value.trim(), detail: els.detail.hidden ? '' : els.detail.dataset.id, card: series ? focusCard : '' },
    { pushOn: started ? ['tab', 'series', 'template'] : [] });
}
const goToCard = (id) => document.querySelector(`.page-card[data-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
async function applyUrl(first = false) {
  applying = true;
  try {
    const want = urlState.get('series'), sid = seriesList.some((x) => x.id === want) ? want : '';
    if (first || (series?.id || '') !== sid) { await openSeries(sid); if (!sid) onTemplateChosen(); }
    const tid = urlState.get('template') || '';
    if ((tpl?.id || '') !== tid) { await flushTpl(); tpl = templates.find((x) => x.id === tid) || null; }
    const filter = urlState.get('filter') || '';
    els.libFilter.value = [...els.libFilter.options].some((o) => o.value === filter) ? filter : '';
    els.libSearch.value = urlState.get('q') || '';
    renderLibrary();
    const t = urlState.get('tab');
    setTab(['library', 'templates', 'series'].includes(t) ? t : sid ? 'series' : tpl ? 'templates' : 'library');   // a hand-written link may leave the tab out
    const d = urlState.get('detail');
    if (d && images.has(d)) await openDetail(d); else els.detail.hidden = true;
    focusCard = series ? urlState.get('card') : null;
    const c = focusCard && series?.cards.find((x) => String(x.n) === focusCard);
    if (c && tab === 'series') goToCard(c.id);
  } finally { applying = false; }
  syncUrl();
}

// ---------- tabs ----------
function setTab(t) {
  tab = t; localStorage.setItem(LAST_TAB, t);
  for (const b of els.tabs.children) b.classList.toggle('on', b.dataset.tab === t);
  for (const c of document.querySelectorAll('.tab-controls')) c.hidden = c.dataset.for !== t;
  els.viewLibrary.hidden = t !== 'library'; els.viewTemplates.hidden = t !== 'templates'; els.viewSeries.hidden = t !== 'series';
  els.stepper.hidden = els.flowRow.hidden = t !== 'series'; els.strip.hidden = t !== 'series';
  if (t !== 'series') els.upscale.hidden = els.draftAll.hidden = true;
  if (t === 'templates') { renderTplList(); renderTemplate(); }
  if (t === 'series') renderSeries();
  syncUrl();
}
function refreshButtons() {
  const all = [...images.values()];
  const todo = all.filter((im) => im.source === 'print' && !im.analysis).length;
  const done = all.filter((im) => im.analysis).length;
  els.libSummary.textContent = `${plural(all.length, 'card')} found, ${done} analyzed. Analyzing reads a card's layout, text and art style so it can become a template.`;
  els.analyzeNew.textContent = todo ? `Analyze ${plural(todo, 'new card')}` : 'All cards are analyzed';
  els.analyzeNew.disabled = busy || !todo;
  els.selCount.textContent = selected.size ? `${plural(selected.size, 'card')} selected` : 'Click cards to select them';
  els.makeTemplate.disabled = els.analyzeSelected.disabled = busy || !selected.size;
  els.makeTemplate.textContent = selected.size > 1 ? `Make one template from these ${selected.size} cards` : 'Make a template from the selection';
  els.suggestGroups.disabled = busy || done < 2;
  els.replan.disabled = busy;
  refreshFlow();
}

// ---------- library ----------
async function loadLibrary() {
  sources = (await api('GET', '/api/cards/library')).sources;
  images.clear();
  for (const s of sources) for (const im of s.images) images.set(im.id, { ...im, source: s.id });
  for (const id of [...selected]) if (!images.has(id)) selected.delete(id);
  const kinds = [...new Set([...images.values()].map((im) => im.analysis?.archetype).filter(Boolean))].sort();
  const cur = els.libFilter.value;
  fillSelect(els.libFilter, [{ id: '', label: 'All cards' }, { id: 'todo', label: 'Not analyzed yet' }, ...kinds.map((k) => ({ id: k, label: archetypeLabel(k) }))], cur);
  renderLibrary(); refreshButtons();
}
function renderLibrary() {
  const filter = els.libFilter.value, query = els.libSearch.value.trim().toLowerCase();
  const html = [];
  for (const s of sources) {
    const folders = new Map();
    for (const im of s.images) {
      const a = im.analysis;
      if (filter === 'todo' ? a : filter && a?.archetype !== filter) continue;
      if (query && !`${im.name} ${a?.title || ''} ${a?.category || ''}`.toLowerCase().includes(query)) continue;
      const key = im.folder || s.label;
      if (!folders.has(key)) folders.set(key, []);
      folders.get(key).push(im);
    }
    for (const [folder, list] of folders) {
      html.push(`<div class="lib-group"><div class="section-title">${escapeHtml(folder.replace(/^upscaled\//, '').replace(/-/g, ' '))} <span class="hint">${list.length} · ${list.filter((x) => x.analysis).length} analyzed</span>
        <button class="link" data-all="${escapeHtml(list.map((x) => x.id).join('|'))}" type="button">select all</button></div><div class="gallery">${list.map(thumbHtml).join('')}</div></div>`);
    }
  }
  els.library.innerHTML = html.join('') || '<div class="empty small">No cards match.</div>';
  syncUrl();
}
function thumbHtml(im) {
  const a = im.analysis;
  return `<div class="thumb pick${selected.has(im.id) ? ' sel' : ''}${a ? '' : ' todo'}" data-id="${escapeHtml(im.id)}" title="${escapeHtml(a?.summary || im.name)}">
    <img loading="lazy" src="${escapeHtml(im.thumbUrl || im.url)}" alt="">
    ${a ? `<span class="badge kind">${escapeHtml(archetypeLabel(a.archetype))}</span>` : ''}${a?.branded ? '<span class="badge warn" title="Contains a brand or licensed character">brand</span>' : ''}
    <button class="info" type="button">details</button><div class="cap">${escapeHtml(a?.title || im.name)}</div></div>`;
}
els.library.addEventListener('click', (e) => {
  const all = e.target.closest('[data-all]');
  if (all) { const ids = all.dataset.all.split('|'); const on = ids.every((id) => selected.has(id)); for (const id of ids) on ? selected.delete(id) : selected.add(id); renderLibrary(); refreshButtons(); return; }
  const t = e.target.closest('.thumb'); if (!t) return;
  if (e.target.closest('.info')) return openDetail(t.dataset.id);
  selected.has(t.dataset.id) ? selected.delete(t.dataset.id) : selected.add(t.dataset.id);
  t.classList.toggle('sel'); refreshButtons();
});

async function analyze(ids, force) {
  await run(`Reading ${plural(ids.length, 'card')}`, async (onProgress) => {
    const r = await streamApi('/api/cards/analyze', { imageIds: ids, force }, onProgress);
    await loadLibrary();
    setStatus(`Analyzed ${plural(r.analyzed, 'card')}${r.skipped ? `, ${r.skipped} already done` : ''}.${r.errors.length ? ` ${r.errors.length} failed: ${escapeHtml(r.errors[0].error)}` : ''}`, r.errors.length ? 'error' : 'ok');
  });
}
async function makeTemplate(imageIds, extra = {}) {
  await run('Writing the template', async (onProgress) => {
    const t = await streamApi('/api/cards/templates', { imageIds, instructions: els.tplInstructions.value, ...extra }, onProgress);
    await Promise.all([loadTemplates(), loadLibrary()]);
    tpl = templates.find((x) => x.id === t.id) || t;
    setTab('templates');
    setStatus(`Created the template “${escapeHtml(t.name)}” with ${plural(t.slots.length, 'content slot')}. Edit anything below, then start a series from it.`, 'ok');
  });
}
async function openDetail(id) {
  const im = images.get(id);
  let a = null;
  if (im.analysis) a = (await api('GET', `/api/cards/analysis?id=${encodeURIComponent(id)}`).catch(() => null))?.analysis;
  const body = a ? `
    <h3>${escapeHtml(a.title)}</h3><p>${escapeHtml([a.subtitle, a.tagline].filter(Boolean).join(' — '))}</p>
    <div class="meta-row"><span class="chip up">${escapeHtml(archetypeLabel(a.archetype))}</span><span class="chip">${escapeHtml(a.category)}</span><span class="chip">${escapeHtml(a.audience)}</span></div>
    ${a.brandedContent ? `<div class="note-warn">Brand or licensed content: ${escapeHtml(a.brandedContent)}. Templates made from this card leave it out.</div>` : ''}
    ${a.issues ? `<div class="note-warn">Noticed: ${escapeHtml(a.issues)}</div>` : ''}
    <div class="kv"><span>Layout</span><div>${escapeHtml(a.layout.summary)}</div><span>Grid</span><div>${escapeHtml(a.layout.grid)}</div>
      ${Object.entries(a.style).map(([k, v]) => `<span>${escapeHtml(k)}</span><div>${escapeHtml(v)}</div>`).join('')}
      ${a.characters ? `<span>Characters</span><div>${escapeHtml(a.characters)}</div>` : ''}</div>
    <table class="regions"><tr><th>Region</th><th>Where</th><th>Text on the card</th><th>Picture</th></tr>
      ${a.layout.regions.map((r) => `<tr><td>${escapeHtml(r.role)}</td><td>${escapeHtml(r.position)}</td><td class="r-text">${r.heading ? `<b>${escapeHtml(r.heading)}</b>\n` : ''}${escapeHtml(r.text)}</td><td>${escapeHtml(r.visual)}</td></tr>`).join('')}</table>`
    : '<p>This card has not been analyzed yet.</p>';
  els.detail.innerHTML = `<div class="drawer"><a href="${escapeHtml(im.url)}" target="_blank"><img src="${escapeHtml(im.thumbUrl || im.url)}" alt=""></a><div class="drawer-body">${body}
    <div class="actions"><button class="btn secondary small" data-act="template" type="button">Make a template from this card</button><button class="btn secondary small" data-act="analyze" type="button">${a ? 'Re-analyze' : 'Analyze'}</button><button class="btn secondary small" data-act="close" type="button">Close</button></div></div></div>`;
  els.detail.hidden = false; els.detail.dataset.id = id;
  els.detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  syncUrl();
}
els.detail.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act, id = els.detail.dataset.id;
  if (act === 'close') { els.detail.hidden = true; syncUrl(); }
  else if (act === 'template') makeTemplate([id]);
  else if (act === 'analyze') { await analyze([id], true); openDetail(id); }
});

function renderGroups() {
  els.groups.hidden = !groups?.length;
  if (!groups?.length) return;
  els.groups.innerHTML = `<div class="section-title">Suggested template families <button class="link" data-act="dismiss" type="button">dismiss</button></div>` + groups.map((g, i) => `
    <div class="group"><div class="group-head"><b>${escapeHtml(g.name)}</b><span class="hint">${plural(g.imageIds.length, 'card')}</span><span class="spacer"></span>
      <button class="btn secondary small" data-act="select" data-i="${i}" type="button">Select these</button><button class="btn secondary small" data-act="create" data-i="${i}" type="button">Create template</button></div>
      <div class="hint">${escapeHtml(g.description)}</div>
      <div class="group-thumbs">${g.imageIds.slice(0, 14).map((id) => `<img class="${id === g.bestImageId ? 'best' : ''}" loading="lazy" src="${escapeHtml(thumbOf(id))}" title="${escapeHtml(images.get(id)?.analysis?.title || id)}" alt="">`).join('')}${g.imageIds.length > 14 ? `<span class="hint">+${g.imageIds.length - 14}</span>` : ''}</div></div>`).join('');
}
els.groups.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const g = groups[Number(b.dataset.i)];
  if (b.dataset.act === 'dismiss') { groups = null; api('DELETE', '/api/cards/groups'); renderGroups(); }
  else if (b.dataset.act === 'select') { selected.clear(); for (const id of g.imageIds) if (images.has(id)) selected.add(id); renderLibrary(); refreshButtons(); }
  else if (b.dataset.act === 'create') makeTemplate(g.imageIds.filter((id) => images.has(id)), { refImageId: g.bestImageId, name: g.name });
});

// ---------- templates ----------
async function loadTemplates() {
  templates = await api('GET', '/api/cards/templates');
  if (tpl) tpl = templates.find((t) => t.id === tpl.id) || null;
  const opts = templates.map((t) => ({ id: t.id, label: `${t.name} · ${t.slots.length} slots` }));
  fillSelect(els.template, opts.length ? opts : [{ id: '', label: 'No templates yet — make one in the Library tab' }], series?.brief.templateId || els.template.value);
  fillSelect(els.styleTemplate, [{ id: '', label: 'Same as the card template' }, ...templates.filter((t) => t.refImageId).map((t) => ({ id: t.id, label: t.name }))], series?.brief.styleTemplateId || els.styleTemplate.value);
}
function renderTplList() {
  els.tplList.innerHTML = templates.map((t) => `<button class="tpl-item${tpl?.id === t.id ? ' on' : ''}" data-id="${escapeHtml(t.id)}" type="button">
    ${t.refImageId && thumbOf(t.refImageId) ? `<img src="${escapeHtml(thumbOf(t.refImageId))}" alt="">` : '<span class="ph">▦</span>'}
    <span><b>${escapeHtml(t.name)}</b><small>${escapeHtml(archetypeLabel(t.archetype))} · ${plural(t.slots.length, 'slot')}${t.exampleIds.length ? ` · from ${plural(t.exampleIds.length, 'card')}` : ' · built in'}</small></span></button>`).join('')
    || '<div class="empty small">No templates yet. Analyze cards in the Library tab, select some and make a template.</div>';
}
els.tplList.addEventListener('click', async (e) => {
  const b = e.target.closest('.tpl-item'); if (!b) return;
  await flushTpl(); tpl = templates.find((t) => t.id === b.dataset.id); renderTplList(); renderTemplate();
});
const TPL_TEXT = [['styleGuide', 'Style guide', 'How every card of this family looks. Added to every picture prompt.', 5], ['layoutGuide', 'Page layout', 'The fixed page structure, top to bottom.', 5],
  ['titleHint', 'Title, subtitle and tagline', 'How they are worded.', 2], ['heroHint', 'Main picture', 'Leave empty if the format has none.', 2], ['textRules', 'Writing rules', 'Voice, reading level, word counts.', 3],
  ['closingHint', 'Bottom line', 'The motto or takeaway pattern.', 2], ['sourceHint', 'Source credit', 'Leave empty for none.', 1]];
function renderTemplate() {
  syncUrl();
  const v = els.viewTemplates;
  if (!tpl) { v.innerHTML = `<div class="empty"><b>Templates are made from your own cards.</b><br>In the <b>Library</b> tab, analyze your cards, select one or more that share a format, and make a template.<br>Or let <b>✨ Sort my cards into template families</b> propose them.</div>`; return; }
  const refUrl = tpl.refImageId ? images.get(tpl.refImageId)?.thumbUrl : '';
  v.innerHTML = `<div class="tpl-editor">
    <div class="tpl-top">
      <div class="tpl-ref">${refUrl ? `<a href="${escapeHtml(images.get(tpl.refImageId).url)}" target="_blank"><img src="${escapeHtml(refUrl)}" alt=""></a><div class="hint">Reference card: sent to the image model with every new card so the look and layout match.</div>` : '<div class="art-empty">No reference card</div><div class="hint">This template is text only. Pair it with a “Look” template when you start a series.</div>'}
        ${tpl.exampleIds.length > 1 ? `<div class="hint" style="margin-top:8px">Made from ${tpl.exampleIds.length} cards — click one to use it as the reference:</div><div class="examples">${tpl.exampleIds.filter((id) => images.has(id)).map((id) => `<img class="${id === tpl.refImageId ? 'on' : ''}" data-ref="${escapeHtml(id)}" loading="lazy" src="${escapeHtml(thumbOf(id))}" title="${escapeHtml(images.get(id).analysis?.title || id)}" alt="">`).join('')}</div>` : ''}
      </div>
      <div class="tpl-fields">
        <div class="book-head"><input class="book-title" data-k="name" value="${escapeHtml(tpl.name)}" placeholder="Template name"><button class="btn primary" data-act="series" type="button">New series from this template</button></div>
        <label class="field"><span>What it is for</span><input data-k="description" value="${escapeHtml(tpl.description)}"></label>
        <div class="grid2"><label class="field"><span>Format</span><select data-k="archetype">${config.cards.archetypes.map((a) => `<option value="${a.id}"${a.id === tpl.archetype ? ' selected' : ''}>${escapeHtml(a.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Audience</span><input data-k="audience" value="${escapeHtml(tpl.audience)}"></label></div>
        ${TPL_TEXT.slice(0, 2).map(tplField).join('')}
      </div>
    </div>
    <div class="grid2">${TPL_TEXT.slice(2, 6).map(tplField).join('')}</div>${tplField(TPL_TEXT[6])}
    <div class="section-title">Content slots <span class="hint">what a new card fills in, in reading order</span></div>
    <div class="pages" id="tpl-slots">${tpl.slots.map(slotHtml).join('')}</div>
    <div class="actions"><button class="btn secondary small" data-act="add-slot" type="button">+ Add a slot</button><span class="save-state" id="tpl-save"></span><span style="flex:1"></span><button class="btn danger small" data-act="delete" type="button">Delete template</button></div></div>`;
}
const tplField = ([k, label, hint, rows]) => `<label class="field"><span>${label} <span class="hint">${hint}</span></span><textarea data-k="${k}" rows="${rows}">${escapeHtml(tpl[k])}</textarea></label>`;
const slotHtml = (s, i) => `<div class="slot-row" data-i="${i}"><div class="slot-head"><span class="num">${i + 1}</span>
  <input data-s="label" value="${escapeHtml(s.label)}" placeholder="Slot name"><input data-s="position" value="${escapeHtml(s.position)}" placeholder="Where on the page">
  <select data-s="role">${config.cards.slotRoles.map((r) => `<option${r === s.role ? ' selected' : ''}>${r}</option>`).join('')}</select>
  <input data-s="maxWords" type="number" min="0" max="200" value="${s.maxWords}" title="Maximum words of body text">
  <span><button class="mini" data-act="slot-up" type="button">↑</button> <button class="mini" data-act="slot-down" type="button">↓</button> <button class="mini" data-act="slot-remove" type="button">✕</button></span></div>
  <div class="slot-hints"><textarea data-s="headingHint" placeholder="Heading: how it is phrased (empty = no heading)">${escapeHtml(s.headingHint)}</textarea><textarea data-s="contentHint" placeholder="Content: what goes here">${escapeHtml(s.contentHint)}</textarea><textarea data-s="visualHint" placeholder="Picture: what accompanies it">${escapeHtml(s.visualHint)}</textarea></div></div>`;
let tplTimer = null, tplDirty = false;
function queueTpl() { tplDirty = true; const s = $('tpl-save'); if (s) { s.textContent = 'Unsaved changes…'; s.className = 'save-state'; } clearTimeout(tplTimer); tplTimer = setTimeout(flushTpl, 600); }
async function flushTpl() {
  clearTimeout(tplTimer);
  if (!tpl || !tplDirty) return;
  tplDirty = false;
  const s = $('tpl-save');
  try {
    const saved = await api('PATCH', `/api/cards/templates/${tpl.id}`, tpl);
    templates = templates.map((t) => (t.id === saved.id ? saved : t));
    if (tpl.id === saved.id) Object.assign(tpl, { updatedAt: saved.updatedAt });
    if (s) { s.textContent = 'All changes saved'; s.className = 'save-state ok'; }
  } catch (e) { if (s) { s.textContent = `Not saved: ${e.message}`; s.className = 'save-state error'; } }
}
els.viewTemplates.addEventListener('input', (e) => {
  if (!tpl) return;
  const row = e.target.closest('.slot-row');
  if (row && e.target.dataset.s) { const k = e.target.dataset.s; tpl.slots[Number(row.dataset.i)][k] = k === 'maxWords' ? Number(e.target.value) || 0 : e.target.value; }
  else if (e.target.dataset.k) tpl[e.target.dataset.k] = e.target.value;
  else return;
  queueTpl();
});
els.viewTemplates.addEventListener('click', async (e) => {
  if (!tpl) return;
  const ref = e.target.closest('[data-ref]');
  if (ref) { tpl.refImageId = ref.dataset.ref; queueTpl(); await flushTpl(); renderTplList(); return renderTemplate(); }
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
  const i = Number(e.target.closest('.slot-row')?.dataset.i);
  if (act === 'add-slot') tpl.slots.push({ key: '', role: 'fact-panel', label: `Panel ${tpl.slots.length + 1}`, position: '', headingHint: '', contentHint: '', visualHint: '', maxWords: 12 });
  else if (act === 'slot-remove') tpl.slots.splice(i, 1);
  else if (act === 'slot-up' && i > 0) [tpl.slots[i - 1], tpl.slots[i]] = [tpl.slots[i], tpl.slots[i - 1]];
  else if (act === 'slot-down' && i < tpl.slots.length - 1) [tpl.slots[i + 1], tpl.slots[i]] = [tpl.slots[i], tpl.slots[i + 1]];
  else if (act === 'delete') {
    if (!confirm(`Delete the template “${tpl.name}”? Series that use it will need another template.`)) return;
    await api('DELETE', `/api/cards/templates/${tpl.id}`); tpl = null; tplDirty = false; await loadTemplates(); renderTplList(); return renderTemplate();
  } else if (act === 'series') { await flushTpl(); await newSeries(); els.template.value = tpl.id; onTemplateChosen(); return setTab('series'); }
  else return;
  queueTpl(); await flushTpl(); tpl = templates.find((t) => t.id === tpl.id); renderTplList(); renderTemplate();
});

// ---------- series: brief form ----------
const kind = () => document.querySelector('input[name=kind]:checked').value;
const currentTemplate = () => templates.find((t) => t.id === (series?.brief.templateId || els.template.value));
const audience = () => config.cards.audiences.find((a) => a.id === (series?.brief.audience || els.audience.value)) || config.cards.audiences[0];
const readBrief = () => ({ kind: kind(), templateId: els.template.value, styleTemplateId: els.styleTemplate.value, premise: els.premise.value, topics: els.topics.value, lesson: els.lesson.value, audience: els.audience.value,
  cardCount: Number(els.cardCount.value) || 6, tone: els.tone.value, notes: els.notes.value, characterIds: [...briefChars] });
const readImage = () => ({ model: els.imgModel.value, quality: els.imgQuality.value, size: els.imgSize.value, textMode: els.textMode.value, proof: els.proof.checked, useTemplateRef: els.useTemplateRef.checked, chain: els.chain.checked, badge: els.badge.checked });
function writeBrief() {
  const b = series?.brief, im = series?.image;
  document.querySelector(`input[name=kind][value=${b?.kind || 'set'}]`).checked = true;
  if (b) { els.template.value = b.templateId; els.styleTemplate.value = b.styleTemplateId || ''; }
  els.premise.value = b?.premise || ''; els.topics.value = b?.topics || ''; els.lesson.value = b?.lesson || ''; els.audience.value = b?.audience || 'template'; els.cardCount.value = b?.cardCount || 6; els.tone.value = b?.tone || ''; els.notes.value = b?.notes || '';
  briefChars.clear(); for (const id of b?.characterIds || []) briefChars.add(id);
  if (im) { els.imgModel.value = im.model; els.imgQuality.value = im.quality; ensureSize(im.size); }
  els.textMode.value = im?.textMode || 'captions';
  els.proof.checked = im?.proof ?? true;
  els.useTemplateRef.checked = im?.useTemplateRef ?? true; els.chain.checked = im?.chain ?? true; els.badge.checked = im?.badge ?? true;
  renderBriefChars(); kindChanged(); artSummary();
}
function ensureSize(size) { if (![...els.imgSize.options].some((o) => o.value === size)) { const o = document.createElement('option'); o.value = size; o.textContent = size.replace('x', ' × '); els.imgSize.appendChild(o); } els.imgSize.value = size; }
function kindChanged() {
  els.premiseLabel.textContent = kind() === 'story' ? 'What is the story?' : 'What is the series about?';
  els.premise.placeholder = kind() === 'story' ? 'Pip the puffin loses her way in the fog and learns how birds navigate home.' : 'Animals that live in tide pools.';
}
function onTemplateChosen() { const t = templates.find((x) => x.id === els.template.value); if (t && !series) ensureSize(t.size || '1024x1536'); artSummary(); }
function artSummary() { const est = estimateImageCost(els.imgModel.value, els.imgSize.value, els.imgQuality.value); els.artSummary.textContent = `${els.imgSize.value.replace('x', '×')} · ${els.imgQuality.value}${est ? ` · ≈ ${fmtCost(est)} per card` : ''}`; }
function renderBriefChars() {
  els.briefChars.innerHTML = characters.length ? '' : '<span class="hint">None yet. Create characters on the Images page.</span>';
  for (const c of characters) {
    const chip = document.createElement('span'); chip.className = 'char-chip' + (briefChars.has(c.id) ? ' on' : '');
    chip.innerHTML = `${c.refs[0] ? `<img src="${escapeHtml(c.refs[0].thumbUrl)}" alt="">` : ''}${escapeHtml(c.name)}`;
    chip.onclick = () => { briefChars.has(c.id) ? briefChars.delete(c.id) : briefChars.add(c.id); renderBriefChars(); if (series) queue({ brief: { characterIds: [...briefChars] } }); };
    els.briefChars.appendChild(chip);
  }
}
// Each control saves only its own field, so form state can never overwrite the rest of a stored brief.
for (const [el, k] of [[els.premise, 'premise'], [els.topics, 'topics'], [els.lesson, 'lesson'], [els.tone, 'tone'], [els.notes, 'notes'], [els.cardCount, 'cardCount'], [els.audience, 'audience'], [els.template, 'templateId'], [els.styleTemplate, 'styleTemplateId']]) {
  el.addEventListener('input', () => {
    if (el === els.template) onTemplateChosen();
    if (!series) return;
    series.brief[k] = k === 'cardCount' ? Number(el.value) || series.brief.cardCount : el.value;
    queue({ brief: { [k]: series.brief[k] } });
    if (el === els.template || el === els.audience) renderCards();
  });
}
for (const r of document.querySelectorAll('input[name=kind]')) r.addEventListener('change', () => { kindChanged(); if (series) { series.brief.kind = kind(); queue({ brief: { kind: kind() } }); } });
for (const [el, k] of [[els.imgModel, 'model'], [els.imgQuality, 'quality'], [els.imgSize, 'size'], [els.textMode, 'textMode'], [els.proof, 'proof'], [els.useTemplateRef, 'useTemplateRef'], [els.chain, 'chain'], [els.badge, 'badge']]) {
  el.addEventListener('change', () => { artSummary(); if (series) queue({ image: { [k]: el.type === 'checkbox' ? el.checked : el.value } }); refreshFlow(); });
}

// ---------- series: autosave ----------
let pending = {}, saveTimer = null;
function setSave(text, k = '') { els.saveState.textContent = text; els.saveState.className = `save-state ${k}`; }
function queue(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'cards') { pending.cards = pending.cards || {}; for (const c of v) pending.cards[c.id] = { ...(pending.cards[c.id] || {}), ...c }; }
    else if (k === 'brief' || k === 'image') pending[k] = { ...(pending[k] || {}), ...v };
    else pending[k] = v;
  }
  setSave('Unsaved changes…'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 600);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!series || !Object.keys(pending).length) return;
  const body = { ...pending, ...(pending.cards ? { cards: Object.values(pending.cards) } : {}) };
  pending = {}; setSave('Saving…');
  try { series = await api('PATCH', `/api/cards/series/${series.id}`, body); setSave('All changes saved', 'ok'); refreshFlow(); }
  catch (e) { setSave(`Not saved: ${e.message}`, 'error'); }
}
window.addEventListener('beforeunload', (e) => { if (Object.keys(pending).length || tplDirty) { flush(); flushTpl(); e.preventDefault(); } });

// ---------- series: list, open, create ----------
async function loadSeriesList() {
  seriesList = await api('GET', '/api/cards/series');
  els.seriesSelect.innerHTML = '<option value="">Open a series…</option>';
  for (const s of seriesList) { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.title}${s.cards ? ` · ${s.illustrated}/${s.cards} pictures` : ' · brief only'}`; els.seriesSelect.appendChild(o); }
  els.seriesSelect.value = series?.id || '';
}
async function openSeries(id) {
  await flush();
  series = id ? await api('GET', `/api/cards/series/${id}`).catch(() => null) : null;
  focusCard = null;
  if (series) localStorage.setItem(LAST_SERIES, series.id); else localStorage.removeItem(LAST_SERIES);
  els.seriesSelect.value = series?.id || '';
  writeBrief(); renderSeries();
}
async function newSeries() { await flush(); series = null; focusCard = null; localStorage.removeItem(LAST_SERIES); els.seriesSelect.value = ''; writeBrief(); onTemplateChosen(); renderSeries(); setStatus(''); }
async function ensureSeries() {
  if (series) { await flush(); return; }
  if (!els.template.value) throw new Error('Make a template first (Library tab), then choose it here.');
  series = await api('POST', '/api/cards/series', { brief: readBrief(), image: readImage() });
  localStorage.setItem(LAST_SERIES, series.id);
  await loadSeriesList();
  syncUrl();
}
els.seriesSelect.addEventListener('change', () => openSeries(els.seriesSelect.value));
els.newSeries.addEventListener('click', newSeries);
els.deleteSeries.addEventListener('click', async () => {
  if (!series || !confirm(`Delete the series “${series.title || 'Untitled'}”? Its pictures stay in History.`)) return;
  pending = {}; await api('DELETE', `/api/cards/series/${series.id}`); series = null; focusCard = null; localStorage.removeItem(LAST_SERIES); await loadSeriesList(); writeBrief(); renderSeries();
});

// ---------- series: steps ----------
const unwritten = () => (series ? series.cards.filter((c) => !c.title) : []);
const unpictured = () => (series ? series.cards.filter((c) => c.title && (!c.imageId || c.draft)) : []);
// The largest upscaled copy of a card picture, if one exists (made here or on the Images page).
const upscaledOf = (id) => [...records.values()].filter((r) => r.upscaleOf === id && !r.deletedAt && !r.missing).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
const notUpscaled = () => (series ? series.cards.filter((c) => records.has(c.imageId) && !upscaledOf(c.imageId)) : []);
const UPSCALE_MODEL = 'realesrgan-x4plus';
function refreshFlow() {
  if (!config) return;
  const cards = series?.cards || [];
  const planned = cards.length > 0, written = planned && !unwritten().length, pictured = written && cards.every((c) => c.imageId && !c.draft);
  const state = { plan: planned, write: written, images: pictured, print: false };
  const current = !planned ? 'plan' : !written ? 'write' : !pictured ? 'images' : 'print';
  const small = { plan: planned ? plural(cards.length, 'card') : '', write: planned ? `${cards.length - unwritten().length}/${cards.length}` : '', images: planned ? `${cards.filter((c) => c.imageId).length}/${cards.length}` : '', print: '' };
  for (const li of els.stepper.children) {
    const s = li.dataset.step;
    li.className = state[s] ? 'done' : s === current ? 'current' : 'locked';
    li.querySelector('small').textContent = small[s];
  }
  const est = estimateImageCost(els.imgModel.value, els.imgSize.value, els.imgQuality.value);
  const n = unpictured().length;
  els.next.textContent = current === 'plan' ? 'Plan the series' : current === 'write' ? `Write ${plural(unwritten().length, 'card')}` : current === 'images' ? `Illustrate ${plural(n, 'card')}${est ? ` (≈ ${fmtCost(est * n)})` : ''}` : 'Send to Print Sheets';
  els.next.dataset.step = current;
  const undrafted = cards.filter((c) => c.title && !c.imageId).length;
  els.draftAll.hidden = tab !== 'series' || !undrafted; els.draftAll.disabled = busy; els.draftAll.textContent = `✏️ Draft storyboard (${undrafted} quick sketches)`;
  for (const b of [els.makePlaces, els.makeExtras, els.tidy]) b.disabled = busy;
  els.redrawAll.hidden = !cards.some((c) => c.imageId); els.redrawAll.disabled = busy;
  els.next.disabled = busy;
  const up = notUpscaled().length;
  els.upscale.hidden = !up || !config.upscale.options.some((o) => o.id === UPSCALE_MODEL);
  els.upscale.disabled = busy;
  els.upscale.textContent = `⬆ Upscale ${plural(up, 'card')} ×4 for print`;
  els.strip.innerHTML = cards.map((c) => `<button class="tile${c.imageId ? ' pictured' : c.title ? ' written' : ''}" data-id="${c.id}" title="${escapeHtml(c.title || c.topic)}" type="button">${c.imageId ? `<img src="${escapeHtml(recThumb(c.imageId))}" alt="">` : ''}<span>${c.n}</span></button>`).join('');
}
els.strip.addEventListener('click', (e) => {
  const t = e.target.closest('.tile'); if (!t) return;
  focusCard = String(series.cards.find((c) => c.id === t.dataset.id)?.n || '') || null;
  syncUrl(); goToCard(t.dataset.id);
});
els.next.addEventListener('click', () => ({ plan, write: () => write(), images: illustrateAll, print: sendToSheets }[els.next.dataset.step])());
els.replan.addEventListener('click', () => plan(els.planInstructions.value));
els.stepper.addEventListener('click', (e) => { if (e.target.closest('li')?.dataset.step === 'print' && series?.cards.some((c) => c.imageId)) sendToSheets(); });
els.stop.addEventListener('click', () => { stopRequested = true; els.stop.disabled = true; });

async function plan(instructions = '') {
  await run('Planning the series', async (onProgress) => {
    if (!series && !els.premise.value.trim() && !els.topics.value.trim()) throw new Error('Say what the series is about (or list its topics) first.');
    await ensureSeries();
    series = await streamApi(`/api/cards/series/${series.id}/plan`, { instructions }, onProgress);
    els.planInstructions.value = '';
    await loadSeriesList(); renderSeries();
    setStatus(`Planned ${plural(series.cards.length, 'card')}. Adjust topics below, then write them.`, 'ok');
  });
}
async function write(cardIds, instructions = '') {
  await run(cardIds ? 'Rewriting the card' : 'Writing the cards', async (onProgress) => {
    await flush();
    series = await streamApi(`/api/cards/series/${series.id}/write`, { cardIds, instructions }, onProgress);
    renderSeries();
    setStatus(cardIds ? 'Card written.' : 'All cards are written. Read them through — every word below is printed on the card — then illustrate.', 'ok');
  });
}
async function illustrate(cardId, body = {}) {
  const el = document.querySelector(`.page-card[data-id="${cardId}"]`);
  el?.classList.add('working');
  try {
    const r = await api('POST', `/api/cards/series/${series.id}/cards/${cardId}/image`, body);
    series = r.series; for (const rec of r.records || [r.record]) records.set(rec.id, rec);
    return r;
  } finally { el?.classList.remove('working'); }
}
async function draftAll() {
  stopRequested = false; els.stop.hidden = false; els.stop.disabled = false;
  await run('Sketching the storyboard', async (onProgress) => {
    await flush();
    const todo = series.cards.filter((c) => c.title && !c.imageId); let done = 0, spent = 0;
    for (const c of todo) {
      if (stopRequested) break;
      onProgress({ phase: `Sketching card ${c.n} of ${series.cards.length}`, done, total: todo.length, snippet: c.title });
      const r = await illustrate(c.id, { draft: true }); done++; spent += r.record.costUsd || 0; renderSeries();
    }
    setStatus(`Sketched ${plural(done, 'card')}${spent ? ` for ${fmtCost(spent)}` : ''}. Read the story through the pictures, fix any card's text, then Illustrate draws the final versions.`, 'ok');
  });
  els.stop.hidden = true;
}
els.draftAll.addEventListener('click', draftAll);
async function seriesAction(label, path, body, done) {
  await run(label, async () => { await flush(); const r = await api('POST', `/api/cards/series/${series.id}/${path}`, body || {}); series = r.series; for (const rec of r.records || []) records.set(rec.id, rec); renderSeries(); setStatus(done(r), 'ok'); });
}
els.makePlaces.addEventListener('click', () => seriesAction('Painting the place references', 'places', {}, (r) => `${plural(series.places.length, 'place')} set up${r.records.length ? `, ${r.records.length} painted` : ''}. New pictures of cards set there will use them.`));
els.makeExtras.addEventListener('click', () => seriesAction('Drawing the cover and chapter cards', 'extras', {}, (r) => (r.records.length ? `Drew ${plural(r.records.length, 'card')}: cover and chapter title cards. They are added when you send the series to Print Sheets.` : 'The cover and chapter cards already exist.')));
els.tidy.addEventListener('click', () => seriesAction('Tidying captions and names', 'tidy', {}, (r) => (r.changed ? `Tidied ${plural(r.changed, 'line')}. Cards that already have pictures need redrawing to show the new words.` : 'Nothing needed changing.')));
els.redrawAll.addEventListener('click', () => {
  const n = series.cards.filter((c) => c.title).length, est = estimateImageCost(els.imgModel.value, els.imgSize.value, els.imgQuality.value);
  if (confirm(`Redraw all ${n} cards with the current picture settings${est ? ` (≈ ${fmtCost(est * n)})` : ''}? The pictures you have now are kept as earlier versions of each card.`)) illustrateAll(true);
});
async function illustrateAll(all = false) {
  stopRequested = false; els.stop.hidden = false; els.stop.disabled = false;
  await run('Illustrating', async (onProgress) => {
    await flush();
    const todo = all === true ? series.cards.filter((c) => c.title) : unpictured(); let done = 0, spent = 0, flagged = 0;
    for (const c of todo) {
      if (stopRequested) break;
      onProgress({ phase: `Illustrating${els.proof.checked ? ' and proofreading' : ''} card ${c.n} of ${series.cards.length} (about a minute each)`, done, total: todo.length, snippet: c.title });
      const r = await illustrate(c.id); done++; if (r.check && !r.check.pass) flagged++;
      for (const rec of (r.records || []).slice(0, -1)) spent += rec.costUsd || 0;
      spent += records.get(series.cards.find((x) => x.id === c.id).imageId)?.costUsd || 0;
      renderSeries();
    }
    setStatus(`Illustrated ${plural(done, 'card')}${spent ? ` for ${fmtCost(spent)}` : ''}.${flagged ? ` ${plural(flagged, 'card')} still ${flagged === 1 ? 'has' : 'have'} something the proofreader flagged — look for ⚠ below.` : els.proof.checked ? ' The proofreader passed every card.' : ''}${stopRequested ? ' Stopped.' : ''}`, flagged ? 'error' : 'ok');
  });
  els.stop.hidden = true;
}
async function upscaleAll() {
  await run('Upscaling', async (onProgress) => {
    const todo = notUpscaled(); let done = 0;
    for (const c of todo) {
      onProgress({ phase: `Upscaling card ${c.n} to print size (Real-ESRGAN ×4, about 15 s each)`, done, total: todo.length, snippet: c.title });
      const r = await api('POST', `/api/history/${c.imageId}/upscale`, { model: UPSCALE_MODEL, scale: 4 });
      records.set(r.id, r); done++;
    }
    setStatus(`Upscaled ${plural(done, 'card')}. Print Sheets will use the large versions.`, 'ok');
  });
}
els.upscale.addEventListener('click', upscaleAll);
async function sendToSheets() {
  await flush();
  const order = [series.cover?.imageId]; let ch = '';
  for (const c of series.cards) { if (c.chapter && c.chapter !== ch) { ch = c.chapter; order.push(series.chapterCards?.[ch]); } order.push(c.imageId); }
  const items = order.filter(Boolean).map((id) => upscaledOf(id) || records.get(id)).filter((r) => r && !r.deletedAt).map((r) => ({ source: 'output', rel: r.file, copies: 1, back: null }));
  if (!items.length) return setStatus('Illustrate at least one card first.', 'error');
  const spec = { ...config.sheets.defaults, page: 'tabloid', orientation: 'portrait', grid: '2x2', items };
  try {
    const sheet = await api('POST', '/api/sheets', { name: series.title || 'Flash cards', spec });
    localStorage.setItem('dadventures.sheetDraft', JSON.stringify({ sheetId: sheet.id, name: sheet.name, spec: sheet.spec }));
    location.href = `/sheets.html?sheet=${encodeURIComponent(sheet.id)}`;
  } catch (e) { setStatus(escapeHtml(e.message), 'error'); }
}

// ---------- series: editor ----------
// What the continuity reader found: each finding names its cards and can be sent to the writer as a rewrite instruction.
function renderLogic() {
  const l = series?.logic;
  if (!l) { els.logic.innerHTML = ''; return; }
  const head = l.holes.length
    ? `<b>Continuity reader:</b> ${plural(l.holes.length, 'thing')} in the ${l.stage === 'script' ? 'written story' : 'plan'} ${l.holes.length === 1 ? 'does' : 'do'} not add up yet${l.fixed ? ` (the editor already fixed ${l.fixed} of ${l.found})` : ''}.`
    : `<span class="proof ok">✓ Continuity reader: the ${l.stage === 'script' ? 'written story' : 'plan'} adds up${l.found ? ` (the editor fixed ${plural(l.found, 'hole')} first)` : ''}.</span>`;
  els.logic.innerHTML = `<div>${head}</div>` + l.holes.map((h) => `<div class="hole ${escapeHtml(h.severity)}" data-hole="${escapeHtml(h.id)}"><div><b>${h.cards.length ? `Card${h.cards.length === 1 ? '' : 's'} ${h.cards.join(', ')}` : 'Whole story'}</b> · ${escapeHtml(h.problem)}</div><div class="fix">Smallest fix: ${escapeHtml(h.fix)}</div>
    ${h.cards.length && h.cards.every((n) => series.cards.find((c) => c.n === n)?.title) ? '<div class="row"><button class="mini" data-fix-hole type="button">Rewrite these cards to fix it</button></div>' : ''}</div>`).join('');
}
async function checkLogic() {
  await run('Reading the story for things that do not add up', async (onProgress) => {
    await flush();
    const r = await streamApi(`/api/cards/series/${series.id}/logic`, {}, onProgress);
    series = r.series; renderSeries();
    setStatus(r.logic.holes.length ? `The continuity reader found ${plural(r.logic.holes.length, 'thing')} that ${r.logic.holes.length === 1 ? 'does' : 'do'} not add up — see the story box.` : 'The continuity reader found nothing that does not add up.', r.logic.holes.length ? 'error' : 'ok');
  });
}
els.checkLogic.addEventListener('click', checkLogic);
els.logic.addEventListener('click', (e) => {
  if (!e.target.closest('[data-fix-hole]')) return;
  const h = series.logic?.holes.find((x) => x.id === e.target.closest('[data-hole]').dataset.hole);
  const ids = h ? h.cards.map((n) => series.cards.find((c) => c.n === n)?.id).filter(Boolean) : [];
  if (ids.length) write(ids, `A continuity reader found this problem: ${h.problem} Fix it this way, changing as little else as possible: ${h.fix} Keep each card's "state" true and make every picture brief agree with it.`);
});

function renderSeries() {
  refreshFlow();
  syncUrl();
  els.seriesEmpty.hidden = Boolean(series?.cards.length); els.series.hidden = !series?.cards.length;
  if (!series?.cards.length) return;
  els.title.value = series.title; els.logline.value = series.logline; els.styleGuide.value = series.styleGuide;
  els.storyBox.hidden = series.brief.kind !== 'story';
  els.world.value = series.world || '';
  els.foundation.innerHTML = config.cards.foundationFields.map((f) => `<label class="field"><span>${escapeHtml(f.label)}</span><textarea data-f="${f.id}" rows="2">${escapeHtml(series.foundation?.[f.id] || '')}</textarea></label>`).join('');
  els.editorNotes.textContent = series.editorNotes ? `Story editor: ${series.editorNotes}` : '';
  renderLogic();
  const ex = [series.cover?.imageId && ['Cover', series.cover.imageId], ...Object.entries(series.chapterCards || {}).map(([k, v]) => [`Chapter: ${k}`, v]), ...(series.places || []).map((pl) => [`Place: ${pl.name}`, pl.imageId])].filter((x) => x && x[1] && records.get(x[1]));
  els.extras.innerHTML = ex.length ? ex.map(([label, rid]) => `<a href="${escapeHtml(records.get(rid).url)}" target="_blank" title="${escapeHtml(label)}"><img loading="lazy" src="${escapeHtml(recThumb(rid))}" alt=""><span>${escapeHtml(label)}</span></a>`).join('') : `<span class="hint">None yet.${(series.places || []).length ? ` Places planned: ${escapeHtml(series.places.map((x) => x.name).join(', '))}.` : ''}</span>`;
  els.spine.value = series.spine || ''; els.refrain.value = series.refrain || ''; els.hiddenFriend.value = series.hiddenFriend || '';
  els.script.href = `/api/cards/series/${series.id}/script.md`;
  const t = currentTemplate(), look = templates.find((x) => x.id === series.brief.styleTemplateId) || t;
  els.styleGuide.placeholder = look?.styleGuide || '';
  renderCast(); renderCards();
}
for (const [el, k] of [[els.title, 'title'], [els.logline, 'logline'], [els.styleGuide, 'styleGuide'], [els.spine, 'spine'], [els.world, 'world'], [els.refrain, 'refrain'], [els.hiddenFriend, 'hiddenFriend']]) el.addEventListener('input', () => queue({ [k]: el.value }));

function renderCast() {
  els.cast.innerHTML = series.cast.length ? '' : '<span class="hint">No recurring characters. Add one to keep a guide or hero on every card.</span>';
  series.cast.forEach((c, i) => {
    const linked = characters.find((x) => x.id === c.characterId);
    const row = document.createElement('div'); row.className = 'cast-row' + (linked ? ' linked' : '');
    row.innerHTML = `<div class="cast-face">${linked?.refs[0] ? `<img src="${escapeHtml(linked.refs[0].thumbUrl)}" alt="">` : '<span>?</span>'}</div>
      <div class="cast-fields"><input data-c="name" value="${escapeHtml(c.name)}" placeholder="Name"><input data-c="role" value="${escapeHtml(c.role)}" placeholder="Role">
        <textarea data-c="description" placeholder="What they look like"${linked ? ' readonly' : ''}>${escapeHtml(c.description)}</textarea>
        <span class="hint c-note">${linked ? 'Linked to a studio character: drawn from its reference images.' : 'Text only: drawn from this description, so it may vary between cards.'}</span></div>
      <span class="cast-btns">${linked ? `<button class="btn secondary small" data-c="bible" type="button" title="Writes this character's profile from the story and draws a detailed production sheet: identity, personality, annotated portrait, design breakdown, scaled turnaround, expressions, palette, story portrait and on-model rules (one paid 2K picture)">📋 ${linked.bible ? 'Redo' : 'Make'} character bible</button>${linked.bible ? `<a class="link" href="/output/${encodeURIComponent(linked.bible.file)}" target="_blank">view bible</a>` : ''}` : '<button class="btn secondary small" data-c="sheet" type="button" title="Draws a clean master of this character from the cards it appears in, a clean turnaround sheet that every later card uses, and the detailed character bible (three paid pictures, about two minutes, ≈ $0.30)">🧍 Make character sheet</button>'}<button class="mini" data-c="remove" type="button">✕</button></span>`;
    row.addEventListener('input', (e) => { if (e.target.dataset.c) { series.cast[i][e.target.dataset.c] = e.target.value; queue({ cast: series.cast }); } });
    const bibleBtn = row.querySelector('[data-c=bible]');
    if (bibleBtn) bibleBtn.onclick = () => run(`Writing and drawing ${c.name}'s character bible (about a minute)`, async () => {
      await flush();
      const r = await api('POST', `/api/cards/series/${series.id}/cast/${c.id}/bible`, {});
      records.set(r.record.id, r.record); characters = await api('GET', '/api/characters'); renderCast();
      setStatus(`${escapeHtml(c.name)}'s character bible is ready. <a href="${escapeHtml(r.record.url)}" target="_blank">Open it</a>`, 'ok');
    });
    const sheetBtn = row.querySelector('[data-c=sheet]');
    if (sheetBtn) sheetBtn.onclick = () => run(`Drawing ${c.name}'s master, clean sheet and character bible (about two minutes)`, async () => {
      await flush();
      const r = await api('POST', `/api/cards/series/${series.id}/cast/${c.id}/sheet`);
      series = r.series; records.set(r.master.id, r.master); records.set(r.sheet.id, r.sheet); if (r.bible) records.set(r.bible.id, r.bible);
      characters = await api('GET', '/api/characters'); renderBriefChars(); renderCast();
      setStatus(`${escapeHtml(c.name)} now has a character sheet and is drawn from it on every new card. ${r.bible ? `<a href="${escapeHtml(r.bible.url)}" target="_blank">Open the character bible</a> · ` : ''}<a href="${escapeHtml(r.sheet.url)}" target="_blank">clean sheet</a>${r.bibleError ? ` (the detailed sheet failed: ${escapeHtml(r.bibleError)})` : ''}`, r.bibleError ? 'error' : 'ok');
    });
    row.querySelector('[data-c=remove]').onclick = () => { series.cast.splice(i, 1); queue({ cast: series.cast }); renderCast(); };
    els.cast.appendChild(row);
  });
}
els.foundation.addEventListener('input', (e) => { const k = e.target.dataset.f; if (!k || !series) return; series.foundation = { ...(series.foundation || {}), [k]: e.target.value }; queue({ foundation: { ...(pending.foundation || {}), [k]: e.target.value } }); });
els.addCast.addEventListener('click', () => { series.cast.push({ id: '', name: 'New character', role: '', description: '', characterId: null }); queue({ cast: series.cast }); renderCast(); });

function renderCards() {
  if (!series) return;
  const t = currentTemplate(), limit = audience().panelWords || 999;
  els.cardsMeta.textContent = t ? `template: ${t.name}${audience().panelWords ? ` · up to ${limit} words per panel for ages ${audience().id}` : ''}` : 'The template for this series is missing — choose one on the left.';
  els.cards.innerHTML = series.cards.map((c) => {
    const rec = records.get(c.imageId);
    const bySlot = new Map(c.slots.map((s) => [s.key, s]));
    const story = series.brief.kind === 'story';
    const extras = story ? `<div class="card-extras">${t?.variants?.length ? `<select data-k="layout" title="Changing the layout means rewriting the card">${t.variants.map((v) => `<option value="${v.id}"${v.id === variantOf(t, c).id ? ' selected' : ''}>${escapeHtml(v.label)}</option>`).join('')}</select>` : ''}
      <select data-k="play"><option value="">No play prompt</option>${config.cards.playTypes.map((p) => `<option${p === c.play ? ' selected' : ''}>${p}</option>`).join('')}</select>
      <input data-k="setting" value="${escapeHtml(c.setting || '')}" placeholder="Where it happens and this card's colours"></div>
      <div class="card-extras story-role"><select data-k="arc" title="Where this card sits in the story"><option value="">Story stage…</option>${config.cards.arcStages.map((a) => `<option value="${a}"${a === c.arc ? ' selected' : ''}>${a}</option>`).join('')}</select>
      <input data-k="feeling" value="${escapeHtml(c.feeling || '')}" placeholder="Feeling"><input data-k="purpose" value="${escapeHtml(c.purpose || '')}" placeholder="Why this card matters to the story"></div>
      <textarea class="card-state" data-k="state" rows="2" title="Sent with every picture of this card and checked by the proofreader" placeholder="Where everyone and everything is at the end of this card: who is where (and who cannot be seen), who holds what, what is blocked or open">${escapeHtml(c.state || '')}</textarea>` : '';
    const slots = slotsFor(t, c).map((s) => {
      const v = bySlot.get(s.key) || { heading: '', text: '', visual: '' }, max = Math.min(limit, s.maxWords || limit), n = words(v.text);
      const story = s.role === 'story-panel';
      return `<div class="card-slot" data-slot="${escapeHtml(s.key)}" data-max="${max}"><div class="s-label">${escapeHtml(s.label)}<small>${escapeHtml(s.position)}</small><span class="wc${n > max ? ' over' : ''}">${n}/${max} words</span></div>
        <div class="s-fields"><input data-s="heading" value="${escapeHtml(v.heading)}" placeholder="${story ? 'Caption' : 'Heading'}"><textarea data-s="text" placeholder="${story ? 'Speech bubble' : 'Text printed on the card'}">${escapeHtml(v.text)}</textarea>
          ${story ? `<textarea class="s-visual" data-s="visual" rows="3" placeholder="Picture brief: where, who is where, what each is doing, the state of the important things, camera">${escapeHtml(v.visual)}</textarea>
          <input class="s-shows" data-s="shows" value="${escapeHtml(Array.isArray(v.shows) ? v.shows.join(', ') : v.shows || '')}" placeholder="Who is drawn in this panel (names, comma separated) — everyone else is kept out" title="Only these characters are drawn in this panel; the proofreader fails a picture that shows anyone else">` : `<input class="s-visual" data-s="visual" value="${escapeHtml(v.visual)}" placeholder="Picture in this panel">`}</div></div>`;
    }).join('');
    const chips = series.cast.map((m) => `<span class="char-chip small${c.characters.includes(m.name) ? ' on' : ''}" data-cast="${escapeHtml(m.name)}">${escapeHtml(m.name)}</span>`).join('');
    return `<div class="page-card" data-id="${c.id}">
      <div class="page-art">${rec ? `<a href="${escapeHtml(rec.url)}" target="_blank"><img src="${escapeHtml(rec.thumbUrl || rec.url)}" alt=""></a>` : `<div class="art-empty">Card ${c.n}</div>`}
        ${c.imageIds.length > 1 ? `<div class="variants">${c.imageIds.map((id) => `<img class="${id === c.imageId ? 'on' : ''}" data-variant="${id}" src="${escapeHtml(recThumb(id))}" alt="">`).join('')}</div>` : ''}
        ${c.title ? `<button class="btn secondary small" data-act="image" type="button">${rec ? '↻ New version' : '🎨 Illustrate'}</button>` : ''}
        ${rec && c.draft ? '<span class="chip draft">Draft sketch</span>' : ''}
        ${rec && !c.draft ? (c.check && c.check.imageId === c.imageId ? (c.check.pass ? `<span class="proof ok" title="${escapeHtml((c.check.notes || []).join(' · '))}">✓ Proofread: words and pictures match${(c.check.notes || []).length ? ` · ${c.check.notes.length} small note${c.check.notes.length === 1 ? '' : 's'}` : ''}</span>` : `<div class="proof bad">⚠ Proofreader:<ul>${c.check.issues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><button class="mini" data-act="fix" type="button">Redraw fixing these</button></div>`) : '<button class="mini" data-act="check" type="button">Proofread this card</button>') : ''}
        ${rec ? `<span class="hint">${rec.costUsd ? fmtCost(rec.costUsd) : ''}</span>` : ''}</div>
      <div class="page-body">
        <div class="page-head"><b>Card ${c.n}</b>${c.chapter ? `<span class="chip">${escapeHtml(c.chapter)}</span>` : ''}<span class="spacer"></span><button class="mini" data-act="up" type="button">↑</button><button class="mini" data-act="down" type="button">↓</button><button class="mini" data-act="remove" type="button">✕</button></div>
        <div class="card-plan"><input data-k="topic" value="${escapeHtml(c.topic)}" placeholder="Topic"><input data-k="beat" value="${escapeHtml(c.beat)}" placeholder="${series.brief.kind === 'story' ? 'What happens' : 'Angle'}"></div>${extras}
        ${c.title ? `<div class="card-titles"><input class="c-title" data-k="title" value="${escapeHtml(c.title)}" placeholder="Title"><input data-k="subtitle" value="${escapeHtml(c.subtitle)}" placeholder="Subtitle"></div>
          <input data-k="tagline" value="${escapeHtml(c.tagline)}" placeholder="Tagline (optional)">
          ${t?.heroHint || c.hero ? `<textarea data-k="hero" rows="2" placeholder="Main picture">${escapeHtml(c.hero)}</textarea>` : ''}
          ${slots}
          ${story ? `<label class="field"><span>Story on the card <span class="hint">printed under the pictures when “Story on the card” is chosen in Picture settings · ${words(c.storyText)} words</span></span><textarea data-k="storyText" rows="2">${escapeHtml(c.storyText || '')}</textarea></label>` : ''}
          ${story ? `<label class="field narration"><span>Read aloud <span class="hint">the storyteller's text for this card (not printed on the front) · ${words(c.narration)} words</span></span><textarea data-k="narration" rows="4">${escapeHtml(c.narration || '')}</textarea></label>` : ''}
          <div class="card-titles"><textarea data-k="closing" rows="2" placeholder="Bottom line">${escapeHtml(c.closing)}</textarea><input data-k="source" value="${escapeHtml(c.source)}" placeholder="Source credit (optional)"></div>
          ${chips ? `<div class="p-chars">${chips}</div>` : ''}` : ''}
        <div class="rewrite"><input class="rw-input" placeholder="${c.title ? 'Rewrite: “shorter”, “add a counting fact”, “make panel 2 funnier”…' : 'Optional instructions for the writer'}"><button class="rw-chip rw-go" data-act="write" type="button">${c.title ? '✎ Rewrite' : '✎ Write this card'}</button></div>
        ${c.title ? '<details class="brief"><summary>Show the picture prompt</summary><pre class="p-prompt-text">Loading…</pre></details>' : ''}
      </div></div>`;
  }).join('');
}
const variantOf = (t, c) => (t?.variants?.length ? t.variants.find((v) => v.id === c.layout) || t.variants[0] : null);
const slotsFor = (t, c) => { const v = variantOf(t, c); return v ? [...v.slots, ...t.slots] : t?.slots || []; };
const cardOf = (el) => series.cards.find((c) => c.id === el.closest('.page-card')?.dataset.id);
els.cards.addEventListener('input', (e) => {
  const c = cardOf(e.target); if (!c) return;
  const slotEl = e.target.closest('.card-slot');
  if (slotEl && e.target.dataset.s) {
    let s = c.slots.find((x) => x.key === slotEl.dataset.slot);
    if (!s) { s = { key: slotEl.dataset.slot, heading: '', text: '', visual: '' }; c.slots.push(s); }
    s[e.target.dataset.s] = e.target.value;
    const wc = slotEl.querySelector('.wc'), n = words(s.text), max = Number(slotEl.dataset.max);
    wc.textContent = `${n}/${max} words`; wc.className = `wc${n > max ? ' over' : ''}`;
    queue({ cards: [{ id: c.id, slots: c.slots }] });
  } else if (e.target.dataset.k) { c[e.target.dataset.k] = e.target.value; queue({ cards: [{ id: c.id, [e.target.dataset.k]: e.target.value }] }); }
});
els.cards.addEventListener('click', async (e) => {
  const c = cardOf(e.target); if (!c) return;
  const variant = e.target.closest('[data-variant]'), chip = e.target.closest('[data-cast]'), act = e.target.closest('[data-act]')?.dataset.act;
  if (variant) { c.imageId = variant.dataset.variant; queue({ cards: [{ id: c.id, imageId: c.imageId }] }); return renderCards(); }
  if (chip) { const n = chip.dataset.cast; c.characters = c.characters.includes(n) ? c.characters.filter((x) => x !== n) : [...c.characters, n]; chip.classList.toggle('on'); return queue({ cards: [{ id: c.id, characters: c.characters }] }); }
  if (act === 'write') return write([c.id], e.target.closest('.rewrite').querySelector('input').value);
  if (act === 'image' || act === 'fix') return run(`Illustrating card ${c.n} (about a minute)`, async () => {
    await flush(); const r = await illustrate(c.id, act === 'fix' ? { fixNotes: c.check?.fixNotes || '' } : {}); renderSeries();
    setStatus(`Card ${c.n} illustrated.${r.check ? (r.check.pass ? ' The proofreader passed it.' : ' The proofreader still flags something — see ⚠ on the card.') : ''}`, r.check && !r.check.pass ? 'error' : 'ok');
  });
  if (act === 'check') return run(`Proofreading card ${c.n}`, async () => { await flush(); const r = await api('POST', `/api/cards/series/${series.id}/cards/${c.id}/check`, {}); series = r.series; renderSeries(); setStatus(r.check.pass ? `Card ${c.n}: words and pictures match the script.` : `Card ${c.n}: ${r.check.issues.length} thing${r.check.issues.length === 1 ? '' : 's'} flagged.`, r.check.pass ? 'ok' : 'error'); });
  if (act === 'up' || act === 'down' || act === 'remove') {
    if (act === 'remove' && !confirm(`Remove card ${c.n}${c.title ? ` “${c.title}”` : ''}? Its pictures stay in History.`)) return;
    await flush();
    series = await api('PATCH', `/api/cards/series/${series.id}`, act === 'remove' ? { removeCard: c.id } : { moveCard: { id: c.id, dir: act === 'up' ? -1 : 1 } });
    return renderSeries();
  }
});
els.cards.addEventListener('toggle', async (e) => {
  if (!e.target.matches('details.brief') || !e.target.open) return;
  const c = cardOf(e.target), pre = e.target.querySelector('pre');
  await flush();
  try { const r = await api('GET', `/api/cards/series/${series.id}/prompt/${c.id}`); pre.textContent = `${r.prompt}${r.references.length ? `\n\nReference images sent: ${r.references.join('; ')}` : ''}`; }
  catch (err) { pre.textContent = err.message; }
}, true);
els.addCard.addEventListener('click', async () => { await flush(); series = await api('PATCH', `/api/cards/series/${series.id}`, { addCardAfter: series.cards.length }); renderSeries(); });

// ---------- library controls ----------
els.tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { setStatus(''); setTab(b.dataset.tab); } });
els.analyzeNew.addEventListener('click', () => analyze([...images.values()].filter((im) => im.source === 'print' && !im.analysis).map((im) => im.id)));
els.analyzeSelected.addEventListener('click', () => analyze([...selected], true));
els.makeTemplate.addEventListener('click', () => makeTemplate([...selected]));
els.selNone.addEventListener('click', () => { selected.clear(); renderLibrary(); refreshButtons(); });
els.libFilter.addEventListener('change', renderLibrary);
els.libSearch.addEventListener('input', renderLibrary);
els.suggestGroups.addEventListener('click', () => run('Sorting your cards into families', async (onProgress) => {
  groups = (await streamApi('/api/cards/groups', {}, onProgress)).groups;
  renderGroups();
  setStatus(`Found ${groups.length} families. Create a template from any of them.`, 'ok');
}));
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && tab === 'series' && !busy) els.next.click(); });

// ---------- init ----------
(async function init() {
  try {
    config = await api('GET', '/api/config');
    els.topbar.textContent = config.hasApiKey ? `Cards read by ${config.cards.visionModel} · written by ${config.cards.model}` : '⚠ Add your OpenAI key to .env, then restart';
    fillSelect(els.audience, config.cards.audiences, 'template');
    fillSelect(els.imgModel, config.imageModels, config.defaultImageModel);
    fillSelect(els.imgQuality, config.qualities, 'high');
    fillSelect(els.imgSize, [{ id: '1024x1536', label: '1024 × 1536 — 2:3 portrait (upscale ×4 for print)' }, { id: '2048x3072', label: '2048 × 3072 — 2:3 portrait, 2K' }, { id: '1536x1024', label: '1536 × 1024 — 3:2 landscape' }, { id: '1024x1024', label: '1024 × 1024 — square' }], '1024x1536');
    const [chars, history] = await Promise.all([api('GET', '/api/characters'), api('GET', '/api/history'), loadLibrary()]);
    characters = chars; for (const r of history) records.set(r.id, r);
    await Promise.all([loadTemplates(), loadSeriesList()]);
    groups = (await api('GET', '/api/cards/groups')).groups;
    renderGroups();
    const last = localStorage.getItem(LAST_SERIES);
    if (urlState.any()) await applyUrl(true);
    else {
      if (last && seriesList.some((s) => s.id === last)) await openSeries(last); else { writeBrief(); onTemplateChosen(); }
      setTab(['library', 'templates', 'series'].includes(localStorage.getItem(LAST_TAB)) ? localStorage.getItem(LAST_TAB) : 'library');
    }
    refreshButtons();
    ready = true; syncUrl(); started = true;
    urlState.onChange(() => applyUrl().catch((e) => setStatus(escapeHtml(e.message), 'error')));
  } catch (e) { setStatus(escapeHtml(e.message), 'error'); }
})();
