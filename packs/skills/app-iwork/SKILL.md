---
name: app-iwork
description: Numbers, Pages, Keynote and Preview: read/write cells, read text and slides, add slides, export PDF, convert images.
source: you
uses: 0
category: Mac Apps
---

Numbers (`app {app: "Numbers"}`):
1. `documents`: open documents with their sheets and tables (rows × columns).
2. `read {sheet?, table?, range?: "A1:D20"}`: values as a grid with column letters and row numbers.
3. `write {sheet?, table?, cells: {"B2": 10}}` or `{start: "A2", values: [[…], […]]}`. "=SUM(B2:B9)" becomes a formula. The table must already be big enough: add rows/columns with computer use (menu Table > Add Row Below) first.
4. Read back the cells you wrote. `save`, `export_pdf {to}`.

Pages: `documents`, `read`, `export_pdf`, `save`. To add text: computer use: click where it goes (cmd+down arrow for the end), `paste_text {text}`, then `read` to verify.

Keynote: `documents`, `read` (titles, bodies, presenter notes), `layouts`, `add_slide {title, body, notes, layout?}` (layout names from layouts; default is like the last slide), `export_pdf`, `save`. Images and builds: computer use (drag a file from Finder or menu Insert > Choose…).

Preview (`app {app: "Preview"}`): `open`, `documents`, `export {path, to, format?, max_size?}` converts images (jpeg/png/heic/tiff/gif/bmp/pdf) or a PDF's first page without clicking, `info` for pixel size. Signing, annotating, Export dialog options (Reduce File Size): computer use, menu File > Export….

General: an unsaved new document's `save` opens a Save sheet: type the name, cmd+shift+g to paste a folder path, Return. Exporting over an existing file asks first.
