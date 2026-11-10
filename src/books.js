// Story Books — draft short illustrated books: brief → outline → page scripts → illustrations.
// Self-contained module: storage under output/books/, routes under /api/books. Image generation and
// character consistency are delegated to the studio (handleGenerate, characters) through injected deps.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// Minimal zip writer (stored, no compression: the entries are already-compressed images plus a little text).
function zipStore(entries) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12); cd.writeUInt16LE(date, 14); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data); central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

export const AGE_BANDS = [
  { id: '0-3', label: '0–3 · board book', words: [0, 15], guidance: 'very simple words, repetition, naming and sounds, one idea per page' },
  { id: '3-5', label: '3–5 · picture book', words: [10, 40], guidance: 'short simple sentences, rhythm and gentle repetition, concrete everyday words' },
  { id: '5-8', label: '5–8 · picture book', words: [30, 80], guidance: 'clear sentences with some dialogue, a few fun new words, a satisfying problem and solution' },
  { id: '6-9', label: '6–9 · early reader', words: [60, 140], guidance: 'short paragraphs, dialogue, mild suspense, vocabulary a confident early reader can decode' },
];
const PLACEMENTS = ['top', 'bottom', 'left', 'right'];
// Where a page sits on the narrative arc. Stages run in this order across the book.
export const ARC_STAGES = [
  { id: 'opening', label: 'Opening', hint: 'meet the character and their world' },
  { id: 'problem', label: 'Want / problem', hint: 'something is wanted or goes wrong' },
  { id: 'rising', label: 'Rising action', hint: 'tries, setbacks and discoveries' },
  { id: 'turning', label: 'Turning point', hint: 'the biggest moment; everything changes' },
  { id: 'resolution', label: 'Resolution', hint: 'the problem is solved' },
  { id: 'ending', label: 'Ending', hint: 'a warm closing image; the theme lands' },
];
const ARC_IDS = ARC_STAGES.map((a) => a.id);
const arcLabel = (id) => ARC_STAGES.find((a) => a.id === id)?.label || '';
const STORYLINE_FIELDS = [['want', 'Want'], ['obstacle', 'Obstacle'], ['turningPoint', 'Turning point'], ['resolution', 'Resolution'], ['change', 'What changes']];
// Planning notes kept for every page; they feed the page text and the picture prompt.
const PAGE_META = [['purpose', 500], ['setting', 300], ['emotion', 200], ['continuity', 600]];
const MAX_PAGES = 32;

const OUTLINE_INSTRUCTIONS = `You are an award-winning children's picture-book author and editor. From the user's brief, plan a short illustrated story book.

Craft rules:
- One clear story arc across the pages: an opening that introduces the main character and their world, a want or problem, rising attempts, a turning point, and a warm, satisfying resolution. The last page should land the theme without preaching.
- Each page is one beat: one moment that can be shown in a single illustration. Vary the beats (action, emotion, quiet moments, a page-turn surprise).
- Keep the cast small (usually 1–4 characters). If the brief lists existing characters, use them with exactly those names and do not change their appearance.
- Everything must be age-appropriate for the stated audience, kind, and free of scary or violent content beyond gentle tension.
- styleGuide: one paragraph describing the illustration style that every page will share (medium, line, color palette, lighting, mood, level of detail, backgrounds). If the brief names a style, build on it; if existing characters have an art style, match it.
- cast descriptions: concrete visual details an illustrator can repeat on every page (species or type, size, colors, clothing, distinctive features) plus a few words of personality.
- coverIllustration: the cover scene, with room for the title at the top.
- tone: two to four words. If the brief gives a tone, keep it.
- storyline: the spine of the story in five short lines. want: what the main character wants. obstacle: what stands in the way. turningPoint: the moment everything changes. resolution: how it ends. change: how the main character or their world is different at the end.
- world: the setting bible, one short paragraph. Where and when the story happens, the places it returns to, and the recurring objects with a fixed look (colors, sizes, materials), so that every picture can match. If the brief gives a setting, build on it.

Plan every page in full; these notes are what the writer and the illustrator work from, and the illustrator sees one page at a time:
- beat: 1–2 sentences, what happens on this page. Describe the action only; do not draft the page's read-aloud words here, they are written in a later step.
- arc: the page's stage on the narrative arc: ${ARC_STAGES.map((a) => `${a.id} (${a.hint})`).join(', ')}. Stages run in that order and never go backwards. Every book has an opening, a turning point and an ending; most pages in the middle are rising.
- purpose: one sentence on what this page does for the story: what it sets up, pays off, reveals or changes.
- characters: the names (exactly as in the cast) of every character visible on the page.
- setting: the specific place plus time of day or weather. Use the same wording for pages in the same place.
- emotion: the main character's feeling and the mood of the page, in a few words.
- continuity: what carries over from earlier pages and must be visible here (an object being carried, a change to how a character looks, something found, built or broken, the light getting later). Empty string when nothing carries over.
- Write in English. Return exactly the requested number of pages.`;

const SCRIPT_INSTRUCTIONS = `You are a children's picture-book author working with an illustrator. You are given a book plan (title, theme, cast, style, and a beat for every page). Write the final on-page text and an illustration brief for the requested pages.

Each page comes with planning notes: its stage on the story arc, its purpose, who is in it, the setting, the feeling and what carries over from earlier pages. Follow them. The text serves the page's purpose and feeling.

Rules for "text" (the words printed on the page):
- Fit the audience's word range per page exactly; read-aloud rhythm matters. Use repetition, sound words and gentle humor where it fits the tone.
- Keep continuity with the surrounding pages: names, facts and tone must match. Do not repeat what the picture already shows; let the words and picture work together.
- No headings, page numbers, or stage directions in the text.

Rules for "illustration" (sent to the image model; it never sees other pages):
- 40–90 words describing one single moment: setting, which characters appear and where (left/right, foreground/background), their action, pose and expression, key props, time of day and lighting, and camera framing (wide, medium, close-up).
- State the setting from the planning notes, and spell out every carry-over detail (objects held, changes to a character or the scene) so the picture matches the pages around it.
- Refer to characters by name only; do not redescribe their appearance (their look is supplied separately).
- Never ask for text, letters or speech bubbles in the picture.
- Vary framing across pages so the book does not feel repetitive.

"characters": the names (exactly as in the cast) of every character visible on the page; keep the planned characters unless the scene needs a change.
"textPlacement": where the page text will sit over the illustration (top, bottom, left or right); the illustrator keeps that area calm and uncluttered.

If revision instructions are given, apply them to the requested pages while keeping everything else consistent.`;

const IDEAS_INSTRUCTIONS = `You are a children's picture-book author pitching story ideas to an editor. Suggest 4 fresh, specific ideas that fit the brief.
- Each premise is 1–2 sentences: a main character with a clear want, what goes wrong, and a hint of the warm ending.
- Make the four ideas clearly different from each other (for example funny, cozy, adventurous, gentle lesson).
- If the user gave a rough idea, offer four distinct developments of it rather than unrelated stories.
- If existing characters are listed, star them by name.
- Concrete and visual (every page must be easy to illustrate), age-appropriate, no clichéd morals stated outright. English only.`;

const BRIEF_INSTRUCTIONS = `You are a children's picture-book editor completing a story brief before the book is outlined. From the story idea and whatever details the author already chose, fill in every detail so the brief is complete and coherent.
- Keep any detail the author already gave exactly as written; only invent the missing ones, and make them fit the given ones.
- tone: two to four words (for example "cozy, funny, bedtime").
- theme: the lesson or feeling, one to four words.
- setting: where and when the story happens, one concrete sentence an illustrator could draw.
- style: the illustration style in one line (medium, palette, shapes, mood). If existing characters have an art style, match it.
- notes: one or two concrete writing devices that suit the audience and idea (a refrain, counting, sound words, rhyme, a closing line). One or two sentences.
Age-appropriate, concrete, English only.`;

const BRIEF_FIELDS = ['tone', 'theme', 'setting', 'style', 'notes'];
const BRIEF_SCHEMA = { type: 'object', additionalProperties: false, required: BRIEF_FIELDS, properties: Object.fromEntries(BRIEF_FIELDS.map((k) => [k, { type: 'string' }])) };

const DETAILS_INSTRUCTIONS = `You are a children's picture-book editor. You are given a book plan in which some planning notes are missing. Complete the plan without changing the story: do not rewrite beats, text or anything that is already filled in.
- storyline: want, obstacle, turningPoint, resolution, change (how the main character or their world is different at the end), one short line each.
- world: one short paragraph on where and when the story happens, the places it returns to and the recurring objects with a fixed look.
- For every page return: arc (${ARC_IDS.join(', ')}; stages run in that order and never go backwards), purpose (one sentence on what the page does for the story), characters (names exactly as in the cast who are visible on the page), setting (specific place plus time of day or weather; same wording for pages in the same place), emotion (the main character's feeling and the page's mood, a few words), continuity (what carries over from earlier pages and must be visible here; empty string when nothing does).
Return every page, in order. English only.`;

const pageMetaProps = {
  arc: { type: 'string', enum: ARC_IDS },
  purpose: { type: 'string' },
  characters: { type: 'array', items: { type: 'string' } },
  setting: { type: 'string' },
  emotion: { type: 'string' },
  continuity: { type: 'string' },
};
const storylineSchema = { type: 'object', additionalProperties: false, required: STORYLINE_FIELDS.map(([k]) => k), properties: Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, { type: 'string' }])) };
const DETAILS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['storyline', 'world', 'pages'],
  properties: {
    storyline: storylineSchema, world: { type: 'string' },
    pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', ...Object.keys(pageMetaProps)], properties: { n: { type: 'integer', description: 'page number' }, ...pageMetaProps } } },
  },
};

const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'premise', 'tone', 'theme'], properties: {
    title: { type: 'string' }, premise: { type: 'string' }, tone: { type: 'string', description: 'two or three words' }, theme: { type: 'string', description: 'one to three words' },
  } } } },
};

const outlineSchema = (pageCount) => ({
  type: 'object', additionalProperties: false,
  required: ['title', 'logline', 'theme', 'tone', 'styleGuide', 'world', 'storyline', 'cast', 'coverIllustration', 'pages'],
  properties: {
    title: { type: 'string' },
    logline: { type: 'string', description: 'one-sentence summary of the story' },
    theme: { type: 'string', description: 'the lesson or feeling the book leaves with the reader' },
    tone: { type: 'string' },
    styleGuide: { type: 'string' },
    world: { type: 'string' },
    storyline: storylineSchema,
    cast: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'role', 'description'], properties: { name: { type: 'string' }, role: { type: 'string' }, description: { type: 'string' } } } },
    coverIllustration: { type: 'string' },
    pages: { type: 'array', description: `exactly ${pageCount} items, one per page in reading order`, items: { type: 'object', additionalProperties: false, required: ['beat', ...Object.keys(pageMetaProps)], properties: { beat: { type: 'string', description: '1–2 sentences: what happens on this page' }, ...pageMetaProps } } },
  },
});

const SCRIPT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pages'],
  properties: {
    pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'text', 'illustration', 'characters', 'textPlacement'], properties: {
      n: { type: 'integer', description: 'page number' },
      text: { type: 'string' },
      illustration: { type: 'string' },
      characters: { type: 'array', items: { type: 'string' } },
      textPlacement: { type: 'string', enum: PLACEMENTS },
    } } },
  },
};

export function createBooks(deps) {
  const { OUTPUT_DIR, BOOK_MODEL, API_KEY, HttpError, responseText, readJson, send, clampStr, slugify, appendLog,
    readJsonFile, writeJsonAtomic, readCharacters, handleGenerate, handleUpdate, handleCreateCharacter, publicCharacter, identityLine, validateSize,
    IMAGE_MODELS, QUALITIES } = deps;
  const BOOKS_DIR = path.join(OUTPUT_DIR, 'books');
  const bookFile = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Book not found.');
    return path.join(BOOKS_DIR, `${id}.json`);
  };

  // ---------- storage (one JSON per book, mutations serialized) ----------
  // Books written before the outline carried planning notes (and Flash Cards mirrors) get blank ones.
  function normalize(b) {
    b.storyline = { ...Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, ''])), ...(b.storyline || {}) };
    b.world ??= ''; b.brief.setting ??= '';
    for (const p of b.pages) { p.arc ??= ''; for (const [k] of PAGE_META) p[k] ??= ''; }
    return b;
  }
  let lock = Promise.resolve();
  function withBook(id, fn) {
    const run = lock.then(async () => {
      const book = await readJsonFile(bookFile(id), null);
      if (!book) throw new HttpError(404, 'Book not found.');
      normalize(book);
      const result = await fn(book);
      book.updatedAt = new Date().toISOString();
      await writeJsonAtomic(bookFile(id), book);
      return result;
    });
    lock = run.catch(() => {});
    return run;
  }
  async function getBook(id) {
    const book = await readJsonFile(bookFile(id), null);
    if (!book) throw new HttpError(404, 'Book not found.');
    return normalize(book);
  }
  async function listBooks() {
    const out = [];
    for (const name of await fsp.readdir(BOOKS_DIR).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const b = await readJsonFile(path.join(BOOKS_DIR, name), null);
      if (!b?.id) continue;
      const pages = b.pages.filter((p) => p.kind === 'page');
      out.push({ id: b.id, title: b.title || 'Untitled book', premise: b.brief.premise, createdAt: b.createdAt, updatedAt: b.updatedAt,
        pages: pages.length, scripted: pages.filter((p) => p.text).length, illustrated: b.pages.filter((p) => p.imageId).length, coverImageId: b.pages.find((p) => p.kind === 'cover')?.imageId || null, fromSeries: Boolean(b.fromSeries) });
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function cleanBrief(v = {}, prev = {}) {
    const pick = (k, max) => (k in v ? clampStr(v[k], max) : prev[k] ?? '');
    const pageCount = Math.min(MAX_PAGES, Math.max(4, Number(v.pageCount ?? prev.pageCount) || 12));
    return {
      premise: pick('premise', 4000), audience: AGE_BANDS.some((a) => a.id === (v.audience ?? prev.audience)) ? (v.audience ?? prev.audience) : '3-5',
      pageCount, tone: pick('tone', 300), theme: pick('theme', 500), setting: pick('setting', 500), style: pick('style', 1000), notes: pick('notes', 4000),
      characterIds: Array.isArray(v.characterIds) ? v.characterIds.map(String).slice(0, 8) : prev.characterIds || [],
    };
  }
  function cleanImage(v = {}, prev = {}) {
    const model = IMAGE_MODELS.some((m) => m.id === v.model) ? v.model : prev.model || IMAGE_MODELS[0].id;
    const quality = QUALITIES.includes(v.quality) ? v.quality : prev.quality || 'high';
    let size = v.size ? String(v.size) : prev.size || '2048x2048';
    validateSize(size);
    return { model, quality, size, textInImage: 'textInImage' in v ? Boolean(v.textInImage) : Boolean(prev.textInImage) };
  }
  const newPage = (kind, n, fields = {}) => ({ id: crypto.randomUUID(), kind, n, beat: '', arc: '', purpose: '', setting: '', emotion: '', continuity: '', text: '', illustration: '', characters: [], textPlacement: 'bottom', imagePrompt: '', promptAuto: '', imageId: null, imageIds: [], ...fields });

  // ---------- LLM ----------
  // Streams the Responses API so long writing calls can report progress; onText receives the JSON text so far.
  async function llmJson(name, instructions, input, schema, logBase, onText = () => {}) {
    const { type, ...refs } = logBase;
    try {
      const r = await deps.ai.text({ feature: type, refs, model: BOOK_MODEL, instructions, input, effort: 'medium', schema, schemaName: name }, onText);
      return { parsed: r.parsed, durationMs: r.durationMs, usage: r.usage, costUsd: r.costUsd };
    } catch (e) {
      await appendLog({ ...logBase, type: `${type}_failed`, error: e.message, model: BOOK_MODEL });
      throw e;
    }
  }

  // Progress hints read from the partial JSON while it streams.
  const countKey = (text, key) => text.split(`"${key}"`).length - 1;
  function lastString(text, key) {
    const i = text.lastIndexOf(`"${key}"`);
    if (i < 0) return '';
    const m = /^"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text.slice(i));
    return m ? m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
  }

  // Undo: snapshot the AI-written fields before every overwrite (last 10 kept, stripped from API responses).
  const SNAPSHOT_FIELDS = ['title', 'logline', 'theme', 'styleGuide', 'storyline', 'world', 'cast', 'pages', 'stage'];
  function snapshot(b, label) {
    b.snapshots = [...(b.snapshots || []), { at: new Date().toISOString(), label, data: structuredClone(Object.fromEntries(SNAPSHOT_FIELDS.map((k) => [k, b[k]]))) }].slice(-10);
  }
  function publicBook(b) {
    const { snapshots, ...rest } = b;
    return { ...rest, pages: b.pages.map((p) => ({ ...p, ...promptState(b, p) })), undoLabel: snapshots?.length ? snapshots[snapshots.length - 1].label : null };
  }
  async function handleUndo(id) {
    let label;
    const book = await withBook(id, (b) => {
      const snap = (b.snapshots || []).pop();
      if (!snap) throw new HttpError(400, 'Nothing to undo.');
      label = snap.label;
      const current = new Map(b.pages.map((p) => [p.id, p]));
      Object.assign(b, snap.data);
      // Keep images made since the snapshot attached to the pages that still exist.
      for (const p of b.pages) {
        const c = current.get(p.id);
        if (c) { p.imageIds = [...new Set([...p.imageIds, ...c.imageIds])]; p.imageId = c.imageId || p.imageId; }
      }
      if (b.pages.length) b.brief.pageCount = b.pages.filter((p) => p.kind === 'page').length;
      return b;
    });
    await appendLog({ type: 'book_undo', bookId: id, undone: label });
    return { book, undone: label };
  }

  async function handleIdeas(body, progress) {
    const all = await readCharacters();
    const chars = (Array.isArray(body.characterIds) ? body.characterIds : []).map((cid) => all.find((c) => c.id === cid)).filter(Boolean);
    const a = AGE_BANDS.find((x) => x.id === body.audience) || AGE_BANDS[1];
    const input = [
      `Audience: ages ${a.id} (${a.label}).`,
      clampStr(body.premise, 4000) && `Rough idea to develop: ${clampStr(body.premise, 4000)}`,
      clampStr(body.tone, 300) && `Tone: ${clampStr(body.tone, 300)}`,
      clampStr(body.theme, 500) && `Theme: ${clampStr(body.theme, 500)}`,
      clampStr(body.setting, 500) && `Setting: ${clampStr(body.setting, 500)}`,
      clampStr(body.style, 1000) && `Illustration style: ${clampStr(body.style, 1000)}`,
      chars.length && `Existing characters:\n${chars.map((c) => `- ${c.name}: ${identityLine(c)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
    const { parsed, durationMs, usage } = await llmJson('book_ideas', IDEAS_INSTRUCTIONS, input, IDEAS_SCHEMA, { type: 'book_ideas' },
      (t) => progress({ phase: `Brainstorming idea ${Math.min(4, countKey(t, 'title') || 1)} of 4`, snippet: lastString(t, 'title') }));
    const ideas = (parsed.ideas || []).slice(0, 6).map((i) => ({ title: clampStr(i.title, 200), premise: clampStr(i.premise, 1000), tone: clampStr(i.tone, 100), theme: clampStr(i.theme, 100) }));
    await appendLog({ type: 'book_ideas', audience: a.id, seed: clampStr(body.premise, 4000) || null, ideas, model: BOOK_MODEL, usage, durationMs });
    return { ideas };
  }

  // Complete a brief before outlining: returns a value for every detail; the page only fills the blank ones.
  async function handleBriefFill(body, progress) {
    const brief = cleanBrief(body);
    if (!brief.premise) throw new HttpError(400, 'Write a story idea first.');
    const all = await readCharacters();
    const chars = brief.characterIds.map((cid) => all.find((c) => c.id === cid)).filter(Boolean);
    const a = AGE_BANDS.find((x) => x.id === brief.audience) || AGE_BANDS[1];
    const given = BRIEF_FIELDS.filter((k) => brief[k]);
    const input = [
      `Story idea: ${brief.premise}`,
      `Audience: ages ${a.id} (${a.label}); ${a.guidance}. ${brief.pageCount} story pages.`,
      given.length ? `Details the author already chose (keep exactly):\n${given.map((k) => `- ${k}: ${brief[k]}`).join('\n')}` : 'The author has not chosen any details yet.',
      chars.length && `Existing characters:\n${chars.map((c) => `- ${c.name}: ${identityLine(c)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
    const { parsed, durationMs, usage } = await llmJson('book_brief', BRIEF_INSTRUCTIONS, input, BRIEF_SCHEMA, { type: 'book_brief' },
      (t) => progress({ phase: `Filling in the details (${Math.min(BRIEF_FIELDS.length, countKey(t, 'tone') + countKey(t, 'theme') + countKey(t, 'setting') + countKey(t, 'style') + countKey(t, 'notes'))} of ${BRIEF_FIELDS.length})` }));
    const max = { tone: 300, theme: 500, setting: 500, style: 1000, notes: 4000 };
    const filled = Object.fromEntries(BRIEF_FIELDS.map((k) => [k, brief[k] || clampStr(parsed[k], max[k])]));
    await appendLog({ type: 'book_brief', premise: brief.premise, filled: BRIEF_FIELDS.filter((k) => !brief[k]), model: BOOK_MODEL, usage, durationMs });
    return { brief: filled };
  }

  const audienceOf = (book) => AGE_BANDS.find((a) => a.id === book.brief.audience) || AGE_BANDS[1];
  function briefText(book, chars) {
    const b = book.brief, a = audienceOf(book);
    return [
      `Premise: ${b.premise}`,
      `Audience: ages ${a.id} (${a.label}). Style of writing: ${a.guidance}. Words per page: ${a.words[0]}–${a.words[1]}.`,
      `Number of story pages: ${b.pageCount}`,
      b.tone && `Tone: ${b.tone}`,
      b.theme && `Theme / lesson: ${b.theme}`,
      b.setting && `Setting: ${b.setting}`,
      b.style && `Illustration style: ${b.style}`,
      b.notes && `Other notes: ${b.notes}`,
      chars.length && `Existing characters to use (keep these exact names; their look is fixed by reference images):\n${chars.map((c) => `- ${c.name}: ${identityLine(c)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  function planText(book) {
    const a = audienceOf(book);
    const pages = book.pages.filter((p) => p.kind === 'page');
    return [
      `Title: ${book.title}`, `Logline: ${book.logline}`, `Theme: ${book.theme}`,
      `Audience: ages ${a.id}. ${a.guidance}. Words per page: ${a.words[0]}–${a.words[1]}.`,
      book.brief.tone && `Tone: ${book.brief.tone}`,
      `Illustration style: ${book.styleGuide}`,
      STORYLINE_FIELDS.some(([k]) => book.storyline[k]) && `Storyline:\n${STORYLINE_FIELDS.filter(([k]) => book.storyline[k]).map(([k, label]) => `- ${label}: ${book.storyline[k]}`).join('\n')}`,
      book.world ? `World: ${book.world}` : book.brief.setting && `Setting from the brief (the world note is still missing): ${book.brief.setting}`,
      `Cast:\n${book.cast.map((c) => `- ${c.name} (${c.role}): ${c.description}`).join('\n')}`,
      `Pages:\n${pages.map((p) => [
        `Page ${p.n}${p.arc ? ` [${arcLabel(p.arc)}]` : ''}: ${p.beat}`,
        p.purpose && `  Purpose: ${p.purpose}`,
        p.characters.length && `  Characters: ${p.characters.join(', ')}`,
        p.setting && `  Setting: ${p.setting}`,
        p.emotion && `  Feeling: ${p.emotion}`,
        p.continuity && `  Carries over: ${p.continuity}`,
        p.text && `  Current text: ${p.text}`,
      ].filter(Boolean).join('\n')).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }
  // The planning notes of one page as the model returned them, with cast names matched to the book's spelling.
  function cleanMeta(out, castNames) {
    return {
      arc: ARC_IDS.includes(out.arc) ? out.arc : '',
      ...Object.fromEntries(PAGE_META.map(([k, max]) => [k, clampStr(out[k], max)])),
      characters: [...new Set((out.characters || []).map((n) => castNames.get(String(n).toLowerCase())).filter(Boolean))],
    };
  }
  const castNameMap = (cast) => new Map(cast.map((c) => [c.name.toLowerCase(), c.name]));

  async function handleOutline(id, body, progress = () => {}) {
    const book = await getBook(id);
    if (!book.brief.premise) throw new HttpError(400, 'Write a premise first.');
    const all = await readCharacters();
    const chars = book.brief.characterIds.map((cid) => all.find((c) => c.id === cid)).filter(Boolean);
    const extra = clampStr(body.instructions, 2000);
    const input = briefText(book, chars) + (extra ? `\n\nRevision instructions: ${extra}` : '');
    const total = book.brief.pageCount;
    const { parsed, durationMs, usage } = await llmJson('book_outline', OUTLINE_INSTRUCTIONS, input, outlineSchema(total), { type: 'book_outline', bookId: id }, (t) => progress(
      !t.includes('"cast"') ? { phase: 'Finding the title and art style', snippet: lastString(t, 'title') }
        : !t.includes('"pages"') ? { phase: `Creating the cast (${countKey(t, 'role')})`, snippet: lastString(t, 'name') }
          : { phase: `Planning page ${Math.min(total, Math.max(1, countKey(t, 'beat')))} of ${total}`, done: Math.max(0, countKey(t, 'beat') - 1), total, snippet: lastString(t, 'beat') }));
    const updated = await withBook(id, (b) => {
      if (b.pages.length) snapshot(b, 'Re-drafted outline');
      b.title = clampStr(parsed.title, 200); b.logline = clampStr(parsed.logline, 1000); b.theme = clampStr(parsed.theme, 1000);
      b.styleGuide = clampStr(parsed.styleGuide, 2000);
      b.world = clampStr(parsed.world, 2000);
      b.storyline = Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, clampStr(parsed.storyline?.[k], 600)]));
      // The outline settles any detail the brief left blank, so the brief always ends up complete.
      if (!b.brief.tone) b.brief.tone = clampStr(parsed.tone, 300);
      if (!b.brief.theme) b.brief.theme = b.theme.slice(0, 500);
      b.cast = (parsed.cast || []).slice(0, 12).map((c) => {
        const linked = chars.find((x) => x.name.toLowerCase() === clampStr(c.name, 80).toLowerCase());
        return { id: crypto.randomUUID(), name: clampStr(c.name, 80), role: clampStr(c.role, 200), description: linked ? identityLine(linked) : clampStr(c.description, 1000), characterId: linked?.id || null };
      });
      for (const c of chars) if (!b.cast.some((x) => x.characterId === c.id)) b.cast.unshift({ id: crypto.randomUUID(), name: c.name, role: 'main character', description: identityLine(c), characterId: c.id });
      const names = castNameMap(b.cast);
      const planned = (parsed.pages || []).slice(0, b.brief.pageCount).map((p) => ({ beat: clampStr(p.beat, 1000), ...cleanMeta(p, names) }));
      while (planned.length < b.brief.pageCount) planned.push({});
      b.pages = [newPage('cover', 0, { illustration: clampStr(parsed.coverIllustration, 2000), textPlacement: 'top', characters: b.cast.slice(0, 3).map((c) => c.name) }), ...planned.map((fields, i) => newPage('page', i + 1, fields))];
      b.stage = 'outlined';
      return b;
    });
    await appendLog({ type: 'book_outline', bookId: id, title: updated.title, pages: updated.brief.pageCount, model: BOOK_MODEL, usage, durationMs });
    return updated;
  }

  // Fill in whatever planning notes are still blank (older books, hand-added pages) without touching the story.
  async function handleDetails(id, progress = () => {}) {
    const book = await getBook(id);
    const pages = book.pages.filter((p) => p.kind === 'page');
    if (!pages.length) throw new HttpError(400, 'Generate an outline first.');
    if (pages.some((p) => !p.beat && !p.text)) throw new HttpError(400, 'Some pages have no beat yet. Say what happens on them first.');
    const total = pages.length;
    const { parsed, durationMs, usage } = await llmJson('book_details', DETAILS_INSTRUCTIONS, planText(book), DETAILS_SCHEMA, { type: 'book_details', bookId: id },
      (t) => progress(!t.includes('"pages"') ? { phase: 'Working out the storyline' } : { phase: `Planning page ${Math.min(total, Math.max(1, countKey(t, 'n')))} of ${total}`, done: Math.max(0, countKey(t, 'continuity')), total, snippet: lastString(t, 'purpose') }));
    let filled = 0;
    const updated = await withBook(id, (b) => {
      snapshot(b, 'Filled in the outline details');
      for (const [k] of STORYLINE_FIELDS) if (!b.storyline[k]) b.storyline[k] = clampStr(parsed.storyline?.[k], 600);
      if (!b.world) b.world = clampStr(parsed.world, 2000);
      const names = castNameMap(b.cast);
      for (const out of parsed.pages || []) {
        const p = b.pages.find((x) => x.kind === 'page' && x.n === out.n);
        if (!p) continue;
        const meta = cleanMeta(out, names);
        for (const k of ['arc', ...PAGE_META.map(([key]) => key)]) if (!p[k] && meta[k]) { p[k] = meta[k]; filled++; }
        if (!p.characters.length && meta.characters.length) { p.characters = meta.characters; filled++; }
      }
      return b;
    });
    await appendLog({ type: 'book_details', bookId: id, filled, model: BOOK_MODEL, usage, durationMs });
    return updated;
  }

  async function handleScripts(id, body, progress = () => {}) {
    const book = await getBook(id);
    const pages = book.pages.filter((p) => p.kind === 'page');
    if (!pages.length) throw new HttpError(400, 'Generate an outline first.');
    const wanted = Array.isArray(body.pageIds) && body.pageIds.length ? pages.filter((p) => body.pageIds.includes(p.id)) : pages;
    if (!wanted.length) throw new HttpError(400, 'No matching pages.');
    const extra = clampStr(body.instructions, 2000);
    const input = `${planText(book)}\n\nWrite pages: ${wanted.map((p) => p.n).join(', ')}${extra ? `\n\nRevision instructions: ${extra}` : ''}`;
    const total = wanted.length;
    const { parsed, durationMs, usage } = await llmJson('book_scripts', SCRIPT_INSTRUCTIONS, input, SCRIPT_SCHEMA, { type: 'book_scripts', bookId: id, pages: wanted.map((p) => p.n) }, (t) => {
      const k = Math.min(total, Math.max(1, countKey(t, 'n')));
      progress({ phase: total === 1 ? `Rewriting page ${wanted[0].n}` : `Writing page ${wanted[k - 1].n} (${k} of ${total})`, done: Math.max(0, countKey(t, 'textPlacement')), total, snippet: lastString(t, 'text') });
    });
    const castNames = castNameMap(book.cast);
    let written = 0;
    const updated = await withBook(id, (b) => {
      snapshot(b, total === 1 ? `Rewrote page ${wanted[0].n}` : wanted.some((w) => w.text) ? 'Rewrote all pages' : 'Wrote page scripts');
      for (const out of parsed.pages || []) {
        const p = b.pages.find((x) => x.kind === 'page' && x.n === out.n && wanted.some((w) => w.id === x.id));
        if (!p) continue;
        p.text = clampStr(out.text, 4000); p.illustration = clampStr(out.illustration, 2000);
        p.characters = [...new Set((out.characters || []).map((n) => castNames.get(String(n).toLowerCase())).filter(Boolean))];
        p.textPlacement = PLACEMENTS.includes(out.textPlacement) ? out.textPlacement : 'bottom';
        written++;
      }
      if (b.pages.filter((p) => p.kind === 'page').every((p) => p.text)) b.stage = 'scripted';
      return b;
    });
    await appendLog({ type: 'book_scripts', bookId: id, pages: wanted.map((p) => p.n), written, instructions: extra || null, model: BOOK_MODEL, usage, durationMs });
    return updated;
  }

  // ---------- illustrations ----------
  function pagePrompt(book, page) {
    const pages = book.pages.filter((p) => p.kind === 'page').length;
    const present = book.cast.filter((c) => page.characters.includes(c.name));
    const unlinked = present.filter((c) => !c.characterId);
    const isCover = page.kind === 'cover';
    const lines = [
      isCover ? `Front cover illustration for the children's picture book "${book.title}".` : `Children's picture book illustration for "${book.title}", page ${page.n} of ${pages}.`,
      '', `Scene: ${page.illustration || page.beat}`,
    ];
    // Planning notes from the outline: the image model sees one page at a time, so each prompt carries its own context.
    const notes = [
      page.setting && `Setting: ${page.setting}`,
      page.emotion && `Mood: ${page.emotion}`,
      page.continuity && `Carried over from earlier pages (must be visible and match): ${page.continuity}`,
      (book.world || book.brief.setting) && `Story world (the same on every page): ${book.world || book.brief.setting}`,
    ].filter(Boolean);
    if (notes.length) lines.push('', ...notes);
    if (unlinked.length) lines.push('', `Characters (draw them exactly like this on every page):\n${unlinked.map((c) => `- ${c.name}: ${c.description}`).join('\n')}`);
    lines.push('', `Style (identical on every page of the book): ${book.styleGuide || book.brief.style || 'warm, friendly picture-book illustration'}`);
    const area = { top: 'top quarter', bottom: 'bottom quarter', left: 'left third', right: 'right third' }[page.textPlacement] || 'bottom quarter';
    if (isCover) lines.push('', `Text: the title "${book.title}" in large, playful, highly legible lettering across the top. No other text.`);
    else if (book.image.textInImage && page.text) lines.push('', `Text: print exactly this text in the ${area}, in a clean, rounded, highly legible children's-book font on a calm area of the picture: "${page.text.replace(/"/g, "'")}". No other text.`);
    else lines.push('', `Composition: keep the ${area} of the image calm and uncluttered (simple background, no important details) so the page text can be placed there later.`);
    lines.push('', 'Constraints:', '- Full-bleed illustration, no border, no frame, no watermark, no signature.');
    if (!isCover && !(book.image.textInImage && page.text)) lines.push('- No text, letters, numbers, captions or speech bubbles anywhere in the image.');
    return lines.join('\n');
  }

  // ---------- picture prompts ----------
  // The step between page text and pictures: every page gets its image prompt written out so it can be read and
  // edited before anything is drawn. promptAuto remembers what the app composed, so an edited prompt is recognised
  // and a page whose text or brief changed afterwards can be flagged as out of date.
  const canPrompt = (p) => Boolean(p.illustration || p.beat);
  async function handlePrompts(id, body = {}) {
    const only = Array.isArray(body.pageIds) ? new Set(body.pageIds) : null;
    return withBook(id, (b) => {
      let written = 0;
      for (const p of b.pages) {
        if ((only && !only.has(p.id)) || !canPrompt(p)) continue;
        if (p.imagePrompt && p.imagePrompt !== p.promptAuto && !body.force && !only) continue;    // keep prompts the author edited
        p.promptAuto = pagePrompt(b, p);
        p.imagePrompt = p.promptAuto;
        written++;
      }
      if (!written && !b.pages.some(canPrompt)) throw new HttpError(400, 'Write the page text first: a prompt needs a picture brief.');
      return b;
    });
  }
  // What the page shows: is the stored prompt the app's own, was it edited, and has the page moved on since.
  function promptState(book, p) {
    if (!p.imagePrompt) return { promptEdited: false, promptStale: false };
    const edited = p.imagePrompt !== p.promptAuto;
    return { promptEdited: edited, promptStale: canPrompt(p) && pagePrompt(book, p) !== p.promptAuto };
  }

  async function handlePageImage(id, pageId) {
    const book = await getBook(id);
    const page = book.pages.find((p) => p.id === pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    if (!page.illustration && !page.beat) throw new HttpError(400, 'This page needs an illustration brief first.');
    const all = await readCharacters();
    const characterIds = book.cast.filter((c) => c.characterId && page.characters.includes(c.name) && all.some((x) => x.id === c.characterId)).map((c) => c.characterId);
    const prompt = page.imagePrompt || pagePrompt(book, page);      // the prompt reviewed in the Picture prompts step, if there is one
    const label = page.kind === 'cover' ? 'cover' : `page ${page.n}`;
    const r = await handleGenerate({
      prompt, originalPrompt: `${book.title} — ${label}: ${page.illustration || page.beat}`.slice(0, 20000), ...book.image, n: 1, format: 'png',
      characterIds, tags: ['book', slugify(book.title || 'book'), page.kind === 'cover' ? 'cover' : `page-${page.n}`],
    }, { ai: { feature: 'book_page_image', refs: { bookId: id } } });
    const rec = await handleUpdate(r.images[0].id, { title: `${book.title} — ${label}` });
    const updated = await withBook(id, (b) => {
      const p = b.pages.find((x) => x.id === pageId);
      if (p) { p.imageIds = [...(p.imageIds || []), rec.id]; p.imageId = rec.id; }
      return b;
    });
    await appendLog({ type: 'book_page_image', bookId: id, page: label, recordId: rec.id, characterIds, costUsd: rec.costUsd });
    return { book: updated, record: rec };
  }

  // Generate a clean design image for a cast member and turn it into a studio character (reference image + identity fields).
  async function handleDesignCast(id, castId) {
    const book = await getBook(id);
    const c = book.cast.find((x) => x.id === castId);
    if (!c) throw new HttpError(404, 'Cast member not found.');
    const prompt = `Character design for "${c.name}", a character in the children's picture book "${book.title}".

Show ${c.name} once, full body, standing in a friendly, neutral three-quarter pose, facing the viewer, centered on a plain white background.
Appearance: ${c.description}
Style: ${book.styleGuide || book.brief.style || 'warm, friendly picture-book illustration'}

Constraints:
- Plain white background, no scene, no props unless they are part of the character.
- No text, labels or watermarks.`;
    const r = await handleGenerate({ prompt, originalPrompt: `${c.name} — character design for ${book.title}`, model: book.image.model, quality: 'high', size: '1024x1024', format: 'png', n: 1, tags: ['book', slugify(book.title || 'book'), 'character-design'] }, { ai: { feature: 'book_cast_design', refs: { bookId: id } } });
    const rec = await handleUpdate(r.images[0].id, { title: `${c.name} — character design` });
    const character = await handleCreateCharacter({ name: c.name, description: c.description, style: book.styleGuide.slice(0, 300), refs: [{ recordId: rec.id, role: 'identity' }] });
    // A designed character is finished properly: a clean turnaround sheet (the reference used on every page) and the detailed
    // character bible. If either extra step fails the character itself is kept.
    const extras = { sheet: null, bible: null, error: null };
    try {
      if (deps.handleCharacterSheet) extras.sheet = (await deps.handleCharacterSheet(character.id, {}, { refs: { bookId: id } })).record;
      if (deps.characterBible) extras.bible = (await deps.characterBible(character.id, {
        aiRefs: { bookId: id }, storyTitle: book.title, logline: book.logline, role: c.role,
        others: book.cast.filter((x) => x.id !== c.id).map((x) => `${x.name} — ${x.description.slice(0, 160)}`).join(' | '),
        appearances: book.pages.filter((p) => p.characters.includes(c.name) && (p.text || p.beat)).map((p) => `Page ${p.n}: ${p.text || p.beat}`).join('\n'),
      })).record;
    } catch (e) { extras.error = e.message; }
    const updated = await withBook(id, (b) => {
      const cc = b.cast.find((x) => x.id === castId);
      if (cc) cc.characterId = character.id;
      return b;
    });
    await appendLog({ type: 'book_cast_design', bookId: id, name: c.name, recordId: rec.id, characterId: character.id, sheetId: extras.sheet?.id || null, bibleId: extras.bible?.id || null, costUsd: (rec.costUsd || 0) + (extras.sheet?.costUsd || 0) + (extras.bible?.costUsd || 0) });
    return { book: updated, record: rec, character, sheet: extras.sheet, bible: extras.bible, extrasError: extras.error };
  }

  // ---------- CRUD ----------
  async function handleCreate(body) {
    await fsp.mkdir(BOOKS_DIR, { recursive: true });
    const now = new Date().toISOString();
    const book = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, stage: 'brief', brief: cleanBrief(body.brief),
      title: '', logline: '', theme: '', styleGuide: '', world: '', storyline: Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, ''])), cast: [], pages: [], image: cleanImage(body.image) };
    await writeJsonAtomic(bookFile(book.id), book);
    await appendLog({ type: 'book_created', bookId: book.id, premise: book.brief.premise });
    return book;
  }

  async function handlePatch(id, body) {
    const all = 'cast' in body ? await readCharacters() : [];
    return withBook(id, (b) => {
      if (body.brief) b.brief = cleanBrief(body.brief, b.brief);
      if (body.image) b.image = cleanImage(body.image, b.image);
      for (const [k, max] of [['title', 200], ['logline', 1000], ['theme', 1000], ['styleGuide', 2000], ['world', 2000]]) if (k in body) b[k] = clampStr(body[k], max);
      if (body.storyline && typeof body.storyline === 'object') for (const [k] of STORYLINE_FIELDS) if (k in body.storyline) b.storyline[k] = clampStr(body.storyline[k], 600);
      if (Array.isArray(body.cast)) {
        b.cast = body.cast.slice(0, 12).map((c) => ({ id: clampStr(c.id, 64) || crypto.randomUUID(), name: clampStr(c.name, 80), role: clampStr(c.role, 200), description: clampStr(c.description, 1000),
          characterId: c.characterId && all.some((x) => x.id === c.characterId) ? c.characterId : null })).filter((c) => c.name);
      }
      if (Array.isArray(body.pages)) {
        for (const patch of body.pages) {
          const p = b.pages.find((x) => x.id === patch.id);
          if (!p) continue;
          for (const [k, max] of [['beat', 1000], ['text', 4000], ['illustration', 2000], ...PAGE_META]) if (k in patch) p[k] = clampStr(patch[k], max);
          if ('arc' in patch) p.arc = ARC_IDS.includes(patch.arc) ? patch.arc : '';
          if ('imagePrompt' in patch) { p.imagePrompt = clampStr(patch.imagePrompt, 8000); if (!p.imagePrompt) p.promptAuto = ''; }
          if (Array.isArray(patch.characters)) p.characters = patch.characters.map((n) => clampStr(n, 80)).filter((n) => b.cast.some((c) => c.name === n));
          if (PLACEMENTS.includes(patch.textPlacement)) p.textPlacement = patch.textPlacement;
          if ('imageId' in patch) p.imageId = p.imageIds.includes(patch.imageId) ? patch.imageId : p.imageId;
        }
      }
      if (body.addPageAfter != null) {
        const n = Number(body.addPageAfter);
        const pages = b.pages.filter((p) => p.kind === 'page');
        if (pages.length >= MAX_PAGES) throw new HttpError(400, `A book can have at most ${MAX_PAGES} pages.`);
        for (const p of pages) if (p.n > n) p.n++;
        b.pages.push(newPage('page', n + 1));
        b.pages.sort((x, y) => x.n - y.n);
        b.brief.pageCount = pages.length + 1;
      }
      if (body.removePage) {
        const i = b.pages.findIndex((p) => p.id === body.removePage && p.kind === 'page');
        if (i >= 0) {
          snapshot(b, `Removed page ${b.pages[i].n}`);
          const [gone] = b.pages.splice(i, 1);
          for (const p of b.pages) if (p.kind === 'page' && p.n > gone.n) p.n--;
          b.brief.pageCount = b.pages.filter((p) => p.kind === 'page').length;
        }
      }
      return b;
    });
  }

  async function handleDelete(id) {
    const book = await getBook(id);
    await fsp.rm(bookFile(id), { force: true });
    await appendLog({ type: 'book_deleted', bookId: id, title: book.title, premise: book.brief.premise });
    return { deleted: id };
  }

  // File name of a page's picture inside a download, numbered so the files sort in reading order: 00-cover.png, 01-page-1.png …
  function pageFileName(b, p, rec) {
    const width = Math.max(2, String(b.pages.filter((x) => x.kind === 'page').length).length);
    const ext = (path.extname(rec.file) || '.png').toLowerCase();
    return `${String(p.n).padStart(width, '0')}-${p.kind === 'cover' ? 'cover' : `page-${p.n}`}${ext}`;
  }
  // Every chosen page picture in reading order as a zip (one folder named after the book); story=true adds story.md,
  // the manuscript with the storyline, page text and planning notes, pointing at the pictures by file name.
  async function exportImagesZip(id, history, story) {
    const b = await getBook(id);
    const byId = new Map(history.map((r) => [r.id, r]));
    const folder = slugify(b.title || 'book') || 'book';
    const entries = [], names = new Map();
    for (const p of b.pages) {
      const rec = p.imageId && byId.get(p.imageId);
      if (!rec) continue;
      const data = await fsp.readFile(path.join(OUTPUT_DIR, rec.file)).catch(() => null);
      if (!data) continue;
      names.set(p.id, pageFileName(b, p, rec));
      entries.push({ name: `${folder}/${names.get(p.id)}`, data });
    }
    if (!entries.length) throw new HttpError(400, 'This book has no pictures yet.');
    if (story) entries.push({ name: `${folder}/story.md`, data: Buffer.from(await exportMarkdown(id, history, (p) => names.get(p.id)), 'utf8') });
    await appendLog({ type: 'book_images_export', bookId: id, images: names.size, story: Boolean(story) });
    return { zip: zipStore(entries), filename: `${folder}${story ? '-with-story' : '-images'}.zip` };
  }

  async function exportMarkdown(id, history, imagePath) {
    const b = await getBook(id);
    const byId = new Map(history.map((r) => [r.id, r]));
    const src = (p) => (imagePath ? imagePath(p) : p.imageId && byId.get(p.imageId) && path.join(OUTPUT_DIR, byId.get(p.imageId).file));
    const img = (p) => (src(p) ? `\n![${p.kind === 'cover' ? 'Cover' : `Page ${p.n}`}](${src(p)})\n` : '');
    const out = [`# ${b.title || 'Untitled book'}`, '', b.logline && `_${b.logline}_`, '', `**Audience:** ages ${b.brief.audience} · **Theme:** ${b.theme || b.brief.theme || '—'}`, '',
      '## Cast', '', ...b.cast.map((c) => `- **${c.name}** (${c.role}) — ${c.description}`), '', '## Illustration style', '', b.styleGuide, ''];
    const spine = STORYLINE_FIELDS.filter(([k]) => b.storyline[k]);
    if (spine.length) out.push('## Storyline', '', ...spine.map(([k, label]) => `- **${label}:** ${b.storyline[k]}`), '');
    if (b.world) out.push('## World', '', b.world, '');
    for (const p of b.pages) {
      out.push(p.kind === 'cover' ? '## Cover' : `## Page ${p.n}${p.arc ? ` · ${arcLabel(p.arc)}` : ''}`, img(p));
      if (p.text) out.push(p.text, '');
      const meta = [p.beat && `Beat: ${p.beat}`, p.purpose && `Purpose: ${p.purpose}`, p.characters.length && `Characters: ${p.characters.join(', ')}`, p.setting && `Setting: ${p.setting}`, p.emotion && `Feeling: ${p.emotion}`, p.continuity && `Carries over: ${p.continuity}`].filter(Boolean);
      if (p.kind === 'page' && meta.length) out.push(...meta.map((m) => `- ${m}`), '');
      out.push(`> Illustration: ${p.illustration || p.beat || '—'}`, '');
    }
    return out.filter((l) => l !== false && l != null).join('\n');
  }

  // ---------- router (returns true when handled) ----------
  // Long LLM calls stream NDJSON when ?stream=1: {"progress":{…}} lines, then {"done":result} or {"error":…}.
  async function streamed(res, url, work) {
    if (url.searchParams.get('stream') !== '1') return send(res, 200, await work(() => {}));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    let last = 0;
    const progress = (p) => { const now = Date.now(); if (now - last >= 200) { last = now; res.write(JSON.stringify({ progress: p }) + '\n'); } };
    res.write(JSON.stringify({ progress: { phase: `Thinking with ${BOOK_MODEL}` } }) + '\n');
    try { res.end(JSON.stringify({ done: await work(progress) }) + '\n'); }
    catch (e) { res.end(JSON.stringify({ error: e.message || 'Internal error', status: e.status || 500 }) + '\n'); }
  }
  const pub = (x) => (x?.pages ? publicBook(x) : x?.book ? { ...x, book: publicBook(x.book) } : x);

  async function route(req, res, url, readHistory) {
    const p = url.pathname;
    if (p === '/api/books' && req.method === 'GET') { send(res, 200, await listBooks()); return true; }
    if (p === '/api/books' && req.method === 'POST') { send(res, 200, pub(await handleCreate(await readJson(req)))); return true; }
    if (p === '/api/books/ideas' && req.method === 'POST') { const body = await readJson(req); await streamed(res, url, (progress) => handleIdeas(body, progress)); return true; }
    if (p === '/api/books/brief' && req.method === 'POST') { const body = await readJson(req); await streamed(res, url, (progress) => handleBriefFill(body, progress)); return true; }
    if (!p.startsWith('/api/books/')) return false;
    const [id, a, b, c] = p.slice('/api/books/'.length).split('/').map(decodeURIComponent);
    if (req.method === 'GET' && !a) send(res, 200, pub(await getBook(id)));
    else if (req.method === 'PATCH' && !a) send(res, 200, pub(await handlePatch(id, await readJson(req))));
    else if (req.method === 'DELETE' && !a) send(res, 200, await handleDelete(id));
    else if (req.method === 'POST' && a === 'outline') { const body = await readJson(req); await getBook(id); await streamed(res, url, async (progress) => pub(await handleOutline(id, body, progress))); }
    else if (req.method === 'POST' && a === 'scripts') { const body = await readJson(req); await getBook(id); await streamed(res, url, async (progress) => pub(await handleScripts(id, body, progress))); }
    else if (req.method === 'POST' && a === 'details') { await getBook(id); await streamed(res, url, async (progress) => pub(await handleDetails(id, progress))); }
    else if (req.method === 'POST' && a === 'undo') send(res, 200, pub(await handleUndo(id)));
    else if (req.method === 'POST' && a === 'prompts') send(res, 200, pub(await handlePrompts(id, await readJson(req))));
    else if (req.method === 'POST' && a === 'pages' && c === 'image') send(res, 200, pub(await handlePageImage(id, b)));
    else if (req.method === 'POST' && a === 'cast' && c === 'design') send(res, 200, pub(await handleDesignCast(id, b)));
    else if (req.method === 'GET' && a === 'prompt' && b) { const book = await getBook(id); const page = book.pages.find((x) => x.id === b); if (!page) throw new HttpError(404, 'Page not found.'); send(res, 200, { prompt: pagePrompt(book, page) }); }
    else if (req.method === 'GET' && a === 'images.zip') {
      const { zip, filename } = await exportImagesZip(id, await readHistory(), url.searchParams.get('story') === '1');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zip.length, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
      res.end(zip);
    } else if (req.method === 'GET' && a === 'export.md') {
      const book = await getBook(id);
      send(res, 200, await exportMarkdown(id, await readHistory()), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${slugify(book.title || 'book')}.md"` });
    } else throw new HttpError(404, 'Not found.');
    return true;
  }

  return { route, config: () => ({ model: BOOK_MODEL, ageBands: AGE_BANDS.map(({ id, label, words }) => ({ id, label, words })), placements: PLACEMENTS, maxPages: MAX_PAGES, arcStages: ARC_STAGES, storyline: STORYLINE_FIELDS.map(([id, label]) => ({ id, label })) }) };
}
