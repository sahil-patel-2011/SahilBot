---
name: deep-web-research
description: Research a question across several sources and give a cited, checked answer.
source: you
uses: 0
category: Research
---

1. Break the question into 2-5 specific sub-questions. For big topics, send each to a helper with the agents tool.
2. For each: web_search with specific queries (names, dates, "official", site: filters). Open the best 2-3 results with fetch_page; prefer official sites, primary sources and recent dates.
3. Cross-check every important claim in at least two independent sources. Note disagreements and dates.
4. If search is unavailable, fetch well-known pages directly (official site, Wikipedia) and say so.
5. Answer: the direct answer first, then supporting details, then "Sources:" with title and URL for each [n] you cited. Say plainly what you couldn't confirm.
