---
name: ideas-novelty-check
description: Check whether an idea already exists: search products, app stores, GitHub, patents and launches, then give a novelty verdict.
source: you
uses: 0
category: Ideas
triggers: does this already exist, already exists, has anyone built, anyone built this, is this idea taken, novelty check, is this idea original, existing products, prior art, similar apps, check if anyone built, already been done
---

## 1. Pin the idea down first
Write it as: customer + job to be done + how it works + price point. "AI app for doctors" can't be checked; "prior-auth letter drafting for solo urology practices, $99/mo" can. List 5-10 phrasings a buyer would type (the problem, the outcome, the category name, competitor names).

## 2. Search everywhere relevant (web_search + fetch_page; agents in parallel)
Query templates, filling in the problem and category:
- `<problem> app`, `<problem> software`, `<problem> tool`, `best <category> software 2026`, `<category> for <niche>`
- `alternative to <X>`, `<X> competitors`, `<X> vs`
- `site:producthunt.com <problem>`; `site:github.com <problem>`; `site:news.ycombinator.com "Show HN" <problem>`
- `"<problem>" site:reddit.com "is there an app"` or `"is there a tool"`; also "I built" and "we built"
- `site:ycombinator.com/companies <category>`; `site:indiehackers.com <problem>`
- App Store / Google Play: `site:apps.apple.com <problem>`, `site:play.google.com <problem>`
- B2B categories: `site:g2.com <category>`, `site:capterra.com <category>`; Crunchbase-style listings (Crunchbase connector if connected, else web search)
- Plugins: Chrome Web Store, Shopify App Store, WordPress, Slack/Zapier app directories, when the idea lives inside a platform
- Physical products or novel mechanisms: Google Patents (`site:patents.google.com <mechanism>`), Amazon and Kickstarter
- The big platforms themselves: check whether Google, Microsoft, Apple, Shopify, Salesforce or the category leader ships it as a feature
Check the brain too (memory search, `vault` search): the user may have researched this space before.

## 3. Record each hit
Name, link, what it does, who it's for, price, signs of life (last update, reviews count, funding, launch date), and the top complaints in its reviews. Open the actual page; don't judge from a search snippet. 5-15 hits is normal; zero after a thorough search is rare and worth double-checking with new phrasings.

## 4. What counts as "already exists as-is"
All of: same target customer, same core job, similar delivery (software vs service, platform), comparable price, and it's alive (updated in the last ~12 months, real users or reviews). If any of these differ in a way buyers care about, it's a possible gap, not a copy. A dead or abandoned product means the idea was tried: find out why (post-mortems, reviews, HN threads) before calling it an opportunity.

## 5. Verdict (one per idea)
- New: nothing alive does this job for this customer after the full search.
- Underserved niche: tools exist, but reviews or forums show a clear gap (a segment, price point, integration, workflow or region they ignore).
- Crowded → reshaped: several alive products do it; propose a narrower angle and re-run steps 2-4 on it.
- Dropped: exists as-is and is good enough; name the product that wins.
Always add a confidence label: high (searched every relevant source, many phrasings), medium (main sources only), low (few sources, niche jargon, non-English markets, or stealth startups likely). Absence of evidence after searching isn't proof of absence: say so, and say which sources you could not check.

## Output
A short table per idea: hits (name, link, price, for whom, last sign of life), the gap, verdict, confidence, sources searched with the date. Then 1-2 sentences of recommendation.

## Pitfalls
Searching only your own phrasing; trusting snippets; missing incumbents' built-in features; treating "no funding news" as "no competitor". For patentability or freedom-to-operate questions, a search is only a start: consult a patent attorney before relying on it or disclosing an invention.
