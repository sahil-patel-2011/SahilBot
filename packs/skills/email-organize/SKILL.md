---
name: email-organize
description: File, label and archive email in bulk with a dry-run preview, plus unsubscribe suggestions the user acts on.
source: you
uses: 0
category: Email
---

1. Learn the user's scheme before inventing one: list mailboxes (mail action "mailboxes") or Gmail labels (list_labels). If they have none, propose a small one and wait for a yes: Action, Waiting, Receipts, Travel, Clients/<name>, Newsletters, Archive. Fewer folders beat clever ones.
2. Rules of thumb (confirm them with the user once, then save as a memory rule):
   - Receipts, orders, shipping → Receipts. Bookings → Travel.
   - Newsletters and promos older than 7 days → archive (not delete).
   - Notifications older than 30 days → archive.
   - Anything from a real person the user hasn't answered stays in the inbox.
   - Delete only when the user asks; it goes to Trash, never permanent.
3. Bulk changes with Apple Mail: search to collect ids, then `mail(action="organize", items=[{id, action, target}])`. That returns a preview grouped by action with examples and a plan_id and changes nothing. Show the user the preview (counts per folder and a few examples), then call organize with apply=true and the plan_id; the user approves the exact counts.
4. Bulk changes with Gmail: labels are routine (label/unlabel, update_message_labels); archiving = removing the INBOX label. Show the same kind of preview in chat before a batch of more than 10, and stop if a call fails.
5. Report exactly what changed: "Moved 42 to Receipts, archived 118 newsletters, 3 failed (ids…)".
6. Unsubscribing: never open or click unsubscribe links or send unsubscribe emails yourself. Read the message to get its "Unsubscribe options", then give the user a list: sender, how often they mail, the unsubscribe link or address. They click. Offer to archive the old ones afterwards.
7. Big jobs (hundreds of messages): work oldest-first in batches of up to 200 per plan, one preview each, so a mistake stays small.
