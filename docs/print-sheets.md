# Print Sheets (N-up layouts for FedEx Office)

A third page (**Print Sheets** in the top nav, `/sheets.html`, code in `src/sheets.js` + `public/sheets.js` +
`public/sheets-layout.js`) tiles several images onto one printable page so you can print four or six posters per sheet,
cut them apart and laminate each one.

- **Pick images** from the media folder (`media/` in the app folder, five levels deep; change it with `PRINT_ROOT`) and from
  Studio history. The picker shows thumbnails and pixel sizes; click an image to add it (again for another piece), or
  set the number of copies per row in the **On the sheet** list. Drops on a slot only ever change that slot; a row with several
  copies is split automatically.
- **Page**: Letter, Legal, Tabloid 11×17, 12×18, 13×19, 18×24 and 24×36 posters, or a custom size; portrait or landscape.
- **Arrangement**: *Auto* picks the grid that fits every image on the fewest pages at the largest size, or choose
  2×2, 2×3, 3×2… or a custom grid. **Printer margin** (¼ in for FedEx) and **gap between pieces** (keep ≥ ½ in when laminating,
  so every piece keeps a sealed border after cutting). Fit mode keeps the whole image or fills the cell and crops.
  **Pack pieces edge to edge** sizes the cells to the pieces' own shape and centres the block, so with a 0 gap every cut line is
  shared (one guillotine pass per line, no scrap strips). Optional **crop marks** in the gaps and at the page edges on every cut line,
  a **hairline border**, and a **sheet-name label** in the bottom margin.
- **Arrange by dragging**: drag rows in the *On the sheet* list to reorder, drag a piece onto another slot in the preview to swap
  them, drag picker images onto a slot (replace), onto an empty slot or anywhere else on a page (append), onto the list (insert)
  or onto the end zone. Drag a front piece onto a back slot (or a back box in the list, or *same back for all*) to use its image
  as a back; drag a back onto another back to copy it. Files dragged in from Finder are matched by name to images in the media folder.
- **Double-sided**: turn on *Print on both sides* and give any piece a back image (drop it on the piece's **back** box, on the
  back page in the preview, or click the box and pick; *same back for all* sets every piece at once). Every front page is
  followed by a back page whose slots are mirrored for the printer's flip (long edge by default, short edge optional), and each
  back image is drawn into the exact mirrored rectangle of its front, so the cuts line up; a back with a different shape is
  letterboxed inside that rectangle by default (white bars, nothing lost) or cropped to fill it with the *Back with a different shape* option.
  Pieces without a back print blank. At FedEx ask for double-sided, flip on the long edge.
- The **preview** is drawn from the same layout math as the PDF, page by page, with slot numbers. The summary shows the cell
  size, printed image size, effective DPI and page count, and warns when an image would print below 150 DPI.
- **Build PDF** writes `output/sheets/<id>-<timestamp>.pdf` (the previous build of the same sheet is replaced), with every
  page at its exact physical size. PNGs are embedded losslessly and JPEGs pass through untouched; images are downscaled to
  the **Image detail** cap (300/400/600 DPI or full resolution, via macOS `sips`, cached under `output/sheets/.cache`) so an
  upscaled 4096 px poster does not bloat the file. Sheets are saved as `output/sheets/<id>.json` and can be reopened and rebuilt.
- At FedEx, upload the PDF and print at **100% / actual size** (not "fit to page"), on the paper size you chose.

---
[← All guides](README.md) · [Project README](../README.md)
