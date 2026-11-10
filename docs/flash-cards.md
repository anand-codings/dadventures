# Flash Cards (templates from your own cards, then sets and story series)

A fourth page (**Flash Cards** in the top nav, `/cards.html`, code in `src/cards.js` + `public/cards.js`) turns existing cards
into reusable templates and makes new cards, and whole series of them, in the same family. Three tabs, left to right:

1. **Library** — every image in the media folder and Studio history (the same sources as Print Sheets). **Analyze** sends a
   ≤1536 px copy of a card to the vision model (`CARD_VISION_MODEL`), which records its format (profile, process, life cycle,
   system overview, letter card, concept, activity, reference sheet, story), a subject-neutral layout summary, every region in
   reading order with its position, verbatim text and picture, the art style (medium, palette, lettering, background, panels,
   mood), and flags brand/licensed content and possible text problems. Click **details** on a card to read its analysis.
   **✨ Sort my cards into template families** groups analyzed cards that share a structure and a look.
2. **Templates** — select one or more analyzed cards (or a suggested family) and **make a template**. The writer model
   (`CARD_MODEL`) sees the analyses and the primary card itself and writes a style guide, a top-to-bottom layout guide, title /
   main-picture / writing rules, the closing-line and source-line patterns, and the **content slots** a new card fills in
   (label, position, heading / content / picture guidance, word limit). Everything is editable and autosaves. One example is the
   **reference card**: it is sent to the image model with every new card so the layout and look match (click another example to
   switch). Brand logos and licensed characters are left out of templates. A built-in **Comic story card** template (four
   numbered panels with captions and speech bubbles, a "Did you know?" box and a next-card teaser) covers story layouts.
3. **Series** — choose a template, optionally a **Look** (borrow another template's art style, e.g. the comic layout painted
   like your wildlife cards), and describe the series:
   - **Set**: a collection where each card stands alone (list topics, or let the planner choose them).
   - **Story**: cards read in order like a comic or a little book — one continuing story with a recurring cast, each card one
     scene that also teaches something and ends on a hook for the next.

   The stepper runs **Plan** (title, cast, a topic and angle per card) → **Write** (every slot of every card: heading, text and
   a picture brief, within the slot's word limit; audience presets from "like the template" to 1–3 / 3–5 / 5–8 / 8–12) →
   **Pictures** (one image per card with all text lettered in; sequential, stoppable, cost estimated from history) → **Print**.
   Cards can be edited, rewritten with an instruction, reordered, added and removed; re-illustrating keeps every version.
   Consistency comes from three things, each a checkbox under *Picture settings*: the template's reference card, the first
   finished card of the series (sent with every later card), and Studio characters linked to cast members. A small
   "Series · 3 of 8" badge keeps printed cards in order. **⬆ Upscale ×4 for print** runs Real-ESRGAN on the finished cards and
   **Send to Print Sheets** opens a Tabloid 2 × 2 sheet with the series (upscaled copies when they exist).

**Stories as one narrative.** For a Story the planner first writes a **story spine** (once upon a time / until one day /
because of that / until finally / ever since): one want set up on card 1, each card caused by the one before, a low point,
and a payoff of something planted at the start. Every card also gets a **read-aloud narration** that continues from the
previous card (not printed on the front; **⬇ Read-aloud script** exports all of them as Markdown). To keep young children
engaged each story card has its own **setting and colour palette**, a **play prompt** (find, count, move, sound, guess), the
series **refrain** on its bottom ribbon and a tiny **hidden friend** to spot. The built-in **Toddler story — mixed layouts**
template lets the planner pick a layout per card (full-page splash, two, three or four panels), never the same twice in a row.

**Stories that add up.** Three things keep a story and its pictures consistent. (1) A **continuity reader** goes through the
plan before and after the story editor, and through the finished script, asking "but why?": the obvious way out that nothing
closes, a helper doing what the hero just failed at, someone turning up by coincidence, a character in two places, words that
disagree with the picture briefs. What is still open is listed in the story box, each finding with **Rewrite these cards to
fix it**; **🔎 Check the story adds up** re-runs it at any time. (2) Every story card has a **state**: where everyone and
everything is at the end of that card (who is where and who cannot be seen, who holds what, what is blocked or open). It is
planned with the story, editable on the card, sent with every picture and given to the proofreader. (3) Every story panel has
a full **picture brief** (where, who is where, what each is doing, the state of the important things, camera) and a list of
**who is drawn in it**; everyone else is named as not in the picture. A proofread picture that shows a character where the
state says it cannot be (outside when it is trapped inside) fails, however small. Stories written before this get their state
and panel lists read off the script the first time a card is proofread or drawn.

**Keeping pictures on the story.** The series reference sent with each picture is the nearest finished card in the same place
whose picture passed proofreading (not always the first card, whose cast and props leaked into later pictures). Each place can
carry **fixtures** — the objects the plot depends on, in the state the story first finds them — which are painted into its
reference picture; **↻ Repaint** on a place thumbnail paints it again. Cards that must show someone trapped or hidden are
planned as one picture (two panels at most) with a single way of looking inside. The hidden friend is assigned to one named
panel per card, and the refrain gives way to a fitting variation on cards where its promise is visibly not happening. When the
proofreader fails a picture because its brief was too thin, the brief is filled in and the card redrawn automatically (up to
three pictures per card; turn off *fill in the brief and redraw without asking* to decide each time). Draft sketches are
proofread too, for who is where only. **📖 Read the story back from the pictures** shows every finished picture to a reader who
has not seen the script, and lists the cards where the pictures tell a different story from the words.

**Checking and finishing a story.** With *Proofread every card* on (Picture settings), each new picture is read by a vision
model against its script: every lettered word, who is in each panel, the hidden friend. Story-breaking problems trigger one
automatic redraw; anything still wrong is shown on the card with ⚠ and a *Redraw fixing these* button, and small
discrepancies are kept as notes. **✏️ Draft storyboard** sketches every card at low quality with no reference images (a few
cents each) so the story can be read through pictures before the real ones are drawn. **🏞 Place references** paints one
picture per place and sends it with every card set there; **🎨 Cover & chapter cards** draws a front cover and a title card
per chapter (included when sending to Print Sheets and shown in Story Books). After writing, a copy-edit pass keeps captions
to nine words and one name per character; **✂️ Tidy the text** re-runs it. *Words on story cards → Story on the card* prints a
short story paragraph under the pictures instead of captions and the play box.

**Storyboard.** After *Draft storyboard*, the series opens in the **Storyboard** view (also under the *Cards | Storyboard*
switch): every card as a tile with its sketch and captions. Drag a tile onto another to move it, ✕ to cut it, or type a
change and press ✎ to rewrite that card and sketch it again. The bar at the bottom shows what the final pictures will cost
(cards × the average price of pictures already drawn at these settings) and holds **Approve and draw the final pictures**.

**When the picture is right to redraw and when the script is at fault.** If the proofreader flags a picture, a second pass
decides whether the illustrator ignored the script or the script never clearly asked for the missing thing. In the second
case no automatic redraw is spent; the card shows a proposed picture description to *Accept and redraw*, *Accept* or
*Dismiss*.

**Changed since the picture.** Every picture remembers the words lettered on it and its picture description. Editing a
card afterwards (by hand, with *Tidy the text*, or by moving it so its badge number changes) marks it *changed* with the
old and new words, and **↻ Redraw changed cards** redraws all of them.

**Whole-book check.** *🔎 Check the whole book* shows every finished picture to a vision model together and lists what
drifts between cards: a character's colour or size, an object that vanishes or reappears, a place that changes. Each item
has a *Redraw card N to match* button.

**Narration.** *🔊 Record the narration* (story box) speaks each card's read-aloud text as its own mp3 track, plus a
title track, with chapters announced; pick the voice next to the button. Tracks are re-recorded only when their words or
the voice change. Each card gets a player, and *⬇ Audio tracks (.zip)* downloads the numbered tracks with a playlist, ready
to upload to a Yoto Make Your Own card. Files live in `output/cards/audio/<series id>/`.

**Card backs.** *🂠 Card backs* typesets a reverse side for the cover and every card (number, chapter, the read-aloud
text, the play prompt, the note for grown-ups) as 2048 × 3072 images under `output/cards/backs/<series id>/`. It uses
headless Google Chrome (set `CHROME_BIN` if it is installed elsewhere), costs nothing, and re-typesets only backs whose
text changed. *Send to Print Sheets* then makes a double-sided sheet with each back behind its card.

**Stories for ages 1–3.** With the audience set to *1–3*, a story follows toddler rules instead of a shortened version of
the older form: one everyday problem with one failed try, two or three characters, only one or two big pictures per card,
captions of at most six words on a repeating sentence pattern, play prompts a toddler can do (point, say, wave), and no
chapters. Narration recorded here also plays in Story Books → Read (*▶ Play the story*).

**Continuing an earlier story.** In the brief, *Continue an earlier story* selects that story's studio characters, look
and picture settings, and gives the planner its world, cast and places. Places that reappear keep their reference
paintings, so nothing is painted twice.

Always read a finished card against its text before printing: image models occasionally misspell or drop a word. Card pictures
are normal History records tagged `flash-card`, `<series-slug>`, `card-N`. Data lives under `output/cards/`: `library/`
(one analysis per image), `templates/`, `series/`, `refs/` (downscaled reference copies) and `groups.json`.

---
[← All guides](README.md) · [Project README](../README.md)
