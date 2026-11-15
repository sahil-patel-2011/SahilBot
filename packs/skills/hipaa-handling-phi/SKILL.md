---
name: hipaa-handling-phi
description: Handle patient data safely in SahilBot: scan for PHI, local models, BAA before cloud or connectors, redact, no PHI in memory.
source: you
uses: 0
category: HIPAA
triggers: patient data, patient record, patient chart, phi in chat, redact phi, anonymize patient, share patient info, send patient records, upload medical records, hipaa safe ai, can i paste patient, remove identifiers, scrub phi, de-identify, patient note
---

## Before touching patient data
1. Detect: run the PHI helper (phi_scan with action "scan", when the tool is available) on pasted text or file contents; otherwise check manually against the 18 identifiers (hipaa-phi-basics). Names, dates, MRNs, phones, emails, addresses, SSNs and photos are the common ones.
2. Ask where it will go: which model is answering (local or cloud) and which tools will see it.
3. Decide using the rules below; tell the user plainly what you'll do and why.

## Rules
- Models: prefer a local model for PHI (Settings → Models → Auto (local), via Ollama). Send PHI to a cloud model only if the user confirms their setup allows it (their organization has a BAA with that provider covering this use and zero-retention terms where required). Don't assume a BAA exists; if unknown, de-identify first or stay local. Personal use of one's own health data isn't HIPAA-covered, but still default to local and minimum data.
- Connectors and the web: never send PHI to Gmail, Slack, Notion, Google Drive, HubSpot, web forms, search engines, image or batch services, or any third party unless the user confirms a BAA covers it. Never put identifiers in a web search query or URL.
- Minimum necessary: use only the fields needed for the task; strip the rest before analysis.
- Redact or de-identify before sharing outside the care team: phi_scan "redact" replaces identifiers with typed placeholders like [NAME] or [DATE]; review the result yourself (detectors miss things, e.g. unusual names or free-text clues like "the mayor's wife") and show the user what changed.
- Memory and skills: never save PHI to memory, rules or skills. Patient-specific notes stay in the user's own files.
- Files: keep PHI files in the workspace or the practice's approved storage, not in shared or public folders; suggest FileVault disk encryption and screen lock. Delete scratch copies only with the user's approval (file deletes always ask).
- Email or messages to patients: drafts only; the practice's secure messaging is preferred; never send without the user's approval.

## Audit-trail mindset
Keep a short log in the reply or the project notes: what PHI was used, for what purpose, which model/tool processed it, where outputs were saved, what was redacted. This mirrors HIPAA's audit controls and helps if questions arise later.

## If something goes wrong
PHI sent to the wrong place or a tool without a BAA: stop, tell the user exactly what was sent where and when, and point to hipaa-breach-response (it may need a breach risk assessment; the practice's privacy officer decides).

## Worked example
User pastes a referral note with name, DOB, MRN and phone and asks for a summary while a cloud model is active. Response: "This note contains PHI (name, date of birth, MRN, phone). I can (a) switch to a local model, (b) redact identifiers first and summarize the redacted version, or (c) proceed on this cloud model if your organization has a BAA covering it. Which do you want?"

## Caveat
Compliance decisions belong to the practice's privacy/security officer; consult a compliance professional for policies.
