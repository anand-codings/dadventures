// Print Sheets — pick images, arrange them N-up on a FedEx-printable page (drag to rearrange, optional back sides), preview, build a PDF.
import { computeLayout, itemKey, edgeMarks, DEFAULT_SPEC, round3 } from '/sheets-layout.js';

const $ = (id) => document.getElementById(id);
const els = {
  sheetSelect: $('sheet-select'), newSheet: $('new-sheet'), deleteSheet: $('delete-sheet'), name: $('name'),
  page: $('page'), orientation: $('orientation'), customSize: $('custom-size'), customWidth: $('custom-width'), customHeight: $('custom-height'), pageNote: $('page-note'),
  grid: $('grid'), customGrid: $('custom-grid'), cols: $('cols'), rows: $('rows'), margin: $('margin'), gutter: $('gutter'), fit: $('fit'), maxDpi: $('max-dpi'),
  cutMarks: $('cut-marks'), pack: $('pack'), outline: $('outline'), label: $('label'), encode: $('encode'), duplex: $('duplex'), flip: $('flip'), backFit: $('back-fit'), duplexOptions: $('duplex-options'),
  summary: $('summary'), warnings: $('warnings'), build: $('build'), status: $('status'), render: $('render'),
  previewMeta: $('preview-meta'), clear: $('clear'), preview: $('preview'), itemsMeta: $('items-meta'), items: $('items'), itemsHead: $('items-head'), allBack: $('all-back'),
  search: $('search'), sourceFilter: $('source-filter'), refresh: $('refresh'), pickerHint: $('picker-hint'), picker: $('picker'), topbar: $('topbar-meta'),
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
    els.deleteSheet.disabled = !sheetId; els.sheetSelect.value = sheetId || '';
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
  renderPreview(layout);
  renderItems();
  renderSummary(layout);
  renderPicker();
  saveDraft();
  syncUrl();
}

function renderSummary(layout) {
  const first = layout.pages[0]?.slots.find((s) => s.image);
  const imgSize = first ? `${round3(first.draw.w)} × ${round3(first.draw.h)} in` : '—';
  const dpis = layout.pages.flatMap((p) => p.slots.map((s) => s.dpi).filter(Boolean));
  const dpi = dpis.length ? `${Math.min(...dpis)}${Math.max(...dpis) !== Math.min(...dpis) ? `–${Math.max(...dpis)}` : ''} DPI` : '—';
  const sheetsN = layout.count ? Math.ceil(layout.pages.length / (layout.duplex ? 2 : 1)) : 0;
  els.summary.innerHTML = `
    <div><span>Page</span><b>${round3(layout.page.width)} × ${round3(layout.page.height)} in</b></div>
    <div><span>Grid</span><b>${layout.cols} × ${layout.rows} = ${layout.cols * layout.rows} per page</b></div>
    <div><span>Cell</span><b>${round3(layout.cell.width)} × ${round3(layout.cell.height)} in</b></div>
    <div><span>Printed image</span><b>${imgSize}</b></div>
    <div><span>Source detail</span><b>${dpi}</b></div>
    <div><span>${layout.duplex ? 'Sheets (2 pages each)' : 'Pages'}</span><b>${sheetsN} (${layout.count} image${layout.count === 1 ? '' : 's'})</b></div>`;
  els.warnings.hidden = !layout.warnings.length;
  els.warnings.innerHTML = layout.warnings.map((w) => `<div>⚠ ${escapeHtml(w)}</div>`).join('');
  els.previewMeta.textContent = layout.count ? `${layout.pages.length} page${layout.pages.length === 1 ? '' : 's'} · ${layout.cols} × ${layout.rows}${layout.duplex ? ' · double-sided' : ''}` : 'Pick images below to start';
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

function renderPreview(layout) {
  if (!layout.count) { els.preview.innerHTML = '<div class="empty small" data-drop-end="1">Click or drag images from the picker onto the sheet (or drop files from the media folder in Finder). Drag pieces between slots to rearrange them. The preview shows exactly how the PDF pages will print.</div>'; return; }
  const { page } = layout;
  const S = 40; // px per inch in the preview
  els.preview.innerHTML = layout.pages.map((pg) => {
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
    const cap = layout.duplex
      ? `Sheet ${pg.of} · ${pg.side === 'front' ? 'front' : `back (mirrored for ${spec.flip}-edge flip)`}`
      : `Page ${pg.number} of ${layout.pages.length}`;
    return `<figure class="page-preview ${pg.side}"><div class="canvas" data-side="${pg.side}" data-canvas="1"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${parts.join('')}</svg>${zones.join('')}</div><figcaption>${cap} · ${round3(page.width)} × ${round3(page.height)} in</figcaption></figure>`;
  }).join('');
}

function renderItems() {
  const prints = spec.items.reduce((n, it) => n + (it.copies || 1), 0);
  els.itemsMeta.textContent = spec.items.length ? `${spec.items.length} image${spec.items.length === 1 ? '' : 's'} · ${prints} print${prints === 1 ? '' : 's'} · drag to reorder` : '';
  els.allBack.hidden = !spec.duplex || !spec.items.length;
  if (!spec.items.length) { els.items.innerHTML = '<div class="empty small drop-end" data-drop-end="1">Nothing on the sheet yet. Drop images here.</div>'; return; }
  els.items.innerHTML = spec.items.map((it, i) => {
    const img = imagesById.get(itemKey(it));
    const back = it.back ? imagesById.get(itemKey(it.back)) : null;
    return `<div class="sheet-item" data-i="${i}" draggable="true">
      <span class="grip" title="Drag to reorder">⋮⋮</span>
      <img src="${img?.thumbUrl ? escapeHtml(img.thumbUrl) : ''}" alt="">
      <div class="sheet-item-meta"><b title="${escapeHtml(it.rel)}">${escapeHtml(img?.name || it.rel)}</b><span>${img ? `${img.width} × ${img.height} px · ${sourceLabel(it.source)}${img.folder ? ` / ${escapeHtml(img.folder)}` : ''}` : 'not found on disk'}</span></div>
      ${spec.duplex ? `<div class="back-zone ${it.back ? 'set' : ''} ${armedBack === i ? 'armed' : ''}" data-back="${i}" ${it.back ? 'draggable="true"' : ''} title="${it.back ? `Back: ${escapeHtml(it.back.rel)} — click to change, ✕ to clear` : 'Drop an image or a front piece here for the back side, or click then pick one'}">
        ${back ? `<img src="${escapeHtml(back.thumbUrl || back.url)}" alt="">` : '<span>back</span>'}${it.back ? '<button data-act="clear-back" title="Remove the back image">✕</button>' : ''}
      </div>` : ''}
      <label class="copies" title="How many copies to print">×<input type="number" min="1" max="50" value="${it.copies || 1}" data-act="copies"></label>
      <button class="btn small" data-act="up" title="Move earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn small" data-act="down" title="Move later" ${i === spec.items.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="btn small danger" data-act="remove" title="Remove from the sheet">✕</button>
    </div>`;
  }).join('') + '<div class="drop-end" data-drop-end="1">Drop here to add at the end</div>';
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
  els.pickerHint.textContent = armedBack != null
    ? `Click an image to use it as the back of #${armedBack + 1} (Esc to cancel)`
    : `${shown} image${shown === 1 ? '' : 's'} · click to add (again for another piece) · drag onto a slot, a back zone, or the list`;
  els.picker.classList.toggle('arming', armedBack != null);
}

// ---------- mutations ----------
function addImage(id, at) {
  const img = imagesById.get(id);
  if (!img) return;
  if (spec.items.length >= config.sheets.maxItems) return setStatus(`At most ${config.sheets.maxItems} images per sheet.`, 'error');
  spec.items.splice(at == null ? spec.items.length : at, 0, { source: img.source, rel: img.rel, copies: 1, back: null });
  update();
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
  const img = imagesById.get(d.id);
  if (!img) return;
  const isMove = d.kind === 'item';   // only front pieces move; picker images and backs are copied
  if (t.id === 'all-back') { for (const it of spec.items) it.back = { source: img.source, rel: img.rel }; update(); return; }
  if (t.matches('.back-zone')) { setBack(Number(t.dataset.back), d.id); return; }
  if (t.matches('[data-drop-end]')) { if (isMove) moveItem(d.index, spec.items.length); else addImage(d.id, spec.items.length); return; }
  if (t.matches('.sheet-item')) {
    const i = Number(t.dataset.i);
    const before = e.clientY < t.getBoundingClientRect().top + t.offsetHeight / 2;
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
    els.sourceFilter.innerHTML = '<option value="">All folders</option>' + sources.map((s) => `<option value="${s.id}">${escapeHtml(s.label)} (${s.images.length})</option>`).join('');
  } finally { els.refresh.disabled = false; }
}
async function loadSheets() {
  sheets = await api('GET', '/api/sheets');
  els.sheetSelect.innerHTML = '<option value="">Open a saved sheet…</option>' + sheets.map((s) => `<option value="${s.id}">${escapeHtml(s.name)} · ${s.spec.items.length} img${s.spec.duplex ? ' · 2-sided' : ''}${s.lastRender ? ' · PDF' : ''}</option>`).join('');
  els.sheetSelect.value = sheetId || '';
  els.deleteSheet.disabled = !sheetId;
}
function openSheet(s) {
  sheetId = s.id; armedBack = null;
  els.name.value = s.name;
  spec = { ...DEFAULT_SPEC, ...s.spec, items: (s.spec.items || []).map((it) => ({ ...it, back: it.back || null })) };
  writeForm(); renderRender(s.lastRender);
  els.deleteSheet.disabled = false; els.sheetSelect.value = s.id;
  update();
}
function newSheet() {
  sheetId = null; armedBack = null;
  els.name.value = '';
  spec = { ...DEFAULT_SPEC, items: [] };
  writeForm(); renderRender(null);
  els.sheetSelect.value = ''; els.deleteSheet.disabled = true;
  setStatus('');
  update();
}
function renderRender(r) {
  els.render.hidden = !r;
  if (!r) { els.render.innerHTML = ''; return; }
  const low = r.embedded.filter((e) => e.downscaled).length;
  els.render.innerHTML = `
    <div class="render-head"><b>PDF ready</b><span class="hint">${new Date(r.at).toLocaleString()}</span></div>
    <div class="actions">
      <a class="btn small" href="${escapeHtml(r.url)}" target="_blank">Open PDF</a>
      <a class="btn small" href="${escapeHtml(r.url)}" download="${escapeHtml(r.file)}">⬇ Download</a>
      <button class="btn small" id="reveal" type="button">Reveal in Finder</button>
    </div>
    <div class="render-meta">${r.pages} page${r.pages === 1 ? '' : 's'}${r.duplex ? ` (${r.pages / 2} double-sided sheet${r.pages === 2 ? '' : 's'})` : ''} · ${r.images} image${r.images === 1 ? '' : 's'} · ${r.grid} on ${r.page} · ${fmtBytes(r.bytes)} · ${(r.ms / 1000).toFixed(1)} s${low ? ` · ${low} image${low === 1 ? '' : 's'} downscaled to the DPI cap` : ''}</div>
    <div class="hint">Saved as output/sheets/${escapeHtml(r.file)}. At FedEx Office print at 100% / “actual size” (not “fit to page”)${r.duplex ? `, <b>double-sided, flip on the ${spec.flip} edge</b>` : ''}.</div>`;
  $('reveal').onclick = () => api('POST', `/api/sheets/${encodeURIComponent(sheetId)}/reveal`).catch((e) => setStatus(e.message, 'error'));
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
    await loadSheets();
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
els.name.addEventListener('input', saveDraft);
els.search.addEventListener('input', () => { renderPicker(); syncUrl(); });
els.sourceFilter.addEventListener('change', () => { renderPicker(); syncUrl(); });
els.refresh.addEventListener('click', async () => { await loadImages(); update(); });
els.clear.addEventListener('click', () => { spec.items = []; armedBack = null; update(); });
els.build.addEventListener('click', build);
els.newSheet.addEventListener('click', newSheet);
els.sheetSelect.addEventListener('change', async () => {
  const id = els.sheetSelect.value;
  if (!id) return newSheet();
  try { openSheet(await api('GET', `/api/sheets/${encodeURIComponent(id)}`)); } catch (e) { setStatus(e.message, 'error'); }
});
els.deleteSheet.addEventListener('click', async () => {
  if (!sheetId || !confirm('Delete this saved sheet and its PDF? Source images are not touched.')) return;
  try { await api('DELETE', `/api/sheets/${encodeURIComponent(sheetId)}`); newSheet(); await loadSheets(); } catch (e) { setStatus(e.message, 'error'); }
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
    const act = btn.dataset.act;
    if (act === 'remove') { spec.items.splice(i, 1); armedBack = null; }
    else if (act === 'up' && i > 0) [spec.items[i - 1], spec.items[i]] = [spec.items[i], spec.items[i - 1]];
    else if (act === 'down' && i < spec.items.length - 1) [spec.items[i + 1], spec.items[i]] = [spec.items[i], spec.items[i + 1]];
    else if (act === 'clear-back') spec.items[i].back = null;
    update();
    return;
  }
  if (e.target.closest('.back-zone')) { armedBack = armedBack === i ? null : i; renderItems(); renderPicker(); }
});
els.items.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-act="copies"]');
  if (!input) return;
  const i = Number(input.closest('.sheet-item').dataset.i);
  spec.items[i].copies = Math.max(1, Math.min(50, Math.floor(Number(input.value) || 1)));
  update();
});
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); build(); }
  if (e.key === 'Escape' && armedBack != null) { armedBack = null; renderItems(); renderPicker(); }
});

// ---------- init ----------
(async () => {
  try {
    config = await api('GET', '/api/config');
    els.page.innerHTML = config.sheets.pageSizes.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
    els.grid.innerHTML = config.sheets.grids.map((g) => `<option value="${g.id}">${escapeHtml(g.label)}</option>`).join('');
    const tidy = (d) => String(d).replace(/^\/(Users|home)\/[^/]+\//, '~/');
    els.topbar.textContent = `PDFs are saved in ${tidy(config.outputDir)}/sheets`;
    els.topbar.title = `Pictures come from:\n${config.sheets.sources.map((s) => s.dir).join('\n')}\n\nPDFs are saved in ${config.outputDir}/sheets`;
    await Promise.all([loadImages(), loadSheets()]);
    await applyUrl();
    ready = true; syncUrl(); started = true;
    urlState.onChange(() => applyUrl().catch((e) => setStatus(escapeHtml(e.message), 'error')));
  } catch (e) { setStatus(e.message, 'error'); els.topbar.textContent = 'Could not load'; }
})();
