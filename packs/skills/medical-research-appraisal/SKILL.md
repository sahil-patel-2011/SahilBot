---
name: medical-research-appraisal
description: Appraise a medical research paper: design, bias, absolute vs relative risk, NNT, confidence intervals, applicability.
source: you
uses: 0
category: Medical
triggers: read this paper, appraise study, critical appraisal, is this study good, journal club, explain this research paper, confidence interval, p value, hazard ratio, number needed to treat, relative risk, randomized trial, meta analysis, study limitations
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Get the paper
Attached PDF: file_read. Otherwise research(source="pubmed") or research(source="doi"), then research(source="pubmed_abstract"); full text from PubMed Central when open. For trials, check the registration (research(source="clinical_trials")) and compare registered vs reported outcomes. Check for retractions or corrections.

## Appraisal checklist
1. Question (PICO) and whether the design fits it: RCT for treatment effects; cohort/case-control for harms and risk factors; diagnostic accuracy studies for tests; systematic reviews to combine evidence.
2. Population: who was included/excluded; does it match the reader's situation?
3. RCTs: randomization and allocation concealment; blinding; baseline balance; dropouts and intention-to-treat; pre-registered primary outcome; trial stopped early; industry funding and author conflicts (see disclosures).
4. Observational: confounding and how it was adjusted; selection and recall bias; reverse causation; dose-response; residual confounding.
5. Systematic reviews: search breadth, risk-of-bias assessment, heterogeneity (I² high means results vary), publication bias (funnel plot).
6. Outcomes: patient-important (death, function, symptoms) vs surrogate (lab values); composite outcomes driven by the softest component.
7. Statistics:
   - Absolute risk reduction (ARR) = control risk - treatment risk; NNT = 1/ARR. Example: 2% → 1% is a 50% relative reduction but ARR 1%, NNT 100.
   - Confidence interval: range of plausible effects; one crossing 1.0 (ratios) or 0 (differences) means no clear effect. A p-value is not the size or importance of an effect.
   - Hazard ratio 0.80 ≈ 20% lower rate over time, not 20 points.
   - Subgroup findings are hypothesis-generating unless pre-specified and tested for interaction.
   - Diagnostic: sensitivity, specificity, predictive values depend on prevalence.
8. Applicability and harms; how it fits the guideline and other evidence (GRADE: high, moderate, low, very low certainty).

## Output
Plain-language summary, a structured table (design, n, population, intervention/comparator, primary outcome with effect size and CI, key harms, follow-up), strengths, limitations, bottom line and certainty, citation with DOI/PMID. Save to the knowledge vault if the user keeps a literature folder.

## Pitfalls
Taking abstracts at face value; spin in conclusions; confusing association with causation; ignoring absolute numbers; treating preprints as peer-reviewed.
