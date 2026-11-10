# Links (every view and setting has its own URL)

The address bar always describes what is on screen, so any view can be bookmarked, pasted into a note or opened in another
tab. Back and Forward step through images, tabs, books, series and sheets. `public/url-state.js` is the shared helper.

| Page | Example | Parameters |
|---|---|---|
| Images | `/?image=<id>&quality=low&size=2048x1152&q=ocean&fav=1` | `image`, `linked`, `chars`, `character` (`<id>` or `new`: the editor); generation settings `model`, `quality`, `size` (a preset or `WxH`), `format`, `bg`, `n`, `tags`; History filters `q`, `fmodel`, `fsize`, `sort`, `fav`, `upscaled`, `trash`; `upscaler`, `scale` |
| Story Books | `/books.html?book=<id>&view=read&page=3` | `book` (`<id>` or `new`), `view` (`shelf` or `read`), `tab` (`outline`, `story` or `setup`), `page` (`cover` or a number) |
| Flash Cards | `/cards.html?tab=series&series=<id>&card=4` | `tab` (`library`, `templates`, `series`), `series`, `template`, `card`; Library `filter`, `q`, `detail` |
| Print Sheets | `/sheets.html?sheet=<id>&grid=3x3&marks=0` | `sheet`; layout `page`, `orientation`, `w`, `h`, `grid`, `cols`, `rows`, `margin`, `gutter`, `fit`, `dpi`, `encode`, `marks`, `pack`, `outline`, `label`, `duplex`, `flip`, `backfit`; picker `q`, `folder` |

- A page address with no parameters resumes where this browser left off (last book, last series and tab, the sheet draft,
  remembered generation settings). A link with parameters is complete on its own: a setting it does not mention is at the
  app default (on Print Sheets: at the saved sheet's value), so the same link shows the same thing everywhere.
- Settings stored with a book, a series or a saved sheet (brief, picture settings, pieces) travel with its id. Text being
  typed (the prompt, an unsaved brief) and unsaved sheet pieces stay in the browser and are not part of the link.

---
[← All guides](README.md) · [Project README](../README.md)
