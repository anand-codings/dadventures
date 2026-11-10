// Characters page: everyone in the cast at a glance, and one page per character with their
// reference pictures, sheets, written profile and every picture they appear in.
// Creating and editing still happens in the editor on the Images page; this page links there.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let characters = [];
let records = [];        // history, newest first
let currentId = null;
let showing = null;      // key of the picture in the big viewer

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
  const list = characters.filter((c) => !q || [c.name, c.description, c.personality, c.style, profileOf(c).epithets].join(' ').toLowerCase().includes(q));
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
    : 'No characters yet. <a href="/?character=new">Create one</a> from your own reference pictures, or save one from any generated image on the Images page.';
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
    ${section('Wants and worries', para(p.wantAndWorry))}
    ${section('Usual mood', para(p.moodBaseline))}
    ${section('Habits', bullets(p.habits))}
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
  const c = characters.find((x) => x.id === currentId) || null;
  if (!c) currentId = null;
  $('cast-view').hidden = !!c;
  $('one-view').hidden = !c;
  document.title = `${c ? c.name : 'Characters'} — Dadventures`;
  $('topbar-meta').textContent = plural(characters.length, 'character');
  if (!c) return renderCast();
  renderSwitcher(); renderViewer(c); renderProfile(c); renderPictures(c);
}

function openCharacter(id) {
  currentId = id; showing = null;
  render(); syncUrl();
  window.scrollTo(0, 0);
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
