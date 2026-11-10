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
const PAGE_META = [['purpose', 500], ['setting', 300], ['emotion', 200], ['continuity', 600], ['state', 700]];
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
- state: where things stand at the END of this page, as plain facts a picture could get wrong: where each cast member is (say plainly who is inside, under or behind something and so cannot be seen from outside, and why), who is holding or carrying whom or what, what is blocked, open, stuck or moved, and how much light is left. Two to four short sentences, using the same names as the cast and the settings. A fact repeats unchanged from page to page until that page's beat changes it.

Story logic — the story must survive a sharp five-year-old who keeps asking "but why?":
- The obvious way out is closed, visibly. For every obstacle, name the simplest thing anyone would try (climb up, go around, lift it, call for help) and make sure a page shows why that does not work. A stuck or trapped character or thing has a visible reason it cannot simply come free.
- Abilities are honest. Each character can only do what its body and size (as given in the cast) allow, and the same on every page. A helper succeeds because of what it IS (the small one fits, the one with the light shows the way, the one with claws grips), never by being stronger than the bigger main character at the very thing the main character just failed.
- Nobody arrives by coincidence. Every helper is met, and seen doing its special thing, before the lowest moment; the answer to the problem is already in the story before it is needed.
- One of each device. Never two loose stones, two hollows, two gaps or two detours; an early episode either causes something later or is cut. Two different places or things never share a name.
- Whereabouts carry forward. A character who is trapped, hidden, asleep, carried, riding on someone or left behind stays exactly so on every following page until a beat changes it; the same goes for anything held, stuck, blocked, opened, broken, lit or lost. Nobody is in two places, and nobody reappears without a page showing how. The page's "characters" list agrees with this.
- When a continuity reader's findings are attached, fix every one with the smallest change that makes the story add up (close the obvious way out visibly, give the helper a job only its body can do, introduce a helper earlier, merge a repeated device, rename a second thing). Never fix a hole by adding an explanation in words: change what happens or what is seen. Then rewrite every page's state so it is true of the revised story.
- Write in English. Return exactly the requested number of pages.`;

// The continuity reader: a second reader who only looks for what does not add up (adapted from the Flash Cards story pipeline).
const LOGIC_INSTRUCTIONS = `You are the continuity supervisor on a children's picture book, reading with the scepticism of a sharp five-year-old who keeps asking "but why?". You do not rewrite and you do not judge style. You find what does not add up. You are given the brief, the cast, and every page (its beat, who is listed on it and its state, and when it has been written, its text and illustration brief).

Walk through the story page by page, keeping a private ledger of where every character and every important object is, and check:
1. Obvious way out: for each obstacle, what is the simplest thing anyone would try? Does a page SHOW why it does not work? (Why not climb up? Why not go around? Why not ask sooner?)
2. Abilities: can each character physically do what it does, given the body and size in the cast? Does a small helper succeed by strength at exactly what the bigger main character failed at? Does anyone's ability change between pages?
3. Whereabouts: is anyone in two places, drawn or mentioned after being trapped, left behind or handed over with no page showing how they got free, or gone without a word? Does a page's illustration brief or list of characters put someone where the story says they are not?
4. Object state: does something blocked, stuck, broken, held, lost or lit stay that way until a page changes it? Is the obstacle the same obstacle every time it is described (too high to reach on one page, tangled on the next)?
5. Coincidence: does a helper or a fix turn up exactly when needed without having been met before?
6. Repeats and dead ends: the same device used twice; an episode that causes nothing later and could be cut.
7. Time: does the time of day or the deadline (light fading, bedtime) move steadily, never backwards, and is it kept or missed clearly?
8. Words against pictures (written pages only): do the text, the illustration brief, the character list and the state of a page agree with each other — who is there, how many there are, what is being held?
9. Names: one thing with two names, or two different things or places sharing one name.

First fill in "ledger" honestly for every obstacle, every helper and every character; a line that reads "not closed", "first met at the moment of need", "the main character could have done this" or "moved with no page showing how" is a hole to report.
Report only real problems that a parent reading aloud, or a child looking at the pictures, would trip over. Each problem: the page numbers, one plain sentence saying what does not add up, and the smallest change that would fix it. severity: "breaks" = the plot does not work or a picture would contradict the story; "confusing" = a listener would stop and ask; "small" = worth tidying. Worst first, at most twelve. Return an empty list when the story truly holds together; do not invent problems to seem thorough.`;
const LOGIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ledger', 'holes'],
  properties: {
    ledger: { type: 'string', description: 'your working notes, written BEFORE the holes, in short lines: for each obstacle — the obvious way out and which page closes it (or "not closed"); for each helper — the page where it is first met, what only it can do, and whether the main character could have done the same; for each character and key object — where it is on every page where that changes' },
    holes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pages', 'problem', 'fix', 'severity'], properties: {
      pages: { type: 'array', description: 'the page numbers involved', items: { type: 'integer' } }, problem: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string', enum: ['breaks', 'confusing', 'small'] },
    } } },
  },
};
// The page proofreader: a vision model compares a finished picture with what the page says is in it.
const PROOF_INSTRUCTIONS = `You are the proofreader for a children's picture book. Compare the finished illustration with what the page says it shows. Report: (1) expected lettering that is misspelled, altered, cut off or missing — ignore line breaks, capitalisation of display lettering, and curly versus straight quotes; (2) any words, letters, numbers, captions or speech bubbles in the picture that are not expected (when no lettering is expected, ANY readable lettering is extra text; a signature or watermark counts); (3) picture problems, each marked major or minor.
MAJOR picture problems are only those a parent reading aloud would notice and that confuse the story: a named character drawn as a different character; a named character the picture needs is absent; a named character appears who should not be there; the one thing the page is about is not shown (the text says stuck and nothing is stuck).
ALWAYS MAJOR, however small it is drawn and whatever else is right: a named character drawn where the story facts or the must-NOT-show list say it cannot be (outside and free when the facts say it is trapped inside something; moving by itself when it is being carried; present after being left behind; in a picture that does not list it). Check this before anything else, and name the character. Also major: the thing the story's problem depends on is drawn in a state that undoes the problem (something the facts call stuck or out of reach is free or within reach; an entrance the facts call blocked is wide open).
MINOR is everything else: exact counts of background things, details of props and small objects, how something is held, pose and anatomy details, markings and stripes, colours of small things, scenery. When unsure, choose minor. Do not report matters of taste or composition at all.
"pass" is true when there are no text problems, no extra text and no major picture problems.`;
const PROOF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['textProblems', 'extraText', 'pictureProblems', 'pass', 'fixNotes'],
  properties: {
    textProblems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['expected', 'found'], properties: { expected: { type: 'string' }, found: { type: 'string', description: 'what is lettered instead, or "missing"' } } } },
    extraText: { type: 'array', description: 'lettering in the picture that is not expected', items: { type: 'string' } },
    pictureProblems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['issue', 'severity'], properties: { issue: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] } } } },
    pass: { type: 'boolean' }, fixNotes: { type: 'string', description: 'if not pass: short instructions for the illustrator, one per line; otherwise ""' },
  },
};

const SCRIPT_INSTRUCTIONS = `You are a children's picture-book author working with an illustrator. You are given a book plan (title, theme, cast, style, and a beat for every page). Write the final on-page text and an illustration brief for the requested pages.

Each page comes with planning notes: its stage on the story arc, its purpose, who is in it, the setting, the feeling, what carries over from earlier pages, and its "state" (the facts at the END of that page: who is where, who holds what, what is blocked or open, the light). Follow them. The text serves the page's purpose and feeling.

Rules for "text" (the words printed on the page):
- Fit the audience's word range per page exactly; read-aloud rhythm matters. Use repetition, sound words and gentle humor where it fits the tone.
- Keep continuity with the surrounding pages: names, facts and tone must match. Do not repeat what the picture already shows; let the words and picture work together.
- No headings, page numbers, or stage directions in the text.

Rules for "illustration" (sent to the image model; it never sees other pages):
- The illustrator sees ONE page at a time and knows nothing else about the story, so each brief is complete: 60–110 words describing one single moment, in this fixed order: (1) where we are, naming the place from the planning notes and the part of it, with the landmark that matters and the time of day; (2) every character in the picture and exactly where each one is — left or right, in front or behind, inside or outside, on top of or under what; (3) what each is doing with which part of its body, and the one feeling on its face; (4) the state of every important object — who holds it, what is blocked, stuck, open, shut or out of reach, and by how much, including every carry-over detail; (5) how close the camera is and from where (wide, medium, close-up). Describe what is SEEN, not what it means.
- Story state: the page's "state" gives the facts at the END of that page; the state of the page before it gives the facts as this page begins. The brief must agree with both. A character the state puts inside, under or behind something is drawn only there: if the picture looks in at them, say so in the brief ("seen through the gap, deep inside the hollow") and list them in "characters"; otherwise leave them out of the brief and out of "characters". Everyone and everything the page text names as present is in the brief.
- Refer to characters by name only; do not redescribe their appearance (their look is supplied separately).
- Never ask for text, letters or speech bubbles in the picture.
- Vary framing across pages so the book does not feel repetitive.

"characters": the names (exactly as in the cast) of every character drawn in the picture, and nobody else: never list a character who is not physically in the picture, and never leave out one who is. Keep the planned characters unless the scene needs a change.
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
- For every page return: arc (${ARC_IDS.join(', ')}; stages run in that order and never go backwards), purpose (one sentence on what the page does for the story), characters (names exactly as in the cast who are visible on the page), setting (specific place plus time of day or weather; same wording for pages in the same place), emotion (the main character's feeling and the page's mood, a few words), continuity (what carries over from earlier pages and must be visible here; empty string when nothing does), state (where things stand at the END of the page, read off the story as it is written: where each cast member is and who cannot be seen from outside, who is holding or carrying what, what is blocked, open, stuck or moved, and the light; two to four short sentences; a fact carries forward unchanged until a page changes it).
Return every page, in order. English only.`;

const pageMetaProps = {
  arc: { type: 'string', enum: ARC_IDS },
  purpose: { type: 'string' },
  characters: { type: 'array', items: { type: 'string' } },
  setting: { type: 'string' },
  emotion: { type: 'string' },
  continuity: { type: 'string' },
  state: { type: 'string', description: 'where everyone and everything is at the END of this page (who is where and who cannot be seen, who holds what, what is blocked or open, the light); 2–4 short sentences' },
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
  const SEVERITIES = ['breaks', 'confusing', 'small'];
  const BOOKS_DIR = path.join(OUTPUT_DIR, 'books');
  const bookFile = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Book not found.');
    return path.join(BOOKS_DIR, `${id}.json`);
  };

  // ---------- storage (one JSON per book, mutations serialized) ----------
  // Books written before the outline carried planning notes (and Flash Cards mirrors) get blank ones.
  function normalize(b) {
    b.storyline = { ...Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, ''])), ...(b.storyline || {}) };
    b.world ??= ''; b.brief.setting ??= ''; b.logic ??= null;
    for (const p of b.pages) { p.arc ??= ''; for (const [k] of PAGE_META) p[k] ??= ''; }
    // A Flash Cards mirror carries each card's state in `continuity`; show it as the page's state too rather than as a blank note.
    if (b.fromSeries) for (const p of b.pages) if (p.kind === 'page' && !p.state) p.state = p.continuity;
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
    // proof: every new picture is read by the proofreader and redrawn once if it contradicts the page (on unless switched off).
    return { model, quality, size, textInImage: 'textInImage' in v ? Boolean(v.textInImage) : Boolean(prev.textInImage), proof: 'proof' in v ? Boolean(v.proof) : prev.proof !== false };
  }
  const newPage = (kind, n, fields = {}) => ({ id: crypto.randomUUID(), kind, n, beat: '', arc: '', purpose: '', setting: '', emotion: '', continuity: '', state: '', text: '', illustration: '', characters: [], textPlacement: 'bottom', imagePrompt: '', promptAuto: '', imageId: null, imageIds: [], check: null, ...fields });

  // ---------- LLM ----------
  // Streams the Responses API so long writing calls can report progress; onText receives the JSON text so far.
  async function llmJson(name, instructions, input, schema, logBase, onText = () => {}, effort = 'medium') {
    const { type, ...refs } = logBase;
    try {
      const r = await deps.ai.text({ feature: type, refs, model: BOOK_MODEL, instructions, input, effort, schema, schemaName: name }, onText);
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
      b.logic = null;      // the reader's findings were about the version just undone
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
        p.state && `  State at the end: ${p.state}`,
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
    const onOutline = (prefix) => (t) => progress(
      !t.includes('"cast"') ? { phase: `${prefix}Finding the title and art style`, snippet: lastString(t, 'title') }
        : !t.includes('"pages"') ? { phase: `${prefix}Creating the cast (${countKey(t, 'role')})`, snippet: lastString(t, 'name') }
          : { phase: `${prefix}Planning page ${Math.min(total, Math.max(1, countKey(t, 'beat')))} of ${total}`, done: Math.max(0, countKey(t, 'beat') - 1), total, snippet: lastString(t, 'beat') });
    const first = await llmJson('book_outline', OUTLINE_INSTRUCTIONS, input, outlineSchema(total), { type: 'book_outline', bookId: id }, onOutline(''));
    let { parsed } = first;
    const { durationMs, usage } = first;
    // Continuity reader: read the plan for holes, let the writer fix them once, read again; what is still open is kept
    // on the book for the author. A failed reader or revision never loses the outline already written.
    let logic = null;
    if (!book.fromSeries) {
      const draft = (o) => ({ ...book, title: o.title, logline: o.logline, storyline: o.storyline || {}, world: o.world, cast: o.cast || [],
        pages: (o.pages || []).slice(0, total).map((p, i) => ({ ...p, kind: 'page', n: i + 1, characters: p.characters || [] })) });
      const read = (o, label) => findHoles(id, storyDigest(draft(o)), (t) => progress({ phase: `${label} (${countKey(t, 'problem')} found so far)`, snippet: lastString(t, 'problem') })).catch(() => null);
      const found = await read(parsed, 'Continuity reader: checking the plan adds up');
      if (found) {
        logic = { at: new Date().toISOString(), stage: 'plan', holes: found, found: found.length, fixed: 0 };
        if (found.length) {
          const revised = await llmJson('book_outline', OUTLINE_INSTRUCTIONS,
            `${input}\n\nFIRST OUTLINE (JSON):\n${JSON.stringify(parsed)}\n\nA continuity reader found these problems in the first outline:\n${holeLines(found)}\n\nReturn the whole outline again with every one of them fixed by the smallest change that makes the story add up. Keep everything that already works (title, cast names, style guide, the pages that are not involved) exactly as it is, and rewrite every page's state so it is true of the revised story.`,
            outlineSchema(total), { type: 'book_outline_fix', bookId: id }, onOutline(`Fixing ${found.length} thing${found.length === 1 ? '' : 's'} that did not add up · `)).catch(() => null);
          if (revised?.parsed?.pages?.length === total) {
            const left = await read(revised.parsed, 'Continuity reader: checking the fixed plan');
            parsed = revised.parsed;
            // If the second read failed, what is still open is unknown: store nothing rather than the stale findings.
            logic = left ? { at: new Date().toISOString(), stage: 'plan', holes: left, found: found.length, fixed: Math.max(0, found.length - left.length) } : null;
          }
        }
      }
    }
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
      b.logic = logic;
      return b;
    });
    await appendLog({ type: 'book_outline', bookId: id, title: updated.title, pages: updated.brief.pageCount, model: BOOK_MODEL, usage, durationMs,
      logic: logic && { found: logic.found, fixed: logic.fixed, open: logic.holes.map((h) => `${h.severity}: pages ${h.pages.join(', ')} — ${h.problem}`) } });
    return updated;
  }

  // ---------- story logic: a reader who only looks for what does not add up ----------
  // The story as the continuity reader sees it: the plan of every page and, where written, its text and illustration brief.
  function storyDigest(book) {
    const a = audienceOf(book);
    const sl = book.storyline || {};
    const pageText = (p) => [
      `Page ${p.n}${[p.arc, p.setting && `setting: ${p.setting}`, p.emotion && `feeling: ${p.emotion}`].filter(Boolean).length ? ` [${[p.arc, p.setting && `setting: ${p.setting}`, p.emotion && `feeling: ${p.emotion}`].filter(Boolean).join('; ')}]` : ''}`,
      `  What happens: ${p.beat || '—'}`,
      `  Characters listed on the page: ${(p.characters || []).join(', ') || 'none'}`,
      p.continuity && `  Carries over: ${p.continuity}`,
      p.state && `  State at the end: ${p.state}`,
      p.text && `  Text: ${p.text}`,
      p.text && p.illustration && `  Illustration brief: ${p.illustration}`,
    ].filter(Boolean).join('\n');
    return [
      `Story: "${book.title}" — ${book.logline}`, `Brief: ${book.brief.premise}`, `Audience: ages ${a.id} (${a.label}).`,
      STORYLINE_FIELDS.some(([k]) => sl[k]) && `Storyline:\n${STORYLINE_FIELDS.filter(([k]) => sl[k]).map(([k, label]) => `- ${label}: ${sl[k]}`).join('\n')}`,
      book.world && `World: ${book.world}`,
      `Cast (body and size decide what each can do):\n${book.cast.map((c) => `- ${c.name} (${c.role}): ${String(c.description || '').slice(0, 400)}`).join('\n')}`,
      `PAGES, in reading order:\n${book.pages.filter((p) => p.kind === 'page').map(pageText).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }
  async function findHoles(id, digest, onText) {
    const { parsed } = await llmJson('book_story_logic', LOGIC_INSTRUCTIONS, digest, LOGIC_SCHEMA, { type: 'book_story_logic', bookId: id }, onText);
    return (parsed.holes || []).slice(0, 12).map((h) => ({ id: crypto.randomUUID(), pages: [...new Set((h.pages || []).filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y),
      problem: clampStr(h.problem, 600), fix: clampStr(h.fix, 600), severity: SEVERITIES.includes(h.severity) ? h.severity : 'confusing' })).filter((h) => h.problem);
  }
  const holeLines = (holes) => holes.map((h) => `- Page${h.pages.length === 1 ? '' : 's'} ${h.pages.join(', ') || '—'} (${h.severity}): ${h.problem} Smallest fix: ${h.fix}`).join('\n');
  // Read the book as it stands (plan, plus text and illustration briefs where written) and keep what the reader found.
  async function handleLogic(id, progress = () => {}) {
    const book = await getBook(id);
    if (book.fromSeries) throw new HttpError(400, 'This book is a copy of a Flash Cards story. Check the story in Flash Cards.');
    const pages = book.pages.filter((p) => p.kind === 'page');
    if (!pages.length) throw new HttpError(400, 'Generate an outline first.');
    const holes = await findHoles(id, storyDigest(book), (t) => progress({ phase: `Reading the story for things that do not add up (${countKey(t, 'problem')} so far)`, snippet: lastString(t, 'problem') }));
    const logic = { at: new Date().toISOString(), stage: pages.every((p) => p.text) ? 'script' : 'plan', holes, found: holes.length, fixed: 0 };
    const updated = await withBook(id, (b) => { b.logic = logic; return b; });
    await appendLog({ type: 'book_story_logic', bookId: id, stage: logic.stage, holes: holes.map((h) => `${h.severity}: pages ${h.pages.join(', ')} — ${h.problem}`) });
    return { book: updated, logic };
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
      // A finding whose pages were all just rewritten to an instruction is taken as dealt with; 🔎 reads the story again.
      if (extra && b.logic?.holes.length) { const done = new Set(wanted.map((w) => w.n)); b.logic.holes = b.logic.holes.filter((h) => !h.pages.length || !h.pages.every((n) => done.has(n))); }
      return b;
    });
    await appendLog({ type: 'book_scripts', bookId: id, pages: wanted.map((p) => p.n), written, instructions: extra || null, model: BOOK_MODEL, usage, durationMs });
    return updated;
  }

  // ---------- illustrations ----------
  // The facts a picture of this page must agree with: the previous page's state as it begins, its own state by the end.
  function storyFacts(book, page) {
    if (page.kind !== 'page') return [];
    const before = book.pages.find((p) => p.kind === 'page' && p.n === page.n - 1)?.state;
    return [before && `As this page begins: ${before}`, page.state && `By the end of this page: ${page.state}`].filter(Boolean);
  }
  // Who is drawn on a story page and who is not; null when the page lists nobody (unknown rather than "nobody").
  function inPicture(book, page) {
    if (page.kind !== 'page' || !page.characters.length) return null;
    return { shown: page.characters, absent: book.cast.map((c) => c.name).filter((n) => !page.characters.includes(n)) };
  }
  const withFix = (prompt, fixNotes) => (fixNotes ? `${prompt}\n\nA previous attempt at this picture had these mistakes — make sure this one does not:\n${fixNotes}` : prompt);
  function pagePrompt(book, page, fixNotes = '') {
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
    const facts = storyFacts(book, page), who = inPicture(book, page);
    if (facts.length) lines.push('', 'Story facts — where everyone and everything is. The picture must agree with them; they are for drawing from, never for lettering:', ...facts.map((x) => `- ${x}`));
    if (who) lines.push('', `In this picture: ${who.shown.join(', ')}.${who.absent.length ? ` NOT in this picture: ${who.absent.join(', ')}.` : ''}`);
    if (unlinked.length) lines.push('', `Characters (draw them exactly like this on every page):\n${unlinked.map((c) => `- ${c.name}: ${c.description}`).join('\n')}`);
    lines.push('', `Style (identical on every page of the book): ${book.styleGuide || book.brief.style || 'warm, friendly picture-book illustration'}`);
    const area = { top: 'top quarter', bottom: 'bottom quarter', left: 'left third', right: 'right third' }[page.textPlacement] || 'bottom quarter';
    if (isCover) lines.push('', `Text: the title "${book.title}" in large, playful, highly legible lettering across the top. No other text.`);
    else if (book.image.textInImage && page.text) lines.push('', `Text: print exactly this text in the ${area}, in a clean, rounded, highly legible children's-book font on a calm area of the picture: "${page.text.replace(/"/g, "'")}". No other text.`);
    else lines.push('', `Composition: keep the ${area} of the image calm and uncluttered (simple background, no important details) so the page text can be placed there later.`);
    lines.push('', 'Constraints:', '- Full-bleed illustration, no border, no frame, no watermark, no signature.');
    if (who) lines.push('- Draw only the characters listed under "In this picture", each exactly once; no other named character appears anywhere, not even small or in the background.');
    if (!isCover && !(book.image.textInImage && page.text)) lines.push('- No text, letters, numbers, captions or speech bubbles anywhere in the image.');
    return withFix(lines.join('\n'), fixNotes);
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

  // Proofreader: a vision model looks at the finished picture next to what the page says is in it — who is there and who
  // must not be, where the story facts put everyone, the thing the problem depends on, and any lettering.
  async function checkPage(id, pageId, recordId) {
    const book = await getBook(id);
    if (book.fromSeries) throw new HttpError(400, 'This book is a copy of a Flash Cards story. Proofread the cards in Flash Cards.');
    const page = book.pages.find((p) => p.id === pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    const recId = recordId || page.imageId;
    const file = recId && deps.recordFile && await deps.recordFile(recId);
    if (!file) throw new HttpError(400, 'This page has no picture to check.');
    const isCover = page.kind === 'cover';
    const lettered = isCover ? book.title : book.image.textInImage && page.text ? page.text : '';
    const facts = storyFacts(book, page), who = inPicture(book, page);
    const cast = book.cast.map((c) => `- ${c.name}: ${String(c.description || '').slice(0, 220)}`).join('\n');
    const label = isCover ? 'cover' : `page ${page.n}`;
    const input = [{ role: 'user', content: [{ type: 'input_text', text: [
      isCover ? `Front cover of "${book.title}".` : `Page ${page.n} of "${book.title}".`,
      lettered ? `LETTERING THAT MUST APPEAR (exactly this${isCover ? ', the title' : ''}, and no other text):\n${lettered}` : 'NO LETTERING IS EXPECTED: the picture must contain no words, letters, numbers, captions or speech bubbles at all.',
      `WHAT THE PICTURE SHOULD SHOW:\n${page.illustration || page.beat}`,
      !isCover && page.text && !lettered && `The words printed next to it (not in the picture): ${page.text}`,
      who ? `NAMED CHARACTERS — must show: ${who.shown.join(', ')}; must NOT show: ${who.absent.join(', ') || '—'}` : isCover && page.characters.length ? `NAMED CHARACTERS expected on the cover: ${page.characters.join(', ')} (others may appear too).` : '',
      facts.length && `STORY FACTS (where everyone and everything is at this point of the story; the picture may not contradict them):\n${facts.join('\n')}`,
      !isCover && book.storyline.obstacle && `THE PROBLEM THE STORY DEPENDS ON: ${book.storyline.obstacle}`,
      cast && `CHARACTERS (how to tell them apart):\n${cast}`,
    ].filter(Boolean).join('\n\n') }, { type: 'input_image', image_url: `data:image/png;base64,${(await fsp.readFile(file)).toString('base64')}`, detail: 'high' }] }];
    const { parsed: r } = await llmJson('book_page_proof', PROOF_INSTRUCTIONS, input, PROOF_SCHEMA, { type: 'book_page_proof', bookId: id, page: label }, () => {}, 'low');
    const issues = [...(r.textProblems || []).map((x) => `Text: “${x.expected}” → ${x.found}`), ...(r.extraText || []).map((x) => `Extra text: “${x}”`), ...(r.pictureProblems || []).filter((x) => x.severity === 'major').map((x) => x.issue)].map((x) => clampStr(x, 400));
    const notes = (r.pictureProblems || []).filter((x) => x.severity !== 'major').map((x) => clampStr(x.issue, 400));
    const check = { imageId: recId, pass: issues.length === 0, issues, notes, fixNotes: issues.length ? [...issues, ...notes].join('\n') : '', at: new Date().toISOString() };
    await withBook(id, (b) => { const p = b.pages.find((x) => x.id === pageId); if (p && p.imageId === recId) p.check = check; return b; });
    await appendLog({ type: 'book_page_proof', bookId: id, page: label, recordId: recId, pass: check.pass, issues });
    return check;
  }

  // body.fixNotes: mistakes of an earlier attempt to avoid. Otherwise, when proofreading is on (book.image.proof, or
  // body.proof), the picture is checked and redrawn once if it fails; the attempt with fewer problems stays selected.
  async function handlePageImage(id, pageId, body = {}) {
    const first = await drawPage(id, pageId, clampStr(body.fixNotes, 2000));
    const proof = 'proof' in body ? Boolean(body.proof) : first.book.image.proof !== false;
    if (!proof || first.book.fromSeries || !deps.recordFile) return first;
    const records = [first.record];
    let check = await checkPage(id, pageId, first.record.id).catch(() => null);
    if (check && !check.pass) {
      const second = await drawPage(id, pageId, check.fixNotes).catch(() => null);
      if (second) {
        records.push(second.record);
        const check2 = await checkPage(id, pageId, second.record.id).catch(() => null);
        // Keep whichever attempt has fewer problems selected; both stay as versions of the page.
        if (check2 && !check2.pass && check2.issues.length > check.issues.length) await withBook(id, (b) => { const p = b.pages.find((x) => x.id === pageId); if (p) { p.imageId = first.record.id; p.check = check; } return b; });
        else check = check2;
      }
    }
    const book = await getBook(id);
    const chosen = book.pages.find((p) => p.id === pageId)?.imageId;
    return { book, record: records.find((r) => r.id === chosen) || records[records.length - 1], records, check };
  }
  async function drawPage(id, pageId, fixNotes = '') {
    const book = await getBook(id);
    const page = book.pages.find((p) => p.id === pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    if (!page.illustration && !page.beat) throw new HttpError(400, 'This page needs an illustration brief first.');
    const all = await readCharacters();
    const characterIds = book.cast.filter((c) => c.characterId && page.characters.includes(c.name) && all.some((x) => x.id === c.characterId)).map((c) => c.characterId);
    const prompt = withFix(page.imagePrompt || pagePrompt(book, page), fixNotes);      // the prompt reviewed in the Picture prompts step, if there is one
    const label = page.kind === 'cover' ? 'cover' : `page ${page.n}`;
    const r = await handleGenerate({
      prompt, originalPrompt: `${book.title} — ${label}: ${page.illustration || page.beat}`.slice(0, 20000), ...book.image, n: 1, format: 'png',
      characterIds, tags: ['book', slugify(book.title || 'book'), page.kind === 'cover' ? 'cover' : `page-${page.n}`],
    }, { ai: { feature: 'book_page_image', refs: { bookId: id } } });
    const rec = await handleUpdate(r.images[0].id, { title: `${book.title} — ${label}` });
    const updated = await withBook(id, (b) => {
      const p = b.pages.find((x) => x.id === pageId);
      if (p) { p.imageIds = [...(p.imageIds || []), rec.id]; p.imageId = rec.id; p.check = null; }
      return b;
    });
    await appendLog({ type: 'book_page_image', bookId: id, page: label, recordId: rec.id, characterIds, fix: Boolean(fixNotes), costUsd: rec.costUsd });
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
      title: '', logline: '', theme: '', styleGuide: '', world: '', storyline: Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, ''])), cast: [], pages: [], logic: null, image: cleanImage(body.image) };
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
        b.logic = null;      // the reader's findings name pages by number
      }
      if (body.removePage) {
        const i = b.pages.findIndex((p) => p.id === body.removePage && p.kind === 'page');
        if (i >= 0) {
          snapshot(b, `Removed page ${b.pages[i].n}`);
          const [gone] = b.pages.splice(i, 1);
          for (const p of b.pages) if (p.kind === 'page' && p.n > gone.n) p.n--;
          b.brief.pageCount = b.pages.filter((p) => p.kind === 'page').length;
          b.logic = null;
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
      const meta = [p.beat && `Beat: ${p.beat}`, p.purpose && `Purpose: ${p.purpose}`, p.characters.length && `Characters: ${p.characters.join(', ')}`, p.setting && `Setting: ${p.setting}`, p.emotion && `Feeling: ${p.emotion}`, p.continuity && `Carries over: ${p.continuity}`, p.state && `State at the end: ${p.state}`].filter(Boolean);
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
    else if (req.method === 'POST' && a === 'logic') { await getBook(id); await streamed(res, url, async (progress) => pub(await handleLogic(id, progress))); }
    else if (req.method === 'POST' && a === 'pages' && c === 'image') send(res, 200, pub(await handlePageImage(id, b, await readJson(req).catch(() => ({})))));
    else if (req.method === 'POST' && a === 'pages' && c === 'check') { const check = await checkPage(id, b); send(res, 200, { check, book: publicBook(await getBook(id)) }); }
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
