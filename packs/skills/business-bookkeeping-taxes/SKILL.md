---
name: business-bookkeeping-taxes
description: Explain small-business bookkeeping and taxes: categorize, reconcile, invoices, sales and estimated tax (see an accountant).
source: you
uses: 0
category: Business
triggers: bookkeeping, categorize transactions, reconcile bank, reconciliation, chart of accounts, invoice, accounts receivable, quickbooks, xero, business taxes, estimated taxes, quarterly taxes, sales tax, deductions, write off, 1099, payroll, receipts, profit and loss
---

## Ground rules
General education, not tax or accounting advice. Tax rules change yearly and by location: cite the current official source (IRS publications and forms for the US, e.g. Pub 334 for small business, Pub 583 starting a business; HMRC, CRA etc. elsewhere) with the tax year, and tell the user to consult a CPA, enrolled agent or accountant before filing.

## Monthly bookkeeping routine
1. Pull transactions: QuickBooks or Xero (find_tools), bank feeds, Stripe/Square/PayPal payouts (note payouts are net of fees and refunds: book gross sales, fees as expense).
2. Categorize to a simple chart of accounts: income by type; COGS; operating expenses (rent, software, marketing, contractors, payroll, travel, meals, insurance, professional fees); owner draws/contributions (not expenses); loans (principal is not an expense).
3. Reconcile every bank and card account to statements; investigate differences; no unexplained "uncategorized" left.
4. Review receivables (chase overdue invoices) and payables.
5. Produce P&L, balance sheet, cash flow; compare to last month and budget. Use create_document for an .xlsx pack.
Never move money, pay bills or file anything yourself: prepare and let the user act.

## Concepts
- Cash vs accrual: cash records when money moves; accrual when earned/incurred. Small businesses often may use cash for taxes; check eligibility.
- Keep receipts and records (the IRS generally suggests keeping records at least 3 years, longer in some cases: check). Photograph receipts; OCR tools can extract fields.
- Separate business and personal accounts.

## Taxes at a high level (US examples)
- Income tax by entity type (pass-through on personal return vs corporate return).
- Self-employment tax for sole props and partners.
- Estimated quarterly taxes if you expect to owe; check current due dates and safe-harbor rules on IRS.gov.
- Payroll taxes and filings when you have employees; contractor forms (1099-NEC) with W-9s collected up front.
- Sales tax: depends on state and on economic nexus thresholds; marketplaces may collect for you.
- Common deductible categories (ordinary and necessary expenses), home office and vehicle rules have specific methods: point to the IRS publication.

## Pitfalls
Mixing personal spending, treating loan repayments or owner draws as expenses, missing sales tax registrations, misclassifying workers, not saving for taxes (many owners set aside a percentage of profit: suggest confirming the right amount with an accountant).

## Verify
Bank balance in books equals the statement; P&L totals tie to transaction totals; every tax figure has a source, year and "confirm with your accountant".
