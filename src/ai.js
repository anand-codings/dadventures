// AI gateway — the one place every model call goes through: OpenAI text (Responses API), OpenAI images
// (generations / edits), fal.ai cloud upscaling and local Real-ESRGAN.
//
// Every call, successful or not, is written to a ledger so input, output, tokens and cost can be monitored:
//   output/ai-calls.jsonl        one line per call: who asked (feature + refs), model, tokens, cost, duration, previews
//   output/ai-calls/<id>.json    the full request and response (images are replaced by a short placeholder)
// The Costs page (/costs.html) reads both through /api/ai/calls.
//
// Nothing else in the app should talk to api.openai.com, fal or the upscaler binary directly.
import https from 'node:https';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

// ---------- pricing ----------
// USD per 1M tokens, OpenAI standard tier. Source: https://developers.openai.com/api/docs/pricing (checked 2026-11-09).
// A model that is not listed is still logged, with costUsd null ("unpriced" on the Costs page) — add its rates here.
const IMAGE_RATES = { textIn: 5, cachedTextIn: 1.25, imageIn: 8, cachedImageIn: 2, imageOut: 30 };
export const PRICING = {
  text: {
    // Over 272K input tokens the whole request is billed at 2x input / 1.5x output.
    'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50, long: { over: 272000, inputX: 2, outputX: 1.5 } },
    'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
  image: {
    'gpt-image-2.6-flare': IMAGE_RATES, 'gpt-image-2.6-sunburst': IMAGE_RATES,
    'gpt-image-2.5-flare': IMAGE_RATES, 'gpt-image-2.5-sunburst': IMAGE_RATES,
  },
  // Speech is billed by audio length; the API returns no usage, so the cost is an estimate from the length of the result.
  speech: { 'gpt-4o-mini-tts': { perMinute: 0.015 } },
  checked: '2026-11-09', source: 'https://developers.openai.com/api/docs/pricing',
};
// Shape the browser config has always exposed for image token rates.
export const IMAGE_PRICE = { imageOut: IMAGE_RATES.imageOut, textIn: IMAGE_RATES.textIn, imageIn: IMAGE_RATES.imageIn, cachedText: IMAGE_RATES.cachedTextIn, cachedImage: IMAGE_RATES.cachedImageIn };

// Exact id first, then the longest listed id the model starts with (dated snapshots such as gpt-6-astra-2026-09-01).
function ratesFor(kind, model) {
  const table = PRICING[kind] || {};
  if (table[model]) return table[model];
  const key = Object.keys(table).filter((k) => String(model).startsWith(`${k}-`)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : null;
}

// Token counts in one flat shape, whatever the endpoint returned.
export function tokensOf(kind, usage) {
  if (!usage) return null;
  const d = usage.input_tokens_details || {}, o = usage.output_tokens_details || {};
  const t = { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cachedInput: d.cached_tokens ?? 0, cacheWrite: d.cache_write_tokens ?? 0, reasoning: o.reasoning_tokens ?? 0 };
  if (kind === 'image') { t.textInput = d.text_tokens ?? t.input; t.imageInput = d.image_tokens ?? 0; }
  return t;
}

// → { costUsd, rates } ; costUsd is null when there is no usage or the model has no listed price.
export function priceUsage(kind, model, usage) {
  const r = ratesFor(kind, model);
  const t = tokensOf(kind, usage);
  if (!r || !t) return { costUsd: null, rates: r || null };
  let usd;
  if (kind === 'image') {
    usd = (t.output * r.imageOut + t.textInput * r.textIn + t.imageInput * r.imageIn) / 1e6;
    return { costUsd: +usd.toFixed(4), rates: r };
  }
  const fresh = Math.max(0, t.input - t.cachedInput - t.cacheWrite);
  const long = r.long && t.input > r.long.over ? r.long : { inputX: 1, outputX: 1 };
  usd = (long.inputX * (fresh * r.input + t.cachedInput * (r.cachedInput ?? r.input) + t.cacheWrite * (r.cacheWrite ?? r.input)) + long.outputX * t.output * r.output) / 1e6;
  return { costUsd: +usd.toFixed(6), rates: r };
}

// Estimated USD for a cloud upscale from the output size: `perMp` (per output megapixel) or `perBlock`/`blockMp`.
export function estimateUpscaleCost(price, width, height) {
  if (!price || !width || !height) return 0;
  const mp = (width * height) / 1e6;
  if (price.perMp) return +(mp * price.perMp).toFixed(4);
  return +(Math.ceil(mp / price.blockMp) * price.perBlock).toFixed(4);
}

export function sniffImage(buf) {
  if (buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function responseText(json) {
  if (typeof json.output_text === 'string') return json.output_text;
  const parts = [];
  for (const item of json.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) if (c.type === 'output_text') parts.push(c.text);
  }
  return parts.join('\n').trim();
}

// ---------- helpers for the ledger ----------
const PREVIEW = 400;
const clip = (s, n = PREVIEW) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };

// Deep copy with every inline image (data: URL) replaced by a placeholder, so payload files stay small. Returns [copy, imageCount].
function redact(value) {
  let images = 0;
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = v.length > 64 && /^data:([\w/+.-]+);base64,/.exec(v.slice(0, 80));
      if (!m) return v;
      images++;
      return `[${m[1]}, ${Math.max(1, Math.round((v.length - m[0].length) * 0.75 / 1024))} KB — not stored]`;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return [walk(value), images];
}

// The human-written part of a Responses `input` (string, or messages with input_text parts).
function inputText(input) {
  if (typeof input === 'string') return input;
  const parts = [];
  for (const m of Array.isArray(input) ? input : []) {
    if (typeof m.content === 'string') parts.push(m.content);
    else for (const c of m.content || []) if (c.type === 'input_text' && c.text) parts.push(c.text);
  }
  return parts.join('\n');
}

// Only short scalar ids travel in `refs` (bookId, seriesId, characterId, imageId, recordId …).
function cleanRefs(refs) {
  const out = {};
  for (const [k, v] of Object.entries(refs || {})) if ((typeof v === 'string' || typeof v === 'number') && String(v).length <= 120) out[k] = v;
  return out;
}

export function createAi({ OUTPUT_DIR, OPENAI_API_KEY = '', FAL_KEY = '', HttpError }) {
  const LEDGER = path.join(OUTPUT_DIR, 'ai-calls.jsonl');
  const CALLS_DIR = path.join(OUTPUT_DIR, 'ai-calls');
  const FAL_QUEUE_URL = 'https://queue.fal.run';
  const FAL_REST_URL = 'https://rest.alpha.fal.ai';
  const FAL_POLL_MS = 2000;
  const FAL_TIMEOUT_MS = 20 * 60 * 1000;
  const httpStatus = (s) => (s >= 400 && s < 600 ? s : 502);

  // ---------- ledger ----------
  // Recording never throws: a full disk must not turn a paid, successful call into an error.
  async function record(entry, payload) {
    try {
      await fsp.mkdir(CALLS_DIR, { recursive: true });
      if (payload) await fsp.writeFile(path.join(CALLS_DIR, `${entry.id}.json`), JSON.stringify({ id: entry.id, ...payload }, null, 2));
      await fsp.appendFile(LEDGER, JSON.stringify(entry) + '\n');
    } catch (e) { console.error('ai ledger write failed', e); }
    return entry;
  }
  const begin = (provider, kind, { feature, refs, model, endpoint }) => ({
    id: crypto.randomUUID(), ts: new Date().toISOString(), provider, kind, endpoint, model: model || null,
    feature: feature || 'unknown', refs: cleanRefs(refs), t0: Date.now(),
  });
  function finish(call, { ok, status = null, error = null, usage = null, costUsd, estimated = false, rates = null, inputPreview = '', outputPreview = '', imagesIn = 0, imagesOut = 0, extra = {} }) {
    const { t0, ...head } = call;
    return { ...head, ok, status, error: error ? clip(error, 600) : null, durationMs: Date.now() - t0, usage, tokens: tokensOf(call.kind, usage), costUsd, estimated, rates, imagesIn, imagesOut, inputPreview: clip(inputPreview), outputPreview: clip(outputPreview), ...extra };
  }

  async function readCalls() {
    const text = await fsp.readFile(LEDGER, 'utf8').catch(() => '');
    const out = [];
    for (const line of text.split('\n')) { if (!line) continue; try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ } }
    return out;
  }
  async function readCall(id) {
    if (!/^[a-z0-9-]{8,80}$/i.test(id || '')) return null;
    const entry = (await readCalls()).find((c) => c.id === id);
    if (!entry) return null;
    let payload = null;
    try { payload = JSON.parse(await fsp.readFile(path.join(CALLS_DIR, `${id}.json`), 'utf8')); } catch { /* backfilled calls have none */ }
    return { entry, payload };
  }

  // ---------- OpenAI text (Responses API, streamed) ----------
  // { feature, refs, model, instructions, input, effort, schema, schemaName } → { text, parsed, usage, costUsd, durationMs, callId }
  // With `schema` the reply is strict JSON and comes back parsed. onText receives the text so far, for progress.
  // Throws HttpError after recording the failure. Tokens already billed are costed even when the call fails.
  async function text({ feature, refs, model, instructions, input, effort = 'low', schema = null, schemaName = null }, onText = () => {}) {
    if (!OPENAI_API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
    const call = begin('openai', 'text', { feature, refs, model, endpoint: '/v1/responses' });
    const body = { model, instructions, input, reasoning: { effort }, stream: true };
    if (schema) body.text = { format: { type: 'json_schema', name: schemaName || feature || 'result', schema, strict: true } };
    const [request, imagesIn] = redact(body);
    let out = '', usage = null;
    const done = (ok, status, error) => {
      const { costUsd, rates } = priceUsage('text', model, usage);
      return record(finish(call, { ok, status, error, usage, costUsd: usage ? costUsd : (ok ? null : 0), rates, imagesIn, inputPreview: inputText(input), outputPreview: out, extra: { effort } }),
        { request, response: { text: out, usage, error: error || null } });
    };
    const fail = async (message, status = 502) => { await done(false, status, message); throw new HttpError(httpStatus(status), message); };
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (e) { return fail(`OpenAI: network error — ${e.message}`); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); return fail(j.error?.message || `OpenAI error ${res.status}`, res.status); }
    let buf = '', stopped = null;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          if (ev.type === 'response.output_text.delta') { out += ev.delta; onText(out); }
          else if (ev.type === 'response.completed') { usage = ev.response?.usage || null; if (!out) out = responseText(ev.response || {}); }
          else if (ev.type === 'response.failed' || ev.type === 'response.incomplete' || ev.type === 'error') {
            usage = ev.response?.usage || usage;
            stopped = ev.response?.error?.message || ev.error?.message || ev.message || `The model stopped early (${ev.response?.incomplete_details?.reason || 'unknown reason'}).`;
          }
        }
        if (stopped) break;
      }
    } catch (e) { return fail(`OpenAI: the response stream broke — ${e.message}`); }
    if (stopped) return fail(stopped);
    let parsed = null;
    if (schema) { try { parsed = JSON.parse(out); } catch { return fail('The model did not return valid JSON.'); } }
    const entry = await done(true, 200, null);
    return { text: out, parsed, usage, costUsd: entry.costUsd, durationMs: entry.durationMs, callId: entry.id };
  }

  // ---------- OpenAI images ----------
  // body is the Images API payload; with body.images it is an edit (reference images), otherwise a generation.
  // → { status, json, usage, costUsd, durationMs, callId }. A non-200 is returned (and recorded), not thrown, so callers
  // can log their own context. Uses node:https rather than fetch: high-quality images can take longer than fetch's
  // five-minute header timeout.
  async function image({ feature, refs, body }) {
    if (!OPENAI_API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
    const endpoint = body.images ? '/v1/images/edits' : '/v1/images/generations';
    const call = begin('openai', 'image', { feature, refs, model: body.model, endpoint });
    const [request, imagesIn] = redact(body);
    const settings = { size: body.size || null, quality: body.quality || null, n: body.n || 1 };
    let status, json;
    try {
      ({ status, json } = await new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request({
          hostname: 'api.openai.com', path: endpoint, method: 'POST',
          headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed;
            try { parsed = JSON.parse(raw); } catch { parsed = { error: { message: raw.slice(0, 500) || `HTTP ${res.statusCode}` } }; }
            resolve({ status: res.statusCode, json: parsed });
          });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
      }));
    } catch (e) {
      await record(finish(call, { ok: false, error: `network error — ${e.message}`, costUsd: 0, imagesIn, inputPreview: body.prompt, extra: settings }), { request, response: { error: e.message } });
      throw e;
    }
    const ok = status === 200;
    const usage = json.usage || null;
    const { costUsd, rates } = priceUsage('image', body.model, usage);
    const outputs = (json.data || []).filter((d) => d.b64_json).map((d) => ({ bytes: Math.floor(d.b64_json.length * 0.75), revisedPrompt: d.revised_prompt || null }));
    const error = ok ? null : json.error?.message || `OpenAI error ${status}`;
    const entry = await record(
      finish(call, { ok, status, error, usage, costUsd: usage ? costUsd : (ok ? null : 0), rates, imagesIn, imagesOut: outputs.length, inputPreview: body.prompt, outputPreview: ok ? `${outputs.length} image${outputs.length === 1 ? '' : 's'}` : '', extra: settings }),
      { request, response: { images: outputs, usage, error } });
    return { status, json, usage, costUsd: entry.costUsd, durationMs: entry.durationMs, callId: entry.id };
  }

  // ---------- OpenAI speech ----------
  // { feature, refs, model, voice, input, instructions } → { buffer (mp3), seconds, costUsd (estimate), durationMs, callId }
  async function speech({ feature, refs, model = 'gpt-4o-mini-tts', voice = 'coral', input, instructions = '' }) {
    if (!OPENAI_API_KEY) throw new HttpError(500, 'OPENAI_API_KEY is not set.');
    const call = begin('openai', 'speech', { feature, refs, model, endpoint: '/v1/audio/speech' });
    const body = { model, voice, input, response_format: 'mp3', ...(instructions ? { instructions } : {}) };
    let res, buffer = null, error = null;
    try {
      res = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) buffer = Buffer.from(await res.arrayBuffer());
      else error = (await res.json().catch(() => ({}))).error?.message || `OpenAI error ${res.status}`;
    } catch (e) {
      await record(finish(call, { ok: false, error: `network error — ${e.message}`, costUsd: 0, inputPreview: input, extra: { voice } }), { request: body, response: { error: e.message } });
      throw e;
    }
    // Length from the file size: the mp3 comes back at a constant 128 kbit/s (16,000 bytes a second).
    const seconds = buffer ? Math.max(1, Math.round(buffer.length / 16000)) : 0;
    const rate = PRICING.speech[model]?.perMinute;
    const entry = await record(finish(call, { ok: Boolean(buffer), status: res.status, error, costUsd: buffer ? (rate == null ? null : (seconds / 60) * rate) : 0, estimated: true, rates: rate == null ? null : { perMinute: rate }, inputPreview: input, outputPreview: buffer ? `${Math.round(buffer.length / 1024)} KB mp3, about ${seconds} s` : '', extra: { voice } }),
      { request: body, response: { bytes: buffer?.length || 0, error } });
    if (!buffer) throw new HttpError(httpStatus(res.status), error);
    return { buffer, seconds, costUsd: entry.costUsd, durationMs: entry.durationMs, callId: entry.id };
  }

  // ---------- fal.ai (queue API, no SDK) ----------
  async function falFetch(url, init = {}, label = 'fal') {
    let res;
    try { res = await fetch(url, { ...init, headers: { Authorization: `Key ${FAL_KEY}`, ...(init.headers || {}) } }); }
    catch (e) { throw new HttpError(502, `${label}: network error — ${e.message}`); }
    if (res.ok) return res;
    const raw = await res.text().catch(() => '');
    let detail = raw.slice(0, 500);
    try { const j = JSON.parse(raw); detail = typeof j.detail === 'string' ? j.detail : Array.isArray(j.detail) ? j.detail.map((d) => d.msg || JSON.stringify(d)).join('; ') : j.message || j.error || detail; } catch { /* keep text */ }
    if (res.status === 401 || res.status === 403) throw new HttpError(502, `${label}: fal rejected the API key (${res.status}). Check FAL_KEY in .env.`);
    throw new HttpError(502, `${label}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  // Upload a local file to fal's CDN storage and return its public URL (same protocol as @fal-ai/client storage.upload).
  async function falUpload(buf, fileName, contentType) {
    const init = await falFetch(`${FAL_REST_URL}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    }, 'fal upload').then((r) => r.json());
    if (!init?.upload_url || !init?.file_url) throw new HttpError(502, 'fal upload: unexpected initiate response.');
    let put;
    try { put = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': contentType }, body: buf }); }
    catch (e) { throw new HttpError(502, `fal upload: network error — ${e.message}`); }
    if (!put.ok) throw new HttpError(502, `fal upload: storage returned HTTP ${put.status}.`);
    return init.file_url;
  }
  // Submit to the queue, poll until done, return the parsed result. `sink.requestId` is set as soon as fal accepts the job.
  async function falRun(endpoint, input, sink) {
    const sub = await falFetch(`${FAL_QUEUE_URL}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    }, 'fal submit').then((r) => r.json());
    if (!sub?.request_id || !sub?.status_url || !sub?.response_url) throw new HttpError(502, 'fal submit: unexpected queue response.');
    sink.requestId = sub.request_id;
    const t0 = Date.now();
    for (;;) {
      const st = await falFetch(sub.status_url, {}, 'fal status').then((r) => r.json());
      if (st.status === 'COMPLETED') break;
      if (Date.now() - t0 > FAL_TIMEOUT_MS) throw new HttpError(504, `fal: request ${sub.request_id} did not finish within ${FAL_TIMEOUT_MS / 60000} minutes.`);
      await new Promise((r) => setTimeout(r, FAL_POLL_MS));
    }
    return falFetch(sub.response_url, {}, 'fal result').then((r) => r.json());
  }

  // Cloud upscale. opt: { id, endpoint, price, input(scale) } from the upscaler catalogue; expected: { width, height } of the
  // result when the source size is known (used for the cost estimate if the output is not a PNG).
  // → { buf, format, requestId, durationMs, width, height, costUsd, callId }
  async function falUpscale({ feature = 'upscale', refs, opt, srcBuf, fileName, contentType, scale, expected = {} }) {
    if (!FAL_KEY) throw new HttpError(400, 'Cloud upscaling needs FAL_KEY in .env (restart the server after adding it).');
    const call = begin('fal', 'upscale', { feature, refs, model: opt.id, endpoint: opt.endpoint });
    const input = opt.input(scale);
    const request = { endpoint: opt.endpoint, input, source: { file: fileName, bytes: srcBuf.length, contentType }, scale };
    const sink = { requestId: null };
    try {
      const imageUrl = await falUpload(srcBuf, fileName, contentType);
      const result = await falRun(opt.endpoint, { image_url: imageUrl, ...input }, sink);
      const outUrl = result?.image?.url;
      if (!outUrl) throw new HttpError(502, `fal: no image in response (${JSON.stringify(result).slice(0, 300)})`);
      let res;
      try { res = await fetch(outUrl); } catch (e) { throw new HttpError(502, `fal download: network error — ${e.message}`); }
      if (!res.ok) throw new HttpError(502, `fal download: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const format = sniffImage(buf) || 'png';
      const width = format === 'png' ? buf.readUInt32BE(16) : expected.width || null;
      const height = format === 'png' ? buf.readUInt32BE(20) : expected.height || null;
      const costUsd = estimateUpscaleCost(opt.price, width, height);
      const entry = await record(
        finish(call, { ok: true, status: 200, costUsd, estimated: true, rates: opt.price || null, imagesIn: 1, imagesOut: 1, inputPreview: `${fileName} ×${scale}`, outputPreview: `${width || '?'} × ${height || '?'} ${format}`, extra: { requestId: sink.requestId, scale, width, height } }),
        { request, response: { result, bytes: buf.length, width, height, format } });
      return { buf, format, requestId: sink.requestId, durationMs: entry.durationMs, width, height, costUsd, callId: entry.id };
    } catch (e) {
      // Once fal has accepted the job it may still bill it, so a failure after submission is flagged rather than costed at zero.
      await record(finish(call, { ok: false, status: e.status || null, error: e.message, costUsd: sink.requestId ? null : 0, estimated: true, rates: opt.price || null, imagesIn: 1, inputPreview: `${fileName} ×${scale}`, extra: { requestId: sink.requestId, scale } }),
        { request, response: { error: e.message } });
      throw e;
    }
  }

  // ---------- local Real-ESRGAN (free, one at a time on the GPU) ----------
  let upscaleLock = Promise.resolve();
  // → { durationMs, callId }; the result is written to `dest`.
  function localUpscale({ feature = 'upscale', refs, bin, modelsDir, src, dest, model, scale }) {
    const run = upscaleLock.then(() => new Promise((resolve, reject) => {
      const call = begin('local', 'upscale', { feature, refs, model, endpoint: 'realesrgan-ncnn-vulkan' });
      const args = ['-i', src, '-o', dest, '-n', model, '-s', String(scale), '-m', modelsDir, '-f', 'png'];
      const base = { costUsd: 0, imagesIn: 1, inputPreview: `${path.basename(src)} ×${scale}`, extra: { scale } };
      execFile(bin, args, { timeout: 30 * 60 * 1000, maxBuffer: 1 << 24 }, async (err, stdout, stderr) => {
        if (err) {
          const message = `Real-ESRGAN failed (${err.signal || err.code}): ${String(stderr).trim().split('\n').filter((l) => !/^\[|^\d+\.\d+%$/.test(l)).pop() || err.message}`;
          await record(finish(call, { ...base, ok: false, error: message }), { request: { bin, args }, response: { error: message } });
          reject(new HttpError(500, message));
        } else {
          const entry = await record(finish(call, { ...base, ok: true, imagesOut: 1, outputPreview: path.basename(dest) }), { request: { bin, args }, response: { file: path.basename(dest) } });
          resolve({ durationMs: entry.durationMs, callId: entry.id });
        }
      });
    }));
    upscaleLock = run.catch(() => {});
    return run;
  }

  // ---------- one-time backfill ----------
  // Before the gateway existed, calls were only noted in prompt-log.jsonl (and image costs on history records). The first
  // start imports those so the Costs page covers the whole history. Imported calls are marked `backfilled` and have no
  // stored request/response beyond what the log kept. Text calls are costed now from their logged token usage.
  async function backfill({ logFile, readHistory }) {
    if (await fsp.access(LEDGER).then(() => true, () => false)) return { skipped: true };
    const lines = (await fsp.readFile(logFile, 'utf8').catch(() => '')).split('\n');
    const events = [];
    for (const l of lines) { if (!l) continue; try { events.push(JSON.parse(l)); } catch { /* skip */ } }
    const history = await readHistory().catch(() => []);
    const recById = new Map(history.map((r) => [r.id, r]));

    // Which book / card series an image record belongs to, and what it was for.
    const owner = new Map();
    const own = (recordId, feature, refs) => { if (recordId && !owner.has(recordId)) owner.set(recordId, { feature, refs }); };
    for (const e of events) {
      if (e.type === 'card_image') own(e.recordId, 'card_image', { seriesId: e.seriesId });
      else if (e.type === 'book_page_image') own(e.recordId, 'book_page_image', { bookId: e.bookId });
      else if (e.type === 'card_cast_sheet') { own(e.masterId, 'card_cast_master', { seriesId: e.seriesId, characterId: e.characterId }); own(e.sheetId, 'character_sheet', { seriesId: e.seriesId, characterId: e.characterId }); own(e.bibleId, 'character_bible_image', { seriesId: e.seriesId, characterId: e.characterId }); }
      else if (e.type === 'book_cast_design') { own(e.recordId, 'book_cast_design', { bookId: e.bookId, characterId: e.characterId }); own(e.sheetId, 'character_sheet', { bookId: e.bookId, characterId: e.characterId }); own(e.bibleId, 'character_bible_image', { bookId: e.bookId, characterId: e.characterId }); }
      else if (e.type === 'card_cast_bible' || e.type === 'character_bible') own(e.recordId, 'character_bible_image', cleanRefs({ seriesId: e.seriesId, characterId: e.characterId }));
    }
    for (const r of history) {
      if (r.card?.seriesId) own(r.id, 'card_image', { seriesId: r.card.seriesId });
    }

    const TEXT_EVENTS = { book_ideas: 1, book_brief: 1, book_outline: 1, book_details: 1, book_scripts: 1, card_analysis: 1, card_groups: 1, card_template: 1, card_series_plan: 1, card_series_write: 1, character_bible: 1, card_cast_bible: 1, enhance: 1, character_described: 1 };
    const DEFAULT_MODEL = { enhance: 'gpt-5.4-mini', character_described: 'gpt-5.4-mini', card_cast_bible: 'gpt-6-astra', character_bible: 'gpt-6-astra' };
    const out = [];
    const seenRecords = new Set();
    const base = (e, provider, kind, feature, model, refs) => ({ id: crypto.randomUUID(), ts: e.ts, provider, kind, endpoint: null, model: model || null, feature, refs: cleanRefs(refs), backfilled: true });
    const textEntry = (e, feature, usage, extra = {}) => {
      const model = e.model || DEFAULT_MODEL[e.type] || null;
      const { costUsd, rates } = priceUsage('text', model, usage);
      return { ...base(e, 'openai', 'text', feature, model, { bookId: e.bookId, seriesId: e.seriesId, imageId: e.imageId, characterId: e.characterId, templateId: e.templateId }),
        endpoint: '/v1/responses', ok: true, status: 200, error: null, durationMs: e.durationMs ?? null, usage: usage || null, tokens: tokensOf('text', usage), costUsd, estimated: false, rates, imagesIn: 0, imagesOut: 0,
        inputPreview: clip(e.prompt || e.premise || e.seed || e.name || e.instructions || (e.cards?.length ? `cards ${[].concat(e.cards).join(', ')}` : '') || (e.pages?.length ? `pages ${[].concat(e.pages).join(', ')}` : '') || ''),
        outputPreview: clip(e.enhanced || e.title || e.description || (e.written != null ? `${e.written} written` : '') || ''), ...extra };
    };
    for (const e of events) {
      if (!e?.type || !e.ts) continue;
      if (e.type === 'generate' || e.type === 'character_sheet') {
        const ids = e.ids || (e.recordId ? [e.recordId] : []);
        ids.forEach((id) => seenRecords.add(id));
        const o = ids.map((id) => owner.get(id)).find(Boolean);
        const feature = o?.feature || (e.type === 'character_sheet' ? 'character_sheet' : 'generate');
        const priced = priceUsage('image', e.model, e.usage);
        const cost = e.batchCostUsd ?? e.costUsd ?? priced.costUsd;
        out.push({ ...base(e, 'openai', 'image', feature, e.model, { ...(o?.refs || {}), ...(e.characterId ? { characterId: e.characterId } : {}) }),
          endpoint: (e.characters?.length || e.type === 'character_sheet') ? '/v1/images/edits' : '/v1/images/generations', ok: true, status: 200, error: null, durationMs: e.durationMs ?? null,
          usage: e.usage || null, tokens: tokensOf('image', e.usage), costUsd: cost ?? null, estimated: false, rates: priced.rates, imagesIn: 0, imagesOut: ids.length || 1,
          inputPreview: clip(e.originalPrompt || e.prompt || e.name || ''), outputPreview: `${ids.length || 1} image${ids.length === 1 ? '' : 's'}`,
          size: e.size || null, quality: e.quality || null, n: e.n || 1, recordIds: ids });
      } else if (e.type === 'generate_failed' || e.type === 'character_sheet_failed') {
        out.push({ ...base(e, 'openai', 'image', e.type === 'generate_failed' ? 'generate' : 'character_sheet', e.model, { characterId: e.characterId }),
          ok: false, status: null, error: clip(e.error, 600), durationMs: e.durationMs ?? null, usage: null, tokens: null, costUsd: 0, estimated: false, rates: null, imagesIn: 0, imagesOut: 0,
          inputPreview: clip(e.originalPrompt || e.prompt || e.name || ''), outputPreview: '', size: e.size || null, quality: e.quality || null, n: e.n || 1 });
      } else if (e.type === 'upscale') {
        seenRecords.add(e.id);
        const fal = e.provider === 'fal';
        out.push({ ...base(e, fal ? 'fal' : 'local', 'upscale', 'upscale', e.model, { recordId: e.sourceId }), ok: true, status: 200, error: null, durationMs: e.durationMs ?? null,
          usage: null, tokens: null, costUsd: e.costUsd ?? 0, estimated: fal, rates: null, imagesIn: 1, imagesOut: 1, inputPreview: `×${e.scale}`, outputPreview: `${e.width || '?'} × ${e.height || '?'}`,
          requestId: e.requestId || null, scale: e.scale, width: e.width, height: e.height, recordIds: [e.id] });
      } else if (TEXT_EVENTS[e.type]) {
        const feature = e.type === 'card_cast_bible' ? 'character_bible' : e.type === 'character_described' ? 'character_describe' : e.type;
        out.push(textEntry(e, feature, e.usage));
        if (e.editorUsage) out.push(textEntry(e, 'card_series_plan_edit', e.editorUsage, { durationMs: null }));
      } else if (e.type.endsWith('_failed')) {
        const feature = e.type.slice(0, -'_failed'.length);
        out.push({ ...textEntry(e, feature, null), ok: false, status: null, error: clip(e.error, 600), costUsd: 0, outputPreview: '' });
      }
    }
    // Images whose log line is gone (older than the log, or the log was trimmed): take them from the history records.
    const batches = new Map();
    for (const r of history) {
      if (seenRecords.has(r.id) || r.costUsd == null) continue;
      const key = r.batchId || r.id;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(r);
    }
    for (const recs of batches.values()) {
      const r = recs[0];
      const up = r.kind === 'upscaled';
      const fal = r.upscale?.provider === 'fal';
      const o = owner.get(r.id);
      out.push({ ...base({ ts: r.createdAt }, up ? (fal ? 'fal' : 'local') : 'openai', up ? 'upscale' : 'image', up ? 'upscale' : o?.feature || (r.tags?.includes('character-sheet') ? 'character_sheet' : 'generate'), up ? r.upscale?.model : r.model, up ? { recordId: r.upscaleOf } : o?.refs),
        ok: true, status: 200, error: null, durationMs: r.durationMs ?? null, usage: up ? null : r.usage || null, tokens: up ? null : tokensOf('image', r.usage),
        costUsd: r.batchCostUsd ?? r.costUsd, estimated: fal, rates: null, imagesIn: up ? 1 : 0, imagesOut: recs.length,
        inputPreview: clip(up ? `×${r.upscale?.scale || ''}` : r.originalPrompt || r.prompt || ''), outputPreview: `${recs.length} image${recs.length === 1 ? '' : 's'}`,
        size: r.size || null, quality: r.quality || null, n: r.n || recs.length, recordIds: recs.map((x) => x.id) });
    }
    out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    await fsp.mkdir(OUTPUT_DIR, { recursive: true });
    await fsp.writeFile(LEDGER, out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
    return { skipped: false, imported: out.length };
  }

  return { text, image, speech, falUpscale, localUpscale, readCalls, readCall, backfill, ledgerFile: LEDGER };
}
