---
name: financial-model
description: Build a driver-based financial model: 3-statement basics, revenue forecast, scenarios, sensitivity, burn and runway.
source: you
uses: 0
category: Business
triggers: financial model, financial projections, forecast revenue, three statement model, 3 statement, runway, burn rate, cash flow forecast, scenario analysis, sensitivity analysis, break-even, projections spreadsheet, p&l forecast
---

## Structure (one workbook, tabs in this order)
1. Assumptions: every driver in one labeled cell with units and source/rationale; base/upside/downside columns and a scenario selector that all formulas reference (INDEX/CHOOSE).
2. Revenue build: bottom-up drivers (leads x conversion x price; or customers start + new - churned; or units x price) monthly for 12-24 months, then yearly to year 3-5.
3. Costs: COGS (variable), headcount plan (role, start month, salary, benefits/taxes load ~20-30% as an assumption), operating expenses, marketing tied to CAC.
4. P&L: revenue, COGS, gross profit, opex, EBITDA, depreciation, interest, taxes (simple rate as assumption), net income.
5. Cash flow: net income + non-cash items - change in working capital (receivables, inventory, payables) - capex + financing.
6. Balance sheet: cash, receivables, inventory, fixed assets; payables, debt; equity. It must balance (assets = liabilities + equity) every period; add a check row that shows 0.
7. Summary/dashboard: key metrics, charts, runway, break-even month.

## Key formulas
- Burn = cash out - cash in per month (net burn). Runway (months) = cash / average net burn of the next 3 months, not last month's.
- Break-even revenue = fixed costs / contribution margin %.
- Working capital: receivables = revenue x DSO/30 (monthly); inventory = COGS x DIO/30; payables = COGS x DPO/30.

## Scenarios and sensitivity
Downside scenario should change several drivers together (slower growth, higher churn, delayed hires). Add a sensitivity table (data table or manual grid) on the 2 drivers that matter most, e.g. growth vs churn on month-18 cash.

## Data sources
Actuals from QuickBooks/Xero (find_tools) or exports; Stripe for revenue history; the user's files via knowledge_search. Start the forecast from the last actual month; reconcile opening cash to the bank balance.

## Build and check (create_document .xlsx)
Formulas only (no hard-coded numbers in calculation tabs), typed currency/percent columns, guarded divisions (IF), no circular references unless intended. Run review_document; fix every FAIL. Then sanity checks: gross margin within industry range (cite), revenue per employee plausible, growth rates not exceeding what the funnel supports, balance sheet balances.

## Mini-example
Cash $400k, revenue $20k/mo growing 8%/mo, costs $55k/mo growing 2%/mo: net burn starts $35k and shrinks; model shows runway ~14 months and break-even around month 16; downside (4% growth) runs out at month 12. State that clearly with the month.

## Caveats
Projections are planning tools, not predictions or financial advice. Tax, accounting treatment (revenue recognition, capitalization) and lending covenants: consult an accountant or CFO.
