# Print Sheets (N-up layouts for FedEx Office)

The **Print Sheets** page (`/sheets.html`, code in `src/sheets.js` + `public/sheets.js` + `public/sheets-layout.js`,
styles in `public/sheets.css`) tiles several images onto one printable page so you can print four or six posters per sheet,
cut them apart and laminate each one. It is one workspace that reads in work order: **1 Pictures**, **2 Sheet**, **3 Setup**.
The sheet's name is the page title (click it to rename), and **Build PDF** sits in the header next to what it will produce.

- **1 Pictures**: images from the media folder (`media/` in the app folder, five levels deep; change it with `PRINT_ROOT`)
  and from Studio history, with a filter box and a chip per folder. Click an image to add it (again for another piece);
  the number on a thumbnail is how many copies are on the sheet.
- **2 Sheet**: one page at a time, as large as the window allows, with a pager (and **Fronts / Backs** when double-sided).
  Next to it is the print check: the size each piece prints at, the picture detail in DPI, and the paper needed.
  **On this sheet** lists the pieces in print order, grouped by page. Click a piece for its details: copies, move
  earlier or later, remove. Drops on a slot only ever change that slot; a piece with several copies is split automatically.
- **3 Setup**:
  - **Paper**: Letter, Legal, Tabloid 11×17, 12×18, 13×19, 18×24 and 24×36 posters, or a custom size; portrait or landscape.
  - **Per page**: *Auto* picks the grid that fits every image on the fewest pages at the largest size, or choose
    2×2, 2×3, 3×2… or a custom grid.
  - **Spacing**: *Laminate* sets a ¼ in margin and a ½ in gap, so every piece keeps a sealed border after cutting.
    *Cut only* sets a gap of 0 and a ⅜ in margin, so each cut line is shared and the crop marks at the page edges print.
    Typing your own **margin** or **gap** switches to *Custom*.
  - **Options**: **crop marks** in the gaps and at the page edges on every cut line, and **double-sided**.
  - **Defaults are set for the best print**: double-sided on, whole image (no cropping), full resolution and lossless PNG.
    Switch to JPEG or a DPI cap under *More options* if the PDF is too big for the print shop's upload limit.
  - **More options**: fit mode (keep the whole image, or fill the cell and crop), image detail, file size,
    **pack edge to edge** (cells take the pieces' own shape and the block is centred, so with a 0 gap every cut line is
    shared: one guillotine pass per line, no scrap strips), a **hairline border**, and a **sheet-name label** in the bottom margin.
- **Arrange by dragging**: drag pieces in *On this sheet* to reorder, drag a piece onto another slot in the preview to swap
  them, drag picker images onto a slot (replace), onto an empty slot or anywhere else on a page (append), or between pieces
  in the list (insert). Drag a front piece onto a back slot (or a back box in the list, or *same back for all*) to use its image
  as a back; drag a back onto another back to copy it. Files dragged in from Finder are matched by name to images in the media folder.
- **Double-sided**: turn it on and give any piece a back image (drop it on the piece's **back** box, on the
  back page in the preview, or click the box and pick; *same back for all* sets every piece at once). Every front page is
  followed by a back page whose slots are mirrored for the printer's flip (long edge by default, short edge optional), and each
  back image is drawn into the exact mirrored rectangle of its front, so the cuts line up; a back with a different shape is
  letterboxed inside that rectangle by default (white bars, nothing lost) or cropped to fill it with the *A back with a different shape* option.
  Pieces without a back print blank, and the page says how many there are. At the print shop ask for double-sided, flip on the long edge.
- The **Sheets** menu in the header starts a new sheet, saves the current one without building, opens a saved sheet, or
  deletes it. The chip beside it shows whether the sheet is saved.
- The **preview** is drawn from the same layout math as the PDF, with slot numbers. The page warns when an image would
  print below 150 DPI.
- **Build PDF** writes `output/sheets/<id>-<timestamp>.pdf` (the previous build of the same sheet is replaced), with every
  page at its exact physical size. PNGs are embedded losslessly and JPEGs pass through untouched; images are downscaled to
  the **Image detail** cap (300/400/600 DPI or full resolution, via macOS `sips`, cached under `output/sheets/.cache`) so an
  upscaled 4096 px poster does not bloat the file. Sheets are saved as `output/sheets/<id>.json` and can be reopened and rebuilt.
- At FedEx, upload the PDF and print at **100% / actual size** (not "fit to page"), on the paper size you chose.

---
[← All guides](README.md) · [Project README](../README.md)
