---
name: business-plan-writing
description: Write a business plan for investors, a bank or SBA loan, or internal use, with sourced market data and a linked model.
source: you
uses: 0
category: Business
triggers: business plan, write a business plan, lean canvas, one page plan, strategy document, sba loan plan, bank loan plan, executive summary, business model canvas
---

## First decide the reader
- Investors: market size, growth, team, traction, the ask; 10-20 pages or a deck (see business-fundraising).
- Bank / SBA lender: cash flow, collateral, owner experience, repayment ability (debt service coverage ratio, DSCR = net operating income / annual debt payments; lenders often look for roughly 1.25 or more: confirm with the lender).
- Internal: goals, priorities, budget, owners, timeline; 2-5 pages.
Start with a one-page lean canvas (problem, customer segments, unique value proposition, solution, channels, revenue streams, cost structure, key metrics, unfair advantage) to find gaps before writing prose.

## Sections (adapt)
1. Executive summary (write last, one page).
2. Problem and customer: who, how painful, how they solve it today. Evidence from interviews or data.
3. Solution and why it wins.
4. Market: TAM/SAM/SOM with top-down and bottom-up math and sources (see ideas-validate-business).
5. Competition: table of 5-8 alternatives with price, strengths, weaknesses; your defensible edge.
6. Go-to-market: channels, sales process, pricing, first 100 customers.
7. Operations: suppliers, location, staffing, key processes, regulations and licenses.
8. Team and gaps.
9. Financials: 3-year projections (monthly year 1), assumptions, break-even, funding need and use of funds (financial-model).
10. Risks and mitigations; milestones.

## Tools
- web_search/fetch_page (or agents in parallel) for market data; prefer government statistics (Census, BLS, industry associations), public company filings, reputable research; cite URL and date for every number.
- knowledge_search for the user's notes, prior drafts, pitch materials; memory for their business facts.
- Spreadsheet model via create_document (.xlsx) and the plan as .docx or .pdf with template "report"; run review_document and fix every FAIL. Numbers in the plan must match the model.

## Quality checks
- Every claim either sourced or labeled as an assumption.
- Bottom-up revenue (customers x price) reconciles with the market share it implies (a year-3 plan needing 30% share of SAM is a red flag).
- Use of funds sums to the ask and covers at least 18 months of runway for startups.

## Pitfalls
Hockey-stick growth with no driver, "no competitors", ignoring working capital (inventory, receivables), and vague milestones.

## Professional help
Entity, tax, securities (raising money from investors) and licensing questions: consult a lawyer and an accountant. SCORE and SBDC offer free mentoring in the US.
