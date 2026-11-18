---
name: business-invoice-collections
description: Chase overdue invoices: find unpaid ones, check what clients promised, age them and draft polite-to-firm reminders for approval.
source: you
uses: 0
category: Business
triggers: overdue invoices, unpaid invoices, invoice reminder, payment reminder, chase payment, collections, late payment, aging report, accounts receivable aging, who owes me, past due, invoice follow up, client hasn't paid
---

## 1. Find the overdue invoices
- Accounting app first, if connected (find_tools("quickbooks"), "xero", "stripe", "freshbooks", "wave"): open invoices with number, client, amount, issue date, due date, amount paid, last reminder.
- No connector: ask for an export (CSV/Excel) or the list; never guess amounts.
- Bucket by days past due: current, 1-30, 31-60, 61-90, 90+. Total per bucket and per client.

## 2. Check what each client said (brain first, then email)
- `about` lookup for the client (contact, terms, relationship notes), `vault` search for the project, memory search for past promises.
- Email (mail or Gmail search: client name, invoice number, "invoice", "payment", "remittance"): the latest message about the invoice. Note any promise to pay ("said they'd pay Friday"), disputes, partial payments, a wrong billing contact or a missing PO number.
- A dispute is not a late payment: list it separately and suggest resolving the issue before chasing.

## 3. Reminder ladder (match tone to age and history)
1. Due soon / 1-7 days late, friendly: "Hi <name>, a quick note that invoice #<n> for $<amt> was due <date>. Here's the link: <link>. Let me know if you need anything from us to process it."
2. 8-30 days, direct: "Following up on invoice #<n> ($<amt>), now <x> days past due. Could you confirm when payment will go out?"
3. 31-60 days, firm: "Invoice #<n> ($<amt>) is <x> days overdue. Please arrange payment by <date>. Per our agreement, late fees of <terms> apply after <date>." (Only cite fees the contract actually allows; check with business-contract-scope.)
4. 60+ days, final notice: state the amount, the deadline, and the next step (pausing work, a payment plan, a collections agency or small-claims court). Suggest a call first for good clients.
Always: invoice number, amount, original due date, a pay link, one clear ask. Polite even when firm; no threats you won't carry out.

## 4. Draft, never send
Draft each reminder (email drafts or the chat), grouped by client. Never send, add late fees or change an invoice without the user's OK. Offer to schedule the next rung (schedule tool, created only after the user agrees).

## 5. Log promises and escalate
Record each promise to pay with date and source in the vault (or memory): "Client B: will pay Friday, Nov 21 (Email · Nov 17)". On the promised date, check whether it arrived. Escalate when a promise is broken twice or the invoice is 60+ days late: a call, a payment plan, pausing new work. Stop service only if the contract allows it and the user decides; for collections agencies, small claims or legal demand letters, consult a lawyer, and an accountant for bad-debt write-offs.

## Output
Lead with one line, then the detail, with source chips:
"3 overdue ($8,450). Client B said they'd pay Friday (Email · Nov 17). Reminders drafted for A and C."
| Client | Invoice | Amount | Days late | Last contact | Promise / dispute | Next step | Source |
Then the drafts, ready for review.

## Pitfalls
Chasing an invoice that was paid (check payments and remittance emails first); emailing the wrong contact; a tone that burns a good client; forgetting partial payments and credits.
