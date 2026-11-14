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
const PAGE_META = [['purpose', 500], ['setting', 300], ['emotion', 200], ['continuity', 600], ['state', 700], ['focus', 200], ['turn', 300]];
// How close the camera is. Planned per page in the outline so the rhythm of the pictures can be seen before any are drawn.
export const SHOTS = [
  { id: 'wide', label: 'Wide', hint: 'the whole place, characters small in it' },
  { id: 'medium', label: 'Medium', hint: 'characters head to foot, with some of the place' },
  { id: 'close', label: 'Close-up', hint: 'a face, a hand or one object fills the picture' },
];
const SHOT_IDS = SHOTS.map((x) => x.id);
const shotLabel = (id) => SHOTS.find((x) => x.id === id)?.label || '';
// Camera set-ups for page pictures. Without one the image model falls back to the same medium, eye-level line-up on
// every page (and copies it from the reference page), so a book of one place turns into one picture fifteen times.
// Each page gets its own; neighbouring pages never share one. close/wide/medium map to the planned shot.
const CAMERAS = [
  { id: 'wide-high', shot: 'wide', text: 'WIDE, from high above and a little to the side: the whole place spread out like a map, the characters small in it, their path or goal visible.' },
  { id: 'close-face', shot: 'close', text: "CLOSE-UP on the main character's face and front feet, filling most of the picture, the feeling unmistakable; the others appear only partly at an edge or out of focus behind, the place reduced to a few big shapes." },
  { id: 'low-up', shot: 'medium', text: 'LOW ANGLE, from the ground looking up: the characters loom tall against the sky, with big foreground leaves or stones framing the picture at the bottom corners.' },
  { id: 'behind', shot: 'medium', text: "FROM BEHIND the main character, over their shoulder: we see their back and head large in one lower corner and look past them at what they are looking at, which fills the rest of the picture." },
  { id: 'side-travel', shot: 'medium', text: 'SIDE VIEW, in profile, the characters moving across the picture in single file or at different distances (one near and big, one further and smaller), with the way ahead open in front of them.' },
  { id: 'close-detail', shot: 'close', text: 'CLOSE-UP on the one thing the page is about (a foot on a stone, a face beside a leaf, two friends touching), large and simple; anything else only in part at the edges.' },
  { id: 'top-down', shot: 'wide', text: "BIRD'S-EYE VIEW looking straight down: the ground as a bright pattern and the characters seen from above, their positions easy to read." },
  { id: 'front-near', shot: 'medium', text: 'FRONT VIEW at the characters\' eye level, near: one character big in the foreground, the others clearly further back and smaller, so they stand at different depths.' },
];
// ---------- page types ----------
// How a book's pages are built. Classic: one full picture and the story text. The designed styles (the layouts of the
// Flash Cards toddler and comic stories) give every page a layout of 1–4 panels with a short caption each, and boxes
// under the pictures: something for the child to do, a "Did you know?" fact, a line for grown-ups. The full story text
// stays with the page for reading aloud; only the captions and boxes are lettered into the picture.
export const PAGE_STYLES = [
  { id: 'classic', label: 'Classic picture book', hint: 'one full-page picture and the story text on every page' },
  { id: 'mixed', label: 'Mixed toddler pages', hint: 'every page looks different: full pictures and 2–4 panel scenes with tiny captions, a play box ("Can you find…?") and a line for grown-ups' },
  { id: 'comic', label: 'Comic panels', hint: 'mostly 2–4 numbered panels with captions and speech bubbles, and a "Did you know?" fact box' },
];
const PAGE_STYLE_IDS = PAGE_STYLES.map((x) => x.id);
export const LAYOUTS = [
  { id: 'picture', label: 'Full picture', panels: 1, when: 'the opening, the biggest surprise or reveal, arriving somewhere wonderful, or the cosy ending', guide: 'ONE large picture filling the whole picture area edge to edge, with a single caption strip along its bottom' },
  { id: 'duo', label: '2 panels', panels: 2, when: 'a simple cause and effect, a peekaboo, a before and after, or a question and its answer', guide: 'TWO wide panels stacked one above the other, equal height, each with a caption strip; small corner numbers 1 and 2', positions: ['top panel', 'bottom panel'] },
  { id: 'trio', label: '3 panels', panels: 3, when: 'arriving somewhere new and then two quick things that happen there', guide: 'ONE wide panel across the top (about 55% of the picture area) and TWO smaller square panels side by side beneath it, each with a caption strip; small corner numbers 1, 2 and 3', positions: ['wide top panel', 'bottom-left panel', 'bottom-right panel'] },
  { id: 'quad', label: '4 panels', panels: 4, when: 'a quick, funny sequence of four small actions; at most once every six pages', guide: 'FOUR panels in a 2 × 2 grid read left to right, top to bottom, each with a caption strip; small corner numbers 1 to 4', positions: ['top-left panel', 'top-right panel', 'bottom-left panel', 'bottom-right panel'] },
];
const LAYOUT_IDS = LAYOUTS.map((x) => x.id);
export const PLAY_KINDS = [
  { id: 'find', heading: 'Can you find…?', icon: 'a pointing hand' },
  { id: 'count', heading: 'How many…?', icon: 'little numbers 1 2 3' },
  { id: 'move', heading: 'Your turn!', icon: 'wiggling arms' },
  { id: 'sound', heading: 'Say it!', icon: 'an open, smiling mouth' },
  { id: 'guess', heading: 'What do you think?', icon: 'a question mark' },
];
const PLAY_IDS = PLAY_KINDS.map((x) => x.id);
const designed = (book, page) => page.kind === 'page' && (book.image?.pageStyle || 'classic') !== 'classic' && page.design?.panels?.length > 0;
// Every word the designed page letters into its picture, in reading order.
function designLettering(page) {
  const d = page.design, play = PLAY_KINDS.find((k) => k.id === d.play?.type);
  return [...d.panels.flatMap((x) => [x.caption, x.speech]), play && d.play.prompt && play.heading, play && d.play.prompt, d.fact && 'Did you know?', d.fact, d.grownups && `For grown-ups: ${d.grownups}`].filter(Boolean);
}
// What a clean design looks like; anything else from the model or the browser is dropped.
function cleanDesign(v, by, clampStr) {
  if (!v || typeof v !== 'object') return null;
  const layout = LAYOUTS.find((l) => l.id === v.layout) || LAYOUTS[0];
  const panels = (Array.isArray(v.panels) ? v.panels : []).slice(0, layout.panels).map((x) => ({ caption: clampStr(x?.caption, 200), speech: clampStr(x?.speech, 80), visual: clampStr(x?.visual, 800) }));
  while (panels.length < layout.panels) panels.push({ caption: '', speech: '', visual: '' });
  const type = PLAY_IDS.includes(v.play?.type) ? v.play.type : '';
  // The heading is lettered by the page itself ("Your turn!"); a prompt that starts with it again loses the repeat.
  const head = PLAY_KINDS.find((k) => k.id === type)?.heading.replace(/[…?!.]+$/, '');
  const prompt = String(v.play?.prompt || '').replace(head ? new RegExp(`^${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[…?!.]*\\s*`, 'i') : /^$/, '');
  return { layout: layout.id, by: ['ai', 'author', 'card'].includes(by) ? by : 'ai', panels, play: { type, prompt: type ? clampStr(prompt.charAt(0).toUpperCase() + prompt.slice(1), 200) : '' }, fact: clampStr(v.fact, 300), grownups: clampStr(String(v.grownups || '').replace(/^for grown-?ups:\s*/i, ''), 300) };
}
const SAD = /sad|cross|angry|scared|afraid|worried|lonely|upset|frustrat|grumpy|shy|nervous|cry/i;
// One camera per page, chosen over the whole book by score: a planned shot wins; otherwise strong feelings go close and
// the first page and each arrival in a new place go wide. No camera repeats within three pages, no shot size twice in a
// row, and the least-used set-ups come first so the whole range gets used.
const placeOf = (p) => String(p.place || '').toLowerCase().trim() || placeKey(p.setting);
export function cameraPlan(pages) {
  const out = new Map(), recent = [], used = Object.fromEntries(CAMERAS.map((c) => [c.id, 0]));
  const story = pages.filter((p) => p.kind === 'page').sort((a, b) => a.n - b.n);
  story.forEach((p, i) => {
    const arrived = i === 0 || (placeOf(p) && placeOf(p) !== placeOf(story[i - 1]));
    const want = SHOT_IDS.includes(p.shot) ? p.shot : SAD.test(p.emotion) ? 'close' : arrived ? 'wide' : '';
    const last = CAMERAS.find((x) => x.id === recent[recent.length - 1]);
    const score = (c) => (want && c.shot === want ? (p.shot ? 8 : 4) : 0) - (recent.slice(-2).includes(c.id) ? 20 : 0)
      - (last && c.shot === last.shot ? 6 : 0) - (c.shot === 'wide' && !arrived && recent.slice(-3).some((id) => CAMERAS.find((x) => x.id === id).shot === 'wide') ? 3 : 0) - used[c.id] * 2;
    const pick = CAMERAS.map((c, k) => ({ c, s: score(c), k: (k + i * 3) % CAMERAS.length })).sort((a, b) => b.s - a.s || a.k - b.k)[0].c;
    out.set(p.id, pick); recent.push(pick.id); used[pick.id]++;
  });
  return out;
}
// The read-aloud devices of a book, kept as their own fields so the writer and the editor can hold every page to them.
const VOICE_FIELDS = [['refrain', 300], ['device', 300]];
const countWords = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
// How far a word count is outside the audience's range (0 = inside).
const offRange = (n, [lo, hi]) => (n < lo ? lo - n : n > hi ? n - hi : 0);
// The style guide as the image model should read it: only how pictures look. Sentences about the words on the page
// (word counts, reading aloud) are writing notes that strayed in, and would otherwise ride along in every picture prompt.
const WRITING_NOTE = /\bread[- ]aloud\b|\bwords? (?:per|on (?:a|each|every)) page\b|\b\d+\s*(?:[–-]|to)\s*\d+\s+(?:\w+\s+){0,2}words\b|\bword (?:count|range)\b/i;
export const visualStyle = (style) => String(style || '').split(/(?<=[.!?])\s+/).filter((x) => !WRITING_NOTE.test(x)).join(' ').trim();
// Two pages are in the same place when their settings start with the same place name ("the kelp patch; morning" / "the kelp patch; dusk").
const placeKey = (setting) => String(setting || '').split(/[;(—]| - /)[0].toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const plain = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
const MAX_PAGES = 32;
// Story pages come in fours so the book prints double-sided with no blank backs (pages 1–2 and 3–4 back to back).
// The cover prints with page 1 on its back, so the cover plus the story pages come in fours (3, 7, 11, 15 … pages):
// every piece is then printed on both sides. 15 pages + cover = two double-sided Tabloid 2x2 sheets.
const PAGE_STEP = 4;
const inFours = (n, max) => Math.min(Math.floor((max + 1) / PAGE_STEP) * PAGE_STEP - 1, Math.max(PAGE_STEP - 1, Math.ceil(((Number(n) || 0) + 1) / PAGE_STEP) * PAGE_STEP - 1));

const OUTLINE_INSTRUCTIONS = `You are an award-winning children's picture-book author and editor. From the user's brief, plan a short illustrated story book.

Craft rules:
- One clear story arc across the pages: an opening that introduces the main character and their world, a want or problem, rising attempts, a turning point, and a warm, satisfying resolution. The last page should land the theme without preaching.
- Each page is one beat: one moment that can be shown in a single illustration. Vary the beats (action, emotion, quiet moments, a page-turn surprise).
- Keep the cast small (usually 1–4 characters). If the brief lists existing characters, use them with exactly those names and do not change their appearance.
- Everything must be age-appropriate for the stated audience, kind, and free of scary or violent content beyond gentle tension.
- styleGuide: one paragraph describing the illustration style that every page will share (medium, line, color palette, lighting, mood, level of detail, backgrounds). If the brief names a style, build on it; if existing characters have an art style, match it. It says only how the pictures look: never mention the words on the page, how many there are, reading aloud or lettering in it.
- cast descriptions: concrete visual details an illustrator can repeat on every page (species or type, size, colors, clothing, distinctive features) plus a few words of personality.
- coverIllustration: the cover scene, with room for the title at the top.
- tone: two to four words. If the brief gives a tone, keep it.
- storyline: the spine of the story in five short lines. want: what the main character wants. obstacle: what stands in the way. turningPoint: the moment everything changes. resolution: how it ends. change: how the main character or their world is different at the end.
- refrain: the one line a child will join in with, in its exact words (three to eight words), used on at least three pages and echoed, perhaps with a small twist, on the last. Empty string when a refrain does not suit the book.
- device: the one other read-aloud device the whole book keeps up, in a short line (counting up, a sound word for each place, rhyming couplets, a question on every page, a closing line). If the brief's notes ask for a device or a refrain, use that. Empty string when there is none.
- world: the setting bible, one short paragraph. Where and when the story happens, the places it returns to, and the recurring objects with a fixed look (colors, sizes, materials), so that every picture can match. If the brief gives a setting, build on it.

Plan every page in full; these notes are what the writer and the illustrator work from, and the illustrator sees one page at a time:
- beat: 1–2 sentences, what happens on this page. Describe the action only; do not draft the page's read-aloud words here, they are written in a later step.
- arc: the page's stage on the narrative arc: ${ARC_STAGES.map((a) => `${a.id} (${a.hint})`).join(', ')}. Stages run in that order and never go backwards. Every book has an opening, a turning point and an ending; most pages in the middle are rising.
- purpose: one sentence on what this page does for the story: what it sets up, pays off, reveals or changes.
- characters: the names (exactly as in the cast) of every character visible on the page.
- setting: the specific place plus time of day or weather. Use the same wording for pages in the same place.
- emotion: the main character's feeling and the mood of the page, in a few words.
- continuity: what carries over from earlier pages and must be visible here (an object being carried, a change to how a character looks, something found, built or broken, the light getting later). Empty string when nothing carries over.
- Pictures must differ from page to page: never plan more than three pages in a row in the same place with the same characters visible. When the story has to stay somewhere longer, move within the place (another corner, another landmark, named in the setting) or change who is visible on the page, and spend the pages saved on the places that come next.
- shot: how close the picture is: ${SHOTS.map((x) => `${x.id} (${x.hint})`).join(', ')}. Plan the shots as a rhythm across the book: open wide to show the world, go close for the strongest feelings and the turning point, and never use the same shot on three pages in a row.
- focus: the one thing the eye should land on first in this page's picture (a face, an object, a gap between two characters), in a few words.
- turn: the page-turn hook, where the page has one: what the reader is left wondering or waiting for as the page is turned, which the NEXT page answers at once (a sound with no source yet, a door half open, a reach that has not landed, a question just asked). One short line; empty string for pages that simply rest. Give at least one page in four a hook, always including the page before the turning point, and never the last page.
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
NUMBERS: when the page's words or its picture brief state how many of something the picture shows ("seven arms hold on", "three apples left"), count them in the picture, slowly, one by one. Report each mismatch in "countProblems" (what was counted, the number stated, the number you see). Skip things that are cut off by the edge or mostly hidden, and report nothing when you cannot count with confidence.
THE PAGE BEFORE: when a second image is attached it is the previous page of the book. Set "sameAsPrevious" to true only when the two pictures would read as the same picture at a glance: the same camera distance and angle AND the same characters in the same places on the page. The same place, the same characters or the same art style alone are NOT a repeat; a clearly different distance, angle or arrangement is enough to be different. Without a second image it is false.
"pass" is true when there are no text problems, no extra text, no major picture problems, no count problems and sameAsPrevious is false.`;
const PROOF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['textProblems', 'extraText', 'pictureProblems', 'countProblems', 'sameAsPrevious', 'pass', 'fixNotes'],
  properties: {
    textProblems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['expected', 'found'], properties: { expected: { type: 'string' }, found: { type: 'string', description: 'what is lettered instead, or "missing"' } } } },
    extraText: { type: 'array', description: 'lettering in the picture that is not expected', items: { type: 'string' } },
    pictureProblems: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['issue', 'severity'], properties: { issue: { type: 'string' }, severity: { type: 'string', enum: ['major', 'minor'] } } } },
    countProblems: { type: 'array', description: 'stated numbers the picture gets wrong', items: { type: 'object', additionalProperties: false, required: ['what', 'expected', 'found'], properties: { what: { type: 'string', description: 'what was counted, e.g. "arms holding the doorway"' }, expected: { type: 'integer' }, found: { type: 'integer' } } } },
    sameAsPrevious: { type: 'boolean', description: 'true only when a previous page is attached and this picture repeats its camera and arrangement' },
    pass: { type: 'boolean' }, fixNotes: { type: 'string', description: 'if not pass: short instructions for the illustrator, one per line; otherwise ""' },
  },
};

const SCRIPT_INSTRUCTIONS = `You are a children's picture-book author working with an illustrator. You are given a book plan (title, theme, cast, style, and a beat for every page). Write the final on-page text and an illustration brief for the requested pages.

Each page comes with planning notes: its stage on the story arc, its purpose, who is in it, the setting, the feeling, what carries over from earlier pages, and its "state" (the facts at the END of that page: who is where, who holds what, what is blocked or open, the light). Each page may also carry a planned shot and focus for its picture, and a page-turn hook. Follow them. The text serves the page's purpose and feeling.

Rules for "text" (the words printed on the page):
- Fit the audience's word range per page exactly; read-aloud rhythm matters. Use repetition, sound words and gentle humor where it fits the tone.
- Keep continuity with the surrounding pages: names, facts and tone must match. Do not repeat what the picture already shows; let the words and picture work together.
- No headings, page numbers, or stage directions in the text.
- Refrain: when the plan gives a refrain, print it word for word on the pages where it belongs, at least three times across the book and on or just before the last page (a small, deliberate twist on its last use is welcome; an accidental change of wording is not). Device: when the plan names one, keep it going on every page it fits.
- Page turns: a page whose notes carry a page-turn hook ends on that hook and stops short of the answer; the next page opens by answering it.

Rules for "illustration" (sent to the image model; it never sees other pages):
- The illustrator sees ONE page at a time and knows nothing else about the story, so each brief is complete: 60–110 words describing one single moment, in this fixed order: (1) where we are, naming the place from the planning notes and the part of it, with the landmark that matters and the time of day; (2) every character in the picture and exactly where each one is AS THIS PAGE'S CAMERA SEES IT — near and large or far and small, in front or behind, at which edge, inside or outside, on top of or under what; (3) what each is doing with which part of its body, and the one feeling on its face; (4) the state of every important object — who holds it, what is blocked, stuck, open, shut or out of reach, and by how much, including every carry-over detail; (5) the camera: each page's notes give its "Camera" set-up (how close, from where), and the picture is drawn with it. Stage the whole brief for that camera — describe the scene as seen from there — and make the planned focus the clearest thing in the picture. Describe what is SEEN, not what it means.
- Every picture is its own composition. Pages that follow each other in the same place must NOT repeat an arrangement: before writing a brief, look at the one before it and change who is near and who is far, which way everyone faces, and what fills the foreground. Never give the same left-to-right line-up on two pages. A fact from the state (who is beside the door, who is inside) fixes where a character IS, not where it appears in the frame: seen from the other side, from above or from behind, the same facts make a different picture.
- Not everyone who is present is in the frame. A close-up shows the one or two characters it is about; the others are out of frame and are left out of the brief and out of "characters". A view from one character's place may leave that character out. Across a run of pages in one place, vary who is in the picture.
- Leave out what is supplied separately with every picture: do not describe the art style, rendering, line or colour treatment, and do not say where to leave room for the words. Call a recurring place or object by the name the world note gives it and do not re-describe its fixed look (colours, size, material); say only where it is and what state it is in on this page.
- Story state: the page's "state" gives the facts at the END of that page; the state of the page before it gives the facts as this page begins. The brief must agree with both. A character the state puts inside, under or behind something is drawn only there: if the picture looks in at them, say so in the brief ("seen through the gap, deep inside the hollow") and list them in "characters"; otherwise leave them out of the brief and out of "characters". Everyone and everything the page text names as present is in the brief.
- Refer to characters by name only; do not redescribe their appearance (their look is supplied separately).
- Never ask for text, letters or speech bubbles in the picture.

"characters": the names (exactly as in the cast) of every character drawn in the picture, and nobody else: never list a character who is not physically in the picture, and never leave out one who is. Keep the planned characters unless the scene needs a change.
"textPlacement": where the page text will sit over the illustration (top, bottom, left or right); the illustrator keeps that area calm and uncluttered. Decide it from the picture you have just described, not by habit: the side with the least in it (open sky or ceiling: top; open ground, floor or water: bottom; everyone gathered on one side: the other side), never over a face or the page's focus. A book whose text sits in the same place on every page is fine only if every picture truly leaves that place empty.

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
- For every page return: arc (${ARC_IDS.join(', ')}; stages run in that order and never go backwards), purpose (one sentence on what the page does for the story), characters (names exactly as in the cast who are visible on the page), setting (specific place plus time of day or weather; same wording for pages in the same place), emotion (the main character's feeling and the page's mood, a few words), continuity (what carries over from earlier pages and must be visible here; empty string when nothing does), state (where things stand at the END of the page, read off the story as it is written: where each cast member is and who cannot be seen from outside, who is holding or carrying what, what is blocked, open, stuck or moved, and the light; two to four short sentences; a fact carries forward unchanged until a page changes it), shot (${SHOT_IDS.join(', ')}: how close the picture is; no three pages in a row the same), focus (the one thing the eye should land on first, a few words), turn (the page-turn hook where the page has one: what the reader is left waiting for, which the next page answers; empty string otherwise and always for the last page).
Return every page, in order. English only.`;

// The read-aloud editor: a second pass over the written text only. It never changes what happens.
const EDIT_INSTRUCTIONS = `You are the read-aloud editor of a children's picture book. The story, the plan and the pictures are settled; you only polish the words printed on the pages. You are given the plan and the text of every page with its word count. Read the whole book aloud in your head from the first page to the last, then return a new text ONLY for the pages that need one.

What to listen for:
1. Word range: every page must be inside the audience's range. A page marked OUT OF RANGE must be brought inside it, by cutting or adding as few words as possible.
2. Breath and rhythm: every sentence can be read in one breath; long and short sentences alternate; no accidental tongue-twister; the stress falls on the word that matters.
3. Refrain and device: when the plan gives a refrain, it appears word for word at least three times and on or just before the last page; an accidental variation is restored to the exact words. When the plan names a device, a page that drops it for no reason picks it up again.
4. Words against the picture: each page's picture brief is given. Cut words that only say what the picture already shows; what the words add is sound, speech, feeling and what happens next.
5. Page turns: a page with a page-turn hook ends on the hook without giving the answer away; the page after it answers at once.
6. The ending: the last page lands how things have changed as something seen or felt, never as a stated moral.
7. Echoes: the same word opening three sentences in a row (unless it is the pattern), a name spelled two ways, a word too hard for the audience.

Rules: do not change what happens, who is present, who says what, or any fact; the pictures are drawn from the same plan. Keep the author's voice and make the smallest change that fixes the problem. Leave a page out of your answer when it already reads well; an empty list is a good answer for a book that reads well. No headings, page numbers or stage directions in the text. English only.`;
const EDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pages'],
  properties: { pages: { type: 'array', description: 'only the pages whose text changes', items: { type: 'object', additionalProperties: false, required: ['n', 'reason', 'text'], properties: {
    n: { type: 'integer', description: 'page number' }, reason: { type: 'string', description: 'what was wrong, in a few plain words' }, text: { type: 'string', description: 'the whole new text of the page' },
  } } } },
};

const pageMetaProps = {
  arc: { type: 'string', enum: ARC_IDS },
  purpose: { type: 'string' },
  characters: { type: 'array', items: { type: 'string' } },
  setting: { type: 'string' },
  emotion: { type: 'string' },
  continuity: { type: 'string' },
  state: { type: 'string', description: 'where everyone and everything is at the END of this page (who is where and who cannot be seen, who holds what, what is blocked or open, the light); 2–4 short sentences' },
  shot: { type: 'string', enum: SHOT_IDS },
  focus: { type: 'string', description: 'the one thing the eye lands on first' },
  turn: { type: 'string', description: 'the page-turn hook the next page answers, or "" when the page simply rests' },
};
const storylineSchema = { type: 'object', additionalProperties: false, required: STORYLINE_FIELDS.map(([k]) => k), properties: Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, { type: 'string' }])) };
const DETAILS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['storyline', 'world', 'pages'],
  properties: {
    storyline: storylineSchema, world: { type: 'string' },
    pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', ...Object.keys(pageMetaProps)], properties: { n: { type: 'integer', description: 'page number' }, ...pageMetaProps } } },
  },
};

const DESIGN_INSTRUCTIONS = `You are the art director of a children's picture book whose pages are designed like story cards: each page has a layout of one to four pictures (panels), a tiny caption under each, and small boxes under the pictures. The story and its full read-aloud text are settled; you turn each requested page into its design. Never change what happens.

Layouts:
${LAYOUTS.map((l) => `- ${l.id} (${l.panels} panel${l.panels > 1 ? 's' : ''}): for ${l.when}.`).join('\n')}
- A page marked "layout chosen by the author" keeps that layout. Otherwise choose the layout that suits the page's moment. Across the book the layouts vary: never the same layout on three pages in a row, and the first and last pages are usually a full picture.

Panels (exactly as many as the layout has, in reading order):
- caption: one short, plain sentence saying what happens in that panel, using names, at most 9 words. Read in order, the captions of the whole book tell the story by themselves.
- speech: what one character says or a sound word, at most 4 words ("Uh-oh!", "Hello, Bo!", "Whoosh!"), or "" for a quiet panel.
- visual: what is drawn in that panel, for an illustrator who sees only this page: where, who is in it and where each stands, what they do, the one feeling on the face, and how close and from where the camera looks (very close, medium, far away, from above, from below, from behind). The panels of a page each use a different camera (vary both the distance and the angle: a close-up of a face, a view from above, from low down, from behind a character), and each shows a real step of this page's story. A viewing rule in the world note (such as "every view uses the same side view") is only for pictures that look inside or under something; it never makes all panels share one angle. Everything in a visual agrees with the page's text and its story facts. Refer to characters by name only; do not describe their looks or the art style.

Boxes:
- play: something the child does, by type: find ("Can you find…?": something that really is drawn in this page's panels), count ("How many…?": things really drawn, at most five), move ("Your turn!": an action to copy), sound ("Say it!": a sound to make), guess ("What do you think?": what happens next). "prompt" is only what comes after the heading, at most 8 words, and never repeats the heading's words (find: "Point to little Bo."; count: "Count the stones."; move: "Take a marching step."). Vary the type from page to page.
- fact: one true, simple, checkable fact linked to something on the page (an animal, a plant, the weather), at most 15 words; "" when the page has none.
- grownups: one tip for the adult reading along, at most 14 words (a question to ask, a gesture to share, a word to stress); without the words "For grown-ups".

Which boxes a page has depends on the book's page style, given in the input. Words are for the age given: tiny, concrete, playful. English only.`;
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pages'],
  properties: { pages: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'layout', 'panels', 'playType', 'play', 'fact', 'grownups'], properties: {
    n: { type: 'integer', description: 'page number' },
    layout: { type: 'string', enum: LAYOUT_IDS },
    panels: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['caption', 'speech', 'visual'], properties: { caption: { type: 'string' }, speech: { type: 'string' }, visual: { type: 'string' } } } },
    playType: { type: 'string', enum: ['', ...PLAY_IDS] }, play: { type: 'string', description: 'the play prompt, or "" when playType is ""' },
    fact: { type: 'string' }, grownups: { type: 'string' },
  } } } },
};
const STYLE_BOXES = {
  mixed: 'Mixed toddler pages: every page has a play box and a grown-ups tip; a fact only where the page shows something a fact fits naturally (about one page in four), otherwise "". About a third of the pages are full pictures.',
  comic: 'Comic panels: most pages use 2–4 panels, with a speech bubble or sound word in most panels; every page has a fact; no play box (playType "") and no grown-ups tip (""), except a play box on the last page.',
};

const IDEAS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'premise', 'tone', 'theme'], properties: {
    title: { type: 'string' }, premise: { type: 'string' }, tone: { type: 'string', description: 'two or three words' }, theme: { type: 'string', description: 'one to three words' },
  } } } },
};

const outlineSchema = (pageCount) => ({
  type: 'object', additionalProperties: false,
  required: ['title', 'logline', 'theme', 'tone', 'styleGuide', 'refrain', 'device', 'world', 'storyline', 'cast', 'coverIllustration', 'pages'],
  properties: {
    title: { type: 'string' },
    logline: { type: 'string', description: 'one-sentence summary of the story' },
    theme: { type: 'string', description: 'the lesson or feeling the book leaves with the reader' },
    tone: { type: 'string' },
    styleGuide: { type: 'string' },
    refrain: { type: 'string', description: 'the exact repeated line, or ""' },
    device: { type: 'string', description: 'the one other read-aloud device kept up through the book, or ""' },
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
  const { storyLine = () => '', writerLine = identityLine, groupText = () => '' } = deps;
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
    b.world ??= ''; b.brief.setting ??= ''; b.logic ??= null; b.edit ??= null; b.worldSheetId ??= null; b.anchorPageId ??= null;
    for (const [k] of VOICE_FIELDS) b[k] ??= '';
    b.image.pageStyle ??= 'classic';
    for (const p of b.pages) { p.arc ??= ''; p.shot ??= ''; p.design ??= null; for (const [k] of PAGE_META) p[k] ??= ''; }
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
        pages: pages.length, scripted: pages.filter((p) => p.text).length, illustrated: b.pages.filter((p) => p.imageId).length, coverImageId: b.pages.find((p) => p.kind === 'cover')?.imageId || null, fromSeries: Boolean(b.fromSeries),
        cast: (b.cast || []).map((c) => String(c?.name || '').trim()).filter(Boolean) });
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  function cleanBrief(v = {}, prev = {}) {
    const pick = (k, max) => (k in v ? clampStr(v[k], max) : prev[k] ?? '');
    const pageCount = inFours(Number(v.pageCount ?? prev.pageCount) || 11, MAX_PAGES);
    return {
      premise: pick('premise', 4000), audience: AGE_BANDS.some((a) => a.id === (v.audience ?? prev.audience)) ? (v.audience ?? prev.audience) : '3-5',
      pageCount, tone: pick('tone', 300), theme: pick('theme', 500), setting: pick('setting', 500), style: pick('style', 1000), notes: pick('notes', 4000),
      characterIds: Array.isArray(v.characterIds) ? v.characterIds.map(String).slice(0, 8) : prev.characterIds || [],
    };
  }
  function cleanImage(v = {}, prev = {}) {
    const model = IMAGE_MODELS.some((m) => m.id === v.model) ? v.model : prev.model || IMAGE_MODELS[0].id;
    const quality = QUALITIES.includes(v.quality) ? v.quality : prev.quality || 'high';
    let size = v.size ? String(v.size) : prev.size || '2176x2816';   // quarter Letter: four pages fill an 8.5 × 11 sheet edge to edge
    validateSize(size);
    // proof: every new picture is read by the proofreader and redrawn once if it contradicts the page (on unless switched off).
    // refs: earlier pictures of the book (and its world sheet) go to the illustrator as references (on unless switched off).
    return { model, quality, size, textInImage: 'textInImage' in v ? Boolean(v.textInImage) : Boolean(prev.textInImage), proof: 'proof' in v ? Boolean(v.proof) : prev.proof !== false,
      refs: 'refs' in v ? Boolean(v.refs) : prev.refs !== false,
      // leanRefs: one reference picture per character, and no style-only page when the characters' own references carry the
      // look (references are about half of what a picture costs). Off until compared side by side.
      // draftFirst: a page gets its full picture only once it has an up-to-date draft (or already has a picture).
      leanRefs: 'leanRefs' in v ? Boolean(v.leanRefs) : Boolean(prev.leanRefs), draftFirst: 'draftFirst' in v ? Boolean(v.draftFirst) : prev.draftFirst !== false,
      // pageStyle: classic (one picture + the story text) or a designed style (panels, captions and play boxes).
      pageStyle: PAGE_STYLE_IDS.includes(v.pageStyle) ? v.pageStyle : PAGE_STYLE_IDS.includes(prev.pageStyle) ? prev.pageStyle : 'classic' };
  }
  const newPage = (kind, n, fields = {}) => ({ id: crypto.randomUUID(), kind, n, beat: '', arc: '', purpose: '', setting: '', emotion: '', continuity: '', state: '', shot: '', focus: '', turn: '', text: '', illustration: '', characters: [], textPlacement: 'bottom', imagePrompt: '', promptAuto: '', imageId: null, imageIds: [], check: null, design: null, ...fields });

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
  const SNAPSHOT_FIELDS = ['title', 'logline', 'theme', 'styleGuide', 'storyline', 'world', 'refrain', 'device', 'cast', 'pages', 'stage'];
  function snapshot(b, label) {
    b.snapshots = [...(b.snapshots || []), { at: new Date().toISOString(), label, data: structuredClone(Object.fromEntries(SNAPSHOT_FIELDS.map((k) => [k, b[k]]))) }].slice(-10);
  }
  function publicBook(b) {
    const { snapshots, ...rest } = b;
    return { ...rest, worldSheetStale: Boolean(b.worldSheetId && b.worldSheetOf != null && b.worldSheetOf !== b.world), pages: b.pages.map(({ draftOf, ...p }) => ({ ...p, ...promptState(b, p), draftCurrent: Boolean(p.draftId && draftOf === (p.imagePrompt || (canPrompt(p) ? pagePrompt(b, p) : ''))) })), undoLabel: snapshots?.length ? snapshots[snapshots.length - 1].label : null };
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
      b.logic = null; b.edit = null;      // the readers' findings were about the version just undone
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
      chars.length && `Existing characters:\n${chars.map((c) => `- ${c.name}: ${writerLine(c)}`).join('\n')}`,
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
      chars.length && `Existing characters:\n${chars.map((c) => `- ${c.name}: ${writerLine(c)}`).join('\n')}`,
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
      chars.length && `Existing characters to use (keep these exact names; their look is fixed by reference images; keep their personality, likes, worries and way of talking):\n${chars.map((c) => `- ${c.name}: ${writerLine(c)}`).join('\n')}`,
      chars.length && groupText(chars, book.id),
    ].filter(Boolean).join('\n');
  }
  // all: the studio characters, so linked cast members carry their personality notes into the writing.
  function planText(book, all = []) {
    const persona = (c) => { const l = c.characterId && all.find((x) => x.id === c.characterId); const t = l && storyLine(l); return t ? ` Personality notes (keep them in character): ${t}` : ''; };
    const a = audienceOf(book);
    const pages = book.pages.filter((p) => p.kind === 'page');
    const cams = cameraPlan(book.pages);
    return [
      `Title: ${book.title}`, `Logline: ${book.logline}`, `Theme: ${book.theme}`,
      `Audience: ages ${a.id}. ${a.guidance}. Words per page: ${a.words[0]}–${a.words[1]}.`,
      book.brief.tone && `Tone: ${book.brief.tone}`,
      `Illustration style: ${book.styleGuide}`,
      STORYLINE_FIELDS.some(([k]) => book.storyline[k]) && `Storyline:\n${STORYLINE_FIELDS.filter(([k]) => book.storyline[k]).map(([k, label]) => `- ${label}: ${book.storyline[k]}`).join('\n')}`,
      book.world ? `World: ${book.world}` : book.brief.setting && `Setting from the brief (the world note is still missing): ${book.brief.setting}`,
      book.refrain && `Refrain (these exact words): ${book.refrain}`,
      book.device && `Read-aloud device kept up through the book: ${book.device}`,
      `Cast:\n${book.cast.map((c) => `- ${c.name} (${c.role}): ${c.description}${persona(c)}`).join('\n')}`,
      `Pages:\n${pages.map((p) => [
        `Page ${p.n}${p.arc ? ` [${arcLabel(p.arc)}]` : ''}: ${p.beat}`,
        p.purpose && `  Purpose: ${p.purpose}`,
        p.characters.length && `  Characters: ${p.characters.join(', ')}`,
        p.setting && `  Setting: ${p.setting}`,
        p.emotion && `  Feeling: ${p.emotion}`,
        p.continuity && `  Carries over: ${p.continuity}`,
        p.state && `  State at the end: ${p.state}`,
        (p.shot || p.focus) && `  Picture: ${[p.shot && `${shotLabel(p.shot).toLowerCase()} shot`, p.focus && `the eye lands first on ${p.focus}`].filter(Boolean).join('; ')}`,
        cams.get(p.id) && `  Camera (write the illustration brief for exactly this set-up): ${cams.get(p.id).text}`,
        p.turn && `  Page-turn hook (the page ends here; the next page answers): ${p.turn}`,
        p.text && `  Current text: ${p.text}`,
      ].filter(Boolean).join('\n')).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }
  // The planning notes of one page as the model returned them, with cast names matched to the book's spelling.
  function cleanMeta(out, castNames) {
    return {
      arc: ARC_IDS.includes(out.arc) ? out.arc : '',
      shot: SHOT_IDS.includes(out.shot) ? out.shot : '',
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
      for (const [k, max] of VOICE_FIELDS) b[k] = clampStr(parsed[k], max);
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
      b.logic = logic; b.edit = null;
      // The last page has nothing after it to answer a hook.
      const last = b.pages[b.pages.length - 1]; if (last?.kind === 'page') last.turn = '';
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
    const { parsed, durationMs, usage } = await llmJson('book_details', DETAILS_INSTRUCTIONS, planText(book, await readCharacters()), DETAILS_SCHEMA, { type: 'book_details', bookId: id },
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
        for (const k of ['arc', 'shot', ...PAGE_META.map(([key]) => key)]) if (!p[k] && meta[k]) { p[k] = meta[k]; filled++; }
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
    const input = `${planText(book, await readCharacters())}\n\nWrite pages: ${wanted.map((p) => p.n).join(', ')}${extra ? `\n\nRevision instructions: ${extra}` : ''}`;
    const total = wanted.length;
    const { parsed, durationMs, usage } = await llmJson('book_scripts', SCRIPT_INSTRUCTIONS, input, SCRIPT_SCHEMA, { type: 'book_scripts', bookId: id, pages: wanted.map((p) => p.n) }, (t) => {
      const k = Math.min(total, Math.max(1, countKey(t, 'n')));
      progress({ phase: total === 1 ? `Rewriting page ${wanted[0].n}` : `Writing page ${wanted[k - 1].n} (${k} of ${total})`, done: Math.max(0, countKey(t, 'textPlacement')), total, snippet: lastString(t, 'text') });
    });
    const castNames = castNameMap(book.cast);
    // Read-aloud editor: after the whole book is written it is read once more for rhythm, the refrain, the page turns and
    // the word range; after a partial write it only looks at pages that came back outside the range. It changes words,
    // never the story, and a failed pass never loses the text already written.
    const range = audienceOf(book).words;
    const ns = new Set(wanted.map((w) => w.n));
    const texts = new Map((parsed.pages || []).filter((o) => ns.has(o.n)).map((o) => [o.n, clampStr(o.text, 4000)]));
    const off = [...texts].filter(([, t]) => offRange(countWords(t), range)).map(([n]) => n);
    const whole = wanted.length === pages.length;
    let edits = null;
    if (!book.fromSeries && (whole || off.length)) {
      const draft = { ...book, pages: book.pages.map((p) => (texts.has(p.n) && p.kind === 'page' ? { ...p, text: texts.get(p.n), illustration: clampStr((parsed.pages || []).find((o) => o.n === p.n)?.illustration, 2000) } : p)) };
      edits = await editPass(id, draft, whole ? null : off, (t) => progress({ phase: whole ? `Read-aloud editor: listening to the whole book (${countKey(t, 'reason')} page${countKey(t, 'reason') === 1 ? '' : 's'} polished)` : `Bringing page${off.length === 1 ? '' : 's'} ${off.join(', ')} into the word range`, snippet: lastString(t, 'text') })).catch(() => null);
    }
    let written = 0;
    const updated = await withBook(id, (b) => {
      snapshot(b, total === 1 ? `Rewrote page ${wanted[0].n}` : wanted.some((w) => w.text) ? 'Rewrote all pages' : 'Wrote page scripts');
      for (const out of parsed.pages || []) {
        const p = b.pages.find((x) => x.kind === 'page' && x.n === out.n && wanted.some((w) => w.id === x.id));
        if (!p) continue;
        p.text = clampStr(out.text, 4000); p.illustration = clampStr(out.illustration, 2000);
        p.characters = [...new Set((out.characters || []).map((n) => castNames.get(String(n).toLowerCase())).filter(Boolean))];
        p.textPlacement = PLACEMENTS.includes(out.textPlacement) ? out.textPlacement : 'bottom';
        const e = edits?.find((x) => x.n === p.n);
        if (e) p.text = e.text;
        written++;
      }
      // What the editor changed is kept for the author; notes about pages just rewritten without it are dropped.
      if (edits) b.edit = { at: new Date().toISOString(), changed: [...(whole ? [] : (b.edit?.changed || []).filter((c) => !ns.has(c.n))), ...edits.map(({ n, reason }) => ({ n, reason }))].sort((x, y) => x.n - y.n) };
      else if (b.edit) b.edit.changed = b.edit.changed.filter((c) => !ns.has(c.n));
      if (b.pages.filter((p) => p.kind === 'page').every((p) => p.text)) b.stage = 'scripted';
      // A finding whose pages were all just rewritten to an instruction is taken as dealt with; 🔎 reads the story again.
      if (extra && b.logic?.holes.length) { const done = new Set(wanted.map((w) => w.n)); b.logic.holes = b.logic.holes.filter((h) => !h.pages.length || !h.pages.every((n) => done.has(n))); }
      return b;
    });
    await appendLog({ type: 'book_scripts', bookId: id, pages: wanted.map((p) => p.n), written, instructions: extra || null, model: BOOK_MODEL, usage, durationMs,
      edited: edits ? edits.map((e) => `page ${e.n}: ${e.reason}`) : null, outOfRange: off });
    return updated;
  }

  // ---------- read-aloud editor ----------
  // The book as the editor hears it: every page's text with its word count, the hook it should end on and its picture brief.
  function editDigest(book, only) {
    const a = audienceOf(book);
    const pages = book.pages.filter((p) => p.kind === 'page');
    return [
      `Title: ${book.title}`, `Audience: ages ${a.id} (${a.label}). ${a.guidance}. Word range per page: ${a.words[0]}–${a.words[1]}.`,
      book.brief.tone && `Tone: ${book.brief.tone}`,
      book.refrain ? `Refrain (these exact words): ${book.refrain}` : 'Refrain: none planned.',
      book.device ? `Read-aloud device: ${book.device}` : 'Read-aloud device: none planned.',
      book.storyline.change && `What has changed by the end: ${book.storyline.change}`,
      `PAGES, in reading order:\n${pages.map((p) => {
        const n = countWords(p.text);
        return [
          `Page ${p.n}${p.arc ? ` [${arcLabel(p.arc)}]` : ''}: ${p.beat}`,
          p.turn && `  Page-turn hook: ${p.turn}`,
          p.illustration && `  Picture brief: ${p.illustration}`,
          `  Text (${n} word${n === 1 ? '' : 's'}${offRange(n, a.words) ? `, OUT OF RANGE: must be ${a.words[0]}–${a.words[1]}` : ''}): ${p.text || '—'}`,
        ].filter(Boolean).join('\n');
      }).join('\n')}`,
      only ? `Revise ONLY page${only.length === 1 ? '' : 's'} ${only.join(', ')}; the other pages are given so you can hear them in context.` : '',
    ].filter(Boolean).join('\n\n');
  }
  // Returns the accepted changes [{ n, reason, text }]. A change is kept only for a written page, only when the words
  // really differ, and never when it moves the page further outside the word range than it was.
  async function editPass(id, book, only, onText) {
    const range = audienceOf(book).words;
    const { parsed } = await llmJson('book_edit', EDIT_INSTRUCTIONS, editDigest(book, only), EDIT_SCHEMA, { type: 'book_edit', bookId: id }, onText);
    const seen = new Set();
    return (parsed.pages || []).map((o) => ({ n: o.n, reason: clampStr(o.reason, 300), text: clampStr(o.text, 4000) })).filter((o) => {
      const p = book.pages.find((x) => x.kind === 'page' && x.n === o.n);
      if (!p || !p.text || !o.text || o.text === p.text || seen.has(o.n) || (only && !only.includes(o.n))) return false;
      seen.add(o.n);
      return offRange(countWords(o.text), range) <= offRange(countWords(p.text), range);
    });
  }
  async function handleEdit(id, progress = () => {}) {
    const book = await getBook(id);
    if (book.fromSeries) throw new HttpError(400, 'This book is a copy of a Flash Cards story. Edit the story in Flash Cards.');
    if (!book.pages.some((p) => p.kind === 'page' && p.text)) throw new HttpError(400, 'Write the page text first.');
    const edits = await editPass(id, book, null, (t) => progress({ phase: `Read-aloud editor: listening to the whole book (${countKey(t, 'reason')} page${countKey(t, 'reason') === 1 ? '' : 's'} polished)`, snippet: lastString(t, 'text') }));
    const edit = { at: new Date().toISOString(), changed: edits.map(({ n, reason }) => ({ n, reason })).sort((x, y) => x.n - y.n) };
    const updated = await withBook(id, (b) => {
      if (edits.length) snapshot(b, 'Read-aloud edit');
      // A page the author changed while the editor was reading keeps the author's words.
      for (const e of edits) { const p = b.pages.find((x) => x.kind === 'page' && x.n === e.n); const was = book.pages.find((x) => x.kind === 'page' && x.n === e.n); if (p && was && p.text === was.text) p.text = e.text; }
      b.edit = edit;
      return b;
    });
    await appendLog({ type: 'book_edit', bookId: id, edited: edits.map((e) => `page ${e.n}: ${e.reason}`) });
    return { book: updated, edit };
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
  // The top of a designed page's prompt: the page layout, every panel with its own picture, and the boxes under them.
  function designHead(book, page, pages, layout, palette) {
    const d = page.design, play = PLAY_KINDS.find((k) => k.id === d.play.type);
    const boxes = [
      play && d.play.prompt && { pct: 14, text: `a rounded "play" box across the full width, with ${play.icon} as a small icon on the left, the heading "${play.heading}" and under it "${d.play.prompt}" in very large lettering` },
      d.fact && { pct: 13, text: `a rounded "Did you know?" box across the full width, with a small spot illustration of the fact on the left and the fact beside it` },
      d.grownups && { pct: 5, text: 'one tiny line of lettering at the very bottom edge for grown-ups' },
    ].filter(Boolean);
    const area = 100 - boxes.reduce((n, b) => n + b.pct, 0);
    const pos = (i) => (layout.panels === 1 ? 'The picture' : `Panel ${i + 1} (${layout.positions[i]})`);
    return [
      `Children's picture book page for "${book.title}", page ${page.n} of ${pages}, designed like a story card: ${layout.panels === 1 ? 'one big picture' : `${layout.panels} picture panels`} with tiny captions${boxes.length ? ' and small boxes under the pictures' : ''}.`,
      '', `Page layout (portrait, top to bottom): the picture area, about ${area}% of the page: ${layout.guide}.${boxes.map((b) => ` Then ${b.text} (about ${b.pct}%).`).join('')}`,
      `Colour: this page has its own dominant colour palette${palette ? ` (${palette})` : ''}, used boldly across the whole page including the panel borders and boxes, so it looks different from the pages around it.`,
      '', layout.panels === 1 ? 'The picture:' : 'Panels (each one a different moment, seen with a different camera: distance and angle change from panel to panel; these cameras outrank any viewing rule in the story world below):',
      ...d.panels.map((x, i) => `- ${pos(i)}: ${x.visual || page.illustration || page.beat}${x.caption ? ` Caption strip: "${x.caption.replace(/"/g, "'")}".` : ''}${x.speech ? ` Speech bubble or sound word: "${x.speech.replace(/"/g, "'")}".` : ''}`),
      play && d.play.prompt && (play.id === 'find' || play.id === 'count') ? `- Whatever the play box asks the child to find or count is clearly visible in the pictures above.` : '',
      page.text ? `\nThe story of this page, for context only (it is NOT lettered on the page): ${page.text}` : '',
    ].filter(Boolean);
  }
  function pagePrompt(book, page, fixNotes = '') {
    const pages = book.pages.filter((p) => p.kind === 'page').length;
    const present = book.cast.filter((c) => page.characters.includes(c.name));
    const unlinked = present.filter((c) => !c.characterId);
    const isCover = page.kind === 'cover';
    const design = designed(book, page) && page.design;
    const layout = design && LAYOUTS.find((l) => l.id === design.layout);
    const palette = page.setting ? (page.setting.split(';').slice(1).join(';').trim() || page.setting).replace(/\.$/, '') : '';
    const lines = design ? designHead(book, page, pages, layout, palette) : [
      isCover ? `Front cover illustration for the children's picture book "${book.title}".` : `Children's picture book illustration for "${book.title}", page ${page.n} of ${pages}.`,
      '', `Scene: ${page.illustration || page.beat}`,
    ];
    // The camera goes straight under the scene: lower down, the image model drifts back to a medium, eye-level line-up.
    // A page of several panels has a camera per panel instead (in each panel's description).
    const cam = !isCover && (!design || layout.panels === 1) && cameraPlan(book.pages).get(page.id);
    if (cam) lines.push('', `CAMERA for this page — the most important instruction about the composition. It outranks any viewing rule in the story world below, and neighbouring pages use other set-ups, so this page must look clearly different from them at a glance:`,
      `- ${cam.text}`,
      '- Do not line the characters up side by side facing the viewer; place them at different depths, sizes and heights, turned towards each other or towards what matters.',
      `- Give the background this page's own colours and light${palette ? ` (${palette})` : ''}, clearly different from the other places in the book.`);
    // Planning notes from the outline: the image model sees one page at a time, so each prompt carries its own context.
    // Each fact is said once: a written brief already names the place, and with story facts the carry-over is in them.
    const facts = storyFacts(book, page), who = inPicture(book, page);
    const brief = page.illustration, place = placeKey(page.setting);
    // A short brief (a Flash Cards copy has only "title — setting") leaves the action to the beat.
    const action = !isCover && !design && page.beat && brief && !plain(brief).includes(plain(page.beat).slice(0, 40)) && page.beat;
    const notes = [
      action && `What happens: ${action} Draw it as ONE single picture (no panels); where this note mentions panels, show the most important moment.`,
      page.setting && !(brief && place && plain(brief).includes(place)) && `Setting: ${page.setting}`,
      page.emotion && `Mood: ${page.emotion}`,
      !brief && page.focus && `Focus: the eye lands first on ${page.focus}`,
      page.continuity && !(brief && facts.length) && `Carried over from earlier pages (must be visible and match): ${page.continuity}`,
      (book.world || book.brief.setting) && (isCover
        ? `Story world: ${book.world || book.brief.setting}`
        : `Story world (keeps places and objects the same from page to page; draw ONLY the part of it where this page happens${page.place || page.setting ? ` — ${page.place || page.setting.split(/[;—]/)[0].trim()}` : ''} — and none of the other places or landmarks unless the scene above names them): ${book.world || book.brief.setting}`),
    ].filter(Boolean);
    if (notes.length) lines.push('', ...notes);
    if (facts.length) lines.push('', `Story facts — where everyone and everything is. The picture must agree with them; they are for drawing from, never for lettering${cam?.shot === 'close' ? '. In this close-up, characters and things away from the focus may be cut off by the edge or left out of frame' : ''}:`, ...facts.map((x) => `- ${x}`));
    if (who) lines.push('', `In this picture: ${who.shown.join(', ')}.${who.absent.length ? ` NOT in this picture: ${who.absent.join(', ')}.` : ''}`);
    if (unlinked.length) lines.push('', `Characters (draw them exactly like this on every page):\n${unlinked.map((c) => `- ${c.name}: ${c.description}`).join('\n')}`);
    lines.push('', `Style (identical on every page of the book): ${visualStyle(book.styleGuide) || book.brief.style || 'warm, friendly picture-book illustration'}`);
    if (design) {
      lines.push('', 'Lettering — print exactly these words, each once, spelled exactly, and no other text anywhere:', ...designLettering(page).map((x) => `- "${x.replace(/"/g, "'")}"`),
        'Caption strips are cream with very large, dark, rounded sans-serif lettering; speech bubbles are white with a dark outline, chunky comic lettering and a tail pointing at the speaker; a sound word may instead be big, bouncy and hand-lettered in a bright contrasting colour. Box headings are large and playful.',
        '', 'Constraints:', '- Panels and boxes have rounded corners and a thick cream border; no outer frame, no watermark, no signature, no page number.');
      if (who) lines.push('- Draw only the characters listed under "In this picture", each at most once per panel; no other named character appears anywhere, not even small or in the background.');
      return withFix(lines.join('\n'), fixNotes);
    }
    const area = { top: 'top quarter', bottom: 'bottom quarter', left: 'left third', right: 'right third' }[page.textPlacement] || 'bottom quarter';
    if (isCover) lines.push('', `Text: the title "${book.title}" in large, playful, highly legible lettering across the top. No other text.`);
    else if (book.image.textInImage && page.text) lines.push('', `Text: print exactly this text in the ${area}, in a clean, rounded, highly legible children's-book font on a calm area of the picture: "${page.text.replace(/"/g, "'")}". No other text.`);
    else lines.push('', `Composition: keep the ${area} of the image calm and uncluttered (simple background, no important details) so the page text can be placed there later.`);
    lines.push('', 'Constraints:', '- Full-bleed illustration, no border, no frame, no watermark, no signature.');
    if (who) lines.push('- Draw only the characters listed under "In this picture", each exactly once; no other named character appears anywhere, not even small or in the background.');
    if (!isCover && !(book.image.textInImage && page.text)) lines.push('- No text, letters, numbers, captions or speech bubbles anywhere in the image.');
    return withFix(lines.join('\n'), fixNotes);
  }

  // ---------- page design ----------
  // For a designed page style: each page gets a layout (chosen by the AI unless the author picked one), its panels with
  // captions and a picture each, and its boxes. body.pageIds: only these pages (default: pages not designed yet; body.all:
  // every page). body.layouts: { pageId: layout } chosen by the author ('' hands the choice back to the AI).
  async function handleDesign(id, body = {}, progress = () => {}) {
    const book = await getBook(id);
    const style = book.image.pageStyle;
    if (!STYLE_BOXES[style]) throw new HttpError(400, 'Choose a page style other than "Classic picture book" first (Setup → Pictures → Page style).');
    const pages = book.pages.filter((p) => p.kind === 'page');
    const only = Array.isArray(body.pageIds) && body.pageIds.length ? new Set(body.pageIds) : null;
    const wanted = pages.filter((p) => (only ? only.has(p.id) : body.all || !p.design));
    if (!wanted.length) throw new HttpError(400, 'Every page is already designed.');
    if (wanted.some((p) => !p.text && !p.beat)) throw new HttpError(400, 'Write the page text first: a page is designed from its story.');
    const chosen = body.layouts && typeof body.layouts === 'object' ? body.layouts : {};
    const lockOf = (p) => (p.id in chosen ? (LAYOUT_IDS.includes(chosen[p.id]) ? chosen[p.id] : '') : p.design?.by === 'author' ? p.design.layout : '');
    const a = audienceOf(book);
    const input = [
      `Book: "${book.title}"${book.logline ? ` — ${book.logline}` : ''}`, `Audience: ages ${a.id} (${a.label})`, `Page style: ${STYLE_BOXES[style]}`,
      `Cast: ${book.cast.map((c) => `${c.name} (${c.role})`).join('; ')}`, book.world && `World: ${book.world}`,
      `Pages:\n${pages.map((p) => {
        const w = wanted.includes(p), lock = w && lockOf(p);
        return [`Page ${p.n}${w ? ' [DESIGN THIS PAGE]' : ''}: ${p.text || p.beat}`, w && p.characters.length && `  In the picture: ${p.characters.join(', ')}`, w && p.setting && `  Setting: ${p.setting}`, w && p.emotion && `  Feeling: ${p.emotion}`,
          w && p.state && `  Story facts at the end of the page: ${p.state}`, lock && `  Layout chosen by the author: ${lock}`, !w && p.design && `  (already designed: ${p.design.layout}${p.design.play.type ? `, play ${p.design.play.type}` : ''})`].filter(Boolean).join('\n');
      }).join('\n')}`,
      `Design pages: ${wanted.map((p) => p.n).join(', ')}`,
    ].filter(Boolean).join('\n\n');
    const total = wanted.length;
    const { parsed, durationMs, usage } = await llmJson('book_design', DESIGN_INSTRUCTIONS, input, DESIGN_SCHEMA, { type: 'book_design', bookId: id, pages: wanted.map((p) => p.n) },
      (t) => progress({ phase: `Designing page ${Math.min(total, Math.max(1, countKey(t, 'layout')))} of ${total}`, done: Math.max(0, countKey(t, 'grownups')), total, snippet: lastString(t, 'caption') }));
    let made = 0;
    const updated = await withBook(id, (b) => {
      snapshot(b, total === 1 ? `Designed page ${wanted[0].n}` : 'Designed the pages');
      for (const o of parsed.pages || []) {
        const p = b.pages.find((x) => x.kind === 'page' && x.n === o.n && wanted.some((w) => w.id === x.id));
        if (!p) continue;
        const lock = lockOf(p);
        p.design = cleanDesign({ layout: lock || o.layout, panels: o.panels, play: { type: o.playType, prompt: o.play }, fact: o.fact, grownups: o.grownups }, lock ? 'author' : 'ai', clampStr);
        made++;
      }
      return b;
    });
    await appendLog({ type: 'book_design', bookId: id, style, pages: wanted.map((p) => p.n), designed: made, usage, durationMs });
    return updated;
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
    const design = designed(book, page) && page.design;
    const lettered = isCover ? book.title : design ? designLettering(page).join('\n') : book.image.textInImage && page.text ? page.text : '';
    const facts = storyFacts(book, page), who = inPicture(book, page);
    const cast = book.cast.map((c) => `- ${c.name}: ${String(c.description || '').slice(0, 220)}`).join('\n');
    const label = isCover ? 'cover' : `page ${page.n}`;
    // The page before, when it has a picture: shown small, only to catch a picture that repeats it.
    const prev = !isCover && book.pages.find((p) => p.kind === 'page' && p.n === page.n - 1 && p.imageId);
    const prevFile = prev && await deps.recordFile(prev.imageId);
    const prevBuf = prevFile && await fsp.readFile(prevFile).catch(() => null);
    const mime = (f) => `image/${path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png'}`;
    const input = [{ role: 'user', content: [{ type: 'input_text', text: [
      isCover ? `Front cover of "${book.title}".` : `Page ${page.n} of "${book.title}".`,
      lettered ? `LETTERING THAT MUST APPEAR (exactly this${isCover ? ', the title' : ''}, and no other text):\n${lettered}` : 'NO LETTERING IS EXPECTED: the picture must contain no words, letters, numbers, captions or speech bubbles at all.',
      design ? `WHAT THE PAGE SHOULD SHOW (${LAYOUTS.find((l) => l.id === design.layout).label.toLowerCase()}, in reading order):\n${design.panels.map((x, i) => `${i + 1}. ${x.visual || page.illustration || page.beat}`).join('\n')}` : `WHAT THE PICTURE SHOULD SHOW:\n${page.illustration || page.beat}`,
      !isCover && page.text && !design && !lettered && `The words printed next to it (not in the picture): ${page.text}`,
      who ? `NAMED CHARACTERS — must show: ${who.shown.join(', ')}; must NOT show: ${who.absent.join(', ') || '—'}` : isCover && page.characters.length ? `NAMED CHARACTERS expected on the cover: ${page.characters.join(', ')} (others may appear too).` : '',
      facts.length && `STORY FACTS (where everyone and everything is at this point of the story; the picture may not contradict them):\n${facts.join('\n')}`,
      !isCover && book.storyline.obstacle && `THE PROBLEM THE STORY DEPENDS ON: ${book.storyline.obstacle}`,
      cast && `CHARACTERS (how to tell them apart):\n${cast}`,
      prevBuf ? `Two images follow. The FIRST is the picture to proofread. The SECOND is page ${prev.n}, the page before it, attached only for the "sameAsPrevious" question: do not proofread it.` : '',
    ].filter(Boolean).join('\n\n') }, { type: 'input_image', image_url: `data:${mime(file)};base64,${(await fsp.readFile(file)).toString('base64')}`, detail: 'high' },
      ...(prevBuf ? [{ type: 'input_image', image_url: `data:${mime(prevFile)};base64,${prevBuf.toString('base64')}`, detail: 'low' }] : [])] }];
    const { parsed: r } = await llmJson('book_page_proof', PROOF_INSTRUCTIONS, input, PROOF_SCHEMA, { type: 'book_page_proof', bookId: id, page: label }, () => {}, 'low');
    const issues = [...(r.textProblems || []).map((x) => `Text: “${x.expected}” → ${x.found}`), ...(r.extraText || []).map((x) => `Extra text: “${x}”`), ...(r.pictureProblems || []).filter((x) => x.severity === 'major').map((x) => x.issue),
      ...(r.countProblems || []).filter((x) => x.expected !== x.found).map((x) => `Count: the page says ${x.expected} ${x.what}, the picture shows ${x.found}. Draw exactly ${x.expected}, each one separate and easy to count`),
      ...(prevBuf && r.sameAsPrevious ? [`Looks like page ${prev.n}: the same camera and the same arrangement. Use this page's own camera set-up, with a clearly different distance, angle and placing of the characters`] : [])].map((x) => clampStr(x, 400));
    const notes = (r.pictureProblems || []).filter((x) => x.severity !== 'major').map((x) => clampStr(x.issue, 400));
    const check = { imageId: recId, pass: issues.length === 0, issues, notes, repeats: prevBuf && r.sameAsPrevious ? prev.n : null, fixNotes: issues.length ? [...issues, ...notes].join('\n') : '', at: new Date().toISOString() };
    await withBook(id, (b) => { const p = b.pages.find((x) => x.id === pageId); if (p && p.imageId === recId) p.check = check; return b; });
    await appendLog({ type: 'book_page_proof', bookId: id, page: label, recordId: recId, pass: check.pass, issues });
    return check;
  }

  // body.fixNotes: mistakes of an earlier attempt to avoid. Otherwise, when proofreading is on (book.image.proof, or
  // body.proof), the picture is checked and redrawn once if it fails; the attempt with fewer problems stays selected.
  async function handlePageImage(id, pageId, body = {}) {
    // Draft first: a full picture costs several times a draft, so it is only drawn once the page's composition has been
    // seen. A page that already has a picture can be redrawn freely; books made from a card series have no drafts.
    const b0 = await getBook(id), p0 = b0.pages.find((p) => p.id === pageId);
    if (b0.image.draftFirst !== false && !b0.fromSeries && p0 && !p0.imageId && (p0.illustration || p0.beat)) {
      const label = p0.kind === 'cover' ? 'The cover' : `Page ${p0.n}`;
      if (!p0.draftId) throw new HttpError(409, `${label} has no draft yet. Draft it and look it over before drawing the full picture (or switch off “Draft first” in Brief & settings).`);
      if (p0.draftOf !== (p0.imagePrompt || pagePrompt(b0, p0))) throw new HttpError(409, `${label} was changed after its draft was drawn. Draft it again and look it over before drawing the full picture.`);
    }
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
  // ---------- reference pictures ----------
  // Words alone let places and props drift from page to page, so a picture is drawn with pictures beside it: the world
  // sheet (places and recurring objects) or, in a book without one, one earlier page: the nearest one set in the same
  // place whose picture passed proofreading, failing that the nearest good page as a style reference. (One page, not several, and
  // the nearest rather than always the first: a reference's cast and props tend to leak into the new picture.) A page
  // the author pinned as the style anchor is added as well.
  const goodPicture = (p) => !(p.check && p.check.imageId === p.imageId && !p.check.pass);
  function refPlan(book, page) {
    if (book.image.refs === false) return [];
    const out = [];
    if (book.worldSheetId) out.push({ recId: book.worldSheetId, label: 'world sheet', text: 'the world sheet of this book: its places and recurring objects, without characters. Wherever one of them appears in this picture, match its shape, colours and size. Do not copy the layout of the sheet, and do not show anything from it that the scene above does not call for.' });
    const others = book.pages.filter((p) => p.id !== page.id && p.imageId);
    const label = (p) => (p.kind === 'cover' ? 'the cover' : `page ${p.n}`);
    const nearest = (list) => [...list].sort((a, b) => Math.abs(a.n - page.n) - Math.abs(b.n - page.n) || a.n - b.n)[0];
    const story = others.filter((p) => p.kind === 'page');
    const key = page.kind === 'page' ? placeKey(page.setting) : '';
    const pinned = others.find((p) => p.id === book.anchorPageId);
    // With a world sheet the place is already fixed by the sheet, so no neighbouring page is sent: the image model copies
    // a same-place page's layout whatever the words beside it say, and a run of pages in one place turns into one picture.
    // The neighbour is then kept only as a style reference, and only when nothing else carries the style (no anchor
    // page, and no character of this page with reference pictures of its own).
    const sheet = Boolean(book.worldSheetId);
    const linked = book.cast.some((c) => c.characterId && page.characters.includes(c.name));
    // Lean references: when every character on the page has reference pictures of its own, those carry the style.
    const allLinked = Boolean(book.image.leanRefs) && page.characters.length > 0 && page.characters.every((n) => book.cast.some((c) => c.name === n && c.characterId));
    const samePlace = key && !sheet ? nearest(story.filter((p) => goodPicture(p) && placeKey(p.setting) === key)) : null;
    const noLeak = 'Who is in this picture, where they are and what they do comes only from the scene described above: never carry over a character, an object, a pose, the framing or any lettering because the reference shows it. Do NOT reuse its camera angle, its distance, the left-to-right order of the characters or its background layout: this page has its own camera set-up, given above, and must look clearly different from it at a glance.';
    if (samePlace) out.push({ recId: samePlace.imageId, label: `same place: ${label(samePlace)}`, text: `${label(samePlace)} of this same book, set in the same place. Match its rendering style, and keep the place as it is drawn there: the look of its landmarks and objects (seen now from this page's own camera). ${noLeak}` });
    if (pinned && pinned !== samePlace) out.push({ recId: pinned.imageId, label: `style anchor: ${label(pinned)}`, text: `${label(pinned)} of this same book, as a style reference only. Match its rendering, line, palette and the way the characters are drawn, so that both look like pages of one book. Its place, composition and poses belong to that page. ${noLeak}` });
    if (!samePlace && !pinned && !(sheet && linked) && !allLinked) {
      const near = nearest(story.filter(goodPicture)) || nearest(others.filter(goodPicture));
      if (near) out.push({ recId: near.imageId, label: `style: ${label(near)}`, text: `${label(near)} of this same book, as a style reference only. Match its rendering, line and the way the characters are drawn, so that both look like pages of one book. Its place, composition and poses belong to that page. ${noLeak}` });
    }
    return out;
  }
  // The planned references as images, dropping any that are gone from disk, too large to send, or over the room left
  // once the character references are counted.
  async function loadRefs(plan, room) {
    const refs = [];
    for (const r of plan) {
      if (refs.length >= room) break;
      const file = deps.recordFile && await deps.recordFile(r.recId);
      const buf = file && await fsp.readFile(file).catch(() => null);
      if (buf && buf.length <= 15 * 1024 * 1024) refs.push({ dataUrl: `data:image/${path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png'};base64,${buf.toString('base64')}`, label: r.label, text: r.text });
    }
    return refs;
  }

  // One picture of the book's places and recurring objects, drawn from the world note, shown to the illustrator with every page.
  async function handleWorldSheet(id) {
    const book = await getBook(id);
    if (!book.world) throw new HttpError(400, 'Write the world note first: the sheet is drawn from it.');
    const prompt = `World sheet for the children's picture book "${book.title}": a model sheet of its places and recurring objects, which the illustrator will match on every page.

World: ${book.world}

Layout: one clean sheet on a plain off-white background. In the upper half, each place the story returns to as its own small scene, empty of characters. In the lower half, each recurring object drawn once, on its own, large enough to read its shape, in its fixed colours and at its true size relative to the others.
Style: ${visualStyle(book.styleGuide) || book.brief.style || 'warm, friendly picture-book illustration'}

Constraints:
- No characters, people or animals anywhere on the sheet.
- No text, labels, numbers, arrows or watermarks.`;
    const r = await handleGenerate({ prompt, originalPrompt: `${book.title} — world sheet`, model: book.image.model, quality: 'high', size: '1024x1024', format: 'png', n: 1, tags: ['book', slugify(book.title || 'book'), 'world-sheet'] }, { ai: { feature: 'book_world_sheet', refs: { bookId: id } } });
    const rec = await handleUpdate(r.images[0].id, { title: `${book.title} — world sheet` });
    const updated = await withBook(id, (b) => { b.worldSheetId = rec.id; b.worldSheetOf = b.world; return b; });
    await appendLog({ type: 'book_world_sheet', bookId: id, recordId: rec.id, costUsd: rec.costUsd });
    return { book: updated, record: rec };
  }

  // ---------- draft pass ----------
  // A sketch of a page: the same prompt at low quality and about a quarter of the size, for a fraction of the price.
  // Drafts are looked at side by side before the real pictures are paid for (do the pages differ? is everyone where
  // they should be?). A draft is not the page's picture; the final picture of a page whose prompt has not changed
  // since is drawn with the draft beside it, so the approved composition is the one that gets painted.
  function draftSize(size) {
    const m = /^(\d+)x(\d+)$/.exec(size || '');
    if (!m) return '1024x1024';
    const k = Math.sqrt(700000 / (m[1] * m[2]));
    const w = Math.max(16, Math.round(m[1] * k / 16) * 16);
    let h = Math.max(16, Math.round(m[2] * k / 16) * 16);
    while (w * h < 655360) h += 16;
    return `${w}x${h}`;
  }
  const draftRef = (page, prompt) => (page.draftId && page.draftOf === prompt
    ? [{ recId: page.draftId, label: 'draft', text: 'a rough, low-quality sketch of THIS page. Keep its composition: the camera distance and angle, who is where, how large, and what is in the foreground. Paint everything afresh at full quality: the characters from their own references, clean shapes, correct lettering. Do not copy its roughness, its mistakes or its lettering.' }] : []);
  // How many extra reference pictures fit beside the characters' own (one each with lean references).
  const refRoom = (book, characterIds, all) => (deps.MAX_REFS || 16) - characterIds.reduce((n, cid) => { const k = all.find((x) => x.id === cid)?.refs.length || 0; return n + (book.image.leanRefs ? Math.min(1, k) : k); }, 0);
  async function drawDraft(id, pageId) {
    const book = await getBook(id);
    const page = book.pages.find((p) => p.id === pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    if (!page.illustration && !page.beat) throw new HttpError(400, 'This page needs an illustration brief first.');
    const all = await readCharacters();
    const characterIds = book.cast.filter((c) => c.characterId && page.characters.includes(c.name) && all.some((x) => x.id === c.characterId)).map((c) => c.characterId);
    const refs = await loadRefs(refPlan(book, page), refRoom(book, characterIds, all));
    const prompt = page.imagePrompt || pagePrompt(book, page);
    const label = page.kind === 'cover' ? 'cover' : `page ${page.n}`;
    const r = await handleGenerate({
      prompt, originalPrompt: `${book.title} — ${label} (draft): ${page.illustration || page.beat}`.slice(0, 20000), ...book.image, quality: 'low', size: draftSize(book.image.size), n: 1, format: 'png',
      characterIds, tags: ['book', slugify(book.title || 'book'), page.kind === 'cover' ? 'cover' : `page-${page.n}`, 'draft'],
    }, { ai: { feature: 'book_page_draft', refs: { bookId: id } }, refs, leanRefs: Boolean(book.image.leanRefs) });
    const rec = await handleUpdate(r.images[0].id, { title: `${book.title} — ${label} (draft)` });
    const updated = await withBook(id, (b) => { const p = b.pages.find((x) => x.id === pageId); if (p) { p.draftId = rec.id; p.draftOf = prompt; } return b; });
    await appendLog({ type: 'book_page_draft', bookId: id, page: label, recordId: rec.id, costUsd: rec.costUsd });
    return { book: updated, record: rec };
  }

  // ---------- look-alike check ----------
  // Every pair of neighbouring pages is shown to a decision model (cheap and fast: a yes/no probability, no text):
  // would the two pictures read as the same picture at a glance? Run on the drafts it catches a book that is about to
  // become one picture fifteen times before the real pictures are paid for; it works on finished pictures as well.
  const SIMILAR_Q = 'Would these two pictures read as the same picture at a glance: the same camera distance and angle AND the same characters in the same places on the page? The same place, the same characters or the same art style alone do not make them the same; a clearly different distance, angle or arrangement makes them different. Ignore the lettering and the picture quality.';
  const pictureOf = (p) => p.imageId || p.draftId || null;
  async function smallPicture(recId) {
    const file = recId && deps.recordFile && await deps.recordFile(recId);
    if (!file) return null;
    const thumb = path.join(OUTPUT_DIR, '.thumbs', `${path.basename(file, path.extname(file))}.jpg`);
    const buf = await fsp.readFile(thumb).catch(() => null);
    if (buf) return `data:image/jpeg;base64,${buf.toString('base64')}`;
    const full = await fsp.readFile(file).catch(() => null);
    return full && `data:image/${path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg') || 'png'};base64,${full.toString('base64')}`;
  }
  async function handleSimilar(id) {
    const book = await getBook(id);
    if (!deps.ai.decide) throw new HttpError(500, 'The decision model is not available on this server.');
    const story = book.pages.filter((p) => p.kind === 'page').sort((a, b) => a.n - b.n);
    const todo = story.slice(1).map((p, i) => [story[i], p]).filter(([a, b]) => pictureOf(a) && pictureOf(b));
    if (!todo.length) throw new HttpError(400, 'Two neighbouring pages need a draft or a picture first.');
    const pairs = [];
    let cost = 0, failed = '';
    const one = async ([a, b]) => {
      const [ia, ib] = await Promise.all([smallPicture(pictureOf(a)), smallPicture(pictureOf(b))]);
      if (!ia || !ib) return;
      const r = await deps.ai.decide({ feature: 'book_similar', refs: { bookId: id }, questions: [{ type: 'predicate', name: 'repeat', instructions: SIMILAR_Q }],
        input: [{ role: 'user', content: [{ type: 'input_text', text: `Two consecutive pages of one children's picture book. Image A is page ${a.n}:` }, { type: 'input_image', image_url: ia }, { type: 'input_text', text: `Image B is page ${b.n}, the page after it:` }, { type: 'input_image', image_url: ib }] }] });
      const p = r.answers.repeat?.probability;
      cost += r.costUsd || 0;
      if (typeof p === 'number') pairs.push({ a: a.n, b: b.n, aId: pictureOf(a), bId: pictureOf(b), p: +p.toFixed(3) });
    };
    // A few at a time; the first failure (no credit, no access to the model) stops the rest.
    for (let i = 0; i < todo.length && !failed; i += 4) await Promise.all(todo.slice(i, i + 4).map((t) => one(t).catch((e) => { failed = failed || e.message; })));
    if (!pairs.length) throw new HttpError(502, failed || 'The pictures could not be compared.');
    pairs.sort((x, y) => x.a - y.a);
    const updated = await withBook(id, (b) => { b.similar = { at: new Date().toISOString(), pairs }; return b; });
    await appendLog({ type: 'book_similar', bookId: id, pairs: pairs.map((x) => `${x.a}-${x.b}: ${x.p}`), costUsd: cost, error: failed || null });
    return { book: updated, costUsd: cost, compared: pairs.length, error: failed || null };
  }

  async function drawPage(id, pageId, fixNotes = '') {
    const book = await getBook(id);
    const page = book.pages.find((p) => p.id === pageId);
    if (!page) throw new HttpError(404, 'Page not found.');
    if (!page.illustration && !page.beat) throw new HttpError(400, 'This page needs an illustration brief first.');
    const all = await readCharacters();
    const characterIds = book.cast.filter((c) => c.characterId && page.characters.includes(c.name) && all.some((x) => x.id === c.characterId)).map((c) => c.characterId);
    const base = page.imagePrompt || pagePrompt(book, page);      // the prompt reviewed in the Picture prompts step, if there is one
    // The approved draft leads the references; a redraw that fixes mistakes is not held to the composition that had them.
    const refs = await loadRefs([...(fixNotes ? [] : draftRef(page, base)), ...refPlan(book, page)], refRoom(book, characterIds, all));
    const prompt = withFix(base, fixNotes);
    const label = page.kind === 'cover' ? 'cover' : `page ${page.n}`;
    const r = await handleGenerate({
      prompt, originalPrompt: `${book.title} — ${label}: ${page.illustration || page.beat}`.slice(0, 20000), ...book.image, n: 1, format: 'png',
      characterIds, tags: ['book', slugify(book.title || 'book'), page.kind === 'cover' ? 'cover' : `page-${page.n}`],
    }, { ai: { feature: 'book_page_image', refs: { bookId: id } }, refs, leanRefs: Boolean(book.image.leanRefs) });
    const rec = await handleUpdate(r.images[0].id, { title: `${book.title} — ${label}` });
    const updated = await withBook(id, (b) => {
      const p = b.pages.find((x) => x.id === pageId);
      if (p) { p.imageIds = [...(p.imageIds || []), rec.id]; p.imageId = rec.id; p.check = null; }
      return b;
    });
    await appendLog({ type: 'book_page_image', bookId: id, page: label, recordId: rec.id, characterIds, references: refs.map((x) => x.label), fix: Boolean(fixNotes), costUsd: rec.costUsd });
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
      title: '', logline: '', theme: '', styleGuide: '', world: '', refrain: '', device: '', storyline: Object.fromEntries(STORYLINE_FIELDS.map(([k]) => [k, ''])), cast: [], pages: [], logic: null, edit: null, worldSheetId: null, anchorPageId: null, image: cleanImage(body.image) };
    await writeJsonAtomic(bookFile(book.id), book);
    await appendLog({ type: 'book_created', bookId: book.id, premise: book.brief.premise });
    return book;
  }

  async function handlePatch(id, body) {
    const all = 'cast' in body ? await readCharacters() : [];
    return withBook(id, (b) => {
      if (body.brief) b.brief = cleanBrief(body.brief, b.brief);
      if (body.image) b.image = cleanImage(body.image, b.image);
      for (const [k, max] of [['title', 200], ['logline', 1000], ['theme', 1000], ['styleGuide', 2000], ['world', 2000], ...VOICE_FIELDS]) if (k in body) b[k] = clampStr(body[k], max);
      // The style anchor is a page of this book that has a picture; anything else (or null) goes back to automatic.
      if ('anchorPageId' in body) b.anchorPageId = b.pages.some((p) => p.id === body.anchorPageId && p.imageId) ? body.anchorPageId : null;
      if ('worldSheetId' in body && !body.worldSheetId) { b.worldSheetId = null; delete b.worldSheetOf; }
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
          if ('shot' in patch) p.shot = SHOT_IDS.includes(patch.shot) ? patch.shot : '';
          // A design edited by hand is the author's: its layout is kept by later "Design pages" runs and by the Flash Cards mirror.
          if ('design' in patch && p.kind === 'page') p.design = patch.design ? cleanDesign(patch.design, 'author', clampStr) : null;
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
    if (b.refrain || b.device) out.push('## Read-aloud voice', '', ...[b.refrain && `- **Refrain:** ${b.refrain}`, b.device && `- **Device:** ${b.device}`].filter(Boolean), '');
    for (const p of b.pages) {
      out.push(p.kind === 'cover' ? '## Cover' : `## Page ${p.n}${p.arc ? ` · ${arcLabel(p.arc)}` : ''}`, img(p));
      if (p.text) out.push(p.text, '');
      const meta = [p.beat && `Beat: ${p.beat}`, p.purpose && `Purpose: ${p.purpose}`, p.characters.length && `Characters: ${p.characters.join(', ')}`, p.setting && `Setting: ${p.setting}`, p.emotion && `Feeling: ${p.emotion}`, p.continuity && `Carries over: ${p.continuity}`, p.state && `State at the end: ${p.state}`, (p.shot || p.focus) && `Picture: ${[shotLabel(p.shot), p.focus && `focus on ${p.focus}`].filter(Boolean).join(' · ')}`, p.turn && `Page turn: ${p.turn}`].filter(Boolean);
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
    else if (req.method === 'POST' && a === 'design') { const body = await readJson(req).catch(() => ({})); await getBook(id); await streamed(res, url, async (progress) => pub(await handleDesign(id, body, progress))); }
    else if (req.method === 'POST' && a === 'prompts') send(res, 200, pub(await handlePrompts(id, await readJson(req))));
    else if (req.method === 'POST' && a === 'edit') { await getBook(id); await streamed(res, url, async (progress) => pub(await handleEdit(id, progress))); }
    else if (req.method === 'POST' && a === 'world-sheet') send(res, 200, pub(await handleWorldSheet(id)));
    else if (req.method === 'POST' && a === 'logic') { await getBook(id); await streamed(res, url, async (progress) => pub(await handleLogic(id, progress))); }
    else if (req.method === 'POST' && a === 'pages' && c === 'image') send(res, 200, pub(await handlePageImage(id, b, await readJson(req).catch(() => ({})))));
    else if (req.method === 'POST' && a === 'similar') send(res, 200, pub(await handleSimilar(id)));
    else if (req.method === 'POST' && a === 'pages' && c === 'draft') send(res, 200, pub(await drawDraft(id, b)));
    else if (req.method === 'POST' && a === 'pages' && c === 'check') { const check = await checkPage(id, b); send(res, 200, { check, book: publicBook(await getBook(id)) }); }
    else if (req.method === 'POST' && a === 'cast' && c === 'design') send(res, 200, pub(await handleDesignCast(id, b)));
    else if (req.method === 'GET' && a === 'prompt' && b) { const book = await getBook(id); const page = book.pages.find((x) => x.id === b); if (!page) throw new HttpError(404, 'Page not found.'); send(res, 200, { prompt: pagePrompt(book, page), references: [...draftRef(page, page.imagePrompt || pagePrompt(book, page)), ...refPlan(book, page)].map((r) => r.label) }); }
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

  return { route, config: () => ({ model: BOOK_MODEL, ageBands: AGE_BANDS.map(({ id, label, words }) => ({ id, label, words })), placements: PLACEMENTS, maxPages: MAX_PAGES, pageStep: PAGE_STEP, arcStages: ARC_STAGES, shots: SHOTS, pageStyles: PAGE_STYLES, layouts: LAYOUTS.map(({ id, label, panels, when }) => ({ id, label, panels, when })), playKinds: PLAY_KINDS, storyline: STORYLINE_FIELDS.map(([id, label]) => ({ id, label })) }) };
}
