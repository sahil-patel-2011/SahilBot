# Office documents

Three tools:
- `create_document` (always available) makes .docx, .pdf, .pptx and .xlsx from data and reviews the result.
- `review_document` (always available) checks any .docx/.xlsx/.pptx/.pdf and lists PASS/FAIL items with locations.
- `office` (`find_tools("office")`) works on existing files: spreadsheets, PDF forms and pages, batch file jobs, receipts, meeting notes.

`file_read` reads every format back as text.

## The loop for every document
1. Read the matching skill: office-word, office-excel, office-powerpoint, office-pdf, office-reports, office-meetings, office-batch-files.
2. Create it. The result ends with a review.
3. Fix every FAIL (rebuild at the same path; a backup is kept), then `review_document` again. At most 2 rounds.
4. Present: the path and a short summary. Mention warnings you chose not to fix only if they matter.

## Word (.docx) and PDF
Markdown in, real Word styles out (Title, Subtitle, Heading 1-4, Caption, Quote, List, Table Text).
- `[TOC]` table of contents (automatic for 4+ sections; page numbers filled in), `<!-- pagebreak -->`, `<!-- landscape -->` / `<!-- portrait -->` sections.
- Tables: header row repeated on each page, banded rows, numbers right-aligned, a caption line `Table: …` right under it.
- Images `![alt](path "Caption")` from the workspace or attached folders, numbered "Figure N".
- Footnotes `text[^1]` + `[^1]: Source.`; `citations` adds a References list.
- Callouts `> [!NOTE]`, `> [!WARNING]`.
- Options: `template` memo | report | letter | meeting_notes | proposal with `fields`; `cover`, `toc`, `subtitle`, `author`, `header`, `footer`, `page_numbers` (default on), `orientation`, `page_size` letter|a4, `font` (default Arial), `accent`.
- Templates never add placeholder text: a field that isn't given is left out.

## PowerPoint (.pptx)
16:9, one theme (light/dark, accent, one font), slide numbers. Layouts: title, section, bullets, two_column, image_text, image, chart (native bar/column/line/area/pie/doughnut you can edit in PowerPoint), table, stats, quote, closing. Speaker notes per slide. Text never overflows: sizes are fitted, long bullets are shortened with the full text moved to the notes, and overfull slides or long tables continue on "(cont.)" slides.

## Excel (.xlsx)
Typed columns (text, number, integer, currency, percent, date, datetime, boolean) with number formats; formulas stored with computed results (Excel also recalculates on open); XLOOKUP rewritten to INDEX/MATCH for compatibility; totals row (plain =SUM, =AVERAGE… formulas); frozen header; filters; dropdown and number validation; conditional formats (thresholds, text, duplicates, blanks, top/bottom, data bars, color scales, custom formulas); a Summary sheet with live totals.

`office` actions for existing workbooks: `sheet_read` (values + formulas), `sheet_write` (cells, blocks, appended rows above the totals row, formats; styles kept; a backup in .foreman/backups; refuses files with charts/pivots/macros unless writing a copy), `sheet_summarize` (column statistics), `csv_to_xlsx`.

## PDF
`office`: `pdf_info`, `pdf_fields`, `pdf_fill` (new file; optional flatten; personal details ask the user first), `pdf_merge`, `pdf_split`, `pdf_extract`, `pdf_rotate`, `pdf_stamp`, `pdf_page_numbers`. The original is never changed.

## Batch file jobs
`office batch` on a folder: rename (patterns with {name} {ext} {n} {date} {created} {year} {month} {parent}, find/replace, case), sort (type, extension, year, month, first letter, size), convert (md/txt→docx/pdf, csv→xlsx, xlsx→csv, docx→md/txt/pdf, pptx→md/txt, pdf→txt, images→pdf), archive. Always a dry-run plan first; applying it (`plan_id`) asks the user. Nothing is deleted or overwritten; a log of every change is kept in .foreman/batches.

## Receipts and meeting notes
- `receipts_to_sheet`: text PDFs → vendor, date, subtotal, tax, tip, total, currency, receipt number, category; unsure rows marked "check". Image or scanned receipts: look at them with `file_read` and pass what you read as `rows`.
- `meeting_notes`: transcript (.txt/.vtt/.srt/.docx/.pdf or text) + what you understood (summary, decisions, actions with owner and due) → notes document; "Friday" becomes a date from the meeting date; items you may have missed are listed.

## review_document checks
- Structure: heading order, a table of contents when long, empty sections, empty slides, slides without titles, blank PDF pages.
- Formatting: bold text posing as headings, mixed fonts and sizes, tables without header rows, slide text that overflows or runs off the slide, tiny slide text, #REF!/#DIV/0!/#NAME?, formulas that don't compute, totals that skip rows, numbers stored as text.
- Content: placeholders (TBD, Lorem, [insert …], {{…}}), duplicated paragraphs, empty table columns, required form fields left empty, and with `source` (CSV/XLSX), numbers that don't match it.
- Spelling: common typos and repeated words.

## For developers
`src/main/docs/index.ts` lists the generator API (`renderDocx`, `renderPptx`, `renderXlsx`, `parseMarkdown`, `blocksToMarkdown`, `reviewDocument`, PDF helpers); `renderPdf` and `createDocument` are in `src/main/docs/create.ts` (they need Electron).
