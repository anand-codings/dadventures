// Keeps what is on screen in the query string, so every view, tab and setting has its own link.
// Pages call urlState.set() whenever state changes and read it back with get() on load and on Back/Forward.
// (window.history is spelled out because app.js has its own global called `history`.)
window.urlState = (() => {
  let params = new URLSearchParams(location.search);
  let timer = null;
  const text = (v) => (Array.isArray(v) ? v.join(',') : v === true ? '1' : v == null || v === false ? '' : String(v));
  const here = () => location.pathname + location.search + location.hash;
  function write(push = false) {
    clearTimeout(timer); timer = null;
    const qs = params.toString().replace(/%2C/gi, ',').replace(/%2F/gi, '/').replace(/%3A/gi, ':');
    const url = location.pathname + (qs ? `?${qs}` : '') + location.hash;
    if (url === here()) return;
    try { window.history[push ? 'pushState' : 'replaceState'](null, '', url); } catch { /* browser rate limit; the next write catches up */ }
  }
  // Registered before any page script, so pages always read the URL the browser just moved to.
  window.addEventListener('popstate', () => { clearTimeout(timer); timer = null; params = new URLSearchParams(location.search); });
  return {
    get: (k) => params.get(k),
    list: (k) => (params.get(k) || '').split(',').filter(Boolean),
    any: () => [...params.keys()].length > 0,
    // patch: { key: value }. Empty, null, false, or equal to defaults[key] removes the key from the URL.
    // pushOn: keys whose change is a navigation step (adds a Back entry); other changes rewrite the current entry.
    set(patch, { defaults = {}, pushOn = [] } = {}) {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        const s = text(v);
        if (s === '' || (k in defaults && s === text(defaults[k]))) next.delete(k); else next.set(k, s);
      }
      const push = pushOn.some((k) => (params.get(k) || '') !== (next.get(k) || ''));
      if (push) write();                       // settle earlier small changes into the entry being left
      params = next;
      if (push) write(true);
      else { clearTimeout(timer); timer = setTimeout(write, 120); }
    },
    onChange(fn) { window.addEventListener('popstate', fn); },
  };
})();
