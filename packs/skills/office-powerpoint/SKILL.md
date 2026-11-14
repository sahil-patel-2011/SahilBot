---
name: office-powerpoint
description: PowerPoint decks with a consistent theme, real layouts, native charts, tables, speaker notes and slide numbers, without text overflow.
source: you
uses: 0
category: Office
---

create_document with a .pptx path and slides. 16:9, slide numbers on, theme "light" (default) or "dark", accent = brand color.

1. Write the storyline first: one message per slide, titles that state the point ("Churn fell to 2% after onboarding changes", not "Churn"). Typical: title → agenda (optional) → 1 slide per key point with evidence → recommendation → next steps → closing. 6-12 slides for a 15-minute talk.
2. Pick the layout for the content:
   - bullets: 3-5 short bullets (≤ 12 words each); sub-points indented with two spaces.
   - chart: chart {type: column|bar|line|area|pie|doughnut, categories, series: [{name, values}], number_format: "$#,##0" or "0%"} with 1-2 bullets as the takeaway. Line for trends over time, column for comparing categories, bar for long labels or rankings, pie/doughnut only for parts of one whole (≤ 6 slices).
   - table: table [[headers], [rows]] for exact figures (≤ 8 rows reads best; longer tables continue on extra slides).
   - stats: 2-4 big numbers {value, label}.
   - two_column: before/after, pros/cons, options (left_title/right_title).
   - image_text / image: a picture from the workspace with bullets or a caption.
   - section (dividers), quote (title = quote, subtitle = who), closing (thanks + contact or the ask).
3. Detail goes in notes (what to say), not on the slide. Long bullets are shortened automatically with the full text moved to the notes, and overfull slides continue on "(cont.)" slides: better to write them short in the first place.
4. Numbers on slides match the source exactly; charts get the real data, never invented series.
5. The result includes a review (overflow, empty slides, missing titles, typos, placeholders). Fix every FAIL, review_document again (max 2 rounds), then give the user the path and the outline.

To edit a deck the user has open in PowerPoint, use the app tool (app-office skill); to rebuild one, file_read it and create_document again.
