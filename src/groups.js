// Character groups: crews of studio characters who belong together (a family, a reef gang, a classroom),
// with how they relate to each other and the storylines that run across their stories — a shared universe
// the story writers build on. Stored in output/characters/groups.json; the stories each group has had together
// are worked out from the Flash Cards series and Story Books on disk, never stored twice.
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';

export const GROUP_TEXT_FIELDS = { about: 1000, relationships: 2000, arcs: 2000 };
const MAX_MEMBERS = 12;

export function createGroups(deps) {
  const { OUTPUT_DIR, HttpError, readJson, send, clampStr, appendLog, readJsonFile, writeJsonAtomic, readCharacters } = deps;
  const FILE = path.join(OUTPUT_DIR, 'characters', 'groups.json');
  const SERIES_DIR = path.join(OUTPUT_DIR, 'cards', 'series');
  const BOOKS_DIR = path.join(OUTPUT_DIR, 'books');

  // Kept in memory so the story writers (which build their prompts synchronously) can read it.
  let groups = [];
  let stories = [];
  let lock = Promise.resolve();
  const ready = (async () => { groups = await readJsonFile(FILE, []); stories = await scanStories().catch(() => []); })();

  function withGroups(fn) {
    const run = lock.then(async () => {
      await ready;
      await fsp.mkdir(path.dirname(FILE), { recursive: true });
      const list = await readJsonFile(FILE, []);
      const result = await fn(list);
      await writeJsonAtomic(FILE, list);
      groups = list;
      return result;
    });
    lock = run.catch(() => {});
    return run;
  }

  // Every story with the studio characters in it: who actually appears (linked cast), else who was picked in the brief.
  async function scanStories() {
    const out = [];
    const read = async (dir) => Promise.all((await fsp.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json')).map((n) => readJsonFile(path.join(dir, n), null)));
    const linked = (x) => [...new Set([...(x.cast || []).map((c) => c.characterId), ...(x.brief?.characterIds || [])].filter(Boolean))];
    for (const s of await read(SERIES_DIR)) {
      if (!s || !s.id || s.brief?.kind !== 'story') continue;
      out.push({ id: s.id, kind: 'series', title: s.title || 'Untitled story', logline: s.logline || '', createdAt: s.createdAt || '', characterIds: linked(s), url: `/cards.html?series=${s.id}` });
    }
    for (const b of await read(BOOKS_DIR)) {
      if (!b || !b.id || b.fromSeries || out.some((x) => x.id === b.id)) continue; // series mirrors are counted once, as the series
      out.push({ id: b.id, kind: 'book', title: b.title || 'Untitled book', logline: b.logline || '', createdAt: b.createdAt || '', characterIds: linked(b), url: `/books.html?book=${b.id}` });
    }
    return out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  // A story belongs to a group's timeline when at least two members are in it (or the group's only member, for a group of one).
  const storiesOf = (g, list = stories) => list.filter((s) => s.characterIds.filter((id) => g.characterIds.includes(id)).length >= Math.min(2, g.characterIds.length));

  // Crews nobody has grouped yet: characters linked by having been in stories together (connected clusters of two or more).
  function suggestions(list, chars) {
    const known = new Set(chars.map((c) => c.id));
    const parent = new Map();
    const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
    for (const s of list) {
      const ids = s.characterIds.filter((id) => known.has(id));
      for (const id of ids) if (!parent.has(id)) parent.set(id, id);
      for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
    }
    const clusters = new Map();
    for (const id of parent.keys()) { const r = find(id); clusters.set(r, [...(clusters.get(r) || []), id]); }
    return [...clusters.values()].filter((ids) => ids.length >= 2)
      // Already covered: one group holds the whole cluster.
      .filter((ids) => !groups.some((g) => ids.every((id) => g.characterIds.includes(id))))
      .map((ids) => {
        const together = list.filter((s) => s.characterIds.filter((id) => ids.includes(id)).length >= 2);
        // Lead the name with whoever is in the most of those stories.
        const lead = ids.map((id) => [id, together.filter((s) => s.characterIds.includes(id)).length]).sort((a, b) => b[1] - a[1])[0][0];
        return { characterIds: ids.sort((a, b) => (a === lead ? -1 : b === lead ? 1 : 0)), stories: together.length, name: `${chars.find((c) => c.id === lead)?.name.split(' ')[0] || 'New'}’s crew` };
      })
      .sort((a, b) => b.stories - a.stories);
  }

  async function list() {
    await ready;
    stories = await scanStories();
    const chars = await readCharacters();
    const known = new Set(chars.map((c) => c.id));
    return {
      groups: groups.map((g) => ({ ...g, characterIds: g.characterIds.filter((id) => known.has(id)), stories: storiesOf(g).map(({ characterIds, ...s }) => ({ ...s, characterIds: characterIds.filter((id) => g.characterIds.includes(id)) })) })),
      suggestions: suggestions(stories, chars),
    };
  }

  async function clean(body, prev = {}) {
    const out = {};
    if ('name' in body || !prev.name) { out.name = clampStr(body.name, 80); if (!out.name) throw new HttpError(400, 'Give the group a name.'); }
    for (const [k, max] of Object.entries(GROUP_TEXT_FIELDS)) if (k in body) out[k] = clampStr(body[k], max);
    if ('characterIds' in body || !prev.characterIds) {
      const all = await readCharacters();
      out.characterIds = [...new Set((Array.isArray(body.characterIds) ? body.characterIds : []).map(String))].filter((id) => all.some((c) => c.id === id)).slice(0, MAX_MEMBERS);
      if (!out.characterIds.length) throw new HttpError(400, 'Pick at least one character for the group.');
    }
    return out;
  }

  async function create(body) {
    const fields = await clean(body);
    const g = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), name: '', about: '', relationships: '', arcs: '', characterIds: [], ...fields };
    await withGroups((all) => all.push(g));
    await appendLog({ type: 'group_created', id: g.id, name: g.name, characterIds: g.characterIds });
    return g;
  }
  async function update(id, body) {
    const g = await withGroups(async (all) => {
      const g = all.find((x) => x.id === id);
      if (!g) throw new HttpError(404, 'Group not found.');
      Object.assign(g, await clean(body, g), { updatedAt: new Date().toISOString() });
      return g;
    });
    await appendLog({ type: 'group_updated', id, name: g.name, characterIds: g.characterIds });
    return g;
  }
  async function remove(id) {
    const g = await withGroups((all) => { const i = all.findIndex((x) => x.id === id); if (i < 0) throw new HttpError(404, 'Group not found.'); return all.splice(i, 1)[0]; });
    await appendLog({ type: 'group_deleted', id, name: g.name });
    return { deleted: id };
  }

  // For the story writers: every group with at least two of this story's characters (or a one-member group whose
  // member is in it), with its relationships, running storylines and the stories it has already had.
  // excludeId: the story being written, so it is not listed as an earlier one.
  function writerText(chars, excludeId) {
    const ids = (chars || []).map((c) => c.id);
    const hit = groups.filter((g) => g.characterIds.length && g.characterIds.filter((id) => ids.includes(id)).length >= Math.min(2, g.characterIds.length));
    if (!hit.length) return '';
    return hit.map((g) => {
      const past = storiesOf(g).filter((s) => s.id !== excludeId).slice(-8);
      return [
        `GROUP "${g.name}" — these characters belong together and share ongoing stories, like one shared universe. Keep their relationships and history consistent, and let this story add a new chapter rather than retell an old one.`,
        g.about && `What the group is about: ${g.about}`,
        g.relationships && `How they relate to each other: ${g.relationships}`,
        g.arcs && `Running storylines (weave one of these forward a little where it fits; do not resolve everything at once): ${g.arcs}`,
        past.length && `Their stories so far, oldest first (a returning detail or callback is welcome; do not repeat a plot):\n${past.map((s) => `- ${s.title}${s.logline ? `: ${s.logline}` : ''}`).join('\n')}`,
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  }

  async function route(req, res, p) {
    if (p === '/api/groups' && req.method === 'GET') { send(res, 200, await list()); return true; }
    if (p === '/api/groups' && req.method === 'POST') { send(res, 200, await create(await readJson(req))); return true; }
    const m = /^\/api\/groups\/([a-f0-9-]{36})$/.exec(p);
    if (m && req.method === 'PATCH') { send(res, 200, await update(m[1], await readJson(req))); return true; }
    if (m && req.method === 'DELETE') { send(res, 200, await remove(m[1])); return true; }
    return false;
  }

  return { route, writerText, list, ready };
}
