---
name: office-word
description: Word documents that look professionally made: real styles, TOC, headers/footers, tables, images, footnotes, templates (memo, report, letter, meeting notes, proposal).
source: you
uses: 0
category: Office
---

Use create_document with a .docx path. Write the content as Markdown; the generator turns it into real Word styles (Title, Heading 1-3, Caption, Quote), so never fake headings with bold text.

1. Pick the frame first.
   - Memo: template "memo", fields {to, from, cc?, date?, subject}. Body: purpose in the first sentence, then the ask, then details. One page.
   - Letter: template "letter", fields {sender, sender_address ("line; line"), recipient, recipient_address, subject?, salutation?, closing?, signature?}. Body only (no "Dear"/"Sincerely": the template adds them unless you write them).
   - Report: template "report" (cover page, automatic TOC, header with the title, "Page X of Y"), fields {subtitle, author, organization}. Start with "## Executive summary" (3-5 sentences: the answer, the key numbers, the recommendation).
   - Proposal: template "proposal", fields {prepared_for, prepared_by, subtitle}. Sections: Summary, Goals, Approach, Scope (in/out), Timeline (table), Pricing (table with a total row), Terms, Next steps.
   - Meeting notes: use the office tool's meeting_notes action (skill office-meetings).
2. Structure: "# Title" once, "##" for sections, "###" for subsections. Never skip a level (## then ####). Every heading has content under it.
3. Tables for anything compared or counted: header row, units in headers ("Revenue ($K)"), right-aligned numbers come automatically, a caption line right under the table: "Table: Revenue by region". Totals as the last row.
4. Extras when they help: [TOC] where the contents go (auto for 4+ sections), <!-- pagebreak --> before big sections, <!-- landscape --> ... <!-- portrait --> around a wide table, footnotes text[^1] with "[^1]: Source, date", images ![alt](path.png "Figure caption") (files in the workspace or attached folders), > [!NOTE] / [!WARNING] callouts, citations: ["Source title, publisher, date" or {text, url}] for a References list.
5. Options: accent "#1F4E79" (navy, formal) or the brand color, font (default Arial), page_size "a4" outside the US, orientation "landscape" for wide documents.
6. Quality bar: no placeholders (TBD, [Name], Lorem): ask or leave the sentence out. Numbers match the source exactly with units and dates. Short paragraphs (under ~120 words). Active voice. Same tense and terms throughout.
7. create_document's result includes a review. Fix every FAIL (rebuild at the same path; a backup is kept), then run review_document again, at most 2 rounds. Then tell the user the path and a 2-line summary.

To change an existing Word file the user gave you: file_read it, rebuild with create_document at a new path (or the same path; a backup is kept), keeping their wording unless asked to change it.
