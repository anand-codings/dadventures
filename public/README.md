# public — the browser UI

Plain HTML, CSS and JavaScript served as-is by [`../src/server.js`](../src/README.md). There is no framework, bundler
or build step: edit a file and reload the page.

| Page | Files | Guide |
|---|---|---|
| Images (`/`) | `index.html`, `app.js` | [Generating and history](../docs/generating-and-history.md) |
| Characters (`/characters.html`) | `characters.html`, `characters.js` (editing happens in the editor on the Images page) | [Character consistency](../docs/characters.md) |
| Story Books (`/books.html`) | `books.html`, `books.js` | [Story Books](../docs/story-books.md) |
| Flash Cards (`/cards.html`) | `cards.html`, `cards.js` | [Flash Cards](../docs/flash-cards.md) |
| Print Sheets (`/sheets.html`) | `sheets.html`, `sheets.js`, `sheets-layout.js`, `sheets.css` | [Print Sheets](../docs/print-sheets.md) |
| Costs (`/costs.html`) | `costs.html`, `costs.js`, `costs.css` | [AI calls and costs](../docs/costs.md) |

Shared by every page:

- `styles.css` — the one stylesheet (Costs adds `costs.css` on top, Print Sheets adds `sheets.css`).
- `theme.css`, `shell.js`, `fonts/` — the Dadventures look: `theme.css` re-points the colour variables and fonts, `shell.js`
  rebuilds each page's top bar into the sidebar and header bar. Remove their two tags from the six pages to get the plain
  dark top-bar layout back.
- `url-state.js` — keeps what is on screen in the query string, so every view has its own link
  ([parameters](../docs/links.md)). Pages call `urlState.set()` on every state change and read it back on load and on
  Back/Forward.

## Conventions

- Each page is one HTML file plus one script of the same name. The top navigation is repeated in every HTML file, so a
  new page means adding its link to all of them.
- `sheets-layout.js` is an ES module imported by both `sheets.js` here and `src/sheets.js` on the server. Keep it free
  of DOM and Node APIs.
- Everything in this folder is public to anyone who can reach the server. Keys and prompts for the models stay in `src/`.
- When you add a kind of model call on the server, add its name to `FEATURES` in `costs.js` so the Costs page labels it.
