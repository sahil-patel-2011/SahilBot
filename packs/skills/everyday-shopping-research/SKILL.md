---
name: everyday-shopping-research
description: Research a purchase: needs, compare options on specs and total cost, reviews, recalls, returns; the user clicks to buy.
source: you
uses: 0
category: Everyday
triggers: which should i buy, best laptop, best vacuum, worth buying, recommend a product, product comparison, compare prices, cheapest place to buy, good deal, mattress, tv to buy, buying guide, what to buy, product recommendation
---

## Steps
1. Needs: use case, budget (and stretch), must-haves, deal-breakers, brand preferences, timing; check memory for past preferences and what they own.
2. Shortlist 3-5 options from reputable testing sources (independent reviewers with lab testing, Consumer Reports if accessible, expert publications) plus manufacturer spec pages. Use agents in parallel for many options.
3. Compare in a table with the same columns: price (with retailer and date), key specs that matter for the use case, reliability/warranty, running costs (ink, filters, subscriptions, energy), return window, availability.
4. Total cost of ownership: price + accessories + consumables + subscription over the expected life. Unit price for groceries and consumables.
5. Reviews sanity: favor detailed reviews from verified buyers; watch for fake-review signs (many 5-star reviews in a short time, vague praise, mismatched product); read the 2-3 star reviews for real downsides.
6. Safety and recalls: check CPSC (saferproducts.gov, cpsc.gov recalls) or NHTSA for car seats and vehicles.
7. Price: compare 2-3 retailers; price history if available; note sale events. For a deep price check use compare-products.
8. Recommend one with a one-line reason, plus a budget pick and an upgrade pick, and when another would be better.

## Purchase rule (hard)
Never complete a purchase. You may fill a cart or checkout fields only if the user asks; every purchase step waits for the user's click on the Purchase card. Never buy what the user didn't ask for, never add extras (warranties, subscriptions) unasked, and never enter card numbers outside the saved-payment flow.

## Pitfalls
Spec-sheet numbers that don't matter for the use case, sponsored "best of" lists without testing, marketplace third-party sellers with poor return policies, counterfeit risk on deeply discounted brand items.

## Verify
Every price and spec has a source and date; links go to official or reputable retailer pages.
