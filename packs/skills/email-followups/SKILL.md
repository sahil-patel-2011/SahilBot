---
name: email-followups
description: Track threads awaiting a reply (theirs or the user's) and suggest follow-ups, a routine or a goal.
source: you
uses: 0
category: Email
---

1. Two lists:
   - Waiting on others: the user sent the last message, it asked something, and no answer for 3+ business days. Find them in Sent (mail search mailbox="Sent" since="21d"; Gmail `in:sent newer_than:21d`), then check whether the thread has a newer reply.
   - The user owes a reply: someone asked them something 2+ days ago and the last message in the thread isn't from the user.
2. For each: who, subject, days waiting, what's outstanding, and a one-line suggested nudge. Skip automated senders and threads that ended with "thanks".
3. Offer to draft the nudges (email-drafting rules: short, friendly, one clear ask; never send without a yes). Flag the important ones in Mail (mail action "flag") so they stand out, if the user wants.
4. Make it stick: suggest a routine ("Every weekday at 4 pm, list threads waiting 3+ days and draft nudges, don't send") with the schedule tool, created paused or only after the user agrees. For something with an end date ("get the contract signed by the 30th"), propose a goal with find_tools("goal") instead.
5. Keep a short list in your notes of threads you're tracking (subject + id), so the next run can say what changed.
