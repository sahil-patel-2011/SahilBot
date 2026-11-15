---
name: medical-clinical-documentation
description: Draft clinician documentation for review: SOAP and progress notes, referral and prior-auth letters, handouts; no invented findings.
source: you
uses: 0
category: Medical
triggers: soap note, write a progress note, history and physical, clinical note, discharge summary, referral letter, prior authorization letter, letter of medical necessity, patient handout, chart note, dictation to note, procedure note, consult note
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Ground rules for clinician-facing drafts
- Draft only from what the clinician provides (dictation, transcript, bullet notes). Never invent exam findings, vitals, results, history or ROS items; mark gaps as [not documented] or [confirm].
- Label every output "Draft for clinician review" and keep the clinician as the decision-maker on assessment, plan and orders.
- PHI: follow hipaa-handling-phi. Prefer a local model; don't send PHI to cloud models or connectors unless the user's setup has a BAA; use minimum necessary data; scan with the PHI helper and offer redaction before sharing outside the practice.

## SOAP note structure
- S: chief complaint (patient's words), HPI (onset, location, duration, character, aggravating/relieving, radiation, timing, severity, associated symptoms), pertinent ROS, PMH/PSH, medications, allergies, social and family history as relevant.
- O: vitals, exam by system, results with dates.
- A: problem list with assessment per problem (differential as the clinician states it).
- P: per problem: diagnostics, treatment, education, follow-up, return precautions.
Keep it concise and specific; avoid copy-forward of stale data; date and time stamps; standard abbreviations only (avoid the Joint Commission "Do Not Use" list, e.g. "U", "QD").

## Letters
- Referral: question for the consultant, pertinent history, results, urgency, what's been tried.
- Prior authorization / medical necessity: diagnosis (ICD-10-CM as the clinician selects), treatment requested, payer criteria met point by point (look up the payer's policy if public), prior treatments and outcomes, supporting guideline citations.

## Patient handouts and after-visit summaries
Reading level about 6th-8th grade; what it is, what to do, medicine instructions copied exactly from the clinician's plan, warning signs and when to call or go to the ER, follow-up; cite guideline sources for the clinician. See patient-education.

## Tools
Transcripts via transcribe (local whisper if configured); templates from the practice saved in memory or the knowledge vault; create_document for .docx/.pdf; review_document before sharing. Coding support: medical-coding-billing.

## Verify
Read the draft against the source notes line by line: every fact traceable, no added findings, medicines and doses exactly as given, missing items flagged. Remind that the signed note is the clinician's legal record.
