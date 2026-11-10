// The shared page shell: turns the old top bar into the navy sidebar and adds the header bar above each page.
// Every page keeps its own <header class="topbar"> in the HTML, so with this script (and theme.css) removed
// the app falls back to the original top navigation.
(() => {
  const BRAND = { name: 'DADVENTURES', tagline: 'Captain Dad speaking' };
  const ICONS = {
    books: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    cards: '<rect x="4" y="7" width="13" height="14" rx="2"/><path d="M8 4h10a2 2 0 0 1 2 2v12"/>',
    characters: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    images: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    print: '<path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="7" rx="1"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>',
    costs: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M15 9.5c0-1.4-1.3-2-3-2s-3 .6-3 2 1.3 2 3 2.5 3 1.1 3 2.5-1.3 2-3 2-3-.6-3-2"/>',
  };
  const PLANE = 'M12 2.5c.9 0 1.4 1 1.4 2.2v4.4l7.6 4.5v2l-7.6-2.2v4.2l2.3 1.7v1.5L12 19.9l-3.7.9v-1.5l2.3-1.7v-4.2L3 15.6v-2l7.6-4.5V4.7c0-1.2.5-2.2 1.4-2.2z';
  // Work order: make things in the hangar, with the crew, then take off for the printer. Costs is the logbook.
  const SECTIONS = [
    { key: 'books', href: '/books.html', label: 'Story Books', bay: '01', group: 'The Hangar', color: '#d85a4c', sub: 'File a flight plan: one idea. Even a silly one. Especially a silly one.',
      jokes: ['What’s a pilot’s favourite bedtime story? Anything with a smooth landing.', 'Why did the picture book go to flight school? It wanted a better plot.', 'I’m reading a book about anti-gravity. It’s impossible to put down.'] },
    { key: 'cards', href: '/cards.html', label: 'Flash Cards', bay: '02', group: 'The Hangar', color: '#e8ac25', sub: 'Pick a template, say what it is about, and the studio does the heavy lifting. (Lift with your knees.)',
      jokes: ['I made a flash card about takeoffs. It really got off the ground.', 'I made a flash card about procrastination. I’ll show you later.'] },
    { key: 'characters', href: '/characters.html', label: 'Characters', bay: '03', group: 'The Crew', color: '#4f8fc8', sub: 'The crew behind every bedtime story.',
      jokes: ['Why won’t Crab share his snacks? He’s a little shellfish.', 'What do you call a fish with no eyes? A fsh.'] },
    { key: 'images', href: '/', label: 'Images', bay: '04', group: 'The Crew', color: '#33a8a2', sub: 'One-off pictures and posters. Fridge-worthy, every time.',
      jokes: ['How do pilots take pictures? On the fly.', 'I told the picture a joke. It was framed.'] },
    { key: 'print', href: '/sheets.html', label: 'Print Sheets', bay: '05', group: 'Takeoff', color: '#62a858', sub: 'From screen to sticky little hands, by way of the print shop.',
      jokes: ['I asked the printer for a flight plan. It gave me a paper plane.', 'The printer and I have a lot in common. We both jam under pressure.'] },
    { key: 'costs', href: '/costs.html', label: 'Costs', bay: '06', group: 'Logbook', color: '#b07e58', sub: 'Where the fuel money went. No receipts were harmed.',
      jokes: ['Why did Dad stare at the receipt? He was trying to budge-it.', 'I’d tell you a joke about the budget, but I can’t afford the punchline.'] },
  ];
  const path = location.pathname === '/index.html' ? '/' : location.pathname;
  const here = SECTIONS.find((s) => s.href === path) || SECTIONS.find((s) => s.key === 'images');
  const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const day = Math.floor(Date.now() / 864e5);

  const navItem = (s) => `<a class="dv-nav${s === here ? ' on' : ''}" href="${s.href}" style="--c:${s.color}"${s === here ? ' aria-current="page"' : ''}><i>${svg(ICONS[s.key])}</i><span>${s.label}</span><small>${s.bay}</small></a>`;
  const groups = [];
  for (const s of SECTIONS.filter((x) => x.key !== 'costs')) (groups.find((g) => g.name === s.group) || groups[groups.push({ name: s.group, items: [] }) - 1]).items.push(s);
  const costs = SECTIONS.find((s) => s.key === 'costs');

  const side = document.createElement('aside');
  side.className = 'dv-side';
  side.innerHTML = `
    <a class="dv-brand" href="/books.html"><span class="dv-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PLANE}"/></svg></span>
      <span><div class="dv-word">${BRAND.name}</div><div class="dv-tag">${BRAND.tagline}</div></span></a>
    <div class="dv-runway" aria-hidden="true"></div>
    <nav aria-label="Sections">${groups.map((g) => `<div class="dv-group">${g.name}</div>${g.items.map(navItem).join('')}`).join('')}</nav>
    <div class="dv-spacer"></div>
    <div class="dv-card"><b>DAD JOKE OF THE DAY</b><span>${esc(here.jokes[day % here.jokes.length])}</span></div>
    <div class="dv-group">${costs.group}</div>
    <div class="dv-card" id="dv-spend" hidden><small>Fuel burned</small><span class="dv-amount"></span><small class="dv-calls"></small></div>
    <nav aria-label="Costs">${navItem(costs)}</nav>`;

  const head = document.createElement('div');
  head.className = 'dv-head';
  head.innerHTML = `<div class="dv-mascot" id="dv-mascot">${svg(ICONS[here.key])}</div>
    <div class="dv-titles"><div class="dv-bay">Bay ${here.bay} · ${here.group}</div><h1 class="dv-title">${here.label}</h1><div class="dv-sub">${esc(here.sub)}</div></div>`;

  const main = document.querySelector('main');
  if (!main) return;
  const wrap = document.createElement('div');
  wrap.className = 'dv-main';
  main.before(wrap);
  wrap.append(head, main);
  wrap.before(side);
  const meta = document.getElementById('topbar-meta');      // the pages write model and folder info here
  if (meta) head.append(meta);
  document.body.dataset.section = here.key;
  document.documentElement.classList.add('dv-on');

  // Each section has a guide: one of your own characters, if you have made any.
  fetch('/api/characters').then((r) => (r.ok ? r.json() : [])).then((chars) => {
    const withFace = chars.filter((c) => c.refs && c.refs[0]);
    if (!withFace.length) return;
    const c = withFace[SECTIONS.indexOf(here) % withFace.length];
    const m = document.getElementById('dv-mascot');
    m.style.backgroundImage = `url("${c.refs[0].thumbUrl}")`;
    m.title = c.name;
    m.innerHTML = '';
  }).catch(() => {});
  fetch('/api/ai/summary').then((r) => (r.ok ? r.json() : null)).then((s) => {
    if (!s) return;
    const box = document.getElementById('dv-spend');
    box.querySelector('.dv-amount').textContent = `$${s.totalUsd.toFixed(2)}`;
    box.querySelector('.dv-calls').textContent = `${s.calls} call${s.calls === 1 ? '' : 's'} · still cheaper than avgas`;
    box.hidden = false;
  }).catch(() => {});
})();
