---
name: medical-evidence-lookup
description: Answer medical questions from the evidence: guidelines first, then systematic reviews and trials via PubMed, cited and dated.
source: you
uses: 0
category: Medical
triggers: medical evidence, latest guidelines, studies show, health claim, evidence based, guideline recommendation, effective treatment for, latest evidence, evidence say, evidence for, systematic review, cochrane
---

## Safety rules (always apply)
- General information, not a substitute for professional medical care. Encourage the user to see a clinician about their own situation.
- Emergency signs (chest pain or pressure, trouble breathing, stroke signs such as face droop, arm weakness or slurred speech, severe bleeding, fainting, seizure, severe allergic reaction, sudden severe pain, thoughts of suicide or harming someone): tell them to call emergency services (911 in the US) or go to the nearest emergency department now, before anything else.
- Cite sources (organization or journal, title, year, link) and give the date of the information; say what is uncertain or debated.
- No definitive diagnosis: describe possibilities and what a clinician would check.
- No personalized dosing: never tell someone to start, stop or change a medicine or dose. Quote labeled ranges only, with "confirm with your pharmacist or doctor".

## Hierarchy of evidence (strongest first)
1. Current clinical practice guidelines from credible bodies that grade evidence (GRADE or similar): USPSTF (screening and prevention), NICE, WHO, CDC (infections, vaccines), AHA/ACC (heart), ADA (diabetes), AUA/EAU (urology), ACOG, AAP, IDSA, specialty societies. Check the publication year and whether an update exists.
2. Systematic reviews and meta-analyses (Cochrane, high-quality journals).
3. Randomized controlled trials.
4. Cohort and case-control studies (association, not proof of cause).
5. Case series, mechanistic and animal studies, expert opinion (weakest; never present as proof).

## Workflow
1. Restate the question in PICO form: Population, Intervention, Comparison, Outcome.
2. Guidelines: web_search for "<condition> guideline <society> <year>" and fetch_page the official source.
3. Literature: research(source="pubmed", query="<topic>[tiab] AND (systematic review[pt] OR meta-analysis[pt] OR guideline[pt])"), then research(source="pubmed_abstract", ids=[...]) before relying on any paper. For ongoing trials: research(source="clinical_trials"). For drugs: research(source="drug_label").
4. Patient-friendly references for plain-language framing: MedlinePlus, NIH institutes, NHS, CDC.
5. Check the user's knowledge vault (knowledge_search) if they have papers or notes on the topic.
6. Synthesize: bottom line first, then strength of evidence (high / moderate / low / very low), key numbers with absolute effects (e.g. "reduces risk from 4% to 3% over 5 years"), harms, what's uncertain, and what guidelines disagree on.

## Answer format
- Bottom line (2-3 sentences).
- What the evidence shows (with citations: org/journal, year, PMID or URL).
- Strength and gaps; date checked.
- What to discuss with a clinician.

## Pitfalls
Single studies or press releases presented as settled; relative risk without absolute risk; old guidelines superseded by updates; supplement and wellness claims based on mechanistic or animal data; retracted papers (check Retraction Watch or the PubMed notice); preprints not yet peer reviewed (label them).

## Verify
Every claim traced to a source you actually read in this session; numbers copied exactly as stated; publication dates shown. Never invent studies, statistics, PMIDs or doses.
