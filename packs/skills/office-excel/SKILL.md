---
name: office-excel
description: Excel workbooks with typed columns, live formulas, totals, frozen headers, filters, dropdowns, conditional formats and a summary sheet; read and edit existing workbooks in place.
source: you
uses: 0
category: Office
---

New workbook: create_document with a .xlsx path and sheets. Existing workbook: office tool (find_tools("office")).

Building one
1. One table per sheet: raw data on its own sheet(s), calculations next to the data as formula columns, a Summary sheet first (summary: true makes one with live totals/averages, or give summary: {items: [{label, value: "=SUM(Data!D2:D50)", format}]}).
2. Declare columns: [{header, type: date|currency|percent|integer|number|text|boolean, total?, options? (dropdown), formula? "=C{r}*D{r}"}]. Dates as "2026-11-14", money as numbers (12.5) or "$12.50", percent as 0.25 or "25%".
3. Formulas, not pasted results: "=SUM(...)", "=AVERAGE(...)", "=IF(...)", "=SUMIF(...)", "=INDEX(range, MATCH(key, keys, 0))". XLOOKUP is rewritten to INDEX/MATCH automatically so it works in every Excel, Numbers and Sheets. Guard divisions: "=IF(B2=0,0,C2/B2)".
4. totals: true adds a Total row with SUBTOTAL (works with filters). Freeze and filter are on by default with a header row. Add conditional: [{column: "Margin", type: "negative"}, {column: "Status", type: "text_contains", value: "Late", color: "red"}, {column: "Revenue", type: "data_bar"}].
5. Assumptions (rates, prices, growth) go in their own labeled cells or sheet and formulas reference them, never typed into formulas.
6. The result includes a review: every formula is computed; fix any #DIV/0!, #REF!, #NAME?, totals that skip rows and numbers stored as text, then review_document again.

Reading and editing
- office sheet_read(path, sheet?, range?) shows values and formulas. sheet_summarize gives per-column stats (use before analysis).
- office sheet_write(path, edits): {cell: "B2", value: 42}, {cell: "A10", values: [[...]]}, {sheet, append: [[...]]} (goes above a totals row, which grows; formula columns carry down), {cell, format: "$#,##0.00"}. A backup is kept, styles stay, results are recomputed and errors reported. Files with charts, pivots or macros: use the app tool in Microsoft Excel instead (app-office skill) or write a copy with out.
- CSV: office csv_to_xlsx(path, totals?) types the columns.

Quality bar: header row in plain words with units, consistent number formats per column, no blank rows inside data, totals checked a second way (e.g. count × average), and the numbers you quote in chat come from the file you made.
