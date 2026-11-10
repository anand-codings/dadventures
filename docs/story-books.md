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

Illustrations are normal History records titled `<book> — page N` and tagged `book`, `<book-slug>`, `page-N`. **📖 Preview**
shows the book as pages (and prints one page per sheet); **⬇ Manuscript** exports Markdown with text, briefs and image paths.
Books are stored as `output/books/<id>.json`; deleting a book keeps its images. Outline, script and illustration events are
written to `prompt-log.jsonl`.

---
[← All guides](README.md) · [Project README](../README.md)
