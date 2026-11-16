---
name: make-slide-deck
description: Build a clear PowerPoint (pptx) presentation.
source: you
uses: 0
category: Office
---

1. Plan the story first: one message per slide, and as many slides as the story needs: no fixed count (a quick update might be 5, a deep review or course 30+). Size it to the content and the time the user has, never pad or cut to hit a number. Title → problem → key points → evidence → recommendation → next steps → closing. Full recipe: office-powerpoint.
2. Each slide: a headline that states the point, at most 5 short bullets, or one chart (native: chart {type, categories, series}), table, or 2-4 stats. Use two_column for comparisons, section slides between parts.
3. Create with create_document (.pptx); theme light or dark, accent = brand color. Detail goes in notes.
4. Fix every FAIL in the review that comes back (overflow, missing titles, empty slides, typos) and run review_document again (max 2 rounds).
5. Report the path and the outline.
