---
name: hipaa-breach-response
description: Respond to a possible HIPAA breach: contain, document, four-factor risk assessment, notify patients, HHS and media.
source: you
uses: 0
category: HIPAA
triggers: hipaa breach, data breach patient, phi breach, sent patient info to wrong person, lost laptop with patient data, ransomware clinic, misdirected fax, breach notification, report breach to hhs, phi exposed, unauthorized access to records
---

## Disclaimer
High-level summary of the HIPAA Breach Notification Rule (45 CFR 164.400-414); not legal advice. State breach laws may add shorter deadlines or regulator notices. Bring in the practice's privacy officer and a healthcare attorney or compliance professional early; for cyberattacks, also the cyber insurer and IT/security responders.

## Immediately (contain and preserve)
1. Stop the exposure: recall or ask the recipient to delete and confirm in writing, disable compromised accounts, reset passwords, isolate infected machines (don't wipe them: preserve evidence), remote-wipe lost devices if possible.
2. Record the facts: what happened, when it happened and when discovered, what data and how many people, who received or accessed it, what was done. Keep a timeline.

## Is it a reportable breach?
An impermissible use or disclosure of unsecured PHI is presumed a breach unless a documented risk assessment shows a low probability of compromise, considering four factors:
1. Nature and extent of the PHI (identifiers, sensitivity, likelihood of re-identification).
2. The unauthorized person who used or received it (another covered entity bound by HIPAA is lower risk).
3. Whether PHI was actually acquired or viewed.
4. Extent the risk was mitigated (e.g. signed attestation of deletion).
Exceptions exist (e.g. unintentional good-faith access by a workforce member within scope). PHI encrypted to HHS guidance standards ("secured") generally isn't a reportable breach if the key wasn't exposed. Ransomware is generally presumed a breach unless the assessment shows low probability (per HHS guidance).

## Notification timelines (if a breach)
- Individuals: without unreasonable delay and no later than 60 calendar days after discovery, by first-class mail (or email if agreed), with required content: what happened, what PHI, steps they should take, what you're doing, contact info.
- HHS: 500 or more individuals: within 60 days of discovery via the HHS breach portal; fewer than 500: log and report within 60 days after the end of the calendar year.
- Media: more than 500 residents of a state or jurisdiction: prominent media outlets within 60 days.
- Business associates notify the covered entity (per the BAA, no later than 60 days).
Verify current requirements on hhs.gov before acting.

## Afterwards
Root cause analysis, fix (training, technical controls, process), sanctions per policy, update the risk analysis, keep all documentation for 6 years.

## How SahilBot helps
Draft the incident timeline, the four-factor assessment worksheet, patient notification letters and the HHS report fields for the privacy officer's review (create_document), and reminders for deadlines. Use de-identified details in drafts where possible. Never send notifications or submit reports without the user's approval.
