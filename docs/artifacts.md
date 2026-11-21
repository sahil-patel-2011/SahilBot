# Artifacts: how agents make and change documents, decks, dashboards and sheets

Every model and helper agent in SahilBot follows this. The short version is in the system prompt (`src/main/agent/prompt.ts`, "Artifacts are native first").

## Native first

Anything the user will read, edit or send is made as a **live document** with `doc_create`. It opens in SahilBot's editor beside the chat, the user edits it there while you do, every change is a version they can restore, and it is listed on the **Artifacts** page under "Your documents".

| The user asks for | `doc_create` type | Exports with `doc_export` |
|---|---|---|
| a report, letter, plan, memo, outline, notes | `doc` | `docx`, `pdf`, `md`, `html` |
| a deck, presentation, pitch, slides | `slides` | `pptx` (editable), `pptx_pictures` (each slide a picture, exact fonts), `odp` (Keynote, LibreOffice, Google Slides), `pdf`, `png` (folder of 1920 × 1080 images), `md` |
| a dashboard, KPI page, scorecard | `dashboard` | `pdf` (landscape), `html`, `docx`, `md` |
| a small spreadsheet, tracker, budget | `sheet` | `xlsx`, `csv`, `pdf`, `md` |

When they ask for a file ("send me a PDF of it", "make a PowerPoint"), make the live document first, then `doc_export` the format, and say where the file is. They get the file and an original they can still change.

Use `create_document` directly only when the user wants a file with no editable copy, or needs what only it does: charts inside a Word or PDF report, a table of contents, templates (invoice, resume, letter), fitting to N pages, or rebuilding an existing file in a folder. After `create_document`, fix every FAIL in its review.

`create_page` is for things to play with (calculators, interactive charts). It isn't a document.

## Changing a document

1. `doc_read` first. The user may have edited it since you last looked. Every block has an `[id]`.
2. `doc_edit` with small, targeted ops on `base` = the version you read. Never rewrite the whole thing for a small change.
3. On a conflict, `doc_read` again and redo your change on top of theirs. Their edits win.
4. The user's own edits flash nothing. Yours flash in your color, so make them deliberate.

## Decks (`type: "slides"`)

Write Markdown. Each slide is:

```markdown
### Assembly guide · November 2026     ← optional kicker (small label above the title)
## Ranger                              ← the slide title (starts a slide)
- Assembly Guide                       ← points; on the first slide: subtitle
- From printer and carbon tube to a balanced aircraft   ← first slide: description
  - a sub-point                        ← two-space indent
- **130** Steps                        ← a big-number stat (bold number, then label)
- **1,192 g** Printed parts
> Say this out loud; it isn't shown.   ← speaker notes
![](/Users/me/Desktop/photo.png)       ← the slide's picture (right side, or full if no points)
```

- A chart: put a fenced `chart` block on the slide with CSV (header row, then one row per label). It's drawn in the slide's colors and exported to PowerPoint as a native chart the user can edit. A two-column Label/Share (or %) table with 2 to 6 rows draws as a donut. 7+ rows, or a time column (Month, Quarter…), draws as a line.

  ```chart
  Quarter, Revenue, Costs
  Q1, 120, 80
  Q2, 150, 90
  ```
- `doc_create` and `doc_export` return a deck check: slides with more than 6 points, points over 120 characters, titles over 70 characters or missing. Fix what it flags with `doc_edit` before sending.
- The first slide is the dark title slide. A slide with only a title is a dark section slide. The others are light, with the deck title and the page number in the footer.
- Write a headline title that states the point, then 3 to 5 short points. Put the detail in the notes.
- The editor, Present, PDF, PNG and "PowerPoint (pictures)" all come from one renderer (`src/shared/slide-render.ts`), so what the user sees is what they send.
- Font and theme (Modern, Classic, Minimal) are document style. The user picks them in the editor. They carry into every export.

## Dashboards (`type: "dashboard"`)

```markdown
## Overview
- **$4.2M** Revenue · up 12% on Q2     ← a stat tile; text after " · " is its note
- **318** Customers
## Revenue by month
| Month | Revenue | Costs |              ← first column = labels; number columns are charted
| --- | --- | --- |
| Jan | 310 | 220 |
## Notes
Short paragraphs and bullet lists show as notes.
```

Tables with 12 or more rows, or 7 or more rows under a first column named Month, Week, Day, Date, Year, Quarter or Period, are charted as a line; others as bars. Blank cells are gaps, not zeros. Numbers may carry $, %, k/M/B, a leading + or −, or (parentheses) for negatives. The user switches between **Dashboard** (drawn) and **Edit data** (the block editor).

## Sheets (`type: "sheet"`)

Pass a Markdown table. Cells starting with `=` are formulas. The editor computes them with the same engine `doc_read` reports.

## Files the user already has

The Artifacts page has **Edit** on Word, PDF, PowerPoint, Markdown, HTML, Excel and CSV files. It opens them as live documents (PowerPoint as a deck). **Save to file** writes back to the original. A backup goes to `.sahilbot-backups`, and PDFs are saved as Word.

## Where the code is

- Tools: `src/main/agent/tools/docspace.ts`
- Store, merge and versions: `src/main/docspace/store.ts`, `merge.ts`
- Exports: `src/main/docspace/export.ts`, `deck-export.ts`
- Models: `src/shared/slides.ts`, `slide-render.ts`, `dashboard.ts`
- Editor: `src/renderer/src/components/DocEditor.tsx`, `doc/SlidesView.tsx`
- Artifacts page: `src/renderer/src/components/Home.tsx` (`FilesView`, `MakeNew`)
