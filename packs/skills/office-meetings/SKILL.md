---
name: office-meetings
description: Meeting transcript or rough notes to clean notes with decisions, action items (owner, due date) and open questions; follow-ups offered.
source: you
uses: 0
category: Office
---

1. Get the source: a transcript file (.txt, .vtt, .srt, .docx, .pdf) or pasted text. Read all of it (file_read) before writing.
2. Work out, in your own words:
   - summary: 2-4 sentences on what was decided and why it matters.
   - decisions: each as one sentence, exactly as agreed (include numbers and dates).
   - actions: [{task (starts with a verb), owner (a named person; "Unassigned" only if nobody took it), due (as said: "Friday", "end of month", "11/20")}].
   - topics: [{title, notes: [key points]}] for the discussion, questions: what's still open, next_meeting if set.
3. office meeting_notes(path or transcript, meeting: {title, date (the meeting's date, so "Friday" resolves to a real date), attendees, summary, decisions, actions, topics, questions, next_meeting}, out?: "Notes 2026-11-14.docx" | .md | .pdf).
4. Read its result: add any "Possibly missed" items that are real, fix owners/dates it warns about (call again), and make sure the review passes.
5. Reply with the decisions and the action list (owner, due date). Offer once to add the actions as Reminders (mac_apps) or calendar events, or to draft the follow-up email (draft only; never send without a clear yes).

Never invent owners, dates or decisions; mark what was unclear as an open question.
