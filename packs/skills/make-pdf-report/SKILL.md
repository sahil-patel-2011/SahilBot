---
name: make-pdf-report
description: Produce a polished PDF report from research or data.
source: you
uses: 0
category: Office
---

1. Gather and verify the content first (sources cited, numbers checked).
2. Outline: title, 2-3 sentence summary up top, sections with headings, a table for any comparison, sources at the end.
3. Create it with create_document (format pdf). Keep paragraphs short; use bullet lists for steps and findings; put numbers in tables.
4. Re-open it with file_read to confirm every section rendered and nothing is cut off.
5. Tell the user where it's saved and the key points in two or three lines.
