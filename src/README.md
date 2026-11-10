# src — the server

A single Node process with no npm dependencies. `npm start` runs `src/server.js`, which serves the pages in
[`../public`](../public/README.md) and the JSON API under `/api`.

| File | What it owns | Routes | Data under `output/` |
|---|---|---|---|
| `server.js` | Entry point: `.env` loading, config, the router, static files, image generation, history, trash, prompt library, characters, upscaling, and the handlers for the Costs page | `/api/*` not listed below (including `/api/ai/calls`), and the files under `/output/`, `/trash/`, `/thumbs/`, `/characters/`, `/sheet-src/` | images and sidecars, `history.json`, `prompts.json`, `prompt-log.jsonl`, `characters/`, `trash/`, `.thumbs/` |
| `ai.js` | The AI gateway. Every model call goes through it (OpenAI text and images, fal.ai, local Real-ESRGAN) and is logged with tokens, duration and cost. The `PRICING` table is at the top | none (read through `server.js`) | `ai-calls.jsonl`, `ai-calls/` |
| `books.js` | Story Books: brief → outline → page scripts → illustrations | `/api/books` | `books/` |
| `cards.js` | Flash Cards: card analysis → templates → sets and story series | `/api/cards` | `cards/` |
| `sheets.js` | Print Sheets: image picker, N-up layout and a hand-written PDF writer | `/api/sheets` | `sheets/` |

## How the pieces fit

- `books.js`, `cards.js` and `sheets.js` each export a `create…(deps)` factory. `server.js` builds them at the bottom
  of the file and passes in what they need (`handleGenerate`, `readHistory`, `send`, `readJson`, the `ai` gateway …),
  so the feature modules never import `server.js`.
- Each feature module has a `route(req, res, url)` function that returns `true` when it handled the request.
- `sheets.js` imports the layout math from `../public/sheets-layout.js`, the same file the browser preview uses, so the
  preview and the PDF cannot drift apart.
- Paths are resolved from the app folder (the parent of `src/`): `.env`, `public/` and the default `output/`.

## Rules worth keeping

- **Never call a provider directly.** Use `ai.text(...)`, `ai.image(...)`, `ai.falUpscale(...)` or
  `ai.localUpscale(...)` with a `feature` name and `refs`, so the call lands in the ledger and on the Costs page. Add
  new feature names to `FEATURES` in `public/costs.js`.
- **Keep it dependency-free.** PNG/JPEG/WebP metadata, the PDF writer and `.env` parsing are all written against
  Node's standard library.
- **Resolve user-supplied paths through `serveFile` or `resolveInSource`.** Both refuse anything outside their folder.
- **Leave `checkRequestSource` in front of the router.** The app has no login; that check is what stops other
  websites from driving it. See [Security](../README.md#security).

Feature behaviour is described in the [guides](../docs/README.md).
