---
name: office-pdf
description: PDF work: fill PDF forms, merge, split, extract, rotate, stamp and number pages; make PDF reports.
source: you
uses: 0
category: Office
---

Load the office tool with find_tools("office"). Every action writes a NEW file next to the original (or out); the original never changes.

Fill a form
1. office pdf_fields(path): exact field names, types, options, required fields. If there are none, the PDF is flat: tell the user, or place text with pdf_stamp only if they ask.
2. Map the user's information to fields. Use only what the user gave you or what is in their files; never guess personal details (SSN, birth date, account numbers). Missing required info: ask once, listing exactly what's missing.
3. office pdf_fill(path, values: {"field name": value}, flatten?: true for a final copy nobody should edit). Checkboxes true/false; radio/dropdown with one of the listed options. Filling personal details asks the user first.
4. Check the result: pdf_fields on the new file (unflattened) or review_document; report what was filled and what is still empty. Never submit or send the form for the user.

Pages
- Merge: pdf_merge(paths in order, out). Split: pdf_split(path, ranges: ["1-3", "4-"]) or each: true. Extract: pdf_extract(path, pages: "2,5-7,last"). Rotate: pdf_rotate(path, degrees: 90, pages?).
- Stamp: pdf_stamp(path, text: "DRAFT", position: "diagonal") or "Approved 2026-11-14" bottom-right. Page numbers: pdf_page_numbers(path, format: "Page {n} of {total}").
- pdf_info for page count, sizes and whether it has form fields.

Make a PDF report: create_document with a .pdf path and markdown (same features as Word: cover, [TOC], tables, footnotes, page numbers). Skill: make-pdf-report.
