---
name: hipaa-phi-basics
description: Explain HIPAA basics: PHI, the 18 Safe Harbor identifiers, minimum necessary, permitted uses, de-identification methods.
source: you
uses: 0
category: HIPAA
triggers: hipaa, what is phi, protected health information, 18 identifiers, deidentification, safe harbor method, expert determination, minimum necessary, covered entity, business associate, limited data set, is this phi, hipaa privacy rule, hipaa identifiers, de-identification
---

## Scope and disclaimer
General education about US HIPAA (45 CFR Parts 160 and 164), not legal advice. Cite HHS Office for Civil Rights (hhs.gov/hipaa) pages with dates. State laws (e.g. California CMIA, Texas HB 300) and other rules (42 CFR Part 2 for substance use treatment records, FTC Health Breach Notification Rule for many consumer health apps) may add requirements. For decisions, consult a healthcare compliance professional or attorney.

## Who HIPAA covers
Covered entities: health plans, health care clearinghouses, and providers who conduct standard electronic transactions (e.g. billing insurance). Business associates: vendors that create, receive, maintain or transmit PHI for them (billing, IT, cloud, transcription, AI services) and must sign a Business Associate Agreement (BAA). An individual managing their own health information is not a covered entity, but the same care is wise.

## PHI
Individually identifiable health information (past, present or future health condition, care, or payment for care) held or sent by a covered entity or business associate, in any form: electronic (ePHI), paper or spoken. Employment records and education records covered by FERPA are excluded.

## The 18 Safe Harbor identifiers (of the patient or relatives, employers, household members)
1 names; 2 geographic units smaller than a state (street, city, county, ZIP; first 3 ZIP digits allowed only if that area has more than 20,000 people); 3 all date elements except year related to the person (birth, admission, discharge, death) and ages over 89 (group as 90+); 4 phone numbers; 5 fax numbers; 6 email addresses; 7 Social Security numbers; 8 medical record numbers; 9 health plan beneficiary numbers; 10 account numbers; 11 certificate/license numbers; 12 vehicle identifiers and license plates; 13 device identifiers and serial numbers; 14 URLs; 15 IP addresses; 16 biometric identifiers (finger, voice prints); 17 full-face photos and comparable images; 18 any other unique identifying number, characteristic or code.

## De-identification (45 CFR 164.514)
- Safe Harbor: remove all 18 identifiers AND have no actual knowledge that the rest could identify the person (rare diagnoses plus small towns can still identify).
- Expert Determination: a qualified statistical expert documents that re-identification risk is very small, with methods; allows keeping some fields (e.g. dates shifted, 3-digit ZIPs).
- Limited data set: may keep dates, city, state, ZIP; only for research, public health or operations under a data use agreement. It is still PHI.
- Re-identification codes are allowed if not derived from identifiers and the key is kept separate.

## Minimum necessary
Use, disclose and request only the minimum PHI needed for the purpose. Does not apply to disclosures to the patient, for treatment between providers, with the patient's authorization, or as required by law.

## Uses and patient rights (Privacy Rule)
Treatment, payment and health care operations generally don't need authorization; marketing, most sales of PHI and psychotherapy notes do. Patients have rights to a Notice of Privacy Practices, access copies of their records (generally within 30 days), request amendments, an accounting of certain disclosures, request restrictions and confidential communications.

## Tools
Use the PHI helper (phi_scan, when available) to flag identifiers in text; see hipaa-handling-phi for what to do with them.
