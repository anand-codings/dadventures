// Groups page: crews of characters who belong together, with how they relate, the storylines that run across
// their stories, and a timeline of every story they have had together. Suggests crews from who has already
// shared a story. The group notes go to the story writers whenever two members share a story.
// ?group=<id> opens one group; ?group=new a blank one (&members=<id,id> pre-picks a suggested crew).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const plural = (n, word) => `${n} ${n === 1 ? word : word.endsWith('y') ? word.slice(0, -1) + 'ies' : word + 's'}`;
  const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };

  let chars = [], groups = [], suggestions = [], loaded = false;
  let editing = null;          // the open group (null id = not saved yet); null = the list
  let members = new Set();
  let saved = '';              // the form as last loaded or saved, to warn before leaving unsaved edits
  const newBtn = $('group-new');

  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const charOf = (id) => chars.find((c) => c.id === id);
  const face = (c, cls = '') => (c ? (c.refs?.[0] ? `<img class="${cls}" src="${esc(c.refs[0].thumbUrl)}" alt="${esc(c.name)}" title="${esc(c.name)}" loading="lazy">` : `<span class="${cls} no-face" title="${esc(c.name)}">${esc(c.name[0] || '?')}</span>`) : '');
  const faces = (ids, max = 6) => {
    const list = ids.map(charOf).filter(Boolean);
    return `<div class="group-faces">${list.slice(0, max).map((c) => face(c)).join('')}${list.length > max ? `<span class="no-face more">+${list.length - max}</span>` : ''}</div>`;
  };
  const names = (ids) => ids.map(charOf).filter(Boolean).map((c) => c.name).join(', ');
  const blank = (ids = []) => ({ id: null, name: '', about: '', relationships: '', arcs: '', characterIds: ids, stories: [] });
  const formState = () => JSON.stringify({ name: $('group-name').value.trim(), characterIds: [...members], about: $('group-about').value, relationships: $('group-relationships').value, arcs: $('group-arcs').value });
  const dirty = () => Boolean(editing) && formState() !== saved;

  // ---------- the list ----------
  function renderList() {
    const grid = $('groups');
    grid.innerHTML = '';
    for (const g of groups) {
      const card = document.createElement('a');
      card.className = 'group-card';
      card.href = `/groups.html?group=${encodeURIComponent(g.id)}`;
      card.innerHTML = `${faces(g.characterIds)}
        <div class="group-name">${esc(g.name)}</div>
        <div class="group-meta">${plural(g.characterIds.length, 'character')} · ${plural(g.stories.length, 'story')} together</div>
        ${g.about ? `<div class="group-about">${esc(g.about)}</div>` : `<div class="group-about hint">${esc(names(g.characterIds)) || 'No members yet'}</div>`}`;
      card.onclick = (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go(g.id); };
      grid.appendChild(card);
    }
    for (const s of suggestions) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'group-card suggested';
      card.innerHTML = `${faces(s.characterIds)}
        <div class="group-name">${esc(names(s.characterIds))}</div>
        <div class="group-meta">Suggested · together in ${plural(s.stories, 'story')}</div>
        <div class="group-about"><span class="link">+ Make them a group</span></div>`;
      card.onclick = () => go('new', s.characterIds, s.name);
      grid.appendChild(card);
    }
    $('groups-empty').hidden = groups.length + suggestions.length > 0;
  }

  // ---------- one group ----------
  function renderMembers() {
    const box = $('group-members');
    box.innerHTML = chars.length ? '' : '<span class="hint">No characters yet. <a href="/characters.html?character=new">Make one</a> first.</span>';
    for (const c of chars) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'char-chip' + (members.has(c.id) ? ' on' : '');
      chip.innerHTML = `${c.refs?.[0] ? `<img src="${esc(c.refs[0].thumbUrl)}" alt="">` : ''}${esc(c.name)}`;
      chip.onclick = () => { members.has(c.id) ? members.delete(c.id) : members.add(c.id); renderMembers(); syncHead(); };
      box.appendChild(chip);
    }
  }
  function renderTimeline(g) {
    const box = $('group-timeline');
    if (!g.id) { box.innerHTML = '<div class="hint">Save the group to see the stories they have had together.</div>'; return; }
    if (!g.stories.length) { box.innerHTML = '<div class="hint">No stories together yet. Pick two or more of them in Flash Cards or Story Books and this group’s notes go to the writer.</div>'; return; }
    box.innerHTML = `<ol class="timeline">${g.stories.map((s, i) => `
      <li><span class="tl-n">${i + 1}</span>
        <div class="tl-body">
          <a href="${esc(s.url)}"><b>${esc(s.title)}</b></a> <span class="hint">${esc(fmtDate(s.createdAt))}${s.kind === 'book' ? ' · Story Book' : ' · Flash Cards'}</span>
          ${s.logline ? `<div class="tl-log">${esc(s.logline)}</div>` : ''}
          <div class="tl-who">${s.characterIds.map((id) => face(charOf(id), 'tiny')).join('')}</div>
        </div></li>`).join('')}</ol>`;
  }
  function fill(g) {
    editing = g;
    members = new Set(g.characterIds);
    $('group-name').value = g.name || '';
    $('group-about').value = g.about || '';
    $('group-relationships').value = g.relationships || '';
    $('group-arcs').value = g.arcs || '';
    $('group-delete').hidden = !g.id;
    $('group-status').textContent = '';
    renderMembers();
    renderTimeline(g);
    saved = formState();
  }

  // The header bar carries where you are: all groups, or one group with a way back.
  function syncHead() {
    const sh = window.dvShell;
    if (!sh) return;
    if (!editing) {
      sh.setHead({ sub: loaded ? (groups.length ? `${plural(groups.length, 'group')}${suggestions.length ? ` · ${plural(suggestions.length, 'suggestion')}` : ''} · crews who share a universe of stories` : 'Crews who share a universe of stories') : null });
      sh.actions.replaceChildren(newBtn);
      sh.setMascot(null);
      return;
    }
    const n = members.size, stories = editing.stories?.length || 0;
    sh.setHead({ back: { label: 'All groups', run: () => go(null) }, title: editing.id ? editing.name : 'New group', sub: `${plural(n, 'character')}${editing.id ? ` · ${plural(stories, 'story')} together` : ' · not saved yet'}` });
    sh.actions.replaceChildren();
    const lead = charOf([...members][0]);
    sh.setMascot(lead?.refs?.[0] ? { url: lead.refs[0].thumbUrl, name: lead.name } : null);
  }
  document.addEventListener('dv-shell', syncHead);

  // ---------- which view is showing follows the URL ----------
  function show() {
    const id = urlState.get('group');
    if (!id) { editing = null; }
    else if (id === 'new') fill({ ...blank(urlState.list('members').filter(charOf)), name: urlState.get('name') || '' });
    else {
      const g = groups.find((x) => x.id === id);
      if (g) fill(g);
      else { editing = null; urlState.set({ group: '', members: '', name: '' }); }
    }
    $('list-view').hidden = Boolean(editing);
    $('group-view').hidden = !editing;
    if (!editing) renderList();
    else if (!editing.id) $('group-name').focus();
    syncHead();
  }
  function go(id, ids = [], name = '') {
    if (dirty() && !confirm('Leave without saving this group?')) return;
    urlState.set({ group: id || '', members: id === 'new' ? ids : '', name: id === 'new' ? name : '' }, { pushOn: ['group'] });
    show();
    window.scrollTo(0, 0);
  }
  urlState.onChange(() => { if (loaded) show(); });
  window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  async function save() {
    const body = JSON.parse(formState());
    if (!body.name) { $('group-status').textContent = 'Give the group a name.'; $('group-name').focus(); return; }
    if (!body.characterIds.length) { $('group-status').textContent = 'Pick at least one character.'; return; }
    $('group-save').disabled = true;
    try {
      const g = await (editing.id ? api('PATCH', `/api/groups/${editing.id}`, body) : api('POST', '/api/groups', body));
      saved = formState();
      await load();
      urlState.set({ group: g.id, members: '', name: '' });   // a new group swaps ?group=new for its own link
      show();
      $('group-status').textContent = '';
      window.dvShell?.flyby?.('Group saved!');
    } catch (e) { $('group-status').textContent = `Could not save: ${e.message}`; }
    finally { $('group-save').disabled = false; }
  }
  async function remove() {
    if (!editing?.id || !confirm(`Delete the group “${editing.name}”? The characters and their stories stay.`)) return;
    try { await api('DELETE', `/api/groups/${editing.id}`); saved = formState(); editing = null; await load(); go(null); }
    catch (e) { $('group-status').textContent = `Could not delete: ${e.message}`; }
  }

  async function load() {
    try {
      const [cs, data] = await Promise.all([api('GET', '/api/characters'), api('GET', '/api/groups')]);
      chars = cs; groups = data.groups; suggestions = data.suggestions;
    } catch (e) {
      $('groups-empty').hidden = false;
      $('groups-empty').textContent = `Could not load the groups: ${e.message}`;
      return false;
    }
    loaded = true;
    return true;
  }

  newBtn.addEventListener('click', () => go('new'));
  $('group-save').addEventListener('click', save);
  $('group-cancel').addEventListener('click', () => { if (editing) fill(editing); go(null); });
  $('back').addEventListener('click', () => go(null));
  $('group-delete').addEventListener('click', remove);
  $('group-name').addEventListener('input', () => { if (editing && !editing.id) syncHead(); });
  document.addEventListener('keydown', (e) => { if (editing && (e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
  load().then((ok) => { if (ok) show(); });
})();
