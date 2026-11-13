---
name: seo-reporting
description: A monthly SEO report as a Page: traffic, rankings, wins, losses and next actions, from Semrush data.
source: you
uses: 0
category: Business
---

1. Inputs: the user's domain, database/market, up to 3 competitors and the keywords they track (memory first; ask once if missing). Discover Semrush tools with find_tools("semrush"); use its discovery → get_report_schema → execute_report flow.
2. Pull for this month vs. last month (and the same month last year when available): organic traffic and keywords, top pages, position changes for tracked keywords (or the Position Tracking project if one exists), new and lost backlinks/referring domains, and competitors' traffic for context.
3. Analyze, don't just list: biggest wins and losses with the likely reason (new page, update, algorithm change, competitor move, lost link), pages slipping from page 1, quick wins (positions 4-15 with good volume).
4. Build the report as a Page (create_page; update_page for next month) with: a one-paragraph summary; a KPI table (metric, this month, last month, change); a chart of traffic and keywords over time; top movers up and down; competitor comparison; 3-5 next actions with owner and effort. Every number cites its report and date.
5. Keep it honest: say when data is missing, estimated (Semrush traffic is modeled, not analytics), or when the change is within normal noise.
6. Monthly routine: suggest one (paused until the user turns it on) that rebuilds the report on the 2nd of each month and notes the three most important changes in the chat.
