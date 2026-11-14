# Story Books

A separate page (**Story Books** in the top nav, `/books.html`, code in `src/books.js` + `public/books.js`) for drafting short
illustrated children's books. A stepper at the top (Outline → Page text → Picture prompts → Pictures → Read) always shows where the book is,
and one primary button runs the next step (⌘/Ctrl + Enter). Writing streams live: you see which page is being written and
the sentence in progress. **↶ Undo** restores whatever the writer last replaced (re-drafts, rewrites, removed pages; last 10
kept), and pictures made since then stay attached. Stuck for an idea? **✨ Suggest ideas** pitches four premises from the
audience, theme and characters (or develops your rough line). The page strip jumps to any page and shows what's written and
illustrated.

1. **Outline** — from a story idea, audience (0–3 board book, 3–5 / 5–8 picture book, 6–9 early reader), page count (4–32),
   tone, theme, setting and style, the writer model (`BOOK_MODEL`) returns a title, logline, theme, a **style guide** shared by
   every illustration, the cast with visual descriptions, a cover brief and a full plan. **✨ Fill in the blank details**
   completes the brief first (typed details are kept); anything still blank is decided by the outline and written back.
   The plan is the **Outline** tab: a five-line **storyline** (want, obstacle, turning point, resolution, what changes), a
   **world** note (places and recurring objects), and for every page its beat, **arc stage** (opening → want/problem → rising
   action → turning point → resolution → ending, drawn as a bar chart of the story), purpose, characters, setting, feeling and
   what carries over from earlier pages. Blank notes are outlined in amber and **✨ Fill in the blank details** completes
   them without changing the story. The writer gets all of it for step 2, and every picture prompt carries the page's
   setting, mood and carry-over plus the world note, since the image model sees one page at a time. Studio characters selected in the
   brief join the cast with their exact names and are linked automatically. Add revision instructions and re-draft at any time.
2. **Page scripts** — writes the on-page text (held to the audience's word range, shown live per page) and an illustration brief
   for every page, with the characters present and where the text will sit. Each page has one-click rewrites (Shorter,
   Simpler words, Funnier, Rhyme, More feeling, Add dialogue) or a free-text instruction; the rest stays consistent.
   Everything is editable and autosaves.
3. **Picture prompts** — before anything is drawn, the image prompt for every page is written out on its own tab so you can
   read it, edit it, or rewrite it from the page as it is now. Writing prompts is free and instant (the app composes them from the
   page's brief, the style guide, the story world and the cast; no model call). A prompt you changed is marked "Edited by you" and
   is kept when you write the rest; a page whose text or brief changed afterwards is marked out of date. Each picture is then drawn
   from exactly the prompt shown. Books made before this step existed still work: a page with no stored prompt is drawn from the
   composed one, as before.
4. **Illustrate** — per page or all missing pages (sequential, stoppable, cost estimated beforehand from your history). Prompts combine the brief,
   the style guide, unlinked cast descriptions and a calm area for the text (or the text itself if **Render page text inside the
   image** is on). Linked cast members go through the [character-reference pipeline](characters.md), so they stay on-model.
   **🎨 Design character** turns a text-only cast member into a studio character (one 1024² design on white), so later pages
   use it as a reference. Re-illustrating keeps every version; click a thumbnail to choose.

**Read-aloud craft and picture consistency.**
- **Refrain and device** are their own fields in the Outline tab (the outline proposes them; blank means none). The writer
  prints the refrain word for word; the editor restores accidental variations.
- Every page plans its **shot** (wide, medium, close-up), what the **eye lands on** first and, where it has one, a
  **page-turn hook** the next page answers. The row of letters under the story arc shows the rhythm of the shots and marks
  a third page in a row at the same distance.
- A **read-aloud editor** goes through the whole text after it is written (and on demand: **🎧 Read-aloud edit**,
  `POST /api/books/:id/edit`): word range, breath and rhythm, the refrain, page turns, words that only repeat the picture.
  It changes words, never the story; a change that moves a page further outside the word range is refused; what it changed
  is listed above the pages and ↶ Undo restores the text. A partial rewrite calls it only for pages that came back outside
  the range. Pages still outside the range are named next to the page count.
- **Reference pictures** (Pictures → Consistency, on by default): a book with a world sheet is drawn with the sheet and
  no neighbouring page, because the image model copies a same-place page's layout whatever the prompt says, and a run of
  pages in one place turns into one picture. A book without a world sheet is drawn with the nearest finished page
  set in the same place beside it (pages whose picture failed proofreading are skipped), or failing that the nearest
  finished page as a style reference. **☆ Use as style anchor** pins one page as the style for all the others.
  **🎨 Draw the world sheet** (Outline tab, `POST /api/books/:id/world-sheet`, one paid 1024² picture) draws the places and
  recurring objects of the world note without characters; it is then sent with every page. References are dropped, never
  the picture, when there is no room left after the character references.
- **Each fact once in the prompt**: when the picture brief already names the place the Setting line is left out, and the
  carry-over line is left out when the page has story facts. Briefs no longer repeat the art style or the look of recurring
  objects, and sentences about word counts or reading aloud are filtered out of the style line. Prompts stored before this
  change show as out of date until rewritten.
- The writer chooses **where the text sits** from the composition (the emptiest side) instead of defaulting to the bottom.

**Story consistency** (ported from Flash Cards). Every page also carries a **state**: where everyone and everything is at
the end of the page (who is where and who cannot be seen, who holds what, what is blocked or open, the light), carried forward
until a page changes it. The outline is written to five story-logic rules (the obvious way out is visibly closed, abilities
are honest, nobody arrives by coincidence, one of each device, whereabouts carry forward), then a **continuity reader**
goes through it for what does not add up; if it finds holes the outline is revised once and read again, and whatever is
still open is listed in the Outline tab with the smallest fix and a button that rewrites the named pages (or prefills the
re-draft box when they are not written yet). **🔎 Check the story adds up** (`POST /api/books/:id/logic`) re-reads the book as
it stands, including page text and illustration briefs. Illustration briefs are 60–110 words in a fixed order (place, who is
where, what each is doing and feeling, the state of every important object, camera) and must agree with the state; each
picture prompt adds the **story facts** (the previous page's state and this page's) and an explicit "In this picture / NOT in
this picture" list. After a picture is drawn a **proofreader** (a vision call, `POST /api/books/:id/pages/:pageId/check`)
compares it with the page: characters present or wrongly present, anyone drawn where the state says they cannot be, the key
object drawn in a state that undoes the problem, stray or wrong lettering, the cover title. A failing picture is redrawn
once with the mistakes listed (a second paid picture) and the attempt with fewer problems stays selected; the result shows
under the picture (✓ or ⚠ with **Redraw fixing these**). Switch it off with **Proofread** in Brief & settings
(`image.proof`). Books copied from Flash Cards skip both readers.

Illustrations are normal History records titled `<book> — page N` and tagged `book`, `<book-slug>`, `page-N`. **📖 Preview**
shows the book as pages (and prints one page per sheet); **⬇ Manuscript** exports Markdown with text, briefs and image paths.
**🖨 Print Sheets** lays the book out for double-sided printing and opens it in Print Sheets (flip on the long
edge; change paper and grid there). New books are drawn at 2176 × 2816, a quarter of a Letter sheet (4.25 × 5.5 in), so
four pages fill an 8.5 × 11 sheet with no margin and no gap; a book drawn in any other shape opens as Tabloid 2 × 2 with gaps: the cover prints on its own with a blank back, then each piece carries two pages back to
back (page 1 on the front with page 2 behind it, then 3 and 4, …), so the cut pieces stack and read like a book. Chapter title
pictures take their place in the reading order, an odd last page has a blank back, and the upscaled version of a picture is
used when there is one. Every page needs a picture first.
**Varied pictures.** Every story page gets its own camera set-up (wide from above, close-up on a face, low angle, from
behind a character, side view, bird's-eye…), chosen across the whole book: a planned shot is kept, strong feelings go close,
arriving somewhere new goes wide, and no set-up repeats within three pages. The camera sits right under the scene in the
prompt and outranks viewing rules in the world note; the story world is limited to the page's own place, and the reference
page is shown for rendering only, never for its framing. Redrawing a book in page order lets each page use a newly varied
neighbour as its reference.

**Catching look-alike pages before paying for them.**
- The **outline** is written to a rule of at most three pages in a row in one place with the same characters, and the
  Outline tab names any longer run under the shot row, with a button that puts the fix into the re-draft box.
- Each **picture brief is written for its page's camera**: the writer is given the camera set-up chosen for the page and
  stages the scene for it, changes the arrangement from the page before, and lists only the characters in the frame.
- **✏️ Draft pages** (Picture prompts tab, `POST /api/books/:id/pages/:pageId/draft`) draws every page without a picture
  as a small low-quality sketch, shown side by side on a sheet. A page whose prompt is unchanged since its draft is then
  painted with the draft beside it as the composition.
- **👀 Check for look-alike pages** (`POST /api/books/:id/similar`) shows each pair of neighbouring pages (drafts or
  pictures) to OpenAI's Decisions API (`gpt-6-luna`, a yes/no probability per pair, a fraction of a cent for a book)
  and marks the pairs that would read as the same picture.
- The **proofreader** also sees the page before: a picture that repeats its camera and arrangement fails and is redrawn
  once, as does one that shows a different number of something than the page states ("seven arms hold on").

**Page types.** *Brief & settings → Pictures → Page style*: **Classic picture book** (one picture and the story text per
page), **Mixed toddler pages** (full pictures and 2–4 panel scenes with tiny captions, a play box such as "Can you find…?",
and a line for grown-ups) or **Comic panels** (mostly panels with speech bubbles and a "Did you know?" fact box). With a
designed style, **🧩 Design the pages** has the AI choose each page's layout and write its captions, speech, panel pictures
and boxes from the story; each page's dropdown overrides its layout (Auto hands it back), and every caption and box can be
edited under the page. Only the captions and boxes are lettered into the picture; the full story text stays for reading
aloud. Books copied from Flash Cards bring each card's layout and boxes along, and keep pictures, designs and settings made
here when the story is refreshed.

Books are stored as `output/books/<id>.json`; deleting a book keeps its images. Outline, script and illustration events are
written to `prompt-log.jsonl`.

---
[← All guides](README.md) · [Project README](../README.md)
