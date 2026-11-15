---
name: medical-lab-results
description: Explain lab and blood test results (CBC, metabolic panel, A1c, lipids, thyroid, kidney) with typical ranges and caveats.
source: you
uses: 0
category: Medical
triggers: lab results, blood test results, blood work, cbc, metabolic panel, cmp, bmp, cholesterol results, a1c, hemoglobin, white blood cell, platelets, creatinine, egfr, tsh, liver enzymes, urinalysis, what does my result mean, out of range, alt level
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Rules for labs
- The lab's own reference range on the report wins; ranges vary by lab, method, age, sex and pregnancy. Typical adult ranges below are approximate and for orientation only.
- One slightly abnormal value is common and often not meaningful (about 5% of healthy people fall outside a range by definition). Trends and the whole picture matter.
- Critical values (e.g. potassium above ~6.0 or below ~2.5 mmol/L, sodium below ~120 mmol/L, glucose below ~54 mg/dL with symptoms) or a lab calling the patient urgently: tell them to contact their clinician now or seek urgent care.

## Typical adult ranges (approximate; cite MedlinePlus or the lab)
- Hemoglobin: ~13.5-17.5 g/dL (men), ~12.0-15.5 g/dL (women). WBC ~4,500-11,000 /µL. Platelets ~150,000-450,000 /µL.
- Sodium 135-145 mmol/L; potassium ~3.5-5.0 mmol/L; creatinine ~0.6-1.3 mg/dL; eGFR 90+ normal, below 60 for 3+ months meets the kidney disease definition (KDIGO).
- Fasting glucose 70-99 mg/dL; 100-125 prediabetes range; 126+ diabetes range if repeated (ADA). A1c below 5.7%; 5.7-6.4% prediabetes; 6.5%+ diabetes range (ADA Standards of Care).
- Lipids: LDL targets depend on overall cardiovascular risk (AHA/ACC); triglycerides below 150 mg/dL normal; HDL higher is generally better.
- TSH ~0.4-4.0 mIU/L (lab-dependent); interpret with free T4.
- ALT/AST: lab-specific upper limits (often ~35-55 U/L).
- PSA: no single normal; age, prostate size, medicines (5-alpha reductase inhibitors roughly halve PSA) and recent ejaculation or infection affect it; see medical-urology-mens-health.

## Workflow
1. Read the report (file_read for PDFs/images; OCR if scanned). If identifiers are present, follow hipaa-handling-phi.
2. Table: test, value, lab range, flag, plain meaning, common reasons for high/low (several, not one), what clinicians often check next.
3. Note patterns (e.g. low hemoglobin + low MCV suggests possible iron deficiency to discuss) without diagnosing.
4. Put results over time in a spreadsheet with a chart if they have several dates.
5. Questions for their clinician.

## Pitfalls
Converting units wrongly (mmol/L vs mg/dL: glucose mg/dL = mmol/L x 18; cholesterol mg/dL = mmol/L x 38.67); ignoring the lab's range; alarming over borderline values; missing that fasting, hydration, exercise or supplements (biotin affects some immunoassays) can shift results.

## Verify
Every range and threshold cited with source and year; units double-checked; urgent values called out first.
