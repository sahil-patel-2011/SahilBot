---
name: ideas-new-business
description: Generate novel business and startup ideas from real complaints, check each one against existing products and keep only real gaps.
source: you
uses: 0
category: Ideas
triggers: business ideas, startup ideas, side hustle, what business should i start, new business idea, ideas for a company, make money ideas, saas ideas, small business ideas, novel ideas, nobody has built, original startup idea, untapped market, gap in the market
---

## 1. Start from the founder (check the brain, ask once)
Look up the user first: memory search, `about` lookup "me", `vault` search for past idea lists. Then fill gaps: skills and credentials, unfair access (an industry, a community, a customer list), budget, hours per week, risk appetite, income goal and timeline, what they refuse to do. Founder-market fit beats a "hot" market.

## 2. Mine real pain before inventing anything
Run business-complaint-mining on 3-5 spaces the founder knows (their job, their community, a trend). Collect 20-40 raw pain points, each with a short quoted complaint, link and date. No quote, no idea: an idea without a real complaint behind it is a guess and must be labeled one.

## 3. Turn pains into candidate ideas (10-20)
For each strong pain cluster, try several shapes:
- Unbundle: one feature of a big platform done 10x better for one niche.
- Vertical: a horizontal tool rebuilt for one industry's workflow and vocabulary.
- Services-first: sell the outcome done by hand, then productize what repeats.
- Why now: new regulation, new tech (AI, APIs), a platform change, a demographic shift (cite source and date).
- Copy-and-localize: a proven model for a new region, language or vertical.
- Picks-and-shovels, or a boring cash-flow business (B2B service, niche distribution, buying a small business).
For a clinician: prior authorization, follow-ups, documentation and billing chores are rich veins.

## 4. Novelty check every candidate (never skip)
Run ideas-novelty-check on each one: web search, Product Hunt, App Store / Google Play, G2/Capterra categories, Crunchbase-style listings, GitHub, Chrome Web Store / Shopify apps, Google Patents, YC / Indie Hackers launches, as relevant. Use agents in parallel when there are many. Then:
- Exists as-is (same customer, same job, similar price, decent reviews): drop it, or reshape it (narrower niche, different buyer, 10x cheaper, a missing integration, a service wrapper) and re-check the reshaped version.
- Exists but reviews show the gap: keep it as "Underserved niche" and name the gap.
- Nothing found after the full search: "New", with a confidence label; absence of evidence is not proof.

## 5. Score the survivors (1-5, show the table)
Pain severity, frequency, willingness to pay, competition gap (from the novelty check), reachability (can you find 100 buyers this month?), founder fit, time to first dollar, capital needed. Drop anything scoring 1 on pain or reachability. Put the evidence in the cells, not just numbers.

## Output (top 3-5 ideas)
For each:
- One-line pitch, target customer, the painful problem with 1-2 quoted complaints (link, date).
- What's already out there: product names with links and prices.
- The gap: what they miss, for whom, at what price.
- Novelty verdict: New / Underserved niche / Crowded → reshaped / Dropped (plus confidence: high, medium, low).
- Business model and rough price, first 10 customers plan, biggest risk, a 2-week cheap test.
Also list the dropped ideas in one line each with the product that already does it, so the user sees the work. Hand the chosen idea to ideas-validate-business. Save the shortlist to the vault if the user wants.

## Pitfalls
- Solutions looking for problems; "an app for everyone"; ideas from your head instead of from complaints.
- Calling something new because the first search page was empty.
- Buyers with no budget (students, hobbyists) unless consumer scale is realistic.
- Ideas needing licenses, inventory or regulation (food, health, finance, childcare, kids' data): flag them and consult a lawyer or the local licensing office early.

## Verify
Every complaint, competitor and trend claim has a link and date; nothing is invented. Re-read the founder constraints and drop ideas that break them.
