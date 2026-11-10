// Print Sheets — layout math shared by the browser preview and the server-side PDF renderer.
// All dimensions are inches. Zero dependencies; works as an ES module in Node and the browser.

// Sheet sizes FedEx Office prints on (self-serve and full-serve). Posters are full-serve only.
export const PAGE_SIZES = [
  { id: 'letter', label: 'Letter 8.5 × 11 in', width: 8.5, height: 11, note: 'standard; self-serve and full-serve' },
  { id: 'legal', label: 'Legal 8.5 × 14 in', width: 8.5, height: 14, note: 'self-serve and full-serve' },
  { id: 'tabloid', label: 'Tabloid 11 × 17 in', width: 11, height: 17, note: 'self-serve and full-serve' },
  { id: '12x18', label: '12 × 18 in', width: 12, height: 18, note: 'full-serve; also a common laminator width' },
  { id: '13x19', label: '13 × 19 in', width: 13, height: 19, note: 'full-serve (ask the store)' },
  { id: '18x24', label: 'Poster 18 × 24 in', width: 18, height: 24, note: 'full-serve poster' },
  { id: '24x36', label: 'Poster 24 × 36 in', width: 24, height: 36, note: 'full-serve poster' },
  { id: 'custom', label: 'Custom…', width: 8.5, height: 11, note: 'enter a width and height' },
];

export const GRID_PRESETS = [
  { id: 'auto', label: 'Auto (best fit)' },
  { id: '1x1', label: '1 per page' },
  { id: '1x2', label: '2 per page (1 × 2)' },
  { id: '2x1', label: '2 per page (2 × 1)' },
  { id: '2x2', label: '4 per page (2 × 2)' },
  { id: '2x3', label: '6 per page (2 × 3)' },
  { id: '3x2', label: '6 per page (3 × 2)' },
  { id: '3x3', label: '9 per page (3 × 3)' },
  { id: '3x4', label: '12 per page (3 × 4)' },
  { id: '4x3', label: '12 per page (4 × 3)' },
  { id: 'custom', label: 'Custom columns × rows' },
];

export const DEFAULT_SPEC = {
  page: 'letter', customWidth: 8.5, customHeight: 11, orientation: 'portrait',
  margin: 0.25,      // printer safe edge
  gutter: 0.5,       // space between pieces: room for the cut and a sealed laminate border
  grid: 'auto', cols: 2, rows: 2,
  fit: 'contain',    // 'contain' keeps the whole image (cell may letterbox); 'cover' fills the cell and crops
  cutMarks: true,    // crop marks in the gutter at every image corner
  outline: false,    // hairline around each image (easy scissors guide; shows on the print)
  maxDpi: 400,       // images are downscaled to at most this before embedding (file size); 300 is print quality
  encode: 'jpeg',    // 'jpeg' (quality 92, small files) or 'png' (lossless, very large files)
  duplex: false,     // double-sided: every front page gets a mirrored back page
  backFit: 'contain', // a back with a different shape than its front: 'contain' (whole image, white bars) or 'cover' (fill, crop)
  pack: false,       // size the cells to the images' own shape and centre the block, so rows and columns touch when the gap is 0
  flip: 'long',      // how the printer turns the sheet: 'long' edge (book-style, the FedEx default) or 'short' edge
  items: [],         // [{ source, rel, copies, back: { source, rel } | null }]
};

export const round3 = (n) => Math.round(n * 1000) / 1000;

export function pageDims(spec) {
  const preset = PAGE_SIZES.find((p) => p.id === spec.page) || PAGE_SIZES[0];
  let w = preset.id === 'custom' ? Number(spec.customWidth) || 8.5 : preset.width;
  let h = preset.id === 'custom' ? Number(spec.customHeight) || 11 : preset.height;
  if (spec.orientation === 'landscape' ? w < h : w > h) [w, h] = [h, w];
  return { width: w, height: h };
}

export function parseGrid(id) {
  const m = /^(\d+)x(\d+)$/.exec(id || '');
  return m ? { cols: Number(m[1]), rows: Number(m[2]) } : null;
}

// Expand items by copies, in order, so every slot has one entry.
export function expandItems(items) {
  const out = [];
  for (const it of items || []) {
    const n = Math.max(1, Math.min(50, Math.floor(Number(it.copies) || 1)));
    for (let i = 0; i < n; i++) out.push(it);
  }
  return out;
}

// Pick the grid that fits every selected image on the fewest pages, with the largest printed size per image.
export function autoGrid(page, spec, items) {
  const count = Math.max(1, expandItems(items).length);
  const aspects = (items || []).map((it) => (it.width && it.height ? it.width / it.height : 2 / 3));
  const aspect = aspects.length ? aspects.slice().sort((a, b) => a - b)[Math.floor(aspects.length / 2)] : 2 / 3;
  const minPages = Math.ceil(count / 12);
  let best = null;
  for (let cols = 1; cols <= 12; cols++) {
    for (let rows = 1; rows <= 12; rows++) {
      const slots = cols * rows;
      if (slots > 12 || Math.ceil(count / slots) !== minPages) continue;
      const cell = cellSize(page, spec, cols, rows);
      if (cell.width <= 0 || cell.height <= 0) continue;
      const img = fitInto(cell.width, cell.height, aspect);
      const score = img.width * img.height;
      if (!best || score > best.score + 1e-9) best = { cols, rows, score };
    }
  }
  return best ? { cols: best.cols, rows: best.rows } : { cols: 2, rows: 2 };
}

export function cellSize(page, spec, cols, rows) {
  const margin = Number(spec.margin) || 0;
  const gutter = Number(spec.gutter) || 0;
  return {
    width: (page.width - 2 * margin - (cols - 1) * gutter) / cols,
    height: (page.height - 2 * margin - (rows - 1) * gutter) / rows,
  };
}

export function fitInto(w, h, aspect) {
  return aspect >= w / h ? { width: w, height: w / aspect } : { width: h * aspect, height: h };
}

// Resolve a spec into concrete pages with placed images.
// Returns { page:{width,height}, cols, rows, cell:{width,height}, pages:[{ number, side, of, slots:[{ index, x,y,w,h, image, draw:{x,y,w,h,crop}, dpi }] }], warnings:[] }
// With duplex on, every front page is followed by its back page: slots are mirrored for the printer's flip and each
// back image is drawn into the exact mirrored rectangle of its front image, so the cut lines match on both sides.
export function computeLayout(spec, imagesById) {
  const page = pageDims(spec);
  const margin = Math.max(0, Number(spec.margin) || 0);
  const gutter = Math.max(0, Number(spec.gutter) || 0);
  const info = (ref) => (ref && imagesById?.get?.(itemKey(ref))) || {};
  const items = (spec.items || []).map((it) => ({ ...it, ...info(it), back: it.back ? { ...it.back, ...info(it.back) } : null }));
  let grid = spec.grid === 'auto' ? autoGrid(page, { ...spec, margin, gutter }, items)
    : spec.grid === 'custom' ? { cols: clampInt(spec.cols, 1, 12), rows: clampInt(spec.rows, 1, 12) }
      : parseGrid(spec.grid) || { cols: 2, rows: 2 };
  let cell = cellSize(page, { margin, gutter }, grid.cols, grid.rows);
  let originX = margin, originY = margin;
  if (spec.pack && cell.width > 0 && cell.height > 0) {
    // Cells take the pieces' own shape (median aspect), so with a 0 gap every edge is shared; the block is centred on the page.
    const aspects = items.map((it) => (it.width && it.height ? it.width / it.height : 2 / 3));
    const aspect = aspects.length ? aspects.slice().sort((a, b) => a - b)[Math.floor(aspects.length / 2)] : 2 / 3;
    const f = fitInto(cell.width, cell.height, aspect);
    cell = { width: f.width, height: f.height };
    originX = (page.width - (grid.cols * cell.width + (grid.cols - 1) * gutter)) / 2;
    originY = (page.height - (grid.rows * cell.height + (grid.rows - 1) * gutter)) / 2;
  }
  const warnings = [];
  if (cell.width <= 0.5 || cell.height <= 0.5) warnings.push('Cells are too small — reduce the grid, gutter or margin.');

  const slotsPerPage = grid.cols * grid.rows;
  const expanded = expandItems(items);
  const pages = [];
  const pageCount = Math.max(1, Math.ceil(expanded.length / slotsPerPage));
  // Long-edge flip mirrors left/right on a portrait sheet and top/bottom on a landscape sheet; short-edge is the opposite.
  const portrait = page.height >= page.width;
  const mirrorCols = spec.duplex ? (portrait ? spec.flip !== 'short' : spec.flip === 'short') : false;
  for (let p = 0; p < pageCount; p++) {
    const slots = [];
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const idx = p * slotsPerPage + r * grid.cols + c;
        const image = expanded[idx] || null;
        const x = originX + c * (cell.width + gutter);
        const y = originY + r * (cell.height + gutter);
        const slot = { index: idx, row: r, col: c, x, y, w: cell.width, h: cell.height, image, draw: null, dpi: null };
        if (image) {
          const aspect = image.width && image.height ? image.width / image.height : 2 / 3;
          if (spec.fit === 'cover') {
            slot.draw = coverInto(x, y, cell.width, cell.height, aspect);
            slot.dpi = image.width ? Math.round((image.width * slot.draw.crop.fx) / cell.width) : null;
          } else {
            const f = fitInto(cell.width, cell.height, aspect);
            slot.draw = { x: x + (cell.width - f.width) / 2, y: y + (cell.height - f.height) / 2, w: f.width, h: f.height, crop: null };
            slot.dpi = image.width ? Math.round(image.width / f.width) : null;
          }
          if (slot.dpi && slot.dpi < 150) warnings.push(`${image.name || 'An image'} prints at only ${slot.dpi} DPI on this layout.`);
        }
        slots.push(slot);
      }
    }
    pages.push({ number: pages.length + 1, side: 'front', of: p + 1, slots });
    if (!spec.duplex) continue;
    const backSlots = slots.map((front) => {
      const col = mirrorCols ? grid.cols - 1 - front.col : front.col;
      const row = mirrorCols ? front.row : grid.rows - 1 - front.row;
      const slot = { index: front.index, row, col, x: originX + col * (cell.width + gutter), y: originY + row * (cell.height + gutter), w: cell.width, h: cell.height, image: null, draw: null, dpi: null, frontImage: front.image };
      const back = front.image?.back || null;
      if (front.image && back) {
        const d = front.draw;
        const rect = mirrorCols ? { x: page.width - (d.x + d.w), y: d.y, w: d.w, h: d.h } : { x: d.x, y: page.height - (d.y + d.h), w: d.w, h: d.h };
        const aspect = back.width && back.height ? back.width / back.height : d.w / d.h;
        slot.image = back;
        slot.cut = rect;   // the piece is cut along the front's rectangle, mirrored
        if (spec.backFit === 'cover') {
          slot.draw = coverInto(rect.x, rect.y, rect.w, rect.h, aspect);   // fill the front's rectangle exactly; crop if the aspect differs
          slot.dpi = back.width ? Math.round((back.width * slot.draw.crop.fx) / rect.w) : null;
          if (Math.abs(aspect / (d.w / d.h) - 1) > 0.02) warnings.push(`${back.name || 'A back image'} has a different shape than its front (${front.image.name || 'image'}) and will be cropped to match.`);
        } else {
          const f = fitInto(rect.w, rect.h, aspect);                        // whole back image, centred inside the front's rectangle (white bars if the shape differs)
          slot.draw = { x: rect.x + (rect.w - f.width) / 2, y: rect.y + (rect.h - f.height) / 2, w: f.width, h: f.height, crop: null };
          slot.dpi = back.width ? Math.round(back.width / f.width) : null;
        }
        if (slot.dpi && slot.dpi < 150) warnings.push(`${back.name || 'A back image'} prints at only ${slot.dpi} DPI on this layout.`);
      }
      return slot;
    });
    backSlots.sort((a, b) => a.row - b.row || a.col - b.col);
    pages.push({ number: pages.length + 1, side: 'back', of: p + 1, slots: backSlots });
  }
  return { page, cols: grid.cols, rows: grid.rows, cell, margin, marginX: originX, marginY: originY, gutter, pages, count: expanded.length, duplex: Boolean(spec.duplex), mirrorCols, warnings: [...new Set(warnings)] };
}

function coverInto(x, y, w, h, aspect) {
  const rectAspect = w / h;
  const crop = aspect > rectAspect ? { fx: rectAspect / aspect, fy: 1 } : { fx: 1, fy: aspect / rectAspect };
  return { x, y, w, h, crop };
}

// Cut lines for a page: every distinct vertical and horizontal edge of the pieces, with the marks that go in the
// outer margin at both ends of each line (printers cannot print the outermost ~0.2 in, so marks stay inside that).
export function edgeMarks(layout, page) {
  const rects = page.slots.filter((s) => s.image).map((s) => s.cut || s.draw);
  const xs = [...new Set(rects.flatMap((r) => [round3(r.x), round3(r.x + r.w)]))];
  const ys = [...new Set(rects.flatMap((r) => [round3(r.y), round3(r.y + r.h)]))];
  const band = (m) => ({ inner: m - 0.04, outer: Math.max(0.2, m - 0.25) });   // mark runs from just inside the printable area to just outside the pieces
  const mx = band(layout.marginX ?? layout.margin), my = band(layout.marginY ?? layout.margin);
  const W = layout.page.width, H = layout.page.height;
  const lines = [];
  if (my.inner - my.outer >= 0.05) for (const x of xs) { lines.push([x, my.outer, x, my.inner]); lines.push([x, H - my.inner, x, H - my.outer]); }
  if (mx.inner - mx.outer >= 0.05) for (const y of ys) { lines.push([mx.outer, y, mx.inner, y]); lines.push([W - mx.inner, y, W - mx.outer, y]); }
  return lines;
}

export const itemKey = (it) => `${it.source}:${it.rel}`;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(Number(v) || lo)));
