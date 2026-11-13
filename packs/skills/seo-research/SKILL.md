---
name: seo-research
description: Keyword research, competitor gaps, site audits, SERP intent and content briefs with Semrush (or the web when it isn't connected).
source: you
uses: 0
category: Business
---

Setup: `find_tools("semrush")` and use whatever tool names it returns; don't assume names. Semrush usually works in three steps: a discovery tool for a toolkit (domain, keywords, organic, backlinks, site audit, traffic…) lists its reports; get_report_schema(report) gives the parameters; execute_report(report, params) returns the data. If Semrush isn't connected, the user gets a Connect card; if they skip it, fall back to web_search and the browser and say the numbers are rough.

Defaults: database "us" unless the user's market is elsewhere (ask once, then remember it); display_limit 30-50. Every number gets its report name, database and date. API units cost money: plan the calls and don't repeat them.

1. Keyword research: start from 3-5 seed topics the user cares about. Pull volume, difficulty, CPC and intent, plus related and question keywords. Group into clusters (one page per cluster). Rank clusters by volume ÷ difficulty and business value, and say why.
2. Competitor gap: find organic competitors for the user's domain, then keywords they rank for (top 20) that the user doesn't. Note which pages win them and the pattern (guides, comparisons, tools, local pages).
3. Site audit: use the Semrush site audit (or crawl key pages with the browser if there is no project). Prioritize: indexing blockers, broken pages and links, duplicate titles, slow or huge pages, missing schema. Each issue: pages affected, impact, fix, effort.
4. SERP intent: for a target keyword, look at what ranks now (web_search or SERP data): informational, commercial, transactional or local; content type and length; features (snippets, People also ask, video, local pack). The page must match that intent to rank.
5. Content brief: target and secondary keywords, intent, suggested title and H1, outline (H2/H3), questions to answer, internal links to and from, word-count range from what ranks, and how to be better than the current top 3.
6. Deliver a short prioritized plan: this week, this month, later. Offer to save the findings as a Page (create_page) and to set up seo-reporting.
