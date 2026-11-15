---
name: medical-chronic-conditions
description: Support self-management of diabetes, high blood pressure, asthma, COPD, heart failure and kidney disease: logs, action plans.
source: you
uses: 0
category: Medical
triggers: diabetes, blood sugar, high blood pressure, hypertension, asthma, copd, heart failure, kidney disease, arthritis, high cholesterol, manage my condition, chronic condition, glucose log, blood pressure log, inhaler, asthma action plan
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## General self-management toolkit
- Know the plan: targets, medicines, monitoring schedule, and action plan from the care team. Write it in one place (document or note) and set reminders (schedule, mac_apps Reminders).
- Track: a spreadsheet log with date, readings, symptoms, medicines taken, notes; chart trends for visits.
- Basics with strong evidence across conditions: not smoking, regular activity, healthy eating pattern, sleep, limiting alcohol, vaccinations recommended for the condition (check CDC), taking medicines as prescribed. Cite the relevant guideline.
- Never change medicines based on readings unless the care team's written plan says to; call them instead.

## Condition notes (verify current guidance before quoting)
- Type 2 diabetes (ADA Standards of Care, updated yearly): A1c goals are individualized (often below 7% for many adults). Low blood sugar under 70 mg/dL: the "15-15 rule" (15 g fast carbs, recheck in 15 minutes) per ADA; severe lows with confusion or unconsciousness are an emergency. Foot checks, eye exams, kidney tests yearly.
- High blood pressure (ACC/AHA): categories normal under 120/80, elevated 120-129/<80, stage 1 130-139 or 80-89, stage 2 140+/90+. Home measurement: seated 5 minutes, back supported, feet flat, arm at heart level, correct cuff size, no caffeine/exercise 30 minutes before, two readings a minute apart. Readings above 180/120: recheck; with chest pain, shortness of breath, weakness, vision or speech changes, call emergency services.
- Asthma (GINA, NAEPP): written asthma action plan with green/yellow/red zones; correct inhaler technique (spacer for many); rescue inhaler needed more than usual is a warning sign; red zone or unable to speak in sentences: emergency.
- COPD (GOLD report): action plan for flare-ups, pulmonary rehab, vaccinations.
- Heart failure (AHA/ACC/HFSA): daily morning weight; a gain of about 2-3 lb in a day or 5 lb in a week is a common "call your team" threshold (confirm with their plan); sodium and fluid guidance from their team.
- Chronic kidney disease (KDIGO): blood pressure and glucose control, avoid regular NSAID use unless the clinician approves, check medicines for kidney dosing with the pharmacist.

## Output
A one-page personal summary template, a log spreadsheet with charts (create_document .xlsx), questions for the next visit, and reliable resources (ADA, AHA, American Lung Association, NKF). Health details stay local where possible (hipaa-handling-phi).

## Pitfalls
Generic targets presented as the user's targets; supplement "cures"; alarm fatigue from single readings; missing depression and burnout that often come with chronic illness (see health-mental-health-support).
