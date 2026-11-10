# Generating and history

## Generating

- **2048×2048 by default**, plus 2K portrait/landscape, 8×10 (4:5), 4K, 1K drafts, or any custom size
  (multiples of 16, aspect between 1:3 and 3:1, 0.66–8.3 MP). Invalid sizes are rejected before the API call.
- **Prompt enhancement**: the Enhance button rewrites your prompt with `gpt-5.4-mini` (configurable) under
  strict preserve-everything rules. The enhanced prompt is editable, and you choose whether to generate with
  the original or the enhanced version.
- Quality up to `xhigh` / `max`, PNG / JPEG / WebP, transparent backgrounds, 1–4 images per run,
  cost estimate per run from the API's `usage` at GPT Image 2.6 token rates.

## History and preservation

Everything lives under `output/` (configurable with `OUTPUT_DIR`):

| Path | What |
|---|---|
| `<timestamp>-<slug>.png` | the image, with the prompt embedded in its own metadata (PNG iTXt, JPEG COM, WebP XMP) |
| `<timestamp>-<slug>.json` | sidecar: original / enhanced / final prompt, guidance, settings, usage, cost, title, tags, notes, lineage |
| `history.json` | the index, rebuilt from sidecars automatically at startup or with **Reindex** |
| `prompt-log.jsonl` | append-only log of every enhance, generation, failed generation, edit, trash, restore, and purge |
| `ai-calls.jsonl` | the AI call ledger: one line per model call with who asked, model, tokens, duration and cost |
| `ai-calls/<id>.json` | the full request and reply of each call (inline images are replaced by a placeholder) |
| `prompts.json` | the prompt library |
| `trash/` | trashed images and sidecars (restore or delete permanently from the Trash view) |
| `.thumbs/` | 512 px thumbnails (macOS `sips`; falls back to the full image elsewhere) |

In the UI:

- **Title, tags, notes, favorite** on every image, written through to the sidecar.
- **Reuse & link** restores prompts and settings and links the next generation to its parent;
  the detail view shows "based on" and related images (parent, siblings, variants).
- **Search, filter by model/size, favorites, sort, trash view, export CSV/JSON.**
- **Prompt library** to save and reload prompts independently of images.
- **Reveal in Finder** on macOS. Drafts of the prompt fields auto-save in the browser.
- If the index is lost or an image file is moved away, **Reindex** recovers records from sidecars and
  flags missing files without losing their prompts.

---
[← All guides](README.md) · [Project README](../README.md)
