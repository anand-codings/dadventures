// Flash Cards — analyze existing cards → reusable templates → card series (topic sets or comic-style stories).
// Self-contained module: storage under output/cards/, routes under /api/cards. Image listing comes from Print Sheets
// (same sources), image generation and character consistency from the studio, through injected deps.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const ARCHETYPES = [
  { id: 'profile', label: 'Profile (one subject, fact panels around a hero picture)' },
  { id: 'process', label: 'Process (numbered steps with arrows)' },
  { id: 'lifecycle', label: 'Life cycle / stages' },
  { id: 'system-overview', label: 'System overview (ecosystem, parts of a whole)' },
  { id: 'alphabet', label: 'Letter / number / word card' },
  { id: 'concept', label: 'Concept explainer' },
  { id: 'activity', label: 'Activity / challenge' },
  { id: 'reference-sheet', label: 'Reference sheet (how-to, routine)' },
  { id: 'story', label: 'Story / comic panels' },
  { id: 'other', label: 'Other' },
];
const ARCHETYPE_IDS = ARCHETYPES.map((a) => a.id);
const REGION_ROLES = ['title', 'subtitle', 'tagline', 'hero', 'fact-panel', 'step-panel', 'strip', 'diagram', 'comparison', 'timeline', 'map', 'challenge', 'banner', 'badge', 'footer', 'other'];
const SLOT_ROLES = REGION_ROLES.filter((r) => !['title', 'subtitle', 'tagline', 'hero'].includes(r)).concat(['story-panel', 'teaser']);

export const CARD_AUDIENCES = [
  { id: 'template', label: 'Like the template', panelWords: 0, guidance: 'follow the template\'s own writing rules and word counts exactly' },
  { id: '1-3', label: '1–3 · point and name', panelWords: 8, guidance: 'naming words and tiny phrases, one idea per panel, sounds and actions; a grown-up reads it aloud' },
  { id: '3-5', label: '3–5 · read-aloud', panelWords: 14, guidance: 'one short, simple sentence per panel, concrete everyday words, a fun comparison now and then' },
  { id: '5-8', label: '5–8 · early reader', panelWords: 22, guidance: 'one or two clear sentences per panel, one new vocabulary word explained in context' },
  { id: '8-12', label: '8–12 · curious kid', panelWords: 32, guidance: 'precise facts, numbers with units, cause and effect' },
];
const MAX_CARDS = 40;
const MAX_SLOTS = 16;
const WRITE_CHUNK = 5;
const REF_EDGE = 1536;

const ANALYZE_INSTRUCTIONS = `You are a print designer cataloguing educational flash cards and posters so their designs can be reused as templates. Study the image and describe it precisely.

- Transcribe text exactly as printed (title, subtitle, tagline, every panel heading and body text). Do not correct or invent words; if something is illegible write "[illegible]".
- archetype: the card's format. profile = one subject with fact panels around a main picture; process = numbered steps joined by arrows; lifecycle = stages of growth or change; system-overview = an ecosystem or the parts of a whole; alphabet = a letter, number or word card; concept = explains one idea without numbered steps; activity = mostly things to do; reference-sheet = how-to or routine instructions; story = narrative or comic panels.
- layout.summary: two or three sentences that describe the page structure in subject-neutral terms (for example "title block across the top, hero picture in the centre, three stacked panels down each side, a three-circle strip and a full-width banner at the bottom").
- layout.regions: every distinct region in reading order (top to bottom, left to right). position uses plain words such as "top", "left column, 2nd of 3", "centre", "bottom banner". visual says what the picture or icon inside that region shows. words is the number of body-text words in the region.
- style: describe the look concretely enough for an illustrator to reproduce it on a different subject: medium and rendering, color palette, lettering, the background treatment, how panels and headings are drawn, and the mood.
- characters: recurring mascots or people shown (for example "a smiling cartoon sun", "a girl and her dad drawing"), or "".
- brandedContent: any logo, brand name, or licensed film/TV character that appears, or "".
- issues: spelling mistakes, duplicated or garbled text, cramped or cut-off elements, or "".
Write in English.`;

const str = (description) => (description ? { type: 'string', description } : { type: 'string' });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

const ANALYSIS_SCHEMA = obj({
  title: str(), subtitle: str(), tagline: str('the short line under the subtitle, or ""'),
  topic: str('what the card teaches, in a few words'), category: str('subject area, e.g. "ocean animals", "physical science"'),
  archetype: { type: 'string', enum: ARCHETYPE_IDS }, audience: str('likely age range and reading situation'),
  summary: str('one sentence describing the card'),
  layout: obj({
    summary: str(), grid: str('e.g. "2 columns of 3 panels around a centre hero"'),
    regions: { type: 'array', items: obj({ role: { type: 'string', enum: REGION_ROLES }, position: str(), heading: str(), text: str(), visual: str(), words: { type: 'integer' } }) },
  }),
  style: obj({ medium: str(), palette: str(), typography: str(), background: str(), panels: str(), mood: str() }),
  closingLine: str('the motto or takeaway at the bottom, or ""'), sourceLine: str('the facts/source credit line, or ""'),
  characters: str(), brandedContent: str(), issues: str(),
});

const TEMPLATE_INSTRUCTIONS = `You are a print designer turning existing educational flash cards into one reusable template. You are given the analysis of one or more cards that share a format. Write a template that lets a writer and an image model make a NEW card on a different subject that clearly belongs to the same family.

- Generalize: keep what is constant across the examples, turn what varies into slots. Nothing in the template may mention the examples' specific subject (write "a painted habitat scene that suits the subject", not "an underwater reef").
- styleGuide: one dense paragraph an image model can follow: medium and rendering, lighting, color approach, lettering for titles/headings/body, how panels, heading tabs, banners and icons are drawn, and the mood.
- layoutGuide: the fixed page structure from top to bottom with positions and rough proportions, naming each slot's place. Portrait page unless the examples are landscape.
- titleHint: how the title, subtitle and tagline are worded and lettered (word limits, tone).
- heroHint: what the main picture shows and where, or "" if the format has no main picture.
- slots: the content regions other than title, subtitle, tagline, the main picture, the closing motto and the source credit, in reading order. Usually 5–10. The closing motto (banner, badge or stone at the bottom) and the source/footer credit are NEVER slots: describe their wording in closingHint and sourceHint, and where and how they are drawn in layoutGuide. Each slot has a unique kebab-case key, a short label, its position, headingHint (how its heading is phrased, or "" when it has none), contentHint (what kind of content goes there), visualHint (what picture or icon accompanies it) and maxWords for the body text (based on what the examples actually use).
- textRules: voice, reading level, sentence shape and word counts the examples follow.
- closingHint: the pattern of the motto or takeaway line at the bottom, or "". sourceHint: how a facts/source credit line appears, or "".
- Leave out logos, brand names and licensed film or TV characters even if an example contains them.
- name: a short, descriptive template name (for example "Animal profile — painted habitat with parchment panels").`;

const TEMPLATE_SCHEMA = obj({
  name: str(), description: str('one sentence: what this template is for'), archetype: { type: 'string', enum: ARCHETYPE_IDS }, audience: str(),
  styleGuide: str(), layoutGuide: str(), titleHint: str(), heroHint: str(), textRules: str(), closingHint: str(), sourceHint: str(),
  slots: { type: 'array', items: obj({ key: str(), role: { type: 'string', enum: SLOT_ROLES }, label: str(), position: str(), headingHint: str(), contentHint: str(), visualHint: str(), maxWords: { type: 'integer' } }) },
});

const GROUP_INSTRUCTIONS = `You are organizing a library of educational flash cards into template families. Each line is one card: index | folder | archetype | title | layout | style. Group cards that share the same page structure AND the same visual style, so that one template could produce all of them. Cards with the same structure but a clearly different look (for example flat vector on white versus painted scenes) belong in different groups. Every card goes in exactly one group; a card unlike all others forms its own group. Order groups from largest to smallest. For each group pick the best single example (clean, typical) as bestIndex.`;
const GROUP_SCHEMA = obj({ groups: { type: 'array', items: obj({ name: str('short template-style name'), description: str('what the cards have in common'), indexes: { type: 'array', items: { type: 'integer' } }, bestIndex: { type: 'integer' } }) } });

const PLAN_INSTRUCTIONS = `You are an editor planning a series of printed educational flash cards for children. Each card is a single illustrated page built from a fixed template. From the brief, plan the series.

For a SET (a collection): choose distinct, concrete topics inside the theme, one per card, ordered so the series builds (familiar to surprising, simple to complex). If the brief lists topics, use them in that order and only invent topics to reach the requested count. "beat" is the angle that makes that card interesting.

For a STORY (a sequence read in order, like a comic or a short picture book told on cards): plan one continuous story with a small recurring cast, a clear want or question, rising events and a warm ending. Each card is one scene that moves the story forward and teaches one real thing along the way; every card except the last ends on a small hook that makes the reader want the next card. "topic" is the scene title, "beat" is what happens and what the reader learns.

- cast: recurring characters with concrete visual descriptions an illustrator can repeat (species or type, size, colors, clothing, distinctive features) plus a few words of personality. Usually empty for a set unless the brief asks for a guide character. If existing characters are listed, use exactly those names and do not change how they look.
- Do not name or describe an art style anywhere; the look is fixed by the template.

Story foundation (STORY only) — decide these BEFORE anything else and make every card serve them. Without them a story is only a list of things that happen:
- lesson: ONE thing the child takes away about feelings or getting along with others (for example "asking for help is brave", "going slowly gets you there", "sharing makes it more fun", "it is okay to feel scared and try anyway"). If the brief names a lesson, use it. The lesson is never stated as a moral: it is shown by what the main character chooses to do at the turning point.
- want: what the main character wants, concretely, on the first card.
- flaw: the habit, fear or mistaken belief that makes this story hard for THIS character, and that the lesson answers (insists on doing everything alone; grabs without asking; rushes; gives up at the first setback; is afraid to speak up).
- challenge: the key obstacle — one specific, visible problem that cannot be solved the way the character first tries, because of the flaw. Not a string of small delays.
- stakes: what will be lost or missed if they fail, in terms a small child feels (the tide is going out, bedtime is coming, a friend is waiting, it will float away for good). A deadline or something visibly slipping away works best.
- failedTry: the character's first attempt, done the old way, which fails or makes things worse. Required: the reader must SEE the old way not working, and feel the disappointment.
- turningChoice: the moment the character decides to act differently. This choice IS the lesson in action. It must be the main character's own decision and effort — never luck, never a rescue by someone else, never a problem that simply goes away.
- change: how the last card mirrors the first with one visible difference that shows what the character has learned.

Clarity (STORY only) — a story a small child cannot follow has failed, however well built:
- The whole plot must be retellable by a four-year-old in three sentences ("The baby was lost. Ollie tried to carry it home all alone and got stuck. He asked his friends and they did it together."). Write that retelling as "logline".
- The problem and every attempt are physical and visible: each can be understood from ONE picture with no words (too heavy to lift, too high to reach, too dark to see, too wide to cross, stuck in a hole). No signalling systems, no rules to learn, no timing puzzles, nothing that needs explaining.
- One new thing per card. Each failed try is a clearly different action in a clearly different place, and each helper solves one obvious thing in one obvious way (the one with the light lights the dark; the small one fits through the small gap; the strong one pushes).
- Name things simply and keep the same name throughout (never "tails" for fish, "arm gate", "the passenger").
- Each beat is written so the picture alone shows what changed since the previous card.

One single narrative (STORY only) — the cards together are ONE story told in chapters, not separate episodes:
- Write "spine" from the foundation, using the story-spine pattern: Once upon a time… / Every day… / Until one day… / Because of that… / Because of that… / Until finally… / And ever since…
- Each card's events are CAUSED by the card before ("because of that" or "but then", never just "and then") and change the situation, so no card could be removed or swapped without breaking the story.
- arc: give every card its stage — opening, problem, rising, turning, resolution, ending — in that order, never going backwards. A story of five or more cards has: an opening that shows the want and hints at the flaw; a problem card; at least one rising card that is the failedTry; a lowest moment just before the turn, where the goal looks lost and the character feels it; exactly one turning card (the turningChoice); a resolution that follows from that choice; and an ending that shows the change. With fewer cards, combine neighbouring stages but never drop the failed try or the turning choice.
- purpose: what this card sets up, pays off or changes in the STORY, in one line of at most 20 words. Not a description of the pictures, and no notes about word counts or layout. feeling: how the main character feels on this card. Feelings must travel — for example content → shocked → determined → frustrated → hopeless → brave → proud — and no two neighbouring cards share the same feeling.
- Something small planted on the first card (an object, a skill, a promise, a friend) pays off at the turning point or the ending. Side characters who help or hinder come back when it matters; a helper may offer or encourage, but the main character does the deciding and the doing.
- world: two or three sentences describing the places and important objects of the story, so they stay the same on every card.
- Each "beat" says what happens, why it follows from the previous card, and what the main character tries or decides.

Story logic (STORY only) — the story must survive a sharp five-year-old who keeps asking "but why?":
- The obvious way out is closed, visibly. For every obstacle, name the simplest thing anyone would try (swim back out, go around, lift it, call for help) and make sure a picture shows why that does not work. A trapped character has a visible reason it cannot simply leave.
- Abilities are honest. Each character can only do what its body and size (as given in the cast) allow, and the same on every card. A helper succeeds because of what it IS (the small one fits, the one with the light shows the way, the one with claws grips), never by being stronger than the bigger main character at the very thing the main character just failed.
- Nobody arrives by coincidence. Every helper is met, and seen doing its special thing, before the lowest moment; the answer to the problem is already in the story before it is needed.
- One of each device. Never two loose stones, two hollows, two gaps or two detours; an early episode either causes something later or is cut. Two different places or things never share a name.
- Whereabouts carry forward. A character who is trapped, hidden, asleep, carried, riding on someone or left behind stays exactly so on every following card until a beat changes it; the same goes for anything held, stuck, blocked, opened, broken, lit or lost. Nobody is in two places, and nobody reappears without a card showing how.
- state: for every card, where things stand at the END of that card, as plain facts a picture could get wrong: where each cast member is (say plainly who cannot be seen from outside and why), who is holding or carrying whom or what, what is blocked, open, stuck or moved, and how much light is left. Two to four short sentences, using the same names as the cast and the places. A fact repeats unchanged from card to card until that card's beat changes it.

Longer stories (STORY with nine or more cards) — a long story needs more than a stretched short one:
- Divide it into chapters of four to six cards (three chapters for about fifteen cards). Give every card its "chapter" title. Each chapter is one sitting: it has its own smaller problem inside the big one, moves to a new part of the world, and ends on a hook; the first card of a new chapter re-orients the listener in its first line.
- The key challenge escalates. There are two or three failed tries, each failing for a different reason that comes from the same flaw, and each leaving things a little worse or the deadline a little closer.
- Around the middle something changes the problem itself (a discovery, a mistake with consequences, a new danger, or the helper needing help), so the second half is not a repeat of the first.
- Every recurring side character has a small want or worry of their own and something only they are good at; each matters to the plot at least twice, and the turning choice draws on what was learned from them.
- Thread one or two running details through the whole story (an object, a little joke, a counting-down sign of the deadline such as the light fading) and pay each of them off.
- The arc stages still run in order across the whole story: one or two opening cards, one or two problem cards, a long run of rising cards (tries, setbacks, discoveries, the lowest moment last), exactly one turning card about four fifths of the way through, then resolution and one or two ending cards.
- Colours: cards within a chapter share a family of colours with clear variation between cards; each chapter has its own family, and the palette follows the time of day or the journey.

Variety (STORY only) — young children lose interest when every card looks and feels the same, so make each card a small surprise inside a familiar frame:
- setting: every card happens in a different place within the same world and has its own dominant colour palette and light (name two or three colours). Make the palettes clearly different from card to card (in a short story consecutive cards use different hue families, e.g. blue, then coral-orange, then green, then gold, then purple; a long story follows the chapter rule above; never three near-identical cards in a row) and let them progress with the journey; the world, the cast and the theme stay the same.
- layout: when layouts are offered, choose the one that suits each beat. Never use the same layout on two cards in a row; give the biggest surprise or reveal a full-page splash.
- Hard pictures get fewer panels. A card whose picture must show someone trapped, hidden or inside something (so that inside and outside are seen together) is the easiest to draw wrong: give it the one-picture layout, or two panels at most, and this outranks the rule about not repeating a layout. Decide ONE way of looking inside (for example "a cutaway side view, as if the rock were sliced open") and write it into "world"; every picture that looks inside uses that same view.
- places.fixtures: for each place, the objects there that the plot depends on, in the exact state they are in when the story first arrives (a stone wedged across a low entrance leaving a gap one hand high; a net hooked over a forked stalk). They are painted into the place's reference picture, so be exact about position and size.
- beat: vary what happens and how the main character feels (curious, startled, giggling, a little worried, proud, sleepy). Do not repeat one pattern (such as "meets an animal and says hello") card after card. The main cast stays; new side characters may come and go.
- play: give each card one play type (find, count, move, sound, guess), never the same type twice in a row.
- refrain: a short, bouncy chant a child can join in with on every card.
- hiddenFriend: one tiny, cute thing to spot on every card, unrelated to the plot.
- Everything is accurate, kind and age-appropriate. Return exactly the requested number of cards. English only.`;

const ARC_IDS = ['opening', 'problem', 'rising', 'turning', 'resolution', 'ending'];
const FOUNDATION_FIELDS = [['lesson', 'Lesson'], ['want', 'Want'], ['flaw', 'Flaw or fear'], ['challenge', 'Key challenge'], ['stakes', 'Stakes'], ['failedTry', 'Failed try'], ['turningChoice', 'Turning choice'], ['change', 'What changes']];
const EDITOR_INSTRUCTIONS = `You are a demanding children's picture-book editor. You are given a brief and a writer's plan for a story told on a series of cards. Your job is to make it a real story with a clear storyline, a key challenge and a lesson, and return the improved plan in exactly the same structure.

Check each point and rewrite whatever fails:
1. Lesson: is there ONE lesson, and is it shown by what the main character chooses to do at the turning point, rather than said aloud or missing?
2. Flaw: does the main character have a habit, fear or mistaken belief that makes this particular problem hard for them, visible on the first cards?
3. Key challenge: is there one specific obstacle that the character's first approach cannot solve? Replace mild delays and coincidences with a real difficulty.
4. Failed try: does at least one card show the character trying the old way and failing or making it worse, and feeling it?
5. Stakes and low point: is something visibly slipping away, and is there a moment just before the turn where it seems lost?
6. Turning choice: does the main character solve the problem by their own decision and effort, in a way that enacts the lesson? Remove rescues by other characters, lucky accidents and problems that solve themselves.
7. Cause and effect: does each card happen BECAUSE of the previous one? Could any card be removed or swapped? If so, rework it.
8. Feelings: do the main character's feelings change from card to card and bottom out before the turn?
9. Ending: does the last card mirror the first with a visible change, and pay off something planted at the start?
10. Simplicity: can a four-year-old retell the plot in three sentences, and understand every card from its picture alone? Replace anything that needs explaining (signals, rules, timing, clever mechanisms, abstract obstacles) with a plain physical problem and a plain physical fix. Cut repeated beats that differ only in detail. Simplifying is more important than keeping the writer's ideas.
11. Tone: still gentle, warm, funny in places and right for the stated age; the tension is felt but never frightening.
12. Story logic: when a continuity reader's findings are attached, fix every one with the smallest change that makes the story add up (close the obvious way out visibly, give the helper a job only its body can do, introduce a helper earlier, merge a repeated device, rename a second thing). Never fix a hole by adding an explanation in words: change what happens or what is seen.
13. Hard pictures: a card that must show someone trapped, hidden or inside something has one picture, or two panels at most, and every look inside uses the single view named in "world". Each place's "fixtures" match the story as revised.
14. State: after your changes, rewrite every card's "state" so it is true for the revised story and carries forward card to card without a jump.

Keep the title, cast names, number of cards, and each card's layout, setting and play type unless changing them clearly improves the story. Keep it concrete and drawable. In "editorNotes" list in plain words the two to four most important things you strengthened (or "No changes needed" if the plan already passed every point).`;

// A second reader who does not rewrite: it only finds what does not add up, so the editor (or the author) can fix it.
const LOGIC_INSTRUCTIONS = `You are the continuity supervisor on a children's picture story told on cards, reading with the scepticism of a sharp five-year-old who keeps asking "but why?". You do not rewrite and you do not judge style. You find what does not add up. You are given the brief, the cast, and every card (its beat and state, and when it has been written, its captions, speech, picture briefs and narration).

Walk through the story card by card, keeping a private ledger of where every character and every important object is, and check:
1. Obvious way out: for each obstacle, what is the simplest thing anyone would try? Does a card SHOW why it does not work? (Why does the trapped one not swim or walk out? Why not go around? Why not ask sooner?)
2. Abilities: can each character physically do what it does, given the body and size in the cast? Does a small helper succeed by strength at exactly what the bigger main character failed at? Does anyone's ability change between cards?
3. Whereabouts: is anyone in two places, drawn or mentioned after being trapped, left behind or handed over with no card showing how they got free, or gone without a word? Does a card's picture brief or list of characters put someone where the story says they are not?
4. Object state: does something blocked, stuck, broken, held, lost or lit stay that way until a card changes it? Is the obstacle the same obstacle every time it is described (too far to reach on one card, blocked by a stone on the next)?
5. Coincidence: does a helper or a fix turn up exactly when needed without having been met before?
6. Repeats and dead ends: the same device used twice; an episode that causes nothing later and could be cut.
7. Time: does the deadline (light fading, bedtime) move steadily, never backwards, and is it kept or missed clearly?
8. Words against pictures (written cards only): do the captions, narration, picture briefs and play prompt of a card agree with each other — who is there, how many there are to count, what is being held?
9. Names: one thing with two names, or two different things or places sharing one name.

First fill in "ledger" honestly for every obstacle, every helper and every character; a line that reads "not closed", "first met at the moment of need", "the main character could have done this" or "moved with no card showing how" is a hole to report.
Report only real problems that a parent reading aloud, or a child looking at the pictures, would trip over. Each problem: the card numbers, one plain sentence saying what does not add up, and the smallest change that would fix it. severity: "breaks" = the plot does not work or a picture would contradict the story; "confusing" = a listener would stop and ask; "small" = worth tidying. Worst first, at most twelve. Return an empty list when the story truly holds together; do not invent problems to seem thorough.`;
const LOGIC_SCHEMA = obj({
  ledger: str('your working notes, written BEFORE the holes, in short lines: for each obstacle — the obvious way out and which card closes it (or "not closed"); for each helper — the card where it is first met, what only it can do, and whether the main character could have done the same; for each character and key object — where it is on every card where that changes'),
  holes: { type: 'array', items: obj({ cards: { type: 'array', description: 'the card numbers involved', items: { type: 'integer' } }, problem: str(), fix: str(), severity: { type: 'string', enum: ['breaks', 'confusing', 'small'] } }) } });

const planSchema = (count, variantIds = []) => obj({
  title: str('series title'), logline: str('one sentence describing the series'),
  foundation: obj({ lesson: str(), want: str(), flaw: str(), challenge: str(), stakes: str(), failedTry: str(), turningChoice: str(), change: str() }),
  spine: str('STORY only: the whole story told in 5–7 short sentences following the story-spine pattern; "" for a set'),
  world: str('STORY only: places and important objects; "" for a set'),
  places: { type: 'array', description: 'STORY only: the three to six distinct places the story visits; empty for a set', items: obj({ name: str('short, e.g. "The rock hollow"'), description: str('landmarks, shapes and plants an illustrator must keep the same every time; no characters; 20–40 words'), fixtures: str('objects here the plot depends on, in the state the story first finds them, with position and size; "" when none') }) },
  editorNotes: str('leave "" unless you are the editor revising a plan'),
  refrain: str('STORY only: a 3–7 word chant that returns on every card; "" for a set'),
  hiddenFriend: str('STORY only: a tiny creature or object hidden once in every picture for the child to spot (what it is and its colours, under 15 words); "" for a set'),
  cast: { type: 'array', items: obj({ name: str(), role: str(), description: str() }) },
  cards: { type: 'array', description: `exactly ${count} items in reading order`, items: obj({
    topic: str(), beat: str('1–3 sentences'), chapter: str('STORY with nine or more cards: the title of the chapter this card belongs to; otherwise ""'),
    place: str('STORY only: the name of the place (exactly as in "places") where this card happens'),
    arc: { type: 'string', enum: ['', ...ARC_IDS], description: 'STORY only; "" for a set' }, purpose: str('STORY only'), feeling: str('STORY only: one or two words'),
    state: str('STORY only: where everyone and everything is at the END of this card (who is where, who holds what, what is blocked or open, the light); 2–4 short sentences; "" for a set'),
    layout: variantIds.length ? { type: 'string', enum: variantIds } : str('always ""'),
    setting: str('STORY only: where this card happens and its own colour palette and light, e.g. "a kelp forest, emerald and lime greens with golden light shafts"; "" for a set'),
    play: { type: 'string', enum: ['', ...PLAY_TYPES], description: 'STORY only: what the child is invited to do on this card; "" for a set' },
  }) },
});

const WRITE_INSTRUCTIONS = `You are a children's non-fiction writer and comic scripter filling in flash cards. Every card is one illustrated page that follows a fixed template; all text is printed inside the picture by an image model, so every word you write will appear on the card exactly as written.

For each requested card return:
- title, subtitle, tagline following the template's title guidance (tagline may be "" if the template has none).
- hero: what the main picture shows (20–50 words: subject, pose or action, setting, lighting), or "" if the template has no main picture.
- slots: one entry for every slot of that card's layout followed by the template's common slots, same keys, same order (when the template has no layouts: every template slot). "heading" follows the slot's heading guidance ("" if none). "text" is the body text, within the slot's word limit and, when the audience sets a per-panel limit, within that too (whichever is smaller). "visual" is the small picture, icon or diagram for that slot (8–25 words), concrete and drawable. For a STORY panel, "visual" is instead a full picture brief (see "Picture briefs" below) and "shows" lists the cast members drawn in that panel; for every other slot "shows" is empty.
- narration: STORY only ("" for a set): the read-aloud text of this chapter, told as a storyteller would on an audio story card, in the past tense, with the length given in the brief. It begins exactly where the previous card's narration stopped and ends at a moment that pulls the listener to the next card. It tells the whole chapter (including feelings and why things happen), while the words printed on the card stay tiny. Use the characters' names, sound words, and the refrain where it falls naturally. Read in order, the narrations of all cards form one complete story.
- storyText: STORY only ("" for a set): the story of this card as it can be PRINTED on the card itself, for families who read straight from the cards. A condensed version of the narration with the length given in the brief: same events, the key line of speech, the feeling; past tense; names, not "he". Read in order across the cards, the storyTexts alone tell the complete story.
- closing: the bottom motto or takeaway, following the template's closing pattern, or "".
- source: a facts credit line only when a real, well-known organisation is the natural authority for these facts (for example "Facts: NOAA Fisheries"). Never invent a citation; use "" when unsure.
- characters: names (exactly as in the cast) of every recurring character drawn on the card.

Rules:
- Facts must be well established and correct. Prefer rounded, hedged numbers ("up to about 60 feet"). No myths, no invented statistics. If a diagram simplifies reality, say so in a tiny note inside the relevant slot text (for example "Simple model").
- Write for the stated audience. Short, concrete, read-aloud friendly. No text that merely repeats another panel.
- Do not write layout instructions, emoji or markdown in any text field. Use plain punctuation.
- In a STORY series the cards read in order: keep names, facts and tone continuous, let captions and speech carry the story from where the previous card stopped, and make the final slot or closing line of every card except the last lead into the next one. Refer to cast members by name only in "hero" and "visual" (their look is supplied separately).
- In a SET each card stands alone but uses parallel wording and structure so the series feels like a family.
- When a card has a setting, set its pictures there and use its colours; when it has a play type, the play slot follows that type, and anything the child is asked to find or count must be described, in exactly that number, in that card's picture descriptions. Do not mention the hidden friend anywhere (it is added to the pictures automatically).
- If the series has a refrain, use it exactly as the template's closing guidance says. One exception, which overrides the template: on a card where what the refrain promises is visibly not happening (the one being taken home is lost, stuck or out of reach; the lowest moment), the bottom line is a short variation in the same rhythm that fits the moment ("Hold on, little one!"), never the cheerful refrain unchanged.
- STORY craft: dramatize, do not summarize. Each card's narration shows what the main character wants in this moment, what they try, what happens, and how they feel about it (use the card's feeling). On the failed-try card the old way visibly does not work. On the lowest moment the character nearly gives up. On the turning card the narration shows the character deciding — a thought, a breath, a line of speech — and then doing the new thing themselves. On the last card the change is shown in an action that mirrors the opening.
- The lesson is never written as a moral or announced by the narrator ("and so he learned that…"). A character may say something natural in the moment ("Could you help me?"). If the template has a line for grown-ups, on the LAST card make it a talk-about-it question tied to the lesson (for example "Talk about it: when did you ask a friend for help?"); on other cards it stays a real fact.
- Caption chain: the caption strips, read by themselves in order across ALL the cards with nothing else, must tell the whole story clearly. So captions use the characters' names (not "he"), say what happens rather than set a mood, and the first caption of each card connects to the last caption of the card before, often starting "But", "So" or "Then". Before finishing, read only the captions from first card to last and fix any place where the story cannot be followed.
- Speech bubbles add feeling or a tiny line of talk; they never carry plot that the caption leaves out. Use the same simple name for a thing every time.
- The words printed on the card (captions, speech, sound words) carry the same beats as the narration in miniature: the failed try gets an "Oh no!" or "Stuck!", the turn gets the brave little line.
- Picture briefs (STORY panels): the illustrator sees ONE card at a time and knows nothing else about the story, so each panel's "visual" is a complete brief of 35–70 words, in this order: (1) where we are, naming the place and the part of it, with the landmark that matters; (2) every character in the picture and exactly where each one is — left or right, in front or behind, inside or outside, on top of or under what; (3) what each is doing with which part of its body, and the one feeling on its face; (4) the state of every important object — who holds it, what is blocked, stuck, open, shut or out of reach, and by how much; (5) how close the camera is and from where. Describe what is SEEN, not what it means. Leave colours and light to the card's setting. Everyone and everything the caption names is in the brief.
- Story state: each card lists its "state", the facts at the END of that card; the card before it gives the facts as this card begins. Every panel must agree with them. A character the state puts inside, under or behind something is drawn only there: in a panel that looks in at them, say so in the brief ("seen through the entrance, deep inside the hollow, behind the stone") and list them in "shows"; in every other panel leave them out of the brief and out of "shows". Never list in "shows" a character who is not physically in that picture, and never leave out one who is.
- The play prompt must be answerable from the pictures exactly as briefed: something to count appears in that exact number in one named panel, and something to find is clearly drawn once.
- If revision instructions are given, apply them to the requested cards and keep everything else consistent.`;

const cardsSchema = obj({
  cards: { type: 'array', items: obj({
    n: { type: 'integer', description: 'card number' }, title: str(), subtitle: str(), tagline: str(), hero: str(),
    slots: { type: 'array', items: obj({ key: str(), heading: str(), text: str(), visual: str(), shows: { type: 'array', description: 'STORY panels: cast names (exactly as in the cast) of everyone drawn in this panel; otherwise empty', items: { type: 'string' } } }) },
    narration: str(), storyText: str('STORY only; "" for a set'), closing: str(), source: str(), characters: { type: 'array', items: { type: 'string' } },
  }) },
});

const BIBLE_INSTRUCTIONS = `You are the character designer on a children's picture-book series, writing the character bible page for one character. The page is a production document: everything on it must help an illustrator or writer keep this character identical and in character on every page. You are given the story, the character's description, and what the character does and says in it.

- Stay faithful to the story and the existing design; add depth, never contradictions. Invent only small consistent details (age in animal terms, favourite thing, a habit).
- Everything is child-appropriate and concrete. Short phrases, not sentences, wherever a list is asked for.
- facts: 6–8 label/value pairs such as Full name, Nickname, Species, Age, Size (with units, and compared with another cast member), Home, Role in the story, Favourite thing.
- callouts: exactly 3 short handwritten-style notes pointing at distinctive parts of the face or body, each naming the feature and what it is like or does (max 8 words each).
- designParts: 4–5 parts of the body or permanent accessories that define the design (for an animal: eyes, fins or limbs, skin or fur or feathers, markings, tail…), each with a note of 8–16 words on its exact shape, colour and texture.
- palette: 5–6 colours, each with a plain colour name and where it appears.
- onModelRules: 4 rules beginning "Always" or "Never" that prevent the most likely drawing mistakes.
- heroScene: one typical moment in the character's own world, showing this character ALONE (no other cast members or animals).`;
const BIBLE_SCHEMA = obj({
  epithets: str('two short epithets separated by " | ", e.g. "The Curious One | The Pearl Keeper"'), quote: str('one line the character would say, max 16 words'),
  facts: { type: 'array', items: obj({ label: str(), value: str() }) },
  coreTraits: { type: 'array', items: str() }, wantAndWorry: str('what they want most and what worries them, max 28 words'),
  habits: { type: 'array', description: '4 recognisable behaviours, max 6 words each', items: str() }, moodBaseline: str('max 14 words'),
  callouts: { type: 'array', items: str() },
  designParts: { type: 'array', items: obj({ name: str(), note: str() }) },
  props: { type: 'array', description: '2–4 objects that belong with the character, or empty', items: str() },
  palette: { type: 'array', items: obj({ name: str(), where: str() }) },
  heroScene: obj({ description: str('what the character is doing, 15–30 words'), environment: str(), lighting: str(), colourTone: str(), expression: str() }),
  onModelRules: { type: 'array', items: str() }, textures: { type: 'array', description: '4–5 surface textures of the character, 1–3 words each', items: str() },
});

// A layout the user's existing cards do not cover: comic-style story panels. Seeded once; editable like any template.
const BUILTIN_TEMPLATES = [{
  id: 'builtin-comic-story', builtin: true, name: 'Comic story card — four panels', archetype: 'story',
  description: 'One scene of a continuing story told in four comic panels with captions and speech bubbles, plus a small fact box. Pair it with one of your own templates as the look.',
  audience: 'ages 3–8, read together',
  styleGuide: 'Warm, richly painted children\'s picture-book illustration with soft cinematic lighting, expressive friendly characters and saturated natural colors. Panels have rounded corners and a thin cream border with a soft drop shadow. Caption boxes are cream parchment with dark rounded sans-serif lettering; speech bubbles are white with a clean dark outline and bold, rounded comic lettering. Headings are chunky rounded capitals with a subtle outline. Cheerful, curious, gentle mood.',
  layoutGuide: 'Portrait page. Top 14%: title block with the card title in large chunky lettering and a smaller subtitle ribbon beneath it. Middle 62%: four comic panels in a 2 × 2 grid read left to right, top to bottom, separated by even gutters; each panel has a small numbered corner tab, one caption box along its top or bottom edge and at most one speech bubble with a tail pointing at the speaker. Lower 14%: a full-width "Did you know?" fact box with a small icon on the left. Bottom 10%: a teaser ribbon that leads to the next card.',
  titleHint: 'Title: the scene title, 2–5 words. Subtitle: a short line that sets the scene, up to 7 words. No tagline.',
  heroHint: '',
  textRules: 'Captions are narration in simple present or past tense, one short sentence each. Speech is what a character says aloud, one short line. The fact box states one real, checkable fact connected to the scene.',
  closingHint: 'A short hook for the next card, such as "Next: the river crossing!" On the last card, a warm closing line instead.',
  sourceHint: '',
  slots: [1, 2, 3, 4].map((i) => ({ key: `panel-${i}`, role: 'story-panel', label: `Panel ${i}`, position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'][i - 1] + ' of the 2 × 2 grid', headingHint: 'The caption box: one short narration sentence (max 12 words).', contentHint: 'The speech bubble: one short line a character says or a sound word (Splash! Peep!). Give most panels one; use "" only for a deliberately quiet panel.', visualHint: 'The moment drawn in this panel: who, doing what, where, expression and framing.', maxWords: 12 }))
    .concat([{ key: 'did-you-know', role: 'fact-panel', label: 'Did you know?', position: 'full-width box under the panels', headingHint: 'Always "Did you know?"', contentHint: 'One real fact that connects to the scene.', visualHint: 'A small icon or spot illustration of the fact.', maxWords: 18 }]),
  exampleIds: [], refImageId: null,
}, {
  id: 'builtin-story-mix', builtin: true, name: 'Toddler story — mixed layouts', archetype: 'story',
  description: 'A story for the youngest readers where every card looks different: full-page splash cards, two-, three- and four-panel cards, each with its own colours, something for the child to do, and a refrain to chant.',
  audience: 'ages 1–4, read together',
  styleGuide: 'Soft, rounded children\'s picture-book illustration with gentle airbrushed shading, glossy friendly characters with big expressive eyes, and simple uncluttered backgrounds. Each card has its own dominant colour palette (given per card) used boldly across the whole page. Panels have rounded corners and a thick cream border. Caption strips are cream with dark, very large rounded sans-serif lettering; speech bubbles are white with a dark outline and chunky comic lettering; sound words are big, bouncy and hand-lettered in a bright contrasting colour. The title is huge, puffy, rounded lettering. Joyful, cuddly, surprising.',
  layoutGuide: 'Portrait page. Top 13%: the card title in huge puffy lettering (no subtitle ribbon unless a subtitle is given). Middle 62%: the story pictures, arranged as described under "Picture area" below. Then a rounded "play" box about 13% tall across the full width, with a small icon on the left and its prompt in very large lettering. Bottom 8%: a ribbon carrying the bottom line. A single tiny line for grown-ups sits under the ribbon at the very bottom edge.',
  titleHint: 'Title: 1–4 playful words, often a sound, a question or an exclamation. Subtitle: leave "". No tagline.',
  heroHint: '',
  textRules: 'Written for a one-to-three-year-old listening on a lap. Captions are one tiny sentence. Speech is a few words or a sound word (Whoosh! Pop! Uh-oh!). Use repetition, rhythm, animal sounds and questions. Never more words than the limits.',
  closingHint: 'The series refrain, word for word, on every card except the last; the last card answers or completes the refrain warmly.',
  sourceHint: '',
  variants: [
    { id: 'splash', label: 'Splash — one full-page picture', when: 'the opening, the biggest surprise or reveal, or the cosy ending', layoutGuide: 'Picture area: ONE large picture filling the whole area edge to edge, with a single caption strip along its bottom and at most one speech bubble or sound word.', panels: 1 },
    { id: 'duo', label: 'Two panels — before and after', when: 'a simple cause and effect, a peekaboo, or a question and its answer', layoutGuide: 'Picture area: TWO wide panels stacked one above the other, equal height, each with a caption strip and at most one speech bubble or sound word. Small corner numbers 1 and 2.', panels: 2 },
    { id: 'trio', label: 'Three panels — one wide, two small', when: 'arriving somewhere new and then two quick things that happen there', layoutGuide: 'Picture area: ONE wide panel across the top (about 55% of the area) and TWO smaller square panels side by side beneath it, each with a caption strip and at most one speech bubble or sound word. Small corner numbers 1, 2 and 3.', panels: 3 },
    { id: 'quad', label: 'Four panels — a busy little sequence', when: 'a quick funny sequence of four small actions; use at most once in a short series', layoutGuide: 'Picture area: FOUR panels in a 2 × 2 grid read left to right, top to bottom, each with a caption strip and at most one speech bubble or sound word. Small corner numbers 1 to 4.', panels: 4 },
  ].map((v) => ({ ...v, slots: Array.from({ length: v.panels }, (_, i) => ({ key: `panel-${i + 1}`, role: 'story-panel', label: v.panels === 1 ? 'The picture' : `Panel ${i + 1}`, position: v.panels === 1 ? 'the whole picture area' : `panel ${i + 1} of ${v.panels}`, headingHint: 'The caption strip: one short, plain sentence saying what happens, using names, at most 9 words. Read in order, the captions alone tell the story.', contentHint: 'The speech bubble or sound word: at most 4 words (Whoosh! / Hello, crab! / Uh-oh!), or "" for a quiet picture.', visualHint: 'What is drawn: who, doing what, how they feel, how close the camera is (very close, medium, far away, from above). Make the camera distance and the main character\'s emotion different from the other panels.', maxWords: 4 })) })),
  slots: [
    { key: 'play', role: 'challenge', label: 'Play box', position: 'full-width rounded box under the pictures', headingHint: 'The invitation, by play type: find → "Can you find…?"; count → "How many…?"; move → "Your turn!"; sound → "Say it!"; guess → "What do you think?"', contentHint: 'What the child does, at most 8 words: something to point at or count that really is in this card\'s pictures, an action to copy, a sound to make, or a guess about what happens next.', visualHint: 'A small simple icon for the box (pointing hand, numbers, wiggling arms, an open mouth, a question mark).', maxWords: 8 },
    { key: 'grown-ups', role: 'footer', label: 'For grown-ups', position: 'tiny line at the very bottom edge', headingHint: '', contentHint: 'One true fact about something on this card for the adult to share, starting "For grown-ups:" and at most 14 words in total.', visualHint: '', maxWords: 14 },
  ],
  exampleIds: [], refImageId: null,
}];
export const PLAY_TYPES = ['find', 'count', 'move', 'sound', 'guess'];

export function createCards(deps) {
  const { OUTPUT_DIR, CARD_MODEL, CARD_VISION_MODEL, API_KEY, HttpError, responseText, readJson, send, clampStr, slugify, appendLog,
    readJsonFile, writeJsonAtomic, readCharacters, handleGenerate, handleUpdate, handleCreateCharacter, handleCharacterSheet, identityLine, validateSize, IMAGE_MODELS, QUALITIES, listImages, resolveImage } = deps;
  const CARDS_DIR = path.join(OUTPUT_DIR, 'cards');
  const LIB_DIR = path.join(CARDS_DIR, 'library');
  const TPL_DIR = path.join(CARDS_DIR, 'templates');
  const SERIES_DIR = path.join(CARDS_DIR, 'series');
  const REFS_DIR = path.join(CARDS_DIR, 'refs');
  const GROUPS_FILE = path.join(CARDS_DIR, 'groups.json');
  const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);
  const exists = (p) => fsp.access(p).then(() => true, () => false);
  const idOk = (id) => /^[a-z0-9-]{3,80}$/.test(id || '');

  // ---------- LLM (Responses API, strict JSON, streamed so long calls can report progress) ----------
  async function llmJson({ name, model, instructions, input, schema, effort = 'medium', log }, onText = () => {}) {
    const { type, ...refs } = log;
    try {
      const r = await deps.ai.text({ feature: type, refs, model, instructions, input, effort, schema, schemaName: name }, onText);
      return { parsed: r.parsed, durationMs: r.durationMs, usage: r.usage, costUsd: r.costUsd };
    } catch (e) {
      await appendLog({ ...log, type: `${type}_failed`, error: e.message, model });
      throw e;
    }
  }
  const countKey = (text, key) => text.split(`"${key}"`).length - 1;
  function lastString(text, key) {
    const i = text.lastIndexOf(`"${key}"`);
    if (i < 0) return '';
    const m = /^"[^"]*"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(text.slice(i));
    return m ? m[1].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1') : '';
  }

  // ---------- reference copies (a ≤1536 px JPEG of a card: sent to the vision model and used as a style reference) ----------
  // A small JPEG of a history record (a finished card), for sending many pictures to the vision model in one call.
  async function recordJpeg(recId, edge = 1024) {
    const abs = recId && await deps.recordFile(recId);
    if (!abs) return null;
    const dest = path.join(REFS_DIR, `${sha(`${abs}|${edge}`)}.jpg`);
    if (!(await exists(dest))) {
      await fsp.mkdir(REFS_DIR, { recursive: true });
      const ok = process.platform === 'darwin' && await new Promise((resolve) => execFile('/usr/bin/sips', ['-Z', String(edge), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', abs, '--out', dest], { timeout: 120000 }, (err) => resolve(!err)));
      if (!ok) return `data:image/png;base64,${(await fsp.readFile(abs)).toString('base64')}`;
    }
    return `data:image/jpeg;base64,${(await fsp.readFile(dest)).toString('base64')}`;
  }
  async function refJpeg(imageId) {
    const abs = resolveImage(imageId);
    const st = await fsp.stat(abs).catch(() => { throw new HttpError(404, `Image not found: ${imageId}`); });
    const dest = path.join(REFS_DIR, `${sha(`${abs}|${Math.floor(st.mtimeMs)}`)}.jpg`);
    if (!(await exists(dest))) {
      await fsp.mkdir(REFS_DIR, { recursive: true });
      const ok = process.platform === 'darwin' && await new Promise((resolve) => execFile('/usr/bin/sips', ['-Z', String(REF_EDGE), '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', abs, '--out', dest], { timeout: 120000 }, (err) => resolve(!err)));
      if (!ok) {
        // No sips (not macOS): fall back to the original when it is small enough to send.
        if (st.size > 15 * 1024 * 1024) throw new HttpError(400, `${path.basename(abs)} is too large to send and could not be downscaled (needs macOS sips).`);
        const mime = { '.png': 'image/png', '.webp': 'image/webp' }[path.extname(abs).toLowerCase()] || 'image/jpeg';
        return { dataUrl: `data:${mime};base64,${(await fsp.readFile(abs)).toString('base64')}`, mtimeMs: st.mtimeMs };
      }
    }
    return { dataUrl: `data:image/jpeg;base64,${(await fsp.readFile(dest)).toString('base64')}`, mtimeMs: st.mtimeMs };
  }

  // ---------- library: one analysis file per source image ----------
  const libFile = (imageId) => path.join(LIB_DIR, `${sha(imageId)}.json`);
  const readAnalysis = (imageId) => readJsonFile(libFile(imageId), null);
  async function readLibrary() {
    const out = new Map();
    for (const name of await fsp.readdir(LIB_DIR).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const a = await readJsonFile(path.join(LIB_DIR, name), null);
      if (a?.imageId) out.set(a.imageId, a);
    }
    return out;
  }
  const brief = (a) => (a ? { analyzedAt: a.analyzedAt, title: a.analysis.title, archetype: a.analysis.archetype, category: a.analysis.category, summary: a.analysis.summary, regions: a.analysis.layout.regions.length, branded: a.analysis.brandedContent || '', issues: a.analysis.issues || '' } : null);

  async function handleLibrary() {
    const [groups, lib] = await Promise.all([listImages(), readLibrary()]);
    return { sources: groups.map((g) => ({ id: g.id, label: g.label, images: g.images.map((im) => ({ id: im.id, name: im.name, folder: im.folder, width: im.width, height: im.height, thumbUrl: im.thumbUrl, url: im.url, analysis: brief(lib.get(im.id)) })) })) };
  }

  async function analyzeOne(imageId) {
    const ref = await refJpeg(imageId);
    const { parsed, durationMs, usage } = await llmJson({
      name: 'card_analysis', model: CARD_VISION_MODEL, instructions: ANALYZE_INSTRUCTIONS, schema: ANALYSIS_SCHEMA, effort: 'low', log: { type: 'card_analysis', imageId },
      input: [{ role: 'user', content: [{ type: 'input_text', text: `File name: ${path.basename(imageId)}. Catalogue this card.` }, { type: 'input_image', image_url: ref.dataUrl, detail: 'high' }] }],
    });
    const record = { imageId, analyzedAt: new Date().toISOString(), model: CARD_VISION_MODEL, mtimeMs: ref.mtimeMs, analysis: parsed };
    await fsp.mkdir(LIB_DIR, { recursive: true });
    await writeJsonAtomic(libFile(imageId), record);
    await appendLog({ type: 'card_analysis', imageId, title: parsed.title, archetype: parsed.archetype, model: CARD_VISION_MODEL, usage, durationMs });
    return record;
  }

  async function handleAnalyze(body, progress = () => {}) {
    const ids = [...new Set((Array.isArray(body.imageIds) ? body.imageIds : []).map(String))].slice(0, 500);
    if (!ids.length) throw new HttpError(400, 'Select at least one image to analyze.');
    const lib = body.force ? new Map() : await readLibrary();
    const todo = ids.filter((id) => !lib.has(id));
    const errors = [];
    let done = 0;
    const queue = todo.slice();
    progress({ phase: `Reading ${todo.length} card${todo.length === 1 ? '' : 's'}`, done: 0, total: todo.length });
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const id = queue.shift();
        let title = '';
        try { title = (await analyzeOne(id)).analysis.title; } catch (e) { errors.push({ imageId: id, error: e.message }); }
        done++;
        progress({ phase: `Read ${done} of ${todo.length}`, done, total: todo.length, snippet: title, force: true });
      }
    }));
    return { analyzed: todo.length - errors.length, skipped: ids.length - todo.length, errors };
  }

  // Ask the writer model to sort the analyzed cards into template families.
  async function handleSuggestGroups(progress = () => {}) {
    const list = [...(await readLibrary()).values()].sort((a, b) => a.imageId.localeCompare(b.imageId));
    if (list.length < 2) throw new HttpError(400, 'Analyze at least two cards first.');
    const line = (a, i) => `${i} | ${path.dirname(a.imageId.split(':')[1] || '')} | ${a.analysis.archetype} | ${a.analysis.title} | ${a.analysis.layout.summary} | ${a.analysis.style.medium}; ${a.analysis.style.panels}`;
    const { parsed, durationMs, usage } = await llmJson({ name: 'card_groups', model: CARD_MODEL, instructions: GROUP_INSTRUCTIONS, schema: GROUP_SCHEMA, effort: 'medium', log: { type: 'card_groups' }, input: list.map(line).join('\n') },
      (t) => progress({ phase: `Sorting ${list.length} cards into families (${countKey(t, 'name')} so far)`, snippet: lastString(t, 'name') }));
    const seen = new Set();
    const groups = (parsed.groups || []).map((g) => {
      const idx = (g.indexes || []).filter((i) => Number.isInteger(i) && i >= 0 && i < list.length && !seen.has(i) && seen.add(i));
      const best = idx.includes(g.bestIndex) ? g.bestIndex : idx[0];
      return { name: clampStr(g.name, 120), description: clampStr(g.description, 500), imageIds: idx.map((i) => list[i].imageId), bestImageId: best == null ? null : list[best].imageId };
    }).filter((g) => g.imageIds.length);
    await fsp.mkdir(CARDS_DIR, { recursive: true });
    await writeJsonAtomic(GROUPS_FILE, { at: new Date().toISOString(), groups });
    await appendLog({ type: 'card_groups', cards: list.length, groups: groups.map((g) => ({ name: g.name, count: g.imageIds.length })), model: CARD_MODEL, usage, durationMs });
    return { groups };
  }

  // ---------- templates ----------
  const tplFile = (id) => { if (!idOk(id)) throw new HttpError(404, 'Template not found.'); return path.join(TPL_DIR, `${id}.json`); };
  async function seedBuiltins() {
    await fsp.mkdir(TPL_DIR, { recursive: true });
    const marker = path.join(TPL_DIR, '.seeded.json');
    const seeded = await readJsonFile(marker, []);
    let changed = false;
    for (const t of BUILTIN_TEMPLATES) {
      if (seeded.includes(t.id)) continue;
      const now = new Date().toISOString();
      await writeJsonAtomic(path.join(TPL_DIR, `${t.id}.json`), { ...t, createdAt: now, updatedAt: now });
      seeded.push(t.id); changed = true;
    }
    if (changed) await writeJsonAtomic(marker, seeded);
  }
  async function listTemplates() {
    await seedBuiltins();
    const out = [];
    for (const name of await fsp.readdir(TPL_DIR)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      const t = await readJsonFile(path.join(TPL_DIR, name), null);
      if (t?.id) out.push(t);
    }
    return out.sort((a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || a.name.localeCompare(b.name));
  }
  async function getTemplate(id) {
    await seedBuiltins();
    const t = await readJsonFile(tplFile(id), null);
    if (!t) throw new HttpError(404, 'Template not found.');
    return t;
  }
  function cleanSlots(slots) {
    const used = new Set();
    return (Array.isArray(slots) ? slots : []).slice(0, MAX_SLOTS).map((s, i) => {
      let key = slugify(clampStr(s.key || s.label, 40)) || `slot-${i + 1}`;
      while (used.has(key)) key = `${key}-${i + 1}`;
      used.add(key);
      return { key, role: SLOT_ROLES.includes(s.role) ? s.role : 'other', label: clampStr(s.label, 80) || key, position: clampStr(s.position, 200), headingHint: clampStr(s.headingHint, 400),
        contentHint: clampStr(s.contentHint, 600), visualHint: clampStr(s.visualHint, 600), maxWords: Math.min(200, Math.max(0, Math.floor(Number(s.maxWords) || 0))) };
    });
  }
  function cleanTemplate(v, prev = {}) {
    const pick = (k, max) => (k in v ? clampStr(v[k], max) : prev[k] ?? '');
    const exampleIds = Array.isArray(v.exampleIds) ? v.exampleIds.map(String).slice(0, 300) : prev.exampleIds || [];
    const ref = 'refImageId' in v ? (v.refImageId ? String(v.refImageId) : null) : prev.refImageId ?? null;
    return {
      ...prev, name: pick('name', 120) || 'Untitled template', description: pick('description', 600), audience: pick('audience', 200),
      archetype: ARCHETYPE_IDS.includes(v.archetype) ? v.archetype : prev.archetype || 'other',
      styleGuide: pick('styleGuide', 3000), layoutGuide: pick('layoutGuide', 3000), titleHint: pick('titleHint', 800), heroHint: pick('heroHint', 800),
      textRules: pick('textRules', 1500), closingHint: pick('closingHint', 500), sourceHint: pick('sourceHint', 500),
      slots: 'slots' in v ? cleanSlots(v.slots) : prev.slots || [], exampleIds, refImageId: ref,
      size: /^\d+x\d+$/.test(v.size || '') ? v.size : prev.size || '1024x1536',
    };
  }
  async function saveTemplate(t) {
    await fsp.mkdir(TPL_DIR, { recursive: true });
    t.updatedAt = new Date().toISOString();
    await writeJsonAtomic(tplFile(t.id), t);
    return t;
  }

  // Pick a generation size with the same shape as the example card.
  function sizeFor(width, height) {
    if (!width || !height) return '1024x1536';
    const r = width / height;
    return r < 0.72 ? '1024x1536' : r < 0.9 ? '1024x1280' : r <= 1.1 ? '1024x1024' : r <= 1.4 ? '1280x1024' : '1536x1024';
  }

  async function handleTemplateFromCards(body, progress = () => {}) {
    const ids = [...new Set((Array.isArray(body.imageIds) ? body.imageIds : []).map(String))];
    if (!ids.length) throw new HttpError(400, 'Select at least one analyzed card.');
    progress({ phase: 'Checking the selected cards' });
    const analyses = [];
    for (const id of ids.slice(0, 300)) analyses.push(await readAnalysis(id) || await analyzeOne(id));
    const primaryId = ids.includes(body.refImageId) ? body.refImageId : ids[0];
    // Full detail for up to six examples (primary first); the rest contribute their layout summary only.
    const ordered = [analyses.find((a) => a.imageId === primaryId), ...analyses.filter((a) => a.imageId !== primaryId)];
    const detail = ordered.slice(0, 6).map((a, i) => `Example ${i + 1}${i === 0 ? ' (primary)' : ''}:\n${JSON.stringify(a.analysis)}`);
    const rest = ordered.slice(6).map((a) => `- ${a.analysis.title}: ${a.analysis.layout.summary}`);
    const extra = clampStr(body.instructions, 2000);
    const input = [detail.join('\n\n'), rest.length && `Other cards in the same family:\n${rest.join('\n')}`, extra && `Instructions from the user: ${extra}`].filter(Boolean).join('\n\n');
    // The writer model also looks at the primary example itself, so the style guide comes from the artwork rather than from a description of it.
    const content = [{ type: 'input_text', text: `${input}\n\nThe attached image is example 1 (the primary example).` }];
    try { content.push({ type: 'input_image', image_url: (await refJpeg(primaryId)).dataUrl, detail: 'high' }); } catch { content[0].text = input; }
    const { parsed, durationMs, usage } = await llmJson({ name: 'card_template', model: CARD_MODEL, instructions: TEMPLATE_INSTRUCTIONS, schema: TEMPLATE_SCHEMA, effort: 'medium', log: { type: 'card_template', imageIds: ids }, input: [{ role: 'user', content }] },
      (t) => progress(!t.includes('"slots"') ? { phase: 'Writing the style and layout guide', snippet: lastString(t, 'name') } : { phase: `Defining content slots (${countKey(t, 'key')})`, snippet: lastString(t, 'label') }));
    const dims = (await listImages()).flatMap((g) => g.images).find((im) => im.id === primaryId);
    const now = new Date().toISOString();
    const name = clampStr(body.name, 120) || parsed.name;
    const t = cleanTemplate({ ...parsed, name, exampleIds: ids, refImageId: primaryId, size: sizeFor(dims?.width, dims?.height) }, { id: `${crypto.randomBytes(3).toString('hex')}-${slugify(name).slice(0, 50) || 'template'}`, createdAt: now });
    await saveTemplate(t);
    await appendLog({ type: 'card_template', templateId: t.id, name: t.name, examples: ids.length, slots: t.slots.length, model: CARD_MODEL, usage, durationMs });
    return t;
  }

  async function handleDeleteTemplate(id) {
    const t = await getTemplate(id);
    await fsp.rm(tplFile(id), { force: true });
    await appendLog({ type: 'card_template_deleted', templateId: id, name: t.name });
    return { deleted: id };
  }

  // ---------- series ----------
  const seriesFile = (id) => { if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(404, 'Series not found.'); return path.join(SERIES_DIR, `${id}.json`); };
  let lock = Promise.resolve();
  function withSeries(id, fn) {
    const run = lock.then(async () => {
      const s = await readJsonFile(seriesFile(id), null);
      if (!s) throw new HttpError(404, 'Series not found.');
      const result = await fn(s);
      await markStale(s).catch(() => {});
      s.updatedAt = new Date().toISOString();
      await writeJsonAtomic(seriesFile(id), s);
      await mirrorBook(s).catch((e) => console.error('book mirror failed', e));
      return result;
    });
    lock = run.catch(() => {});
    return run;
  }
  // What a picture was drawn from. Every picture remembers the words lettered on it and a fingerprint of its picture
  // description; when the card's text is edited afterwards (by hand, by Tidy, or by moving the card so its badge number
  // changes), the card is marked stale: { words: now expected, was: lettered on the picture, picture: description changed }.
  const picSig = (card) => {
    const base = [card.hero, card.slots.map((x) => x.visual), [...card.characters].sort(), card.setting, card.place, card.layout];
    const facts = card.state || card.slots.some((x) => Array.isArray(x.shows)) ? [[card.state || '', card.slots.map((x) => (Array.isArray(x.shows) ? x.shows.join('|') : null))]] : [];
    return sha(JSON.stringify([...base, ...facts]));
  };
  const printSig = (s, card, t) => { const text = []; cardPrompt(s, card, t, { collect: text }); return { text, pic: picSig(card) }; };
  async function markStale(s) {
    if (!s.cards.some((c) => c.imageId)) return;
    const t = await templatesFor(s);
    for (const c of s.cards) {
      if (!c.imageId || !c.title) { c.stale = null; continue; }
      const now = printSig(s, c, t);
      c.prints = Object.fromEntries(Object.entries(c.prints || {}).filter(([k]) => (c.imageIds || []).includes(k)));
      const was = c.prints[c.imageId];
      // A picture made before this was tracked: assume it shows the text as it stands now.
      if (!was) { c.prints[c.imageId] = now; c.stale = null; continue; }
      const words = now.text.filter((x) => !was.text.includes(x)), gone = was.text.filter((x) => !now.text.includes(x));
      c.stale = words.length || gone.length || was.pic !== now.pic ? { words, was: gone, picture: was.pic !== now.pic } : null;
    }
  }
  // Story series also appear on the Story Books page: each is mirrored to output/books/<series id>.json (cover + one page per
  // card, the card picture as the illustration and the read-aloud narration as the page text). The mirror is rewritten whenever
  // the series changes, so edit the story here, not in Story Books.
  const BOOKS_DIR = path.join(OUTPUT_DIR, 'books');
  async function mirrorBook(s) {
    const file = path.join(BOOKS_DIR, `${s.id}.json`);
    const prev = await readJsonFile(file, null);
    if (prev && !prev.fromSeries) return;
    if (s.brief.kind !== 'story' || !s.cards.length) { if (prev) await fsp.rm(file, { force: true }); return; }
    const first = s.cards.find((c) => c.imageId);
    const printed = (c) => c.slots.filter((x) => x.heading || x.text).map((x) => [x.heading, x.text].filter(Boolean).join(' ')).join(' ');
    const f = s.foundation || {};
    const page = (c) => ({ id: c.id, kind: 'page', n: c.n, chapter: c.chapter || '', arc: c.arc || '', purpose: c.purpose || '', setting: c.setting || '', emotion: c.feeling || '', continuity: c.state || '', beat: c.beat || c.topic, text: c.narration || printed(c), illustration: `${c.title}${c.setting ? ` — ${c.setting}` : ''}`,
      characters: c.characters, textPlacement: 'bottom', imageId: c.imageId, imageIds: c.imageIds || [] });
    const book = {
      id: s.id, fromSeries: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, stage: s.cards.every((c) => c.title) ? 'scripted' : 'outlined',
      brief: { premise: s.brief.premise, audience: { '1-3': '0-3', '3-5': '3-5', '5-8': '5-8', '8-12': '6-9' }[s.brief.audience] || '3-5', pageCount: s.cards.length, tone: s.brief.tone,
        theme: '', style: '', notes: 'Made in Flash Cards → Series. Edit it there; this copy is refreshed automatically.', characterIds: s.brief.characterIds },
      chapterArt: s.chapterCards || {},
      title: s.title, logline: s.logline, theme: f.lesson || s.refrain || '', styleGuide: s.styleGuide || '', cast: s.cast, world: s.world || '',
      storyline: { want: f.want || '', obstacle: [f.challenge, f.failedTry && `First try: ${f.failedTry}`].filter(Boolean).join(' ') || '', turningPoint: f.turningChoice || '', resolution: s.cards.find((c) => c.arc === 'resolution')?.beat || '', change: f.change || '' },
      pages: [{ id: `${s.id.slice(0, 28)}c0ve0000`, kind: 'cover', n: 0, titlePage: !s.cover?.imageId, beat: '', text: '', illustration: s.logline, characters: s.cast.slice(0, 3).map((c) => c.name), textPlacement: 'top', imageId: s.cover?.imageId || first?.imageId || null, imageIds: s.cover?.imageId ? [s.cover.imageId] : first ? [first.imageId] : [] },
        ...s.cards.map(page)],
      image: { model: s.image.model, quality: s.image.quality, size: s.image.size, textInImage: true },
    };
    await fsp.mkdir(BOOKS_DIR, { recursive: true });
    await writeJsonAtomic(file, book);
  }
  async function getSeries(id) {
    const s = await readJsonFile(seriesFile(id), null);
    if (!s) throw new HttpError(404, 'Series not found.');
    return s;
  }
  async function listSeries() {
    const out = [];
    for (const name of await fsp.readdir(SERIES_DIR).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const s = await readJsonFile(path.join(SERIES_DIR, name), null);
      if (!s?.id) continue;
      if (s.brief.kind === 'story' && s.cards.length && !(await exists(path.join(BOOKS_DIR, `${s.id}.json`)))) await mirrorBook(s).catch(() => {});
      out.push({ id: s.id, title: s.title || s.brief.premise.slice(0, 60) || 'Untitled series', kind: s.brief.kind, templateId: s.brief.templateId, updatedAt: s.updatedAt,
        cards: s.cards.length, written: s.cards.filter((c) => c.title).length, illustrated: s.cards.filter((c) => c.imageId).length, coverImageId: s.cards.find((c) => c.imageId)?.imageId || null });
    }
    return out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }
  const audienceOf = (s) => CARD_AUDIENCES.find((a) => a.id === s.brief.audience) || CARD_AUDIENCES[0];
  function cleanBrief(v = {}, prev = {}) {
    const pick = (k, max) => (k in v ? clampStr(v[k], max) : prev[k] ?? '');
    const tid = (k) => (k in v ? (idOk(v[k]) ? v[k] : '') : prev[k] || '');
    return {
      kind: (v.kind ?? prev.kind) === 'story' ? 'story' : 'set',
      templateId: tid('templateId'), styleTemplateId: tid('styleTemplateId'),
      premise: pick('premise', 4000), topics: pick('topics', 4000), lesson: pick('lesson', 300),
      audience: CARD_AUDIENCES.some((a) => a.id === (v.audience ?? prev.audience)) ? (v.audience ?? prev.audience) : 'template',
      cardCount: Math.min(MAX_CARDS, Math.max(1, Math.floor(Number(v.cardCount ?? prev.cardCount) || 6))),
      tone: pick('tone', 300), notes: pick('notes', 4000),
      characterIds: Array.isArray(v.characterIds) ? v.characterIds.map(String).slice(0, 8) : prev.characterIds || [],
      // Another story series whose world, places, cast and look this one continues.
      basedOn: 'basedOn' in v ? (/^[a-f0-9-]{36}$/.test(v.basedOn || '') ? v.basedOn : '') : prev.basedOn || '',
    };
  }
  function cleanImage(v = {}, prev = {}) {
    const model = IMAGE_MODELS.some((m) => m.id === v.model) ? v.model : prev.model || IMAGE_MODELS[0].id;
    const quality = QUALITIES.includes(v.quality) ? v.quality : prev.quality || 'high';
    const size = v.size ? String(v.size) : prev.size || '1024x1536';
    validateSize(size);
    const flag = (k, d) => (k in v ? Boolean(v[k]) : prev[k] ?? d);
    // textMode: 'captions' = short captions, play box and a line for grown-ups (the story is read from the script);
    // 'story' = a short story paragraph printed on the card itself, so the cards can be read without the script.
    const textMode = ['captions', 'story'].includes(v.textMode) ? v.textMode : prev.textMode || 'captions';
    return { model, quality, size, textMode, useTemplateRef: flag('useTemplateRef', true), chain: flag('chain', true), badge: flag('badge', true), proof: flag('proof', true), autoFix: flag('autoFix', true) };
  }
  const newCard = (n, fields = {}) => ({ id: crypto.randomUUID(), n, topic: '', beat: '', place: '', draft: false, check: null, stale: null, prints: {}, chapter: '', arc: '', purpose: '', feeling: '', state: '', layout: '', setting: '', play: '', title: '', subtitle: '', tagline: '', hero: '', slots: [], closing: '', source: '', characters: [], narration: '', storyText: '', imageId: null, imageIds: [], ...fields });
  // Cast names as a model returns them or an author types them ("Ollie", "ollie the octopus"), matched to the cast's spelling.
  const GENERIC_FIRST = /^(the|a|an|baby|little|big|mr|mrs|miss|old)$/i;
  const castMatcher = (cast) => (name) => {
    const k = String(name || '').trim().toLowerCase();
    if (!k) return null;
    const exact = cast.find((c) => c.name.toLowerCase() === k);
    if (exact) return exact.name;
    const first = cast.filter((c) => c.name.toLowerCase().split(' ')[0] === k);
    return first.length === 1 ? first[0].name : null;
  };
  const cleanShows = (v, match) => { const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null; return list ? [...new Set(list.map(match).filter(Boolean))].slice(0, 10) : null; };
  // Who a picture brief mentions by name: the fallback when a panel has no cast list of its own.
  const inferShows = (visual, cast) => cast.filter((c) => { const first = c.name.split(' ')[0]; const names = [c.name, ...(first !== c.name && !GENERIC_FIRST.test(first) ? [first] : [])]; return names.some((n) => new RegExp(`(^|[^\\p{L}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'iu').test(visual || '')); }).map((c) => c.name);
  // "shows" (who is drawn in a story panel) is kept only when the cast is given to match it against.
  const cleanCardSlots = (slots, cast = null) => {
    const match = cast && castMatcher(cast);
    return (Array.isArray(slots) ? slots : []).slice(0, MAX_SLOTS).map((s) => { const shows = match ? cleanShows(s.shows, match) : null; return { key: clampStr(s.key, 60), heading: clampStr(s.heading, 300), text: clampStr(s.text, 1500), visual: clampStr(s.visual, 800), ...(shows ? { shows } : {}) }; }).filter((s) => s.key);
  };

  async function templatesFor(s) {
    if (!s.brief.templateId) throw new HttpError(400, 'Choose a template first.');
    const layout = await getTemplate(s.brief.templateId);
    const style = s.brief.styleTemplateId && s.brief.styleTemplateId !== layout.id ? await getTemplate(s.brief.styleTemplateId).catch(() => null) : null;
    return { layout, style };
  }
  const styleOf = (s, t) => s.styleGuide || (t.style || t.layout).styleGuide;

  // A template may offer several layouts (variants); a card then uses its variant's slots followed by the common slots.
  const variantOf = (t, card) => (t.variants?.length ? t.variants.find((v) => v.id === card?.layout) || t.variants[0] : null);
  const slotsFor = (t, card) => { const v = variantOf(t, card); return v ? [...v.slots, ...t.slots] : t.slots; };
  const slotLine = (x) => `- key "${x.key}" — ${x.label} (${x.position}). Heading: ${x.headingHint || 'none'}. Content: ${x.contentHint || '—'} Picture: ${x.visualHint || '—'} Max ${x.maxWords || 15} words.`;
  const storyWords = (a) => (a.id === '1-3' ? '15–25' : a.id === '3-5' ? '30–45' : '40–60');
  function templateText(t) {
    if (t.variants?.length) return [
      `Template: ${t.name} (${t.archetype})${t.description ? ` — ${t.description}` : ''}`,
      `Page frame: ${t.layoutGuide}`,
      t.titleHint && `Title guidance: ${t.titleHint}`, t.textRules && `Text rules: ${t.textRules}`,
      `Closing line: ${t.closingHint || 'none — leave "closing" empty.'}`, 'Main picture: none — leave "hero" empty.', `Source line: ${t.sourceHint || 'none — leave "source" empty.'}`,
      `Layouts (each card names the one it uses):\n${t.variants.map((v) => `Layout "${v.id}" — ${v.label}; use for ${v.when}. ${v.layoutGuide}\nSlots:\n${v.slots.map(slotLine).join('\n')}`).join('\n\n')}`,
      `Common slots (on every card, after the layout's slots):\n${t.slots.map(slotLine).join('\n')}`,
    ].filter(Boolean).join('\n');
    return [
      `Template: ${t.name} (${t.archetype})${t.description ? ` — ${t.description}` : ''}`,
      `Layout: ${t.layoutGuide}`,
      t.titleHint && `Title guidance: ${t.titleHint}`,
      `Main picture: ${t.heroHint || 'none — leave "hero" empty.'}`,
      t.textRules && `Text rules: ${t.textRules}`,
      `Closing line: ${t.closingHint || 'none — leave "closing" empty.'}`,
      `Source line: ${t.sourceHint || 'none — leave "source" empty.'}`,
      `Slots (fill every one, in this order):\n${t.slots.map(slotLine).join('\n')}`,
    ].filter(Boolean).join('\n');
  }
  function seriesText(s, chars) {
    const b = s.brief, a = audienceOf(s);
    return [
      `Series type: ${b.kind === 'story' ? 'STORY (cards are read in order)' : 'SET (a collection; each card stands alone)'}`,
      s.title && `Series title: ${s.title}`, s.logline && `About: ${s.logline}`,
      b.lesson && `Lesson the author wants: ${b.lesson}`,
      s.foundation && FOUNDATION_FIELDS.some(([k]) => s.foundation[k]) && `Story foundation:\n${FOUNDATION_FIELDS.filter(([k]) => s.foundation[k]).map(([k, label]) => `- ${label}: ${s.foundation[k]}`).join('\n')}`,
      s.spine && `Story spine (the whole story; every card is one part of it): ${s.spine}`,
      s.world && `World: ${s.world}`,
      b.kind === 'story' && `Read-aloud narration per card: ${a.id === '1-3' ? '40–70' : a.id === '3-5' ? '70–110' : '90–150'} words.`,
      b.kind === 'story' && `Printed story text per card (storyText): ${storyWords(a)} words.`,
      s.refrain && `Refrain: "${s.refrain}"`, s.hiddenFriend && `Hidden friend in every picture: ${s.hiddenFriend}`,
      `Brief: ${b.premise}`,
      b.topics && `Topics requested (one per line or comma separated): ${b.topics}`,
      a.panelWords ? `Audience: ages ${a.id} (${a.label}). ${a.guidance}. At most ${a.panelWords} words of body text per panel.` : `Audience and length: ${a.guidance}.`,
      `Number of cards: ${b.cardCount}`,
      b.tone && `Tone: ${b.tone}`, b.notes && `Other notes: ${b.notes}`,
      chars.length && `Existing characters to use (keep these exact names; their look is fixed by reference images):\n${chars.map((c) => `- ${c.name}: ${identityLine(c)}`).join('\n')}`,
    ].filter(Boolean).join('\n');
  }

  // A new story in the world of an earlier one: its places (with their reference paintings), cast and running details
  // are handed to the planner as established facts, and its plot as something not to repeat.
  function establishedText(src) {
    return [`ESTABLISHED WORLD — this is a NEW story set in the same world as the earlier story "${src.title}". Keep that world; do not retell or repeat its plot (${src.logline}${src.foundation?.lesson ? ` Its lesson was: ${src.foundation.lesson}` : ''}). Choose a different problem and a different lesson.`,
      src.world && `World: ${src.world}`,
      (src.places || []).length && `Places that already exist, with reference paintings. Wherever the new story goes to one of them, use its exact name and this exact description in "places" and on the cards; set at least two cards in existing places, and add new places only where the story needs somewhere new:\n${src.places.map((pl) => `- ${pl.name}: ${pl.description}`).join('\n')}`,
      src.cast.length && `Cast of the earlier story (returning characters keep their exact name, look and personality; not all need to appear, and new side characters may join):\n${src.cast.map((c) => `- ${c.name} (${c.role}): ${c.description.slice(0, 300)}`).join('\n')}`,
      src.hiddenFriend && `The earlier story's hidden friend was: ${src.hiddenFriend} — keep the same one so the set matches.`,
      src.refrain && `The earlier story's refrain was "${src.refrain}" — write a new refrain in the same rhythm.`,
    ].filter(Boolean).join('\n');
  }
  // Choosing an earlier story for a series that is not planned yet copies its cast (studio characters), look and picture settings.
  async function inherit(s) {
    const src = s.brief.basedOn && s.brief.basedOn !== s.id ? await readJsonFile(seriesFile(s.brief.basedOn), null).catch(() => null) : null;
    if (!src) { s.brief.basedOn = ''; return; }
    if (s.cards.length) return;
    const all = await readCharacters();
    s.brief.kind = 'story';
    s.brief.characterIds = [...new Set([...src.cast.map((c) => c.characterId).filter((cid) => cid && all.some((x) => x.id === cid)), ...s.brief.characterIds])].slice(0, 8);
    s.brief.templateId = src.brief.templateId; s.brief.styleTemplateId = src.brief.styleTemplateId || '';
    s.brief.audience = src.brief.audience; if (!s.brief.tone) s.brief.tone = src.brief.tone || '';
    s.styleGuide = src.styleGuide || ''; s.image = cleanImage(src.image);
  }

  // ---------- story logic: a reader who only looks for what does not add up ----------
  // The story as the continuity reader sees it: plan facts for every card and, for written cards, the words and picture briefs.
  function storyDigest(s, layout) {
    const f = s.foundation || {}, a = audienceOf(s);
    const cardText = (c) => {
      const panels = c.title ? slotsFor(layout, c).map((slot) => ({ slot, v: c.slots.find((x) => x.key === slot.key) })).filter((x) => x.v && (x.v.heading || x.v.text || x.v.visual)) : [];
      return [
        `Card ${c.n} "${c.title || c.topic}" [${[c.arc, c.place && `place: ${c.place}`, c.feeling && `feeling: ${c.feeling}`].filter(Boolean).join('; ')}]`,
        `  What happens: ${c.beat || '—'}`, c.state && `  State at the end: ${c.state}`,
        ...panels.map(({ slot, v }) => `  ${slot.label} — ${slot.role === 'story-panel' ? 'caption' : 'heading'}: ${v.heading || '—'} | ${slot.role === 'story-panel' ? 'speech' : 'text'}: ${v.text || '—'} | picture: ${v.visual || '—'}${Array.isArray(v.shows) ? ` | drawn in it: ${v.shows.join(', ') || 'nobody'}` : ''}`),
        c.title && `  Characters listed on the card: ${c.characters.join(', ') || 'none'}`, c.narration && `  Narration: ${c.narration}`,
      ].filter(Boolean).join('\n');
    };
    return [
      `Story: "${s.title}" — ${s.logline}`, `Brief: ${s.brief.premise}`, `Audience: ages ${a.id} (${a.label}).`,
      FOUNDATION_FIELDS.some(([k]) => f[k]) && `Foundation:\n${FOUNDATION_FIELDS.filter(([k]) => f[k]).map(([k, label]) => `- ${label}: ${f[k]}`).join('\n')}`,
      s.spine && `Spine: ${s.spine}`, s.world && `World: ${s.world}`,
      (s.places || []).length && `Places:\n${s.places.map((pl) => `- ${pl.name}: ${pl.description}`).join('\n')}`,
      `Cast (body and size decide what each can do):\n${s.cast.map((c) => `- ${c.name} (${c.role}): ${c.description.slice(0, 400)}`).join('\n')}`,
      `CARDS, in reading order:\n${s.cards.map(cardText).join('\n')}`,
    ].filter(Boolean).join('\n\n');
  }
  async function findHoles(id, digest, onText) {
    const { parsed, usage } = await llmJson({ name: 'card_story_logic', model: CARD_MODEL, instructions: LOGIC_INSTRUCTIONS, schema: LOGIC_SCHEMA, log: { type: 'card_story_logic', seriesId: id }, input: digest }, onText);
    const holes = (parsed.holes || []).slice(0, 12).map((h) => ({ id: crypto.randomUUID(), cards: [...new Set((h.cards || []).filter((n) => Number.isInteger(n) && n > 0))].sort((x, y) => x - y), problem: clampStr(h.problem, 600), fix: clampStr(h.fix, 600), severity: ['breaks', 'confusing', 'small'].includes(h.severity) ? h.severity : 'confusing' })).filter((h) => h.problem);
    return { holes, usage };
  }
  const holeLines = (holes) => holes.map((h) => `- Card${h.cards.length === 1 ? '' : 's'} ${h.cards.join(', ') || '—'} (${h.severity}): ${h.problem} Smallest fix: ${h.fix}`).join('\n');
  // Read the story as it stands (plan, and script where written) and keep what the reader found on the series.
  async function handleLogic(id, progress = () => {}) {
    const s = await getSeries(id);
    if (s.brief.kind !== 'story' || !s.cards.length) throw new HttpError(400, 'Plan a story first.');
    const { layout } = await templatesFor(s);
    const { holes } = await findHoles(id, storyDigest(s, layout), (t) => progress({ phase: `Reading the story for things that do not add up (${countKey(t, 'problem')} so far)`, snippet: lastString(t, 'problem') }));
    const logic = { at: new Date().toISOString(), stage: s.cards.every((c) => c.title) ? 'script' : 'plan', holes };
    const updated = await withSeries(id, (x) => { x.logic = logic; return x; });
    await appendLog({ type: 'card_story_logic', seriesId: id, stage: logic.stage, holes: holes.map((h) => `${h.severity}: cards ${h.cards.join(', ')} — ${h.problem}`) });
    return { series: updated, logic };
  }

  // Stories written before cards carried a state and a cast list per panel get them here, read off the story as written,
  // so that old stories can be proofread and redrawn against the same facts as new ones. Nothing else is changed.
  async function ensureContinuity(id) {
    const s = await getSeries(id);
    if (s.brief.kind !== 'story') return s;
    const { layout } = await templatesFor(s);
    const panelKeys = (c) => slotsFor(layout, c).filter((x) => x.role === 'story-panel').map((x) => x.key);
    const needs = (c) => c.title && (!c.state || panelKeys(c).some((k) => { const v = c.slots.find((x) => x.key === k); return v && !Array.isArray(v.shows); }));
    const todo = s.cards.filter(needs);
    if (!todo.length) return s;
    const { parsed } = await llmJson({ name: 'card_story_state', model: CARD_MODEL, effort: 'low', log: { type: 'card_story_state', seriesId: id },
      schema: obj({ cards: { type: 'array', items: obj({ n: { type: 'integer' }, state: str(), panels: { type: 'array', items: obj({ key: str('the panel key exactly as given'), shows: { type: 'array', items: { type: 'string' } } }) } }) } }),
      instructions: `You are the continuity supervisor on a children's story told on cards. Read the whole story in order and, for each card you are asked for, record what the story says — do not change or judge it.
"state": where things stand at the END of that card, as plain facts a picture could get wrong: where each cast member is (say plainly who is inside, under or behind something and so cannot be seen from outside), who is holding or carrying whom or what, what is blocked, open, stuck or moved, and how much light is left. Two to four short sentences. A fact carries forward unchanged until a card changes it.
"panels": for every story panel of that card (keys as given), "shows" = the cast members (exact cast names) who are physically in that picture at that moment according to the story. A character who is trapped or hidden is listed only for a panel whose picture looks in at them. Where the story is unclear, keep everyone where they were last seen.`,
      input: `${storyDigest(s, layout)}\n\nStory panels per card: ${todo.map((c) => `card ${c.n}: ${panelKeys(c).join(', ')}`).join('; ')}\n\nReturn cards: ${todo.map((c) => c.n).join(', ')}` });
    const updated = await withSeries(id, (x) => {
      const match = castMatcher(x.cast);
      for (const o of parsed.cards || []) {
        const c = x.cards.find((k) => k.n === o.n);
        if (!c || !c.title) continue;
        const upToDate = !c.stale, keys = new Set(panelKeys(c));
        if (!c.state) c.state = clampStr(o.state, 700);
        for (const p of o.panels || []) { const v = keys.has(p.key) && c.slots.find((k) => k.key === p.key); if (v && !Array.isArray(v.shows)) v.shows = cleanShows(p.shows, match) || []; }
        // The picture was not drawn from different words: adding the facts must not mark it as changed.
        if (upToDate && c.imageId && c.prints?.[c.imageId]) c.prints[c.imageId].pic = picSig(c);
      }
      return x;
    });
    await appendLog({ type: 'card_story_state', seriesId: id, cards: todo.map((c) => c.n) });
    return updated;
  }

  async function handlePlan(id, body, progress = () => {}) {
    const s = await getSeries(id);
    if (!s.brief.premise && !s.brief.topics) throw new HttpError(400, 'Describe the series (or list its topics) first.');
    const { layout } = await templatesFor(s);
    const all = await readCharacters();
    const chars = s.brief.characterIds.map((cid) => all.find((c) => c.id === cid)).filter(Boolean);
    const extra = clampStr(body.instructions, 2000);
    const total = s.brief.cardCount;
    const src = s.brief.kind === 'story' && s.brief.basedOn ? await readJsonFile(seriesFile(s.brief.basedOn), null).catch(() => null) : null;
    const input = `${seriesText({ ...s, title: '', logline: '', spine: '', world: '', foundation: null, refrain: '', hiddenFriend: '' }, chars)}${src ? `\n\n${establishedText(src)}` : ''}\n\n${templateText(layout)}${extra ? `\n\nRevision instructions: ${extra}` : ''}`;
    const { parsed, durationMs, usage } = await llmJson({ name: 'card_series_plan', model: CARD_MODEL, instructions: PLAN_INSTRUCTIONS, schema: planSchema(total, (layout.variants || []).map((v) => v.id)), log: { type: 'card_series_plan', seriesId: id }, input },
      (t) => progress(!t.includes('"cards"') ? { phase: 'Finding the title and cast', snippet: lastString(t, 'title') } : { phase: `Planning card ${Math.min(total, Math.max(1, countKey(t, 'topic')))} of ${total}`, done: Math.max(0, countKey(t, 'beat')), total, snippet: lastString(t, 'topic') }));
    // Second opinion for stories: an editor checks the plot (lesson, flaw, failed try, turning choice, cause and effect)
    // and returns a strengthened plan before any card is written. If that pass fails, the first plan is used.
    let plan = parsed, editorUsage = null, logic = null;
    const draftOf = (p) => ({ ...s, title: p.title, logline: p.logline, foundation: p.foundation, spine: p.spine, world: p.world, places: p.places || [], cast: p.cast || [], cards: (p.cards || []).map((c, i) => ({ ...c, n: i + 1, title: '', slots: [], characters: [] })) });
    const read = async (p, phase) => (await findHoles(id, storyDigest(draftOf(p), layout), (t) => progress({ phase: `${phase} (${countKey(t, 'problem')} found)`, snippet: lastString(t, 'problem') })).catch(() => null))?.holes || null;
    if (s.brief.kind === 'story') {
      // A reader who only looks for holes goes first; the editor then has to fix what was found, and the reader looks again.
      progress({ phase: 'A continuity reader is asking "but why?" of every card', force: true });
      const holes = await read(parsed, 'A continuity reader is asking "but why?" of every card') || [];
      progress({ phase: 'The story editor is checking the plot: lesson, challenge, turning point', force: true });
      try {
        const r = await llmJson({ name: 'card_series_plan_edit', model: CARD_MODEL, instructions: EDITOR_INSTRUCTIONS, schema: planSchema(total, (layout.variants || []).map((v) => v.id)), log: { type: 'card_series_plan_edit', seriesId: id },
          input: `BRIEF AND TEMPLATE\n${input}\n\nWRITER'S PLAN (JSON)\n${JSON.stringify(parsed)}${holes.length ? `\n\nCONTINUITY READER'S FINDINGS (fix every one)\n${holeLines(holes)}` : ''}` },
          (t) => progress({ phase: `The story editor is tightening the plot${t.includes('"cards"') ? ` (card ${Math.min(total, Math.max(1, countKey(t, 'topic')))} of ${total})` : ''}`, snippet: lastString(t, 'beat') || lastString(t, 'lesson') }));
        if ((r.parsed.cards || []).length === total) { plan = r.parsed; editorUsage = r.usage; }
      } catch { /* keep the writer's plan */ }
      // What is still open after the edit is kept with the plan, so the author sees it before any card is written.
      const left = plan === parsed ? holes : await read(plan, 'The continuity reader is checking the edited plan');
      if (left) logic = { at: new Date().toISOString(), stage: 'plan', holes: left, fixed: Math.max(0, holes.length - left.length), found: holes.length };
    }
    const updated = await withSeries(id, (x) => {
      const parsed = plan;
      x.title = clampStr(parsed.title, 200); x.logline = clampStr(parsed.logline, 1000);
      const story = x.brief.kind === 'story';
      x.spine = story ? clampStr(parsed.spine, 2500) : '';
      x.world = story ? clampStr(parsed.world, 1500) : '';
      // Places keep their reference painting: this series' own, or the earlier story's when the world is shared.
      const oldPlaces = new Map([...(src?.places || []).map((pl) => ({ ...pl, id: crypto.randomUUID(), from: src.id })), ...(x.places || [])].map((pl) => [pl.name.toLowerCase(), pl]));
      x.places = story ? (parsed.places || []).slice(0, 8).map((pl) => ({ id: crypto.randomUUID(), imageId: null, ...(oldPlaces.get(clampStr(pl.name, 80).toLowerCase()) || {}), name: clampStr(pl.name, 80), description: clampStr(pl.description, 600), fixtures: clampStr(pl.fixtures, 400) })).filter((pl) => pl.name) : [];
      x.foundation = Object.fromEntries(FOUNDATION_FIELDS.map(([k]) => [k, story ? clampStr(parsed.foundation?.[k], 600) : '']));
      x.editorNotes = story && plan !== (void 0) ? clampStr(parsed.editorNotes, 1500) : '';
      x.logic = story ? logic : null;
      x.refrain = story ? clampStr(parsed.refrain, 200) : ''; x.hiddenFriend = story ? clampStr(parsed.hiddenFriend, 300) : '';
      x.cast = (parsed.cast || []).slice(0, 10).map((c) => {
        const linked = chars.find((k) => k.name.toLowerCase() === clampStr(c.name, 80).toLowerCase());
        return { id: crypto.randomUUID(), name: clampStr(c.name, 80), role: clampStr(c.role, 200), description: linked ? identityLine(linked) : clampStr(c.description, 1000), characterId: linked?.id || null };
      });
      for (const c of chars) if (!x.cast.some((k) => k.characterId === c.id)) x.cast.unshift({ id: crypto.randomUUID(), name: c.name, role: 'guide character', description: identityLine(c), characterId: c.id });
      const planned = (parsed.cards || []).slice(0, total);
      while (planned.length < total) planned.push({ topic: '', beat: '' });
      // Keep pictures and text of cards whose topic did not change.
      const old = new Map(x.cards.map((c) => [c.topic.toLowerCase(), c]));
      x.cards = planned.map((p, i) => {
        const topic = clampStr(p.topic, 200), keep = old.get(topic.toLowerCase());
        const plan = { place: story ? clampStr(p.place, 80) : '', chapter: story ? clampStr(p.chapter, 120) : '', arc: story && ARC_IDS.includes(p.arc) ? p.arc : '', purpose: story ? clampStr(p.purpose, 400) : '', feeling: story ? clampStr(p.feeling, 100) : '', state: story ? clampStr(p.state, 700) : '', beat: clampStr(p.beat, 1000), layout: clampStr(p.layout, 40), setting: story ? clampStr(p.setting, 400) : '', play: story && PLAY_TYPES.includes(p.play) ? p.play : '' };
        // A card whose layout changed needs rewriting: its slots no longer fit.
        return keep ? { ...keep, n: i + 1, ...plan, ...(keep.layout !== plan.layout ? { title: '', slots: [] } : {}) } : newCard(i + 1, { topic, ...plan });
      });
      return x;
    });
    await appendLog({ type: 'card_series_plan', seriesId: id, title: updated.title, cards: total, lesson: updated.foundation?.lesson || null, holesFound: logic?.found ?? null, holesLeft: logic ? logic.holes.length : null, editorNotes: updated.editorNotes || null, edited: Boolean(editorUsage), model: CARD_MODEL, usage, editorUsage, durationMs });
    return updated;
  }

  async function handleWrite(id, body, progress = () => {}) {
    let s = await getSeries(id);
    if (!s.cards.length) throw new HttpError(400, 'Plan the series first.');
    const { layout } = await templatesFor(s);
    if (!layout.slots.length && !layout.variants?.length) throw new HttpError(400, 'This template has no content slots. Add some in the Templates tab.');
    const wanted = Array.isArray(body.cardIds) && body.cardIds.length ? s.cards.filter((c) => body.cardIds.includes(c.id)) : s.cards.filter((c) => body.all || !c.title);
    if (!wanted.length) throw new HttpError(400, 'Every card is already written. Use a card\'s rewrite box to change one.');
    const all = await readCharacters();
    const chars = s.brief.characterIds.map((cid) => all.find((c) => c.id === cid)).filter(Boolean);
    const extra = clampStr(body.instructions, 2000);
    const total = wanted.length;
    let written = 0;
    for (let i = 0; i < wanted.length; i += WRITE_CHUNK) {
      const chunk = wanted.slice(i, i + WRITE_CHUNK);
      const extras = (c) => [c.chapter && `chapter: ${c.chapter}`, c.place && `place: ${c.place}`, c.arc && `stage: ${c.arc}`, c.feeling && `feeling: ${c.feeling}`, c.purpose && `purpose: ${c.purpose}`, variantOf(layout, c) && `layout "${variantOf(layout, c).id}"`, c.setting && `setting: ${c.setting}`, c.play && `play type: ${c.play}`, c.state && `state at the end of this card: ${c.state}`].filter(Boolean).join('; ');
      const outline = s.cards.map((c) => `Card ${c.n}: ${c.topic}${c.beat ? ` — ${c.beat}` : ''}${extras(c) ? `\n  [${extras(c)}]` : ''}${c.title ? `\n  Written so far: "${c.title}"${c.slots.length ? ` · ${c.slots.map((x) => [x.heading, x.text].filter(Boolean).join(': ')).join(' / ').slice(0, 500)}` : ''}${c.closing ? ` · ends: "${c.closing}"` : ''}${c.narration ? `\n  Narration so far: ${c.narration}` : ''}` : ''}`).join('\n');
      const input = [seriesText(s, chars), s.cast.length && `Cast:\n${s.cast.map((c) => `- ${c.name} (${c.role}): ${c.description}`).join('\n')}`, templateText(layout), `Series outline:\n${outline}`,
        `Write cards: ${chunk.map((c) => c.n).join(', ')}`, extra && `Revision instructions: ${extra}`].filter(Boolean).join('\n\n');
      const base = written;
      const { parsed, durationMs, usage } = await llmJson({ name: 'card_series_cards', model: CARD_MODEL, instructions: WRITE_INSTRUCTIONS, schema: cardsSchema, log: { type: 'card_series_write', seriesId: id, cards: chunk.map((c) => c.n) }, input }, (t) => {
        const k = Math.min(chunk.length, Math.max(1, countKey(t, 'n')));
        progress({ phase: total === 1 ? `Writing card ${chunk[0].n}` : `Writing card ${chunk[k - 1].n} (${base + k} of ${total})`, done: base + Math.max(0, countKey(t, 'characters')), total, snippet: lastString(t, 'text') || lastString(t, 'title') });
      });
      const castNames = new Map(s.cast.map((c) => [c.name.toLowerCase(), c.name]));
      s = await withSeries(id, (x) => {
        for (const out of parsed.cards || []) {
          const c = x.cards.find((k) => k.n === out.n && chunk.some((w) => w.id === k.id));
          if (!c) continue;
          c.title = clampStr(out.title, 200); c.subtitle = clampStr(out.subtitle, 300); c.tagline = clampStr(out.tagline, 400); c.hero = clampStr(out.hero, 1200);
          const got = new Map(cleanCardSlots(out.slots, x.cast).map((k) => [k.key, k]));
          // Every story panel carries the list of who is drawn in it (taken from the brief when the writer left it empty).
          c.slots = slotsFor(layout, c).map((t) => { const { shows, ...v } = got.get(t.key) || { key: t.key, heading: '', text: '', visual: '' }; return x.brief.kind === 'story' && t.role === 'story-panel' ? { ...v, shows: shows?.length ? shows : inferShows(v.visual, x.cast) } : v; });
          c.closing = clampStr(out.closing, 400); c.source = clampStr(out.source, 300); c.narration = s.brief.kind === 'story' ? clampStr(out.narration, 3000) : ''; c.storyText = s.brief.kind === 'story' ? clampStr(out.storyText, 800) : '';
          c.characters = [...new Set([...(out.characters || []).map((n) => castNames.get(String(n).toLowerCase())).filter(Boolean), ...c.slots.flatMap((k) => k.shows || [])])];
          written++;
        }
        return x;
      });
      await appendLog({ type: 'card_series_write', seriesId: id, cards: chunk.map((c) => c.n), instructions: extra || null, model: CARD_MODEL, usage, durationMs });
    }
    if (s.brief.kind === 'story') {
      progress({ phase: 'Copy editor: caption length and steady names', force: true });
      s = (await tidyText(id, wanted.map((c) => c.id)).catch(() => ({ series: s }))).series;
      // Once the whole story is written, the continuity reader goes through words and picture briefs together.
      if (wanted.length > 1 && s.cards.every((c) => c.title)) s = (await handleLogic(id, progress).catch(() => ({ series: s }))).series;
    }
    return s;
  }

  // ---------- illustration ----------
  // Quoted text for the prompt; a line break inside a panel is written as " / " (explained in the constraints).
  const quoted = (t) => `"${String(t).replace(/"/g, "'").trim().split(/\s*\n+\s*/).map((l) => l.replace(/\s+/g, ' ')).join(' / ')}"`;
  // opts.collect: array that receives every string lettered on the card (used by the proofreader); opts.fixNotes: what the
  // proofreader found wrong with the previous attempt.
  function cardPrompt(s, card, t, opts = {}) {
    const plain = quoted;
    const q = (text) => { opts.collect?.push(String(text).replace(/\s+/g, ' ').trim()); return plain(text); };
    const L = t.layout, many = s.cards.length > 1;
    const present = s.cast.filter((c) => card.characters.includes(c.name));
    const unlinked = present.filter((c) => !c.characterId || opts.describeAll);
    const byKey = new Map(card.slots.map((x) => [x.key, x]));
    const onCard = s.brief.kind === 'story' && s.image.textMode === 'story' && Boolean(card.storyText);
    const lines = [
      `Educational flash card for children, print-ready${many ? `: card ${card.n} of ${s.cards.length} in the ${s.brief.kind === 'story' ? 'story series' : 'series'} ${plain(s.title || 'Untitled')}` : ''}. One complete designed page with all of its text lettered into the artwork.`,
      '', `Layout (follow this page structure exactly):\n${L.layoutGuide}${variantOf(L, card) ? `\n${variantOf(L, card).layoutGuide}` : ''}`,
      ...(onCard ? ['', 'Story-on-the-card version — this overrides the layout above where they differ: the title takes the top 10%; the pictures take about the next 50% and carry speech bubbles only (no caption strips or caption boxes); under the pictures sits a STORY BOX about 28% of the page tall and nearly full width — a cream rounded panel holding the story text in large, dark, rounded, very legible lettering, left-aligned, in four to seven lines with generous line spacing, like the text of a picture book; the bottom 8% is the ribbon. There is no play box, no fact box and no line for grown-ups on this version.'] : []),
      '', 'Text to print — letter every item exactly as written, with correct spelling and nothing added:',
      `- Title: ${q(card.title)}`,
    ];
    if (card.subtitle) lines.push(`- Subtitle: ${q(card.subtitle)}`);
    if (card.tagline) lines.push(`- Tagline under the subtitle: ${q(card.tagline)}`);
    if (card.hero) lines.push('', `Main picture: ${card.hero}`);
    const panels = [];
    let tracked = false;
    for (const slot of slotsFor(L, card)) {
      const c = byKey.get(slot.key);
      if (!c || !(c.heading || c.text || c.visual)) continue;
      const isStory = slot.role === 'story-panel';
      if (onCard && !isStory) continue;
      const parts = [`${slot.label} (${slot.position})`];
      if (c.heading && !onCard) parts.push(`${isStory ? 'caption box' : 'heading'} ${q(c.heading)}`);
      if (c.heading && onCard) parts.push(`what happens here, for you to draw and NOT to letter: ${c.heading}`);
      if (c.text) parts.push(`${isStory ? 'speech bubble' : 'text'} ${q(c.text)}`);
      if (c.visual) parts.push(`picture: ${c.visual}`);
      if (isStory && Array.isArray(c.shows)) {
        tracked = true;
        const absent = s.cast.map((m) => m.name).filter((n) => !c.shows.includes(n));
        parts.push(`in this picture: ${c.shows.join(', ') || 'none of the named characters'}${absent.length ? `; NOT in this picture: ${absent.join(', ')}` : ''}`);
      }
      panels.push(`- ${parts.join(' — ')}`);
    }
    if (panels.length) lines.push('', 'Panels:', ...panels);
    const before = s.brief.kind === 'story' ? s.cards[s.cards.indexOf(card) - 1]?.state : '';
    const facts = s.brief.kind === 'story' ? [before && `- As this card begins: ${before}`, card.state && `- By the end of this card: ${card.state}`].filter(Boolean) : [];
    if (facts.length) lines.push('', 'Story facts — where everyone and everything is. Every picture on this card must agree with them; they are for drawing from, never for lettering:', ...facts);
    if (onCard) lines.push('', `Story box text (letter it exactly, every word): ${q(card.storyText)}`);
    if (card.closing) lines.push('', `Bottom line: ${q(card.closing)}`);
    if (card.source) lines.push(`Small credit line at the very bottom: ${q(card.source)}`);
    if (many && s.image.badge) lines.push(`Small series badge in the top-left corner: ${q(`${s.title || 'Series'} · ${card.n} of ${s.cards.length}`)}`);
    if (unlinked.length) lines.push('', `Characters (draw them exactly like this on every card):\n${unlinked.map((c) => `- ${c.name}: ${c.description}`).join('\n')}`);
    const place = (s.places || []).find((pl) => pl.name && pl.name === card.place);
    if (place) lines.push('', `Place: ${place.name} — ${place.description}${place.imageId ? ' (shown in the location reference image: keep its landmarks, shapes and plants; the light and colours follow this card)' : ''}${place.fixtures ? ` Objects here that the story depends on, as the story first finds them: ${place.fixtures} Keep their shape and size the same in every panel; whether they have been moved, opened or cut by now is given by the story facts.` : ''}`);
    const varied = Boolean(card.setting);
    if (varied) lines.push('', `Setting and colours of THIS card: ${card.setting}. Let this palette dominate the whole page — background, panel borders, title colour and ribbons are tinted to suit it — so the card looks clearly different in colour from the other cards of the series.`);
    if (s.hiddenFriend) {
      // With several panels the friend tends to be drawn in each: name the one panel it belongs in (it moves from card to card).
      const pics = slotsFor(L, card).filter((x) => x.role === 'story-panel' && byKey.get(x.key)?.visual);
      const home = pics.length > 1 ? pics[(card.n - 1) % pics.length].label : '';
      lines.push('', `Hidden friend: ${s.hiddenFriend}. Draw it exactly once on the whole card, small (about the size of a thumbnail), ${home ? `in ${home} only — in no other panel and in no box or ribbon —` : 'tucked somewhere inside the picture'} where a child can spot it; never over text.`);
    }
    lines.push('', `Style (${varied ? 'the same rendering, lettering shapes and character designs on every card of the series; only the colours and layout change from card to card' : 'identical on every card of the series'}): ${styleOf(s, t)}`);
    if (s.brief.kind === 'story') lines.push('', varied
      ? 'Continuity: this card continues a story. Recurring characters keep exactly the same design, proportions and body colours on every card, even when the surroundings change colour.'
      : 'Continuity: this card continues a story. Keep recurring characters, their sizes and colors, the setting and the time of day consistent with the other cards.');
    lines.push('', 'Constraints:',
      '- Every word must be spelled exactly as given, sharp and easy to read when the card is printed 5 × 7.5 inches: large rounded lettering with strong contrast against its background.',
      '- A slash with spaces around it ( / ) inside quoted text marks a line break: start a new line there and do not print the slash.',
      '- No text other than the items listed above: no extra labels, no filler words, no logos, no watermark, no signature.',
      '- Keep all text and panel edges inside a safe margin of about 4% from every edge (the card will be cut and laminated); the background art runs to the edge.',
      '- Each panel shows its own picture; do not repeat the same picture in two panels.');
    if (tracked || facts.length) lines.push('- Draw in each panel only the named characters listed for it. A character the story facts place inside, under or behind something is drawn there and nowhere else on the card: not in another panel, not in the play box, not as a decoration.');
    if (opts.fixNotes) lines.push('', `A previous attempt at this card had these mistakes — make sure this one does not:\n${opts.fixNotes}`);
    if (slotsFor(L, card).some((x) => x.role === 'story-panel')) lines.push('- Comic panels read left to right, top to bottom. Each speech bubble sits inside its own panel with its tail pointing at the character who is speaking; caption boxes have no tail.');
    return lines.join('\n');
  }

  async function referenceImages(s, card, t, opts = {}) {
    const refs = [];
    const add = async (imageId, text, label) => { try { refs.push({ dataUrl: (await refJpeg(imageId)).dataUrl, text, label }); } catch { /* example image moved or deleted: generate without it */ } };
    if (s.image.useTemplateRef) {
      const noCopy = 'Do not copy its subject, its pictures or any of its words.';
      if (t.style?.refImageId) {
        await add(t.style.refImageId, `style reference only. Match its rendering, lettering, color treatment and the way panels, heading tabs and banners are drawn. Ignore its page layout. ${noCopy}`, `style: ${t.style.name}`);
        if (t.layout.refImageId) await add(t.layout.refImageId, `layout reference only. Match its page structure and the placement and proportions of its regions. Ignore its art style. ${noCopy}`, `layout: ${t.layout.name}`);
      } else if (t.layout.refImageId) {
        await add(t.layout.refImageId, `layout and style reference from the same family of cards. Match its page structure, panel shapes, lettering, color treatment and rendering. ${noCopy}`, `template: ${t.layout.name}`);
      }
    }
    const place = (s.places || []).find((pl) => pl.name && pl.name === card.place && pl.imageId);
    const placeFile = place && deps.recordFile && await deps.recordFile(place.imageId);
    if (placeFile) { const buf = await fsp.readFile(placeFile).catch(() => null); if (buf) refs.push({ dataUrl: `data:image/png;base64,${buf.toString('base64')}`, label: `place: ${place.name}`, text: `location reference for "${place.name}". Set this card there: keep its landmarks, rock and plant shapes and overall arrangement, seen from whatever angle suits the picture. It shows no characters; take characters only from their own references.` }); }
    if (s.image.chain && deps.recordFile && !opts.draft) {
      // The nearest finished card set in the same place whose picture passed proofreading; failing that the nearest good card.
      // (Always using the first card pulled its cast and props into every later picture.)
      const done = s.cards.filter((c) => c.imageId && c.id !== card.id), real = done.filter((c) => !c.draft);
      const good = (c) => !(c.check && c.check.imageId === c.imageId && !c.check.pass);
      const nearest = (list) => [...list].sort((a, b) => Math.abs(a.n - card.n) - Math.abs(b.n - card.n) || a.n - b.n)[0];
      const anchor = nearest(real.filter((c) => good(c) && card.place && c.place === card.place)) || nearest(real.filter(good)) || nearest(real) || nearest(done);
      const file = anchor && await deps.recordFile(anchor.imageId);
      if (file) {
        const buf = await fsp.readFile(file).catch(() => null);
        if (buf && buf.length <= 15 * 1024 * 1024) refs.push({ dataUrl: `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,${buf.toString('base64')}`, label: `series card ${anchor.n}`,
          text: card.setting
            ? `card ${anchor.n} of this same series. Match its rendering style, lettering shapes and the exact design of any character that appears in both. Do NOT copy its colour palette, its page layout, its words or its pictures: this card has its own colours and layout as described above. Who is in each picture, and where, comes only from this card's own panel lists and story facts: never carry over a character, an object or a pose because that card shows it.`
            : `card ${anchor.n} of this same series. The new card must look like it belongs to the same printed set: same lettering, colors, panel treatment${s.brief.kind === 'story' ? ' and the same characters and world' : ''}. Do not copy its words or repeat its pictures. Who is in each picture, and where, comes only from this card's own description.` });
      }
    }
    return refs;
  }

  // Story-on-the-card needs a printable paragraph per card. Cards written before the option existed get theirs here, condensed
  // from the narration in one call.
  async function ensureStoryText(id) {
    const s = await getSeries(id);
    const todo = s.cards.filter((c) => c.title && !c.storyText);
    if (s.brief.kind !== 'story' || !todo.length) return s;
    const a = audienceOf(s);
    const { parsed } = await llmJson({ name: 'card_story_text', model: CARD_MODEL, effort: 'low', log: { type: 'card_story_text', seriesId: id },
      schema: obj({ cards: { type: 'array', items: obj({ n: { type: 'integer' }, storyText: str() }) } }),
      instructions: `You are a children's picture-book editor. For each listed card of a story, write "storyText": the story of that card as it will be printed on the card itself, ${storyWords(a)} words. Condense the card's narration: same events, the key line of speech, the feeling; past tense; names rather than "he" or "she"; plain words for the stated age. Each storyText begins where the previous card's stopped, and read in order they tell the complete story by themselves. Never state a moral. Return every listed card.`,
      input: `Story: "${s.title}" — ${s.logline}\nAudience: ages ${a.id}\n\n${s.cards.map((c) => `Card ${c.n} "${c.title}"${todo.includes(c) ? '' : ' (already has storyText; context only)'}:\n${c.narration || c.beat}`).join('\n\n')}\n\nWrite storyText for cards: ${todo.map((c) => c.n).join(', ')}` });
    return withSeries(id, (x) => { for (const o of parsed.cards || []) { const c = x.cards.find((k) => k.n === o.n); if (c && !c.storyText) c.storyText = clampStr(o.storyText, 800); } return x; });
  }

  // Proofreader: a vision model reads the finished card against its script — every lettered word, who is in each panel,
  // the hidden friend — and says what is wrong in words an illustrator can act on.
  const PROOF_SCHEMA = obj({
    textProblems: { type: 'array', items: obj({ expected: str(), found: str('what is lettered instead, or "missing"') }) },
    extraText: { type: 'array', description: 'words lettered on the card that are not in the expected list', items: str() },
    pictureProblems: { type: 'array', items: obj({ issue: str('names the panel'), severity: { type: 'string', enum: ['major', 'minor'] } }) },
    hiddenFriendCount: { type: 'integer', description: 'how many times the hidden friend appears; -1 if the card has none to check' },
    pass: { type: 'boolean' }, fixNotes: str('if not pass: short instructions for the illustrator, one per line; otherwise ""'),
  });
  async function checkCard(id, cardId, recordId, opts = {}) {
    const s = await ensureContinuity(id).catch(() => getSeries(id));
    const card = s.cards.find((c) => c.id === cardId);
    if (!card) throw new HttpError(404, 'Card not found.');
    const recId = recordId || card.imageId;
    const file = recId && await deps.recordFile(recId);
    if (!file) throw new HttpError(400, 'This card has no picture to check.');
    const t = await templatesFor(s);
    const expected = [];
    cardPrompt(s, card, t, { collect: expected });
    const cast = s.cast.map((c) => `- ${c.name}: ${c.description.slice(0, 220)}`).join('\n');
    const onCard = s.brief.kind === 'story' && s.image.textMode === 'story' && Boolean(card.storyText);
    const panels = slotsFor(t.layout, card).filter((x) => x.role === 'story-panel').map((slot, k) => { const v = card.slots.find((x) => x.key === slot.key); return v ? `Panel ${k + 1}: ${[v.heading, v.visual].filter(Boolean).join(' — ')}${Array.isArray(v.shows) ? ` [must show: ${v.shows.join(', ') || 'no named character'}; must NOT show: ${s.cast.map((m) => m.name).filter((n) => !v.shows.includes(n)).join(', ') || '—'}]` : ''}` : ''; }).filter(Boolean).join('\n');
    const before = s.brief.kind === 'story' ? s.cards[s.cards.indexOf(card) - 1]?.state : '';
    const facts = s.brief.kind === 'story' ? [before && `As this card begins: ${before}`, card.state && `By the end of this card: ${card.state}`].filter(Boolean).join('\n') : '';
    const input = [{ role: 'user', content: [{ type: 'input_text', text: [
      `Card ${card.n} of "${s.title}".`, `TEXT THAT MUST BE LETTERED (each item exactly, somewhere on the card):\n${expected.map((x) => `- ${x.replace(/ \/ /g, ' ')}`).join('\n')}`,
      panels && `WHAT EACH PICTURE SHOULD SHOW:\n${panels}`, card.hero && `Main picture: ${card.hero}`,
      facts && `STORY FACTS (where everyone and everything is at this point of the story; no picture may contradict them):\n${facts}`,
      cast && `CHARACTERS (how to tell them apart):\n${cast}`,
      s.hiddenFriend ? `HIDDEN FRIEND (must appear exactly once): ${s.hiddenFriend}` : 'There is no hidden friend on this card: report hiddenFriendCount -1.',
      onCard && 'This card has no caption strips; the descriptions above are for the pictures only.',
      opts.draft && 'THIS IS A ROUGH DRAFT SKETCH, drawn quickly without character references. Do not judge lettering, spelling, the hidden friend, drawing quality or how closely a character matches its design: tell characters apart by kind and main colour. Report only picture problems: who is in each panel and where, and the state of the things the story depends on.',
    ].filter(Boolean).join('\n\n') }, { type: 'input_image', image_url: `data:image/png;base64,${(await fsp.readFile(file)).toString('base64')}`, detail: 'high' }] }];
    const { parsed: r } = await llmJson({ name: 'card_proof', model: CARD_MODEL, effort: 'low', schema: PROOF_SCHEMA, log: { type: 'card_proof', seriesId: id, card: card.n }, input,
      instructions: `You are the proofreader for printed children's story cards. Compare the finished card image with its script. Report: (1) any expected text that is misspelled, altered, cut off or missing — ignore line breaks, capitalisation of display lettering, and curly versus straight quotes; (2) lettered words that are not in the expected list (panel numbers are fine); (3) picture problems, each marked major or minor; (4) how many times the hidden friend appears.
MAJOR picture problems are only those a parent reading aloud would notice and that confuse the story: a named character drawn as a different character; a named character the picture needs is absent; a named character appears who should not be there; the one thing the picture is about is not shown (the caption says stuck and nobody is stuck; the family the story mentions is missing); a play prompt asks the child to find or count something that is not clearly drawn, or the number drawn differs from the number the story gives.
ALWAYS MAJOR, however small it is drawn and whatever else is right: a named character drawn where the story facts or a panel's must-NOT-show list say it cannot be (outside and free when the facts say it is trapped inside something; moving by itself when it is being carried; present after being left behind; in a panel that does not list it). Check every panel for this before anything else, and name the panel and the character. Also major: the thing the story's problem depends on is drawn in a state that undoes the problem (an entrance the facts call blocked is wide open; something out of reach is within reach).
MINOR is everything else: exact counts of background things, details of props and small objects, how something is held, pose and anatomy details, markings and stripes, colours of small things, scenery, items in decorative boxes. When unsure, choose minor. Do not report matters of taste or composition at all.
"pass" is true when there are no text problems, no extra text and no major picture problems.` });
    if (opts.draft) { r.textProblems = []; r.extraText = []; r.hiddenFriendCount = -1; }
    const issues = [...r.textProblems.map((x) => `Text: “${x.expected}” → ${x.found}`), ...r.extraText.map((x) => `Extra text: “${x}”`), ...r.pictureProblems.filter((x) => x.severity === 'major').map((x) => x.issue), ...(r.hiddenFriendCount === 0 ? ['The hidden friend is missing'] : [])];
    const notes = [...r.pictureProblems.filter((x) => x.severity !== 'major').map((x) => x.issue), ...(r.hiddenFriendCount > 1 ? [`The hidden friend appears ${r.hiddenFriendCount} times`] : [])];
    const check = { imageId: recId, ...(opts.draft ? { draft: true } : {}), pass: issues.length === 0, issues, notes, fixNotes: issues.length ? [...issues, ...notes].join('\n') : '', at: new Date().toISOString() };
    await withSeries(id, (x) => { const c = x.cards.find((k) => k.id === cardId); if (c && c.imageId === recId) c.check = check; return x; });
    await appendLog({ type: 'card_proof', seriesId: id, card: card.n, recordId: recId, pass: check.pass, issues });
    return check;
  }

  // body.draft: a cheap low-quality storyboard picture (no proofreading; replaced by the real one later).
  // body.fixNotes: mistakes to avoid. Otherwise, when proofreading is on, the card is checked and redrawn once if it fails.
  async function drawCard(id, cardId, opts = {}) {
    let s = await ensureContinuity(id).catch(() => getSeries(id));
    if (s.image.textMode === 'story') s = await ensureStoryText(id);
    const card = s.cards.find((c) => c.id === cardId);
    if (!card) throw new HttpError(404, 'Card not found.');
    if (!card.title) throw new HttpError(400, 'Write this card first.');
    const t = await templatesFor(s);
    const all = await readCharacters();
    const characterIds = s.cast.filter((c) => c.characterId && card.characters.includes(c.name) && all.some((x) => x.id === c.characterId)).map((c) => c.characterId);
    // A draft sketch sends no reference images (they are most of the cost): characters are drawn from their descriptions.
    const prompt = cardPrompt(s, card, t, { fixNotes: opts.fixNotes, describeAll: Boolean(opts.draft) });
    const drawnFrom = printSig(s, card, t);
    const refs = opts.draft ? [] : await referenceImages(s, card, t, opts);
    if (opts.draft) characterIds.length = 0;
    const label = `${s.cards.length > 1 ? `${s.title || 'Series'} — ${card.n}. ${card.title}` : card.title}${opts.draft ? ' (draft)' : s.image.textMode === 'story' && s.brief.kind === 'story' ? ' (story on card)' : ''}`;
    const r = await handleGenerate({
      prompt, originalPrompt: `${card.title}${card.subtitle ? ` — ${card.subtitle}` : ''}`.slice(0, 200), model: s.image.model, quality: opts.draft ? 'low' : s.image.quality, size: s.image.size, n: 1, format: 'png',
      characterIds, tags: ['flash-card', slugify(s.title || 'series'), `card-${card.n}`, ...(opts.draft ? ['draft'] : [])],
    }, { refs, meta: { card: { seriesId: s.id, cardId: card.id, n: card.n, draft: Boolean(opts.draft), templateId: t.layout.id, styleTemplateId: t.style?.id || null } }, ai: { feature: 'card_image', refs: { seriesId: s.id } } });
    const rec = await handleUpdate(r.images[0].id, { title: label.slice(0, 120) });
    const updated = await withSeries(id, (x) => {
      const c = x.cards.find((k) => k.id === cardId);
      if (c) { c.imageIds = [...(c.imageIds || []), rec.id]; c.imageId = rec.id; c.draft = Boolean(opts.draft); c.check = null; c.prints = { ...(c.prints || {}), [rec.id]: drawnFrom }; }
      return x;
    });
    await appendLog({ type: 'card_image', seriesId: id, card: card.n, title: card.title, recordId: rec.id, draft: Boolean(opts.draft), refs: refs.map((x) => x.label), characterIds, costUsd: rec.costUsd });
    return { series: updated, record: rec };
  }
  // Draw, proofread, and while the picture fails: let the script doctor fill in the picture brief when the script is at
  // fault (applied automatically unless the series turns that off), then redraw with the proofreader's notes. At most three
  // pictures for a final card and two for a draft sketch; the attempt with the fewest problems stays selected.
  async function handleCardImage(id, cardId, body = {}) {
    const draft = Boolean(body.draft);
    const first = await drawCard(id, cardId, { draft, fixNotes: clampStr(body.fixNotes, 2000) });
    const proof = 'proof' in body ? Boolean(body.proof) : first.series.image.proof !== false;
    if (!proof) return first;
    const auto = first.series.image.autoFix !== false, max = draft ? 2 : 3, fixed = [];
    const tries = [{ record: first.record, check: await checkCard(id, cardId, first.record.id, { draft }).catch(() => null) }];
    while (tries.length < max) {
      const last = tries[tries.length - 1];
      if (!last.check || last.check.pass) break;
      const proposal = await proposeFix(id, cardId, last.check).catch(() => null);
      if (proposal && !auto) { last.check = { ...last.check, proposal }; break; }
      if (proposal) { await handleApplyFix(id, cardId, {}); fixed.push(proposal.explanation); }
      const next = await drawCard(id, cardId, { draft, fixNotes: last.check.fixNotes }).catch(() => null);
      if (!next) break;
      tries.push({ record: next.record, check: await checkCard(id, cardId, next.record.id, { draft }).catch(() => null) });
    }
    const score = (t) => (!t.check ? 99 : t.check.pass ? -1 : t.check.issues.length);
    const best = tries.reduce((x, y) => (score(y) <= score(x) ? y : x));
    const check = best.check && fixed.length ? { ...best.check, autoFixed: fixed } : best.check;
    await withSeries(id, (x) => { const c = x.cards.find((k) => k.id === cardId); if (c) { c.imageId = best.record.id; if (check) c.check = check; } return x; });
    return { series: await getSeries(id), record: best.record, records: tries.map((t) => t.record), check };
  }

  // ---------- script doctor: when the proofreader's complaint is really the script's fault ----------
  const FIX_SCHEMA = obj({
    cause: { type: 'string', enum: ['script', 'picture'] }, explanation: str('one or two plain sentences for the author'),
    panels: { type: 'array', description: 'only panels whose picture description must change; empty when cause is picture', items: obj({ key: str('the panel key exactly as given'), visual: str('the complete new picture description') }) },
    hero: str('new main-picture description, or "" to leave it'), addCharacters: { type: 'array', items: str('exact cast name') },
  });
  async function proposeFix(id, cardId, check) {
    const s = await getSeries(id);
    const card = s.cards.find((c) => c.id === cardId);
    const pictureIssues = (check?.issues || []).filter((x) => !/^(Text|Extra text):/.test(x));
    if (!card || !pictureIssues.length) return null;
    const t = await templatesFor(s);
    const slots = slotsFor(t.layout, card).map((slot) => ({ slot, v: card.slots.find((x) => x.key === slot.key) })).filter((x) => x.v && (x.v.heading || x.v.text || x.v.visual));
    const { parsed: r } = await llmJson({ name: 'card_script_fix', model: CARD_MODEL, effort: 'low', schema: FIX_SCHEMA, log: { type: 'card_script_fix', seriesId: id, card: card.n },
      instructions: `A proofreader compared a finished children's story card with its script and flagged picture problems. Decide where the fault lies.
"picture": the script's picture descriptions clearly ask for the thing, and the illustrator left it out or drew it wrong. Redrawing will fix it. Return no panels.
"script": the picture descriptions never ask for the missing character, object or action (or contradict the caption, the story text or the narration), so the illustrator could not have known. Redrawing from the same script will fail again.
When the cause is "script", return corrected picture descriptions for only the panels that need them. Each is a complete replacement of that panel's description, at most 60 words, in the same plain style, naming exactly who is in the picture and what must be visible, including how many and what they look like if the script elsewhere says. Change as little as possible; never change captions, speech or the story. "addCharacters": cast members (exact names from the cast list) who must be drawn on this card but are not in its character list. "hero" stays "" unless the card has a main picture that needs the change.`,
      input: [`Card ${card.n} of "${s.title}": ${card.title}`, `What happens: ${card.beat}`, card.narration && `Narration: ${card.narration}`, card.storyText && `Story text: ${card.storyText}`,
        card.hero && `Main picture: ${card.hero}`, `Panels:\n${slots.map(({ slot, v }) => `- key "${slot.key}" (${slot.label}) — caption: ${v.heading || '—'} | speech: ${v.text || '—'} | picture description: ${v.visual || '—'}`).join('\n')}`,
        `Characters listed on this card: ${card.characters.join(', ') || 'none'}`, `Cast: ${s.cast.map((c) => c.name).join(', ')}`,
        `PROOFREADER FLAGGED:\n${pictureIssues.map((x) => `- ${x}`).join('\n')}`].filter(Boolean).join('\n\n') });
    if (r.cause !== 'script') return null;
    const panels = (r.panels || []).map((x) => { const hit = slots.find((k) => k.slot.key === x.key); const to = clampStr(x.visual, 800); return hit && to && to !== hit.v.visual ? { key: x.key, label: hit.slot.label, from: hit.v.visual, to } : null; }).filter(Boolean);
    const hero = card.hero && clampStr(r.hero, 1200) && clampStr(r.hero, 1200) !== card.hero ? { from: card.hero, to: clampStr(r.hero, 1200) } : null;
    const addCharacters = (r.addCharacters || []).filter((n) => s.cast.some((c) => c.name === n) && !card.characters.includes(n));
    if (!panels.length && !hero && !addCharacters.length) return null;
    const proposal = { explanation: clampStr(r.explanation, 600), panels, hero, addCharacters, at: new Date().toISOString() };
    await withSeries(id, (x) => { const c = x.cards.find((k) => k.id === cardId); if (c?.check && c.check.imageId === check.imageId) c.check.proposal = proposal; return x; });
    await appendLog({ type: 'card_script_fix', seriesId: id, card: card.n, panels: panels.map((x) => x.key), addCharacters });
    return proposal;
  }
  // Accept (or dismiss) the proposed script correction. Accepting rewrites the picture descriptions; the card then shows as
  // changed since its picture, and the next drawing uses the corrected script.
  async function handleApplyFix(id, cardId, body = {}) {
    return withSeries(id, (x) => {
      const c = x.cards.find((k) => k.id === cardId), p = c?.check?.proposal;
      if (!p) throw new HttpError(400, 'There is no proposed correction for this card.');
      if (!body.dismiss) {
        for (const e of p.panels) { const v = c.slots.find((k) => k.key === e.key); if (v) v.visual = e.to; }
        if (p.hero) c.hero = p.hero.to;
        c.characters = [...new Set([...c.characters, ...p.addCharacters])];
      }
      c.check.proposal = null; if (!body.dismiss) c.check.accepted = true;
      return x;
    });
  }

  // ---------- whole-book continuity: every finished picture looked at together ----------
  const CONT_SCHEMA = obj({
    summary: str('one sentence'),
    issues: { type: 'array', items: obj({ subject: str('the character, object or place'), problem: str('what differs, naming the cards'), cards: { type: 'array', items: { type: 'integer' }, description: 'cards where it looks wrong' },
      severity: { type: 'string', enum: ['major', 'minor'] }, fixNote: str('instruction for the illustrator redrawing the wrong cards: what it must look like') }) },
  });
  async function handleContinuity(id) {
    const s = await getSeries(id);
    const cards = s.cards.filter((c) => c.imageId && !c.draft);
    if (cards.length < 2) throw new HttpError(400, 'The whole-book check needs at least two finished pictures.');
    const all = await readCharacters();
    const content = [{ type: 'input_text', text: [`Story: "${s.title}" — ${s.logline}`, s.world && `World: ${s.world}`,
      `CAST (the fixed design of each character):\n${s.cast.map((c) => `- ${c.name}: ${c.description.slice(0, 400)}`).join('\n')}`,
      (s.places || []).length && `PLACES:\n${s.places.map((pl) => `- ${pl.name}: ${pl.description}`).join('\n')}`,
      s.hiddenFriend && `Hidden friend (one small one per card): ${s.hiddenFriend}`,
      `CARDS, in reading order (the pictures follow in the same order):\n${cards.map((c) => `Card ${c.n} "${c.title}" — place: ${c.place || '—'}; with: ${c.characters.join(', ') || '—'}. ${c.beat}`).join('\n')}`].filter(Boolean).join('\n\n') }];
    for (const m of s.cast) {
      const ref = all.find((x) => x.id === m.characterId)?.refs?.[0];
      const url = ref?.recordId && await recordJpeg(ref.recordId, 768).catch(() => null);
      if (url) content.push({ type: 'input_text', text: `Reference design of ${m.name} (the canonical look):` }, { type: 'input_image', image_url: url, detail: 'low' });
    }
    const sent = [];
    for (const c of cards) {
      const url = await recordJpeg(c.imageId, 1024).catch(() => null);
      if (!url) continue;
      sent.push(c);
      content.push({ type: 'input_text', text: `Card ${c.n}:` }, { type: 'input_image', image_url: url, detail: 'high' });
    }
    const { parsed: r, usage, durationMs } = await llmJson({ name: 'card_continuity', model: CARD_MODEL, effort: 'medium', schema: CONT_SCHEMA, log: { type: 'card_continuity', seriesId: id }, input: [{ role: 'user', content }],
      instructions: `You are the continuity checker for a children's story told on printed cards. You are shown every finished card in reading order. Look ACROSS the cards, not at each one alone, and report where something that should stay the same does not:
1. Characters: each recurring character keeps one design on every card — body colour, markings, eye style, proportions and relative size to the others, accessories. The canonical look is the reference design where one is shown, otherwise what most cards show.
2. Things that persist: an object that is carried, sought, broken, opened or changed stays in that state on the following cards until the story changes it. Report an object that vanishes while it should still be there, reappears after being lost, or changes shape or colour.
3. Places: two cards set in the same named place show the same landmarks.
4. Count and presence: someone who joined the group and has not left is still with the group when the picture shows the group.
INTENDED variation is not a problem and must not be reported: each card has its own colour palette, light and page layout; backgrounds change as the journey moves; expressions and poses change.
Report only what a parent reading the cards in a row, or a sharp-eyed child, would notice. "major" changes who or what something appears to be, or breaks the story's logic; "minor" is a small drift. In "cards" list the cards that are WRONG (the minority that differ from the reference or from most cards), never all cards. At most 8 issues, most serious first. If the set is consistent, return no issues.` });
    const known = new Set(sent.map((c) => c.n));
    const issues = (r.issues || []).slice(0, 8).map((x) => ({ id: crypto.randomUUID(), subject: clampStr(x.subject, 120), problem: clampStr(x.problem, 600), cards: [...new Set((x.cards || []).filter((n) => known.has(n)))], severity: x.severity === 'major' ? 'major' : 'minor', fixNote: clampStr(x.fixNote, 600) })).filter((x) => x.cards.length);
    const updated = await withSeries(id, (x) => { x.continuity = { at: new Date().toISOString(), checked: Object.fromEntries(sent.map((c) => [c.id, c.imageId])), summary: clampStr(r.summary, 400), issues }; return x; });
    await appendLog({ type: 'card_continuity', seriesId: id, cards: sent.length, issues: issues.map((x) => `${x.severity}: ${x.subject} (cards ${x.cards.join(', ')})`), usage, durationMs });
    return { series: updated, continuity: updated.continuity };
  }

  // ---------- read-back: what story do the pictures tell by themselves? ----------
  // One reader sees only the pictures (no script) and says what each shows and what story they add up to; a second compares
  // that with the story as written. Where the two differ, the pictures and the words are telling different stories.
  async function handleReadback(id, progress = () => {}) {
    const s = await getSeries(id);
    const cards = s.cards.filter((c) => c.imageId && !c.draft);
    if (s.brief.kind !== 'story' || cards.length < 3) throw new HttpError(400, 'Reading a story back needs at least three finished pictures.');
    const content = [{ type: 'input_text', text: `CAST (only so that you can name who you see):\n${s.cast.map((c) => `- ${c.name}: ${c.description.slice(0, 220)}`).join('\n')}` }];
    const sent = [];
    for (const c of cards) {
      const url = await recordJpeg(c.imageId, 1024).catch(() => null);
      if (!url) continue;
      sent.push(c);
      content.push({ type: 'input_text', text: `Card ${c.n}:` }, { type: 'input_image', image_url: url, detail: 'high' });
    }
    progress({ phase: `Looking at ${sent.length} pictures without the script`, force: true });
    const { parsed: seen } = await llmJson({ name: 'card_readback_look', model: CARD_MODEL, effort: 'low', log: { type: 'card_readback', seriesId: id }, input: [{ role: 'user', content }],
      schema: obj({ cards: { type: 'array', items: obj({ n: { type: 'integer' }, seen: str('one or two plain sentences') }) }, retelling: str('four to six sentences') }),
      instructions: `You are shown the cards of a children's picture story, in order. You have not been told the story. Look ONLY at the pictures and ignore every lettered word (titles, captions, speech bubbles, boxes, ribbons), as a child who cannot read would.
For each card, say in one or two plain sentences what its pictures show: who is there, where each one is (inside or outside what, held by whom), what they are doing, and what state the important things are in. Report what is drawn, even when it seems odd; do not smooth it into what would make sense.
Then retell the whole story, as far as the pictures alone tell it, in four to six sentences. Where the pictures do not show why something happens or how someone got somewhere, say that plainly instead of guessing.` });
    progress({ phase: 'Comparing what the pictures say with the story as written', force: true });
    const intended = [s.spine && `Spine: ${s.spine}`, `Cards as written:\n${sent.map((c) => `Card ${c.n} "${c.title}": ${c.beat}${c.state ? ` [state at the end: ${c.state}]` : ''}`).join('\n')}`].filter(Boolean).join('\n\n');
    const { parsed: r } = await llmJson({ name: 'card_readback_compare', model: CARD_MODEL, effort: 'low', log: { type: 'card_readback', seriesId: id },
      schema: obj({ verdict: str('one sentence: do the pictures tell the same story?'), issues: { type: 'array', items: obj({ card: { type: 'integer' }, intended: str('what the story says, briefly'), seen: str('what the pictures show instead'), severity: { type: 'string', enum: ['major', 'minor'] } }) } }),
      instructions: `A reader who saw only the pictures of a children's story described each card and retold the story. Compare that with the story as written. Report each card where a child looking only at the pictures would understand something different about WHO is WHERE, what happens, or the state of the thing the plot depends on. "major": the pictures contradict the story or lose a step it needs (someone free who should be trapped, the problem already solved, the helper's action not shown, the family missing at the reunion). "minor": a detail differs but the story survives. Do not report differences of wording, mood, colours, or things the picture reader simply could not know from pictures (names of places, what is said). At most ten, most serious first; none if the pictures tell the same story.`,
      input: `THE STORY AS WRITTEN\n${intended}\n\nWHAT THE PICTURES SHOW (from a reader who had only the pictures)\n${(seen.cards || []).map((c) => `Card ${c.n}: ${c.seen}`).join('\n')}\n\nThat reader's retelling: ${seen.retelling}` });
    const known = new Set(sent.map((c) => c.n));
    const readback = { at: new Date().toISOString(), checked: Object.fromEntries(sent.map((c) => [c.id, c.imageId])), retelling: clampStr(seen.retelling, 2000), verdict: clampStr(r.verdict, 400),
      issues: (r.issues || []).slice(0, 10).filter((x) => known.has(x.card)).map((x) => ({ id: crypto.randomUUID(), card: x.card, intended: clampStr(x.intended, 400), seen: clampStr(x.seen, 400), severity: x.severity === 'major' ? 'major' : 'minor' })) };
    const updated = await withSeries(id, (x) => { x.readback = readback; return x; });
    await appendLog({ type: 'card_readback', seriesId: id, cards: sent.length, issues: readback.issues.map((x) => `${x.severity}: card ${x.card} — ${x.seen}`) });
    return { series: updated, readback };
  }

  // ---------- text tidy: caption length and steady naming, after writing ----------
  // The name the story actually uses for a character: "Ollie" rather than "Ollie the Octopus" when the text says Ollie.
  function callName(name, s) {
    const first = name.split(' ')[0];
    if (first === name || /^(the|a|baby|little|mr|mrs|miss|old)$/i.test(first)) return name;
    const text = s.cards.map((c) => `${c.narration} ${c.storyText} ${c.slots.map((x) => x.heading).join(' ')}`).join(' ');
    const full = text.split(name).length - 1, short = text.split(first).length - 1 - full;
    return short > full ? first : name;
  }
  async function tidyText(id, cardIds) {
    const s = await getSeries(id);
    if (s.brief.kind !== 'story') return { series: s, changed: 0 };
    const { layout } = await templatesFor(s);
    const a = audienceOf(s);
    const cards = s.cards.filter((c) => c.title && (!cardIds || cardIds.includes(c.id)));
    if (!cards.length) return { series: s, changed: 0 };
    const view = (c) => ({ n: c.n, captions: slotsFor(layout, c).filter((x) => x.role === 'story-panel').map((x) => ({ key: x.key, caption: c.slots.find((v) => v.key === x.key)?.heading || '' })), storyText: c.storyText || '' });
    const { parsed } = await llmJson({ name: 'card_text_tidy', model: CARD_MODEL, effort: 'low', log: { type: 'card_text_tidy', seriesId: id },
      schema: obj({ cards: { type: 'array', items: obj({ n: { type: 'integer' }, captions: { type: 'array', items: obj({ key: str(), caption: str() }) }, storyText: str() }) } }),
      instructions: `You are the copy editor for a children's story told on cards. Return every card with its captions and storyText corrected to these rules, changing as little as possible and never changing what happens:
1. Each caption is at most 9 words. Shorten by cutting, not by dropping the character's name or the action.
2. One name per character and per thing: replace nicknames and stand-ins ("the baby", "the little one", "the octopus", "his passenger") with the character's call-name exactly as listed, and call each object and place by the same plain word every time. Ordinary pronouns (he, she, his, its, they) are fine and should stay wherever it is clear who is meant; do not repeat a name three times in one sentence. Never lengthen a name that is already the call-name.
5. Keep the linking words that join one caption to the next (But, So, Then, Because).
3. storyText is ${storyWords(a)} words ("" stays ""). Trim or pad lightly to fit.
4. Keep the caption chain readable: captions alone, in order, still tell the story.
Leave text that already follows the rules exactly as it is.`,
      input: `Call-names: ${s.cast.map((c) => callName(c.name, s)).join(', ')}\nStory: ${s.logline}\n\n${JSON.stringify(s.cards.filter((c) => c.title).map(view))}\n\nReturn cards: ${cards.map((c) => c.n).join(', ')}` });
    let changed = 0;
    const updated = await withSeries(id, (x) => {
      for (const o of parsed.cards || []) {
        const c = x.cards.find((k) => k.n === o.n && cards.some((w) => w.id === k.id));
        if (!c) continue;
        for (const cap of o.captions || []) { const v = c.slots.find((k) => k.key === cap.key); const nv = clampStr(cap.caption, 300); if (v && nv && nv !== v.heading) { v.heading = nv; changed++; } }
        const st = clampStr(o.storyText, 800); if (st && st !== c.storyText) { c.storyText = st; changed++; }
      }
      return x;
    });
    await appendLog({ type: 'card_text_tidy', seriesId: id, cards: cards.map((c) => c.n), changed });
    return { series: updated, changed };
  }

  // ---------- places: one reference painting per place, so the world stays the same across cards ----------
  // body.redo: the id of a place to paint again (its old painting stays in History).
  async function handlePlaces(id, body = {}) {
    let s = await getSeries(id);
    if (s.brief.kind !== 'story' || !s.cards.length) throw new HttpError(400, 'Plan a story first.');
    if (!(s.places || []).length) {
      // Stories planned before places existed: work them out from the cards.
      const { parsed } = await llmJson({ name: 'card_places', model: CARD_MODEL, effort: 'low', log: { type: 'card_places', seriesId: id },
        schema: obj({ places: { type: 'array', items: obj({ name: str(), description: str() }) }, cards: { type: 'array', items: obj({ n: { type: 'integer' }, place: str() }) } }),
        instructions: 'From this card story, list the three to six distinct places it visits. For each: a short name and a 20–40 word description of the landmarks, shapes and plants an illustrator must keep the same every time (no characters, no events, no colours of light). Then give every card the name of its place, exactly as listed.',
        input: `World: ${s.world || '—'}\n\n${s.cards.map((c) => `Card ${c.n} "${c.title || c.topic}": ${c.beat} [${c.setting}]`).join('\n')}` });
      s = await withSeries(id, (x) => {
        x.places = (parsed.places || []).slice(0, 8).map((pl) => ({ id: crypto.randomUUID(), name: clampStr(pl.name, 80), description: clampStr(pl.description, 600), imageId: null })).filter((pl) => pl.name);   // fixtures follow below
        for (const o of parsed.cards || []) { const c = x.cards.find((k) => k.n === o.n); if (c && x.places.some((pl) => pl.name === o.place)) c.place = o.place; }
        return x;
      });
    }
    const t = await templatesFor(s);
    // Places planned before they carried "fixtures" (the objects the plot depends on, in their story state) get them here.
    if (s.places.some((pl) => pl.fixtures === undefined)) {
      const { parsed } = await llmJson({ name: 'card_place_fixtures', model: CARD_MODEL, effort: 'low', log: { type: 'card_places', seriesId: id },
        schema: obj({ places: { type: 'array', items: obj({ name: str('exactly as given'), fixtures: str() }) } }),
        instructions: 'For each place of this card story, write "fixtures": the objects in that place that the plot depends on, in the exact state they are in when the story FIRST arrives there, with position and size (for example "a loose stone wedged across the low entrance of the hollow, covering all but a gap one hand high"). One or two sentences; no characters; "" when the plot depends on no object there. Take the facts from the story; do not invent objects.',
        input: `${storyDigest(s, t.layout)}\n\nReturn places: ${s.places.map((pl) => pl.name).join('; ')}` }).catch(() => ({ parsed: { places: [] } }));
      s = await withSeries(id, (x) => { for (const pl of x.places) if (pl.fixtures === undefined) pl.fixtures = clampStr((parsed.places || []).find((o) => o.name === pl.name)?.fixtures, 400); return x; });
    }
    const made = [];
    for (const pl of s.places.filter((x) => !x.imageId || x.id === body.redo)) {
      const prompt = [`Location reference painting for the children's story "${s.title}": ${pl.name}.`, '', `Show the place by itself, as a wide establishing view with its landmarks clearly readable: ${pl.description}`,
        pl.fixtures && `The story depends on this, so paint it large, in clear view and exactly in this state: ${pl.fixtures}`, s.world && `World: ${s.world}`,
        `Style: ${styleOf(s, t)}`, 'Constraints:', '- No characters, animals or creatures of any kind.', '- No text, letters, panels, borders or frames; one single full-bleed picture.', '- Neutral, even daylight so the shapes are clear.'].filter(Boolean).join('\n\n').replace(/\n\n- /g, '\n- ');
      const r = await handleGenerate({ prompt, originalPrompt: `${pl.name} — place reference for ${s.title}`, model: s.image.model, quality: 'medium', size: '1536x1024', format: 'png', n: 1, tags: ['flash-card', slugify(s.title || 'series'), 'place'] }, { ai: { feature: 'card_place', refs: { seriesId: s.id } } });
      const rec = await handleUpdate(r.images[0].id, { title: `${s.title} — place: ${pl.name}`.slice(0, 120) });
      made.push(rec);
      s = await withSeries(id, (x) => { const k = x.places.find((m) => m.id === pl.id); if (k) k.imageId = rec.id; return x; });
    }
    await appendLog({ type: 'card_places', seriesId: id, places: s.places.map((x) => x.name), made: made.length, costUsd: made.reduce((n, r) => n + (r.costUsd || 0), 0) });
    return { series: s, records: made };
  }

  // ---------- cover and chapter cards ----------
  const chaptersOf = (s) => { const out = []; for (const c of s.cards) { if (!c.chapter) continue; const last = out[out.length - 1]; if (last && last.title === c.chapter) last.cards.push(c); else out.push({ title: c.chapter, cards: [c] }); } return out; };
  async function handleExtras(id, body = {}) {
    let s = await getSeries(id);
    if (!s.cards.length) throw new HttpError(400, 'Plan the series first.');
    const t = await templatesFor(s);
    const all = await readCharacters();
    const linked = (names) => s.cast.filter((c) => c.characterId && (!names || names.includes(c.name)) && all.some((x) => x.id === c.characterId));
    const style = styleOf(s, t);
    const draw = async (prompt, title, chars, tag, place) => {
      const refs = [];
      const file = place?.imageId && await deps.recordFile(place.imageId);
      if (file) refs.push({ dataUrl: `data:image/png;base64,${(await fsp.readFile(file)).toString('base64')}`, label: `place: ${place.name}`, text: `location reference for "${place.name}": keep its landmarks and shapes. It shows no characters.` });
      const r = await handleGenerate({ prompt, originalPrompt: title, model: s.image.model, quality: s.image.quality, size: s.image.size, n: 1, format: 'png', characterIds: chars.slice(0, 5).map((c) => c.characterId), tags: ['flash-card', slugify(s.title || 'series'), tag] }, { refs, ai: { feature: 'card_extra', refs: { seriesId: s.id } } });
      return handleUpdate(r.images[0].id, { title: title.slice(0, 120) });
    };
    const made = [];
    const tail = ['', `Style (the same rendering and character designs as the story cards): ${style}`, '', 'Constraints:', '- Letter the quoted text exactly, with correct spelling; no other text, no logos, no watermark.', '- Keep all lettering inside a safe margin of about 5% from every edge; the art runs to the edge.', '- One single picture: no comic panels, no speech bubbles, no boxes.'];
    if (!s.cover?.imageId || body.redoCover) {
      const cast = linked();
      const names = s.cast.map((c) => c.name);
      const rec = await draw([`Front cover of the children's story card set ${quoted(s.title)}.`, '', `Lettering: the title ${quoted(s.title)} in huge, puffy, joyful lettering across the top third. Near the bottom, small: ${quoted(`A story in ${s.cards.length} cards`)}.`,
        '', `Picture: ${names.slice(0, 5).join(', ')} together in the world of the story, warm and inviting, the main character ${names[0]} largest and in the centre, looking at the reader. ${s.logline}`, s.world && `World: ${s.world}`,
        cast.length < names.length ? `Characters without reference images: ${s.cast.filter((c) => !cast.includes(c)).map((c) => `${c.name}: ${c.description}`).join(' | ')}` : '', ...tail].filter((l) => l != null && l !== false).join('\n'), `${s.title} — cover`, cast, 'cover');
      made.push(rec);
      s = await withSeries(id, (x) => { x.cover = { imageId: rec.id, imageIds: [...(x.cover?.imageIds || []), rec.id] }; return x; });
    }
    const chapters = chaptersOf(s);
    for (const [i, ch] of chapters.entries()) {
      if (s.chapterCards?.[ch.title] && !body.redoChapters) continue;
      const first = ch.cards[0], names = [...new Set(ch.cards.flatMap((c) => c.characters))];
      const place = (s.places || []).find((pl) => pl.name === first.place);
      const rec = await draw([`Chapter title card for the children's story card set ${quoted(s.title)}.`, '', `Lettering: small spaced capitals ${quoted(`CHAPTER ${i + 1}`)} above the chapter title ${quoted(ch.title)} in huge puffy lettering, in the upper half. At the bottom, small: ${quoted(`Cards ${first.n}–${ch.cards[ch.cards.length - 1].n}`)}.`,
        '', `Picture: a calm, wide view of where this chapter happens${place ? ` — ${place.name}: ${place.description}` : ''}, with ${s.cast[0]?.name || 'the main character'} small in the scene, setting out. Nothing from the plot is given away.`, first.setting && `Colours of this chapter: ${first.setting}`, ...tail].filter((l) => l != null && l !== false).join('\n'),
      `${s.title} — chapter ${i + 1}: ${ch.title}`, linked(names.length ? [s.cast[0]?.name] : null).slice(0, 1), 'chapter-card', place);
      made.push(rec);
      s = await withSeries(id, (x) => { x.chapterCards = { ...(x.chapterCards || {}), [ch.title]: rec.id }; return x; });
    }
    await appendLog({ type: 'card_extras', seriesId: id, made: made.map((r) => r.title), costUsd: made.reduce((n, r) => n + (r.costUsd || 0), 0) });
    return { series: s, records: made };
  }

  // Character sheet for a cast member who so far exists only as a description (and in finished cards). Follows the usual
  // practice: first one approved "master" drawing — taken from the cards the character already appears in, so the sheet matches
  // the art that exists — then a turnaround + expression sheet built from that master. The result is a studio character
  // linked to the cast member, so every later card is drawn from the sheet.
  async function handleCastSheet(id, castId) {
    const s = await getSeries(id);
    const c = s.cast.find((x) => x.id === castId);
    if (!c) throw new HttpError(404, 'Cast member not found.');
    if (c.characterId && (await readCharacters()).some((x) => x.id === c.characterId)) throw new HttpError(400, `${c.name} is already a studio character. Open it on the Images page to regenerate its reference sheet.`);
    // Cards the character appears in, fewest other characters first (cleanest view of the design).
    const seen = s.cards.filter((k) => k.imageId && k.characters.includes(c.name)).sort((a, b) => a.characters.length - b.characters.length || a.n - b.n).slice(0, 3);
    const others = s.cast.filter((x) => x.id !== c.id).map((x) => x.name);
    const refs = [];
    for (const k of seen) {
      const file = await deps.recordFile(k.imageId);
      const buf = file && await fsp.readFile(file).catch(() => null);
      if (buf && buf.length <= 15 * 1024 * 1024) refs.push({ dataUrl: `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,${buf.toString('base64')}`, label: `card ${k.n}`,
        text: `a finished story card in which "${c.name}" appears. Use it only to see exactly how ${c.name} is drawn (shapes, proportions, colours, markings, eyes, rendering style). Ignore its layout, panels, text and every other character.` });
    }
    const { layout, style } = await templatesFor(s);
    const look = styleOf(s, { layout, style });
    const prompt = [
      `Character master drawing of "${c.name}" from the children's story "${s.title}".`,
      '', `Show ${c.name} exactly once: full body, friendly neutral pose, three-quarter front view, centred, filling most of the frame, on a plain white background.`,
      `Who ${c.name} is: ${c.description}`,
      refs.length ? `Match the design shown in the attached cards precisely; this drawing is the same character lifted cleanly out of them, not a new interpretation.` : `Rendering style: ${look}`,
      others.length ? `Do not draw any other character (${others.join(', ')}).` : '',
      '', 'Constraints:', '- Plain white background, soft even lighting, no scene, no props, no panels, no borders.', '- No text, letters, labels or watermarks.',
    ].filter((l) => l !== '').join('\n');
    const r = await handleGenerate({ prompt, originalPrompt: `${c.name} — character master for ${s.title}`, model: 'gpt-image-2.5-sunburst', quality: 'high', size: '1024x1024', format: 'png', n: 1, tags: ['flash-card', slugify(s.title || 'series'), 'character-master'] }, { refs, ai: { feature: 'card_cast_master', refs: { seriesId: id } } });
    const master = await handleUpdate(r.images[0].id, { title: `${c.name} — character master` });
    const character = await handleCreateCharacter({ name: c.name, description: c.description, style: look.slice(0, 300), refs: [{ recordId: master.id, role: 'identity' }] });
    const sheet = await handleCharacterSheet(character.id, {}, { refs: { seriesId: id } });
    const updated = await withSeries(id, (x) => { const k = x.cast.find((m) => m.id === castId); if (k) k.characterId = character.id; return x; });
    // Every new character sheet is finished with the detailed bible; if that last step fails the character and clean sheet stay.
    const bible = await handleCastBible(id, castId).catch((e) => ({ error: e.message }));
    await appendLog({ type: 'card_cast_sheet', seriesId: id, name: c.name, characterId: character.id, masterId: master.id, sheetId: sheet.record.id, bibleId: bible.record?.id || null, fromCards: seen.map((k) => k.n), costUsd: (master.costUsd || 0) + (sheet.record.costUsd || 0) + (bible.record?.costUsd || 0) });
    return { series: updated, character: sheet.character, master, sheet: sheet.record, bible: bible.record || null, bibleError: bible.error || null };
  }

  // Character bible: the detailed production sheet every character gets. Step 1 writes the profile (from the story when
  // there is one, otherwise from the design alone); step 2 lays it out as one poster — identity block, annotated hero
  // portrait, design breakdown, scaled turnaround, head study, palette, story portrait and on-model rules — drawn from the
  // character's reference images. The clean, text-free sheet stays the image given to the model for new pages (a reference
  // full of lettering drags text into pictures); the bible is the human-readable source of truth and its profile feeds the
  // identity fields. ctx: { storyTitle, logline, spine, role, others, appearances } — all optional.
  async function characterBible(characterId, ctx = {}, body = {}) {
    const character = (await readCharacters()).find((x) => x.id === characterId);
    if (!character) throw new HttpError(404, 'Character not found.');
    if (!character.refs.length) throw new HttpError(400, `Add a reference image for ${character.name} first.`);
    const name = character.name;
    const input = [
      ctx.storyTitle ? `Story: "${ctx.storyTitle}"${ctx.logline ? ` — ${ctx.logline}` : ''}` : 'There is no story yet: write the profile from the design alone, giving the character a small, consistent, child-friendly personality and world.',
      ctx.spine && `Story spine: ${ctx.spine}`,
      `Character: ${name}${ctx.role ? ` (${ctx.role})` : ''}`, `Design: ${identityLine(character) || 'as shown in the reference images'}`,
      ctx.others && `Other cast (for size comparisons): ${ctx.others}`,
      ctx.appearances && `In the story:\n${ctx.appearances}`,
      clampStr(body.notes, 2000) && `Notes from the author: ${clampStr(body.notes, 2000)}`,
    ].filter(Boolean).join('\n\n');
    const { parsed: p, usage, durationMs } = await llmJson({ name: 'character_bible', model: CARD_MODEL, instructions: BIBLE_INSTRUCTIONS, schema: BIBLE_SCHEMA, log: { type: 'character_bible', characterId, ...(ctx.aiRefs || {}) }, input });
    const list = (a, n) => (a || []).slice(0, n).map((x) => String(x).trim()).filter(Boolean);
    const quote = (t) => `"${String(t).replace(/"/g, "'").trim()}"`;
    const lines = [
      `Character bible page (production character sheet) for "${name}"${ctx.storyTitle ? `, a character in the children's story "${ctx.storyTitle}"` : ', a children\'s picture-book character'}. One dense, beautifully organised portrait poster on a soft warm-grey paper background, laid out on a clear grid with thin rule lines between sections, in the manner of a professional film or animation character sheet. Every drawing shows the SAME single character design taken from the reference images.`,
      '', 'Layout, top to bottom:',
      `1. TOP LEFT (about 30% wide) — identity block. The name ${quote(name.toUpperCase())} in very large, heavy condensed capitals. Under it in small gold capitals: ${quote(p.epithets)}. Then in italics: ${quote(`“${p.quote}”`)}. Then a two-column fact list, labels in bold capitals:\n${list(p.facts.map((f) => `${f.label.toUpperCase()}: ${f.value}`), 8).map((t) => `   ${quote(t)}`).join('\n')}`,
      `   Below it the heading ${quote('PERSONALITY')} with ${quote('CORE TRAITS:')} as a bulleted list: ${list(p.coreTraits, 5).map(quote).join(', ')}; then ${quote('WANTS & WORRIES:')} ${quote(p.wantAndWorry)}; then ${quote('HABITS:')} as bullets: ${list(p.habits, 4).map(quote).join(', ')}; then ${quote('USUAL MOOD:')} ${quote(p.moodBaseline)}.`,
      `2. TOP CENTRE (about 42% wide) — a large, finely finished hero portrait of ${name} from the chest or mid-body up, three-quarter view, lively expression, on the plain background, with three small handwritten pencil notes and thin curved arrows pointing at the features they describe: ${list(p.callouts, 3).map(quote).join('; ')}.`,
      `3. RIGHT COLUMN (about 28% wide), boxed — heading ${quote('DESIGN BREAKDOWN')}; beneath it one small isolated close-up drawing for each part with its name in bold capitals and its note beside it:\n${p.designParts.slice(0, 5).map((d) => `   ${quote(d.name.toUpperCase())} — ${quote(d.note)}`).join('\n')}`,
      list(p.props, 4).length ? `   Then the heading ${quote('PROPS')} with small drawings of: ${list(p.props, 4).map(quote).join(', ')} (each labelled).` : '',
      `   Then the heading ${quote('COLOUR PALETTE')} with a row of ${Math.min(6, p.palette.length)} flat square swatches in exactly the character's colours, each with a tiny label: ${p.palette.slice(0, 6).map((x) => quote(x.name)).join(', ')}.`,
      `4. MIDDLE BAND, full width under the portrait — heading ${quote('TURNAROUND (FULL BODY)')}. Five full-body views of ${name} in the same neutral pose, the same size, standing on one ground line against a faint height ruler with tick marks down the left side: labelled underneath ${quote('FRONT')}, ${quote('3/4')}, ${quote('SIDE')}, ${quote('BACK')}, ${quote('3/4 BACK')}.`,
      `5. LOWER LEFT (about 48% wide) — heading ${quote('HEAD STUDY (EXPRESSIONS & ANGLES)')}. Six head close-ups in a 3 × 2 grid, labelled underneath: ${quote('FRONT (CALM)')}, ${quote('3/4 (HAPPY)')}, ${quote('PROFILE')}, ${quote('LOOKING DOWN (WORRIED)')}, ${quote('LOOKING UP (SURPRISED)')}, ${quote('SLEEPY')}.`,
      `6. LOWER RIGHT (about 52% wide) — heading ${quote('STORY PORTRAIT')}. A fully painted scene showing only ${name} (no other characters or animals): ${p.heroScene.description} Beside it a short note column: ${quote(`ENVIRONMENT: ${p.heroScene.environment}`)}, ${quote(`LIGHTING: ${p.heroScene.lighting}`)}, ${quote(`COLOUR TONE: ${p.heroScene.colourTone}`)}, ${quote(`EXPRESSION: ${p.heroScene.expression}`)}.`,
      `7. BOTTOM STRIP — left: heading ${quote('ON-MODEL RULES')} with four bullets: ${list(p.onModelRules, 4).map(quote).join('; ')}. Right: heading ${quote('TEXTURE GUIDE')} with ${Math.min(5, p.textures.length)} small square texture samples labelled ${list(p.textures, 5).map(quote).join(', ')}.`,
      '', 'Typography: clean modern sans-serif; section headings in small spaced capitals; body text small but crisp and fully legible; the handwritten notes in a neat pencil script.',
      '', 'Constraints:', '- Letter every quoted item exactly as written, with correct spelling; no other text, no lorem ipsum, no logos, no watermark.',
      `- ${name} looks identical in every drawing on the page: same shapes, proportions, colours and markings as the reference images. Do not redesign or age the character.`,
      '- Keep all content inside a 3% margin; nothing cut off at the edges.',
    ].filter((l) => l !== '');
    const r = await handleGenerate({ prompt: lines.join('\n'), originalPrompt: `${name} — character bible${ctx.storyTitle ? ` for ${ctx.storyTitle}` : ''}`, model: 'gpt-image-2.5-sunburst', quality: 'high', size: body.size === '1024x1536' ? '1024x1536' : '2048x3072', format: 'png', n: 1,
      characterIds: [character.id], tags: ['character-bible', slugify(name), ...(ctx.storyTitle ? [slugify(ctx.storyTitle)] : [])] }, { ai: { feature: 'character_bible_image', refs: { ...(ctx.aiRefs || {}), characterId } } });
    const rec = await handleUpdate(r.images[0].id, { title: `${name} — character bible` });
    // The written profile also sharpens the identity fields used in every later prompt.
    const patch = {};
    if (!character.palette) patch.palette = p.palette.slice(0, 5).map((x) => `${x.name} (${x.where})`).join(', ').slice(0, 300);
    if (!character.personality) patch.personality = list(p.coreTraits, 5).join(', ').slice(0, 300);
    if (Object.keys(patch).length) await deps.handleUpdateCharacter(character.id, patch);
    await deps.setCharacterBible(character.id, { recordId: rec.id, file: rec.file, at: new Date().toISOString(), story: ctx.storyTitle || null, profile: p });
    await appendLog({ type: 'character_bible', name, characterId, recordId: rec.id, story: ctx.storyTitle || null, usage, durationMs, costUsd: rec.costUsd });
    return { record: rec, profile: p };
  }
  async function handleCastBible(id, castId, body = {}) {
    const s = await getSeries(id);
    const c = s.cast.find((x) => x.id === castId);
    if (!c) throw new HttpError(404, 'Cast member not found.');
    if (!c.characterId) throw new HttpError(400, `Make a character sheet for ${c.name} first.`);
    const appears = s.cards.filter((k) => k.characters.includes(c.name));
    return characterBible(c.characterId, {
      aiRefs: { seriesId: id }, storyTitle: s.title, logline: s.logline, spine: s.spine, role: c.role,
      others: s.cast.filter((x) => x.id !== c.id).map((x) => `${x.name} — ${x.description.slice(0, 160)}`).join(' | '),
      appearances: appears.map((k) => `Card ${k.n} "${k.title}": ${k.narration || k.beat || k.slots.map((x) => [x.heading, x.text].filter(Boolean).join(' ')).join(' ')}`).join('\n'),
    }, body);
  }

  // ---------- series CRUD ----------
  async function handleCreateSeries(body) {
    await fsp.mkdir(SERIES_DIR, { recursive: true });
    const now = new Date().toISOString();
    const brief = cleanBrief(body.brief);
    const tpl = brief.templateId ? await getTemplate(brief.templateId).catch(() => null) : null;
    const s = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, brief, title: '', logline: '', styleGuide: '', spine: '', world: '', foundation: Object.fromEntries(FOUNDATION_FIELDS.map(([k]) => [k, ''])), editorNotes: '', refrain: '', hiddenFriend: '', cast: [], cards: [], image: cleanImage({ size: tpl?.size, ...(body.image || {}) }) };
    await inherit(s);
    await writeJsonAtomic(seriesFile(s.id), s);
    await appendLog({ type: 'card_series_created', seriesId: s.id, kind: brief.kind, templateId: brief.templateId, premise: brief.premise });
    return s;
  }
  async function handlePatchSeries(id, body) {
    const all = 'cast' in body ? await readCharacters() : [];
    return withSeries(id, async (s) => {
      const based = s.brief.basedOn || '';
      if (body.brief) s.brief = cleanBrief(body.brief, s.brief);
      if (s.brief.basedOn !== based) await inherit(s);
      if (body.image) s.image = cleanImage(body.image, s.image);
      for (const [k, max] of [['title', 200], ['logline', 1000], ['styleGuide', 3000], ['refrain', 200], ['hiddenFriend', 300], ['spine', 2500], ['world', 1500]]) if (k in body) s[k] = clampStr(body[k], max);
      if (body.foundation && typeof body.foundation === 'object') { s.foundation = s.foundation || {}; for (const [k] of FOUNDATION_FIELDS) if (k in body.foundation) s.foundation[k] = clampStr(body.foundation[k], 600); }
      if (Array.isArray(body.cast)) {
        s.cast = body.cast.slice(0, 10).map((c) => ({ id: clampStr(c.id, 64) || crypto.randomUUID(), name: clampStr(c.name, 80), role: clampStr(c.role, 200), description: clampStr(c.description, 1000),
          characterId: c.characterId && all.some((x) => x.id === c.characterId) ? c.characterId : null })).filter((c) => c.name);
      }
      for (const patch of Array.isArray(body.cards) ? body.cards : []) {
        const c = s.cards.find((x) => x.id === patch.id);
        if (!c) continue;
        if (PLAY_TYPES.includes(patch.play) || patch.play === '') c.play = patch.play;
        if (ARC_IDS.includes(patch.arc) || patch.arc === '') c.arc = patch.arc;
        for (const [k, max] of [['purpose', 400], ['feeling', 100], ['chapter', 120], ['place', 80], ['state', 700]]) if (k in patch) c[k] = clampStr(patch[k], max);
        for (const [k, max] of [['storyText', 800], ['narration', 3000], ['layout', 40], ['setting', 400], ['topic', 200], ['beat', 1000], ['title', 200], ['subtitle', 300], ['tagline', 400], ['hero', 1200], ['closing', 400], ['source', 300]]) if (k in patch) c[k] = clampStr(patch[k], max);
        if (Array.isArray(patch.slots)) c.slots = cleanCardSlots(patch.slots, s.cast);
        if (Array.isArray(patch.characters)) c.characters = patch.characters.map((n) => clampStr(n, 80)).filter((n) => s.cast.some((k) => k.name === n));
        if ('imageId' in patch) c.imageId = patch.imageId === null ? null : c.imageIds.includes(patch.imageId) ? patch.imageId : c.imageId;
      }
      // Adding, removing or moving cards renumbers them and keeps the brief's card count in step.
      const renumber = () => { s.cards.forEach((c, i) => { c.n = i + 1; }); s.brief.cardCount = Math.max(1, s.cards.length); };
      if (body.addCardAfter != null) {
        if (s.cards.length >= MAX_CARDS) throw new HttpError(400, `A series can have at most ${MAX_CARDS} cards.`);
        s.cards.splice(Math.min(s.cards.length, Math.max(0, Number(body.addCardAfter) || 0)), 0, newCard(0));
        renumber();
      }
      if (body.removeCard) { s.cards = s.cards.filter((c) => c.id !== body.removeCard); renumber(); }
      if (Array.isArray(body.orderCards)) {
        const at = new Map(body.orderCards.map((cid, i) => [cid, i]));
        s.cards = s.cards.map((c, i) => [c, at.has(c.id) ? at.get(c.id) : 1000 + i]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
        renumber();
      }
      if (body.moveCard) {
        const i = s.cards.findIndex((c) => c.id === body.moveCard.id), j = i + (body.moveCard.dir < 0 ? -1 : 1);
        if (i >= 0 && j >= 0 && j < s.cards.length) { [s.cards[i], s.cards[j]] = [s.cards[j], s.cards[i]]; renumber(); }
      }
      return s;
    });
  }
  async function handleDeleteSeries(id) {
    const s = await getSeries(id);
    await fsp.rm(seriesFile(id), { force: true });
    const mirror = path.join(BOOKS_DIR, `${id}.json`);
    if ((await readJsonFile(mirror, null))?.fromSeries) await fsp.rm(mirror, { force: true });
    await appendLog({ type: 'card_series_deleted', seriesId: id, title: s.title });
    return { deleted: id };
  }

  // The story as a read-aloud script (one section per card), for printing or reading from a phone.
  async function exportScript(id) {
    const s = await getSeries(id);
    const out = [`# ${s.title || 'Untitled series'}`, '', s.logline && `_${s.logline}_`, '', s.refrain && `**Refrain:** ${s.refrain}`, s.hiddenFriend && `**Hidden on every card:** ${s.hiddenFriend}`, ''];
    for (const c of s.cards) {
      const play = c.slots.find((x) => x.key === 'play');
      if (c.chapter && c.chapter !== s.cards[s.cards.indexOf(c) - 1]?.chapter) out.push(`# ${c.chapter}`, '');
      out.push(`## ${c.n}. ${c.title || c.topic}`, '', c.narration || c.beat || '', '', play?.text && `> ${[play.heading, play.text].filter(Boolean).join(' ')}`, '');
    }
    return out.filter((l) => l !== false && l != null && l !== undefined).join('\n');
  }

  // ---------- router (returns true when handled) ----------
  // Long calls stream NDJSON when ?stream=1: {"progress":{…}} lines, then {"done":result} or {"error":…}.
  async function streamed(res, url, model, work) {
    if (url.searchParams.get('stream') !== '1') return send(res, 200, await work(() => {}));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    let last = 0;
    const progress = (p) => { const now = Date.now(); if (p.force || now - last >= 200) { last = now; res.write(JSON.stringify({ progress: p }) + '\n'); } };
    res.write(JSON.stringify({ progress: { phase: `Thinking with ${model}` } }) + '\n');
    try { res.end(JSON.stringify({ done: await work(progress) }) + '\n'); }
    catch (e) { res.end(JSON.stringify({ error: e.message || 'Internal error', status: e.status || 500 }) + '\n'); }
  }

  async function route(req, res, url) {
    const p = url.pathname, m = req.method;
    if (p === '/api/cards/library' && m === 'GET') { send(res, 200, await handleLibrary()); return true; }
    if (p === '/api/cards/analysis' && m === 'GET') {
      const a = await readAnalysis(String(url.searchParams.get('id') || ''));
      if (!a) throw new HttpError(404, 'This card has not been analyzed yet.');
      send(res, 200, a); return true;
    }
    if (p === '/api/cards/analyze' && m === 'POST') { const body = await readJson(req); await streamed(res, url, CARD_VISION_MODEL, (progress) => handleAnalyze(body, progress)); return true; }
    if (p === '/api/cards/groups' && m === 'GET') { send(res, 200, await readJsonFile(GROUPS_FILE, { groups: [] })); return true; }
    if (p === '/api/cards/groups' && m === 'DELETE') { await fsp.rm(GROUPS_FILE, { force: true }); send(res, 200, { groups: [] }); return true; }
    if (p === '/api/cards/groups' && m === 'POST') { await streamed(res, url, CARD_MODEL, (progress) => handleSuggestGroups(progress)); return true; }
    if (p === '/api/cards/templates' && m === 'GET') { send(res, 200, await listTemplates()); return true; }
    if (p === '/api/cards/templates' && m === 'POST') { const body = await readJson(req); await streamed(res, url, CARD_MODEL, (progress) => handleTemplateFromCards(body, progress)); return true; }
    if (p.startsWith('/api/cards/templates/')) {
      const id = decodeURIComponent(p.slice('/api/cards/templates/'.length));
      if (m === 'GET') send(res, 200, await getTemplate(id));
      else if (m === 'PATCH') send(res, 200, await saveTemplate(cleanTemplate(await readJson(req), await getTemplate(id))));
      else if (m === 'DELETE') send(res, 200, await handleDeleteTemplate(id));
      else throw new HttpError(404, 'Not found.');
      return true;
    }
    if (m === 'POST' && /^\/api\/cards\/characters\/[^/]+\/bible$/.test(p)) { send(res, 200, await characterBible(decodeURIComponent(p.split('/')[4]), {}, await readJson(req))); return true; }
    if (p === '/api/cards/series' && m === 'GET') { send(res, 200, await listSeries()); return true; }
    if (p === '/api/cards/series' && m === 'POST') { send(res, 200, await handleCreateSeries(await readJson(req))); return true; }
    if (!p.startsWith('/api/cards/series/')) return false;
    const [id, a, b, c] = p.slice('/api/cards/series/'.length).split('/').map(decodeURIComponent);
    if (m === 'GET' && !a) send(res, 200, await getSeries(id));
    else if (m === 'PATCH' && !a) send(res, 200, await handlePatchSeries(id, await readJson(req)));
    else if (m === 'DELETE' && !a) send(res, 200, await handleDeleteSeries(id));
    else if (m === 'POST' && a === 'plan') { const body = await readJson(req); await getSeries(id); await streamed(res, url, CARD_MODEL, (progress) => handlePlan(id, body, progress)); }
    else if (m === 'POST' && a === 'write') { const body = await readJson(req); await getSeries(id); await streamed(res, url, CARD_MODEL, (progress) => handleWrite(id, body, progress)); }
    else if (m === 'POST' && a === 'cards' && c === 'image') send(res, 200, await handleCardImage(id, b, await readJson(req)));
    else if (m === 'POST' && a === 'cards' && c === 'check') { const check = await checkCard(id, b); const proposal = check.pass ? null : await proposeFix(id, b, check).catch(() => null); send(res, 200, { check: { ...check, proposal }, series: await getSeries(id) }); }
    else if (m === 'POST' && a === 'cards' && c === 'fix') send(res, 200, await handleApplyFix(id, b, await readJson(req)));
    else if (m === 'POST' && a === 'continuity') send(res, 200, await handleContinuity(id));
    else if (m === 'POST' && a === 'readback') { await getSeries(id); await streamed(res, url, CARD_MODEL, (progress) => handleReadback(id, progress)); }
    else if (m === 'POST' && a === 'logic') { await getSeries(id); await streamed(res, url, CARD_MODEL, (progress) => handleLogic(id, progress)); }
    else if (m === 'POST' && a === 'tidy') send(res, 200, await tidyText(id));
    else if (m === 'POST' && a === 'places') send(res, 200, await handlePlaces(id, await readJson(req)));
    else if (m === 'POST' && a === 'extras') send(res, 200, await handleExtras(id, await readJson(req)));
    else if (m === 'POST' && a === 'cast' && c === 'sheet') send(res, 200, await handleCastSheet(id, b));
    else if (m === 'POST' && a === 'cast' && c === 'bible') send(res, 200, await handleCastBible(id, b, await readJson(req)));
    else if (m === 'GET' && a === 'script.md') { const s = await getSeries(id); send(res, 200, await exportScript(id), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${slugify(s.title || 'story')}-read-aloud.md"` }); }
    else if (m === 'GET' && a === 'prompt' && b) {
      const s = await getSeries(id); const card = s.cards.find((x) => x.id === b);
      if (!card) throw new HttpError(404, 'Card not found.');
      const t = await templatesFor(s);
      send(res, 200, { prompt: cardPrompt(s, card, t), references: (await referenceImages(s, card, t)).map((r) => r.label) });
    } else throw new HttpError(404, 'Not found.');
    return true;
  }

  return { route, characterBible, config: () => ({ model: CARD_MODEL, visionModel: CARD_VISION_MODEL, audiences: CARD_AUDIENCES, archetypes: ARCHETYPES, slotRoles: SLOT_ROLES, playTypes: PLAY_TYPES, arcStages: ARC_IDS, foundationFields: FOUNDATION_FIELDS.map(([id, label]) => ({ id, label })), maxCards: MAX_CARDS, maxSlots: MAX_SLOTS }) };
}
