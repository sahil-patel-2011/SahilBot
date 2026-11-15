---
name: medical-medications
description: Look up a medication from its label: uses, labeled dose ranges, side effects, interactions, red flags; never dose changes.
source: you
uses: 0
category: Medical
triggers: medication, medicine, side effects, drug interaction, dose of, dosage, how much can i take, missed dose, mix with alcohol, over the counter, prescription, generic vs brand, supplement interaction, antibiotic, drug label, take with food
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Sources (in order)
1. Official label: research(source="drug_label", query="<generic name>") (FDA label via openFDA); DailyMed for the full label; EMA or national regulators outside the US.
2. MedlinePlus drug pages for plain language.
3. Guidelines for how a drug class is used (e.g. AHA/ACC for statins); the Beers Criteria (AGS) for older adults.
Always use the generic name, list common brand names, and cite label date or version.

## What to report
Uses (labeled indications; mention off-label use only as "sometimes used for, per <source>"); typical labeled adult dose range exactly as the label states, with "confirm with your pharmacist or doctor"; how to take (food, timing); boxed warnings; common vs serious side effects; contraindications; pregnancy/breastfeeding notes from the label; storage; what to do about a missed dose as the label says.

## Interactions
Check both drugs' labels. Flag clearly significant combinations, for example: nitrates with PDE5 inhibitors (sildenafil, tadalafil) can cause dangerous low blood pressure; warfarin with NSAIDs, many antibiotics or some supplements raises bleeding risk; serotonergic combinations (SSRIs/SNRIs with MAOIs, tramadol, linezolid) risk serotonin syndrome; opioids or benzodiazepines with alcohol or each other can stop breathing; ACE inhibitors/ARBs with potassium supplements or spironolactone can raise potassium. Suggest a pharmacist review for any multi-drug regimen.

## Red flags to stop and seek care now
Signs of severe allergic reaction (swelling of face or throat, trouble breathing, widespread hives), severe rash with blisters or peeling, black stools or vomiting blood, fainting, chest pain, signs of overdose. Suspected overdose or poisoning: emergency services, or Poison Control (US 1-800-222-1222).

## Hard limits
- Never tell someone to start, stop, skip, double or adjust a dose, or to split, crush or substitute a drug: that is the prescriber's or pharmacist's call. Explain the general rule from the label and send them to their pharmacist.
- Never compute doses for children, weight-based or kidney/liver-adjusted doses for an individual.
- No help obtaining prescription drugs without a prescription.

## Format
Short summary, a table (use, usual labeled range, key side effects, warnings, interactions), citations with dates, and 2-3 questions to ask the pharmacist. Medication lists the user wants kept can go in memory (ask first) or a spreadsheet.
