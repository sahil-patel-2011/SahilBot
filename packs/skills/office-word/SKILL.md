---
name: office-word
description: Word documents that look professionally made: real styles, themes, TOC, headers/footers, tables, native charts, images, footnotes, templates (memo, report, letter, meeting notes, proposal, resume, invoice), fit to N pages, render check without Word.
source: you
uses: 0
category: Office
---

Use create_document with a .docx path. Write the content as Markdown; the generator turns it into real Word styles (Title, Heading 1-4, Caption, Quote, TOC field), so never fake headings with bold text.

1. Pick the frame first.
   - Memo: template "memo", fields {to, from, cc?, date?, subject}. Body: purpose in the first sentence, then the ask, then details. One page: add fit_pages: 1.
   - Letter: template "letter", fields {sender, sender_address ("line; line"), recipient, recipient_address, subject?, salutation?, closing?, signature?}. Body only (no "Dear"/"Sincerely": the template adds them unless you write them).
   - Report: template "report" (cover page, automatic TOC with page numbers, header with the title, "Page X of Y"), fields {subtitle, author, organization}. Start with "## Executive summary" (3-5 sentences: the answer, the key numbers, the recommendation).
   - Proposal: template "proposal", fields {prepared_for, prepared_by, subtitle}. Sections: Summary, Goals, Approach, Scope (in/out), Timeline (table), Pricing (table with a Total row), Terms, Next steps.
   - Resume: template "resume": "# Name", a contact line, "## Experience" with "### Role — Company | 2021 – Present" (dates go to the right margin), bullets with results. Fits one page automatically.
   - Invoice: template "invoice", fields {sender, sender_address, recipient, recipient_address, invoice_number, date, due_date, po_number?, terms?}; body = the line-items table (Subtotal / Tax / "Total due" rows) and payment notes.
   - Meeting notes: use the office tool's meeting_notes action (skill office-meetings).
2. Structure: "# Title" once, "##" for sections, "###" for subsections. Never skip a level. Every heading has content under it.
3. Tables for anything compared or counted: header row, units in headers ("Revenue ($K)"), numbers right-align automatically, "Table: caption" right under the table, totals as the last row starting with "Total".
4. Charts: a fenced ```chart block of JSON {type: column|bar|line|area|pie|doughnut, title, categories, series: [{name, values}], number_format} becomes a native, editable Word chart. Use only real numbers.
5. Extras when they help: [TOC] where the contents go (auto for 4+ sections), <!-- pagebreak --> before big sections, <!-- landscape --> ... <!-- portrait --> around a wide table, footnotes text[^1] with "[^1]: Source, date", images ![alt](path.png "Figure caption"), > [!NOTE] / [!WARNING] callouts, citations [{text, url}] for References.
6. Look and layout are options, never hand edits: theme (modern | classic | minimal; matches the PDF and deck), accent (brand color; too-light colors are darkened for text), font, font_size (pt), margins (inches, or {top, right, bottom, left}), page_size (letter | a4 | legal), orientation, fit_pages (N: tightens spacing, then type and margins within readable limits, and says what it changed). The result reports the page count as Word lays it out.
7. Quality bar: no placeholders (TBD, [Name], Lorem): ask or leave the sentence out. Numbers match the source exactly with units and dates. Short paragraphs (under ~120 words). Active voice. Same tense and terms throughout.
8. Check: create_document's result includes a review with the rendered page count (Word isn't needed: macOS Quick Look lays the file out). Fix every FAIL. Then review_document(path) once and look at the attached pages; ask for pages: "1" to see one full size. If it must fit N pages, rebuild with fit_pages: N and review with expect_pages: N. At most 2 rounds, then tell the user the path, page count and a 2-line summary.

Never unzip a .docx and edit word/document.xml or styles.xml (margins, fonts, sizes): rebuild with create_document and the options above (a backup of the old file is kept).

To change an existing Word file the user gave you: file_read it, rebuild with create_document at a new path (or the same path; a backup is kept), keeping their wording unless asked to change it.
