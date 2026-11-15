---
name: medical-explain-conditions
description: Explain a diagnosis, condition, procedure or radiology/pathology report in plain language from reputable sources.
source: you
uses: 0
category: Medical
triggers: explain my diagnosis, i was diagnosed with, what does this condition mean, explain this report, mri report, ct report, pathology report, prognosis, surgery explained, explain this condition, what is this condition, explain the surgery
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Approach
1. Clarify: the exact condition or report wording, who it's for (the user, a child, a parent), and what they want (overview, a specific worry, preparing questions). If they paste a report with identifiers, see hipaa-handling-phi for redaction and local-model guidance.
2. Sources: MedlinePlus, NIH institutes, NHS, CDC, specialty society patient pages, and the current guideline for details (see medical-evidence-lookup). Use web_search/fetch_page and research; cite each.
3. Explain at about a 6th-8th grade reading level: short sentences, define every medical term once, one analogy if it helps (e.g. "an enlarged prostate squeezing the urine tube like a hand around a garden hose").

## Structure
- What it is (1-2 sentences).
- Why it happens / risk factors.
- Common symptoms and how it usually progresses.
- How it's diagnosed (tests a clinician might order and why).
- Treatment options in general: lifestyle, medicines (classes, not personal doses), procedures; benefits and trade-offs.
- Outlook in general terms with sourced numbers where available (e.g. 5-year survival from SEER for cancers), noting that individual outlook depends on many factors.
- Warning signs that need urgent care.
- Questions to ask their clinician (see medical-doctor-visit-prep).

## Reports (radiology, pathology, operative)
Translate section by section: findings, impression. Explain common terms ("unremarkable" = normal; "incidental" = found by chance; "clinical correlation recommended" = the doctor should match this with symptoms). Point out anything the report flags as needing follow-up, without speculating beyond it. Never interpret images yourself as a diagnosis.

## Pitfalls
Alarming with worst cases; false reassurance; mixing up similar conditions; outdated statistics. Keep emotional tone calm and kind: a new diagnosis is stressful.

## Verify
Re-check names, numbers and terms against sources; include the date of sources; end with a gentle prompt to discuss specifics with their care team.
