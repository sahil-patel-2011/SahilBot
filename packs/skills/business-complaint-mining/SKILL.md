---
name: business-complaint-mining
description: Mine real complaints from Reddit, forums and reviews to test if a problem is real, painful and worth paying for, then score and decide.
source: you
uses: 0
category: Business
triggers: complaints, complaining about, what do people hate about, pain points, reddit complaints, negative reviews, bad reviews, one star reviews, is this a real problem, would people pay for, voice of customer, complaint mining, real pain
---

## 1. Frame the search
Name the problem space, the customer (role, industry, region) and 2-3 incumbent products. Check the brain first: memory search and `vault` search for past research, `about` for clients or contacts in the space.

## 2. Search where people complain (web_search + fetch_page; agents in parallel)
- Reddit: `"<problem>" site:reddit.com`, `site:reddit.com/r/<niche> "<tool>" hate OR frustrating OR "is there"`, `"<tool>" alternative site:reddit.com`
- Hacker News: `site:news.ycombinator.com "<problem>"`, `"Ask HN" <problem>`
- Niche forums and communities: `"<problem>" forum`, Facebook groups, Discord, Slack communities, trade associations
- App Store / Google Play: 1-3 star reviews of the top apps (`site:apps.apple.com <tool>`; sort by most critical)
- G2 / Capterra / Trustpilot: `site:g2.com <tool> reviews` and read the "dislikes" sections; Trustpilot 1-2 stars
- Amazon: 1-3 star reviews of the top products in the category
- X / social: `"<tool>" (sucks OR broken OR "so slow" OR "cancel")`
- Job boards and freelance sites (Upwork, Fiverr): people paying someone to do the task by hand
Prefer the last 24 months; note older evidence as older.

## 3. Collect quotes honestly
Quote SHORT real complaints (under ~25 words each) as citations: quote, source, link, date. Never fabricate, paraphrase into a fake quote, or paste whole posts. Skip obvious spam, vendor astroturf and one person repeating themselves. Aim for 20-50 quotes.

## 4. Cluster and measure
Group quotes into 3-8 pain clusters. For each:
- Frequency: distinct sources and threads (not upvotes alone), and how recent.
- Intensity: workarounds (spreadsheets, scripts, VAs), money or hours lost, anger words, "I'd pay", switching or churn stories.
- Willingness to pay: people already paying for a bad tool, hiring freelancers, stacking spreadsheets + VAs, "take my money", asking for pricing. A pain with no spend is usually a nice-to-have.

## 5. Score each idea (1-5, evidence in every cell)
| Criterion | Score | Evidence |
Pain severity · Frequency · Willingness to pay · Competition (from ideas-novelty-check: 5 = open gap, 1 = crowded and good) · Feasibility for the user (skills, budget, time, licenses).
Verdict: Go (no score below 3 and pain + pay ≥ 8), Reshape (strong pain, but crowded or hard: change segment, price or form), Kill (weak pain or no spend). Say what evidence would change the verdict.

## 6. Next validation step (pick one, write it out)
- Landing-page smoke test: headline from the top complaint's own words, one CTA (waitlist or pre-order at a price), $ ad budget and traffic source (subreddit, niche ads, a community post), success threshold (e.g. ≥ 5% email signups from 300 targeted visitors in 2 weeks).
- 5 customer interviews, Mom-Test style (past behavior, no pitching):
  1. Walk me through the last time you dealt with <problem>.
  2. How often does it happen?
  3. What did it cost you (time, money, stress)?
  4. What do you use today? What do you dislike about it?
  5. What have you tried that didn't work?
  6. Who else is involved or decides?
  7. Have you paid for anything to fix it? How much?
  8. If you could wave a wand, what would change?
  9. What would make you switch from what you use now?
  10. Who else should I talk to?
- Pre-sale: the offer, the price, the deadline, the success threshold (e.g. 3 paid pilots at $300/month in 30 days); refund if you don't deliver.

## Output
Pain clusters with quotes (link, date), the scoring table, verdict, and the next step. Save the summary to the vault if the user wants. Hand off to ideas-validate-business for sizing.

## Pitfalls
Loud minorities; old threads about problems since fixed; counting one viral post as frequency; reading features into complaints. For regulated spaces (health, finance, kids), consult a lawyer before running tests.
