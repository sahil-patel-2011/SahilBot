---
name: make-pdf-report
description: Produce a polished, send-ready PDF report from research or data: outline first, themed layout, charts and tables, then a visual check of the rendered pages.
source: you
uses: 0
category: Office
---

The bar: a document a professional would send without touching. The engine handles typography, pagination, TOC page numbers, bookmarks and metadata; your job is the content, the structure and the final look.

1. Gather and verify first (sources cited, numbers checked; for datasets use office-reports and compute in a workbook).
2. Plan the outline before writing: title (states the subject), 3-5 sentence executive summary with the answer and the 2-3 key numbers, then one "##" section per finding or topic, each opening with a sentence that states its point. Decide where each table and chart goes and what it proves.
3. Write the Markdown:
   - "# Title" once, "##" sections, "###" subsections (never skip a level, every heading has text under it).
   - Tables for anything compared or counted: header row, units in headers ("Revenue ($K)"), a "Table: …" line right under it, a "Total" row last (it is styled automatically). Numbers right-align by themselves.
   - Charts for trends and comparisons, from the real numbers only: a fenced block
     ```chart
     {"type": "column", "title": "Revenue by quarter ($K)", "categories": ["Q1","Q2","Q3","Q4"], "series": [{"name": "FY2026", "values": [10420, 11150, 12060, 14570]}], "number_format": "$#,##0"}
     ```
     line = over time, column = categories, bar = long labels/rankings, pie/doughnut = parts of one whole (≤ 6 slices). Add "Figure: caption" under it if useful.
   - One callout for the recommendation or the main risk (> [!IMPORTANT] …, > [!WARNING] …), not one per section.
   - Sources: footnotes text[^1] with [^1]: Source, date — or citations [{text, url}] for a References list.
   - Short paragraphs (under ~120 words), plain words, consistent units and tense.
4. create_document with a .pdf path and:
   - template "report" (cover page, contents with page numbers, running header, "Page X of Y") with fields {subtitle, author, organization, date}; "proposal" / "memo" / "letter" / "resume" / "invoice" for those.
   - theme: "modern" (default, sans), "classic" (serif, formal/legal/academic), "minimal" (monochrome); accent = the brand color if known.
   - Layout options instead of workarounds: fit_pages (e.g. 1 for a one-pager: spacing, then type and margins tighten within readable limits), margins (inches), font_size, page_size (letter | a4 | legal), orientation; <!-- pagebreak --> before a big section only when needed; <!-- landscape --> … <!-- portrait --> around a very wide table.
5. Check the result like a reader:
   - The create_document result includes a review with the real page count and rendered-page checks (blank pages, cut-off content, a nearly empty last page). Fix every FAIL.
   - Then call review_document(path) once and LOOK at the attached overview picture (add pages: "1" to see a page full size): headings orphaned at a page bottom, a lonely last page, a table or chart that looks wrong, awkward breaks. Fix by changing the Markdown or the options and rebuilding at the same path (a backup is kept). At most 2 rounds.
   - Never unzip or edit the PDF/DOCX internals, and never hand-place text with pdf_stamp to fix layout.
6. Tell the user where it's saved, the page count, and the key points in two or three lines.
