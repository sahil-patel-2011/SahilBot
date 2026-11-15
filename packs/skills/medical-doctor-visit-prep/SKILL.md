---
name: medical-doctor-visit-prep
description: Prepare for a doctor visit: prioritized questions, symptom diary, medication list, second opinions, after-visit summary.
source: you
uses: 0
category: Medical
triggers: doctor appointment, questions to ask my doctor, prepare for appointment, specialist visit, symptom diary, symptom journal, medication list, second opinion, after visit summary, telehealth visit, what to bring to the doctor, surgery consultation
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Before the visit
1. Goal: what the user most wants from this visit (answer, test, referral, treatment change, reassurance). Put the top 3 concerns first: visits are short.
2. One-page summary (create_document .docx or .pdf):
   - Main concern with timeline (when it started, how it changed, what helps or worsens it).
   - Current medicines with strength and how taken, plus supplements and over-the-counter products.
   - Allergies and reactions; past conditions, surgeries, family history relevant to the concern.
   - Recent results and other clinicians involved.
3. Symptom diary (spreadsheet or table): date/time, symptom, severity 0-10, duration, trigger/activity, food/sleep, medicine taken, effect. 1-2 weeks of entries beats memory.
4. Question list tailored to the topic, researched from reputable sources (medical-evidence-lookup). Useful universal questions:
   - What do you think is causing this, and what else could it be?
   - What tests do you recommend, why, and what will the results change?
   - Treatment options: benefits, risks, alternatives, and what happens if we wait (the BRAN questions).
   - What should I watch for, and when should I call or go to the ER?
   - When is follow-up, and how do I get results?
5. Practical: insurance card, ID, referral if required, portal login, someone to come along or take notes, ask whether recording is allowed.

## Second opinions
Reasonable for major surgery, cancer, rare conditions or unclear diagnoses. Request records and imaging (patients have a HIPAA right of access to their records in the US); prepare a concise timeline.

## After the visit
Turn notes or a transcript into an after-visit summary: what was found, the plan, medicines changed (exactly as the clinician said; don't reinterpret), tests and dates, warning signs, follow-up. Offer to set reminders (schedule or mac_apps Reminders/Calendar) for refills, tests and follow-ups. Save the care team and appointment facts to memory only with the user's OK; prefer local storage for health details (see hipaa-handling-phi).

## Pitfalls
Too many questions with no priorities; leaving out supplements; "doctor-shopping" for a desired answer rather than a real second opinion; changing medicines based on internet research before talking to the prescriber.
