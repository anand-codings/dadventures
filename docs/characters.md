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
