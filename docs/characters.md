# Character consistency

Built on OpenAI's image-prompting guidance (reusable character reference, repeat the defining details, assign each
input image a numbered role, separate changes from constraints, "do not redesign the character").

**Characters** live under `output/characters/<id>/`. Each has a name, structured identity fields (appearance, outfit,
color palette, art style, personality) and up to 16 reference images, each with a role: identity (full view),
face close-up, reference sheet, or style-only. The first image is the primary anchor and is sent first.

- **Create** one from any generated image ("Use as character reference" in the detail view — the identity fields are
  filled automatically by a vision model) or from your own photos (**+ new character**). **✨ Auto-describe** re-reads
  the references at any time; edit whatever is wrong.
- **🧍 Generate reference sheet** makes a front / three-quarter / side turnaround plus three expressions on a plain white
  background, adds it as a `sheet` reference, and files it in history (paid generation, ≈ $0.06–0.25).
- Select character chips before generating. The app switches to the Images **edits** endpoint, attaches the references
  in order, and appends a block the UI previews live: numbered image roles, a per-character identity paragraph, and
  constraints (new pose/framing/background, no text from references, keep multiple characters distinct).
- **Enhance** becomes character-aware: it refers to characters by name without redescribing them and writes the prompt
  as labeled `Scene / Composition / Style / Constraints` sections.
- Records generated with characters show a purple **👤** badge and chips naming the characters used. Add approved
  outputs back as references to tighten consistency over a series, and keep the same model and quality within a series.

---
[← All guides](README.md) · [Project README](../README.md)

## Groups: crews who share stories

Groups have their own page, **Groups** in the sidebar under The Crew (`/groups.html`; the Characters page links to it with **👥 Groups**). Each group opens as its own page with its own link (`/groups.html?group=<id>`). A group is a crew of characters who belong together (a family, a reef gang, a classroom), and it builds up a shared universe of stories:

- **Who is in it**, **what the group is about**, **how they relate to each other** and **running storylines**: threads that carry across stories (Ollie is slowly getting less scared of the dark; Baby Seahorse is looking for her family).
- **Their stories together, in order**: every Flash Cards story and Story Book with at least two members in it, oldest first, linked to the story.
- **Suggested groups**: characters who have already been in stories together but are not grouped yet. Click one to make it a group.

When a new story (Flash Cards or Story Books) has at least two members of a group, the writer receives the group's notes, its running storylines and the titles and loglines of its earlier stories. It is asked to add a new chapter that keeps relationships consistent and moves a storyline forward, rather than retelling an earlier plot. In Flash Cards, the 👥 group chip in the character picker selects the whole crew in one click.

Groups are stored in `output/characters/groups.json`. The story timeline is not stored; it is worked out each time from the series and books on disk.
