// Print Sheets — tile images from the media folder (and studio history) onto FedEx-printable pages and build a PDF.
// Self-contained module: storage under output/sheets/, routes under /api/sheets. Zero dependencies: the PDF is
// written by hand, PNGs are embedded losslessly (FlateDecode with PNG predictors) and JPEGs pass through (DCTDecode).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { computeLayout, expandItems, itemKey, edgeMarks, PAGE_SIZES, GRID_PRESETS, DEFAULT_SPEC, round3 } from '../public/sheets-layout.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SKIP_DIRS = new Set(['node_modules', 'trash', '.thumbs', 'sheets', 'characters', 'books']);
const MAX_ITEMS = 200;
const PT = 72;

export function createSheets(deps) {
  const { ROOT, OUTPUT_DIR, THUMBS_DIR, HttpError, send, readJson, slugify, clampStr, appendLog, readJsonFile, writeJsonAtomic } = deps;
  const SHEETS_DIR = path.join(OUTPUT_DIR, 'sheets');
  const CACHE_DIR = path.join(SHEETS_DIR, '.cache');
  const PRINT_ROOT = path.resolve(ROOT, process.env.PRINT_ROOT || 'media');
  const isDarwin = process.platform === 'darwin';
  const exists = (p) => fsp.access(p).then(() => true, () => false);

  // ---------- sources ----------
  // Two browsable roots: the media folder (media/ in the app folder by default; PRINT_ROOT to override) and the studio output.
  function sources() {
    const list = [];
    if (PRINT_ROOT !== path.parse(PRINT_ROOT).root) list.push({ id: 'print', label: path.basename(PRINT_ROOT), dir: PRINT_ROOT, depth: 5 });
    list.push({ id: 'output', label: 'Studio history', dir: OUTPUT_DIR, depth: 1 });
    return list;
  }
  function sourceById(id) {
    const s = sources().find((x) => x.id === id);
    if (!s) throw new HttpError(400, `Unknown image source "${id}".`);
    return s;
  }
  function resolveInSource(src, rel) {
    const file = path.normalize(path.join(src.dir, rel));
    if (!file.startsWith(src.dir + path.sep)) throw new HttpError(403, 'Forbidden.');
    return file;
  }

  async function scan(src) {
    const out = [];
    async function walk(dir, depth, relDir) {
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth <= 1 || SKIP_DIRS.has(e.name) || abs === ROOT || abs === OUTPUT_DIR) continue;
          await walk(abs, depth - 1, relDir ? `${relDir}/${e.name}` : e.name);
        } else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
          out.push({ abs, rel: relDir ? `${relDir}/${e.name}` : e.name, folder: relDir });
        }
      }
    }
    await walk(src.dir, src.depth, '');
    return out;
  }

  const dimsCache = new Map();
  async function imageInfo(src, f) {
    const st = await fsp.stat(f.abs);
    const key = `${f.abs}|${st.mtimeMs}|${st.size}`;
    let dims = dimsCache.get(key);
    if (!dims) { dims = await readDims(f.abs).catch(() => null); if (dims) dimsCache.set(key, dims); }
    const thumbUrl = await ensureThumb(f.abs, st);
    return {
      id: `${src.id}:${f.rel}`, source: src.id, rel: f.rel, name: path.basename(f.rel), folder: f.folder,
      width: dims?.width || null, height: dims?.height || null, format: dims?.format || path.extname(f.abs).slice(1).toLowerCase(),
      bytes: st.size, mtime: st.mtime.toISOString(), thumbUrl, url: `/sheet-src/${src.id}/${f.rel.split('/').map(encodeURIComponent).join('/')}`,
    };
  }

  async function listImages() {
    const groups = [];
    for (const src of sources()) {
      const files = await scan(src);
      const images = [];
      const queue = files.slice();
      await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) images.push(await imageInfo(src, queue.shift())); }));
      images.sort((a, b) => a.rel.localeCompare(b.rel));
      groups.push({ id: src.id, label: src.label, dir: src.dir, images });
    }
    return groups;
  }

  async function ensureThumb(abs, st) {
    if (!isDarwin) return null;
    const name = `ext-${crypto.createHash('sha1').update(abs).digest('hex').slice(0, 16)}-${Math.floor(st.mtimeMs)}.jpg`;
    const dest = path.join(THUMBS_DIR, name);
    if (!(await exists(dest))) {
      await fsp.mkdir(THUMBS_DIR, { recursive: true });
      const ok = await sips(['-Z', '512', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', abs, '--out', dest]);
      if (!ok) return null;
    }
    return `/thumbs/${encodeURIComponent(name)}`;
  }

  function sips(args, timeout = 120000) {
    return new Promise((resolve) => execFile('/usr/bin/sips', args, { timeout }, (err) => resolve(!err)));
  }

  // ---------- saved sheets ----------
  const sheetFile = (id) => path.join(SHEETS_DIR, `${id}.json`);
  const validId = (id) => /^[a-z0-9-]{3,80}$/.test(id || '');

  async function listSheets() {
    await fsp.mkdir(SHEETS_DIR, { recursive: true });
    const names = (await fsp.readdir(SHEETS_DIR)).filter((n) => n.endsWith('.json'));
    const sheets = (await Promise.all(names.map((n) => readJsonFile(path.join(SHEETS_DIR, n), null)))).filter(Boolean);
    sheets.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return sheets.map(pub);
  }
  async function getSheet(id) {
    if (!validId(id)) throw new HttpError(400, 'Invalid sheet id.');
    const s = await readJsonFile(sheetFile(id), null);
    if (!s) throw new HttpError(404, 'Sheet not found.');
    return s;
  }
  function pub(s) {
    const render = s.lastRender ? { ...s.lastRender, url: `/output/sheets/${encodeURIComponent(s.lastRender.file)}` } : null;
    return { ...s, lastRender: render };
  }

  function sanitizeSpec(input) {
    const s = { ...DEFAULT_SPEC, ...(input || {}) };
    const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    const out = {
      page: PAGE_SIZES.some((p) => p.id === s.page) ? s.page : 'letter',
      customWidth: num(s.customWidth, 2, 60, 8.5), customHeight: num(s.customHeight, 2, 60, 11),
      orientation: s.orientation === 'landscape' ? 'landscape' : 'portrait',
      margin: num(s.margin, 0, 3, 0.25), gutter: num(s.gutter, 0, 4, 0.5),
      grid: GRID_PRESETS.some((g) => g.id === s.grid) ? s.grid : 'auto',
      cols: Math.floor(num(s.cols, 1, 12, 2)), rows: Math.floor(num(s.rows, 1, 12, 2)),
      fit: s.fit === 'cover' ? 'cover' : 'contain',
      cutMarks: s.cutMarks !== false, outline: Boolean(s.outline), label: Boolean(s.label),
      maxDpi: Math.floor(num(s.maxDpi, 72, 1200, DEFAULT_SPEC.maxDpi)),
      encode: s.encode === 'jpeg' ? 'jpeg' : 'png',
      duplex: Boolean(s.duplex), flip: s.flip === 'short' ? 'short' : 'long', backFit: s.backFit === 'cover' ? 'cover' : 'contain', pack: Boolean(s.pack),
      items: [],
    };
    const ref = (r) => (r && typeof r.rel === 'string' && r.rel && !r.rel.includes('..') && sourceById(r.source) ? { source: r.source, rel: r.rel } : null);
    for (const it of Array.isArray(s.items) ? s.items.slice(0, MAX_ITEMS) : []) {
      const front = ref(it);
      if (!front) continue;
      out.items.push({ ...front, copies: Math.floor(num(it.copies, 1, 50, 1)), back: ref(it.back) });
    }
    return out;
  }

  async function upsertSheet(body) {
    await fsp.mkdir(SHEETS_DIR, { recursive: true });
    const now = new Date().toISOString();
    const spec = sanitizeSpec(body.spec);
    const name = clampStr(body.name, 120) || 'Untitled sheet';
    let sheet = body.id ? await readJsonFile(sheetFile(validId(body.id) ? body.id : '-'), null) : null;
    if (!sheet) sheet = { id: `${crypto.randomBytes(4).toString('hex')}-${slugify(name)}`, createdAt: now, lastRender: null };
    sheet = { ...sheet, name, spec, updatedAt: now };
    await writeJsonAtomic(sheetFile(sheet.id), sheet);
    return sheet;
  }

  async function deleteSheet(id) {
    const s = await getSheet(id);
    await fsp.unlink(sheetFile(id)).catch(() => {});
    for (const n of await fsp.readdir(SHEETS_DIR)) if (n.startsWith(`${id}-`) && n.endsWith('.pdf')) await fsp.unlink(path.join(SHEETS_DIR, n)).catch(() => {});
    await appendLog({ type: 'sheet_delete', sheetId: id, name: s.name });
    return { deleted: id };
  }

  // Resolve the spec's items to real files with dimensions, for layout and rendering.
  async function resolveItems(spec) {
    const map = new Map();
    for (const it of spec.items.flatMap((x) => (x.back ? [x, x.back] : [x]))) {
      const key = itemKey(it);
      if (map.has(key)) continue;
      const src = sourceById(it.source);
      const abs = resolveInSource(src, it.rel);
      let st;
      try { st = await fsp.stat(abs); } catch { throw new HttpError(404, `Image not found: ${it.rel}`); }
      const dims = await readDims(abs).catch(() => null);
      if (!dims) throw new HttpError(400, `Could not read image size: ${it.rel}`);
      map.set(key, { abs, name: path.basename(it.rel), width: dims.width, height: dims.height, format: dims.format, bytes: st.size, mtimeMs: st.mtimeMs });
    }
    return map;
  }

  // ---------- rendering ----------
  async function renderSheet(body) {
    // Validate everything before saving, so a failed build never leaves a stray sheet behind.
    const checked = sanitizeSpec(body.spec);
    if (!checked.items.length) throw new HttpError(400, 'Add at least one image to the sheet.');
    const images = await resolveItems(checked);
    const sheet = await upsertSheet(body);
    const spec = sheet.spec;
    const layout = computeLayout(spec, images);
    await fsp.mkdir(CACHE_DIR, { recursive: true });

    const started = Date.now();
    const pdf = new PdfWriter();
    const xobjects = new Map();   // cache key → { ref, width, height }
    const embedded = [];
    for (const page of layout.pages) {
      for (const slot of page.slots) {
        if (!slot.image) continue;
        const info = images.get(itemKey(slot.image));
        // Downscale to the max DPI the slot needs (keeps PDFs within upload limits; never upscales).
        const drawW = slot.draw.crop ? slot.draw.w / slot.draw.crop.fx : slot.draw.w;
        const drawH = slot.draw.crop ? slot.draw.h / slot.draw.crop.fy : slot.draw.h;
        const maxEdgePx = Math.ceil(Math.max(drawW, drawH) * spec.maxDpi);
        const needsDownscale = Math.max(info.width, info.height) > maxEdgePx * 1.15;
        const toJpeg = spec.encode === 'jpeg' && info.format !== 'jpeg';
        const key = `${info.abs}|${info.mtimeMs}|${needsDownscale ? maxEdgePx : 'full'}|${toJpeg ? 'jpg' : 'png'}`;
        if (!xobjects.has(key)) {
          let file = info.abs;
          if (needsDownscale || toJpeg || info.format === 'webp') file = await cachedConvert(info, needsDownscale ? maxEdgePx : null, toJpeg);
          const img = await loadImage(file, info);
          const ref = pdf.addImage(img);
          xobjects.set(key, { ref, width: img.width, height: img.height });
          embedded.push({ name: info.name, sourcePx: `${info.width}×${info.height}`, embeddedPx: `${img.width}×${img.height}`, downscaled: needsDownscale, encode: img.filter === 'DCTDecode' ? 'jpeg' : 'png' });
        }
        slot.xobj = xobjects.get(key);
      }
    }
    const font = spec.label ? pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>') : null;
    if (font) font.name = '/F1';
    for (const page of layout.pages) {
      const content = pageContent(layout, page, spec, sheet, font);
      pdf.addPage(layout.page.width * PT, layout.page.height * PT, content, page.slots.filter((s) => s.xobj).map((s) => s.xobj.ref), font);
    }
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
    const file = `${sheet.id}-${stamp}.pdf`;
    const buf = pdf.build({ Title: sheet.name, Producer: 'Dadventures Print Sheets' });
    await fsp.writeFile(path.join(SHEETS_DIR, file), buf);
    const render = {
      file, at: new Date().toISOString(), bytes: buf.length, pages: layout.pages.length, images: layout.count,
      duplex: layout.duplex, grid: `${layout.cols}×${layout.rows}`, page: `${round3(layout.page.width)}×${round3(layout.page.height)} in`,
      cell: `${round3(layout.cell.width)}×${round3(layout.cell.height)} in`, embedded, warnings: layout.warnings, ms: Date.now() - started,
    };
    // Keep only the newest render on disk.
    if (sheet.lastRender?.file && sheet.lastRender.file !== file) await fsp.unlink(path.join(SHEETS_DIR, sheet.lastRender.file)).catch(() => {});
    sheet.lastRender = render;
    await writeJsonAtomic(sheetFile(sheet.id), sheet);
    await appendLog({ type: 'sheet_render', sheetId: sheet.id, name: sheet.name, file, pages: render.pages, images: render.images, grid: render.grid, page: render.page, bytes: buf.length, ms: render.ms });
    return pub(sheet);
  }

  // Convert / downscale through sips (macOS). Cached under output/sheets/.cache by content identity.
  async function cachedConvert(info, maxEdgePx, toJpeg = false) {
    if (!isDarwin) {
      if (info.format === 'webp') throw new HttpError(400, `${info.name}: WebP can only be embedded on macOS (needs sips). Convert it to PNG or JPEG first.`);
      return info.abs; // no downscaling / re-encoding available: embed the file as-is
    }
    const hash = crypto.createHash('sha1').update(`${info.abs}|${info.mtimeMs}|${info.bytes}|${maxEdgePx || 'full'}|${toJpeg ? 'jpg' : 'png'}`).digest('hex').slice(0, 20);
    const dest = path.join(CACHE_DIR, `${hash}.${toJpeg ? 'jpg' : 'png'}`);
    if (!(await exists(dest))) {
      const args = maxEdgePx ? ['-Z', String(maxEdgePx)] : [];
      const fmt = toJpeg ? ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92'] : ['-s', 'format', 'png'];
      const ok = await sips([...args, ...fmt, info.abs, '--out', dest], 300000);
      if (!ok) throw new HttpError(500, `Could not convert ${info.name} with sips.`);
    }
    return dest;
  }

  async function loadImage(file, info) {
    const buf = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png' || buf.subarray(0, 8).equals(PNG_SIG)) return pngImage(buf, info.name);
    if (ext === '.jpg' || ext === '.jpeg' || (buf[0] === 0xff && buf[1] === 0xd8)) return jpegImage(buf, info.name);
    throw new HttpError(400, `${info.name}: unsupported image format for PDF embedding.`);
  }

  function pageContent(layout, page, spec, sheet, font) {
    const H = layout.page.height;
    const ops = [`1 g 0 0 ${(layout.page.width * PT).toFixed(3)} ${(H * PT).toFixed(3)} re f`];  // white page
    const X = (x) => (x * PT).toFixed(3);
    const Y = (y) => ((H - y) * PT).toFixed(3);  // flip: PDF origin is bottom-left
    const S = (v) => (v * PT).toFixed(3);
    for (const slot of page.slots) {
      if (!slot.xobj) continue;
      const d = slot.draw;
      if (d.crop) {
        const fullW = d.w / d.crop.fx, fullH = d.h / d.crop.fy;
        const ox = d.x - (fullW - d.w) / 2, oy = d.y - (fullH - d.h) / 2;
        ops.push(`q ${X(d.x)} ${Y(d.y + d.h)} ${S(d.w)} ${S(d.h)} re W n ${S(fullW)} 0 0 ${S(fullH)} ${X(ox)} ${Y(oy + fullH)} cm ${slot.xobj.ref.name} Do Q`);
      } else {
        ops.push(`q ${S(d.w)} 0 0 ${S(d.h)} ${X(d.x)} ${Y(d.y + d.h)} cm ${slot.xobj.ref.name} Do Q`);
      }
    }
    if (spec.outline || spec.cutMarks) {
      ops.push('q 0.25 w 0.55 G');
      for (const slot of page.slots) {
        if (!slot.xobj) continue;
        const d = slot.cut || slot.draw;
        if (spec.outline) ops.push(`${X(d.x)} ${Y(d.y + d.h)} ${S(d.w)} ${S(d.h)} re S`);
        if (spec.cutMarks) {
          // Corner crop marks sit outside the image, in the gutter/margin, so they are cut away with the scrap.
          const gap = 0.04;
          const len = Math.min(0.25, Math.min(layout.gutter, layout.marginX, layout.marginY) - gap);
          if (len < 0.03) continue;
          const x0 = d.x, x1 = d.x + d.w, y0 = d.y, y1 = d.y + d.h;
          const line = (ax, ay, bx, by) => ops.push(`${X(ax)} ${Y(ay)} m ${X(bx)} ${Y(by)} l S`);
          for (const [cx, dx] of [[x0, -1], [x1, 1]]) for (const [cy, dy] of [[y0, -1], [y1, 1]]) {
            line(cx + dx * gap, cy, cx + dx * (gap + len), cy);       // horizontal tick
            line(cx, cy + dy * gap, cx, cy + dy * (gap + len));       // vertical tick
          }
        }
      }
      if (spec.cutMarks) for (const [ax, ay, bx, by] of edgeMarks(layout, page)) ops.push(`${X(ax)} ${Y(ay)} m ${X(bx)} ${Y(by)} l S`);
      ops.push('Q');
    }
    if (font && layout.margin >= 0.15) {
      const text = `${sheet.name} - ${layout.duplex ? `sheet ${page.of} ${page.side}` : `page ${page.number}/${layout.pages.length}`} - ${layout.cols}x${layout.rows}, ${round3(layout.cell.width)}x${round3(layout.cell.height)} in cells`;
      ops.push(`BT ${font.name} 6 Tf 0.5 g ${X(layout.margin)} ${((layout.margin / 2) * PT).toFixed(3)} Td (${pdfString(text)}) Tj ET`);
    }
    return ops.join('\n');
  }

  // ---------- routes ----------
  async function route(req, res, url) {
    const p = url.pathname;
    if (p === '/api/sheets/images' && req.method === 'GET') { send(res, 200, { sources: await listImages() }); return true; }
    if (p === '/api/sheets/layout' && req.method === 'POST') {
      const spec = sanitizeSpec((await readJson(req)).spec);
      const images = spec.items.length ? await resolveItems(spec) : new Map();
      const layout = computeLayout(spec, images);
      const brief = (im) => (im ? { source: im.source, rel: im.rel, name: im.name, width: im.width, height: im.height } : null);
      send(res, 200, { ...layout, pages: layout.pages.map((pg) => ({ ...pg, slots: pg.slots.map((s) => ({ ...s, image: brief(s.image), frontImage: brief(s.frontImage) })) })) });
      return true;
    }
    if (p === '/api/sheets/render' && req.method === 'POST') { send(res, 200, await renderSheet(await readJson(req))); return true; }
    if (p === '/api/sheets' && req.method === 'GET') { send(res, 200, await listSheets()); return true; }
    if (p === '/api/sheets' && req.method === 'POST') { send(res, 200, pub(await upsertSheet(await readJson(req)))); return true; }
    if (!p.startsWith('/api/sheets/')) return false;
    const [id, a] = p.slice('/api/sheets/'.length).split('/').map(decodeURIComponent);
    if (req.method === 'GET' && !a) send(res, 200, pub(await getSheet(id)));
    else if (req.method === 'DELETE' && !a) send(res, 200, await deleteSheet(id));
    else if (req.method === 'POST' && a === 'reveal') {
      const s = await getSheet(id);
      if (!isDarwin) throw new HttpError(400, 'Reveal in Finder is only available on macOS.');
      if (!s.lastRender?.file) throw new HttpError(404, 'This sheet has not been built yet.');
      execFile('/usr/bin/open', ['-R', path.join(SHEETS_DIR, s.lastRender.file)]);
      send(res, 200, { revealed: s.lastRender.file });
    } else throw new HttpError(404, 'Not found.');
    return true;
  }

  // Serve a source image (full size) for the picker's "open" link.
  function sourceFile(sourceId, rel) {
    const src = sourceById(sourceId);
    return { dir: src.dir, rel };
  }

  // "<source>:<relative path>" (the picker's image id) → absolute path.
  function resolveImage(id) {
    const i = String(id).indexOf(':');
    if (i < 1) throw new HttpError(400, 'Invalid image id.');
    return resolveInSource(sourceById(id.slice(0, i)), id.slice(i + 1));
  }

  return {
    route, sourceFile, listImages, resolveImage,
    config: () => ({ pageSizes: PAGE_SIZES, grids: GRID_PRESETS, defaults: DEFAULT_SPEC, sources: sources().map(({ id, label, dir }) => ({ id, label, dir })), maxItems: MAX_ITEMS, canDownscale: isDarwin }),
  };
}

// ---------- image headers ----------
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function readDims(file) {
  const fh = await fsp.open(file, 'r');
  try {
    let size = 64 * 1024;
    for (let attempt = 0; attempt < 6; attempt++) {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, 0);
      const head = buf.subarray(0, bytesRead);
      const dims = dimsFromHeader(head);
      if (dims) return dims;
      if (bytesRead < size) break;
      size *= 4;
    }
  } finally { await fh.close(); }
  throw new Error('Unrecognised image header');
}

export function dimsFromHeader(b) {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG)) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), format: 'jpeg', components: b[i + 9] };
      }
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), format: 'webp' };
    if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: 'webp' }; }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
  }
  return null;
}

// ---------- PNG → PDF image ----------
// 8-bit grey/RGB, non-interlaced, no transparency: the IDAT stream is embedded as-is with PNG predictors (lossless, no re-encode).
// Everything else (alpha, palette, 16-bit, sub-byte depths) is decoded to 8-bit RGB/grey, composited over white, and re-deflated.
function pngImage(buf, name) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error(`${name}: not a PNG`);
  let pos = 8;
  let ihdr = null; const idat = []; let plte = null; let trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error(`${name}: PNG without IHDR`);
  if (ihdr.interlace) throw new Error(`${name}: interlaced PNGs are not supported — re-save it without interlacing.`);
  const { width, height, bitDepth, colorType } = ihdr;
  const compressed = Buffer.concat(idat);
  if (bitDepth === 8 && (colorType === 2 || colorType === 0) && !trns) {
    const colors = colorType === 2 ? 3 : 1;
    return { width, height, colorSpace: colors === 3 ? 'DeviceRGB' : 'DeviceGray', bpc: 8, filter: 'FlateDecode', data: compressed,
      decodeParms: `<< /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>` };
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${name}: unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(compressed);
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const pixels = unfilter(raw, width, height, bpp, stride);
  const outGray = colorType === 0 || colorType === 4;
  const outChannels = outGray ? 1 : 3;
  const out = Buffer.alloc(width * height * outChannels);
  const maxVal = (1 << bitDepth) - 1;
  const sampleAt = (row, i) => { // i-th sample in the row, scaled to 0..255
    if (bitDepth === 8) return row[i];
    if (bitDepth === 16) return row[i * 2];
    const bitPos = i * bitDepth; const byte = row[bitPos >> 3];
    const v = (byte >> (8 - bitDepth - (bitPos & 7))) & maxVal;
    return colorType === 3 ? v : Math.round((v * 255) / maxVal);
  };
  const trnsGray = trns && colorType === 0 ? trns.readUInt16BE(0) : null;
  const trnsRgb = trns && colorType === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null;
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let r, g, b, a = 255;
      if (colorType === 0) { r = sampleAt(row, x); if (trnsGray != null && rawSample(row, x, bitDepth) === trnsGray) a = 0; }
      else if (colorType === 2) { r = sampleAt(row, x * 3); g = sampleAt(row, x * 3 + 1); b = sampleAt(row, x * 3 + 2); if (trnsRgb && rawSample(row, x * 3, bitDepth) === trnsRgb[0] && rawSample(row, x * 3 + 1, bitDepth) === trnsRgb[1] && rawSample(row, x * 3 + 2, bitDepth) === trnsRgb[2]) a = 0; }
      else if (colorType === 3) { const idx = sampleAt(row, x); r = plte[idx * 3]; g = plte[idx * 3 + 1]; b = plte[idx * 3 + 2]; if (trns && idx < trns.length) a = trns[idx]; }
      else if (colorType === 4) { r = sampleAt(row, x * 2); a = sampleAt(row, x * 2 + 1); }
      else { r = sampleAt(row, x * 4); g = sampleAt(row, x * 4 + 1); b = sampleAt(row, x * 4 + 2); a = sampleAt(row, x * 4 + 3); }
      if (outGray) out[o++] = a === 255 ? r : Math.round((r * a + 255 * (255 - a)) / 255);
      else if (a === 255) { out[o++] = r; out[o++] = g; out[o++] = b; }
      else { out[o++] = Math.round((r * a + 255 * (255 - a)) / 255); out[o++] = Math.round((g * a + 255 * (255 - a)) / 255); out[o++] = Math.round((b * a + 255 * (255 - a)) / 255); }
    }
  }
  return { width, height, colorSpace: outGray ? 'DeviceGray' : 'DeviceRGB', bpc: 8, filter: 'FlateDecode', data: zlib.deflateSync(out, { level: 6 }), decodeParms: null };
}
function rawSample(row, i, bitDepth) {
  if (bitDepth === 8) return row[i];
  if (bitDepth === 16) return row.readUInt16BE(i * 2);
  const bitPos = i * bitDepth; return (row[bitPos >> 3] >> (8 - bitDepth - (bitPos & 7))) & ((1 << bitDepth) - 1);
}
function unfilter(raw, width, height, bpp, stride) {
  const out = Buffer.alloc(stride * height);
  let ip = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[ip++];
    const o = y * stride; const prev = y > 0 ? o - stride : -1;
    for (let i = 0; i < stride; i++) {
      const x = raw[ip + i];
      const a = i >= bpp ? out[o + i - bpp] : 0;
      const b = prev >= 0 ? out[prev + i] : 0;
      const c = prev >= 0 && i >= bpp ? out[prev + i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error(`Bad PNG filter type ${ft} on row ${y}`);
      }
      out[o + i] = v & 0xff;
    }
    ip += stride;
  }
  return out;
}

// ---------- JPEG → PDF image (pass-through) ----------
function jpegImage(buf, name) {
  const d = dimsFromHeader(buf.subarray(0, Math.min(buf.length, 4 << 20)));
  if (!d || d.format !== 'jpeg') throw new Error(`${name}: could not parse JPEG header`);
  const cs = d.components === 1 ? 'DeviceGray' : d.components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
  const adobe = d.components === 4 && buf.includes('Adobe', 0, 'ascii');
  return { width: d.width, height: d.height, colorSpace: cs, bpc: 8, filter: 'DCTDecode', data: buf, decodeParms: null, decode: adobe ? '[1 0 1 0 1 0 1 0]' : null };
}

// ---------- minimal PDF writer ----------
class PdfWriter {
  constructor() { this.objects = []; this.pages = []; this.imageCount = 0; }
  add(body, stream) { const num = this.objects.length + 1; this.objects.push({ num, body, stream }); return { num, name: null }; }
  addImage(img) {
    this.imageCount++;
    const name = `/Im${this.imageCount}`;
    const dict = [`/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${img.colorSpace} /BitsPerComponent ${img.bpc} /Filter /${img.filter}`];
    if (img.decodeParms) dict.push(`/DecodeParms ${img.decodeParms}`);
    if (img.decode) dict.push(`/Decode ${img.decode}`);
    const ref = this.add(`<< ${dict.join(' ')} /Length ${img.data.length} >>`, img.data);
    ref.name = name;
    return ref;
  }
  addPage(wPt, hPt, content, imageRefs, fontRef) {
    const data = Buffer.from(content, 'latin1');
    const contentRef = this.add(`<< /Length ${data.length} >>`, data);
    const xo = [...new Set(imageRefs)].map((r) => `${r.name} ${r.num} 0 R`).join(' ');
    const fonts = fontRef ? `/Font << ${fontRef.name} ${fontRef.num} 0 R >>` : '';
    this.pages.push({ wPt, hPt, contentRef, resources: `<< /XObject << ${xo} >> ${fonts} >>` });
  }
  build(info = {}) {
    const pagesNum = this.objects.length + 1 + this.pages.length;  // page objects first, then the Pages node
    const pageRefs = this.pages.map((p) => this.add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${p.wPt.toFixed(3)} ${p.hPt.toFixed(3)}] /Resources ${p.resources} /Contents ${p.contentRef.num} 0 R >>`));
    const pages = this.add(`<< /Type /Pages /Kids [${pageRefs.map((r) => `${r.num} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
    const catalog = this.add(`<< /Type /Catalog /Pages ${pages.num} 0 R >>`);
    const infoRef = this.add(`<< ${Object.entries(info).map(([k, v]) => `/${k} (${pdfString(v)})`).join(' ')} /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`);
    const parts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    const offsets = [];
    let len = parts[0].length;
    for (const o of this.objects) {
      offsets.push(len);
      const head = Buffer.from(`${o.num} 0 obj\n${o.body}\n${o.stream ? 'stream\n' : ''}`, 'latin1');
      const tail = Buffer.from(o.stream ? '\nendstream\nendobj\n' : 'endobj\n', 'latin1');
      parts.push(head); len += head.length;
      if (o.stream) { parts.push(o.stream); len += o.stream.length; }
      parts.push(tail); len += tail.length;
    }
    const xrefPos = len;
    const xref = [`xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((off) => `${String(off).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${this.objects.length + 1} /Root ${catalog.num} 0 R /Info ${infoRef.num} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}
export { pngImage, jpegImage, PdfWriter };
function pdfString(s) {
  return String(s ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);
}
