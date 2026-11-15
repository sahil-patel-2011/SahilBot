---
name: business-revenue-growth
description: Grow revenue: find the biggest lever (pricing, acquisition, conversion, retention, expansion), size it from real data and test it.
source: you
uses: 0
category: Business
triggers: grow revenue, increase revenue, increase sales, revenue growth, growth plan, sales are flat, more customers, grow my business, revenue is down, double revenue
---

## Model first
Revenue = customers x price x purchase frequency (or for subscriptions: new MRR + expansion - contraction - churn). Write the business's own version of this equation before suggesting anything. Every idea must move one term.

## Gather data (use tools, not guesses)
- Stripe / Square / PayPal / Shopify connectors (find_tools("stripe") etc.): revenue by month, new vs returning customers, refunds, plan mix, churned subscriptions.
- HubSpot / Pipedrive / Close: leads, win rate, cycle length, deal size by source.
- QuickBooks or Xero (if connected): gross margin by product so growth isn't unprofitable.
- No connector: ask for an export (CSV/Excel) and analyze it with the spreadsheet tools. Check memory and knowledge_search for past plans and numbers.

## The five levers, with a quick diagnostic each
1. Pricing: last price change > 12 months ago, few complaints about price, high win rate (> 40%) all suggest underpricing. See pricing-strategy.
2. Acquisition: traffic/leads by channel, cost per lead, trend. Fix only if conversion and retention are healthy; otherwise you pour water into a leaky bucket.
3. Conversion: funnel step rates (visit to lead to trial to paid, or quote to close). The worst step relative to benchmark is usually cheapest to fix.
4. Retention: monthly logo churn and net revenue retention (NRR). B2B SaaS rough guide: NRR > 100% healthy, > 120% excellent; consumer subscriptions churn far more. Cite a current benchmark source when you quote one.
5. Expansion: upsell, cross-sell, usage tiers, add-ons, annual plans, referrals from happy customers.

## Prioritize
Score each idea on impact ($ per year = affected base x expected lift), confidence (evidence you have), and effort (ICE score). Do the top 2-3, not ten. Example: 1,000 customers at $50/mo; a 10% price rise with 3% extra churn = +$60k - $18k ≈ +$42k/yr; a funnel fix lifting trial-to-paid from 15% to 18% on 200 trials/mo at $600 LTV = +$86k/yr. Show the math.

## Run it as experiments
For each: hypothesis, metric, baseline, target, duration, sample size, guardrail metric (margin, churn, refunds), and a stop rule. One change per test when possible.

## Deliverable
A one-page plan (docx/pdf via create_document) plus a spreadsheet with the baseline equation, each lever's sized impact as formulas, and a 90-day test calendar. Save key figures and decisions to memory.

## Pitfalls
- Vanity metrics (traffic, signups) instead of paid revenue and margin.
- Discounting to grow: it often trains customers to wait and lowers LTV.
- Blending cohorts: always split new vs existing customers.
- Benchmarks without source and date. Say when data is thin.

## Verify
Recompute the revenue equation from raw data and check it ties to reported revenue within ~2%. Re-read sources for every benchmark. For tax, legal or securities questions that come up, recommend consulting an accountant or lawyer.
