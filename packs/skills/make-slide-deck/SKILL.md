---
name: make-slide-deck
description: Build a clear PowerPoint (pptx) presentation.
source: you
uses: 0
category: Office
---

1. Plan the story first: one message per slide, 6-12 slides for most talks. Title → problem → key points → evidence → recommendation → next steps.
2. Each slide: a headline that states the point (not a topic label), at most 5 short bullets, or one chart/table.
3. Create with create_document (format pptx). Use speaker notes for detail instead of crowding slides.
4. Re-read the file with file_read to check every slide's text, order and that nothing overflows.
5. Report the path and the outline.
