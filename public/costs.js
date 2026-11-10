// Costs page: reads the AI call ledger (/api/ai/calls) and shows spend, a per-day chart, breakdowns and every call
// with its input and output. All filtering and totals happen here, so every number on the page is the same slice.
const $ = (id) => document.getElementById(id);

// feature → where it shows up in the app and what it does. Unknown features fall into "Other" under their raw name.
const FEATURES = {
  generate: ['Images', 'Image generation'], enhance: ['Images', 'Prompt enhancement'], upscale: ['Upscaling', 'Upscale'],
  character_describe: ['Characters', 'Describe character'], character_sheet: ['Characters', 'Reference sheet'],
  character_bible: ['Characters', 'Character bible — writing'], character_bible_image: ['Characters', 'Character bible — poster'],
  book_ideas: ['Story Books', 'Book ideas'], book_brief: ['Story Books', 'Fill in brief'], book_outline: ['Story Books', 'Outline'],
  book_details: ['Story Books', 'Page details'], book_scripts: ['Story Books', 'Write pages'], book_page_image: ['Story Books', 'Page illustration'],
  book_cast_design: ['Story Books', 'Cast design drawing'],
  card_analysis: ['Flash Cards', 'Read an existing card'], card_groups: ['Flash Cards', 'Group the library'], card_template: ['Flash Cards', 'Make a template'],
  card_series_plan: ['Flash Cards', 'Plan a series'], card_series_plan_edit: ['Flash Cards', 'Edit the plan'], card_series_write: ['Flash Cards', 'Write cards'],
  card_image: ['Flash Cards', 'Card picture'], card_cast_master: ['Flash Cards', 'Cast master drawing'],
};
const AREAS = ['Images', 'Characters', 'Story Books', 'Flash Cards', 'Upscaling', 'Other'];
const KINDS = [['text', 'Text (writing & vision)', '--series-text'], ['image', 'Image generation', '--series-image'], ['upscale', 'Upscaling', '--series-upscale']];
const areaOf = (c) => (FEATURES[c.feature] || ['Other'])[0];
const labelOf = (c) => (FEATURES[c.feature] || [null, c.feature])[1];
const actName = (c) => `${areaOf(c)} · ${labelOf(c)}`;

const DEFAULTS = { range: '30d' };
const PAGE = 100;
let data = { calls: [], projects: {}, characters: {}, pricing: null };
let shown = PAGE;
const state = { range: '30d', area: '', act: '', model: '', project: '', status: '', q: '' };

// ---------- formatting ----------
const money = (v) => (v == null ? '—' : v === 0 ? '$0.00' : v < 0.1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
const money2 = (v) => `$${v.toFixed(2)}`;
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n.toLocaleString());
const secs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const when = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const cssVar = (name) => getComputedStyle(document.querySelector('.costs-page')).getPropertyValue(name).trim();

function el(tag, props = {}, kids = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'text') n.textContent = v; else if (k === 'class') n.className = v; else if (k === 'style') n.style.cssText = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const kid of [].concat(kids)) if (kid != null) n.append(kid);
  return n;
}
const svg = (tag, attrs = {}, kids = []) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const kid of [].concat(kids)) if (kid != null) n.append(kid);
  return n;
};

// replaceChildren that ignores null entries (so optional pieces can be written inline).
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null));

// ---------- slicing ----------
const projectId = (c) => c.refs?.seriesId || c.refs?.bookId || '';
const projectName = (c) => { const id = projectId(c); return id ? (data.projects[id]?.title || `Deleted project (${id.slice(0, 8)})`) : ''; };

function rangeBounds() {
  const today = dayStart(new Date());
  const end = new Date(today.getTime() + 864e5);
  if (state.range === 'today') return { from: today, to: end };
  if (state.range === '7d') return { from: new Date(today.getTime() - 6 * 864e5), to: end };
  if (state.range === '30d') return { from: new Date(today.getTime() - 29 * 864e5), to: end };
  const first = data.calls.length ? dayStart(new Date(data.calls[data.calls.length - 1].ts)) : today;
  return { from: first, to: end };
}
function slice() {
  const { from, to } = rangeBounds();
  const q = state.q.trim().toLowerCase();
  return data.calls.filter((c) => {
    const t = new Date(c.ts);
    if (t < from || t >= to) return false;
    if (state.area && areaOf(c) !== state.area) return false;
    if (state.act && c.feature !== state.act) return false;
    if (state.model && c.model !== state.model) return false;
    if (state.project && projectId(c) !== state.project) return false;
    if (state.status === 'ok' && !c.ok) return false;
    if (state.status === 'failed' && c.ok) return false;
    if (q && !`${c.inputPreview} ${c.outputPreview} ${c.error || ''} ${c.feature} ${c.model} ${projectName(c)}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
const sum = (list, f) => list.reduce((s, x) => s + (f(x) || 0), 0);

// ---------- tooltip ----------
const tip = $('tip');
function showTip(evt, title, rows, total) {
  fill(tip, el('div', { class: 'tip-title', text: title }),
    ...rows.map((r) => el('div', { class: 'tip-row' }, [el('span', {}, [r.color ? el('i', { class: 'tip-key', style: `background:${r.color}` }) : null, r.label]), el('b', { text: r.value })])),
    total ? el('div', { class: 'tip-row tip-total' }, [el('span', { text: total.label }), el('b', { text: total.value })]) : null);
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  const src = evt.clientX != null && evt.type !== 'focus' ? { x: evt.clientX, y: evt.clientY } : (() => { const r = evt.currentTarget.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 20 }; })();
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - box.width - 8, src.x + 14))}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - box.height - 8, src.y + 14))}px`;
}
const hideTip = () => { tip.hidden = true; };

// ---------- tiles ----------
function renderTiles(list) {
  const total = sum(list, (c) => c.costUsd);
  const failed = list.filter((c) => !c.ok).length;
  const img = list.filter((c) => c.kind === 'image');
  const txt = list.filter((c) => c.kind === 'text');
  const up = list.filter((c) => c.kind === 'upscale');
  const images = sum(img, (c) => c.imagesOut);
  const tin = sum(list, (c) => c.tokens?.input), tout = sum(list, (c) => c.tokens?.output);
  const freeUps = up.filter((c) => c.provider === 'local').length;
  const tile = (label, value, sub) => el('div', { class: 'stat' }, [el('div', { class: 't-label', text: label }), el('div', { class: 't-value', text: value }), el('div', { class: 't-sub' }, sub)]);
  $('tiles').replaceChildren(
    tile('Total spend', money2(total), [plural(list.length, 'call'), failed ? ' · ' : null, failed ? el('span', { class: 'bad', text: `${failed} failed` }) : null]),
    tile('Image generation', money2(sum(img, (c) => c.costUsd)), images ? `${plural(images, 'image')} · ${money(sum(img, (c) => c.costUsd) / images)} each on average` : 'no images'),
    tile('Text (writing & vision)', money2(sum(txt, (c) => c.costUsd)), txt.length ? `${plural(txt.length, 'call')} · ${money(sum(txt, (c) => c.costUsd) / txt.length)} each on average` : 'no calls'),
    tile('Upscaling', money2(sum(up, (c) => c.costUsd)), up.length ? `${plural(up.length, 'upscale')}${freeUps ? ` · ${freeUps} local, free` : ''}` : 'no upscales'),
    tile('Tokens', compact(tin + tout), `${compact(tin)} in · ${compact(tout)} out`),
  );
}

// ---------- spend per day ----------
function buckets() {
  const { from, to } = rangeBounds();
  const out = [];
  if (state.range === 'today') {
    for (let h = 0; h < 24; h++) out.push({ start: new Date(from.getTime() + h * 36e5), end: new Date(from.getTime() + (h + 1) * 36e5), label: new Date(from.getTime() + h * 36e5).toLocaleTimeString(undefined, { hour: 'numeric' }), title: `${new Date(from.getTime() + h * 36e5).toLocaleTimeString(undefined, { hour: 'numeric' })} today` });
    return out;
  }
  const days = Math.round((to - from) / 864e5);
  const step = days > 92 ? 7 : 1;
  for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step)) {
    const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
    const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    out.push({ start: d, end, label, title: step === 7 ? `Week of ${label}` : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  return out;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function renderDays(list) {
  const bs = buckets();
  for (const b of bs) { b.text = 0; b.image = 0; b.upscale = 0; b.calls = 0; }
  for (const c of list) {
    const t = new Date(c.ts);
    const b = bs.find((x) => t >= x.start && t < x.end);
    if (b) { b[c.kind] = (b[c.kind] || 0) + (c.costUsd || 0); b.calls++; }
  }
  const colors = Object.fromEntries(KINDS.map(([k, , v]) => [k, cssVar(v)]));
  $('day-legend').replaceChildren(...KINDS.map(([k, label]) => el('span', { class: 'key' }, [el('i', { class: 'swatch', style: `background:${colors[k]}` }), label])));

  const wrap = $('day-chart');
  const W = Math.max(320, wrap.clientWidth), H = 260, m = { l: 52, r: 8, t: 12, b: 26 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const max = niceMax(Math.max(...bs.map((b) => b.text + b.image + b.upscale), 0));
  const y = (v) => m.t + ph - (v / max) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Spend per day, stacked by kind of call' });
  const tickFmt = (v) => `$${max < 1 ? v.toFixed(2) : String(+v.toFixed(2))}`;
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: cssVar(i ? '--grid' : '--axis'), 'stroke-width': 1 }));
    const t = svg('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end' }); t.textContent = tickFmt(v); root.append(t);
  }
  const band = pw / bs.length, bw = Math.max(2, Math.min(24, band * 0.7));
  const every = Math.max(1, Math.ceil(64 / band));
  bs.forEach((b, i) => {
    const cx = m.l + band * i + band / 2;
    const g = svg('g', { class: 'col', tabindex: 0, role: 'img', 'aria-label': `${b.title}: ${money(b.text + b.image + b.upscale)}` });
    g.append(svg('rect', { class: 'hit', x: m.l + band * i, y: m.t, width: band, height: ph, fill: 'transparent' }));
    const parts = KINDS.map(([k]) => [k, b[k]]).filter(([, v]) => v > 0);
    let base = 0;
    parts.forEach(([k, v], j) => {
      const y0 = y(base), y1 = y(base + v);
      base += v;
      const top = j === parts.length - 1;
      const gap = top ? 0 : 2;                       // 2px surface gap between stacked segments
      const h = Math.max(1, y0 - y1 - gap), yy = y0 - h, x = cx - bw / 2;
      const r = top ? Math.min(4, bw / 2, h) : 0;    // rounded data-end, square at the baseline
      g.append(svg('path', { class: 'seg-r', fill: colors[k], d: `M${x},${yy + h}V${yy + r}Q${x},${yy} ${x + r},${yy}H${x + bw - r}Q${x + bw},${yy} ${x + bw},${yy + r}V${yy + h}Z` }));
    });
    const show = (e) => showTip(e, b.title, KINDS.map(([k, label]) => ({ color: colors[k], label, value: money(b[k]) })), { label: plural(b.calls, 'call'), value: money(b.text + b.image + b.upscale) });
    g.addEventListener('pointermove', show); g.addEventListener('focus', show);
    g.addEventListener('pointerleave', hideTip); g.addEventListener('blur', hideTip);
    root.append(g);
    if (i % every === 0) { const t = svg('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }); t.textContent = b.label; root.append(t); }
  });
  // The one direct label: the biggest bucket.
  const peak = bs.reduce((a, b) => (b.text + b.image + b.upscale > a.text + a.image + a.upscale ? b : a), bs[0]);
  const peakV = peak ? peak.text + peak.image + peak.upscale : 0;
  if (peakV > 0) {
    const i = bs.indexOf(peak);
    const t = svg('text', { class: 'tip-label', x: Math.max(m.l + 22, Math.min(W - m.r - 22, m.l + band * i + band / 2)), y: Math.max(10, y(peakV) - 5), 'text-anchor': 'middle' });
    t.textContent = money2(peakV); root.append(t);
  }
  wrap.replaceChildren(root);

  const rows = bs.filter((b) => b.calls);
  $('day-table').replaceChildren(rows.length ? el('table', {}, [
    el('tr', {}, ['', 'Text', 'Images', 'Upscaling', 'Total', 'Calls'].map((h) => el('th', { text: h }))),
    ...rows.map((b) => el('tr', {}, [b.title, money(b.text), money(b.image), money(b.upscale), money(b.text + b.image + b.upscale), String(b.calls)].map((v) => el('td', { text: v })))),
  ]) : el('div', { text: 'No calls in this range.' }));
}

// ---------- breakdown bars ----------
function renderBars(id, list, keyOf, nameOf, stateKey, subOf = () => '') {
  const groups = new Map();
  for (const c of list) {
    const k = keyOf(c);
    if (!groups.has(k)) groups.set(k, { key: k, name: nameOf(c), sub: subOf(c), cost: 0, calls: 0, images: 0, tin: 0, tout: 0 });
    const g = groups.get(k);
    g.cost += c.costUsd || 0; g.calls++; g.images += c.imagesOut || 0; g.tin += c.tokens?.input || 0; g.tout += c.tokens?.output || 0;
  }
  const rows = [...groups.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const top = rows.slice(0, 10), rest = rows.slice(10);
  const max = Math.max(...top.map((r) => r.cost), 0) || 1;
  const box = $(id);
  if (!rows.length) { box.replaceChildren(el('div', { class: 'empty-note', text: 'Nothing in this range.' })); return; }
  fill(box, top.map((r) => {
    const row = el('button', { type: 'button', class: `bar-row${state[stateKey] && state[stateKey] === r.key ? ' on' : ''}`, title: r.key === '' ? '' : 'Filter by this' }, [
      el('span', { class: 'b-name' }, [r.name, r.sub ? el('small', { text: r.sub }) : null]),
      el('span', { class: 'b-track' }, el('span', { class: 'b-fill', style: `width:${Math.max(0.5, (r.cost / max) * 100)}%` })),
      el('span', { class: 'b-val', text: money(r.cost) }),
    ]);
    const show = (e) => showTip(e, r.name, [
      { label: 'Calls', value: r.calls.toLocaleString() },
      r.images ? { label: 'Images', value: r.images.toLocaleString() } : null,
      r.tin || r.tout ? { label: 'Tokens in / out', value: `${compact(r.tin)} / ${compact(r.tout)}` } : null,
      { label: 'Average per call', value: money(r.cost / r.calls) },
    ].filter(Boolean), { label: 'Spend', value: money(r.cost) });
    row.addEventListener('pointermove', show); row.addEventListener('focus', show);
    row.addEventListener('pointerleave', hideTip); row.addEventListener('blur', hideTip);
    row.addEventListener('click', () => { if (r.key === '') return; setState({ [stateKey]: state[stateKey] === r.key ? '' : r.key }); });
    return row;
  }), rest.length ? el('div', { class: 'empty-note', text: `+ ${rest.length} more · ${money(sum(rest, (r) => r.cost))}` }) : null);
}

// ---------- calls table ----------
function renderCalls(list) {
  const body = $('calls').tBodies[0];
  const colors = Object.fromEntries(KINDS.map(([k, , v]) => [k, cssVar(v)]));
  $('calls-count').textContent = list.length ? `${plural(list.length, 'call')}, newest first · click a row for the full input and output` : '';
  if (!list.length) { body.replaceChildren(el('tr', {}, el('td', { colspan: 10, class: 'calls-empty', text: data.calls.length ? 'No calls match these filters.' : 'No AI calls recorded yet. Generate an image or write a story and it will show up here.' }))); $('more').hidden = true; return; }
  body.replaceChildren(...list.slice(0, shown).map((c) => {
    const badges = [
      !c.ok ? el('span', { class: 'badge bad', text: 'failed' }) : null,
      c.backfilled ? el('span', { class: 'badge', title: 'Imported from the earlier prompt log', text: 'imported' }) : null,
    ];
    const cost = c.costUsd == null ? el('span', { title: c.backfilled && !c.usage ? 'Made before token usage was recorded for this kind of call' : c.kind === 'upscale' ? 'fal accepted the job before it failed, so it may have been billed' : 'No rate listed for this model in ai.js', text: c.backfilled && !c.usage ? 'not recorded' : 'unpriced' })
      : c.provider === 'local' ? 'free' : `${c.estimated ? '≈ ' : ''}${money(c.costUsd)}`;
    const tr = el('tr', { tabindex: 0 }, [
      el('td', { class: 'when', text: when(c.ts) }),
      el('td', { class: 'act' }, [el('i', { class: 'kind-dot', style: `background:${colors[c.kind] || 'var(--muted)'}` }), labelOf(c), ...badges]),
      el('td', { text: projectName(c) || (c.refs?.characterId && data.characters[c.refs.characterId]) || '' }),
      el('td', { class: 'nowrap', text: c.model || '' }),
      el('td', { class: 'clipcell' }, el('div', { class: 'clip', text: c.inputPreview || '' })),
      el('td', { class: 'clipcell' }, el('div', { class: `clip${c.ok ? '' : ' d-error'}`, text: c.ok ? c.outputPreview || '' : c.error || 'failed' })),
      el('td', { class: 'num', text: c.tokens ? c.tokens.input.toLocaleString() : '' }),
      el('td', { class: 'num', text: c.tokens ? c.tokens.output.toLocaleString() : '' }),
      el('td', { class: 'num', text: secs(c.durationMs) }),
      el('td', { class: 'num' }, cost),
    ]);
    tr.addEventListener('click', () => openDetail(c));
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(c); });
    return tr;
  }));
  $('more').hidden = list.length <= shown;
  $('more').textContent = `Show more (${(list.length - shown).toLocaleString()} left)`;
}

// ---------- call detail ----------
function block(title, text, cls = 'prompt-text') {
  return el('div', { class: 'prompt-block' }, [el('div', { class: 'prompt-title', text: title }), el(cls === 'pre' ? 'pre' : 'div', { class: cls === 'pre' ? '' : cls, text })]);
}
const pretty = (v) => { if (typeof v !== 'string') return JSON.stringify(v, null, 2); try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } };
async function openDetail(c) {
  urlState.set({ call: c.id });
  $('d-title').textContent = `${actName(c)} — ${when(c.ts)}`;
  const chips = [c.provider, c.model, c.endpoint, c.size, c.quality && `quality ${c.quality}`, c.effort && `effort ${c.effort}`, c.scale && `×${c.scale}`, secs(c.durationMs),
    c.costUsd == null ? 'unpriced' : c.provider === 'local' ? 'free' : `${c.estimated ? '≈ ' : ''}${money(c.costUsd)}`, c.ok ? 'succeeded' : 'failed', c.backfilled && 'imported from prompt log', projectName(c)].filter(Boolean);
  $('d-chips').replaceChildren(...chips.map((t) => el('span', { class: 'chip', text: t })));
  $('d-body').replaceChildren(el('div', { class: 'status', text: 'Loading…' }));
  if (!$('detail').open) $('detail').showModal();
  let d;
  try { d = await (await fetch(`/api/ai/calls/${encodeURIComponent(c.id)}`)).json(); if (d.error) throw new Error(d.error); }
  catch (e) { $('d-body').replaceChildren(el('div', { class: 'status error', text: e.message })); return; }
  const req = d.payload?.request, res = d.payload?.response;
  const out = [];
  if (c.error) out.push(el('div', { class: 'd-error', text: c.error }));
  if (!d.payload) out.push(el('div', { class: 'hint', text: 'This call was imported from the earlier prompt log, which kept only a summary. Calls made from now on keep the full request and reply.' }));
  if (req?.instructions) out.push(block('Instructions (system prompt)', req.instructions));
  if (req?.input != null) out.push(block(`Input${c.imagesIn ? ` · ${plural(c.imagesIn, 'image')} attached` : ''}`, typeof req.input === 'string' ? req.input : pretty(req.input), typeof req.input === 'string' ? 'prompt-text' : 'pre'));
  if (req?.prompt) out.push(block(`Prompt sent${c.imagesIn ? ` · ${plural(c.imagesIn, 'reference image')} attached` : ''}`, req.prompt));
  if (req && !req.instructions && req.input == null && !req.prompt) out.push(block('Request', pretty(req), 'pre'));
  if (!req && c.inputPreview) out.push(block('Input (summary)', c.inputPreview));
  if (res?.text) out.push(block('Reply', pretty(res.text), res.text.trim().startsWith('{') ? 'pre' : 'prompt-text'));
  else if (!d.payload && c.outputPreview) out.push(block('Output (summary)', c.outputPreview));
  if (d.records?.length) {
    out.push(el('div', { class: 'prompt-block' }, [el('div', { class: 'prompt-title', text: `Images produced (${d.records.length})` }), el('div', { class: 'd-images' }, d.records.map((r) =>
      el('a', { href: r.missing ? null : r.url, target: '_blank', rel: 'noopener' }, [r.missing ? null : el('img', { src: r.thumbUrl || r.url, alt: r.title || r.file, loading: 'lazy' }), `${r.title || r.file}${r.deletedAt ? ' (in trash)' : ''}${r.missing ? ' (file missing)' : ''}`])))]));
  } else if (c.imagesOut && c.kind !== 'text') out.push(el('div', { class: 'hint', text: `${plural(c.imagesOut, 'image')} produced; no longer in the history (deleted permanently).` }));
  if (c.usage) out.push(block('Usage reported by the provider', pretty(c.usage), 'pre'));
  if (c.rates) out.push(block(c.kind === 'upscale' ? 'Rate used (estimate from the published price)' : 'Rates used (USD per 1M tokens)', pretty(c.rates), 'pre'));
  if (Object.keys(c.refs || {}).length) out.push(block('Linked to', pretty(c.refs), 'pre'));
  $('d-body').replaceChildren(...out);
}

// ---------- pricing ----------
function renderPricing() {
  const p = data.pricing;
  if (!p) return;
  const used = new Set(data.calls.map((c) => c.model));
  const cell = (v) => el('td', { text: v == null ? '—' : `$${v}` });
  const rows = [
    ...Object.entries(p.text).map(([m, r]) => el('tr', {}, [el('td', { text: m }), cell(r.input), cell(r.cachedInput), cell(r.cacheWrite), cell(r.output), el('td', { text: '—' }), el('td', { text: '—' })])),
    ...Object.entries(p.image).map(([m, r]) => el('tr', {}, [el('td', { text: m }), cell(r.textIn), cell(r.cachedTextIn), el('td', { text: '—' }), el('td', { text: '—' }), cell(r.imageIn), cell(r.imageOut)])),
  ];
  const unlisted = [...used].filter((m) => m && !p.text[m] && !p.image[m] && data.calls.some((c) => c.model === m && c.provider === 'openai' && c.costUsd == null && c.ok));
  $('pricing-note').textContent = `USD per 1M tokens · checked ${p.checked}`;
  $('pricing').replaceChildren(
    el('table', {}, [el('tr', {}, ['Model', 'Text in', 'Cached in', 'Cache write', 'Text out', 'Image in', 'Image out'].map((h) => el('th', { text: h }))), ...rows]),
    el('p', { text: `Costs are worked out from the token usage each call reports, at the rates above (edit them in src/ai.js when prices change). fal.ai upscales are estimates from fal's published per-megapixel prices, marked ≈. Local Real-ESRGAN is free. The provider's own billing page is the final word.${unlisted.length ? ` No rate is listed for: ${unlisted.join(', ')}.` : ''}` }),
  );
}

// ---------- state ----------
function fillSelect(id, first, options, value) {
  $(id).replaceChildren(el('option', { value: '', text: first }), ...options.map(([v, label]) => el('option', { value: v, text: label })));
  $(id).value = options.some(([v]) => v === value) ? value : '';
}
function renderFilters() {
  for (const b of $('range').children) b.classList.toggle('on', b.dataset.range === state.range);
  const areas = AREAS.filter((a) => data.calls.some((c) => areaOf(c) === a));
  fillSelect('f-area', 'All areas', areas.map((a) => [a, a]), state.area);
  fillSelect('f-model', 'All models', [...new Set(data.calls.map((c) => c.model).filter(Boolean))].sort().map((m) => [m, m]), state.model);
  const projects = [...new Set(data.calls.map(projectId).filter(Boolean))].map((id) => [id, data.projects[id] ? `${data.projects[id].title} (${data.projects[id].kind.toLowerCase()})` : `Deleted project (${id.slice(0, 8)})`]).sort((a, b) => a[1].localeCompare(b[1]));
  fillSelect('f-project', 'All projects', projects, state.project);
  $('f-status').value = state.status;
  if (document.activeElement !== $('f-q')) $('f-q').value = state.q;
  $('f-clear').hidden = !(state.area || state.act || state.model || state.project || state.status || state.q);
}
function render() {
  renderFilters();
  const list = slice();
  renderTiles(list);
  renderDays(list);
  renderBars('by-feature', list, (c) => c.feature, labelOf, 'act', areaOf);
  renderBars('by-model', list, (c) => c.model || '', (c) => c.model || 'unknown', 'model', (c) => c.provider);
  renderBars('by-project', list, projectId, (c) => projectName(c) || 'Not tied to a book or series', 'project', (c) => data.projects[projectId(c)]?.kind || '');
  renderCalls(list);
  const unpriced = list.filter((c) => c.costUsd == null).length;
  $('status').textContent = unpriced ? `${plural(unpriced, 'call')} in this view ${unpriced === 1 ? 'has' : 'have'} no price and ${unpriced === 1 ? 'is' : 'are'} not in the totals (marked “unpriced” or “not recorded” in the table).` : '';
}
function setState(patch) {
  Object.assign(state, patch);
  shown = PAGE;
  urlState.set(state, { defaults: DEFAULTS, pushOn: ['range', 'area', 'act', 'model', 'project', 'status'] });
  render();
}
function readUrl() {
  for (const k of Object.keys(state)) state[k] = urlState.get(k) || DEFAULTS[k] || '';
  if (!['today', '7d', '30d', 'all'].includes(state.range)) state.range = '30d';
}

$('range').addEventListener('click', (e) => { const r = e.target.closest('button')?.dataset.range; if (r) setState({ range: r }); });
$('f-area').addEventListener('change', (e) => setState({ area: e.target.value, act: '' }));
$('f-model').addEventListener('change', (e) => setState({ model: e.target.value }));
$('f-project').addEventListener('change', (e) => setState({ project: e.target.value }));
$('f-status').addEventListener('change', (e) => setState({ status: e.target.value }));
$('f-q').addEventListener('input', (e) => setState({ q: e.target.value }));
$('f-clear').addEventListener('click', () => setState({ area: '', act: '', model: '', project: '', status: '', q: '' }));
$('more').addEventListener('click', () => { shown += PAGE; renderCalls(slice()); });
$('d-close').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => urlState.set({ call: '' }));
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
urlState.onChange(() => { readUrl(); shown = PAGE; render(); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => renderDays(slice()), 120); });
window.addEventListener('scroll', hideTip, true);

async function load() {
  try {
    const r = await fetch('/api/ai/calls');
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    data = await r.json();
  } catch (e) { $('status').className = 'status error'; $('status').textContent = `Could not load the call ledger: ${e.message}`; $('topbar-meta').textContent = ''; return; }
  const all = sum(data.calls, (c) => c.costUsd);
  $('topbar-meta').textContent = `${money2(all)} all time · ${plural(data.calls.length, 'call')}`;
  readUrl();
  renderPricing();
  render();
  const open = data.calls.find((c) => c.id === urlState.get('call'));
  if (open) openDetail(open);
}
load();
