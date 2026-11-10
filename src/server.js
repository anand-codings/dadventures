#!/usr/bin/env node
// Dadventures — zero-dependency local server for GPT Image 2.6 generation.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBooks } from './books.js';
import { createSheets } from './sheets.js';
import { createCards } from './cards.js';
import { createAi, IMAGE_PRICE, PRICING, sniffImage, responseText } from './ai.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // the app folder (this file is in src/)
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 53405);
const HOST = process.env.HOST || '127.0.0.1';
const OUTPUT_DIR = path.resolve(ROOT, process.env.OUTPUT_DIR || 'output');
const TRASH_DIR = path.join(OUTPUT_DIR, 'trash');
const THUMBS_DIR = path.join(OUTPUT_DIR, '.thumbs');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.json');
const PROMPTS_FILE = path.join(OUTPUT_DIR, 'prompts.json');
const LOG_FILE = path.join(OUTPUT_DIR, 'prompt-log.jsonl');
const CHARACTERS_DIR = path.join(OUTPUT_DIR, 'characters');
const CHARACTERS_FILE = path.join(CHARACTERS_DIR, 'characters.json');
const RESERVED = new Set(['history.json', 'prompts.json', 'history.json.tmp', 'prompts.json.tmp']);
const UPSCALE_BIN = process.env.REALESRGAN_BIN || '';   // path to realesrgan-ncnn-vulkan; local upscaling is off when unset
const UPSCALE_MODELS_DIR = process.env.REALESRGAN_MODELS || (UPSCALE_BIN ? path.join(path.dirname(UPSCALE_BIN), 'models') : '');
const FAL_KEY = process.env.FAL_KEY || '';
// Upscaler catalogue. `provider` is 'local' (Real-ESRGAN binary, free) or 'fal' (fal.ai cloud, billed per output megapixel).
// Cloud pricing is an estimate from fal's published rates: either `perMp` (USD per output megapixel) or
// `perBlock`/`blockMp` (USD per started block of N megapixels).
const UPSCALE_OPTIONS = [
  { id: 'realesrgan-x4plus', provider: 'local', short: 'x4plus', label: 'Real-ESRGAN x4plus — photos & general', hint: 'local GPU, free, ~10–60 s', scales: [2, 3, 4] },
  { id: 'realesrgan-x4plus-anime', provider: 'local', short: 'x4plus-anime', label: 'Real-ESRGAN x4plus-anime — illustrations, flat colors, posters', hint: 'local GPU, free, ~10–60 s', scales: [2, 3, 4] },
  { id: 'realesr-animevideov3', provider: 'local', short: 'animevideov3', label: 'Real-ESR animevideov3 — fast, lighter touch', hint: 'local GPU, free, fastest', scales: [2, 3, 4] },
  { id: 'fal-seedvr2', provider: 'fal', short: 'seedvr2', label: 'SeedVR2 — photoreal restoration, best value', hint: 'fal.ai, ~20–60 s', scales: [2, 3, 4, 6, 8],
    endpoint: 'fal-ai/seedvr/upscale/image', price: { perMp: 0.001 },
    input: (scale) => ({ upscale_mode: 'factor', upscale_factor: scale, noise_scale: 0.1, output_format: 'png' }) },
  { id: 'fal-topaz-standard', provider: 'fal', short: 'topaz-std', label: 'Topaz Gigapixel Standard V2 — faithful, general photos', hint: 'fal.ai, ~30–90 s', scales: [2, 3, 4],
    endpoint: 'topaz/upscale/image/precision', price: { perBlock: 0.08, blockMp: 24 },
    input: (scale) => ({ model: 'Standard V2', upscale_factor: scale, output_format: 'png' }) },
  { id: 'fal-topaz-hifi', provider: 'fal', short: 'topaz-hifi', label: 'Topaz Gigapixel High Fidelity V3 — preserves fine detail', hint: 'fal.ai, ~30–90 s', scales: [2, 3, 4],
    endpoint: 'topaz/upscale/image/precision', price: { perBlock: 0.08, blockMp: 24 },
    input: (scale) => ({ model: 'High Fidelity V3', upscale_factor: scale, output_format: 'png' }) },
  { id: 'fal-topaz-cgi', provider: 'fal', short: 'topaz-cgi', label: 'Topaz Gigapixel CGI — artwork, renders, flat color', hint: 'fal.ai, ~30–90 s', scales: [2, 3, 4],
    endpoint: 'topaz/upscale/image/precision', price: { perBlock: 0.08, blockMp: 24 },
    input: (scale) => ({ model: 'CGI', upscale_factor: scale, output_format: 'png' }) },
  { id: 'fal-topaz-wonder', provider: 'fal', short: 'topaz-wonder', label: 'Topaz Wonder 3.5 — generative, rebuilds detail (premium)', hint: 'fal.ai, ~1–3 min', scales: [2, 3, 4],
    endpoint: 'topaz/upscale/image/generative', price: { perBlock: 0.08, blockMp: 8 },
    input: (scale) => ({ model: 'Wonder 3.5', upscale_factor: scale, output_format: 'png' }) },
];
const UPSCALE_MAX_EDGE = 16384;
const MAX_REF_BYTES = 15 * 1024 * 1024;
const MAX_REFS = 16;
const API_KEY = process.env.OPENAI_API_KEY || '';
const DEFAULT_IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-2.6-flare';
const ENHANCE_MODEL = process.env.ENHANCE_MODEL || 'gpt-5.4-mini';
const BOOK_MODEL = process.env.BOOK_MODEL || 'gpt-6-astra';
const CARD_MODEL = process.env.CARD_MODEL || BOOK_MODEL;
const CARD_VISION_MODEL = process.env.CARD_VISION_MODEL || ENHANCE_MODEL;
const THUMB_SIZE = 512;

const IMAGE_MODELS = [
  { id: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare (fast, default)' },
  { id: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst (most precise, slower)' },
  // Previous generation, kept so in-progress books and card series stay visually consistent.
  { id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare (previous)' },
  { id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst (previous)' },
];
const SIZE_PRESETS = [
  { id: '2048x2048', label: '2048 × 2048 — 2K square' },
  { id: '2048x3072', label: '2048 × 3072 — 2K portrait 2:3' },
  { id: '3072x2048', label: '3072 × 2048 — 2K landscape 3:2' },
  { id: '2048x2560', label: '2048 × 2560 — 4:5 portrait (8×10 print)' },
  { id: '2560x2048', label: '2560 × 2048 — 5:4 landscape' },
  { id: '2160x3840', label: '2160 × 3840 — 4K portrait (experimental)' },
  { id: '3840x2160', label: '3840 × 2160 — 4K landscape (experimental)' },
  { id: '1024x1024', label: '1024 × 1024 — 1K square (draft)' },
  { id: '1024x1536', label: '1024 × 1536 — 1K portrait (draft)' },
  { id: '1536x1024', label: '1536 × 1024 — 1K landscape (draft)' },
];
const QUALITIES = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const FORMATS = ['png', 'jpeg', 'webp'];
const BACKGROUNDS = ['auto', 'opaque', 'transparent'];
// USD per 1M tokens, same rates for GPT Image 2.6 and 2.5 (2.6 uses more output tokens per image at low quality). All pricing lives in ai.js.
const PRICE = IMAGE_PRICE;

const ENHANCE_INSTRUCTIONS = `You are an expert prompt writer for OpenAI's GPT Image 2.6 image model.
Rewrite the user's image prompt into a richer, production-ready prompt.

Rules:
- PRESERVE every subject, object, count, color, pose, named style, and constraint the user specified. Never remove, replace, soften, or contradict anything they asked for.
- If the user wants text or lettering in the image, keep it verbatim, wrap it in double quotes, and describe its font style and placement. Do not invent additional text.
- ADD only what is missing: composition and framing, camera or viewpoint, lighting, color palette, materials and textures, mood, medium/style, background, and finishing details suitable for high-resolution print (crisp edges, clean full-bleed composition, no watermark, no border unless asked).
- Keep the user's intended audience and tone (for example, a children's poster stays friendly and simple).
- If named characters are listed, reference images of them will be attached at generation time. Refer to each by name, describe only their pose, expression, action and placement (left/right, foreground/background), and do NOT describe, change or invent their appearance. Avoid ambiguous pronouns when several characters share the scene.
- When named characters are listed, write the prompt as short labeled sections in this order instead of prose: "Scene:", "Composition:", "Style:", "Constraints:". Keep the style section consistent with the characters' art style. Under Constraints include "Do not redesign the characters" plus any text/watermark exclusions.
- Write 60 to 160 words of plain prose in one or two paragraphs, in English only. No headings, bullets, labels, or preamble.
- Output only the enhanced prompt.`;

// ---------- helpers ----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const exists = (p) => fsp.access(p).then(() => true, () => false);

function validateSize(size) {
  if (size === 'auto') return;
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!m) throw new HttpError(400, 'Size must be WIDTHxHEIGHT or auto.');
  const w = Number(m[1]), h = Number(m[2]);
  if (w % 16 || h % 16) throw new HttpError(400, 'Width and height must be multiples of 16.');
  if (Math.max(w, h) > 3840) throw new HttpError(400, 'Neither edge may exceed 3840 px.');
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > 3) throw new HttpError(400, 'Aspect ratio must be between 1:3 and 3:1.');
  const px = w * h;
  if (px < 655360) throw new HttpError(400, 'Total pixels must be at least 655,360 (e.g. 1024x640).');
  if (px > 8294400) throw new HttpError(400, 'Total pixels must not exceed 8,294,400 (4K).');
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-').slice(0, 48) || 'image';
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const baseName = (file) => file.replace(/\.[a-z0-9]+$/i, '');
const clampStr = (v, max) => (v == null ? '' : String(v)).trim().slice(0, max);
const cleanTags = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((t) => clampStr(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20);

function pngDimensions(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ---------- embedded metadata (PNG iTXt, JPEG COM, WebP XMP) ----------
function pngWithMetadata(buf, fields) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') return buf;
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrEnd = 8 + 4 + 4 + ihdrLen + 4;
  const chunks = Object.entries(fields).filter(([, v]) => v != null && v !== '').map(([k, v]) => {
    const data = Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(String(v), 'utf8')]);
    const type = Buffer.from('iTXt', 'latin1');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0);
    return Buffer.concat([len, type, data, crc]);
  });
  return Buffer.concat([buf.subarray(0, ihdrEnd), ...chunks, buf.subarray(ihdrEnd)]);
}

function jpegWithComment(buf, text) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const data = Buffer.from(text, 'utf8').subarray(0, 65000);
  const seg = Buffer.alloc(4); seg[0] = 0xff; seg[1] = 0xfe; seg.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([buf.subarray(0, 2), seg, data, buf.subarray(2)]);
}

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
function xmpPacket(prompt, metaJson) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dv="https://dadventures.local/ns/1.0/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(prompt)}</rdf:li></rdf:Alt></dc:description><xmp:CreatorTool>dadventures</xmp:CreatorTool><dv:metadata>${xmlEscape(metaJson)}</dv:metadata></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

function riffChunk(fourcc, data) {
  const head = Buffer.alloc(8); head.write(fourcc, 0, 'latin1'); head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
}
function webpWithXmp(buf, xmp) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return buf;
  const body = Buffer.from(buf.subarray(12));
  const first = body.toString('latin1', 0, 4);
  const xmpChunk = riffChunk('XMP ', Buffer.from(xmp, 'utf8'));
  let out;
  if (first === 'VP8X') {
    body[8] |= 0x04; // XMP flag
    out = Buffer.concat([body, xmpChunk]);
  } else {
    let w, h;
    if (first === 'VP8 ' && body[11] === 0x9d && body[12] === 0x01 && body[13] === 0x2a) {
      w = body.readUInt16LE(14) & 0x3fff; h = body.readUInt16LE(16) & 0x3fff;
    } else if (first === 'VP8L' && body[8] === 0x2f) {
      const bits = body.readUInt32LE(9); w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1;
    } else return buf;
    const vp8x = Buffer.alloc(18);
    vp8x.write('VP8X', 0, 'latin1'); vp8x.writeUInt32LE(10, 4); vp8x[8] = 0x04;
    vp8x.writeUIntLE(w - 1, 12, 3); vp8x.writeUIntLE(h - 1, 15, 3);
    out = Buffer.concat([vp8x, body, xmpChunk]);
  }
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(4 + out.length, 4); header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, out]);
}

function embedMetadata(buf, format, prompt, meta) {
  const metaJson = JSON.stringify(meta);
  if (format === 'png') return pngWithMetadata(buf, { Description: prompt, Comment: metaJson, Software: 'dadventures' });
  if (format === 'jpeg') return jpegWithComment(buf, `dadventures ${JSON.stringify({ prompt, ...meta })}`);
  if (format === 'webp') return webpWithXmp(buf, xmpPacket(prompt, metaJson));
  return buf;
}

// ---------- thumbnails (macOS sips when available) ----------
let sipsAvailable = null;
async function ensureThumb(rec) {
  if (sipsAvailable === null) sipsAvailable = process.platform === 'darwin' && await exists('/usr/bin/sips');
  if (!sipsAvailable) return null;
  const src = path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, rec.file);
  const thumbFile = `${baseName(rec.file)}.jpg`;
  const dest = path.join(THUMBS_DIR, thumbFile);
  if (!(await exists(dest))) {
    await fsp.mkdir(THUMBS_DIR, { recursive: true });
    const ok = await new Promise((resolve) => execFile('/usr/bin/sips', ['-Z', String(THUMB_SIZE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dest], { timeout: 30000 }, (err) => resolve(!err)));
    if (!ok) return null;
  }
  rec.thumbUrl = `/thumbs/${encodeURIComponent(thumbFile)}`;
  return rec.thumbUrl;
}

// ---------- AI gateway ----------
// Every model call (OpenAI text and images, fal.ai, Real-ESRGAN) goes through ai.js, which logs input, output and cost.
const ai = createAi({ OUTPUT_DIR, OPENAI_API_KEY: API_KEY, FAL_KEY, HttpError });

// ---------- records, history, sidecars, log ----------
function normalize(rec) {
  rec.title = clampStr(rec.title, 120);
  rec.notes = clampStr(rec.notes, 4000);
  rec.tags = cleanTags(rec.tags);
  rec.favorite = Boolean(rec.favorite);
  rec.parentId = rec.parentId || null;
  rec.deletedAt = rec.deletedAt || null;
  rec.enhancedPrompt = rec.enhancedPrompt || null;
  rec.enhanceNotes = rec.enhanceNotes || null;
  rec.url = `${rec.deletedAt ? '/trash/' : '/output/'}${encodeURIComponent(rec.file)}`;
  rec.thumbUrl = rec.thumbUrl || null;
  rec.missing = Boolean(rec.missing);
  rec.kind = rec.kind === 'upscaled' ? 'upscaled' : 'generated';
  rec.upscaleOf = rec.upscaleOf || null;
  rec.upscale = rec.upscale || null;
  rec.characters = Array.isArray(rec.characters) ? rec.characters : [];
  rec.characterPrompt = rec.characterPrompt || null;
  return rec;
}

async function readJsonFile(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}
const readHistory = async () => (await readJsonFile(HISTORY_FILE, [])).map(normalize);
const writeHistory = (list) => writeJsonAtomic(HISTORY_FILE, list);

const sidecarPath = (rec) => path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, `${baseName(rec.file)}.json`);
const writeSidecar = (rec) => fsp.writeFile(sidecarPath(rec), JSON.stringify(rec, null, 2));

function appendLog(event) {
  return fsp.appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n').catch((e) => console.error('log write failed', e));
}

// Serialize all history mutations through one promise chain.
let lock = Promise.resolve();
function withHistory(fn) {
  const run = lock.then(async () => {
    const list = await readHistory();
    const result = await fn(list);
    await writeHistory(list);
    return result;
  });
  lock = run.catch(() => {});
  return run;
}

function findRec(list, id) {
  const rec = list.find((r) => r.id === id);
  if (!rec) throw new HttpError(404, 'Not found.');
  return rec;
}

// Rebuild the index from per-image sidecars (output + trash) and flag missing files.
async function reconcile() {
  return withHistory(async (list) => {
    const byId = new Map(list.map((r) => [r.id, r]));
    let added = 0;
    for (const [dir, deleted] of [[OUTPUT_DIR, false], [TRASH_DIR, true]]) {
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        if (!name.endsWith('.json') || RESERVED.has(name)) continue;
        const rec = await readJsonFile(path.join(dir, name), null);
        if (!rec?.id || !rec.file || byId.has(rec.id)) continue;
        if (deleted && !rec.deletedAt) rec.deletedAt = new Date().toISOString();
        if (!deleted) rec.deletedAt = null;
        list.push(normalize(rec)); byId.set(rec.id, rec); added++;
      }
    }
    let missing = 0, thumbs = 0;
    for (const rec of list) {
      rec.missing = !(await exists(path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, rec.file)));
      if (rec.missing) { missing++; continue; }
      if (!rec.thumbUrl || !(await exists(path.join(THUMBS_DIR, `${baseName(rec.file)}.jpg`)))) {
        rec.thumbUrl = null;
        if (await ensureThumb(rec)) thumbs++;
      }
    }
    list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { total: list.length, added, missing, thumbsCreated: thumbs };
  });
}

// ---------- HTTP plumbing ----------
async function readJson(req, limit = 1 << 20) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'Body too large.');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff2': 'font/woff2' };
async function serveFile(res, dir, rel, cache) {
  const file = path.normalize(path.join(dir, rel));
  if (!file.startsWith(dir + path.sep)) throw new HttpError(403, 'Forbidden.');
  let st;
  try { st = await fsp.stat(file); } catch { throw new HttpError(404, 'Not found.'); }
  if (!st.isFile()) throw new HttpError(404, 'Not found.');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

function getConfig() {
  return {
    hasApiKey: Boolean(API_KEY), outputDir: OUTPUT_DIR, platform: process.platform,
    imageModels: IMAGE_MODELS, defaultImageModel: DEFAULT_IMAGE_MODEL, enhanceModel: ENHANCE_MODEL,
    sizePresets: SIZE_PRESETS, defaultSize: '2048x2048', qualities: QUALITIES, defaultQuality: 'high',
    formats: FORMATS, backgrounds: BACKGROUNDS, price: PRICE,
    upscale: {
      available: upscaleOptions.length > 0, maxEdge: UPSCALE_MAX_EDGE,
      local: { available: localModels.length > 0, bin: UPSCALE_BIN },
      fal: { available: Boolean(FAL_KEY) },
      // Only serialize the public fields (the `input` builder stays server-side).
      options: upscaleOptions.map(({ id, provider, short, label, hint, scales, price }) => ({ id, provider, short, label, hint, scales, price: price || null })),
    },
    books: books.config(),
    sheets: sheets.config(),
    cards: cards.config(),
    characters: { maxRefs: MAX_REFS, maxRefBytes: MAX_REF_BYTES, roles: Object.fromEntries(Object.entries(REF_ROLES).map(([k, v]) => [k, v.label])), fields: CHAR_FIELDS },
  };
}

let localModels = [];     // Real-ESRGAN models found on disk
let upscaleOptions = [];  // every usable option (local + fal)
async function detectUpscaler() {
  localModels = [];
  if (UPSCALE_BIN && await exists(UPSCALE_BIN) && await exists(UPSCALE_MODELS_DIR)) {
    const files = await fsp.readdir(UPSCALE_MODELS_DIR).catch(() => []);
    localModels = UPSCALE_OPTIONS.filter((m) => m.provider === 'local' && files.some((f) => f === `${m.id}.param` || f.startsWith(`${m.id}-x`)));
  }
  upscaleOptions = [...localModels, ...(FAL_KEY ? UPSCALE_OPTIONS.filter((m) => m.provider === 'fal') : [])];
}

const SOURCE_MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };

async function handleUpscale(id, body) {
  if (!upscaleOptions.length) throw new HttpError(400, `No upscaler is available. Install Real-ESRGAN and set REALESRGAN_BIN (and REALESRGAN_MODELS) in .env, or set FAL_KEY for cloud upscaling.`);
  const modelId = String(body.model || 'realesrgan-x4plus-anime');
  const opt = upscaleOptions.find((m) => m.id === modelId);
  if (!opt) {
    const known = UPSCALE_OPTIONS.find((m) => m.id === modelId);
    if (known?.provider === 'fal') throw new HttpError(400, 'Cloud upscaling needs FAL_KEY in .env (restart the server after adding it).');
    if (known?.provider === 'local') throw new HttpError(400, `Real-ESRGAN model ${modelId} is not installed at ${UPSCALE_MODELS_DIR}.`);
    throw new HttpError(400, `Unknown upscale model: ${modelId}`);
  }
  const scale = Number(body.scale) || 4;
  if (!opt.scales.includes(scale)) throw new HttpError(400, `Scale must be one of ${opt.scales.join(', ')}.`);
  const source = await withHistory((list) => findRec(list, id));
  if (source.deletedAt) throw new HttpError(400, 'Restore the image from trash before upscaling.');
  if (source.missing) throw new HttpError(400, 'The source file is missing on disk.');
  const srcPath = path.join(OUTPUT_DIR, source.file);
  const srcDims = source.format === 'png' ? pngDimensions(await fsp.readFile(srcPath)) : null;
  const sw = srcDims?.width ?? source.width, sh = srcDims?.height ?? source.height;
  if (sw && sh && Math.max(sw, sh) * scale > UPSCALE_MAX_EDGE) throw new HttpError(400, `Result would be ${sw * scale} × ${sh * scale}; the limit is ${UPSCALE_MAX_EDGE} px per edge.`);

  let buf, durationMs, outFormat = 'png', requestId = null, aiCallId = null, falCost = 0;
  const aiRefs = { recordId: source.id, ...(source.card?.seriesId ? { seriesId: source.card.seriesId } : {}) };
  if (opt.provider === 'fal') {
    const srcBuf = await fsp.readFile(srcPath);
    const contentType = SOURCE_MIME[source.format] || SOURCE_MIME[sniffImage(srcBuf)] || 'application/octet-stream';
    ({ buf, durationMs, requestId, format: outFormat, costUsd: falCost, callId: aiCallId } = await ai.falUpscale({
      refs: aiRefs, opt, srcBuf, fileName: source.file, contentType, scale, expected: { width: sw ? sw * scale : null, height: sh ? sh * scale : null },
    }));
  }
  const ext = outFormat === 'jpeg' ? 'jpg' : outFormat;
  let file = `${baseName(source.file)}-up-x${scale}-${opt.short}.${ext}`;
  for (let i = 2; await exists(path.join(OUTPUT_DIR, file)); i++) file = `${baseName(source.file)}-up-x${scale}-${opt.short}-${i}.${ext}`;
  const dest = path.join(OUTPUT_DIR, file);
  if (opt.provider === 'local') {
    ({ durationMs, callId: aiCallId } = await ai.localUpscale({ refs: aiRefs, bin: UPSCALE_BIN, modelsDir: UPSCALE_MODELS_DIR, src: srcPath, dest, model: opt.id, scale }));
    buf = await fsp.readFile(dest);
  }
  const dims = outFormat === 'png' ? pngDimensions(buf) : null;
  const width = dims?.width ?? (sw ? sw * scale : null), height = dims?.height ?? (sh ? sh * scale : null);
  const costUsd = opt.provider === 'fal' ? falCost : 0;
  const rec = normalize({
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), file, kind: 'upscaled', upscaleOf: source.id, parentId: source.id,
    upscale: {
      tool: opt.provider === 'fal' ? 'fal.ai' : 'realesrgan-ncnn-vulkan', provider: opt.provider, model: opt.id, label: opt.label.split(' — ')[0],
      endpoint: opt.endpoint || null, requestId, scale, sourceFile: source.file, sourceWidth: sw, sourceHeight: sh, durationMs, costUsd,
    },
    originalPrompt: source.originalPrompt, enhancedPrompt: source.enhancedPrompt, enhanceNotes: source.enhanceNotes, prompt: source.prompt,
    characters: source.characters, characterPrompt: source.characterPrompt,
    model: source.model, size: source.size, quality: source.quality, format: outFormat, background: source.background, n: 1, batchId: null,
    width, height, usage: null, costUsd, batchCostUsd: costUsd, durationMs, aiCallId,
    title: source.title ? `${source.title} (upscaled ×${scale})` : '', tags: [...source.tags, 'upscaled'], favorite: false, notes: '',
  });
  buf = embedMetadata(buf, outFormat, rec.prompt, { id: rec.id, originalPrompt: rec.originalPrompt, enhancedPrompt: rec.enhancedPrompt, model: rec.model, size: rec.size, quality: rec.quality, background: rec.background, parentId: rec.parentId, createdAt: rec.createdAt, upscale: rec.upscale });
  await fsp.writeFile(dest, buf);
  await ensureThumb(rec);
  await writeSidecar(rec);
  await withHistory((list) => list.push(rec));
  await appendLog({ type: 'upscale', id: rec.id, sourceId: source.id, file, provider: opt.provider, model: opt.id, scale, width: rec.width, height: rec.height, durationMs, costUsd, requestId });
  return rec;
}

// ---------- characters (reference images for consistency) ----------
let charLock = Promise.resolve();
function withCharacters(fn) {
  const run = charLock.then(async () => {
    await fsp.mkdir(CHARACTERS_DIR, { recursive: true });
    const list = await readJsonFile(CHARACTERS_FILE, []);
    const result = await fn(list);
    await writeJsonAtomic(CHARACTERS_FILE, list);
    return result;
  });
  charLock = run.catch(() => {});
  return run;
}
const readCharacters = () => readJsonFile(CHARACTERS_FILE, []);
const charUrl = (c, r) => `/characters/${encodeURIComponent(c.id)}/${encodeURIComponent(r.file)}`;
function publicCharacter(c) {
  const out = { ...c, refs: c.refs.map((r) => ({ ...r, role: refRole(r), url: charUrl(c, r), thumbUrl: r.thumb ? `/characters/${encodeURIComponent(c.id)}/${encodeURIComponent(r.thumb)}` : charUrl(c, r) })) };
  for (const k of CHAR_FIELDS) out[k] = out[k] || '';
  return out;
}

function makeThumb(src, dest, size) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    execFile('/usr/bin/sips', ['-Z', String(size), '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', src, '--out', dest], { timeout: 30000 }, (err) => resolve(!err));
  });
}
function downscaleCopy(src, dest, maxEdge) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    execFile('/usr/bin/sips', ['-Z', String(maxEdge), '-s', 'format', 'png', src, '--out', dest], { timeout: 60000 }, (err) => resolve(!err));
  });
}

// Copy a reference image into a character folder. Sources: a history record, or an uploaded data URL.
async function addRef(character, ref) {
  const dir = path.join(CHARACTERS_DIR, character.id);
  await fsp.mkdir(dir, { recursive: true });
  const stampId = crypto.randomUUID().slice(0, 8);
  let file, srcInfo;
  if (ref.recordId) {
    const rec = await withHistory((list) => findRec(list, String(ref.recordId)));
    if (rec.missing) throw new HttpError(400, 'That image file is missing on disk.');
    const src = path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, rec.file);
    const st = await fsp.stat(src);
    const ext = path.extname(rec.file).toLowerCase();
    file = `${stampId}-${baseName(rec.file).slice(0, 60)}${ext}`;
    if (st.size > MAX_REF_BYTES || rec.kind === 'upscaled') {
      file = `${stampId}-${baseName(rec.file).slice(0, 60)}.png`;
      if (!(await downscaleCopy(src, path.join(dir, file), 2048))) throw new HttpError(400, 'Image is too large to use as a reference and could not be downscaled.');
    } else await fsp.copyFile(src, path.join(dir, file));
    srcInfo = { source: 'history', recordId: rec.id };
  } else if (ref.dataUrl) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(ref.dataUrl));
    if (!m) throw new HttpError(400, 'Uploads must be PNG, JPEG or WebP.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_REF_BYTES) throw new HttpError(400, `Reference images must be under ${Math.round(MAX_REF_BYTES / 1048576)} MB.`);
    const ext = m[1] === 'jpg' ? 'jpeg' : m[1];
    file = `${stampId}-${slugify(clampStr(ref.filename, 80) || 'upload')}.${ext === 'jpeg' ? 'jpg' : ext}`;
    await fsp.writeFile(path.join(dir, file), buf);
    srcInfo = { source: 'upload', filename: clampStr(ref.filename, 120) || null };
  } else throw new HttpError(400, 'Each reference needs a recordId or a dataUrl.');
  const thumb = `${baseName(file)}.thumb.jpg`;
  const ok = await makeThumb(path.join(dir, file), path.join(dir, thumb), 256);
  character.refs.push({ id: crypto.randomUUID(), file, thumb: ok ? thumb : null, role: REF_ROLES[ref.role] ? ref.role : 'identity', addedAt: new Date().toISOString(), ...srcInfo });
}

async function handleCreateCharacter(body) {
  const name = clampStr(body.name, 80);
  if (!name) throw new HttpError(400, 'Character name is required.');
  const character = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), name, refs: [] };
  for (const k of CHAR_FIELDS) character[k] = clampStr(body[k], k === 'description' ? 1000 : 300);
  for (const ref of (Array.isArray(body.refs) ? body.refs : []).slice(0, MAX_REFS)) await addRef(character, ref);
  await withCharacters((list) => list.push(character));
  await appendLog({ type: 'character_created', id: character.id, name, description: character.description, outfit: character.outfit, palette: character.palette, style: character.style, personality: character.personality, refs: character.refs.length });
  return publicCharacter(character);
}

async function handleUpdateCharacter(id, body) {
  const character = await withCharacters(async (list) => {
    const c = list.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'Character not found.');
    if ('name' in body) { const n = clampStr(body.name, 80); if (!n) throw new HttpError(400, 'Character name is required.'); c.name = n; }
    for (const k of CHAR_FIELDS) if (k in body) c[k] = clampStr(body[k], k === 'description' ? 1000 : 300);
    if (body.refRoles && typeof body.refRoles === 'object') for (const r of c.refs) if (REF_ROLES[body.refRoles[r.id]]) r.role = body.refRoles[r.id];
    if (clampStr(body.primaryRef, 64)) { const i = c.refs.findIndex((r) => r.id === body.primaryRef); if (i > 0) c.refs.unshift(...c.refs.splice(i, 1)); }
    if (Array.isArray(body.removeRefs)) {
      for (const rid of body.removeRefs) {
        const i = c.refs.findIndex((r) => r.id === rid);
        if (i < 0) continue;
        const [r] = c.refs.splice(i, 1);
        await fsp.rm(path.join(CHARACTERS_DIR, c.id, r.file), { force: true });
        if (r.thumb) await fsp.rm(path.join(CHARACTERS_DIR, c.id, r.thumb), { force: true });
      }
    }
    for (const ref of (Array.isArray(body.addRefs) ? body.addRefs : [])) {
      if (c.refs.length >= MAX_REFS) throw new HttpError(400, `A character can have at most ${MAX_REFS} reference images.`);
      await addRef(c, ref);
    }
    c.updatedAt = new Date().toISOString();
    return c;
  });
  await appendLog({ type: 'character_updated', id, name: character.name, refs: character.refs.length });
  return publicCharacter(character);
}

async function handleDeleteCharacter(id) {
  const c = await withCharacters(async (list) => {
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new HttpError(404, 'Character not found.');
    const [c] = list.splice(i, 1);
    await fsp.rm(path.join(CHARACTERS_DIR, c.id), { recursive: true, force: true });
    return c;
  });
  await appendLog({ type: 'character_deleted', id, name: c.name, description: c.description });
  return { deleted: id };
}

async function selectCharacters(ids) {
  const wanted = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  if (!wanted.length) return [];
  const all = await readCharacters();
  const selected = wanted.map((id) => all.find((c) => c.id === id)).filter(Boolean);
  if (!selected.length) throw new HttpError(400, 'Selected characters no longer exist.');
  return selected;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const REF_ROLES = {
  identity: { label: 'Identity (full view)', text: 'identity reference. Use it for the face, head and body shape, proportions, colors, markings and outfit only.' },
  face: { label: 'Face close-up', text: 'face close-up. Use it for the facial features, eye and mouth design and expression style only.' },
  sheet: { label: 'Reference sheet (multi-view)', text: 'character reference sheet with several views. Use it to keep the design correct from every angle.' },
  style: { label: 'Style only (not the character)', text: 'style reference only. Borrow its art style, line quality and rendering; it does not depict the character.' },
};
const CHAR_FIELDS = ['description', 'outfit', 'palette', 'style', 'personality'];
const refRole = (r) => (REF_ROLES[r.role] ? r.role : 'identity');

function identityLine(c) {
  const parts = [];
  if (c.description) parts.push(c.description.replace(/\s+$/, '').replace(/\.?$/, '.'));
  if (c.outfit && !/^(none|n\/a|no outfit)\.?$/i.test(c.outfit.trim())) parts.push(`Outfit: ${c.outfit.replace(/\.?$/, '.')}`);
  if (c.palette) parts.push(`Colors: ${c.palette.replace(/\.?$/, '.')}`);
  if (c.style) parts.push(`Art style: ${c.style.replace(/\.?$/, '.')}`);
  if (c.personality) parts.push(`Personality: ${c.personality.replace(/\.?$/, '.')}`);
  return parts.join(' ');
}

// Build the character block appended to every prompt that uses references. Follows OpenAI's prompting guide:
// assign each input image a numbered role, repeat the defining details in text, separate changes from constraints.
function buildCharacterBlock(selected, startIndex = 1) {
  const refLines = [];
  let i = startIndex;
  for (const c of selected) for (const r of c.refs) refLines.push(`- Image ${i++}: "${c.name}" — ${REF_ROLES[refRole(r)].text} Do not copy its pose, framing, background or any text.`);
  const identity = selected.map((c) => `- "${c.name}": ${identityLine(c) || 'as shown in the reference images.'} Keep the same facial features, head and body shape, proportions, color palette, outfit and art style as the reference images.`);
  const constraints = [
    `- Do not redesign ${selected.length > 1 ? 'any character' : 'the character'}. Change only the scene, pose, expression, action, composition, lighting and framing described above.`,
    '- Use a new pose, framing and background rather than copying the reference images, unless the scene says otherwise.',
    '- Do not reproduce any text, labels or watermarks from the reference images.',
  ];
  if (selected.length > 1) constraints.push('- Keep each character distinct; do not transfer features, colors or clothing between them.');
  return `Reference images:\n${refLines.join('\n')}\n\nCharacter consistency:\n${identity.join('\n')}\n\nConstraints:\n${constraints.join('\n')}`;
}

async function refDataUrl(c, r) {
  const buf = await fsp.readFile(path.join(CHARACTERS_DIR, c.id, r.file)).catch(() => { throw new HttpError(400, `Reference image for "${c.name}" is missing on disk.`); });
  return `data:${MIME_BY_EXT[path.extname(r.file).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`;
}

async function characterPayload(selected) {
  const images = [];
  for (const c of selected) {
    if (!c.refs.length) throw new HttpError(400, `Character "${c.name}" has no reference images.`);
    for (const r of c.refs) {
      if (images.length >= MAX_REFS) throw new HttpError(400, `At most ${MAX_REFS} reference images can be sent per generation.`);
      images.push({ image_url: await refDataUrl(c, r) });
    }
  }
  return { images, block: buildCharacterBlock(selected) };
}
function characterContext(selected) {
  if (!selected.length) return '';
  return `\n\nCharacters (reference images will be attached at generation; refer to them by name, do not describe or change their appearance):\n${selected.map((c) => `- ${c.name}${identityLine(c) ? `: ${identityLine(c)}` : ''}`).join('\n')}`;
}

const DESCRIBE_INSTRUCTIONS = `You describe a character from reference images so it can be reproduced consistently by an image model. Look only at the character (ignore the background and any text). Return a JSON object with these string fields, each concrete and literal, in English:
- description: face, head and body shape, proportions, colors and markings in 1–3 sentences.
- outfit: signature clothing and accessories, or "none".
- palette: 3–5 key colors and where each appears.
- style: the art medium and rendering style (e.g. flat vector cartoon, soft watercolor, 3D render).
- personality: the demeanor or tone in a few words.
Output only the JSON object.`;

async function handleDescribeCharacter(body) {
  if (!API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
  const content = [{ type: 'input_text', text: `Character name: ${clampStr(body.name, 80) || 'unnamed'}. Describe this character.` }];
  let count = 0;
  if (body.characterId) {
    const c = (await readCharacters()).find((x) => x.id === body.characterId);
    if (!c) throw new HttpError(404, 'Character not found.');
    for (const r of c.refs.filter((r) => refRole(r) !== 'style').slice(0, 4)) { content.push({ type: 'input_image', image_url: await refDataUrl(c, r) }); count++; }
  }
  for (const ref of (Array.isArray(body.refs) ? body.refs : []).slice(0, 4)) {
    if (ref.dataUrl && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(ref.dataUrl)) { content.push({ type: 'input_image', image_url: ref.dataUrl }); count++; }
    else if (ref.recordId) {
      const rec = await withHistory((list) => findRec(list, String(ref.recordId)));
      const file = path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, rec.file);
      const buf = await fsp.readFile(file).catch(() => null);
      if (buf && buf.length <= MAX_REF_BYTES) { content.push({ type: 'input_image', image_url: `data:${MIME_BY_EXT[path.extname(rec.file).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}` }); count++; }
    }
  }
  if (!count) throw new HttpError(400, 'Add at least one reference image first.');
  const reply = await ai.text({ feature: 'character_describe', refs: { characterId: body.characterId }, model: ENHANCE_MODEL, instructions: DESCRIBE_INSTRUCTIONS, input: [{ role: 'user', content }], effort: 'low' });
  const text = reply.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new HttpError(502, 'The model did not return valid JSON.'); }
  const out = {};
  for (const k of CHAR_FIELDS) out[k] = clampStr(parsed[k], k === 'description' ? 1000 : 300);
  await appendLog({ type: 'character_described', name: body.name || null, characterId: body.characterId || null, ...out });
  return out;
}

// aiCtx: { feature, refs } from internal callers (books, cards) so the call is attributed to their project.
async function handleCharacterSheet(id, body, aiCtx = {}) {
  if (!API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
  const c = (await readCharacters()).find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'Character not found.');
  const refs = c.refs.filter((r) => refRole(r) !== 'style');
  if (!refs.length) throw new HttpError(400, 'Add at least one identity reference first.');
  const model = IMAGE_MODELS.some((m) => m.id === body.model) ? body.model : 'gpt-image-2.6-sunburst';
  const quality = QUALITIES.includes(body.quality) ? body.quality : 'high';
  const size = '1536x1024';
  const images = [];
  for (const r of refs.slice(0, 6)) images.push({ image_url: await refDataUrl(c, r) });
  const prompt = `Create a character reference sheet (model sheet) for "${c.name}".

Layout:
Top row: a full-body turnaround on one plain white background — front view, three-quarter view, side (profile) view and back view — in the same neutral relaxed pose, evenly spaced, all resting on one shared ground line and drawn at exactly the same scale. Bottom row: four head close-ups with different expressions — happy, surprised, worried, sleepy. The same single design in every view: do not let any view drift into a different character. Consistent flat, even lighting.

Character consistency:
- "${c.name}": ${identityLine(c) || 'exactly as shown in the reference images.'} Keep the same facial features, head and body shape, proportions, color palette, outfit and art style as the reference images in every view.

Constraints:
- Do not redesign the character.
- Plain white background, no scene, no props unless they are part of the outfit.
- No text, labels, arrows, color swatches, logos or watermarks.
- No frames, boxes, borders or panel outlines around the views.`;
  const block = buildCharacterBlock([{ ...c, refs: refs.slice(0, 6) }]);
  const finalPrompt = `${prompt}\n\n${block}`;
  const { status, json, usage, costUsd: cost, durationMs, callId: aiCallId } = await ai.image({
    feature: aiCtx.feature || 'character_sheet', refs: { ...(aiCtx.refs || {}), characterId: c.id },
    body: { model, prompt: finalPrompt, images, size, quality, output_format: 'png', n: 1 },
  });
  if (status !== 200) {
    const message = json.error?.message || `OpenAI error ${status}`;
    await appendLog({ type: 'character_sheet_failed', characterId: c.id, name: c.name, error: message, model, quality });
    throw new HttpError(status >= 400 && status < 600 ? status : 502, message);
  }
  const item = (json.data || [])[0];
  if (!item?.b64_json) throw new HttpError(502, 'OpenAI returned no image data.');
  let buf = Buffer.from(item.b64_json, 'base64');
  const file = `${stamp()}-${slugify(c.name)}-reference-sheet.png`;
  const dims = pngDimensions(buf);
  const rec = normalize({
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), file, kind: 'generated',
    originalPrompt: `Character reference sheet for "${c.name}"`, enhancedPrompt: null, enhanceNotes: null, prompt: finalPrompt,
    characters: [{ id: c.id, name: c.name, refs: refs.length }], characterPrompt: block,
    model, size, quality, format: 'png', background: 'opaque', n: 1, batchId: null, parentId: null, tags: ['character-sheet', slugify(c.name)],
    width: dims?.width ?? 1536, height: dims?.height ?? 1024, usage, costUsd: cost, batchCostUsd: cost, durationMs, aiCallId, title: `${c.name} — reference sheet`,
  });
  buf = embedMetadata(buf, 'png', finalPrompt, { id: rec.id, originalPrompt: rec.originalPrompt, model, size, quality, characters: rec.characters, createdAt: rec.createdAt });
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  await fsp.writeFile(path.join(OUTPUT_DIR, file), buf);
  await ensureThumb(rec);
  await writeSidecar(rec);
  await withHistory((list) => list.push(rec));
  const character = await withCharacters(async (list) => {
    const cc = list.find((x) => x.id === id);
    if (!cc) throw new HttpError(404, 'Character not found.');
    await addRef(cc, { recordId: rec.id, role: 'sheet' });
    cc.updatedAt = new Date().toISOString();
    return cc;
  });
  await appendLog({ type: 'character_sheet', characterId: c.id, name: c.name, recordId: rec.id, file, model, quality, usage, costUsd: cost, durationMs });
  return { record: rec, character: publicCharacter(character) };
}

// ---------- handlers ----------
async function handleEnhance(body) {
  const prompt = clampStr(body.prompt, 20000);
  const notes = clampStr(body.notes, 2000);
  if (!prompt) throw new HttpError(400, 'Prompt is required.');
  if (!API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
  const selected = await selectCharacters(body.characterIds);
  const input = (notes ? `Prompt:\n${prompt}\n\nAdditional guidance from the user:\n${notes}` : `Prompt:\n${prompt}`) + characterContext(selected);
  let reply;
  try { reply = await ai.text({ feature: 'enhance', model: ENHANCE_MODEL, instructions: ENHANCE_INSTRUCTIONS, input, effort: 'low' }); }
  catch (e) { await appendLog({ type: 'enhance_failed', prompt, notes, error: e.message }); throw e; }
  const enhanced = reply.text.trim();
  if (!enhanced) throw new HttpError(502, 'The model returned an empty enhancement.');
  await appendLog({ type: 'enhance', prompt, notes, enhanced, model: ENHANCE_MODEL, usage: reply.usage, costUsd: reply.costUsd, durationMs: reply.durationMs });
  return { enhanced, model: ENHANCE_MODEL, durationMs: reply.durationMs, costUsd: reply.costUsd };
}

// extra.refs: [{ dataUrl, text, label }] reference images appended after the character references (internal callers only);
// extra.meta: fields merged into every record; extra.ai: { feature, refs } attributes the call on the Costs page.
async function handleGenerate(body, extra = {}) {
  const prompt = clampStr(body.prompt, 20000);
  if (!prompt) throw new HttpError(400, 'Prompt is required.');
  if (!API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
  const model = String(body.model || DEFAULT_IMAGE_MODEL);
  if (!IMAGE_MODELS.some((m) => m.id === model)) throw new HttpError(400, `Unknown model: ${model}`);
  const size = String(body.size || '2048x2048');
  validateSize(size);
  const quality = String(body.quality || 'high');
  if (!QUALITIES.includes(quality)) throw new HttpError(400, `Unknown quality: ${quality}`);
  const format = String(body.format || 'png');
  if (!FORMATS.includes(format)) throw new HttpError(400, `Unknown format: ${format}`);
  const background = String(body.background || 'auto');
  if (!BACKGROUNDS.includes(background)) throw new HttpError(400, `Unknown background: ${background}`);
  if (background === 'transparent' && format === 'jpeg') throw new HttpError(400, 'Transparent backgrounds require png or webp.');
  const n = Math.min(4, Math.max(1, Number(body.n) || 1));
  const originalPrompt = clampStr(body.originalPrompt, 20000) || prompt;
  const enhancedPrompt = clampStr(body.enhancedPrompt, 20000) || null;
  const enhanceNotes = clampStr(body.enhanceNotes, 2000) || null;
  const parentId = clampStr(body.parentId, 64) || null;
  const tags = cleanTags(body.tags);

  const selected = await selectCharacters(body.characterIds);
  let finalPrompt = prompt, characterPrompt = null, images = null;
  if (selected.length) {
    const cp = await characterPayload(selected);
    images = cp.images; characterPrompt = cp.block;
    finalPrompt = `${prompt}\n\n${characterPrompt}`;
  }
  const characters = selected.map((c) => ({ id: c.id, name: c.name, refs: c.refs.length }));
  const extraRefs = Array.isArray(extra.refs) ? extra.refs : [];
  if (extraRefs.length) {
    images = images || [];
    if (images.length + extraRefs.length > MAX_REFS) throw new HttpError(400, `At most ${MAX_REFS} reference images can be sent per generation.`);
    const start = images.length + 1;
    for (const r of extraRefs) images.push({ image_url: r.dataUrl });
    finalPrompt += `\n\n${selected.length ? 'Additional reference images' : 'Reference images'}:\n${extraRefs.map((r, i) => `- Image ${start + i}: ${r.text}`).join('\n')}`;
  }
  const meta = { ...(extra.meta || {}), ...(extraRefs.length ? { styleRefs: extraRefs.map((r) => r.label) } : {}) };

  const payload = { model, prompt: finalPrompt, size, quality, output_format: format, n };
  if (images) payload.images = images;
  if (background !== 'auto') payload.background = background;
  if (format !== 'png' && body.compression != null) payload.output_compression = Math.min(100, Math.max(0, Number(body.compression)));

  const { status, json, usage, costUsd: batchCost, durationMs, callId: aiCallId } = await ai.image({
    feature: extra.ai?.feature || 'generate', refs: { ...(extra.ai?.refs || {}), ...(parentId ? { parentId } : {}) }, body: payload,
  });
  if (status !== 200) {
    const message = json.error?.message || `OpenAI error ${status}`;
    await appendLog({ type: 'generate_failed', originalPrompt, enhancedPrompt, prompt: finalPrompt, model, size, quality, format, background, n, parentId, characters, error: message, durationMs });
    throw new HttpError(status >= 400 && status < 600 ? status : 502, message);
  }
  const ext = format === 'jpeg' ? 'jpg' : format;
  const base = `${stamp()}-${slugify(originalPrompt)}`;
  const batchId = crypto.randomUUID();
  const records = [];
  await fsp.mkdir(OUTPUT_DIR, { recursive: true });
  const data = json.data || [];
  for (let i = 0; i < data.length; i++) {
    if (!data[i].b64_json) continue;
    let buf = Buffer.from(data[i].b64_json, 'base64');
    const suffix = data.length > 1 ? `-${i + 1}` : '';
    const file = `${base}${suffix}.${ext}`;
    const dims = format === 'png' ? pngDimensions(buf) : null;
    const rec = normalize({
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), file, kind: 'generated',
      originalPrompt, enhancedPrompt, enhanceNotes, prompt: finalPrompt, characters, characterPrompt,
      model, size, quality, format, background, n, batchId, parentId, tags,
      width: dims?.width ?? (size === 'auto' ? null : Number(size.split('x')[0])),
      height: dims?.height ?? (size === 'auto' ? null : Number(size.split('x')[1])),
      usage, costUsd: batchCost == null ? null : +(batchCost / data.length).toFixed(4), batchCostUsd: batchCost, durationMs, aiCallId, ...meta,
    });
    buf = embedMetadata(buf, format, finalPrompt, { id: rec.id, originalPrompt, enhancedPrompt, model, size, quality, background, parentId, characters, createdAt: rec.createdAt });
    await fsp.writeFile(path.join(OUTPUT_DIR, file), buf);
    await ensureThumb(rec);
    await writeSidecar(rec);
    records.push(rec);
  }
  if (!records.length) throw new HttpError(502, 'OpenAI returned no image data.');
  await withHistory((list) => list.push(...records));
  await appendLog({ type: 'generate', ids: records.map((r) => r.id), files: records.map((r) => r.file), originalPrompt, enhancedPrompt, prompt: finalPrompt, model, size, quality, format, background, n, parentId, characters, usage, batchCostUsd: batchCost, durationMs });
  return { images: records, usage, batchCostUsd: batchCost, durationMs };
}

async function handleUpdate(id, body) {
  const rec = await withHistory(async (list) => {
    const rec = findRec(list, id);
    if ('title' in body) rec.title = clampStr(body.title, 120);
    if ('notes' in body) rec.notes = clampStr(body.notes, 4000);
    if ('tags' in body) rec.tags = cleanTags(body.tags);
    if ('favorite' in body) rec.favorite = Boolean(body.favorite);
    rec.updatedAt = new Date().toISOString();
    if (!rec.missing) await writeSidecar(rec);
    return rec;
  });
  await appendLog({ type: 'update', id, title: rec.title, tags: rec.tags, favorite: rec.favorite, notes: rec.notes });
  return rec;
}

async function moveRecord(rec, toTrash) {
  const fromDir = toTrash ? OUTPUT_DIR : TRASH_DIR, toDir = toTrash ? TRASH_DIR : OUTPUT_DIR;
  await fsp.mkdir(toDir, { recursive: true });
  const oldSidecar = sidecarPath(rec);
  if (!rec.missing) await fsp.rename(path.join(fromDir, rec.file), path.join(toDir, rec.file)).catch(() => { rec.missing = true; });
  await fsp.rm(oldSidecar, { force: true });
  rec.deletedAt = toTrash ? new Date().toISOString() : null;
  normalize(rec);
  if (!rec.missing) await writeSidecar(rec);
}

async function handleTrash(id) {
  const rec = await withHistory(async (list) => {
    const rec = findRec(list, id);
    if (rec.deletedAt) throw new HttpError(400, 'Already in trash.');
    await moveRecord(rec, true);
    return rec;
  });
  await appendLog({ type: 'trash', id, file: rec.file, prompt: rec.prompt, originalPrompt: rec.originalPrompt });
  return rec;
}

async function handleRestore(id) {
  const rec = await withHistory(async (list) => {
    const rec = findRec(list, id);
    if (!rec.deletedAt) throw new HttpError(400, 'Not in trash.');
    await moveRecord(rec, false);
    return rec;
  });
  await appendLog({ type: 'restore', id, file: rec.file });
  return rec;
}

async function handlePurge(id) {
  const rec = await withHistory(async (list) => {
    const rec = findRec(list, id);
    if (!rec.deletedAt) throw new HttpError(400, 'Only trashed images can be permanently deleted.');
    await fsp.rm(path.join(TRASH_DIR, rec.file), { force: true });
    await fsp.rm(sidecarPath(rec), { force: true });
    await fsp.rm(path.join(THUMBS_DIR, `${baseName(rec.file)}.jpg`), { force: true });
    list.splice(list.indexOf(rec), 1);
    return rec;
  });
  await appendLog({ type: 'purge', id, file: rec.file, prompt: rec.prompt, originalPrompt: rec.originalPrompt, enhancedPrompt: rec.enhancedPrompt });
  return rec;
}

function handleReveal(id) {
  if (process.platform !== 'darwin') throw new HttpError(400, 'Reveal in Finder is only available on macOS.');
  return withHistory(async (list) => {
    const rec = findRec(list, id);
    const file = path.join(rec.deletedAt ? TRASH_DIR : OUTPUT_DIR, rec.file);
    if (!(await exists(file))) throw new HttpError(404, 'File is missing on disk.');
    execFile('/usr/bin/open', ['-R', file]);
    return { revealed: file };
  });
}

function csvEscape(v) {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function exportCsv() {
  const cols = ['id', 'createdAt', 'kind', 'file', 'width', 'height', 'title', 'favorite', 'tags', 'model', 'size', 'quality', 'format', 'background', 'costUsd', 'durationMs', 'parentId', 'upscaleOf', 'upscaleModel', 'upscaleScale', 'characters', 'deletedAt', 'originalPrompt', 'enhancedPrompt', 'prompt', 'enhanceNotes', 'notes'];
  const list = (await readHistory()).map((r) => ({ ...r, upscaleModel: r.upscale?.model, upscaleScale: r.upscale?.scale, characters: r.characters.map((c) => c.name) }));
  return [cols.join(','), ...list.map((r) => cols.map((c) => csvEscape(r[c])).join(','))].join('\r\n');
}

// prompt library
let promptLock = Promise.resolve();
function withPrompts(fn) {
  const run = promptLock.then(async () => {
    const list = await readJsonFile(PROMPTS_FILE, []);
    const result = await fn(list);
    await writeJsonAtomic(PROMPTS_FILE, list);
    return result;
  });
  promptLock = run.catch(() => {});
  return run;
}
async function handleSavePrompt(body) {
  const original = clampStr(body.original, 20000);
  if (!original) throw new HttpError(400, 'Prompt is required.');
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), name: clampStr(body.name, 120) || original.slice(0, 60), original, enhanced: clampStr(body.enhanced, 20000) || null, notes: clampStr(body.notes, 2000) || null };
  await withPrompts((list) => list.push(entry));
  await appendLog({ type: 'prompt_saved', ...entry });
  return entry;
}

// ---------- AI calls & costs ----------
// Titles of the books and card series that calls are attributed to (a deleted project keeps its id).
async function projectTitles() {
  const out = {};
  for (const [dir, kind] of [[path.join(OUTPUT_DIR, 'books'), 'Story book'], [path.join(OUTPUT_DIR, 'cards', 'series'), 'Card series']]) {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.json')) continue;
      const j = await readJsonFile(path.join(dir, f), null);
      if (j?.id) out[j.id] = { kind, title: j.title || clampStr(j.brief?.premise, 60) || 'Untitled' };
    }
  }
  return out;
}
async function handleAiCalls() {
  const calls = (await ai.readCalls()).reverse();
  const characters = Object.fromEntries((await readCharacters()).map((c) => [c.id, c.name]));
  return { calls, projects: await projectTitles(), characters, pricing: PRICING, ledgerFile: ai.ledgerFile };
}
async function handleAiCall(id) {
  const found = await ai.readCall(id);
  if (!found) throw new HttpError(404, 'Call not found.');
  const ids = new Set(found.entry.recordIds || []);
  const records = (await readHistory()).filter((r) => r.aiCallId === id || ids.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, file: r.file, url: r.url, thumbUrl: r.thumbUrl, deletedAt: r.deletedAt, missing: r.missing, width: r.width, height: r.height, costUsd: r.costUsd }));
  return { ...found, records };
}

// ---------- browser safety ----------
// The app has no login, so a request is only served when it comes from the app's own pages.
// 1. Host must be localhost, an IP address, or listed in ALLOWED_HOSTS: a hostile site cannot point its own
//    domain name at this server (DNS rebinding).
// 2. A request that carries an Origin (every cross-site POST/PATCH/DELETE does) must come from this same host:
//    another website cannot start generations or delete images in the background (CSRF).
const ALLOWED_HOSTS = new Set(['localhost', ...String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)]);
const hostName = (hostPort) => { try { return new URL(`http://${hostPort}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };
function checkRequestSource(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const name = hostName(host);
  if (!name || !(net.isIP(name) || ALLOWED_HOSTS.has(name))) throw new HttpError(403, 'Host not allowed. Open the app by IP address or localhost, or add this hostname to ALLOWED_HOSTS in .env.');
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let originHost = '';
  try { originHost = new URL(origin).host.toLowerCase(); } catch { /* "null" or malformed */ }
  if (originHost !== host) throw new HttpError(403, 'Cross-site request refused.');
}

// ---------- router ----------
async function route(req, res) {
  checkRequestSource(req);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const seg = (prefix) => (p.startsWith(prefix) ? decodeURIComponent(p.slice(prefix.length)) : null);

  if (req.method === 'GET' && p === '/api/config') return send(res, 200, getConfig());
  if (req.method === 'GET' && p === '/api/history') return send(res, 200, (await readHistory()).reverse());
  if (req.method === 'GET' && p === '/api/history/export.json') return send(res, 200, JSON.stringify(await readHistory(), null, 2), { 'Content-Disposition': 'attachment; filename="dadventures-history.json"' });
  if (req.method === 'GET' && p === '/api/history/export.csv') return send(res, 200, '﻿' + await exportCsv(), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="dadventures-history.csv"' });
  if (req.method === 'GET' && p === '/api/log') {
    const text = await fsp.readFile(LOG_FILE, 'utf8').catch(() => '');
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const lines = text.trim().split('\n').filter(Boolean).slice(-limit).reverse();
    return send(res, 200, lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
  }
  if (req.method === 'GET' && p === '/api/ai/calls') return send(res, 200, await handleAiCalls());
  if (req.method === 'GET' && p === '/api/ai/summary') { const calls = await ai.readCalls(); return send(res, 200, { calls: calls.length, totalUsd: +calls.reduce((sum, c) => sum + (c.costUsd || 0), 0).toFixed(4) }); }
  if (req.method === 'GET' && seg('/api/ai/calls/')) return send(res, 200, await handleAiCall(seg('/api/ai/calls/')));
  if (req.method === 'POST' && p === '/api/history/reindex') return send(res, 200, await reconcile());
  if (req.method === 'POST' && p === '/api/enhance') return send(res, 200, await handleEnhance(await readJson(req)));
  if (req.method === 'POST' && p === '/api/generate') return send(res, 200, await handleGenerate(await readJson(req)));
  if (req.method === 'GET' && p === '/api/prompts') return send(res, 200, (await readJsonFile(PROMPTS_FILE, [])).reverse());
  if (req.method === 'POST' && p === '/api/prompts') return send(res, 200, await handleSavePrompt(await readJson(req)));
  if (req.method === 'DELETE' && seg('/api/prompts/')) {
    const id = seg('/api/prompts/');
    await withPrompts((list) => { const i = list.findIndex((x) => x.id === id); if (i < 0) throw new HttpError(404, 'Not found.'); list.splice(i, 1); });
    return send(res, 200, { deleted: id });
  }
  if (seg('/api/history/')) {
    const rest = seg('/api/history/');
    const [id, action] = rest.split('/');
    if (req.method === 'PATCH' && !action) return send(res, 200, await handleUpdate(id, await readJson(req)));
    if (req.method === 'DELETE' && !action) return send(res, 200, await handleTrash(id));
    if (req.method === 'DELETE' && action === 'permanent') return send(res, 200, { deleted: (await handlePurge(id)).id });
    if (req.method === 'POST' && action === 'restore') return send(res, 200, await handleRestore(id));
    if (req.method === 'POST' && action === 'reveal') return send(res, 200, await handleReveal(id));
    if (req.method === 'POST' && action === 'upscale') return send(res, 200, await handleUpscale(id, await readJson(req)));
  }
  if (req.method === 'GET' && p === '/api/characters') return send(res, 200, (await readCharacters()).map(publicCharacter));
  if (req.method === 'POST' && p === '/api/characters') return send(res, 200, await handleCreateCharacter(await readJson(req, 200 << 20)));
  if (req.method === 'POST' && p === '/api/characters/describe') return send(res, 200, await handleDescribeCharacter(await readJson(req, 200 << 20)));
  if (req.method === 'POST' && p === '/api/characters/block') {
    const selected = await selectCharacters((await readJson(req)).characterIds);
    return send(res, 200, { block: selected.length ? buildCharacterBlock(selected) : '', images: selected.reduce((n, c) => n + c.refs.length, 0) });
  }
  if (seg('/api/characters/')) {
    const [id, action] = seg('/api/characters/').split('/');
    if (req.method === 'PATCH' && !action) return send(res, 200, await handleUpdateCharacter(id, await readJson(req, 200 << 20)));
    if (req.method === 'DELETE' && !action) return send(res, 200, await handleDeleteCharacter(id));
    if (req.method === 'POST' && action === 'sheet') return send(res, 200, await handleCharacterSheet(id, await readJson(req)));
  }
  if (p.startsWith('/api/books') && await books.route(req, res, url, readHistory)) return;
  if (p.startsWith('/api/sheets') && await sheets.route(req, res, url)) return;
  if (p.startsWith('/api/cards') && await cards.route(req, res, url)) return;
  if (req.method === 'GET' && seg('/sheet-src/')) {
    const [sourceId, ...rest] = seg('/sheet-src/').split('/');
    const { dir, rel } = sheets.sourceFile(sourceId, rest.join('/'));
    return serveFile(res, dir, rel, false);
  }
  if (req.method === 'GET' && seg('/characters/')) return serveFile(res, CHARACTERS_DIR, seg('/characters/'), false);
  if (req.method === 'GET' && seg('/output/')) return serveFile(res, OUTPUT_DIR, seg('/output/'), true);
  if (req.method === 'GET' && seg('/trash/')) return serveFile(res, TRASH_DIR, seg('/trash/'), true);
  if (req.method === 'GET' && seg('/thumbs/')) return serveFile(res, THUMBS_DIR, seg('/thumbs/'), true);
  if (req.method === 'GET') return serveFile(res, PUBLIC_DIR, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)), false);
  throw new HttpError(404, 'Not found.');
}

const books = createBooks({
  OUTPUT_DIR, BOOK_MODEL, API_KEY, ai, HttpError, responseText, readJson, send, clampStr, slugify, appendLog,
  readJsonFile, writeJsonAtomic, readCharacters, handleGenerate, handleUpdate, handleCreateCharacter, publicCharacter, identityLine, validateSize,
  IMAGE_MODELS, QUALITIES, handleCharacterSheet,
  characterBible: (...args) => cards.characterBible(...args),
  recordFile: async (id) => { const rec = (await readHistory()).find((r) => r.id === id); return rec && !rec.deletedAt && !rec.missing ? path.join(OUTPUT_DIR, rec.file) : null; },
});

const sheets = createSheets({ ROOT, OUTPUT_DIR, THUMBS_DIR, HttpError, send, readJson, slugify, clampStr, appendLog, readJsonFile, writeJsonAtomic });

const cards = createCards({
  OUTPUT_DIR, CARD_MODEL, CARD_VISION_MODEL, API_KEY, ai, HttpError, responseText, readJson, send, clampStr, slugify, appendLog,
  readJsonFile, writeJsonAtomic, readCharacters, handleGenerate, handleUpdate, handleCreateCharacter, handleCharacterSheet, identityLine, validateSize, IMAGE_MODELS, QUALITIES,
  listImages: sheets.listImages, resolveImage: sheets.resolveImage, handleUpdateCharacter,
  // Attach non-reference data (the written profile and the bible poster) to a studio character.
  setCharacterBible: (id, bible) => withCharacters((list) => { const c = list.find((x) => x.id === id); if (c) { c.bible = bible; c.updatedAt = new Date().toISOString(); } return c; }),
  // Absolute path of a live history image, or null.
  recordFile: async (id) => { const rec = (await readHistory()).find((r) => r.id === id); return rec && !rec.deletedAt && !rec.missing ? path.join(OUTPUT_DIR, rec.file) : null; },
});

const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
  route(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message || 'Internal error' });
    else res.end();
  });
});
server.keepAliveTimeout = 65000;

await fsp.mkdir(OUTPUT_DIR, { recursive: true });
await detectUpscaler();
const summary = await reconcile();
const backfilled = await ai.backfill({ logFile: LOG_FILE, readHistory });
server.listen(PORT, HOST, () => {
  console.log(`Dadventures → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Output: ${OUTPUT_DIR}  (history: ${summary.total} images, ${summary.added} recovered from sidecars, ${summary.missing} missing files)`);
  console.log(localModels.length ? `Real-ESRGAN: ${UPSCALE_BIN} (${localModels.map((m) => m.id).join(', ')})` : (UPSCALE_BIN ? `Real-ESRGAN: not found at ${UPSCALE_BIN} — local upscaling disabled` : 'Real-ESRGAN: REALESRGAN_BIN not set — local upscaling disabled'));
  console.log(`Print Sheets: sources ${sheets.config().sources.map((s) => `${s.id}=${s.dir}`).join(', ')}`);
  console.log(FAL_KEY ? `fal.ai: enabled (${UPSCALE_OPTIONS.filter((m) => m.provider === 'fal').map((m) => m.short).join(', ')})` : 'fal.ai: FAL_KEY not set — cloud upscaling disabled');
  console.log(`AI calls: ${ai.ledgerFile}${backfilled.skipped ? '' : ` (imported ${backfilled.imported} earlier calls from the prompt log)`}`);
  if (!API_KEY) console.warn('WARNING: OPENAI_API_KEY is not set. Copy .env.example to .env and add your key.');
});
