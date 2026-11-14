const $ = (id) => document.getElementById(id);
const els = {
  shelf: $('shelf'), shelfGrid: $('shelf-grid'), shelfMeta: $('shelf-meta'), shelfSort: $('shelf-sort'), shelfChar: $('shelf-char'), workspace: $('workspace'), back: $('back'), subtabs: $('subtabs'),
  tabSetup: $('tab-setup'), tabStory: $('tab-story'), tabPages: $('tab-pages'), tabOutline: $('tab-outline'), tabPrompts: $('tab-prompts'), promptList: $('prompt-list'), promptSide: $('prompt-side'),
  setting: $('setting'), fillBrief: $('fill-brief'), briefGaps: $('brief-gaps'), storyline: $('storyline'), world: $('world'), arcBar: $('arc-bar'), arcLegend: $('arc-legend'),
  outline: $('outline'), outlineMeta: $('outline-meta'), fillDetails: $('fill-details'), bkHead: $('bk-head'), bkCover: $('bk-cover'), headLogline: $('head-logline'), headChips: $('head-chips'),
  readToggle: $('read-toggle'), toSheets: $('to-sheets'), fromSeries: $('from-series'), pageWarn: $('page-warn'),
  bookSelect: $('book-select'), newBook: $('new-book'), deleteBook: $('delete-book'),
  briefBox: $('brief-box'), suggest: $('suggest'), ideas: $('ideas'),
  premise: $('premise'), audience: $('audience'), pageCount: $('page-count'), tone: $('tone'), themeBrief: $('theme-brief'), style: $('style'), briefNotes: $('brief-notes'), briefChars: $('brief-chars'),
  artSummary: $('art-summary'), imgModel: $('img-model'), imgQuality: $('img-quality'), imgSize: $('img-size'), textInImage: $('text-in-image'), pageStyle: $('page-style'), pageStyleHint: $('page-style-hint'), proof: $('proof'), refs: $('refs'), leanRefs: $('lean-refs'), draftFirst: $('draft-first'), worldSheet: $('world-sheet'), refrain: $('refrain'), device: $('device'), shotBar: $('shot-bar'), editPass: $('edit-pass'), editBox: $('edit-box'), logic: $('logic'), checkLogic: $('check-logic'), logicBox: $('logic-box'),
  stepper: $('stepper'), next: $('next'), stop: $('stop'), undo: $('undo'), saveState: $('save-state'), status: $('status'), strip: $('strip'), topbar: $('topbar-meta'),
  progress: $('progress'), progressPhase: $('progress-phase'), progressTime: $('progress-time'), progressBar: $('progress-bar'), progressSnippet: $('progress-snippet'),
  empty: $('empty'), book: $('book'), editor: $('editor'), title: $('title'), logline: $('logline'), theme: $('theme'), styleGuide: $('style-guide'),
  outlineInstructions: $('outline-instructions'), redraft: $('redraft'), exportMd: $('export-md'), addCast: $('add-cast'), cast: $('cast'), pages: $('pages'), pagesMeta: $('pages-meta'), preview: $('preview'), readBar: $('read-bar'), script: $('script'), scriptBody: $('script-body'), readText: $('read-text'), dlImages: $('dl-images'), dlStory: $('dl-story'), dlHint: $('dl-hint'),
};

let config = null;
let book = null;
let books = [];
let characters = [];
const records = new Map();   // history records by id (page images, cost estimates)
let busy = false;
let reading = false;         // preview mode
let creating = false;        // the brief of a book that does not exist yet is on screen
let subtab = 'pages';        // outline | pages | prompts | story | setup
const SUBTABS = ['outline', 'pages', 'prompts', 'story', 'setup'];
let stopRequested = false;
const LAST_KEY = 'dadventures.lastBook';
let focusPage = null;        // 'cover' or a page number: the page the link points at
const QUICK_REWRITES = [['Shorter', 'Make it shorter.'], ['Simpler words', 'Use simpler words for the youngest readers in the audience.'], ['Funnier', 'Make it funnier.'], ['Rhyme', 'Make it rhyme with a read-aloud rhythm.'], ['More feeling', 'Show more of how the character feels.'], ['Add dialogue', 'Add a line of dialogue.']];

// ---------- utils (same conventions as app.js) ----------
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const fmtCost = (v) => (v == null ? '' : `$${v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`);
const words = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
function setStatus(text, kind = '') { els.status.className = `status ${kind}`; els.status.innerHTML = text; }
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}
// POST to a streaming endpoint: NDJSON {progress} lines, then {done} or {error}.
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
function fillSelect(sel, items, selected) {
  sel.innerHTML = '';
  for (const it of items) { const o = document.createElement('option'); o.value = typeof it === 'string' ? it : it.id; o.textContent = typeof it === 'string' ? it : it.label; sel.appendChild(o); }
  if (selected != null && [...sel.options].some((o) => o.value === selected)) sel.value = selected;
}
const storyPages = () => (book ? book.pages.filter((p) => p.kind === 'page') : []);
const pageLabel = (p) => (p.kind === 'cover' ? 'Cover' : `Page ${p.n}`);
const audience = () => config.books.ageBands.find((a) => a.id === (book?.brief.audience || els.audience.value)) || config.books.ageBands[1];
// Planning notes every story page should have before its text and picture are made.
const PLAN_FIELDS = [['beat', 'what happens'], ['arc', 'arc stage'], ['purpose', 'purpose'], ['setting', 'setting'], ['emotion', 'feeling'], ['state', 'where things stand']];
// A Flash Cards copy is read-only here and may have no state: do not count that as a blank to fill in.
const planGaps = (p) => PLAN_FIELDS.filter(([k]) => !p[k] && !(k === 'state' && book?.fromSeries)).length;
const outlineGaps = () => storyPages().reduce((n, p) => n + planGaps(p), 0) + (book ? config.books.storyline.filter((f) => !storyline()[f.id]).length + (book.world || !config.books.storyline.length ? 0 : 1) : 0);
// A server started before the outline carried planning notes sends books without them; treat those as blank.
const storyline = () => (book.storyline ||= {});
const arcStage = (id) => config.books.arcStages.find((a) => a.id === id);
const shotOf = (id) => (config.books.shots || []).find((x) => x.id === id);
// Edits update the open book right away so the other tabs show them; the PATCH follows.
function setPage(id, patch) { const p = book.pages.find((x) => x.id === id); if (p) Object.assign(p, patch); queue({ pages: [{ id, ...patch }] }); }
const BRIEF_DETAILS = [['tone', 'tone'], ['themeBrief', 'theme'], ['setting', 'setting'], ['style', 'illustration style'], ['briefNotes', 'notes for the writer']];
const briefBlanks = () => BRIEF_DETAILS.filter(([el]) => !els[el].value.trim());
function renderBriefGaps() {
  const blanks = briefBlanks();
  els.fillBrief.hidden = !blanks.length;
  els.fillBrief.disabled = busy || !els.premise.value.trim();
  els.briefGaps.textContent = !blanks.length ? '✓ Every detail is filled in.' : `Blank: ${blanks.map(([, label]) => label).join(', ')}. Type them, let ✨ suggest them, or leave them for the outline to decide.`;
}
const missingPictures = () => (book ? book.pages.filter((p) => !p.imageId && (p.illustration || p.beat)) : []);

// Average cost of earlier images with the same model, size and quality; null when there is nothing to go on.
function estimateImageCost(model, size, quality) {
  const same = [...records.values()].filter((r) => r.kind === 'generated' && r.model === model && r.size === size && r.quality === quality && r.costUsd);
  return same.length ? same.reduce((s, r) => s + r.costUsd, 0) / same.length : null;
}

// ---------- URL state: the shelf, each book, its tab, reading mode and a page all have their own link ----------
// A bare /books.html reopens the last book. ?view=shelf is the shelf, ?book=<id> a book, ?book=new a blank brief.
let ready = false, started = false, applying = false;
const pageKey = (p) => (p.kind === 'cover' ? 'cover' : String(p.n));
function syncUrl() {
  if (!ready || applying) return;
  const outlined = Boolean(book?.pages.length);
  urlState.set(
    { book: book ? book.id : creating ? 'new' : '', view: !book && !creating ? 'shelf' : reading ? 'read' : '', tab: outlined && !reading ? subtab : '', page: book ? focusPage : '' },
    { defaults: { tab: 'pages' }, pushOn: started && urlState.get('book') !== 'new' ? ['book', 'view', 'tab'] : [] });
}
async function applyUrl() {
  applying = true;
  try {
    const id = urlState.get('book');
    if (id === 'new') { if (!creating) await newBook(); }
    else if (id && books.some((b) => b.id === id)) { if (book?.id !== id) await openBook(id); }
    else if (book || creating) await closeBook();
    if (book) {
      const t = urlState.get('tab');
      subtab = SUBTABS.includes(t) ? t : 'pages';
      reading = urlState.get('view') === 'read' && book.pages.length > 0;
      focusPage = urlState.get('page');
    }
    renderAll();
    const target = focusPage && book?.pages.find((p) => pageKey(p) === focusPage);
    if (target) goToPage(target);
  } finally { applying = false; }
  syncUrl();
}
function goToPage(p) {
  if (reading) { els.preview.querySelector(`[data-id="${p.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  const card = (subtab === 'outline' ? els.outline : els.pages).querySelector(`[data-id="${p.id}"]`);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.classList.add('flash'); setTimeout(() => card?.classList.remove('flash'), 1200);
}

// ---------- progress panel ----------
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

// ---------- autosave: collect edits, flush as one PATCH ----------
let pending = {};
let saveTimer = null;
function setSave(text, kind = '') { els.saveState.textContent = text; els.saveState.className = `save-state ${kind}`; }
function queue(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'pages') {
      pending.pages = pending.pages || {};
      for (const pp of v) pending.pages[pp.id] = { ...(pending.pages[pp.id] || {}), ...pp };
    } else if (k === 'brief' || k === 'image' || k === 'storyline') pending[k] = { ...(pending[k] || {}), ...v };
    else pending[k] = v;
  }
  setSave('Unsaved changes…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 600);
}
async function flush() {
  clearTimeout(saveTimer);
  if (!book || !Object.keys(pending).length) return;
  const body = { ...pending, ...(pending.pages ? { pages: Object.values(pending.pages) } : {}) };
  pending = {};
  setSave('Saving…');
  try { book = await api('PATCH', `/api/books/${book.id}`, body); setSave('All changes saved', 'ok'); refreshFlow(); }
  catch (e) { setSave(`Not saved: ${e.message}`, 'error'); }
}
window.addEventListener('beforeunload', (e) => { if (Object.keys(pending).length) { flush(); e.preventDefault(); } });

// ---------- pages in fours ----------
// The cover prints with page 1 on its back, so the cover plus the pages come in fours (3, 7, 11, 15 … story pages) and the
// book prints double-sided with every back filled (15 pages + cover = two Tabloid 2x2 sheets). Editing can leave it off by a
// few; the book then says how many pages to add or remove.
const PAGE_STEP = 4;
const snapFours = (n) => Math.min(31, Math.max(PAGE_STEP - 1, Math.ceil(((Number(n) || 0) + 1) / PAGE_STEP) * PAGE_STEP - 1));
function fourHint(n, what = 'story page') {
  const over = (n + 1) % PAGE_STEP;
  if (!n || !over) return '';
  const add = PAGE_STEP - over;
  return `This book has ${n} ${what}${n === 1 ? '' : 's'} plus the cover. The cover and pages print in fours (3, 7, 11, 15 … pages) so every back is filled: add ${add} page${add === 1 ? '' : 's'}${n > over ? ` or remove ${over}` : ''}.`;
}
function renderPageWarn(b) {
  const n = b ? b.pages.filter((p) => p.kind === 'page').length : 0;
  const msg = fourHint(n);
  els.pageWarn.hidden = !msg;
  els.pageWarn.textContent = msg ? `${msg}${b.fromSeries ? ' Do it in Flash Cards → Series, where this story is made.' : ''}` : '';
}

// ---------- Print Sheets ----------
// A quarter of a Letter sheet is 4.25 × 5.5 in (17:22). Pictures of that shape tile a Letter sheet 2 × 2 with nothing left over.
const isQuarterLetter = (r) => Boolean(r?.width && r?.height) && Math.abs(Math.min(r.width, r.height) / Math.max(r.width, r.height) - 17 / 22) < 0.01;
const QUARTER_LETTER_SHEET = { page: 'letter', margin: 0, gutter: 0, fit: 'cover', backFit: 'cover', cutMarks: false, pack: false };
// The largest live version of a picture: its upscale when there is one, else the picture itself.
function printRecord(id) {
  if (!id) return null;
  const ok = (r) => r && !r.deletedAt && !r.missing;
  const up = [...records.values()].filter((r) => r.upscaleOf === id && ok(r)).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return up || (ok(records.get(id)) ? records.get(id) : null);
}
// Double-sided book layout: the cover has page 1 on its back, then each piece carries the next two pages back to back
// (2 on the front, 3 behind it; 4 and 5 on the next), so a stack of cut pieces reads like a book. Chapter title
// pictures take their place in the reading order.
function bookPieces(b) {
  const seq = []; let ch = '';
  for (const p of b.pages) {
    if (p.kind !== 'page') continue;
    if (p.chapter && p.chapter !== ch) { ch = p.chapter; if (b.chapterArt?.[ch]) seq.push({ id: b.chapterArt[ch], label: `the “${ch}” chapter card` }); }
    seq.push({ id: p.imageId, label: `page ${p.n}` });
  }
  const missing = seq.filter((x) => !printRecord(x.id)).map((x) => x.label);
  const ref = (id) => ({ source: 'output', rel: printRecord(id).file });
  const cover = b.pages.find((p) => p.kind === 'cover');
  const hasCover = Boolean(cover && printRecord(cover.imageId));
  const faces = [...(hasCover ? [{ id: cover.imageId }] : []), ...seq];
  const items = [];
  if (!missing.length) for (let i = 0; i < faces.length; i += 2) items.push({ ...ref(faces[i].id), copies: 1, back: faces[i + 1] ? ref(faces[i + 1].id) : null });
  return { items, missing, pages: seq.length, hasCover };
}
async function sendToSheets() {
  if (!book) return;
  await flush();
  const { items, missing, pages, hasCover } = bookPieces(book);
  if (missing.length) return setStatus(`Every page needs a picture before the book can be printed back to back. Still missing: ${escapeHtml(missing.slice(0, 6).join(', '))}${missing.length > 6 ? ` and ${missing.length - 6} more` : ''}.`, 'error');
  if (!pages) return setStatus('This book has no pages yet.', 'error');
  const faces = pages + (hasCover ? 1 : 0);
  if (faces % PAGE_STEP && !confirm(`${hasCover ? fourHint(pages, 'printed page') : `This book has ${pages} printed pages and no cover picture yet; pages print in fours so every back is filled.`}${faces % 2 ? ' As it is, the last piece prints with a blank back.' : ''}\n\nSend it to Print Sheets anyway?`)) return;
  const first = printRecord(book.pages.find((p) => p.kind === 'page')?.imageId);
  const orientation = first && first.width > first.height ? 'landscape' : 'portrait';
  // Pages drawn in the quarter-Letter shape go four to a Letter sheet with no margin and no gap; any other shape keeps the Tabloid sheet with gaps.
  const faceIds = [...(hasCover ? [book.pages.find((p) => p.kind === 'cover').imageId] : []), ...book.pages.filter((p) => p.kind === 'page').map((p) => p.imageId)];
  const paper = faceIds.every((id) => isQuarterLetter(printRecord(id))) ? QUARTER_LETTER_SHEET : { page: 'tabloid' };
  const spec = { ...config.sheets.defaults, ...paper, orientation, grid: '2x2', duplex: true, flip: 'long', items };
  try {
    const sheet = await api('POST', '/api/sheets', { name: `${book.title || 'Story book'} (book, double-sided)`, spec });
    localStorage.setItem('dadventures.sheetDraft', JSON.stringify({ sheetId: sheet.id, name: sheet.name, spec: sheet.spec }));
    setStatus(`Sent ${pages} page${pages === 1 ? '' : 's'}${hasCover ? ' and the cover' : ''} to Print Sheets.`, 'ok');
    location.href = `/sheets.html?sheet=${encodeURIComponent(sheet.id)}`;
  } catch (e) { setStatus(escapeHtml(e.message), 'error'); }
}

// ---------- book list ----------
async function loadBooks() {
  books = await api('GET', '/api/books');
  els.bookSelect.innerHTML = '<option value="">Open a book…</option>';
  for (const b of books) {
    const o = document.createElement('option'); o.value = b.id;
    o.textContent = `${b.title}${b.pages ? ` · ${b.scripted}/${b.pages} written · ${b.illustrated}/${b.pages + 1} pictures` : ' · idea only'}`;
    els.bookSelect.appendChild(o);
  }
  els.bookSelect.value = book?.id || '';
  // A server started before the list carried cast names: read each book once for its cast.
  if (books.some((b) => !Array.isArray(b.cast))) await Promise.all(books.map(async (b) => {
    if (Array.isArray(b.cast)) return;
    const full = await api('GET', `/api/books/${b.id}`).catch(() => null);
    b.cast = (full?.cast || []).map((c) => String(c?.name || '').trim()).filter(Boolean);
  }));
  if (!book && !creating) renderShelf();
}
const bookFinished = (b) => Boolean(b.pages) && b.scripted >= b.pages && b.illustrated >= b.pages + 1;
// Shelf order and character filter are remembered on this browser.
const SHELF_KEY = 'dadventures.shelf';
const shelfPrefs = (() => { try { return { sort: 'progress', char: '', ...JSON.parse(localStorage.getItem(SHELF_KEY) || '{}') }; } catch { return { sort: 'progress', char: '' }; } })();
const plain = (t) => t.replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"');   // curly and straight quotes sort together
const byText = (a, z) => plain(a).localeCompare(plain(z), undefined, { sensitivity: 'base', numeric: true });
const castOf = (b) => (Array.isArray(b.cast) ? b.cast : []);
const SHELF_SORTS = {
  // Books still being made come first: they are what you came back for. Within each half, the latest edit first (the server's order).
  progress: (list) => [...list.filter((b) => !bookFinished(b)), ...list.filter(bookFinished)],
  updated: (list) => [...list].sort((a, z) => (z.updatedAt || '').localeCompare(a.updatedAt || '')),
  created: (list) => [...list].sort((a, z) => (z.createdAt || '').localeCompare(a.createdAt || '')),
  'created-asc': (list) => [...list].sort((a, z) => (a.createdAt || '').localeCompare(z.createdAt || '')),
  title: (list) => [...list].sort((a, z) => byText(a.title || '', z.title || '')),
};
function shelfGroups(list) {
  if (shelfPrefs.sort !== 'character') return [{ name: '', books: (SHELF_SORTS[shelfPrefs.sort] || SHELF_SORTS.progress)(list) }];
  // One shelf per lead character (the first in the cast); when filtering, the chosen character leads. Newest first within a shelf.
  const groups = new Map();
  for (const b of SHELF_SORTS.created(list)) {
    const lead = (shelfPrefs.char && castOf(b).includes(shelfPrefs.char) ? shelfPrefs.char : castOf(b)[0]) || '';
    if (!groups.has(lead)) groups.set(lead, []);
    groups.get(lead).push(b);
  }
  return [...groups].map(([name, books]) => ({ name: name || 'No characters', books }))
    .sort((a, z) => (a.name === 'No characters') - (z.name === 'No characters') || byText(a.name, z.name));
}
function renderShelfTools() {
  const names = [...new Set(books.flatMap(castOf))].sort(byText);
  if (shelfPrefs.char && !names.includes(shelfPrefs.char)) shelfPrefs.char = '';
  els.shelfChar.innerHTML = '<option value="">Everyone</option>' + names.map((n) => {
    const count = books.filter((b) => castOf(b).includes(n)).length;
    return `<option value="${escapeHtml(n)}">${escapeHtml(n)} (${count})</option>`;
  }).join('');
  els.shelfChar.value = shelfPrefs.char;
  els.shelfChar.closest('.shelf-pick').hidden = !names.length;
  els.shelfSort.value = SHELF_SORTS[shelfPrefs.sort] || shelfPrefs.sort === 'character' ? shelfPrefs.sort : 'progress';
}
function setShelfPref(k, v) {
  shelfPrefs[k] = v;
  localStorage.setItem(SHELF_KEY, JSON.stringify(shelfPrefs));
  renderShelf();
}
function shelfBook(b) {
    const cover = b.coverImageId && imageUrl(b.coverImageId);
    const total = b.pages ? b.pages + 1 : 0;
    const done = bookFinished(b);
    const state = !b.pages ? 'Idea only' : b.scripted < b.pages ? `Writing · ${b.scripted}/${b.pages} pages` : !done ? `Illustrating · ${b.illustrated}/${total} pictures` : `${b.pages} pages`;
    return `<button class="shelf-book${done ? ' done' : ''}" data-id="${b.id}" type="button">
      <span class="shelf-cover">${cover ? `<img loading="lazy" src="${cover}" alt="">` : `<span class="shelf-blank">${escapeHtml((b.title || '?').slice(0, 1))}</span>`}${b.fromSeries ? '<span class="shelf-tag">Flash Cards</span>' : ''}</span>
      <b>${escapeHtml(b.title)}</b>
      <span class="shelf-state">${state}</span>
      ${total && !done ? `<span class="bar"><i style="width:${Math.round((100 * b.illustrated) / total)}%"></i></span>` : ''}</button>`;
}
function renderShelf() {
  renderShelfTools();
  const shown = shelfPrefs.char ? books.filter((b) => castOf(b).includes(shelfPrefs.char)) : books;
  els.shelfMeta.textContent = !books.length ? ''
    : shelfPrefs.char ? `${shown.length} of ${books.length} books with ${shelfPrefs.char} · click one to open it`
    : `${books.length} book${books.length === 1 ? '' : 's'} · click one to open it`;
  const newTile = `<button class="shelf-book shelf-new" id="shelf-new" type="button"><span class="shelf-cover"><span class="shelf-blank">+</span></span><b>New book</b><span class="shelf-state">Start from an idea</span></button>`;
  const groups = shelfGroups(shown);
  els.shelfGrid.innerHTML = groups.map((g, i) => (g.name ? `<h2 class="shelf-group">${escapeHtml(g.name)} <span class="hint">${g.books.length}</span></h2>` : '')
    + g.books.map(shelfBook).join('') + (i === groups.length - 1 ? newTile : '')).join('') || newTile;
}
async function closeBook() {
  await flush();
  book = null; creating = false; reading = false; focusPage = null;
  localStorage.removeItem(LAST_KEY);
  setStatus(''); setSave('');
  await loadBooks(); renderAll();
  window.scrollTo({ top: 0 });
}
async function openBook(id) {
  await flush();
  creating = false; subtab = 'pages'; focusPage = null;
  book = id ? await api('GET', `/api/books/${id}`) : null;
  if (book) localStorage.setItem(LAST_KEY, book.id); else localStorage.removeItem(LAST_KEY);
  reading = false; els.ideas.hidden = true;
  renderAll();
}
async function newBook() {
  await flush();
  book = null; reading = false; creating = true; focusPage = null;
  localStorage.removeItem(LAST_KEY);
  for (const el of [els.premise, els.tone, els.themeBrief, els.setting, els.style, els.briefNotes]) el.value = '';
  els.pageCount.value = 12; briefChars.clear(); els.ideas.hidden = true;
  setStatus(''); setSave('');
  renderAll();
  els.premise.focus();
}
async function deleteBook() {
  if (!book) return;
  if (!confirm(`Delete “${book.title || 'this book'}”? Its pictures stay in your image History.`)) return;
  try { await api('DELETE', `/api/books/${book.id}`); pending = {}; book = null; await closeBook(); }
  catch (e) { setStatus(`Delete failed: ${e.message}`, 'error'); }
}

function briefFromForm() {
  return { premise: els.premise.value, audience: els.audience.value, pageCount: snapFours(Number(els.pageCount.value) || 11), tone: els.tone.value, theme: els.themeBrief.value, setting: els.setting.value, style: els.style.value, notes: els.briefNotes.value, characterIds: [...briefChars] };
}
const imageFromForm = () => ({ model: els.imgModel.value, quality: els.imgQuality.value, size: els.imgSize.value, textInImage: els.textInImage.checked, proof: els.proof.checked, refs: els.refs.checked, leanRefs: els.leanRefs.checked, draftFirst: els.draftFirst.checked, pageStyle: els.pageStyle.value || 'classic' });
// Page types: a designed style gives each page a layout of panels with captions and boxes (see src/books.js PAGE_STYLES).
const pageStyle = () => book?.image.pageStyle || 'classic';
const isDesigned = () => pageStyle() !== 'classic';
const layoutOf = (id) => (config.books.layouts || []).find((l) => l.id === id);
const undesigned = () => storyPages().filter((p) => (p.text || p.beat) && !p.design);
function renderPageStyleHint() { els.pageStyleHint.textContent = (config.books.pageStyles || []).find((x) => x.id === els.pageStyle.value)?.hint || ''; }
// Create the book on its first AI step, or save the brief and settings of the open one.
async function ensureBook() {
  if (book) { queue({ brief: briefFromForm(), image: imageFromForm() }); await flush(); return book; }
  book = await api('POST', '/api/books', { brief: briefFromForm(), image: imageFromForm() });
  localStorage.setItem(LAST_KEY, book.id);
  await loadBooks();
  return book;
}

// ---------- the guided flow ----------
function flowState() {
  const pages = storyPages();
  const written = pages.filter((p) => p.text).length;
  const pictured = book ? book.pages.filter((p) => p.imageId).length : 0;
  const all = pages.length + (pages.length ? 1 : 0);
  const promptable = book ? book.pages.filter((p) => p.illustration || p.beat) : [];
  const prompted = promptable.filter((p) => p.imagePrompt).length, stale = promptable.filter((p) => p.promptStale).length;
  return { pages: pages.length, written, pictured, all, promptable: promptable.length, prompted, stale, promptsDone: promptable.length > 0 && prompted === promptable.length, gaps: pages.length ? outlineGaps() : 0, outlined: pages.length > 0, scripted: pages.length > 0 && written === pages.length, illustrated: all > 0 && pictured === all };
}
function nextAction() {
  const s = flowState();
  if (!s.outlined) return { step: 'outline', label: 'Draft the outline', run: draftOutline, disabled: !els.premise.value.trim() };
  if (!s.scripted) return { step: 'scripts', label: s.written ? `Write the remaining ${s.pages - s.written} pages` : 'Write the page text', run: () => writeScripts(true) };
  const missing = missingPictures().length;
  // A designed page style: pages get their layouts, captions and boxes before their prompts are written.
  const toDesign = isDesigned() ? undesigned().length : 0;
  if (toDesign) return { step: 'prompts', label: `🧩 Design ${toDesign === s.pages ? 'the pages' : `${toDesign} more page${toDesign > 1 ? 's' : ''}`} (layouts, captions, play boxes)`, run: () => designPages() };
  // Pictures cost money and prompts do not, so the prompts are written out and checked before anything is drawn.
  if (missing && !s.promptsDone) return { step: 'prompts', label: s.prompted ? `Write the remaining ${s.promptable - s.prompted} picture prompts` : 'Write the picture prompts', run: () => writePrompts() };
  if (missing) {
    const each = estimateImageCost(book.image.model, book.image.size, book.image.quality);
    return { step: 'images', label: `Illustrate ${missing} page${missing > 1 ? 's' : ''}${each ? ` (≈ ${fmtCost(each * missing)})` : ''}`, run: illustrateMissing };
  }
  return { step: 'read', label: reading ? '✎ Back to editing' : '📖 Read the book', run: toggleReading };
}
function refreshFlow() {
  const s = flowState();
  const act = nextAction();
  const info = {
    outline: s.outlined ? `${s.pages} pages${s.gaps ? ` · ${s.gaps} blank` : ' planned'}` : 'idea → plan',
    scripts: s.outlined ? `${s.written}/${s.pages} written` : '',
    prompts: !s.scripted ? '' : !s.prompted && s.illustrated ? 'pictures already drawn' : `${s.prompted}/${s.promptable} ready${s.stale ? ` · ${s.stale} out of date` : ''}`,
    images: s.outlined ? `${s.pictured}/${s.all} pictures` : '',
    read: s.illustrated ? 'ready' : '',
  };
  const done = { outline: s.outlined, scripts: s.scripted, prompts: s.promptsDone || s.illustrated, images: s.illustrated, read: false };
  const reachable = { outline: true, scripts: s.outlined, prompts: s.promptable > 0, images: s.outlined, read: s.outlined };
  for (const li of els.stepper.children) {
    const k = li.dataset.step;
    li.className = [done[k] ? 'done' : '', act.step === k ? 'current' : '', reachable[k] ? '' : 'locked', k === 'read' && reading ? 'current' : ''].join(' ');
    li.querySelector('small').textContent = info[k];
    li.title = { outline: s.outlined ? 'Re-draft the outline (undo is available)' : 'Plan the story', scripts: 'Write the text for every page', prompts: 'Read and edit every picture prompt before anything is drawn', images: 'Illustrate pages that have no picture yet', read: 'Read the book page by page' }[k];
  }
  els.next.textContent = act.label;
  els.next.disabled = busy || act.disabled;
  els.undo.hidden = !book?.undoLabel || busy;
  els.undo.textContent = book?.undoLabel ? `↶ Undo: ${book.undoLabel.toLowerCase()}` : '↶ Undo';
  els.redraft.disabled = busy; els.suggest.disabled = busy; els.fillDetails.disabled = busy;
  renderBriefGaps();
  if (s.outlined) {
    els.fillDetails.hidden = !s.gaps;
    els.outlineMeta.textContent = s.gaps ? `· ${s.gaps} planning note${s.gaps === 1 ? '' : 's'} still blank (outlined in amber)` : '· every page is fully planned ✓';
  }
  for (const b of els.pages.querySelectorAll('.p-image, .rw-go, .rw-chip, .p-layout, .d-make')) b.disabled = busy;
  for (const b of els.tabPrompts.querySelectorAll('button:not([data-f])')) b.disabled = busy;
  const spend = book ? book.pages.flatMap((p) => p.imageIds).reduce((sum, id) => sum + (records.get(id)?.costUsd || 0), 0) : 0;
  if (s.outlined && book) renderHead();
  syncHead();
  const range = audience().words, offPages = isDesigned() ? [] : storyPages().filter((p) => p.text && (words(p.text) < range[0] || words(p.text) > range[1])).map((p) => p.n);
  els.pagesMeta.textContent = s.outlined ? `${s.written}/${s.pages} written · ${s.pictured}/${s.all} pictures · picture spend ≈ ${fmtCost(spend)}${offPages.length ? ` · ⚠ page${offPages.length === 1 ? '' : 's'} ${offPages.join(', ')} outside ${range[0]}–${range[1]} words` : ''}` : '';
  els.editPass.disabled = busy; els.editPass.hidden = !s.written || Boolean(book?.fromSeries);
  for (const b of els.worldSheet.querySelectorAll('button')) b.disabled = busy;
  renderStrip();
}
function setBusy(on) { busy = on; refreshFlow(); }

function renderStrip() {
  els.strip.innerHTML = '';
  if (!book?.pages.length) return;
  for (const p of book.pages) {
    const d = document.createElement('button');
    d.type = 'button';
    const img = p.imageId && imageUrl(p.imageId);
    d.className = 'tile' + (p.imageId ? ' pictured' : p.text || p.kind === 'cover' ? ' written' : '');
    d.title = `${pageLabel(p)} — ${p.imageId ? 'has a picture' : p.text ? 'written, no picture' : 'not written yet'}`;
    d.innerHTML = img ? `<img src="${img}" alt=""><span>${p.kind === 'cover' ? 'C' : p.n}</span>` : `<span>${p.kind === 'cover' ? 'C' : p.n}</span>`;
    d.addEventListener('click', () => { focusPage = pageKey(p); syncUrl(); goToPage(p); });
    els.strip.appendChild(d);
  }
}

// ---------- rendering ----------
const briefChars = new Set();
function renderBriefChars() {
  els.briefChars.innerHTML = characters.length ? '' : '<span class="hint">None yet — after outlining, 🎨 Design character turns any cast member into one.</span>';
  for (const c of characters) {
    const chip = document.createElement('span');
    chip.className = 'char-chip' + (briefChars.has(c.id) ? ' on' : '');
    chip.title = c.description || '';
    chip.innerHTML = `${c.refs[0] ? `<img src="${c.refs[0].thumbUrl}" alt="">` : '<img alt="">'}<span>${escapeHtml(c.name)}</span>`;
    chip.addEventListener('click', () => { if (briefChars.has(c.id)) briefChars.delete(c.id); else briefChars.add(c.id); renderBriefChars(); if (book) queue({ brief: { characterIds: [...briefChars] } }); });
    els.briefChars.appendChild(chip);
  }
}
function renderArtSummary() {
  const each = estimateImageCost(els.imgModel.value, els.imgSize.value, els.imgQuality.value);
  els.artSummary.textContent = `· ${els.imgSize.value} · ${els.imgQuality.value}${each ? ` · ≈ ${fmtCost(each)}/picture` : ''}`;
}

function renderAll() {
  const b = book;
  if (b) {
    els.premise.value = b.brief.premise; els.audience.value = b.brief.audience; els.pageCount.value = b.brief.pageCount;
    els.tone.value = b.brief.tone; els.themeBrief.value = b.brief.theme; els.setting.value = b.brief.setting || ''; els.style.value = b.brief.style; els.briefNotes.value = b.brief.notes;
    briefChars.clear(); for (const id of b.brief.characterIds) briefChars.add(id);
    els.imgModel.value = b.image.model; els.imgQuality.value = b.image.quality; els.textInImage.checked = b.image.textInImage; els.proof.checked = b.image.proof !== false; els.refs.checked = b.image.refs !== false; els.leanRefs.checked = Boolean(b.image.leanRefs); els.draftFirst.checked = b.image.draftFirst !== false;
    els.pageStyle.value = b.image.pageStyle || 'classic'; renderPageStyleHint();
    if (![...els.imgSize.options].some((o) => o.value === b.image.size)) fillSelect(els.imgSize, [...config.sizePresets, { id: b.image.size, label: b.image.size }], b.image.size);
    els.imgSize.value = b.image.size;
  }
  renderBriefChars(); renderArtSummary();
  els.bookSelect.value = b?.id || '';
  const outlined = Boolean(b?.pages.length);
  const working = Boolean(b) || creating;
  els.shelf.hidden = working; els.workspace.hidden = !working;
  if (!working) { renderShelf(); syncHead(); syncUrl(); return; }
  els.empty.hidden = outlined; els.book.hidden = !outlined;
  els.deleteBook.hidden = !b;
  // Before the outline exists the brief is the page; afterwards the pages are, with the rest one click away.
  const tab = !outlined ? 'setup' : reading ? '' : subtab;
  els.subtabs.hidden = !outlined || reading;
  for (const t of els.subtabs.children) t.classList.toggle('on', t.dataset.sub === tab);
  els.tabSetup.hidden = tab !== 'setup'; els.tabStory.hidden = tab !== 'story'; els.tabPages.hidden = tab !== 'pages'; els.tabOutline.hidden = tab !== 'outline'; els.tabPrompts.hidden = tab !== 'prompts';
  els.bkHead.hidden = !outlined;
  els.readToggle.textContent = reading ? '✎ Edit' : '📖 Read';
  renderPageWarn(b);
  els.fromSeries.hidden = !b?.fromSeries;
  if (b?.fromSeries) els.fromSeries.innerHTML = `This book is a copy of a Flash Cards story and is refreshed whenever that story changes. Edit it in <a href="/cards.html?tab=series&series=${encodeURIComponent(b.fromSeries)}">Flash Cards → Series</a>: the story, its text and its plan are overwritten from there. Pictures drawn here, page designs you edit here and the picture settings are kept.`;
  if (outlined) renderHead();
  els.suggest.textContent = els.premise.value.trim() ? '✨ Develop this idea' : '✨ Suggest ideas';
  if (outlined) {
    els.title.value = b.title; els.logline.value = b.logline; els.theme.value = b.theme; els.styleGuide.value = b.styleGuide;
    els.exportMd.href = `/api/books/${b.id}/export.md`;
    els.editor.hidden = reading; els.preview.hidden = !reading; els.readBar.hidden = !reading; els.script.hidden = !reading;
    if (reading) renderPreview(); else { renderCast(); renderOutline(); renderPages(); renderPrompts(); }
  }
  refreshFlow();
  syncUrl();
}

// The header bar carries where you are: the shelf, or one book with a way back, its title and its actions.
function syncHead() {
  const sh = window.dvShell;
  if (!sh) return;
  const setActions = (...nodes) => { if (nodes.length !== sh.actions.children.length || nodes.some((n, i) => sh.actions.children[i] !== n)) sh.actions.replaceChildren(...nodes); };
  if (!book && !creating) {
    const done = books.filter(bookFinished).length, open = books.length - done;
    sh.setHead({ sub: books.length ? `${books.length} book${books.length === 1 ? '' : 's'} · ${[done ? `${done} finished` : '', open ? `${open} in progress` : ''].filter(Boolean).join(', ')}` : null });
    setActions(els.newBook);
    return;
  }
  const outlined = Boolean(book?.pages.length);
  const s = flowState();
  const sub = outlined
    ? [`Ages ${audience().id}`, `${s.pages} pages`, `${s.written}/${s.pages} written`, `${s.pictured}/${s.all} pictures`, s.stale ? `${s.stale} prompt${s.stale === 1 ? '' : 's'} need${s.stale === 1 ? 's' : ''} a look` : ''].filter(Boolean).join(' · ')
    : null;
  sh.setHead({ back: { label: 'All books', run: closeBook }, title: outlined ? els.title : book?.title || 'New book', sub });
  setActions(...(outlined ? [els.readToggle, els.exportMd, els.toSheets] : []));
}
function renderHead() {
  const s = flowState();
  const cover = book.pages.find((p) => p.kind === 'cover');
  const img = cover?.imageId && imageUrl(cover.imageId);
  els.bkCover.innerHTML = img ? `<img src="${img}" alt="">` : '<span>📖</span>';
  els.headLogline.textContent = book.logline || '';
  const a = audience();
  els.headChips.innerHTML = [`ages ${a.id}`, `${s.pages} pages`, `${s.written}/${s.pages} written`, `${s.pictured}/${s.all} pictures`, book.cast.length ? `cast: ${book.cast.map((c) => c.name).join(', ')}` : '']
    .filter(Boolean).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
}
function castCharacterSelect(c) {
  const s = document.createElement('select');
  s.innerHTML = '<option value="">Not linked — described in words</option>' + characters.map((x) => `<option value="${x.id}">👤 ${escapeHtml(x.name)} (${x.refs.length} refs)</option>`).join('');
  s.value = c.characterId && characters.some((x) => x.id === c.characterId) ? c.characterId : '';
  return s;
}
function renderCast() {
  els.cast.innerHTML = '';
  book.cast.forEach((c, i) => {
    const linked = characters.find((x) => x.id === c.characterId);
    const row = document.createElement('div'); row.className = 'cast-row' + (linked ? ' linked' : '');
    row.innerHTML = `
      <div class="cast-face">${linked?.refs[0] ? `<img src="${linked.refs[0].thumbUrl}" alt="">` : '<span>?</span>'}</div>
      <div class="cast-fields">
        <div class="grid2"><input class="c-name" type="text" placeholder="Name"><input class="c-role" type="text" placeholder="Role"></div>
        <textarea class="c-desc" rows="2" placeholder="What they look like (used in prompts when not linked to a studio character)"></textarea>
        <div class="cast-actions"></div>
        <div class="hint c-note">${linked ? `✓ On-model: pictures use this character’s reference images.${linked.bible ? ` <a href="/output/${encodeURIComponent(linked.bible.file)}" target="_blank">View character bible</a>` : ''}` : '⚠ Described in words only, so they may look different from page to page.'}</div>
      </div>
      <button class="btn icon c-rm" type="button" title="Remove from cast">✕</button>`;
    row.querySelector('.c-name').value = c.name; row.querySelector('.c-role').value = c.role; row.querySelector('.c-desc').value = c.description;
    const sel = castCharacterSelect(c);
    const design = document.createElement('button'); design.type = 'button'; design.className = 'btn secondary small';
    design.textContent = linked ? '🎨 Redesign' : '🎨 Design character';
    design.title = 'Generate a character design on white from this description and save it as a studio character, so every page uses it as a reference (one paid 1024² picture)';
    row.querySelector('.cast-actions').append(sel, design);
    const save = () => {
      book.cast[i] = { ...book.cast[i], name: row.querySelector('.c-name').value.trim(), role: row.querySelector('.c-role').value.trim(), description: row.querySelector('.c-desc').value.trim(), characterId: sel.value || null };
      queue({ cast: book.cast });
    };
    for (const el of row.querySelectorAll('input, textarea')) el.addEventListener('input', save);
    sel.addEventListener('change', () => { save(); flush().then(renderCast); });
    row.querySelector('.c-rm').addEventListener('click', () => { if (!confirm(`Remove ${c.name || 'this character'} from the cast?`)) return; book.cast.splice(i, 1); queue({ cast: book.cast }); flush().then(() => { renderCast(); renderPages(); }); });
    design.addEventListener('click', () => designCast(c, design));
    els.cast.appendChild(row);
  });
}

function imageUrl(id, thumb = true) { const r = records.get(id); return r ? (thumb && r.thumbUrl) || r.url : null; }
function renderPages() {
  renderEdit();
  els.pages.innerHTML = '';
  const range = audience().words;
  for (const p of book.pages) {
    const isCover = p.kind === 'cover';
    const card = document.createElement('div'); card.className = 'page-card' + (isCover ? ' cover' : ''); card.dataset.id = p.id;
    const img = p.imageId && imageUrl(p.imageId);
    const variants = p.imageIds.length > 1 ? `<div class="variants">${p.imageIds.map((id) => imageUrl(id) ? `<img src="${imageUrl(id)}" data-img="${id}" class="${id === p.imageId ? 'on' : ''}" title="Use this version">` : '').join('')}</div>` : '';
    card.innerHTML = `
      <div class="page-art">
        ${img ? `<a href="${imageUrl(p.imageId, false)}" target="_blank" rel="noopener"><img src="${img}" alt=""></a>` : `<div class="art-empty">${pageLabel(p)}<br><span class="hint">no picture yet</span></div>`}
        ${variants}
        <button class="btn secondary small p-image" type="button">${p.imageId ? '🎨 Try another picture' : '🎨 Illustrate'}</button>
        ${img && !book.fromSeries ? proofHtml(p) : ''}
        ${img && book.image.refs !== false ? `<button class="link p-anchor${book.anchorPageId === p.id ? ' on' : ''}" type="button" title="${book.anchorPageId === p.id ? 'Every other picture is drawn with this one beside it as the style to match. Click to go back to automatic (the nearest finished page).' : 'Draw every other picture with this one beside it as the style to match. Without a pinned page the nearest finished page is used.'}">${book.anchorPageId === p.id ? '★ Style anchor' : '☆ Use as style anchor'}</button>` : ''}
      </div>
      <div class="page-body">
        <div class="page-head">
          <b>${pageLabel(p)}</b>
          ${isCover ? '' : '<span class="wc"></span>'}
          <span class="spacer"></span>
          ${!isCover && isDesigned() ? `<select class="p-layout" title="This page's type. Choosing one re-designs the page's captions and boxes for it; Auto lets the AI choose."><option value="">Auto${p.design && p.design.by !== 'author' ? ` · ${escapeHtml(layoutOf(p.design.layout)?.label || '')}` : ''}</option>${(config.books.layouts || []).map((l) => `<option value="${l.id}" title="${escapeHtml(l.when)}">${escapeHtml(l.label)}</option>`).join('')}</select>` : ''}
          <select class="p-place"${!isCover && isDesigned() ? ' hidden' : ''} title="Where the text goes; the picture keeps this area calm">${config.books.placements.map((x) => `<option value="${x}">text at ${x}</option>`).join('')}</select>
          ${isCover ? '' : '<button class="mini p-add" type="button" title="Insert a blank page after this one">+ Add page after</button><button class="mini danger p-rm" type="button" title="Delete this page (↶ Undo brings it back)">Delete page</button>'}
        </div>
        ${isCover ? `<div class="cover-title">${escapeHtml(book.title)}</div>` : `<textarea class="p-text" rows="3" placeholder="${p.beat ? 'Not written yet — step 2 writes this, or type your own.' : 'Type the words for this page.'}"></textarea>`}
        ${!isCover && isDesigned() ? designHtml(p) : ''}
        ${isCover ? '' : `<div class="rewrite">${QUICK_REWRITES.map(([label], i) => `<button class="rw-chip" type="button" data-i="${i}">${label}</button>`).join('')}<input class="rw-input" type="text" placeholder="…or say what to change, then Enter"><button class="btn secondary small rw-go" type="button" title="Rewrite this page">✍</button></div>`}
        <details class="brief"${p.imageId ? '' : ' open'}>
          <summary>${isCover ? 'Cover picture' : 'Story beat & picture brief'} <span class="hint"></span></summary>
          ${isCover ? '' : '<div class="p-meta"></div><div class="hint p-purpose"></div><label class="field"><span>Beat</span><input class="p-beat" type="text"></label>'}
          <label class="field"><span>Picture brief</span><textarea class="p-ill" rows="3" placeholder="What the picture shows. Step 2 writes this."></textarea></label>
          <div class="p-chars"></div>
          <button class="link p-prompt" type="button">view the full image prompt</button>
          <pre class="p-prompt-text" hidden></pre>
        </details>
        <div class="status p-status"></div>
      </div>`;
    const q = (s) => card.querySelector(s);
    q('.p-place').value = p.textPlacement;
    if (q('.p-layout')) {
      q('.p-layout').value = p.design?.by === 'author' ? p.design.layout : '';
      q('.p-layout').addEventListener('change', () => designPages([p.id], { [p.id]: q('.p-layout').value }));
    }
    wireDesign(p, card);
    q('.p-ill').value = p.illustration;
    q('.brief .hint').textContent = p.characters.length ? `· ${p.characters.join(', ')}` : '';
    if (q('.p-beat')) { q('.p-beat').value = p.beat; q('.p-beat').addEventListener('input', () => setPage(p.id, { beat: q('.p-beat').value })); }
    if (q('.p-meta')) {
      const st = arcStage(p.arc);
      q('.p-meta').innerHTML = [st ? `<span class="chip arc arc-${st.id}" title="${escapeHtml(st.hint)}">${escapeHtml(st.label)}</span>` : '', p.setting ? `<span class="chip" title="Setting">📍 ${escapeHtml(p.setting)}</span>` : '', p.emotion ? `<span class="chip" title="Feeling">💛 ${escapeHtml(p.emotion)}</span>` : '', p.continuity ? `<span class="chip" title="Carries over from earlier pages">🔗 ${escapeHtml(p.continuity)}</span>` : '',
        p.shot || p.focus ? `<span class="chip" title="Planned shot and what the eye lands on first">🎥 ${escapeHtml([shotOf(p.shot)?.label, p.focus].filter(Boolean).join(' · '))}</span>` : '', p.turn ? `<span class="chip" title="Page-turn hook: the page ends here and the next one answers">↪ ${escapeHtml(p.turn)}</span>` : '']
        .join('') + `<button class="link p-plan" type="button">${planGaps(p) ? '⚠ plan this page in the Outline' : 'edit in Outline'}</button>`;
      q('.p-purpose').textContent = p.purpose ? `Why this page matters: ${p.purpose}` : '';
      q('.p-plan').addEventListener('click', async () => { await flush(); subtab = 'outline'; focusPage = pageKey(p); renderAll(); const cur = book.pages.find((x) => x.id === p.id); if (cur) goToPage(cur); });
    }
    if (q('.p-text')) {
      q('.p-text').value = p.text;
      const wc = () => { const n = words(q('.p-text').value);
        // In a designed style the story text is read aloud, not printed: only the captions are on the page.
        if (isDesigned()) { q('.wc').textContent = `${n} words to read aloud`; q('.wc').className = 'wc'; return; }
        const over = n > range[1], under = n && n < range[0]; q('.wc').textContent = `${n} / ${range[0]}–${range[1]} words`; q('.wc').className = `wc${over ? ' over' : under ? ' under' : n ? ' ok' : ''}`; };
      wc(); q('.p-text').addEventListener('input', () => { wc(); queue({ pages: [{ id: p.id, text: q('.p-text').value }] }); });
      const run = (instructions) => rewritePage(p, card, instructions);
      for (const chip of card.querySelectorAll('.rw-chip')) chip.addEventListener('click', () => run(QUICK_REWRITES[chip.dataset.i][1]));
      q('.rw-go').addEventListener('click', () => run(q('.rw-input').value.trim()));
      q('.rw-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); run(q('.rw-input').value.trim()); } });
    }
    q('.p-ill').addEventListener('input', () => queue({ pages: [{ id: p.id, illustration: q('.p-ill').value }] }));
    q('.p-place').addEventListener('change', () => queue({ pages: [{ id: p.id, textPlacement: q('.p-place').value }] }));
    for (const c of book.cast) {
      const chip = document.createElement('span');
      const on = p.characters.includes(c.name);
      chip.className = 'char-chip small' + (on ? ' on' : '');
      chip.textContent = `${c.characterId ? '👤 ' : ''}${c.name}`;
      chip.title = on ? 'In this picture — click to remove' : 'Click to add to this picture';
      chip.addEventListener('click', () => {
        p.characters = on ? p.characters.filter((n) => n !== c.name) : [...p.characters, c.name];
        queue({ pages: [{ id: p.id, characters: p.characters }] }); renderPages();
      });
      q('.p-chars').appendChild(chip);
    }
    for (const v of card.querySelectorAll('[data-img]')) v.addEventListener('click', () => { queue({ pages: [{ id: p.id, imageId: v.dataset.img }] }); flush().then(renderPages); });
    q('.p-add')?.addEventListener('click', () => structural({ addPageAfter: p.n }, `Added a page after page ${p.n}.`));
    q('.p-rm')?.addEventListener('click', () => structural({ removePage: p.id }, `Removed page ${p.n}.`));
    q('.p-image').addEventListener('click', () => illustrate(p).catch(() => {}));
    q('.p-fix')?.addEventListener('click', () => illustrate(p, false, { fixNotes: p.check?.fixNotes || '' }).catch(() => {}));
    q('.p-proof')?.addEventListener('click', () => proofread(p, q('.p-proof')));
    q('.p-anchor')?.addEventListener('click', () => { book.anchorPageId = book.anchorPageId === p.id ? null : p.id; queue({ anchorPageId: book.anchorPageId }); flush().then(renderPages); });
    q('.p-prompt').addEventListener('click', async () => {
      const pre = q('.p-prompt-text');
      if (!pre.hidden) { pre.hidden = true; return; }
      await flush();
      try {
        const linked = book.cast.filter((c) => c.characterId && p.characters.includes(c.name)).map((c) => c.name);
        const r = await api('GET', `/api/books/${book.id}/prompt/${p.id}`);
        pre.textContent = r.prompt + (linked.length ? `\n\n+ reference images and consistency instructions for: ${linked.join(', ')}` : '') + (r.references?.length ? `\n\n+ reference pictures from this book: ${r.references.join('; ')}` : '');
        pre.hidden = false;
      } catch (e) { pre.textContent = e.message; pre.hidden = false; }
    });
    els.pages.appendChild(card);
  }
  refreshFlow();
}

// What the proofreader said about the picture now chosen for a page (a result for another version is not shown).
function proofHtml(p) {
  const c = p.check && p.check.imageId === p.imageId ? p.check : null;
  if (!c) return '<button class="link p-proof" type="button" title="A second reader looks at the picture next to the page: who is in it and who should not be, where the story says everyone is, and any stray lettering">🔍 Proofread</button>';
  const notes = c.notes || [];
  if (c.pass) return `<span class="proof ok" title="${escapeHtml(notes.join(' · '))}">✓ Proofread: matches the page${notes.length ? ` · ${notes.length} small note${notes.length === 1 ? '' : 's'}` : ''}</span>`;
  return `<div class="proof bad" style="text-align:left">⚠ Proofreader:<ul>${c.issues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul><button class="mini p-fix" type="button" title="Draw the picture again with these mistakes listed as things to avoid (a paid picture)">🎨 Redraw fixing these</button></div>`;
}
async function proofread(p, btn) {
  if (busy) return;
  await flush();
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Proofreading…';
  try { const r = await api('POST', `/api/books/${book.id}/pages/${p.id}/check`); book = r.book; renderPages(); }
  catch (e) { btn.disabled = false; btn.textContent = '🔍 Proofread'; setStatus(`Proofreading failed: ${escapeHtml(e.message)}`, 'error'); }
}

// ---------- continuity reader: what does not add up in the plan or the written story ----------
// Each finding names its pages and can be handed to the writer: written pages are rewritten, planned ones go to the re-draft box.
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const holeText = (h) => `A continuity reader found this problem: ${h.problem} Fix it this way, changing as little else as possible: ${h.fix}`;
function renderLogic() {
  els.logicBox.hidden = Boolean(book.fromSeries);
  const l = book.logic;
  if (!l) { els.logic.innerHTML = '<div class="hint">Not read yet. The reader goes through the plan (and the text and picture briefs, once written) asking “but why?”.</div>'; return; }
  const what = l.stage === 'script' ? 'written story' : 'plan';
  const head = l.holes.length
    ? `<b>Continuity reader:</b> ${plural(l.holes.length, 'thing')} in the ${what} ${l.holes.length === 1 ? 'does' : 'do'} not add up yet${l.fixed ? ` (the editor already fixed ${l.fixed} of ${l.found})` : ''}.`
    : `<span class="proof ok">✓ Continuity reader: the ${what} adds up${l.fixed ? ` (the editor fixed ${plural(l.fixed, 'hole')} first)` : ''}.</span>`;
  els.logic.innerHTML = `<div>${head}</div>` + l.holes.map((h) => {
    const written = h.pages.length && h.pages.every((n) => storyPages().find((p) => p.n === n)?.text);
    return `<div class="hole ${escapeHtml(h.severity)}" data-hole="${escapeHtml(h.id)}"><div><b>${h.pages.length ? `Page${h.pages.length === 1 ? '' : 's'} ${h.pages.join(', ')}` : 'Whole story'}</b> · ${escapeHtml(h.problem)}</div><div class="fix">Smallest fix: ${escapeHtml(h.fix)}</div>
      <div class="row"><button class="mini" data-fix-hole type="button">${written ? `Rewrite ${h.pages.length === 1 ? 'this page' : 'these pages'} to fix it` : 'Re-draft the outline to fix it…'}</button></div></div>`;
  }).join('');
}
async function checkLogic() {
  if (busy) return;
  setBusy(true);
  const onProgress = showProgress('Reading the story for things that do not add up');
  try {
    await flush();
    const r = await streamApi(`/api/books/${book.id}/logic`, {}, onProgress);
    book = r.book; hideProgress(); renderAll();
    const n = r.logic.holes.length;
    setStatus(n ? `The continuity reader found ${plural(n, 'thing')} that ${n === 1 ? 'does' : 'do'} not add up. See the Outline tab.` : 'The continuity reader found nothing that does not add up.', n ? 'error' : 'ok');
  } catch (e) { hideProgress(); setStatus(`The continuity reader failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}
async function fixHole(h) {
  if (busy) return;
  const pages = h.pages.map((n) => storyPages().find((p) => p.n === n)).filter(Boolean);
  if (!pages.length || pages.length < h.pages.length || pages.some((p) => !p.text)) {
    // Not written yet (or about the whole story): the fix belongs in the plan, so hand it to the re-draft box.
    els.outlineInstructions.value = `${holeText(h)} Keep everything else as it is.`.slice(0, 2000);
    els.outlineInstructions.scrollIntoView({ behavior: 'smooth', block: 'center' }); els.outlineInstructions.focus();
    setStatus('The finding is in the re-draft box below. ↻ Re-draft outline rewrites the plan with it (the page text is written again afterwards).', 'ok');
    return;
  }
  setBusy(true);
  const onProgress = showProgress(`Rewriting page${pages.length === 1 ? '' : 's'} ${h.pages.join(', ')}`);
  try {
    await flush();
    book = await streamApi(`/api/books/${book.id}/scripts`, { pageIds: pages.map((p) => p.id), instructions: `${holeText(h)} Keep each page's state true and make every illustration brief agree with it.`.slice(0, 2000) }, onProgress);
    hideProgress(); renderAll();
    setStatus(`Rewrote page${pages.length === 1 ? '' : 's'} ${h.pages.join(', ')} to fix it. 🔎 Check the story adds up reads it again; ↶ Undo restores the old text.`, 'ok');
  } catch (e) { hideProgress(); setStatus(`Rewrite failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}

// ---------- outline: the plan for every page ----------
function renderStoryline() {
  els.storyline.innerHTML = '';
  for (const f of config.books.storyline) {
    const l = document.createElement('label'); l.className = 'field';
    l.innerHTML = `<span>${escapeHtml(f.label)}</span><textarea rows="2"></textarea>`;
    const t = l.querySelector('textarea');
    t.value = storyline()[f.id] || ''; t.classList.toggle('gap', !t.value.trim());
    t.addEventListener('input', () => { storyline()[f.id] = t.value; t.classList.toggle('gap', !t.value.trim()); queue({ storyline: { [f.id]: t.value } }); });
    els.storyline.appendChild(l);
  }
  els.world.value = book.world || ''; els.world.classList.toggle('gap', !book.world);
  els.refrain.value = book.refrain || ''; els.device.value = book.device || '';
  renderWorldSheet();
}
// The world sheet: one picture of the places and recurring objects, shown to the illustrator with every page.
function renderWorldSheet() {
  const url = book.worldSheetId && imageUrl(book.worldSheetId);
  const each = estimateImageCost(book.image.model, '1024x1024', 'high');
  const cost = each ? ` (≈ ${fmtCost(each)})` : '';
  els.worldSheet.hidden = Boolean(book.fromSeries);
  els.worldSheet.innerHTML = url
    ? `<a href="${imageUrl(book.worldSheetId, false)}" target="_blank" rel="noopener"><img src="${url}" alt="World sheet"></a><span>${book.worldSheetStale ? '⚠ The world note changed since this sheet was drawn.' : 'World sheet: shown to the illustrator with every page, so places and objects keep their look.'}</span><button class="mini" data-ws="draw" type="button">🎨 Draw it again${cost}</button><button class="mini" data-ws="remove" type="button" title="Stop using the sheet; the picture stays in History">Stop using it</button>`
    : `<button class="btn secondary small" data-ws="draw" type="button" title="One picture of the places and recurring objects in the world note, without characters. Every page is then drawn with it beside it, so the things that come back keep their look.">🎨 Draw the world sheet${cost}</button><span class="hint">optional: gives the illustrator a picture of the places and objects that come back, not only words</span>`;
}
async function drawWorldSheet() {
  if (busy) return;
  if (!els.world.value.trim()) { setStatus('Write the world note first: the sheet is drawn from it.', 'error'); els.world.focus(); return; }
  setBusy(true);
  els.worldSheet.innerHTML = '<span class="spinner"></span> Drawing the world sheet…';
  try {
    await flush();
    const r = await api('POST', `/api/books/${book.id}/world-sheet`);
    records.set(r.record.id, r.record); book = r.book;
    setStatus(`World sheet drawn${r.record.costUsd ? ` · ${fmtCost(r.record.costUsd)}` : ''}. New pictures are drawn with it beside them; pictures already made are unchanged.`, 'ok');
  } catch (e) { setStatus(`World sheet failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); renderWorldSheet(); }
}
// The rhythm of the pictures: one cell per page with its planned shot; a third page in a row at the same distance is marked.
function renderShotBar() {
  const pages = storyPages();
  els.shotBar.hidden = !pages.some((p) => p.shot);
  els.shotBar.innerHTML = pages.map((p, i) => {
    const run = p.shot && i >= 2 && pages[i - 1].shot === p.shot && pages[i - 2].shot === p.shot;
    const s = shotOf(p.shot);
    return `<span class="${run ? 'run' : ''}" title="Page ${p.n}: ${s ? `${escapeHtml(s.label)} — ${escapeHtml(s.hint)}` : 'no shot planned'}${run ? ' · third page in a row at this distance' : ''}">${s ? escapeHtml(s.label[0]) : '·'}</span>`;
  }).join('');
  renderSameRuns();
}
// Runs of more than three pages in one place with the same characters: their pictures come out looking alike, whatever
// the camera. Named under the shot row with a re-draft instruction ready to use.
const placeKeyOf = (setting) => String(setting || '').split(/[;(—]| - /)[0].toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function sameRuns() {
  const pages = storyPages(), runs = [];
  const key = (p) => (placeKeyOf(p.setting) ? `${placeKeyOf(p.setting)}|${[...p.characters].sort().join(',')}` : '');
  for (let i = 0; i < pages.length;) {
    let j = i;
    while (key(pages[i]) && j + 1 < pages.length && key(pages[j + 1]) === key(pages[i])) j++;
    if (j - i + 1 > 3) runs.push({ from: pages[i].n, to: pages[j].n, count: j - i + 1, place: pages[i].setting.split(/[;(—]/)[0].trim() });
    i = j + 1;
  }
  return runs;
}
function renderSameRuns() {
  let box = document.getElementById('same-runs');
  if (!box) { box = document.createElement('div'); box.id = 'same-runs'; box.className = 'same-runs'; els.shotBar.after(box); }
  const runs = book.fromSeries ? [] : sameRuns();
  box.hidden = !runs.length;
  box.innerHTML = runs.map((r, i) => `<div>⚠ Pages ${r.from}–${r.to}: ${r.count} pages in a row in the same place (${escapeHtml(r.place)}) with the same characters. Their pictures will look alike. <button class="mini" type="button" data-run="${i}">Use as a re-draft instruction</button></div>`).join('');
  box.onclick = (e) => {
    const b = e.target.closest('[data-run]'); if (!b) return;
    const r = runs[Number(b.dataset.run)];
    const field = els.outlineInstructions;
    const text = `Pages ${r.from}–${r.to} are ${r.count} pages in a row in the same place with the same characters, so their pictures would look the same. Keep the story, but spend at most three pages in a row there: move within the place or to the next one, or change who is visible on each page.`;
    if (field) { field.value = text; field.dispatchEvent(new Event('input', { bubbles: true })); field.scrollIntoView({ behavior: 'smooth', block: 'center' }); field.focus(); }
    else { navigator.clipboard?.writeText(text); setStatus('Instruction copied. Paste it into the re-draft box and re-draft the outline.', 'ok'); }
  };
}
// What the read-aloud editor changed the last time it went through the text.
function renderEdit() {
  const e = book.edit;
  els.editBox.hidden = !e || Boolean(book.fromSeries);
  if (!e) return;
  els.editBox.innerHTML = e.changed.length
    ? `<div><b>Read-aloud editor:</b> polished ${plural(e.changed.length, 'page')}. ↶ Undo restores the text as it was.</div><ul>${e.changed.map((c) => `<li><b>Page ${c.n}</b> · ${escapeHtml(c.reason)}</li>`).join('')}</ul>`
    : '<span class="proof ok">✓ Read-aloud editor: the text reads well as it is.</span>';
}
async function editPass() {
  if (busy) return;
  setBusy(true);
  const onProgress = showProgress('Reading the whole book aloud');
  try {
    await flush();
    const r = await streamApi(`/api/books/${book.id}/edit`, {}, onProgress);
    book = r.book; hideProgress(); renderAll();
    const n = r.edit.changed.length;
    setStatus(n ? `The read-aloud editor polished ${plural(n, 'page')}; what changed is listed above the pages. ↶ Undo restores the text.` : 'The read-aloud editor found nothing to change.', 'ok');
  } catch (e) { hideProgress(); setStatus(`The read-aloud edit failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}
// One bar per page, coloured by stage and rising to the turning point, so the shape of the story is visible at a glance.
function renderArcBar() {
  const pages = storyPages();
  const rising = pages.filter((p) => p.arc === 'rising');
  const height = (p) => ({ opening: 34, problem: 48, turning: 100, resolution: 60, ending: 40 }[p.arc] ?? (p.arc === 'rising' ? 56 + Math.round((30 * (rising.indexOf(p) + 1)) / rising.length) : 24));
  els.arcBar.innerHTML = '';
  for (const p of pages) {
    const st = arcStage(p.arc);
    const b = document.createElement('button'); b.type = 'button';
    b.className = `arc-seg arc-${st ? st.id : 'none'}`; b.style.setProperty('--h', `${height(p)}%`);
    b.textContent = p.n; b.title = `Page ${p.n} · ${st ? st.label : 'no arc stage yet'}${p.beat ? ` — ${p.beat}` : ''}`;
    b.addEventListener('click', () => { focusPage = pageKey(p); syncUrl(); goToPage(p); });
    els.arcBar.appendChild(b);
  }
  els.arcLegend.innerHTML = config.books.arcStages.map((a) => { const n = pages.filter((p) => p.arc === a.id).length; return n ? `<span class="arc-key arc-${a.id}" title="${escapeHtml(a.hint)}"><i></i>${escapeHtml(a.label)} · ${n}</span>` : ''; }).join('');
}
function renderOutline() {
  renderStoryline(); renderArcBar(); renderShotBar(); renderLogic();
  els.outline.innerHTML = '';
  for (const p of book.pages) {
    const isCover = p.kind === 'cover';
    const row = document.createElement('div'); row.dataset.id = p.id;
    row.className = `ol-row${isCover ? ' cover' : ` arc-${arcStage(p.arc) ? p.arc : 'none'}`}`;
    const img = p.imageId && imageUrl(p.imageId);
    row.innerHTML = `<div class="ol-n"><b>${pageLabel(p)}</b>${img ? `<img src="${img}" alt="">` : ''}</div>` + (isCover
      ? `<div class="ol-main"><label class="field"><span>Cover picture</span><textarea class="o-illustration" rows="2"></textarea></label><div class="ol-chars"></div></div>`
      : `<div class="ol-main">
          <div class="ol-top"><select class="o-arc" title="Where this page sits on the story arc"><option value="">Arc stage…</option>${config.books.arcStages.map((a) => `<option value="${a.id}">${escapeHtml(a.label)}</option>`).join('')}</select><select class="o-shot" title="How close this page's picture is"><option value="">Shot…</option>${(config.books.shots || []).map((x) => `<option value="${x.id}" title="${escapeHtml(x.hint)}">${escapeHtml(x.label)}</option>`).join('')}</select><div class="ol-chars"></div><span class="spacer"></span><button class="mini o-add" type="button" title="Insert a blank page after this one">+ Add page after</button><button class="mini danger o-rm" type="button" title="Delete this page (↶ Undo brings it back)">Delete page</button></div>
          <label class="field"><span>What happens</span><textarea class="o-beat" rows="2" placeholder="What happens on this page, in a sentence or two"></textarea></label>
          <label class="field"><span>Why this page matters</span><textarea class="o-purpose" rows="1" placeholder="What it sets up, pays off or changes"></textarea></label>
          <label class="field"><span>Where things stand at the end <span class="hint">facts every picture must agree with</span></span><textarea class="o-state" rows="2" placeholder="Who is where (and who cannot be seen), who holds what, what is stuck, blocked or open, the light"></textarea></label>
        </div>
        <div class="ol-side">
          <label class="field"><span>Setting</span><textarea class="o-setting" rows="1" placeholder="Place, time of day, weather"></textarea></label>
          <label class="field"><span>Feeling</span><textarea class="o-emotion" rows="1" placeholder="How the main character feels; the mood"></textarea></label>
          <label class="field"><span>Carries over <span class="hint">optional</span></span><textarea class="o-continuity" rows="1" placeholder="Objects held, changes from earlier pages"></textarea></label>
          <label class="field"><span>Eye lands on <span class="hint">optional</span></span><textarea class="o-focus" rows="1" placeholder="The one thing seen first in the picture"></textarea></label>
          <label class="field"><span>Page-turn hook <span class="hint">optional</span></span><textarea class="o-turn" rows="1" placeholder="What the reader waits for; the next page answers"></textarea></label>
        </div>`);
    row.querySelector('.o-add')?.addEventListener('click', () => structural({ addPageAfter: p.n }, `Added a blank page after page ${p.n}.`));
    row.querySelector('.o-rm')?.addEventListener('click', () => { if (confirm(`Delete page ${p.n}? Its picture stays in History, and ↶ Undo brings the page back.`)) structural({ removePage: p.id }, `Deleted page ${p.n}.`); });
    for (const k of isCover ? ['illustration'] : ['beat', 'purpose', 'setting', 'emotion', 'continuity', 'state', 'focus', 'turn']) {
      const el = row.querySelector(`.o-${k}`);
      const required = PLAN_FIELDS.some(([f]) => f === k);
      el.value = p[k] || ''; if (required) el.classList.toggle('gap', !el.value.trim());
      el.addEventListener('input', () => { setPage(p.id, { [k]: el.value }); if (required) el.classList.toggle('gap', !el.value.trim()); });
    }
    const arc = row.querySelector('.o-arc');
    if (arc) {
      arc.value = arcStage(p.arc) ? p.arc : ''; arc.classList.toggle('gap', !arc.value);
      arc.addEventListener('change', () => { setPage(p.id, { arc: arc.value }); row.className = `ol-row arc-${arc.value || 'none'}`; arc.classList.toggle('gap', !arc.value); renderArcBar(); });
    }
    const shot = row.querySelector('.o-shot');
    if (shot) { shot.value = shotOf(p.shot) ? p.shot : ''; shot.addEventListener('change', () => { setPage(p.id, { shot: shot.value }); renderShotBar(); }); }
    const chars = row.querySelector('.ol-chars');
    const drawChars = () => {
      const cur = book.pages.find((x) => x.id === p.id) || p;
      chars.innerHTML = '';
      for (const c of book.cast) {
        const on = cur.characters.includes(c.name);
        const chip = document.createElement('span'); chip.className = 'char-chip small' + (on ? ' on' : '');
        chip.textContent = `${c.characterId ? '👤 ' : ''}${c.name}`; chip.title = on ? 'On this page — click to remove' : 'Click to put them on this page';
        chip.addEventListener('click', () => { setPage(p.id, { characters: on ? cur.characters.filter((n) => n !== c.name) : [...cur.characters, c.name] }); drawChars(); });
        chars.appendChild(chip);
      }
    };
    drawChars();
    els.outline.appendChild(row);
  }
}

// Download names sort in reading order: 00-cover.png, 01-page-1.png … (the zip uses the same names).
function pageFileName(p) {
  const r = records.get(p.imageId);
  const width = Math.max(2, String(storyPages().length).length);
  const ext = (/\.[a-z0-9]+$/i.exec(r?.file || r?.url || '')?.[0] || '.png').toLowerCase();
  return `${String(p.n).padStart(width, '0')}-${p.kind === 'cover' ? 'cover' : `page-${p.n}`}${ext}`;
}
function renderReadBar() {
  const n = book.pages.filter((p) => p.imageId && records.get(p.imageId)).length;
  els.dlImages.href = `/api/books/${book.id}/images.zip${els.dlStory.checked ? '?story=1' : ''}`;
  els.dlImages.classList.toggle('disabled', !n); els.dlImages.style.pointerEvents = n ? '' : 'none'; els.dlImages.style.opacity = n ? '' : '.5';
  els.dlHint.textContent = !n ? 'No pictures yet.' : `${n} picture${n === 1 ? '' : 's'}, named in reading order (00-cover, 01-page-1 …)${els.dlStory.checked ? ', plus story.md' : ''}. Hover a page to download just that one.`;
}
// ---------- typesetting the page text over the picture (no AI: measured, fitted and coloured from the picture) ----------
const TYPE_FONT = '"Arial Rounded MT Bold", ui-rounded, "Chalkboard SE", "Comic Sans MS", system-ui, sans-serif';
// The area each placement keeps calm in the picture prompt, as fractions of the page.
const TYPE_ZONES = {
  top: { x: 0.07, y: 0.04, w: 0.86, h: 0.2, anchor: 'middle' }, bottom: { x: 0.07, y: 0.76, w: 0.86, h: 0.2, anchor: 'middle' },
  left: { x: 0.06, y: 0.1, w: 0.36, h: 0.5, anchor: 'start' }, right: { x: 0.58, y: 0.1, w: 0.36, h: 0.5, anchor: 'end' },
};
const READ_TEXT_KEY = 'dadventures.readText';
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const hsl = (h, s, l, a = 1) => `hsla(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
// Colours for the lettering, read from the picture: the text area decides light-on-dark or dark-on-light and tints the
// outline and the soft wash behind the words; the accent is the picture's strongest colour that differs from that area.
function typeColors(img, zone) {
  const w = 96, h = Math.max(1, Math.round((96 * img.naturalHeight) / img.naturalWidth));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  const hues = new Array(12).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x >= zone.x * w && x < (zone.x + zone.w) * w && y >= zone.y * h && y < (zone.y + zone.h) * h) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; }
    const [hh, ss, ll] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (ss > 0.5 && ll > 0.35 && ll < 0.8) hues[Math.floor(hh / 30) % 12] += ss;
  }
  r /= n || 1; g /= n || 1; b /= n || 1;
  const [zh, zs, zl] = rgbToHsl(r, g, b);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const light = lum < 0.66;                                      // light lettering unless the area is pale
  // Hues close to the text area would not stand out against it, so the further a hue is from the area, the more it counts.
  const away = (k) => { if (zs < 0.2) return 1; const d = Math.abs(k * 30 + 15 - zh) % 360, dist = Math.min(d, 360 - d); return dist < 80 ? 0 : dist / 180; };
  const best = hues.map((v, k) => [v * away(k), k]).sort((a, z) => z[0] - a[0])[0];
  const accentHue = best[0] > 0 ? best[1] * 30 + 15 : (zh + 180) % 360;
  return light
    ? { fill: '#fff', stroke: hsl(zh, Math.min(zs, 0.75), 0.17), accent: hsl(accentHue, 1, 0.74), wash: hsl(zh, Math.min(zs, 0.8), Math.max(0.1, zl * 0.55), 0.55), light }
    : { fill: hsl(zh, Math.min(Math.max(zs, 0.35), 0.7), 0.16), stroke: 'rgba(255,255,255,.92)', accent: hsl(accentHue, 0.85, 0.3), wash: hsl(zh, zs, Math.min(0.96, zl + 0.2), 0.6), light };
}
// Short exclamations and repeated words ("Whoosh!", "Up, up!", "Snuggle, snuggle.") are the read-aloud sound words; they get the accent colour.
function isSoundWord(sentence) {
  const ws = sentence.toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, '').split(/\s+/).filter(Boolean);
  return (ws.length > 1 && ws.length <= 3 && ws.every((x) => x === ws[0])) || (ws.length <= 2 && /!["”’')]*$/.test(sentence));
}
// Largest size at which the text fits its area. Lines break between sentences first and are balanced when a sentence must wrap.
let measureCtx = null;
function layoutType(text, zone, W, H) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  const sentences = (text.replace(/\s+/g, ' ').trim().match(/[^.!?…]+[.!?…]+["”’')]*|[^.!?…]+$/g) || []).map((s) => s.trim()).filter(Boolean);
  const zw = zone.w * W, zh = zone.h * H;
  let fit = null;
  for (let size = Math.round(Math.min(W, H) * 0.07); size >= H * 0.02; size = Math.floor(size * 0.95)) {
    measureCtx.font = `700 ${size}px ${TYPE_FONT}`;
    const space = measureCtx.measureText(' ').width;
    const lines = []; let cur = [], curW = 0, tooWide = false;
    const push = () => { if (cur.length) lines.push(cur); cur = []; curW = 0; };
    for (const s of sentences) {
      const em = isSoundWord(s);
      const words = s.split(' ').map((t) => ({ t, em, w: measureCtx.measureText(t).width }));
      const sw = words.reduce((a, x) => a + x.w, 0) + space * (words.length - 1);
      if (words.some((x) => x.w > zw) || (words.length <= 3 && sw > zw)) tooWide = true;   // never split a word or a short phrase
      if (cur.length && curW + space + sw <= zw) { cur.push(...words); curW += space + sw; continue; }
      push();
      if (sw <= zw) { cur = words; curW = sw; continue; }
      const target = Math.min(zw, (sw / Math.ceil(sw / zw)) * 1.12);   // balanced wrap of a long sentence
      for (const x of words) {
        if (cur.length && curW + space + x.w > target) push();
        curW += (cur.length ? space : 0) + x.w; cur.push(x);
      }
    }
    push();
    fit = { size, lines, lineHeight: size * 1.2, width: Math.max(...lines.map((l) => l.reduce((a, x) => a + x.w, 0) + space * (l.length - 1))) };
    if (!tooWide && lines.length * fit.lineHeight <= zh) break;
  }
  return fit;
}
async function typesetPage(art, p) {
  const img = art.querySelector('img');
  try { await img.decode(); } catch { return false; }
  const W = img.naturalWidth, H = img.naturalHeight;
  const zone = TYPE_ZONES[p.textPlacement] || TYPE_ZONES.bottom;
  const fit = layoutType(p.text, zone, W, H);
  if (!fit?.lines.length) return false;
  const col = typeColors(img, zone);
  const blockH = fit.lines.length * fit.lineHeight;
  const top = zone.y * H + (zone.h * H - blockH) / 2;
  const x = zone.anchor === 'middle' ? (zone.x + zone.w / 2) * W : zone.anchor === 'start' ? zone.x * W : (zone.x + zone.w) * W;
  // A soft cloud of the area's own colour behind the words, fading out into the picture on every side.
  const cx = zone.anchor === 'middle' ? x : zone.anchor === 'start' ? x + fit.width / 2 : x - fit.width / 2;
  const rx = fit.width * 0.5 + fit.size * 2.2, ry = blockH * 0.5 + fit.size * 1.6;
  const rect = [cx - rx, top + blockH / 2 - ry, 2 * rx, 2 * ry].map((v) => v.toFixed(1));
  const gid = `wash-${p.id}`;
  const rows = fit.lines.map((line, i) => {
    const runs = [];
    for (const wd of line) { const last = runs[runs.length - 1]; if (last && last.em === wd.em) last.t += ` ${wd.t}`; else runs.push({ em: wd.em, t: wd.t }); }
    return `<text x="${x.toFixed(1)}" y="${(top + i * fit.lineHeight + fit.size * 0.86).toFixed(1)}" text-anchor="${zone.anchor}" font-size="${fit.size}" stroke="${col.stroke}" stroke-width="${(fit.size * 0.16).toFixed(1)}">${runs.map((r, k) => `<tspan fill="${r.em ? col.accent : col.fill}">${escapeHtml(r.t)}${k < runs.length - 1 ? ' ' : ''}</tspan>`).join('')}</text>`;
  }).join('');
  art.insertAdjacentHTML('beforeend', `<svg class="spread-type" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <defs><radialGradient id="${gid}"><stop offset="0" stop-color="${col.wash}"/><stop offset=".55" stop-color="${col.wash}" stop-opacity=".75"/><stop offset="1" stop-color="${col.wash}" stop-opacity="0"/></radialGradient></defs>
    <rect x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}" fill="url(#${gid})"/>${rows}</svg>`);
  return true;
}
// How a page's words are shown in the reading view. Automatic: nothing extra when the picture already has the words drawn in,
// otherwise set over the picture. Pages without a picture always show their words below.
function readTextMode(p, hasPicture) {
  if (!hasPicture) return 'below';
  if (p.kind === 'cover') return 'none';                 // the cover picture always carries the title
  const mode = els.readText.value;
  return mode === 'auto' ? (book.image.textInImage ? 'none' : 'over') : mode;
}

// The book in words, under the pages of the reading view: storyline, world, cast, then every page's text and plan.
function renderScript() {
  const e = escapeHtml;
  const spine = config.books.storyline.filter((f) => storyline()[f.id]);
  const row = (label, value) => (value ? `<dt>${label}</dt><dd>${e(value)}</dd>` : '');
  els.scriptBody.innerHTML = [
    book.logline ? `<p><i>${e(book.logline)}</i></p>` : '',
    spine.length ? `<div><h3>Storyline</h3><ul>${spine.map((f) => `<li><b>${e(f.label)}:</b> ${e(storyline()[f.id])}</li>`).join('')}</ul></div>` : '',
    book.world ? `<div><h3>World</h3><p>${e(book.world)}</p></div>` : '',
    book.cast.length ? `<div><h3>Cast</h3><ul>${book.cast.map((c) => `<li><b>${e(c.name)}</b>${c.role ? ` (${e(c.role)})` : ''}${c.description ? ` — ${e(c.description)}` : ''}</li>`).join('')}</ul></div>` : '',
    `<div><h3>Page by page</h3></div>`,
    ...book.pages.map((p) => {
      const st = arcStage(p.arc);
      const isCover = p.kind === 'cover';
      return `<div class="script-page arc-${st ? st.id : 'none'}">
        <h4>${pageLabel(p)}${st ? `<span class="chip">${e(st.label)}</span>` : ''}${p.imageId ? '' : '<span class="hint">no picture yet</span>'}</h4>
        ${isCover ? `<div class="said">${e(book.title)}</div>` : `<div class="said${p.text ? '' : ' none'}">${p.text ? e(p.text) : 'Text not written yet.'}</div>`}
        <dl>${row('What happens', p.beat)}${row('Why it matters', p.purpose)}${row('Characters', p.characters.join(', '))}${row('Setting', p.setting)}${row('Feeling', p.emotion)}${row('Carries over', p.continuity)}${row('Where things stand', p.state)}${row('Picture', p.illustration)}</dl>
      </div>`;
    }),
  ].join('');
}

function renderPreview() {
  renderReadBar(); renderScript();
  els.preview.innerHTML = '';
  let chapter = '';
  for (const p of book.pages) {
    // A book copied from a card story has no cover art of its own: show a title page instead of repeating page 1.
    if (p.kind === 'cover' && p.titlePage) {
      const t = document.createElement('div'); t.className = 'spread title-page'; t.dataset.id = p.id;
      t.innerHTML = `<h1>${escapeHtml(book.title)}</h1>${book.logline ? `<p>${escapeHtml(book.logline)}</p>` : ''}${book.cast.length ? `<small>With ${escapeHtml(book.cast.map((c) => c.name).join(', '))}</small>` : ''}`;
      els.preview.appendChild(t);
      continue;
    }
    if (p.chapter && p.chapter !== chapter) {
      chapter = p.chapter;
      const h = document.createElement('div'); h.className = 'chapter-head';
      h.innerHTML = `<span>Chapter ${[...new Set(book.pages.map((x) => x.chapter).filter(Boolean))].indexOf(chapter) + 1}</span><b>${escapeHtml(chapter)}</b>${book.chapterArt?.[chapter] && imageUrl(book.chapterArt[chapter], false) ? `<img src="${imageUrl(book.chapterArt[chapter], false)}" alt="">` : ''}`;
      els.preview.appendChild(h);
    }
    const img = p.imageId ? imageUrl(p.imageId, false) : null;
    const words = p.kind === 'cover' ? '' : p.text || '';
    const mode = readTextMode(p, Boolean(img));
    const d = document.createElement('div'); d.className = `spread place-${p.textPlacement}` + (p.kind === 'cover' ? ' cover' : '') + (mode === 'over' && words ? ' typeset' : ''); d.dataset.id = p.id;
    d.innerHTML = `<div class="spread-art">${img ? `<img src="${img}" alt="${escapeHtml(words)}">` : `<div class="art-empty">${pageLabel(p)} — no picture yet</div>`}</div>
      ${mode === 'below' ? `<div class="spread-text">${p.kind === 'cover' ? `<h1>${escapeHtml(book.title)}</h1>` : escapeHtml(p.text || p.beat).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="spread-num">${p.kind === 'cover' ? '' : p.n}</div>
      ${img ? `<a class="spread-dl" href="${img}" download="${escapeHtml(pageFileName(p))}" title="Download ${escapeHtml(pageFileName(p))}">⬇ ${escapeHtml(pageFileName(p))}</a>` : ''}`;
    els.preview.appendChild(d);
    if (mode === 'over' && words) typesetPage(d.querySelector('.spread-art'), p).catch(() => {});
  }
}

// ---------- actions ----------
async function toggleReading() { await flush(); reading = !reading; renderAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
async function structural(patch, message) {
  await flush();
  try { book = await api('PATCH', `/api/books/${book.id}`, patch); renderAll(); setStatus(message + (book.undoLabel && patch.removePage ? ' Undo brings it back.' : ''), 'ok'); }
  catch (e) { setStatus(e.message, 'error'); }
}
async function undo() {
  if (busy) return;
  await flush();
  try { const r = await api('POST', `/api/books/${book.id}/undo`); book = r.book; renderAll(); await loadBooks(); setStatus(`Undid: ${r.undone.toLowerCase()}.`, 'ok'); }
  catch (e) { setStatus(`Undo failed: ${e.message}`, 'error'); }
}

async function suggestIdeas() {
  setBusy(true);
  els.ideas.hidden = false;
  els.ideas.innerHTML = '<div class="hint"><span class="spinner"></span><span class="idea-phase">Brainstorming…</span></div>';
  try {
    const r = await streamApi('/api/books/ideas', { ...briefFromForm() }, (p) => { const el = els.ideas.querySelector('.idea-phase'); if (el) el.textContent = `${p.phase}${p.snippet ? ` — “${p.snippet}”` : ''}`; });
    els.ideas.innerHTML = '';
    for (const idea of r.ideas) {
      const d = document.createElement('button'); d.type = 'button'; d.className = 'idea';
      d.innerHTML = `<b>${escapeHtml(idea.title)}</b><span>${escapeHtml(idea.premise)}</span><small>${escapeHtml([idea.tone, idea.theme].filter(Boolean).join(' · '))}</small>`;
      d.addEventListener('click', () => {
        els.premise.value = idea.premise;
        if (idea.tone) els.tone.value = idea.tone;
        if (idea.theme) els.themeBrief.value = idea.theme;
        els.ideas.hidden = true; els.suggest.textContent = '✨ Develop this idea';
        if (book) queue({ brief: briefFromForm() });
        refreshFlow();
        setStatus(`Using “${escapeHtml(idea.title)}”. Adjust anything, then draft the outline.`, 'ok');
      });
      els.ideas.appendChild(d);
    }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'link'; close.textContent = 'hide ideas';
    close.addEventListener('click', () => { els.ideas.hidden = true; });
    els.ideas.appendChild(close);
  } catch (e) { els.ideas.innerHTML = `<div class="status error">Ideas failed: ${escapeHtml(e.message)}</div>`; }
  finally { setBusy(false); }
}

// Suggest a value for every blank brief detail; whatever is already typed stays.
async function fillBrief() {
  if (busy) return;
  if (!els.premise.value.trim()) { setStatus('Write a story idea first (or click ✨ Suggest ideas).', 'error'); els.premise.focus(); return; }
  setBusy(true);
  const onProgress = showProgress('Filling in the details');
  try {
    const r = await streamApi('/api/books/brief', briefFromForm(), onProgress);
    const filled = [];
    for (const [el, label] of BRIEF_DETAILS) {
      const key = { themeBrief: 'theme', briefNotes: 'notes' }[el] || el;
      if (!els[el].value.trim() && r.brief[key]) { els[el].value = r.brief[key]; filled.push(label); }
    }
    hideProgress();
    if (book) queue({ brief: briefFromForm() });
    setStatus(filled.length ? `Filled in ${filled.join(', ')}. Change anything you like, then draft the outline.` : 'Nothing was blank.', 'ok');
  } catch (e) { hideProgress(); setStatus(`Could not fill in the details: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}
// Fill the blank planning notes of an outlined book (hand-added pages, older books) without changing the story.
async function fillDetails() {
  if (busy) return;
  setBusy(true);
  const onProgress = showProgress('Filling in the outline details');
  try {
    await flush();
    book = await streamApi(`/api/books/${book.id}/details`, {}, onProgress);
    hideProgress(); renderAll();
    const left = outlineGaps();
    setStatus(left ? `Filled in what could be worked out; ${left} note${left === 1 ? ' is' : 's are'} still blank.` : 'Every page is fully planned. ↶ Undo restores the blanks.', 'ok');
  } catch (e) { hideProgress(); setStatus(`Could not fill in the details: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}

async function draftOutline() {
  if (!els.premise.value.trim()) { setStatus('Write a story idea first (or click ✨ Suggest ideas).', 'error'); els.premise.focus(); return; }
  const redo = storyPages().length > 0;
  setBusy(true);
  const onProgress = showProgress(redo ? 'Re-drafting the outline' : 'Drafting the outline');
  try {
    await ensureBook();
    book = await streamApi(`/api/books/${book.id}/outline`, { instructions: els.outlineInstructions.value }, onProgress);
    hideProgress(); reading = false; creating = false; subtab = 'outline'; els.outlineInstructions.value = '';
    await loadBooks(); renderAll();
    setStatus(`${redo ? 'Re-drafted' : 'Outlined'} “${escapeHtml(book.title)}”: ${storyPages().length} pages, ${book.cast.length} characters. Check the plan for each page below (arc stage, who is in it, setting, feeling), then write the page text.${redo ? ' ↶ Undo restores the previous version.' : ''}`, 'ok');
  } catch (e) { hideProgress(); setStatus(`Outline failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}

async function writeScripts(onlyMissing) {
  const pages = storyPages();
  const todo = onlyMissing ? pages.filter((p) => !p.text) : pages;
  setBusy(true);
  const onProgress = showProgress(`Writing ${todo.length} page${todo.length > 1 ? 's' : ''}`);
  try {
    queue({ brief: briefFromForm(), image: imageFromForm() }); await flush();
    book = await streamApi(`/api/books/${book.id}/scripts`, { pageIds: todo.length < pages.length ? todo.map((p) => p.id) : [] }, onProgress);
    hideProgress(); reading = false; await loadBooks(); renderAll();
    const polished = book.edit?.changed.length || 0;
    setStatus(`Wrote ${todo.length} page${todo.length > 1 ? 's' : ''}${polished ? `; the read-aloud editor then polished ${polished} (listed above the pages)` : ''}. Polish any page with the rewrite buttons, then illustrate.`, 'ok');
  } catch (e) { hideProgress(); setStatus(`Writing failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}

// Lays out pages for a designed style. pageIds: only these (default: pages not designed yet); layouts: { pageId: layout }
// chosen by the author ('' = let the AI choose); all: redo every page.
async function designPages(pageIds, layouts, all = false) {
  if (busy) return;
  const n = pageIds?.length || (all ? storyPages().length : undesigned().length);
  setBusy(true);
  const onProgress = showProgress(`Designing ${n} page${n > 1 ? 's' : ''}`);
  try {
    queue({ image: imageFromForm() }); await flush();
    book = await streamApi(`/api/books/${book.id}/design`, { pageIds: pageIds || [], layouts: layouts || {}, all }, onProgress);
    hideProgress(); reading = false; renderAll();
    setStatus(`Designed ${n} page${n > 1 ? 's' : ''}. Check the captions and boxes under each page (change a page's type with its dropdown), then write the picture prompts.`, 'ok');
  } catch (e) { hideProgress(); setStatus(`Designing failed: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); }
}
// The editable design of one page: its panels (caption, speech, picture) and its boxes.
function designHtml(p) {
  const d = p.design;
  if (!d) return `<div class="design empty"><span class="hint">Not designed yet.</span> <button class="btn secondary small d-make" type="button">🧩 Design this page</button></div>`;
  const kinds = config.books.playKinds || [];
  return `<div class="design">
    <div class="d-head"><b>${escapeHtml(layoutOf(d.layout)?.label || d.layout)}</b><span class="hint">${d.by === 'author' ? 'chosen by you' : d.by === 'card' ? 'from the Flash Cards story' : 'chosen by the AI'} · lettered into the picture; the story text above is for reading aloud</span></div>
    ${d.panels.map((x, i) => `<div class="d-panel" data-i="${i}"><span class="d-num">${d.panels.length > 1 ? i + 1 : '▣'}</span>
      <input class="d-caption" type="text" maxlength="200" placeholder="Caption (≤ 9 words)" value="${escapeHtml(x.caption)}">
      <input class="d-speech" type="text" maxlength="80" placeholder="Speech / sound word" value="${escapeHtml(x.speech)}">
      <textarea class="d-visual" rows="2" placeholder="What this panel shows, and from where">${escapeHtml(x.visual)}</textarea></div>`).join('')}
    <div class="d-box"><select class="d-play-type"><option value="">No play box</option>${kinds.map((k) => `<option value="${k.id}">${escapeHtml(k.heading)}</option>`).join('')}</select><input class="d-play" type="text" maxlength="200" placeholder="What the child does (≤ 8 words)" value="${escapeHtml(d.play.prompt)}"></div>
    <div class="d-box"><span class="d-label">Did you know?</span><input class="d-fact" type="text" maxlength="300" placeholder="One true fact, or leave empty" value="${escapeHtml(d.fact)}"></div>
    <div class="d-box"><span class="d-label">For grown-ups</span><input class="d-grown" type="text" maxlength="300" placeholder="A tip for the reader, or leave empty" value="${escapeHtml(d.grownups)}"></div>
  </div>`;
}
function wireDesign(p, card) {
  const box = card.querySelector('.design');
  if (!box) return;
  box.querySelector('.d-make')?.addEventListener('click', () => designPages([p.id]));
  if (!p.design) return;
  box.querySelector('.d-play-type').value = p.design.play.type || '';
  const save = () => {
    const d = { ...p.design, panels: [...box.querySelectorAll('.d-panel')].map((el) => ({ caption: el.querySelector('.d-caption').value, speech: el.querySelector('.d-speech').value, visual: el.querySelector('.d-visual').value })),
      play: { type: box.querySelector('.d-play-type').value, prompt: box.querySelector('.d-play').value }, fact: box.querySelector('.d-fact').value, grownups: box.querySelector('.d-grown').value, by: 'author' };
    p.design = d; queue({ pages: [{ id: p.id, design: d }] });
    box.querySelector('.d-head .hint').textContent = 'edited by you · lettered into the picture; the story text above is for reading aloud';
  };
  for (const el of box.querySelectorAll('input, textarea, select')) el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', save);
}

async function rewritePage(p, card, instructions) {
  if (busy) return;
  setBusy(true);
  const st = card.querySelector('.p-status');
  await flush();
  card.classList.add('working');
  st.className = 'status p-status'; st.innerHTML = '<span class="spinner"></span>Rewriting…';
  try {
    book = await streamApi(`/api/books/${book.id}/scripts`, { pageIds: [p.id], instructions }, (pr) => { st.innerHTML = `<span class="spinner"></span>${escapeHtml(pr.snippet ? `“${pr.snippet}”` : pr.phase)}`; });
    renderAll();
    const fresh = els.pages.querySelector(`[data-id="${p.id}"] .p-status`);
    if (fresh) { fresh.className = 'status p-status ok'; fresh.textContent = `Rewritten${instructions ? ` (${instructions.replace(/\.$/, '').toLowerCase()})` : ''}. ↶ Undo restores the old text.`; }
  } catch (e) { card.classList.remove('working'); st.className = 'status p-status error'; st.textContent = `Rewrite failed: ${e.message}`; }
  finally { setBusy(false); }
}

async function illustrate(p, inBatch = false, body) {
  if (!inBatch) { if (busy) return; setBusy(true); }
  const card = () => els.pages.querySelector(`[data-id="${p.id}"]`);
  const c0 = card();
  const st = c0?.querySelector('.p-status');
  await flush();
  const t0 = Date.now();
  c0?.classList.add('working');
  const tick = () => { if (st) { st.className = 'status p-status'; st.innerHTML = `<span class="spinner"></span>Painting ${pageLabel(p).toLowerCase()} — ${Math.round((Date.now() - t0) / 1000)}s`; } };
  tick(); const t = setInterval(tick, 1000);
  if (c0) c0.querySelector('.p-image').disabled = true;
  try {
    const r = await api('POST', `/api/books/${book.id}/pages/${p.id}/image`, body);
    // With proofreading on, a picture that fails is redrawn once: both attempts come back and both were paid for.
    const made = r.records || [r.record];
    for (const x of made) records.set(x.id, x);
    records.set(r.record.id, r.record); book = r.book;
    const spent = made.reduce((n, x) => n + (x.costUsd || 0), 0);
    clearInterval(t);
    if (!reading) renderPages(); else renderPreview();
    const s2 = card()?.querySelector('.p-status');
    if (s2) { s2.className = 'status p-status ok'; s2.textContent = `Done in ${Math.round((Date.now() - t0) / 1000)}s${spent ? ` · ${fmtCost(spent)}` : ''}${made.length > 1 ? ' · redrawn once after proofreading' : ''}.`; }
    return { ...r.record, costUsd: spent || r.record.costUsd };
  } catch (e) {
    clearInterval(t); c0?.classList.remove('working');
    if (st) { st.className = 'status p-status error'; st.textContent = `Picture failed: ${e.message}`; }
    if (c0) c0.querySelector('.p-image').disabled = false;
    throw e;
  } finally { if (!inBatch) setBusy(false); }
}

// ---------- picture prompts ----------
// The step between page text and pictures. The server composes each prompt from the page's picture brief, the
// story world, the style and the cast; here they are read, edited and re-written before any picture is paid for.
async function writePrompts(pageIds, force = false) {
  if (busy) return;
  await flush();
  setBusy(true);
  try {
    book = await api('POST', `/api/books/${book.id}/prompts`, pageIds ? { pageIds } : { force });
    subtab = 'prompts'; reading = false;
    const s = flowState();
    setStatus(pageIds ? 'Prompt rewritten from the page as it is now.' : `${s.prompted} picture prompt${s.prompted === 1 ? '' : 's'} written. Read them through, change anything you like, then draw.`, 'ok');
  } catch (e) { setStatus(`Could not write the prompts: ${escapeHtml(e.message)}`, 'error'); }
  finally { busy = false; renderAll(); }
}
async function savePrompt(p, value) {
  await flush();
  try { book = await api('PATCH', `/api/books/${book.id}`, { pages: [{ id: p.id, imagePrompt: value }] }); setSave('All changes saved', 'ok'); }
  catch (e) { setSave(`Not saved: ${e.message}`, 'error'); }
  renderPrompts(); refreshFlow();
}
let promptFilter = 'all';     // all | look | edited
function renderPrompts() {
  if (!book || els.tabPrompts.hidden) return;
  const every = book.pages.filter((p) => p.illustration || p.beat);
  // With a prompt per page, the ones that need you are easy to lose: missing or out of date, and the ones you edited.
  const groups = { all: every, look: every.filter((p) => p.promptStale || (!p.imagePrompt && !p.imageId)), edited: every.filter((p) => p.imagePrompt && p.promptEdited && !p.promptStale) };
  if (!groups[promptFilter].length) promptFilter = 'all';
  const pages = groups[promptFilter];
  els.promptList.innerHTML = '';
  if (every.length) {
    const bar = document.createElement('div'); bar.className = 'seg-filters';
    bar.innerHTML = [['all', 'All'], ['look', 'Needs a look'], ['edited', 'Edited by you']].map(([k, label]) => `<button type="button" data-f="${k}" class="${k === promptFilter ? 'on' : ''}"${groups[k].length ? '' : ' disabled'}>${label} <small>${groups[k].length}</small></button>`).join('');
    bar.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b && !b.disabled) { promptFilter = b.dataset.f; renderPrompts(); } });
    els.promptList.appendChild(bar);
  }
  if (!pages.length) els.promptList.innerHTML = '<div class="empty">Write the page text first. Each page’s picture brief is what its prompt is built from.</div>';
  else renderDraftSheet();
  for (const p of pages) {
    const state = !p.imagePrompt ? ['', 'No prompt yet'] : p.promptStale ? ['warn', 'Page changed since this was written'] : p.promptEdited ? ['edited', 'Edited by you'] : ['ready', 'Prompt ready'];
    const linked = book.cast.filter((c) => c.characterId && p.characters.includes(c.name)).map((c) => c.name);
    const card = document.createElement('div');
    card.className = 'prompt-card' + (p.promptStale ? ' stale' : '');
    card.dataset.id = p.id;
    const thumb = p.imageId && imageUrl(p.imageId);
    card.innerHTML = `
      <div class="pc-head"><span class="chip">${pageLabel(p)}</span><h3>${escapeHtml(p.kind === 'cover' ? book.title : (p.beat || p.illustration).split(/(?<=[.!?])\s/)[0].slice(0, 70))}</h3><span class="chip ${state[0]}">${state[1]}</span>
        <span class="spacer"></span>
        <button class="btn quiet small pc-rewrite" type="button" title="Compose the prompt again from the page as it is now. This replaces your edits to it.">↻ Rewrite</button>
        <button class="btn secondary small pc-draw" type="button">${p.imageId ? '🎨 Draw again' : '🎨 Draw this one'}</button></div>
      <div class="pc-body">
        <div><div class="label-row"><span>Words on the page</span></div><p class="pc-words">${escapeHtml(p.kind === 'cover' ? book.title : p.text || '(not written yet)')}</p>
          ${thumb ? `<img src="${thumb}" alt="" style="width:92px;border-radius:4px;display:block">` : ''}</div>
        <div><div class="label-row"><span>Picture prompt</span><span class="hint">sent to the image model exactly as written</span></div>
          <textarea class="pc-text" spellcheck="true" placeholder="No prompt yet. Use ↻ Rewrite, or write your own.">${escapeHtml(p.imagePrompt || '')}</textarea>
          <div class="pc-tags">${[p.setting && `📍 ${p.setting}`, p.emotion && `💛 ${p.emotion}`, linked.length && `👤 reference pictures: ${linked.join(', ')}`].filter(Boolean).map((t) => `<span class="chip">${escapeHtml(String(t).slice(0, 80))}</span>`).join('')}</div></div>
      </div>`;
    const ta = card.querySelector('.pc-text');
    ta.addEventListener('change', () => savePrompt(p, ta.value.trim()));
    card.querySelector('.pc-rewrite').addEventListener('click', () => { if (!p.promptEdited || confirm('Rewrite this prompt from the page? Your edits to it will be replaced.')) writePrompts([p.id]); });
    card.querySelector('.pc-draw').addEventListener('click', async () => {
      if (ta.value.trim() !== (p.imagePrompt || '')) await savePrompt(p, ta.value.trim());
      subtab = 'pages'; renderAll();
      const page = book.pages.find((x) => x.id === p.id);
      els.pages.querySelector(`[data-id="${p.id}"]`)?.scrollIntoView({ block: 'center' });
      illustrate(page).catch(() => {});
    });
    els.promptList.appendChild(card);
  }
  const s = flowState(), missing = missingPictures().length;
  const each = estimateImageCost(book.image.model, book.image.size, book.image.quality);
  const linkedAll = book.cast.filter((c) => c.characterId).map((c) => c.name);
  els.promptSide.innerHTML = `
    <h3>Added to every prompt</h3>
    <div><div class="label-row"><span>Look</span></div><p>${escapeHtml(book.styleGuide || book.brief.style || 'warm, friendly picture-book illustration')}</p></div>
    <div><div class="label-row"><span>Character reference pictures</span></div><p>${linkedAll.length ? escapeHtml(linkedAll.join(', ')) : 'None. Cast members are described in words only.'}</p></div>
    <div><div class="label-row"><span>Size and quality</span></div><p>${escapeHtml(`${book.image.size} · ${book.image.quality} · ${book.image.model}`)}</p></div>
    <div class="estimate"><span class="hint">${missing ? `Drawing the ${missing} missing picture${missing === 1 ? '' : 's'} will cost about` : 'Every page has a picture'}</span><b>${missing && each ? fmtCost(each * missing) : missing ? '—' : '✓'}</b>
      <span class="hint">Prompts are free to rewrite. Drawing is the part that costs, so measure twice, draw once.</span></div>
    <button class="btn secondary small ps-all" type="button">${s.prompted ? '↻ Rewrite all prompts' : 'Write the picture prompts'}</button>
    <h3>Before you pay for pictures</h3>
    <button class="btn secondary small ps-draft" type="button" title="Draws every page that has no picture as a small, low-quality sketch, so you can see the whole book side by side first. A page whose prompt you then leave alone is painted with its draft as the composition.">✏️ Draft ${draftTodo().length ? `${draftTodo().length} page${draftTodo().length === 1 ? '' : 's'}` : 'pages'}${draftTodo().length && draftEach() ? ` ≈ ${fmtCost(draftEach() * draftTodo().length)}` : ''}</button>
    <button class="btn secondary small ps-similar" type="button" title="A fast, cheap decision model looks at each pair of neighbouring pages (drafts or pictures) and says whether they would read as the same picture.">👀 Check for look-alike pages</button>
    <span class="hint">Drafts cost a fraction of a picture. Look-alikes are marked on the sheet.</span>`;
  els.promptSide.querySelector('.ps-draft').addEventListener('click', draftAll);
  els.promptSide.querySelector('.ps-similar').addEventListener('click', checkSimilar);
  els.promptSide.querySelector('.ps-all').addEventListener('click', () => { if (!s.prompted || confirm('Rewrite every prompt from the pages as they are now? Prompts you edited are replaced too.')) writePrompts(null, true); });
}

// ---------- drafts and look-alikes ----------
// A draft is a small low-quality sketch of a page, made from its prompt. The sheet shows the whole book side by side
// (the picture where there is one, else the draft), with neighbours that look alike marked.
const draftTodo = () => book.pages.filter((p) => (p.illustration || p.beat) && !p.imageId && !p.draftCurrent);
const draftEach = () => estimateImageCost(book.image.model, '736x944', 'low') || estimateImageCost(book.image.model, '1024x1024', 'low');
const ALIKE = 0.5;
function alikePairs() {
  const byN = new Map(book.pages.filter((p) => p.kind === 'page').map((p) => [p.n, p]));
  const cur = (p) => p && (p.imageId || p.draftId);
  return (book.similar?.pairs || []).filter((x) => x.p >= ALIKE && cur(byN.get(x.a)) === x.aId && cur(byN.get(x.b)) === x.bId);
}
function renderDraftSheet() {
  const pages = book.pages.filter((p) => p.illustration || p.beat);
  if (!pages.some((p) => p.imageId || p.draftId)) return;
  const alike = alikePairs();
  const box = document.createElement('div'); box.className = 'draft-sheet';
  box.innerHTML = `<div class="ds-head"><b>The whole book, side by side</b><span class="hint">${alike.length ? `⚠ ${alike.length} pair${alike.length === 1 ? '' : 's'} of neighbouring pages look alike. Change the picture brief or the prompt of one page in each pair, then draft it again.` : book.similar ? 'No neighbouring pages look alike.' : 'Do the pages differ from each other? Is everyone where they should be?'}</span></div>
    <div class="ds-grid">${pages.map((p) => {
      const id = p.imageId || p.draftId, url = id && imageUrl(id);
      const hit = alike.find((x) => x.b === p.n);
      return `<a class="ds-cell${hit ? ' alike' : ''}" data-id="${p.id}" title="${escapeHtml(pageLabel(p))}${hit ? ` · looks like page ${hit.a} (${Math.round(hit.p * 100)}%)` : ''}">${url ? `<img src="${url}" alt="" loading="lazy">` : '<span class="ds-none">no draft</span>'}<small>${escapeHtml(pageLabel(p))}${p.imageId ? '' : p.draftId ? (p.draftCurrent ? ' · draft' : ' · old draft') : ''}${hit ? ` · like p${hit.a}` : ''}</small></a>`;
    }).join('')}</div>`;
  box.addEventListener('click', (e) => { const c = e.target.closest('.ds-cell'); if (c) els.promptList.querySelector(`.prompt-card[data-id="${c.dataset.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  els.promptList.insertBefore(box, els.promptList.querySelector('.prompt-card'));
}
async function draftAll() {
  if (busy) return;
  await flush();
  const todo = draftTodo();
  if (!todo.length) { setStatus('Every page already has a picture or an up-to-date draft.', 'ok'); return; }
  const each = draftEach();
  if (!confirm(`Draft ${todo.length} page${todo.length === 1 ? '' : 's'} as small low-quality sketches?\n${each ? `Estimated cost ≈ ${fmtCost(each * todo.length)} (≈ ${fmtCost(each)} each).` : 'Each draft is a paid generation, at a fraction of the price of a picture.'}`)) return;
  setBusy(true); stopRequested = false; els.stop.hidden = false;
  const onProgress = showProgress('Drafting');
  let done = 0, cost = 0;
  try {
    // Drafts do not depend on each other, so three are drawn at a time.
    for (let i = 0; i < todo.length && !stopRequested; i += 3) {
      const batch = todo.slice(i, i + 3);
      onProgress({ phase: `Sketching ${batch.map((p) => pageLabel(p).toLowerCase()).join(', ')} · spent ${fmtCost(cost)}`, done, total: todo.length });
      const out = await Promise.all(batch.map((p) => api('POST', `/api/books/${book.id}/pages/${p.id}/draft`)));
      for (const r of out) { records.set(r.record.id, r.record); cost += r.record.costUsd || 0; done++; }
      book = out[out.length - 1].book;
      book = await api('GET', `/api/books/${book.id}`);
      renderPrompts();
    }
    hideProgress();
    setStatus(`${stopRequested ? 'Stopped' : 'Done'}: ${done} draft${done === 1 ? '' : 's'} for ≈ ${fmtCost(cost)}. Look at them side by side, then 👀 check for look-alikes.`, 'ok');
  } catch (e) { hideProgress(); setStatus(`Stopped after ${done} draft${done === 1 ? '' : 's'}: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); els.stop.hidden = true; renderPrompts(); }
}
async function checkSimilar() {
  if (busy) return;
  await flush();
  setBusy(true); setStatus('<span class="spinner"></span>Comparing neighbouring pages…');
  try {
    const r = await api('POST', `/api/books/${book.id}/similar`);
    book = r.book;
    const n = alikePairs().length;
    setStatus(`${r.compared} pair${r.compared === 1 ? '' : 's'} compared${r.costUsd ? ` · ${fmtCost(r.costUsd)}` : ''}: ${n ? `${n} look alike (marked on the sheet).` : 'no two neighbours look alike.'}${r.error ? ` Some could not be compared: ${escapeHtml(r.error)}` : ''}`, n ? 'error' : 'ok');
  } catch (e) { setStatus(`Could not compare the pages: ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); renderPrompts(); }
}

async function illustrateMissing() {
  await flush();
  if (subtab !== 'pages' && !reading) { subtab = 'pages'; renderAll(); }
  const todo = missingPictures();
  if (!todo.length) { setStatus('Every page already has a picture. Use 🎨 Try another picture on a page to redo it.', 'ok'); return; }
  // Draft first (Brief & settings): pages with no up-to-date draft are drafted before any full picture is paid for.
  if (book.image.draftFirst !== false && !book.fromSeries && todo.some((p) => !p.draftCurrent)) {
    subtab = 'prompts'; reading = false; renderAll();
    setStatus('“Draft first” is on: pages without an up-to-date draft are sketched first. Look the drafts over, then illustrate.', 'ok');
    return draftAll();
  }
  const each = estimateImageCost(book.image.model, book.image.size, book.image.quality);
  const unlinked = book.cast.filter((c) => !c.characterId);
  const warn = unlinked.length ? `\n\nHeads up: ${unlinked.map((c) => c.name).join(', ')} ${unlinked.length > 1 ? 'are' : 'is'} described in words only and may look different on every page. Cancel and use 🎨 Design character first for consistency.` : '';
  if (!confirm(`Illustrate ${todo.length} page${todo.length > 1 ? 's' : ''} at ${book.image.size} (${book.image.quality})?\n${each ? `Estimated cost ≈ ${fmtCost(each * todo.length)} (≈ ${fmtCost(each)} each, from your history).` : 'Each picture is a paid generation; the cost shows after the first one.'}${warn}`)) return;
  setBusy(true); stopRequested = false; els.stop.hidden = false;
  const onProgress = showProgress('Illustrating');
  let done = 0, cost = 0;
  try {
    for (const p of todo) {
      if (stopRequested) break;
      onProgress({ phase: `Painting ${pageLabel(p).toLowerCase()} (${done + 1} of ${todo.length}) · spent ${fmtCost(cost)}`, done, total: todo.length, snippet: p.illustration.slice(0, 140) });
      els.pages.querySelector(`[data-id="${p.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const rec = await illustrate(p, true);
      done++; cost += rec.costUsd || 0;
    }
    hideProgress();
    setStatus(`${stopRequested ? 'Stopped' : 'Done'}: ${done} picture${done === 1 ? '' : 's'} for ≈ ${fmtCost(cost)}. They’re also in your image History, tagged “book”.`, 'ok');
    if (done) window.dvShell?.flyby?.(missingPictures().length ? `${done} picture${done === 1 ? '' : 's'} landed` : 'Every page has its picture!');
  } catch (e) { hideProgress(); setStatus(`Stopped after ${done} picture${done === 1 ? '' : 's'} (≈ ${fmtCost(cost)}): ${escapeHtml(e.message)}`, 'error'); }
  finally { setBusy(false); els.stop.hidden = true; els.stop.textContent = 'Stop after this page'; await loadBooks(); }
}

async function designCast(c, btn) {
  if (!c.description) { setStatus('Describe the character first.', 'error'); return; }
  const each = estimateImageCost(book.image.model, '1024x1024', 'high');
  if (!confirm(`Design ${c.name} as a studio character?\n\nThis makes three pictures (about two minutes, ≈ $0.30): a master drawing, a clean turnaround sheet that every page with ${c.name} will use as a reference, and a detailed character bible (profile, design breakdown, expressions, palette, on-model rules).`)) return;
  await flush();
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>Designing…';
  try {
    const r = await api('POST', `/api/books/${book.id}/cast/${c.id}/design`);
    records.set(r.record.id, r.record); book = r.book;
    for (const x of [r.sheet, r.bible]) if (x) records.set(x.id, x);
    characters = await api('GET', '/api/characters');
    renderAll();
    setStatus(`${escapeHtml(c.name)} is now an on-model studio character with a turnaround sheet${r.bible ? ` and a <a href="${r.bible.url}" target="_blank">character bible</a>` : ''}.${r.extrasError ? ` (The detailed sheet step failed: ${escapeHtml(r.extrasError)})` : ''}`, r.extrasError ? 'error' : 'ok');
  } catch (e) { setStatus(`Design failed: ${escapeHtml(e.message)}`, 'error'); btn.disabled = false; btn.textContent = '🎨 Design character'; }
}

// Text boxes grow to show everything typed in them. Chrome does this in CSS (field-sizing); elsewhere, measure and set.
const GROW_IN_CSS = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
function grow(t) { if (GROW_IN_CSS || !t.offsetParent) return; t.style.height = 'auto'; t.style.height = `${t.scrollHeight + 2}px`; }
function growAll() { if (!GROW_IN_CSS) for (const t of document.querySelectorAll('body.books textarea')) grow(t); }
document.addEventListener('input', (e) => { if (e.target.tagName === 'TEXTAREA') grow(e.target); });
if (!GROW_IN_CSS) new MutationObserver(() => requestAnimationFrame(growAll)).observe(document.querySelector('main'), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });

// ---------- init ----------
async function init() {
  config = await api('GET', '/api/config');
  config.books.arcStages ||= []; config.books.storyline ||= [];
  fillSelect(els.audience, config.books.ageBands, '3-5');
  fillSelect(els.imgModel, config.imageModels, config.defaultImageModel);
  fillSelect(els.imgQuality, config.qualities, 'high');
  fillSelect(els.pageStyle, config.books.pageStyles || [{ id: 'classic', label: 'Classic picture book' }], 'classic');
  fillSelect(els.imgSize, config.sizePresets, '2176x2816');
  els.topbar.textContent = config.hasApiKey ? `Words by ${config.books.model} · pictures by ${config.defaultImageModel.replace('gpt-image-', 'GPT Image ')}` : '⚠ Add your OpenAI key to .env, then restart';
  const [hist, chars] = await Promise.all([api('GET', '/api/history'), api('GET', '/api/characters')]);
  for (const r of hist) records.set(r.id, r);
  characters = chars;
  await loadBooks();
  const last = localStorage.getItem(LAST_KEY);
  if (urlState.any()) await applyUrl();
  else if (last && books.some((b) => b.id === last)) await openBook(last); else renderAll();
  ready = true; syncUrl(); started = true;
  urlState.onChange(() => applyUrl().catch((e) => setStatus(escapeHtml(e.message), 'error')));

  els.bookSelect.addEventListener('change', () => (els.bookSelect.value ? openBook(els.bookSelect.value) : closeBook()));
  els.newBook.addEventListener('click', newBook);
  els.back.addEventListener('click', closeBook);
  els.readToggle.addEventListener('click', toggleReading);
  els.toSheets.addEventListener('click', () => sendToSheets().catch((e) => setStatus(escapeHtml(e.message), 'error')));
  els.shelfSort.addEventListener('change', () => setShelfPref('sort', els.shelfSort.value));
  els.shelfChar.addEventListener('change', () => setShelfPref('char', els.shelfChar.value));
  els.shelfGrid.addEventListener('click', (e) => { const b = e.target.closest('.shelf-book'); if (b) (b.dataset.id ? openBook(b.dataset.id) : newBook()); });
  els.subtabs.addEventListener('click', async (e) => { const t = e.target.closest('[data-sub]'); if (t) { await flush(); subtab = t.dataset.sub; renderAll(); } });
  els.dlStory.addEventListener('change', renderReadBar);
  els.readText.value = ['over', 'below', 'none'].includes(localStorage.getItem(READ_TEXT_KEY)) ? localStorage.getItem(READ_TEXT_KEY) : 'auto';
  if (book && reading) renderPreview();
  els.readText.addEventListener('change', () => { localStorage.setItem(READ_TEXT_KEY, els.readText.value); if (book && reading) renderPreview(); });
  els.fillBrief.addEventListener('click', fillBrief);
  els.fillDetails.addEventListener('click', fillDetails);
  els.checkLogic.addEventListener('click', checkLogic);
  els.editPass.addEventListener('click', editPass);
  els.worldSheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ws]');
    if (!b || busy) return;
    if (b.dataset.ws === 'draw') drawWorldSheet();
    else { book.worldSheetId = null; queue({ worldSheetId: null }); flush().then(renderWorldSheet); }
  });
  for (const k of ['refrain', 'device']) els[k].addEventListener('input', () => { book[k] = els[k].value; queue({ [k]: els[k].value }); });
  els.logic.addEventListener('click', (e) => {
    if (!e.target.closest('[data-fix-hole]')) return;
    const h = book.logic?.holes.find((x) => x.id === e.target.closest('[data-hole]').dataset.hole);
    if (h) fixHole(h);
  });
  els.world.addEventListener('input', () => { book.world = els.world.value; els.world.classList.toggle('gap', !els.world.value.trim()); queue({ world: els.world.value }); });
  els.deleteBook.addEventListener('click', deleteBook);
  els.next.addEventListener('click', () => nextAction().run());
  els.undo.addEventListener('click', undo);
  els.stop.addEventListener('click', () => { stopRequested = true; els.stop.textContent = 'Stopping after this page…'; });
  els.suggest.addEventListener('click', suggestIdeas);
  els.redraft.addEventListener('click', draftOutline);
  els.outlineInstructions.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !busy) { e.preventDefault(); draftOutline(); } });
  // Clicking a step runs it (outline/text/pictures) or toggles reading.
  for (const li of els.stepper.children) li.addEventListener('click', () => {
    if (busy || li.classList.contains('locked')) return;
    const k = li.dataset.step;
    if (k === 'outline') { if (!storyPages().length || confirm('Re-draft the whole outline? ↶ Undo can bring the current one back.')) draftOutline(); }
    else if (k === 'scripts') { if (!storyPages().some((p) => p.text) || confirm('Rewrite the text of every page? ↶ Undo can bring the current text back.')) writeScripts(false); }
    else if (k === 'prompts') { if (flowState().prompted) { subtab = 'prompts'; reading = false; renderAll(); } else writePrompts(); }
    else if (k === 'images') illustrateMissing();
    else toggleReading();
  });
  els.premise.addEventListener('input', () => { els.suggest.textContent = els.premise.value.trim() ? '✨ Develop this idea' : '✨ Suggest ideas'; refreshFlow(); });
  els.pageCount.addEventListener('change', () => { const v = snapFours(els.pageCount.value); if (Number(els.pageCount.value) !== v) { els.pageCount.value = v; if (book) queue({ brief: briefFromForm() }); } });
  for (const el of [els.premise, els.tone, els.themeBrief, els.setting, els.style, els.briefNotes, els.pageCount]) el.addEventListener('input', () => { renderBriefGaps(); if (book) queue({ brief: briefFromForm() }); });
  els.audience.addEventListener('change', () => { if (book) { queue({ brief: briefFromForm() }); book.brief.audience = els.audience.value; if (book.pages.length && !reading) renderPages(); } });
  for (const el of [els.imgModel, els.imgQuality, els.imgSize, els.textInImage, els.proof, els.refs, els.leanRefs, els.draftFirst, els.pageStyle]) el.addEventListener('change', () => { renderArtSummary(); renderPageStyleHint(); if (book) { book.image = imageFromForm(); queue({ image: book.image }); if (el === els.pageStyle) flush().then(() => api('GET', `/api/books/${book.id}`)).then((b) => { book = b; renderAll(); }).catch(() => {}); else refreshFlow(); } });
  els.title.addEventListener('input', () => queue({ title: els.title.value }));
  els.logline.addEventListener('input', () => { queue({ logline: els.logline.value }); els.headLogline.textContent = els.logline.value; });
  els.theme.addEventListener('input', () => queue({ theme: els.theme.value }));
  els.styleGuide.addEventListener('input', () => queue({ styleGuide: els.styleGuide.value }));
  els.addCast.addEventListener('click', () => { book.cast.push({ id: crypto.randomUUID(), name: 'New character', role: '', description: '', characterId: null }); queue({ cast: book.cast }); flush().then(renderCast); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !els.next.disabled) { e.preventDefault(); nextAction().run(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flush(); }
  });
}

document.addEventListener('dv-shell', syncHead);
init().catch((e) => setStatus(`Failed to load: ${e.message}`, 'error'));
