---
name: business-unit-economics
description: Calculate unit economics (CAC, LTV, payback, gross and contribution margin, churn) and run cohort retention analysis.
source: you
uses: 0
category: Business
triggers: unit economics, cac, ltv, lifetime value, customer acquisition cost, payback period, ltv to cac, cohort analysis, retention curve, churn rate, contribution margin, gross margin
---

## Definitions (state which one you use; they vary by company)
- Gross margin % = (revenue - COGS) / revenue. COGS includes hosting, payment fees, support and delivery costs, not just product cost.
- CAC = sales + marketing spend in a period / new customers acquired in that period. Blended (all customers) vs paid (only paid channels): show both.
- ARPA = average revenue per account per month.
- Churn (monthly logo) = customers lost in month / customers at start of month.
- LTV (simple) = ARPA x gross margin % / monthly churn. Cap lifetime (e.g. 3-5 years) when churn is tiny; uncapped LTV is fiction.
- CAC payback (months) = CAC / (ARPA x gross margin %).
- Contribution margin = revenue - variable costs (COGS + variable selling costs) per unit or customer.

## Rules of thumb (cite a current source before relying on them)
- LTV:CAC ~3:1 is a commonly quoted healthy target for venture-backed SaaS; much higher can mean under-investing in growth.
- Payback under ~12 months is strong for SMB-focused SaaS; enterprise often tolerates longer.
- Ecommerce: watch contribution margin after shipping, returns and ad costs per order; first-order profit is often negative.

## Cohort analysis (the real truth)
1. Get transactions with customer id, first purchase date, date, amount (Stripe/Shopify/Square export, or the user's CSV).
2. Group customers by first-purchase month. For each cohort, compute % still active (logo retention) and revenue vs month 0 (revenue retention) at months 1..N.
3. Build a triangle table in a spreadsheet (create_document .xlsx, formulas not pasted numbers) and a line chart of retention curves.
4. Read it: curves that flatten = a retained core (good); curves that keep falling = no product-market fit for that segment; newer cohorts better than older = improvements working.

## Worked example
ARPA $80, gross margin 75%, churn 4%/mo, CAC $600. LTV = 80 x 0.75 / 0.04 = $1,500. LTV:CAC = 2.5. Payback = 600 / 60 = 10 months. Levers: cut churn to 3% gives LTV $2,000 (3.3:1); raising price 10% raises LTV and shortens payback.

## Pitfalls
- Mixing annual prepaid cash with monthly revenue.
- Leaving out salaries of sales/marketing staff from CAC.
- Using revenue instead of gross profit in LTV.
- Averaging across segments with very different behavior: segment by channel, plan, or customer size.

## Verify
Recompute one cohort by hand from raw rows; totals of cohort revenue must tie to total revenue. State data period and gaps. For accounting treatment or tax effects, consult an accountant.
