---
name: office-reports
description: Turn data (CSV, Excel, research) into a finished report: analysis workbook plus a Word/PDF report or a deck, with every number checked against the source.
source: you
uses: 0
category: Office
---

1. Understand the data: office sheet_summarize(path) (types, totals, ranges, blanks, outliers); sheet_read for the details. For CSVs, csv_to_xlsx first. Note the date range, units and anything odd (blanks, duplicates, outliers) to mention.
2. Compute the answers in a workbook, not in your head: create_document .xlsx with a Data sheet (the source rows) and an Analysis sheet of formulas (SUMIF/AVERAGEIF by group, growth "=C2/B2-1", shares), totals: true, summary: true. Read back the computed values with sheet_read.
3. Write the report (office-word skill, template "report"):
   - Executive summary: the answer in 3-5 sentences with the 3 most important numbers.
   - Key findings: one ## section each, a sentence that states the finding, the evidence table ("Table: …" caption), what it means.
   - Recommendations (numbered, specific, with owner/timing if known), Method and data (source, dates, caveats), Appendix (full tables).
   - Charts: a ```chart block (JSON: type, categories, series from the workbook's computed values, number_format) draws a native chart in Word and a vector chart in PDF; one chart per key trend, with the table of exact figures nearby.
   - Use the same theme (and accent) for the report, the deck and the workbook so they look like one set.
4. Check: review_document(report, source: the CSV/XLSX with the true figures) flags numbers in tables or text that don't match, and renders the pages: look at the overview picture before presenting. Fix every FAIL by rebuilding (options like fit_pages, margins, font_size; never edit document XML); numbers rounded on purpose should say so ("$1.2M").
5. Deliver the files (report + workbook, and a deck if asked), and summarize the findings in 3 lines in chat.

Quality bar: every number traceable to the workbook, consistent units and periods, no unexplained jargon, charts and tables labeled, a clear "so what" per section.
