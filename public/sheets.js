// Print Sheets — one workspace in work order: 1 pick pictures, 2 check the sheet (one page at a time, exactly as it prints),
// 3 set it up. The sheet's name, the Sheets menu and Build PDF sit in the page header.
import { computeLayout, itemKey, edgeMarks, DEFAULT_SPEC, round3 } from '/sheets-layout.js';

const $ = (id) => document.getElementById(id);
const els = {
  name: $('name'), saveState: $('save-state'), sheetsBtn: $('sheets-btn'), sheetsPop: $('sheets-pop'), buildMeta: $('build-meta'),
  page: $('page'), orientation: $('orientation'), customSize: $('custom-size'), customWidth: $('custom-width'), customHeight: $('custom-height'), pageNote: $('page-note'),
  grid: $('grid'), gridTiles: $('grid-tiles'), gridNote: $('grid-note'), customGrid: $('custom-grid'), cols: $('cols'), rows: $('rows'),
  spacingSeg: $('spacing-seg'), spacingNote: $('spacing-note'), margin: $('margin'), gutter: $('gutter'), fit: $('fit'), maxDpi: $('max-dpi'),
  cutMarks: $('cut-marks'), pack: $('pack'), outline: $('outline'), label: $('label'), encode: $('encode'), duplex: $('duplex'), flip: $('flip'), backFit: $('back-fit'), duplexOptions: $('duplex-options'),
  flipNote: $('flip-note'), moreNote: $('more-note'),
  summary: $('summary'), warnings: $('warnings'), build: $('build'), status: $('status'), render: $('render'),
  stage: $('stage'), preview: $('preview'), previewMeta: $('preview-meta'), sideSeg: $('side-seg'), pager: $('pager'), pagerLabel: $('pager-label'), prev: $('prev'), next: $('next'),
  clear: $('clear'), itemsMeta: $('items-meta'), items: $('items'), piece: $('piece'), allBack: $('all-back'),
  search: $('search'), sourceFilter: $('source-filter'), folderChips: $('folder-chips'), refresh: $('refresh'), pickerHint: $('picker-hint'), pickerCount: $('picker-count'), picker: $('picker'), topbar: $('topbar-meta'),
};

let config = null;
let spec = { ...DEFAULT_SPEC, items: [] };
let sheetId = null;
let sheets = [];
let sources = [];
const imagesById = new Map();
let busy = false;
let layout = null;
let armedBack = null;          // index of the item whose back the next picker click fills
let selItem = null;            // index of the piece whose details show under the strip
const view = { sheet: 0, side: 'front' };   // the one page the preview shows
// Spacing presets turn the laminate / guillotine advice into a choice. They only set the margin and the gap.
const SPACING = {
  laminate: { margin: 0.25, gutter: 0.5, note: 'A ½ in gap, so every piece keeps a sealed edge after cutting.' },
  cut: { margin: 0.375, gutter: 0, note: 'No gap, so each cut line is shared. The ⅜ in margin lets the crop marks at the page edges print.' },
  custom: { note: 'Laminating: keep the gap at ¼–½ in. Cutting only: a gap of 0 and a margin of ⅜ in.' },
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DRAFT_KEY = 'dadventures.sheetDraft';
const DND = 'application/x-sheet';   // dataTransfer type: JSON { kind: 'image'|'item', id?, index? }

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(text, kind = '') { els.status.className = `status ${kind}`; els.status.innerHTML = text; }
const fmtBytes = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- spec <-> form ----------
function readForm() {
  spec = {
    ...spec,
    page: els.page.value, orientation: els.orientation.value,
    customWidth: Number(els.customWidth.value) || 8.5, customHeight: Number(els.customHeight.value) || 11,
    grid: els.grid.value, cols: Number(els.cols.value) || 2, rows: Number(els.rows.value) || 2,
    margin: Number(els.margin.value) || 0, gutter: Number(els.gutter.value) || 0,
    fit: els.fit.value, maxDpi: Number(els.maxDpi.value) || 400, encode: els.encode.value,
    cutMarks: els.cutMarks.checked, pack: els.pack.checked, outline: els.outline.checked, label: els.label.checked,
    duplex: els.duplex.checked, flip: els.flip.value, backFit: els.backFit.value,
  };
  els.customSize.hidden = spec.page !== 'custom';
  els.customGrid.hidden = spec.grid !== 'custom';
  els.duplexOptions.hidden = !spec.duplex;
  const preset = config.sheets.pageSizes.find((p) => p.id === spec.page);
  els.pageNote.textContent = preset ? preset.note : '';
}
function writeForm() {
  els.page.value = spec.page; els.orientation.value = spec.orientation;
  els.customWidth.value = spec.customWidth; els.customHeight.value = spec.customHeight;
  els.grid.value = spec.grid; els.cols.value = spec.cols; els.rows.value = spec.rows;
  els.margin.value = spec.margin; els.gutter.value = spec.gutter; els.fit.value = spec.fit;
  els.maxDpi.value = [300, 400, 600, 1200].includes(spec.maxDpi) ? String(spec.maxDpi) : '400';
  els.encode.value = spec.encode === 'png' ? 'png' : 'jpeg';
  els.cutMarks.checked = spec.cutMarks; els.pack.checked = Boolean(spec.pack); els.outline.checked = spec.outline; els.label.checked = Boolean(spec.label);
  els.duplex.checked = Boolean(spec.duplex); els.flip.value = spec.flip === 'short' ? 'short' : 'long'; els.backFit.value = spec.backFit === 'cover' ? 'cover' : 'contain';
  readForm();
}
function saveDraft() { localStorage.setItem(DRAFT_KEY, JSON.stringify({ sheetId, name: els.name.value, spec })); }

// ---------- URL state: the open sheet, every layout setting and the picker filter live in the link ----------
// A bare /sheets.html resumes the draft in this browser. ?sheet=<id> is that sheet as saved; a setting appears in the
// link only where it differs from the saved sheet (or from the defaults when the sheet has not been saved).
const URL_KEYS = { page: 'page', orientation: 'orientation', customWidth: 'w', customHeight: 'h', grid: 'grid', cols: 'cols', rows: 'rows', margin: 'margin', gutter: 'gutter',
  fit: 'fit', maxDpi: 'dpi', encode: 'encode', cutMarks: 'marks', pack: 'pack', outline: 'outline', label: 'label', duplex: 'duplex', flip: 'flip', backFit: 'backfit' };
const BOOL_KEYS = new Set(['cutMarks', 'pack', 'outline', 'label', 'duplex']);
const NUM_KEYS = new Set(['customWidth', 'customHeight', 'cols', 'rows', 'margin', 'gutter', 'maxDpi']);
const SELECT_KEYS = { page: 'page', orientation: 'orientation', grid: 'grid', fit: 'fit', encode: 'encode', flip: 'flip', backFit: 'backFit' };   // spec key → form control
const urlText = (k, v) => (BOOL_KEYS.has(k) ? (v ? '1' : '0') : String(v ?? ''));
let ready = false, started = false, applying = false;
const baseSpec = () => ({ ...DEFAULT_SPEC, ...(sheets.find((s) => s.id === sheetId)?.spec || {}) });
const cleanSpec = (sp) => ({ ...DEFAULT_SPEC, ...sp, items: (sp?.items || []).filter((it) => imagesById.has(itemKey(it))).map((it) => ({ ...it, back: it.back && imagesById.has(itemKey(it.back)) ? it.back : null })) });
function syncUrl() {
  if (!ready || applying) return;
  const base = baseSpec(), defaults = {};
  const patch = { sheet: sheetId, q: els.search.value.trim(), folder: els.sourceFilter.value };
  for (const [k, p] of Object.entries(URL_KEYS)) { patch[p] = urlText(k, spec[k]); defaults[p] = urlText(k, base[k]); }
  urlState.set(patch, { defaults, pushOn: started ? ['sheet'] : [] });
}
function fromUrl(k, v, fallback) {
  if (v == null) return fallback;
  if (BOOL_KEYS.has(k)) return v === '1';
  if (NUM_KEYS.has(k)) return v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
  return [...els[SELECT_KEYS[k]].options].some((o) => o.value === v) ? v : fallback;
}
// Used on load and on Back/Forward. Pieces come from the local draft when it belongs to the sheet being opened
// (so a reload keeps unsaved arranging), otherwise from the saved sheet; layout settings always follow the link.
async function applyUrl() {
  applying = true;
  try {
    let draft = null;
    try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { /* ignore a corrupt draft */ }
    const bare = !urlState.any();
    const exists = (id) => (id && sheets.some((s) => s.id === id) ? id : null);
    const draftId = exists(draft?.sheetId), want = bare ? draftId : exists(urlState.get('sheet'));
    let name = '';
    if (draft?.spec && draftId === want) { spec = cleanSpec(draft.spec); name = draft.name || ''; }
    else if (want) { const s = await api('GET', `/api/sheets/${encodeURIComponent(want)}`); spec = cleanSpec(s.spec); name = s.name; }
    else spec = { ...DEFAULT_SPEC, items: [] };
    sheetId = want; armedBack = null; els.name.value = name;
    if (!bare) { const base = baseSpec(); for (const [k, p] of Object.entries(URL_KEYS)) spec[k] = fromUrl(k, urlState.get(p), base[k]); }
    writeForm();
    renderRender(sheets.find((s) => s.id === sheetId)?.lastRender || null);
    selItem = null; view.sheet = 0; view.side = 'front';
    els.search.value = urlState.get('q') || '';
    const folder = urlState.get('folder') || '';
    els.sourceFilter.value = sources.some((s) => s.id === folder) ? folder : '';
    update();
  } finally { applying = false; }
  syncUrl();
}

// ---------- render everything ----------
function update() {
  readForm();
  layout = computeLayout(spec, imagesById);
  syncControls(layout);
  renderPreview(layout);
  renderItems();
  renderSummary(layout);
  renderPicker();
  renderHead();
  saveDraft();
  syncUrl();
}

// Segmented controls and tiles are faces for hidden <select>s, so the form, the draft and the link keep one source of truth.
function syncControls(layout) {
  for (const box of document.querySelectorAll('[data-for]')) {
    const v = $(box.dataset.for).value;
    for (const b of box.querySelectorAll('button[data-v]')) { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-pressed', b.dataset.v === v); }
  }
  const preset = Object.keys(SPACING).find((k) => SPACING[k].margin === spec.margin && SPACING[k].gutter === spec.gutter) || 'custom';
  for (const b of els.spacingSeg.querySelectorAll('button')) { b.classList.toggle('on', b.dataset.preset === preset); b.setAttribute('aria-pressed', b.dataset.preset === preset); }
  els.spacingNote.textContent = SPACING[preset].note;
  const cell = `${layout.cols} × ${layout.rows} grid · each cell is ${round3(layout.cell.width)} × ${round3(layout.cell.height)} in`;
  els.gridNote.textContent = spec.grid === 'auto' ? (layout.count ? `Auto: ${cell}` : 'Auto picks the best fit as you add pictures.') : cell;
  els.flipNote.textContent = `Each back is mirrored so it lands behind its front. At the print shop, ask for “double-sided, flip on the ${spec.flip} edge”.`;
  const more = [spec.fit === 'cover' ? 'Fill the cell' : 'Whole image', spec.maxDpi >= 1200 ? 'Full resolution' : `${spec.maxDpi} DPI`, spec.encode === 'png' ? 'PNG' : 'JPEG'];
  if (spec.pack) more.push('packed'); if (spec.outline) more.push('border'); if (spec.label) more.push('name label');
  els.moreNote.textContent = more.join(' · ');
}

// What is saved is compared as text: the name plus every setting and piece, in a fixed order.
const sig = (name, sp) => JSON.stringify([name || '', Object.keys(DEFAULT_SPEC).sort().map((k) => (k === 'items'
  ? (sp.items || []).map((it) => [it.source, it.rel, Math.max(1, it.copies || 1), it.back ? [it.back.source, it.back.rel] : null])
  : sp[k] ?? DEFAULT_SPEC[k]))]);
function isDirty() {
  const saved = sheets.find((s) => s.id === sheetId);
  return !saved || sig(saved.name, { ...DEFAULT_SPEC, ...saved.spec }) !== sig(els.name.value.trim(), spec);
}
function renderHead() {
  if (!layout) return;
  const dirty = isDirty();
  const state = sheetId ? (dirty ? 'Unsaved changes' : 'Saved') : (spec.items.length ? 'Not saved' : '');
  els.saveState.textContent = state; els.saveState.hidden = !state; els.saveState.classList.toggle('ok', state === 'Saved');
  const preset = config.sheets.pageSizes.find((p) => p.id === spec.page);
  const paper = preset && preset.id !== 'custom' ? preset.label : `${round3(layout.page.width)} × ${round3(layout.page.height)} in`;
  const sub = layout.count ? `${paper} · ${layout.cols * layout.rows} per page${layout.duplex ? ' · double-sided' : ''}` : 'Pick pictures on the left to start.';
  window.dvShell?.setHead({ title: $('ws-name'), sub });
  const pages = layout.pages.length, last = sheets.find((s) => s.id === sheetId)?.lastRender;
  els.buildMeta.querySelector('b').textContent = !layout.count ? 'Nothing to build yet'
    : layout.duplex ? `${plural(pages, 'page')} · ${plural(pages / 2, 'sheet')} of paper` : `${plural(pages, 'page')} · ${plural(layout.count, 'piece')}`;
  els.buildMeta.querySelector('small').textContent = !layout.count ? 'Add a picture first'
    : last && !dirty ? `PDF built · ${fmtBytes(last.bytes)}` : `${spec.encode === 'png' ? 'PNG' : 'JPEG'} · ${spec.maxDpi >= 1200 ? 'full resolution' : `${spec.maxDpi} DPI`}`;
  renderMenu();
}
function renderMenu() {
  els.sheetsPop.innerHTML = `
    <button type="button" data-act="new">+ New sheet</button>
    <button type="button" data-act="save" ${spec.items.length && isDirty() ? '' : 'disabled'}>Save this sheet</button>
    <div class="ws-pop-label">Saved sheets</div>
    ${sheets.map((s) => `<button type="button" class="${s.id === sheetId ? 'on' : ''}" data-open="${escapeHtml(s.id)}"><b>${escapeHtml(s.name)}</b><small>${plural(s.spec.items.length, 'picture')}${s.spec.duplex ? ' · double-sided' : ''}${s.lastRender ? ' · PDF' : ''}</small></button>`).join('') || '<div class="hint">None yet. Save this sheet, or build its PDF.</div>'}
    <button type="button" class="danger" data-act="delete" ${sheetId ? '' : 'disabled'} title="Its PDF is removed; source pictures are untouched">Delete this sheet</button>`;
}

function renderSummary(layout) {
  const first = layout.pages[0]?.slots.find((s) => s.image);
  const imgSize = first ? `${round3(first.draw.w)} × ${round3(first.draw.h)} in` : '—';
  const dpis = layout.pages.flatMap((p) => p.slots.map((s) => s.dpi).filter(Boolean));
  const lo = Math.min(...dpis), hi = Math.max(...dpis);
  const dpi = dpis.length ? `${lo}${hi !== lo ? `–${hi}` : ''} DPI` : '—';
  const sheetsN = layout.count ? Math.ceil(layout.pages.length / (layout.duplex ? 2 : 1)) : 0;
  const paper = !layout.count ? '—' : plural(sheetsN, layout.duplex ? 'sheet' : 'page');
  els.summary.innerHTML = `
    <div><span>Each piece prints</span><b>${imgSize}</b></div>
    <div><span>Picture detail</span><b class="${dpis.length ? (lo < 150 ? 'low' : 'ok') : ''}">${dpi}${dpis.length && lo < 150 ? ' · soft' : ''}</b></div>
    <div><span>Paper needed</span><b>${paper}</b></div>`;
  const noBack = spec.duplex ? spec.items.reduce((n, it) => n + (it.back ? 0 : Math.max(1, it.copies || 1)), 0) : 0;
  const warns = layout.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`);
  if (noBack) warns.push(`<div>⚠ ${noBack === 1 ? '1 piece has' : `${noBack} pieces have`} no back and will print blank on the reverse. <button type="button" class="ws-link" data-act="show-noback">Show</button></div>`);
  els.warnings.hidden = !warns.length;
  els.warnings.innerHTML = warns.join('');
  els.build.disabled = busy || !layout.count;
}

// Map an expanded slot index back to the item index in spec.items (copies expand into consecutive slots).
function itemIndexForSlot(slotIndex) {
  let n = 0;
  for (let i = 0; i < spec.items.length; i++) { n += Math.max(1, spec.items[i].copies || 1); if (slotIndex < n) return i; }
  return -1;
}
const firstSlotOfItem = (index) => spec.items.slice(0, index).reduce((n, it) => n + Math.max(1, it.copies || 1), 0);
// A drop on one slot must only change that slot. If the slot belongs to a row with several copies, split the row so the
// slot becomes its own single-copy row (the printed order does not change). Returns the index of that row.
function splitSlot(slotIndex) {
  let n = 0;
  for (let i = 0; i < spec.items.length; i++) {
    const it = spec.items[i];
    const c = Math.max(1, it.copies || 1);
    if (slotIndex < n + c) {
      if (c === 1) return i;
      const k = slotIndex - n;
      const clone = (copies) => ({ ...it, copies, back: it.back ? { ...it.back } : null });
      const parts = [];
      if (k > 0) parts.push(clone(k));
      parts.push(clone(1));
      if (c - k - 1 > 0) parts.push(clone(c - k - 1));
      spec.items.splice(i, 1, ...parts);
      return i + (k > 0 ? 1 : 0);
    }
    n += c;
  }
  return -1;
}

// The preview shows one page at a time, as large as the stage allows; the pager and Fronts / Backs choose which.
function currentPage(layout) {
  const per = layout.duplex ? 2 : 1, n = Math.ceil(layout.pages.length / per);
  view.sheet = Math.max(0, Math.min(n - 1, view.sheet));
  if (!layout.duplex) view.side = 'front';
  return { pg: layout.pages[view.sheet * per + (view.side === 'back' ? 1 : 0)], n };
}
function fitStage() {
  const c = els.preview.querySelector('.canvas');
  if (!c) return;
  const w = Number(c.dataset.w), h = Number(c.dataset.h);
  const k = Math.min(els.preview.clientWidth / w, els.preview.clientHeight / h);
  if (!(k > 0)) return;
  c.style.width = `${Math.floor(w * k)}px`; c.style.height = `${Math.floor(h * k)}px`;
}
new ResizeObserver(fitStage).observe(els.preview);

function renderPreview(layout) {
  const size = `${round3(layout.page.width)} × ${round3(layout.page.height)} in`;
  els.pager.hidden = !layout.count; els.sideSeg.hidden = !layout.count || !layout.duplex;
  $('view').classList.toggle('tall', layout.page.height > layout.page.width);   // a portrait page leaves room beside it for the print check
  if (!layout.count) {
    els.preview.innerHTML = `<div class="canvas ws-blank" data-drop-end="1" data-w="${layout.page.width}" data-h="${layout.page.height}"><div><b>Your sheet is empty</b><span>Click a picture on the left and it lands here. The layout adjusts as you add more.</span></div></div>`;
    els.previewMeta.textContent = `${size} · this is exactly what prints`;
    fitStage(); return;
  }
  const { pg: shown, n } = currentPage(layout);
  els.pagerLabel.textContent = `${layout.duplex ? 'Sheet' : 'Page'} ${view.sheet + 1} of ${n}`;
  els.prev.disabled = view.sheet === 0; els.next.disabled = view.sheet >= n - 1;
  for (const b of els.sideSeg.querySelectorAll('button')) { b.classList.toggle('on', b.dataset.side === view.side); b.setAttribute('aria-pressed', b.dataset.side === view.side); }
  els.previewMeta.textContent = layout.duplex ? `${shown.side === 'front' ? 'Fronts' : 'Backs'} of sheet ${shown.of}${shown.side === 'back' ? `, mirrored for the ${spec.flip}-edge flip` : ''} · ${size}` : `${size} · this is exactly what prints`;
  const { page } = layout;
  const S = 40; // px per inch in the preview
  els.preview.innerHTML = [shown].map((pg) => {
    const W = page.width * S, H = page.height * S;
    const parts = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`];
    const zones = [];
    for (const slot of pg.slots) {
      const itemIdx = itemIndexForSlot(slot.index);
      const droppable = pg.side === 'back' ? Boolean(slot.frontImage) : true;
      if (droppable) zones.push(`<div class="zone ${slot.image ? 'filled' : 'empty'}" data-side="${pg.side}" data-slot="${slot.index}" data-item="${itemIdx}" ${slot.image ? 'draggable="true"' : ''} style="left:${(slot.x / page.width * 100).toFixed(3)}%;top:${(slot.y / page.height * 100).toFixed(3)}%;width:${(slot.w / page.width * 100).toFixed(3)}%;height:${(slot.h / page.height * 100).toFixed(3)}%" title="${slot.image ? (pg.side === 'front' ? 'Drag to swap with another slot, or onto a back slot to use it as a back · drop an image here to replace' : 'Drag to copy this back to another piece · drop an image here to change it') : (pg.side === 'back' ? 'Drop any image or front piece here for the back' : 'Drop an image here')}"></div>`);
      parts.push(`<g class="slot">`);
      parts.push(`<rect x="${slot.x * S}" y="${slot.y * S}" width="${slot.w * S}" height="${slot.h * S}" fill="${pg.side === 'back' && slot.frontImage && !slot.image ? '#f3f4f8' : 'transparent'}" stroke="#c9d0dd" stroke-dasharray="3 3" stroke-width="1"/>`);
      if (slot.image) {
        const img = imagesById.get(itemKey(slot.image));
        const d = slot.draw; const cut = slot.cut || slot.draw;
        if (slot.cut && (cut.w !== d.w || cut.h !== d.h)) parts.push(`<rect x="${cut.x * S}" y="${cut.y * S}" width="${cut.w * S}" height="${cut.h * S}" fill="#fff" stroke="#e3e6ee" stroke-width="0.5"/>`);
        if (img?.thumbUrl) parts.push(`<image href="${escapeHtml(img.thumbUrl)}" x="${d.x * S}" y="${d.y * S}" width="${d.w * S}" height="${d.h * S}" preserveAspectRatio="${d.crop ? 'xMidYMid slice' : 'none'}"/>`);
        else parts.push(`<rect x="${d.x * S}" y="${d.y * S}" width="${d.w * S}" height="${d.h * S}" fill="#e6e9f0"/>`);
        if (spec.outline) parts.push(`<rect x="${cut.x * S}" y="${cut.y * S}" width="${cut.w * S}" height="${cut.h * S}" fill="none" stroke="#777" stroke-width="0.75"/>`);
        if (spec.cutMarks) {
          const gap = 0.04, len = Math.min(0.25, Math.min(layout.gutter, layout.marginX, layout.marginY) - gap);
          if (len >= 0.03) {
            const x0 = cut.x, x1 = cut.x + cut.w, y0 = cut.y, y1 = cut.y + cut.h;
            for (const [cx, dx] of [[x0, -1], [x1, 1]]) for (const [cy, dy] of [[y0, -1], [y1, 1]]) {
              parts.push(`<line x1="${(cx + dx * gap) * S}" y1="${cy * S}" x2="${(cx + dx * (gap + len)) * S}" y2="${cy * S}" stroke="#555" stroke-width="0.75"/>`);
              parts.push(`<line x1="${cx * S}" y1="${(cy + dy * gap) * S}" x2="${cx * S}" y2="${(cy + dy * (gap + len)) * S}" stroke="#555" stroke-width="0.75"/>`);
            }
          }
        }
        parts.push(`<text x="${(d.x + 0.08) * S}" y="${(d.y + 0.3) * S}" font-size="11" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="2.5" paint-order="stroke">${slot.index + 1}${pg.side === 'back' ? 'B' : ''}</text>`);
      } else if (pg.side === 'back' && slot.frontImage) {
        parts.push(`<text x="${(slot.x + slot.w / 2) * S}" y="${(slot.y + slot.h / 2) * S}" font-size="10" font-family="sans-serif" fill="#8a92a6" text-anchor="middle">back of ${slot.index + 1} — drop an image</text>`);
      }
      parts.push('</g>');
    }
    if (spec.cutMarks) for (const [ax, ay, bx, by] of edgeMarks(layout, pg)) parts.push(`<line x1="${ax * S}" y1="${ay * S}" x2="${bx * S}" y2="${by * S}" stroke="#555" stroke-width="0.75"/>`);
    return `<figure class="page-preview ${pg.side}"><div class="canvas" data-side="${pg.side}" data-canvas="1" data-w="${page.width}" data-h="${page.height}"><svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">${parts.join('')}</svg>${zones.join('')}</div></figure>`;
  }).join('');
  fitStage();
}

// "On this sheet": the pieces as a strip of thumbnails in print order, grouped by the page they start on.
// Click one to see its details (copies, move, remove) under the strip.
function renderItems() {
  const prints = spec.items.reduce((n, it) => n + Math.max(1, it.copies || 1), 0);
  els.itemsMeta.textContent = spec.items.length ? `${plural(prints, 'piece')}${spec.duplex ? '' : ' · drag to reorder'}` : '';
  els.allBack.hidden = !spec.duplex || !spec.items.length;
  els.clear.hidden = !spec.items.length;
  if (selItem != null && !spec.items[selItem]) selItem = null;
  if (!spec.items.length) { els.items.innerHTML = '<div class="ws-strip-empty" data-drop-end="1">Pieces you add line up here, in print order.</div>'; renderPiece(); return; }
  const per = layout.cols * layout.rows, groups = [];
  let slot = 0;
  spec.items.forEach((it, i) => {
    const pg = Math.floor(slot / per), c = Math.max(1, it.copies || 1);
    slot += c;
    const img = imagesById.get(itemKey(it));
    const back = it.back ? imagesById.get(itemKey(it.back)) : null;
    const html = `<div class="sheet-item ${selItem === i ? 'sel' : ''}" data-i="${i}" draggable="true" title="${escapeHtml(img?.name || it.rel)}${img ? ` — ${img.width} × ${img.height} px` : ' — not found on disk'} · click for details, drag to reorder">
      <img src="${img?.thumbUrl ? escapeHtml(img.thumbUrl) : ''}" alt="" draggable="false">
      ${c > 1 ? `<span class="n">×${c}</span>` : ''}
      <button type="button" data-act="remove" title="Remove from the sheet" aria-label="Remove">✕</button>
      ${spec.duplex ? `<div class="back-zone ${it.back ? 'set' : ''} ${armedBack === i ? 'armed' : ''}" data-back="${i}" ${it.back ? 'draggable="true"' : ''} title="${it.back ? `Back: ${escapeHtml(it.back.rel)} — click to change, ✕ to clear` : 'Drop a picture or a front piece here for the back side, or click then pick one'}">
        ${back ? `<img src="${escapeHtml(back.thumbUrl || back.url)}" alt="" draggable="false">` : '<span>+ back</span>'}${it.back ? '<button type="button" data-act="clear-back" title="Remove the back picture" aria-label="Remove the back">✕</button>' : ''}
      </div>` : ''}
    </div>`;
    (groups[pg] ||= []).push(html);
  });
  els.items.innerHTML = groups.map((g, pg) => (g ? `<div class="ws-pg"><span>${spec.duplex ? 'Sheet' : 'Page'} ${pg + 1}</span><div>${g.join('')}</div></div>` : '')).join('')
    + '<div class="drop-end" data-drop-end="1">Drop here to add at the end</div>';
  renderPiece();
}
function renderPiece() {
  const it = selItem == null ? null : spec.items[selItem];
  els.piece.hidden = !it;
  if (!it) { els.piece.innerHTML = ''; return; }
  const img = imagesById.get(itemKey(it));
  els.piece.innerHTML = `
    <div class="sheet-item-meta"><b title="${escapeHtml(it.rel)}">${escapeHtml(img?.name || it.rel)}</b><span>${img ? `${img.width} × ${img.height} px · ${escapeHtml(sourceLabel(it.source))}${img.folder ? ` / ${escapeHtml(img.folder)}` : ''}` : 'not found on disk'}</span></div>
    <label class="copies" title="How many copies to print">Copies <input type="number" min="1" max="50" value="${Math.max(1, it.copies || 1)}" data-act="copies"></label>
    <button class="btn small" type="button" data-act="up" title="Move earlier" ${selItem === 0 ? 'disabled' : ''}>‹ Earlier</button>
    <button class="btn small" type="button" data-act="down" title="Move later" ${selItem === spec.items.length - 1 ? 'disabled' : ''}>Later ›</button>
    <button class="btn small danger" type="button" data-act="remove" title="Remove from the sheet">Remove</button>`;
}

function sourceLabel(id) { return sources.find((s) => s.id === id)?.label || id; }

function renderPicker() {
  const q = els.search.value.trim().toLowerCase();
  const only = els.sourceFilter.value;
  const counts = new Map();
  for (const it of spec.items) {
    counts.set(itemKey(it), (counts.get(itemKey(it)) || 0) + (it.copies || 1));
    if (it.back) counts.set(itemKey(it.back), (counts.get(itemKey(it.back)) || 0) + (it.copies || 1));
  }
  let shown = 0;
  els.picker.innerHTML = sources.filter((s) => !only || s.id === only).map((s) => {
    const imgs = s.images.filter((im) => !q || im.rel.toLowerCase().includes(q));
    if (!imgs.length) return '';
    shown += imgs.length;
    return `<div class="picker-group"><div class="section-title">${escapeHtml(s.label)} <span class="hint">${escapeHtml(s.dir)} · ${imgs.length}</span></div>
      <div class="gallery">${imgs.map((im) => {
        const n = counts.get(im.id) || 0;
        return `<div class="thumb pick ${n ? 'active' : ''}" draggable="true" data-id="${escapeHtml(im.id)}" title="${escapeHtml(im.rel)} — ${im.width} × ${im.height} px — click to add, or drag onto the sheet">
          <img src="${im.thumbUrl ? escapeHtml(im.thumbUrl) : escapeHtml(im.url)}" loading="lazy" alt="" draggable="false">
          ${n ? `<span class="badge pickcount">${n}</span>` : ''}
          <a class="open" href="${escapeHtml(im.url)}" target="_blank" title="Open full size">⤢</a>
          <div class="cap">${escapeHtml(im.name)}<small>${im.width} × ${im.height}</small></div>
        </div>`;
      }).join('')}</div></div>`;
  }).join('') || '<div class="empty small">No images match.</div>';
  els.pickerCount.textContent = `${shown} found`;
  els.pickerHint.textContent = armedBack != null ? `Click a picture to use it as the back of piece ${armedBack + 1} (Esc to cancel).`
    : spec.items.length ? 'The number shows how many copies are on the sheet. Click again to add another.'
      : 'Click a picture to add it. Click again for another copy, or drag it onto a slot.';
  for (const b of els.folderChips.querySelectorAll('button')) { b.classList.toggle('on', b.dataset.v === only); b.setAttribute('aria-pressed', b.dataset.v === only); }
  els.picker.classList.toggle('arming', armedBack != null);
}

// ---------- mutations ----------
function addImage(id, at) {
  const img = imagesById.get(id);
  if (!img) return;
  if (spec.items.length >= config.sheets.maxItems) return setStatus(`At most ${config.sheets.maxItems} images per sheet.`, 'error');
  const i = at == null ? spec.items.length : at;
  spec.items.splice(i, 0, { source: img.source, rel: img.rel, copies: 1, back: null });
  selItem = null;
  update();
  showPiece(i);
}
// Turn the preview to the page a piece is on.
function showPiece(i, side) {
  if (!layout || !spec.items[i]) return;
  const to = Math.floor(firstSlotOfItem(i) / (layout.cols * layout.rows));
  if (to === view.sheet && (!side || side === view.side)) return;
  view.sheet = to; if (side) view.side = side;
  renderPreview(layout);
}
function setBack(i, id) {
  const img = imagesById.get(id);
  if (!img || !spec.items[i]) return;
  spec.items[i].back = { source: img.source, rel: img.rel };
  armedBack = null;
  update();
}
function moveItem(from, to) {
  if (from === to || from < 0 || to < 0) return;
  const [it] = spec.items.splice(from, 1);
  spec.items.splice(to > from ? to - 1 : to, 0, it);
  update();
}
function swapItems(a, b) {
  if (a === b || a < 0 || b < 0) return;
  [spec.items[a], spec.items[b]] = [spec.items[b], spec.items[a]];
  update();
}
function replaceItemImage(i, id) {
  const img = imagesById.get(id);
  if (!img || !spec.items[i]) return;
  spec.items[i] = { ...spec.items[i], source: img.source, rel: img.rel };
  update();
}

// ---------- drag and drop ----------
// Every drag carries the image id, so any source can be dropped where an image is wanted (a back slot, a replace, an add):
//   image — a picker thumbnail;  item — a front piece (moves/swaps between front slots, copies onto back targets);
//   back — a piece's back image (copies onto other back targets, adds as a new piece on the front).
let dragging = null;   // { kind: 'image'|'item'|'back', id, index? }
function readDrag(e) {
  if (dragging) return dragging;
  try { return JSON.parse(e.dataTransfer.getData(DND) || 'null'); } catch { return null; }
}
document.addEventListener('dragstart', (e) => {
  const pick = e.target.closest?.('.thumb.pick');
  const backBox = e.target.closest?.('.back-zone[draggable="true"]');
  const item = e.target.closest?.('.sheet-item');
  const slot = e.target.closest?.('.zone[draggable="true"]');
  if (pick) dragging = { kind: 'image', id: pick.dataset.id };
  else if (backBox) dragging = { kind: 'back', index: Number(backBox.dataset.back), id: itemKey(spec.items[Number(backBox.dataset.back)].back) };
  else if (item) dragging = { kind: 'item', index: Number(item.dataset.i), slot: firstSlotOfItem(Number(item.dataset.i)), row: true, id: itemKey(spec.items[Number(item.dataset.i)]) };
  else if (slot && slot.dataset.side === 'back') dragging = { kind: 'back', index: Number(slot.dataset.item), id: itemKey(spec.items[Number(slot.dataset.item)].back) };
  else if (slot) dragging = { kind: 'item', index: Number(slot.dataset.item), slot: Number(slot.dataset.slot), id: itemKey(spec.items[Number(slot.dataset.item)]) };
  else return;
  e.dataTransfer.setData(DND, JSON.stringify(dragging));
  e.dataTransfer.effectAllowed = dragging.kind === 'item' ? 'copyMove' : 'copy';
  document.body.classList.add(`dragging-${dragging.kind}`);
});
document.addEventListener('dragend', () => { dragging = null; document.body.classList.remove('dragging-image', 'dragging-item', 'dragging-back'); clearDropHints(); });
function clearDropHints() { for (const el of document.querySelectorAll('.drop-over')) el.classList.remove('drop-over'); }
function dropTarget(e) {
  const t = e.target.closest?.('.back-zone, .sheet-item, [data-drop-end], .zone, [data-canvas], #all-back');
  return t || null;
}
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
document.addEventListener('dragover', (e) => {
  const t = dropTarget(e);
  if (!t) return;
  const d = readDrag(e) || (hasFiles(e) ? { kind: 'image', file: true } : null);
  if (!d) return;
  const backTarget = t.matches('.back-zone, #all-back') || ((t.matches('.zone') || t.matches('[data-canvas]')) && t.dataset.side === 'back');
  if (backTarget && t.matches('[data-canvas]')) return;                                  // the back page itself has no "add" meaning
  if (backTarget && t.matches('.zone') && Number(t.dataset.item) < 0) return;             // no front piece behind this slot
  if (backTarget && d.kind === 'back' && d.index === Number(t.dataset.item ?? t.dataset.back)) return;  // onto itself
  e.preventDefault();
  e.dataTransfer.dropEffect = d.kind === 'item' && !backTarget ? 'move' : 'copy';
  clearDropHints(); t.classList.add('drop-over');
});
// A file dragged in from Finder: match it to an image the picker already knows (same name and size).
function imageIdForFile(file) {
  const hits = [...imagesById.values()].filter((im) => im.name === file.name && (!file.size || im.bytes === file.size));
  if (hits.length === 1) return hits[0].id;
  const byName = [...imagesById.values()].filter((im) => im.name === file.name);
  return byName.length === 1 ? byName[0].id : null;
}
document.addEventListener('dragleave', (e) => { const t = dropTarget(e); if (t && !t.contains(e.relatedTarget)) t.classList.remove('drop-over'); });
document.addEventListener('drop', (e) => {
  const t = dropTarget(e);
  let d = readDrag(e);
  if (!d && t && hasFiles(e)) {
    e.preventDefault(); clearDropHints();
    const files = Array.from(e.dataTransfer.files);
    const ids = files.map(imageIdForFile);
    const missing = files.filter((f, i) => !ids[i]).map((f) => f.name);
    if (missing.length) setStatus(`Not in the media folder: ${missing.join(', ')}. Copy files into ${config.sheets.sources[0].dir} and press ↻ in the picker.`, 'error');
    const found = ids.filter(Boolean);
    if (!found.length) return;
    if (found.length > 1 || !t.matches('.zone, .back-zone, .sheet-item, #all-back')) { for (const id of found) addImage(id, spec.items.length); return; }
    d = { kind: 'image', id: found[0] };
  }
  if (!d || !t) return;
  e.preventDefault(); clearDropHints();
  selItem = null;
  const img = imagesById.get(d.id);
  if (!img) return;
  const isMove = d.kind === 'item';   // only front pieces move; picker images and backs are copied
  if (t.id === 'all-back') { for (const it of spec.items) it.back = { source: img.source, rel: img.rel }; update(); return; }
  if (t.matches('.back-zone')) { setBack(Number(t.dataset.back), d.id); return; }
  if (t.matches('[data-drop-end]')) { if (isMove) moveItem(d.index, spec.items.length); else addImage(d.id, spec.items.length); return; }
  if (t.matches('.sheet-item')) {
    const i = Number(t.dataset.i);
    const before = e.clientX < t.getBoundingClientRect().left + t.offsetWidth / 2;
    if (isMove) moveItem(d.index, before ? i : i + 1); else addImage(d.id, before ? i : i + 1);
    return;
  }
  // A piece dragged from a single slot acts on that slot only; a row dragged from the list acts on the whole row.
  const sourceIndex = () => (d.row ? itemIndexForSlot(d.slot) : splitSlot(d.slot));
  if (t.matches('.zone')) {
    const slotIdx = Number(t.dataset.slot);
    const filled = Number(t.dataset.item) >= 0;
    if (t.dataset.side === 'back') { if (filled) setBack(splitSlot(slotIdx), d.id); return; }
    if (isMove) {
      if (!filled) { moveItem(sourceIndex(), spec.items.length); return; }
      splitSlot(slotIdx); sourceIndex();
      swapItems(itemIndexForSlot(d.slot), itemIndexForSlot(slotIdx));
    } else if (filled) replaceItemImage(splitSlot(slotIdx), d.id);
    else addImage(d.id, spec.items.length);
    return;
  }
  if (t.matches('[data-canvas]')) {  // dropped on the front page outside any slot: add at the end
    if (isMove) moveItem(sourceIndex(), spec.items.length); else addImage(d.id, spec.items.length);
  }
});
// Stop the browser from opening a file when it is dropped outside a target.
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (hasFiles(e)) e.preventDefault(); });

// ---------- sheets ----------
async function loadImages() {
  els.refresh.disabled = true;
  try {
    const data = await api('GET', '/api/sheets/images');
    sources = data.sources;
    imagesById.clear();
    for (const s of sources) for (const im of s.images) imagesById.set(im.id, im);
    const keep = els.sourceFilter.value;
    els.sourceFilter.innerHTML = '<option value="">All folders</option>' + sources.map((s) => `<option value="${s.id}">${escapeHtml(s.label)} (${s.images.length})</option>`).join('');
    els.sourceFilter.value = sources.some((s) => s.id === keep) ? keep : '';
    els.folderChips.innerHTML = `<button type="button" data-v="">All · ${imagesById.size}</button>` + sources.map((s) => `<button type="button" data-v="${escapeHtml(s.id)}" title="${escapeHtml(s.dir)}">${escapeHtml(s.label)} · ${s.images.length}</button>`).join('');
  } finally { els.refresh.disabled = false; }
}
async function loadSheets() {
  sheets = await api('GET', '/api/sheets');
}
function openSheet(s) {
  sheetId = s.id; armedBack = null; selItem = null; view.sheet = 0; view.side = 'front';
  els.name.value = s.name;
  spec = { ...DEFAULT_SPEC, ...s.spec, items: (s.spec.items || []).map((it) => ({ ...it, back: it.back || null })) };
  writeForm(); renderRender(s.lastRender);
  update();
}
function newSheet() {
  sheetId = null; armedBack = null; selItem = null; view.sheet = 0; view.side = 'front';
  els.name.value = '';
  spec = { ...DEFAULT_SPEC, items: [] };
  writeForm(); renderRender(null);
  setStatus('');
  update();
}
function renderRender(r) {
  els.render.hidden = !r;
  if (!r) { els.render.innerHTML = ''; return; }
  const low = r.embedded.filter((e) => e.downscaled).length;
  els.render.innerHTML = `
    <div class="render-head"><b>PDF ready</b><span class="hint">${new Date(r.at).toLocaleString()}</span><span class="spacer"></span>
      <a class="btn small" href="${escapeHtml(r.url)}" target="_blank">Open PDF</a>
      <a class="btn small" href="${escapeHtml(r.url)}" download="${escapeHtml(r.file)}">⬇ Download</a>
      <button class="btn small" id="reveal" type="button">Reveal in Finder</button>
    </div>
    <div class="render-meta">${r.pages} page${r.pages === 1 ? '' : 's'}${r.duplex ? ` (${r.pages / 2} double-sided sheet${r.pages === 2 ? '' : 's'})` : ''} · ${r.images} image${r.images === 1 ? '' : 's'} · ${r.grid} on ${r.page} · ${fmtBytes(r.bytes)} · ${(r.ms / 1000).toFixed(1)} s${low ? ` · ${low} image${low === 1 ? '' : 's'} downscaled to the DPI cap` : ''}</div>
    <div class="hint">Saved as output/sheets/${escapeHtml(r.file)}. At the print shop, print at 100% / “actual size” (not “fit to page”)${r.duplex ? `, <b>double-sided, flip on the ${spec.flip} edge</b>` : ''}.</div>`;
  $('reveal').onclick = () => api('POST', `/api/sheets/${encodeURIComponent(sheetId)}/reveal`).catch((e) => setStatus(e.message, 'error'));
}
// Save the sheet without building its PDF.
async function save() {
  if (busy || !spec.items.length) return;
  try {
    const name = els.name.value.trim() || `Sheet ${new Date().toLocaleDateString()}`;
    els.name.value = name;
    const s = await api('POST', '/api/sheets', { id: sheetId, name, spec });
    sheetId = s.id;
    await loadSheets();
    update();
    setStatus('Saved.', 'ok');
  } catch (e) { setStatus(escapeHtml(e.message), 'error'); }
}
async function build() {
  if (busy || !spec.items.length) return;
  busy = true; els.build.disabled = true;
  setStatus('<span class="spinner"></span>Building the PDF… large upscaled images are downscaled first, this can take a few seconds per image.');
  try {
    const name = els.name.value.trim() || `Sheet ${new Date().toLocaleDateString()}`;
    els.name.value = name;
    const s = await api('POST', '/api/sheets/render', { id: sheetId, name, spec });
    sheetId = s.id;
    renderRender(s.lastRender);
    els.render.scrollIntoView({ block: 'nearest' });
    await loadSheets();
    renderHead();
    syncUrl();
    setStatus(`Built ${s.lastRender.pages} page${s.lastRender.pages === 1 ? '' : 's'} (${fmtBytes(s.lastRender.bytes)}).`, 'ok');
    window.dvShell?.flyby?.('Wheels up. Your PDF is ready.');
    saveDraft();
  } catch (e) { setStatus(e.message, 'error'); }
  finally { busy = false; els.build.disabled = !spec.items.length; }
}

// ---------- events ----------
for (const el of [els.page, els.orientation, els.customWidth, els.customHeight, els.grid, els.cols, els.rows, els.margin, els.gutter, els.fit, els.maxDpi, els.encode, els.cutMarks, els.pack, els.outline, els.label, els.duplex, els.flip, els.backFit]) {
  el.addEventListener('input', update);
  el.addEventListener('change', update);
}
els.name.addEventListener('input', () => { saveDraft(); renderHead(); });
els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.name.blur(); });
els.search.addEventListener('input', () => { renderPicker(); syncUrl(); });
els.sourceFilter.addEventListener('change', () => { renderPicker(); syncUrl(); });
els.refresh.addEventListener('click', async () => { await loadImages(); update(); });
els.clear.addEventListener('click', () => { spec.items = []; armedBack = null; selItem = null; update(); });
els.build.addEventListener('click', build);
// Faces for the hidden selects (orientation, grid, flip), the folder chips and the spacing presets.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-for] button[data-v]');
  if (!b) return;
  const sel = $(b.parentElement.dataset.for);
  if (sel.value === b.dataset.v) return;
  sel.value = b.dataset.v; sel.dispatchEvent(new Event('change'));
});
els.folderChips.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-v]');
  if (!b) return;
  els.sourceFilter.value = b.dataset.v; renderPicker(); syncUrl();
});
els.spacingSeg.addEventListener('click', (e) => {
  const p = SPACING[e.target.closest('button')?.dataset.preset];
  if (!p) return;
  if (p.margin == null) { els.margin.focus(); els.margin.select(); return; }
  els.margin.value = p.margin; els.gutter.value = p.gutter; update();
});
els.prev.addEventListener('click', () => { view.sheet -= 1; renderPreview(layout); });
els.next.addEventListener('click', () => { view.sheet += 1; renderPreview(layout); });
els.sideSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { view.side = b.dataset.side; renderPreview(layout); } });
els.warnings.addEventListener('click', (e) => {
  if (!e.target.closest('[data-act="show-noback"]')) return;
  const i = spec.items.findIndex((it) => !it.back);
  if (i >= 0) { selItem = i; renderItems(); showPiece(i, 'back'); }
});
// The Sheets menu: new, save, open a saved sheet, delete.
const closeMenu = () => { els.sheetsPop.hidden = true; els.sheetsBtn.setAttribute('aria-expanded', 'false'); };
els.sheetsBtn.addEventListener('click', () => { const open = els.sheetsPop.hidden; els.sheetsPop.hidden = !open; els.sheetsBtn.setAttribute('aria-expanded', String(open)); });
document.addEventListener('click', (e) => { if (!e.target.closest('.ws-menu')) closeMenu(); });
els.sheetsPop.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  closeMenu();
  try {
    if (b.dataset.open) { if (b.dataset.open !== sheetId) openSheet(await api('GET', `/api/sheets/${encodeURIComponent(b.dataset.open)}`)); }
    else if (b.dataset.act === 'new') newSheet();
    else if (b.dataset.act === 'save') await save();
    else if (b.dataset.act === 'delete') {
      if (!sheetId || !confirm('Delete this saved sheet and its PDF? Source pictures are not touched.')) return;
      await api('DELETE', `/api/sheets/${encodeURIComponent(sheetId)}`);
      await loadSheets(); newSheet();
    }
  } catch (err) { setStatus(escapeHtml(err.message), 'error'); }
});
els.picker.addEventListener('click', (e) => {
  if (e.target.closest('a.open')) return;
  const t = e.target.closest('.thumb.pick');
  if (!t) return;
  if (armedBack != null) setBack(armedBack, t.dataset.id); else addImage(t.dataset.id);
});
els.items.addEventListener('click', (e) => {
  const row = e.target.closest('.sheet-item');
  if (!row) return;
  const i = Number(row.dataset.i);
  const btn = e.target.closest('button[data-act]');
  if (btn) {
    if (btn.dataset.act === 'remove') { spec.items.splice(i, 1); armedBack = null; selItem = null; }
    else if (btn.dataset.act === 'clear-back') spec.items[i].back = null;
    update();
    return;
  }
  if (e.target.closest('.back-zone')) { armedBack = armedBack === i ? null : i; renderItems(); renderPicker(); return; }
  selItem = selItem === i ? null : i;
  renderItems();
  if (selItem != null) { showPiece(i); els.piece.scrollIntoView({ block: 'nearest' }); }
});
els.piece.addEventListener('click', (e) => {
  const act = e.target.closest('button[data-act]')?.dataset.act, i = selItem;
  if (!act || i == null) return;
  if (act === 'remove') { spec.items.splice(i, 1); armedBack = null; selItem = null; }
  else if (act === 'up' && i > 0) { [spec.items[i - 1], spec.items[i]] = [spec.items[i], spec.items[i - 1]]; selItem = i - 1; }
  else if (act === 'down' && i < spec.items.length - 1) { [spec.items[i + 1], spec.items[i]] = [spec.items[i], spec.items[i + 1]]; selItem = i + 1; }
  update();
});
els.piece.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-act="copies"]');
  if (!input || selItem == null) return;
  spec.items[selItem].copies = Math.max(1, Math.min(50, Math.floor(Number(input.value) || 1)));
  update();
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); build(); }
  if (e.key === 'Escape') closeMenu();
  if (e.key === 'Escape' && armedBack != null) { armedBack = null; renderItems(); renderPicker(); }
});

// ---------- init ----------
(async () => {
  try {
    config = await api('GET', '/api/config');
    els.page.innerHTML = config.sheets.pageSizes.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
    els.grid.innerHTML = config.sheets.grids.map((g) => `<option value="${g.id}">${escapeHtml(g.label)}</option>`).join('');
    els.gridTiles.innerHTML = config.sheets.grids.map((g) => {
      const m = /^(\d+)x(\d+)$/.exec(g.id);
      if (!m) return `<button type="button" data-v="${g.id}" title="${escapeHtml(g.label)}"><span>${g.id === 'auto' ? 'Auto' : 'Custom'}</span></button>`;
      const c = Number(m[1]), r = Number(m[2]), w = (14 - (c - 1) * 1.5) / c, h = (18 - (r - 1) * 1.5) / r;
      let cells = '';
      for (let x = 0; x < c; x++) for (let y = 0; y < r; y++) cells += `<rect x="${(x * (w + 1.5)).toFixed(2)}" y="${(y * (h + 1.5)).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}"/>`;
      return `<button type="button" data-v="${g.id}" title="${escapeHtml(g.label)}"><svg viewBox="0 0 14 18" aria-hidden="true">${cells}</svg><span>${c * r}</span></button>`;
    }).join('');
    // With the shell on, the sheet's name is the page title and the bar's actions sit in the header.
    if (window.dvShell) { window.dvShell.setHead({ title: $('ws-name'), sub: '' }); window.dvShell.actions.append(...$('ws-actions').children); $('ws-bar').hidden = true; }
    const tidy = (d) => String(d).replace(/^\/(Users|home)\/[^/]+\//, '~/');
    els.topbar.textContent = `PDFs are saved in ${tidy(config.outputDir)}/sheets`;
    els.topbar.title = `Pictures come from:\n${config.sheets.sources.map((s) => s.dir).join('\n')}\n\nPDFs are saved in ${config.outputDir}/sheets`;
    await Promise.all([loadImages(), loadSheets()]);
    await applyUrl();
    ready = true; syncUrl(); started = true;
    urlState.onChange(() => applyUrl().catch((e) => setStatus(escapeHtml(e.message), 'error')));
  } catch (e) { setStatus(e.message, 'error'); els.topbar.textContent = 'Could not load'; }
})();
