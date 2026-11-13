// Characters page: everyone in the cast at a glance, and one page per character with their
// reference pictures, sheets, written profile and every picture they appear in.
// New characters can be designed here from a description alone (master drawing, turnaround sheet and bible);
// editing and starting from your own pictures happen in the editor on the Images page, which this page links to.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let characters = [];
let records = [];        // history, newest first
let currentId = null;
let showing = null;      // key of the picture in the big viewer
let designing = false;   // a description → character sheet run is in progress

async function api(path) {
  const res = await fetch(path);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

const ROLE_LABELS = { identity: 'Portrait', sheet: 'Reference sheet', style: 'Style reference' };
const profileOf = (c) => c.bible?.profile || {};
const portrait = (c) => c.refs[0] || null;

// Every picture that defines the character: reference images first, then the character bible poster.
function mediaOf(c) {
  const out = c.refs.map((r, i) => ({
    key: r.id, url: r.url, thumbUrl: r.thumbUrl,
    label: i === 0 ? 'Portrait' : ROLE_LABELS[r.role] || 'Reference',
    hint: i === 0 ? 'main reference, sent with every picture' : 'sent with every picture',
  }));
  if (c.bible?.file) {
    const rec = records.find((r) => r.id === c.bible.recordId);
    if (!rec || (!rec.deletedAt && !rec.missing)) {
      out.push({ key: 'bible', url: rec?.url || `/output/${encodeURIComponent(c.bible.file)}`, thumbUrl: rec?.thumbUrl || `/output/${encodeURIComponent(c.bible.file)}`, label: 'Character bible', hint: 'for people to read, not sent to the image model' });
    }
  }
  return out;
}

// Pictures the character appears in, leaving out their own reference pictures and sheets.
function picturesOf(c) {
  const own = new Set([...c.refs.map((r) => r.recordId), c.bible?.recordId].filter(Boolean));
  return records.filter((r) => !r.deletedAt && !own.has(r.id) && !(r.tags || []).some((t) => t.startsWith('character-')) && (r.characters || []).some((x) => x.id === c.id));
}

function syncUrl() { urlState.set({ character: currentId, show: currentId ? showing : null, q: $('search').value.trim() }, { pushOn: ['character'] }); }

// ---------- everyone ----------
function renderCast() {
  const q = $('search').value.trim().toLowerCase();
  const list = characters.filter((c) => !q || [c.name, c.description, c.personality, c.style, c.loves, c.voice, c.quirks, c.world, profileOf(c).epithets].join(' ').toLowerCase().includes(q));
  $('cast-count').textContent = characters.length ? `· ${characters.length}` : '';
  const cast = $('cast');
  cast.innerHTML = '';
  for (const c of list) {
    const p = portrait(c), n = picturesOf(c).length;
    const a = document.createElement('a');
    a.className = 'cast-card';
    a.href = `/characters.html?character=${encodeURIComponent(c.id)}`;
    a.innerHTML = `
      <div class="cast-img">${p ? `<img src="${esc(p.thumbUrl)}" alt="" loading="lazy">` : '<span class="hint">No picture yet</span>'}</div>
      <div class="cast-body">
        <div class="cast-name">${esc(c.name)}</div>
        ${profileOf(c).epithets ? `<div class="cast-epithet">${esc(profileOf(c).epithets.split('|')[0].trim())}</div>` : ''}
        <div class="cast-desc">${esc(c.personality || c.description || 'No description yet.')}</div>
        <div class="cast-meta"><span class="chip">${plural(n, 'picture')}</span>${c.bible?.file ? '<span class="chip char">bible</span>' : ''}${c.refs.some((r) => r.role === 'sheet') ? '<span class="chip char">sheet</span>' : ''}</div>
      </div>`;
    a.addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openCharacter(c.id); });
    cast.appendChild(a);
  }
  const empty = $('cast-empty');
  empty.hidden = list.length > 0;
  empty.innerHTML = characters.length
    ? 'No character matches that search.'
    : 'No characters yet. <a href="/characters.html?character=new">Describe one</a> and the studio draws their character sheet, start from <a href="/?character=new">your own pictures</a>, or save one from any generated image on the Images page.';
}

// ---------- one character ----------
function section(title, html) { return html ? `<div class="p-section"><div class="prompt-title">${esc(title)}</div>${html}</div>` : ''; }
const bullets = (items) => (items?.length ? `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
const para = (text) => (text ? `<p>${esc(text)}</p>` : '');

function renderProfile(c) {
  const p = profileOf(c);
  const facts = (p.facts || []).filter((f) => f.value);
  const palette = p.palette?.length
    ? `<dl class="facts">${p.palette.map((x) => `<dt>${esc(x.name)}</dt><dd>${esc(x.where)}</dd>`).join('')}</dl>`
    : para(c.palette);
  const parts = [...(p.designParts || []), ...(p.props || [])].filter((x) => x.name);
  $('profile').innerHTML = `
    <h1>${esc(c.name)}</h1>
    ${p.epithets ? `<div class="epithets">${esc(p.epithets.split('|').map((s) => s.trim()).join(' · '))}</div>` : ''}
    ${p.quote ? `<blockquote>“${esc(p.quote.replace(/^[“"]|[”"]$/g, ''))}”</blockquote>` : ''}
    <div class="actions">
      <a class="btn primary small" href="/?chars=${encodeURIComponent(c.id)}">Make a picture with ${esc(c.name)}</a>
      <a class="btn secondary small" href="/?character=${encodeURIComponent(c.id)}">Edit character</a>
      ${c.bible?.seriesId ? `<a class="btn secondary small" href="/cards.html?series=${encodeURIComponent(c.bible.seriesId)}">Open their card series</a>` : ''}
    </div>
    ${section('About', facts.length ? `<dl class="facts">${facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>` : '')}
    ${section('Appearance', para(c.description))}
    ${section('Personality', p.coreTraits?.length ? bullets(p.coreTraits) : para(c.personality))}
    ${section('Loves', para(c.loves))}
    ${section('Worries', para(c.worries))}
    ${section('How they talk', para(c.voice))}
    ${section('Habits and quirks', para(c.quirks))}
    ${section('Home and friends', para(c.world))}
    ${section('Wants and worries', c.worries ? '' : para(p.wantAndWorry))}
    ${section('Usual mood', para(p.moodBaseline))}
    ${section('Habits', c.quirks ? '' : bullets(p.habits))}
    ${section('Outfit and accessories', c.outfit && c.outfit.toLowerCase() !== 'none' ? para(c.outfit) : '')}
    ${section('Colors', palette)}
    ${section('Design details', parts.length ? `<dl class="facts">${parts.map((x) => `<dt>${esc(x.name)}</dt><dd>${esc(x.note || x.description || '')}</dd>`).join('')}</dl>` : '')}
    ${section('Art style', para(c.style))}
    ${section('Always draw them this way', bullets(p.onModelRules))}
    ${!c.bible?.file && c.refs.length ? '<p class="hint">No written profile yet. “Edit character” has a button that draws a turnaround sheet and a full character bible.</p>' : ''}`;
}

function renderViewer(c) {
  const media = mediaOf(c);
  const m = media.find((x) => x.key === showing) || media[0];
  showing = m?.key || null;
  $('big').hidden = !m;
  if (m) {
    $('big').src = m.url; $('big').alt = `${c.name} — ${m.label}`;
    $('big-link').href = m.url;
  } else $('big-link').removeAttribute('href');
  $('big-label').textContent = m ? m.label : 'No reference pictures yet';
  $('big-hint').textContent = m ? m.hint : '';
  const strip = $('strip');
  strip.innerHTML = '';
  strip.hidden = media.length < 2;
  for (const x of media) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'thumb' + (x.key === showing ? ' active' : '');
    b.title = x.label;
    b.innerHTML = `<img src="${esc(x.thumbUrl)}" alt="" loading="lazy"><span class="cap">${esc(x.label)}</span>`;
    b.addEventListener('click', () => { showing = x.key; renderViewer(c); syncUrl(); });
    strip.appendChild(b);
  }
}

function renderPictures(c) {
  const list = picturesOf(c);
  $('pictures-title').textContent = `Pictures with ${c.name}${list.length ? ` · ${list.length}` : ''}`;
  const box = $('pictures');
  box.innerHTML = '';
  for (const r of list) {
    const a = document.createElement('a');
    a.className = 'thumb' + (r.missing ? ' missing' : '');
    a.href = `/?image=${encodeURIComponent(r.id)}`;
    a.title = r.title || r.originalPrompt || '';
    const others = (r.characters || []).filter((x) => x.id !== c.id).map((x) => x.name);
    a.innerHTML = `<img src="${esc(r.thumbUrl || r.url)}" alt="" loading="lazy">${others.length ? `<span class="badge char" title="Also with ${esc(others.join(', '))}">+${others.length}</span>` : ''}<span class="cap">${esc(r.title || r.originalPrompt || 'Untitled')}</span>`;
    box.appendChild(a);
  }
  $('pictures-empty').hidden = list.length > 0;
  $('pictures-empty').textContent = `${c.name} is not in any picture yet.`;
}

function renderSwitcher() {
  const box = $('switcher');
  box.innerHTML = '';
  for (const c of characters) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'char-chip' + (c.id === currentId ? ' on' : '');
    b.innerHTML = `${portrait(c) ? `<img src="${esc(portrait(c).thumbUrl)}" alt="">` : ''}<span>${esc(c.name)}</span>`;
    b.addEventListener('click', () => openCharacter(c.id));
    box.appendChild(b);
  }
}

function render() {
  const isNew = currentId === 'new';
  const c = isNew ? null : characters.find((x) => x.id === currentId) || null;
  if (!c && !isNew) currentId = null;
  $('cast-view').hidden = !!c || isNew;
  $('one-view').hidden = !c;
  $('new-view').hidden = !isNew;
  document.title = `${c ? c.name : isNew ? 'New character' : 'Characters'} — Dadventures`;
  $('topbar-meta').textContent = plural(characters.length, 'character');
  syncHead(c, isNew);
  if (isNew) { if (!designing) $('new-ask').focus(); return; }
  if (!c) return renderCast();
  renderSwitcher(); renderViewer(c); renderProfile(c); renderPictures(c);
}

// One character: the header bar names them, shows their face and carries the way back.
function syncHead(c, isNew = currentId === 'new') {
  const sh = window.dvShell;
  if (!sh) return;
  if (isNew) { sh.setHead({ back: { label: 'All characters', run: () => openCharacter(null) }, title: 'New character', sub: 'from a description' }); sh.setMascot(null); return; }
  sh.setHead(c ? { back: { label: 'All characters', run: () => openCharacter(null) }, title: c.name, sub: plural(picturesOf(c).length, 'picture') } : { sub: characters.length ? `${plural(characters.length, 'character')} · the crew behind every bedtime story` : null });
  sh.setMascot(c && c.refs && c.refs[0] ? { url: c.refs[0].thumbUrl, name: c.name } : null);
}
document.addEventListener('dv-shell', () => syncHead(characters.find((x) => x.id === currentId) || null));

function openCharacter(id) {
  currentId = id; showing = null;
  render(); syncUrl();
  window.scrollTo(0, 0);
}

// ---------- a new character from a description ----------
async function streamApi(path, body, onProgress) {
  const res = await fetch(`${path}?stream=1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `Request failed (${res.status})`); }
  const reader = res.body.getReader(), dec = new TextDecoder();
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

const NOTE_FIELDS = ['personality', 'loves', 'worries', 'voice', 'quirks', 'world'];
const FORM_FIELDS = ['name', 'brief', 'style', ...NOTE_FIELDS];
const formValues = () => Object.fromEntries(FORM_FIELDS.map((k) => [k, $(`new-${k}`).value.trim()]));
let undoValues = null;   // the form before the last AI enhance

async function enhanceForm() {
  const v = formValues(), idea = $('new-ask').value.trim();
  if (!idea && !Object.values(v).some(Boolean)) { newStatus('Write a sentence or two about the character in the briefing box first.', 'error'); $('new-ask').focus(); return; }
  $('new-enhance').disabled = true;
  newStatus('<span class="spinner"></span>Filling in the details…');
  try {
    const res = await fetch('/api/cards/characters/enhance', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea, ...v }) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `Request failed (${res.status})`);
    undoValues = v;
    let changed = 0;
    for (const k of FORM_FIELDS) {
      const el = $(`new-${k}`);
      if (r[k] && r[k] !== el.value.trim()) { el.value = r[k]; el.classList.add('ai-filled'); changed++; }
    }
    $('new-undo').hidden = false;
    newStatus(`${changed ? `Filled in ${changed} field${changed === 1 ? '' : 's'} (highlighted).` : 'Nothing needed changing.'} Check them, edit anything you like, then create the character sheet. Change the briefing and run it again for other ideas.`, 'ok');
    $('new-name').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) { newStatus(`AI help failed: ${esc(e.message)}`, 'error'); }
  finally { $('new-enhance').disabled = false; }
}
function undoEnhance() {
  if (!undoValues) return;
  for (const k of FORM_FIELDS) { $(`new-${k}`).value = undoValues[k]; $(`new-${k}`).classList.remove('ai-filled'); }
  undoValues = null; $('new-undo').hidden = true;
  newStatus('Put back what you had before.', '');
}

function newStatus(html, kind = '') { $('new-status').className = `status ${kind}`.trim(); $('new-status').innerHTML = html; }

async function createFromDescription() {
  const v = formValues(), { name, brief } = v;
  if ((!name || !brief) && $('new-ask').value.trim()) { newStatus('Click “✨ Fill in the rest” first to turn your briefing into the fields, then check them.', 'error'); $('new-enhance').focus(); return; }
  if (!name) { newStatus('Give the character a name.', 'error'); $('new-name').focus(); return; }
  if (!brief) { newStatus('Describe the character: what kind of animal or creature, how they look, what they are like.', 'error'); $('new-brief').focus(); return; }
  if (characters.some((c) => c.name.toLowerCase() === name.toLowerCase()) && !confirm(`There is already a character called “${name}”. Create another one with the same name?`)) return;
  designing = true;
  const lock = ['new-ask', 'new-enhance', 'new-undo', 'new-create', ...FORM_FIELDS.map((k) => `new-${k}`)];
  for (const id of lock) $(id).disabled = true;
  const t0 = Date.now();
  let phase = 'Starting';
  const tick = () => newStatus(`<span class="spinner"></span>${esc(phase)}… ${Math.round((Date.now() - t0) / 1000)}s <span class="hint">(keep this tab open)</span>`);
  tick(); const timer = setInterval(tick, 1000);
  try {
    const r = await streamApi('/api/cards/characters/design', v, (p) => { if (p.phase) { phase = p.phase; tick(); } });
    clearInterval(timer);
    characters = await api('/api/characters');
    records = await api('/api/history');
    if (r.error) {
      newStatus(`${esc(name)} was created from the master picture, but the turnaround sheet failed: ${esc(r.error)}. Open <a href="/?character=${encodeURIComponent(r.characterId)}">Edit character</a> to try the sheet again.`, 'error');
      return;
    }
    for (const id of ['new-ask', ...FORM_FIELDS.map((k) => `new-${k}`)]) { $(id).value = ''; $(id).classList.remove('ai-filled'); }
    undoValues = null; $('new-undo').hidden = true;
    newStatus('', '');
    openCharacter(r.characterId);
    if (r.bibleError) alert(`${name} is ready with a master picture and turnaround sheet, but the character bible failed: ${r.bibleError}\n\nUse “Edit character” → “Generate character sheets” to try again.`);
  } catch (e) {
    clearInterval(timer);
    newStatus(`Could not create the character: ${esc(e.message)}`, 'error');
    characters = await api('/api/characters').catch(() => characters);
  } finally {
    designing = false;
    for (const id of lock) $(id).disabled = false;
  }
}

function readUrl() {
  currentId = urlState.get('character');
  showing = urlState.get('show');
  $('search').value = urlState.get('q') || '';
  render();
}

async function init() {
  $('search').addEventListener('input', () => { renderCast(); syncUrl(); });
  $('back').addEventListener('click', () => openCharacter(null));
  $('new-back').addEventListener('click', () => openCharacter(null));
  $('new-btn').addEventListener('click', (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); openCharacter('new'); });
  $('new-create').addEventListener('click', createFromDescription);
  $('new-enhance').addEventListener('click', enhanceForm);
  $('new-undo').addEventListener('click', undoEnhance);
  $('new-ask').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enhanceForm(); } });
  // A highlighted (AI-filled) field counts as checked once you edit it.
  for (const k of FORM_FIELDS) $(`new-${k}`).addEventListener('input', (e) => e.target.classList.remove('ai-filled'));
  urlState.onChange(readUrl);
  try {
    [characters, records] = await Promise.all([api('/api/characters'), api('/api/history')]);
  } catch (e) {
    $('topbar-meta').textContent = '';
    $('cast-empty').hidden = false;
    $('cast-empty').textContent = `Could not load the characters: ${e.message}`;
    return;
  }
  readUrl();
}
init();
