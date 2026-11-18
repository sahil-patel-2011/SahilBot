---
name: business-weekly-newsletter
description: Draft the weekly newsletter or team update from what actually shipped in Slack, Notion, release notes and the vault, for review.
source: you
uses: 0
category: Business
triggers: weekly newsletter, newsletter draft, team newsletter, company newsletter, customer newsletter, weekly update email, what shipped this week, release notes summary, internal newsletter, weekly roundup, product update email, changelog email
---

## 1. Settle the brief (check memory first)
Audience (team, customers, investors), sender, length, tone and format from past issues: memory search and `vault` search "newsletter" for the style guide and last issue. Ask once only for what's missing. Default: one screen, plain and specific.

## 2. Gather what happened this week (brain first, then apps)
- Brain: `vault` search for project notes and decisions this week; `about` lookup for projects and people mentioned; memory search for the worklog.
- Slack (when connected): the shipping, release, announcements and wins channels for the last 7 days.
- Notion / Linear / Jira / GitHub (when connected): pages updated, issues closed, merged PRs, release notes, the changelog.
- Calendar and email: launches, events, customer wins the user was copied on.
Keep a source list as you go: item, link, date, who.

## 3. Pick 3-5 stories
Rank by what the audience cares about: user-visible launches and fixes, customer wins and numbers, milestones, people news (welcomes, thanks), what's next. Cut internal-only noise for customer issues. One lead story, 2-4 short ones, then a "coming up" line.

## 4. Write it
- Subject line: 3 options, specific, under ~50 characters ("Bulk export is live + 2 faster reports").
- Opening: 1-2 sentences with the week's headline.
- Each story: what changed, why it matters to the reader, a link (docs, demo, post). Bold the feature name. Credit the people who did it.
- Close: what's next, one call to action (reply, try it, book a demo), sign-off.
- Tone: match past issues; short sentences; no hype words ("revolutionary").

## 5. Never invent
Only include what a source shows shipped. Don't promise dates, features or numbers that aren't in a source; mark anything uncertain "[confirm]". Leave out confidential customer names, unreleased work and personal data unless the user says it's fine. For customer-facing claims about security, privacy or pricing, have the owner confirm; for regulated claims, consult a lawyer or compliance professional.

## Output
The draft (subject options, body), then the source chips per story ("Slack · Nov 14 #releases", "Notion · Nov 12", "GitHub PR #412"), and the items you left out and why. Offer to save it as a doc, as a draft in the email or newsletter tool (Mailchimp, Beehiiv, Substack connectors), or as a recurring Friday routine via schedule. Never send or publish without the user's OK.

## Pitfalls
Listing every ticket; jargon for a customer audience; stale items from last week; a subject line that says "Newsletter #42".
