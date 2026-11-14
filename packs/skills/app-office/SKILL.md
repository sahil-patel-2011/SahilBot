---
name: app-office
description: Microsoft Excel, Word and PowerPoint through their AppleScript dictionaries: read/write cells, document text, slides, export PDF; computer use for formatting.
source: you
uses: 0
category: Mac Apps
---

Making a new file from scratch? Use create_document (docx/xlsx/pptx) instead. Use the app adapters when the user has the document open or wants it changed in place.

Excel (`app {app: "Microsoft Excel"}`):
1. `workbooks`: open workbooks, sheets and their used ranges.
2. `read {doc?, sheet?, range?: "A1:F40"}` (default: the used range; at most 5000 cells per read).
3. `write {sheet?, cells: {"B2": 42, "C2": "=B2*1.2"}}` or `{start: "A1", values: [["Name", "Total"], ["Ann", 3]]}`. Values go in as if typed: numbers, dates and formulas are parsed.
4. Read the range back to check formula results. `save`; `export_pdf {to}` (Office may show "Grant access" for the folder: the user clicks it).

Word (`app {app: "Microsoft Word"}`): `documents`, `read`, `append_text {text}` (start with "\n" for a new paragraph), `export_pdf`, `save`. To insert in the middle: computer use, click the spot (or cmd+f to find the anchor text, Escape), then `paste_text`.

PowerPoint (`app {app: "Microsoft PowerPoint"}`): `presentations`, `read`, `add_slide {title, body}` (one bullet per line), `export_pdf`, `save`.

Formatting, charts, tables, styles (computer use):
- Ribbon tabs and buttons are in `computer ui {app: "Microsoft Excel", query: "Bold"}`; or the menu bar: `menu {path: "Format > Cells…"}`.
- Excel: cmd+shift+L filters, cmd+t table, ctrl+cmd+v paste special, F2 edit cell, cmd+arrow jump to edge.
- Word: cmd+b/i/u, cmd+option+1/2/3 headings, cmd+k link.
- Verify each change with ui or a screenshot.

Don'ts: never "Don't Save" or close without saving unless asked; Protected View and macro prompts are the user's call.
