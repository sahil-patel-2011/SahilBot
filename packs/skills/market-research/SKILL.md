---
name: market-research
description: Research a market: size with sources, competitor table, pricing, channels, dated trends and unmet needs from real complaints.
source: you
uses: 0
category: Business
triggers: market research, research the market, industry analysis, competitive landscape, competitor analysis, market overview, market trends, industry report, market landscape, who are the competitors
---

## 1. Scope
Write the market definition (customer, problem, geography, B2B or consumer) and the 3-6 questions the research must answer (e.g. "Is it growing? Who wins and why? What's underserved? What do buyers pay?"). Check the brain first: memory search and `vault` search for earlier research; `about` for companies or people involved.

## 2. Gather in parallel (agents, or web_search + fetch_page)
Split into helpers: sizing, competitors, pricing, channels, trends, customer pain. Prefer primary and recent sources: government statistics (Census, BLS, Eurostat), public filings (10-K, S-1), industry associations, company pricing pages, analyst summaries with named methodology. Use Crunchbase, Similarweb or other connectors when connected (find_tools).

## 3. Market size
Bottom-up (number of buyers x annual spend) and top-down (industry figure narrowed by segment); show the arithmetic and cite every input with URL and date. Give a range, not a single number, and say which inputs are assumptions. Growth rate with its source and period.

## 4. Competitor table
| Name | Link | Target customer | Price / model | Positioning | Strengths | Weaknesses (from reviews) | Size / funding | Last sign of life |
Include indirect alternatives (spreadsheets, agencies, in-house, doing nothing). Read the actual pricing pages and review sites; note "pricing on request".

## 5. Pricing and channels
Price bands in the market (entry, mid, premium), packaging (per seat, usage, flat), discounts and free tiers. How buyers find and buy: search terms, marketplaces, review sites, communities, partners, sales teams, events. Note where competitors spend (ads, content, SEO) when visible.

## 6. Trends with dates
3-6 trends that change the market (regulation, technology, consolidation, buyer behavior), each with a dated source and why it matters. Separate facts from forecasts.

## 7. Unmet needs from real complaints
Run business-complaint-mining against the top incumbents: short quoted complaints (link, date) clustered into gaps, with frequency and willingness-to-pay signals. These gaps are the opportunities section.

## Output
1. Summary (5 bullets, the answers to the scoping questions).
2. Market size range with the math.
3. Competitor table.
4. Pricing and channels.
5. Trends.
6. Unmet needs and opportunities, then threats.
7. Next steps.
8. Sources (title, URL, date).
As a docx/pdf report or a page if the user wants; save key figures to the vault.

## Verify
Every number has a source and a date; recompute the sizing math; flag sources older than ~2 years and any figure from a vendor selling into the market. Say clearly where data is thin. For investment, legal or regulatory decisions based on this, consult a qualified professional.
