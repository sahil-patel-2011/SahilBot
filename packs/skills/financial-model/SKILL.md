---
name: financial-model
description: Build a financial model: revenue, costs, cash flow, break-even and scenarios.
source: you
uses: 0
category: Business
---

1. List drivers: customers, price, conversion, churn, unit costs, salaries, rent, marketing.
2. Assumptions sheet first: one labeled cell per driver (with units), base/best/worst columns and a scenario selector (options dropdown) that every formula references through INDEX or CHOOSE.
3. Monthly for year 1, then yearly: revenue, COGS, gross margin, operating costs, EBITDA, cash, all as formulas (create_document .xlsx with typed currency/percent columns, totals, summary: true). Guard divisions with IF.
4. Compute break-even and runway; check totals a second way; fix every FAIL in the review (#DIV/0!, #REF!, totals that skip rows).
5. Summarize the key numbers in plain words. It is planning, not financial advice.
