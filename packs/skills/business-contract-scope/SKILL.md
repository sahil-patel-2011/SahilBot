---
name: business-contract-scope
description: Look up what scope was agreed with a client from signed SOWs, contracts and emails, with exact clause citations and conflicts flagged.
source: you
uses: 0
category: Business
triggers: what scope did we agree, agreed scope, scope of work, statement of work, sow, in scope, out of scope, scope creep, what did we agree with, what does the contract say, contract terms with, change order, deliverables we agreed
---

## 1. Pin the question
Which client, which project or engagement, and the specific question (a deliverable, a number of revisions, hours, a deadline, payment terms, who owns what). "What scope did we agree with Client C?" means the full current scope; "is X in scope?" needs a yes/no with the clause.

## 2. Search the brain first
- `about` lookup for the client: contacts, project names, contract dates, notes.
- `vault` search for the project, the client and "SOW" / "contract"; memory search for decisions and earlier summaries.

## 3. Then the documents and email
- Drive / Dropbox / OneDrive / local files (find_tools("drive"), file search): the signed contract or MSA, SOWs, order forms, change orders, amendments, proposals. Prefer the signed or executed version (DocuSign/PDF with signatures, "executed", "final"); note the date and version of each.
- Email (mail or Gmail search: client name, "SOW", "scope", "change order", "amendment", "out of scope", "additional"): threads after the signature date where scope was discussed, added or cut.
- Read the actual text (file_read, office/pdf tools); never answer from a file name or snippet.

## 4. Work out the agreed scope
- The signed document is the baseline: list deliverables, quantities (pages, revisions, hours, users), milestones and dates, acceptance criteria, assumptions, exclusions, fees and payment terms, change-order process.
- Layer on written amendments and signed change orders, in date order.
- Later emails: an email that says "let's add X" changes scope only if the contract allows changes that way (some require a signed change order) and both sides agreed in writing. Otherwise it's a request, not agreed scope.
- Rule: the signed document wins unless amended in writing as the contract requires. Flag every conflict between the signed doc and later emails explicitly.

## 5. Answer with citations
- Lead with the answer: "Agreed scope for Client C (SOW signed Mar 3): 3 landing pages, 2 revision rounds, launch by May 1 [Signed SOW §2.1, §2.4]."
- Each item with its citation chip: document name, section or clause, date ("Signed SOW §2", "MSA §7.2 · Jan 10", "Email · Oct 14 from Dana").
- Quote the key clause words exactly (short) when the wording matters.
- Conflicts: "Email · Oct 14 asks for a 4th page; SOW §5 requires a signed change order; none found, so it's out of scope as of today."
- Out of scope: items requested but not agreed, and items the SOW excludes.
- Unknowns: what you couldn't find (e.g. no signed copy, only a draft).
Offer next steps: a polite out-of-scope reply or a change-order draft (never sent without the user's OK), and a vault note summarizing the scope with links.

## Caveats
This is a factual lookup of the documents, not legal advice. Contract interpretation, enforceability, disputes or anything with real money at stake: consult a lawyer. See business-legal-admin for the contract checklist.

## Pitfalls
Using a draft or proposal as if signed; missing an amendment; treating a friendly email as a binding change; quoting a clause without its section number.
