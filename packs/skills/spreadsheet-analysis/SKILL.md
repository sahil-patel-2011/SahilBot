---
name: spreadsheet-analysis
description: Analyze or build an Excel/CSV spreadsheet with correct numbers.
source: you
uses: 0
category: Office
---

1. Profile the file: office sheet_summarize (find_tools("office")) gives column types, counts, blanks, sums, ranges and outliers; sheet_read shows values and formulas. Note row count, units, blanks and obvious errors.
2. For analysis, compute with formulas in a workbook (office-excel) or a Python script via run_command (pandas if installed) when it's heavy; never mental math beyond a few numbers. Show exact figures.
3. To build a spreadsheet: create_document (.xlsx) with typed columns, formulas, totals: true and summary: true; raw data on one sheet, analysis on another. To change the user's workbook: office sheet_write (backup kept).
4. Double-check totals a second way (row count × average, a hand sum on a sample) and fix every FAIL from the review (#DIV/0!, totals that skip rows).
5. Explain the findings in plain words with the key numbers.
