---
name: make-word-doc
description: Write a well-formatted Word document (docx): letters, memos, proposals, reports.
source: you
uses: 0
category: Office
---

1. Confirm the purpose and audience; match the tone (formal letter vs. internal memo). Read office-word for the full recipe.
2. Pick a template when one fits: memo, letter, report, proposal, meeting_notes (create_document template + fields). Otherwise "# Title" then "##" sections.
3. Structure with real headings (never bold text as a heading), short paragraphs, lists for steps, tables (with a "Table: …" caption) for comparisons; put the most important point in the first paragraph.
4. Create with create_document (.docx). Long documents get a table of contents and page numbers automatically.
5. Read the review in the result; fix every FAIL (placeholders, empty sections, heading order, typos), run review_document again (max 2 rounds).
6. Report the path and a two-line summary.
