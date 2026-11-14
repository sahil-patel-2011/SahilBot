---
name: make-pdf-report
description: Produce a polished PDF report from research or data.
source: you
uses: 0
category: Office
---

1. Gather and verify the content first (sources cited, numbers checked; for data use office-reports).
2. Outline: title, 2-3 sentence summary up top, sections with headings, a table for any comparison (with a "Table: …" caption), footnotes or citations for sources.
3. Create it with create_document (.pdf, markdown; template "report" for a cover page and contents; page numbers are on by default). Keep paragraphs short; bullets for steps and findings; numbers in tables.
4. Fix every FAIL in the review that comes back, then review_document again (max 2 rounds). For numbers from a dataset, pass it as source.
5. Tell the user where it's saved and the key points in two or three lines.
