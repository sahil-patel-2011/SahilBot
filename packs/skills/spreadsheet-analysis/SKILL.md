---
name: spreadsheet-analysis
description: Analyze or build an Excel/CSV spreadsheet with correct numbers.
source: you
uses: 0
category: Office
---

1. Read the file (file_read handles xlsx and csv). Note columns, types, row count, blanks and obvious errors.
2. For analysis, compute with code when it's more than a few numbers: a Python script via run_command (pandas if installed) beats mental math. Show the exact figures.
3. To build a spreadsheet: create_document (format xlsx) with a header row, consistent units, and totals; keep raw data on one sheet and summaries on another.
4. Double-check totals a second way (row count, a sum by hand on a sample).
5. Explain the findings in plain words with the key numbers.
