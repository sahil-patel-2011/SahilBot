---
name: systems-engineering
description: Run a multi-subsystem project with shall requirements, traceability, ICDs, trade studies, a risk register, V-model V&V, reviews and budgets.
source: you
uses: 0
category: Engineering
triggers: systems engineering, shall statement, requirements traceability, verification matrix, interface control document, icd, trade study, weighted decision matrix, risk register, likelihood impact matrix, v-model, srr pdr cdr, critical design review, configuration management, mass budget, budget contingency
---

## When
Several subsystems, people or vendors must fit together, or a missed requirement is expensive. Single part or mechanism: mechanical-design-process. Calc rigor: engineering-calculations. Write-ups: engineering-report. Keep each artifact below as a table (spreadsheet or markdown) under version control.

## Requirements
- Start from the need and a short concept of operations: users, environment, modes, a day in the life.
- One shall per statement, measurable, solution-free, with rationale: "The arm shall lift 5 kg from 0 to 90 deg in <= 1.0 s." Shall = mandatory, should = goal, will = statement of fact. Ban unverifiable words: fast, robust, adequate, user-friendly, as needed, etc.
- Columns: ID, text, rationale, parent ID, owner, verification method (Test, Analysis, Inspection, Demonstration), pass criterion, status.
- Trace up to a need and down to a design element and a verification. A requirement with no parent is gold plating; a need with no child is a gap.
- Allocate numbers downward with margin: 1.0 s total = 0.6 s motion + 0.2 s sensing + 0.2 s reserve.

## Interfaces (ICD)
Per interface: mechanical (envelope, bolt pattern, datums, loads), electrical (voltage, current, connector, pinout), data (protocol, rate, units, coordinate frame, timing), thermal, fluid. Name an owner on each side, version it, get both signatures, and change it only through change control. Freeze ICDs before detail design; most integration failures are interface failures.

## Trade studies
1. Options include the baseline. Musts are gates, not weights.
2. Criteria trace to requirements; weights sum to 100% and are set before scoring.
3. Define the scale anchors (1-3-9 or 1-5) and the data source for each score.
4. Sensitivity: swing each weight +/-25-50% and swap close scores. If the winner flips, the decision is close: buy data on the deciding criterion or take the lower-risk option. Record the rationale.

## Risk register
Columns: ID, "If <cause>, then <consequence>", likelihood 1-5, impact 1-5, score L x I, response (avoid, reduce, transfer, accept), owner, due date, trigger, status. Rule of thumb on a 5x5: >= 15 red, 8-12 yellow, <= 6 green. Review at every milestone; retire risks with prototypes and tests, not optimism.

## V-model
Left leg decomposes need > system > subsystem > component. Right leg integrates and verifies at the matching level: component test > subsystem test > system verification > validation with real users. Verification: built it right (meets the requirements). Validation: built the right thing (meets the need in use). Write the verification method when you write the requirement.

## Reviews
- SRR: requirements complete, verifiable, agreed.
- PDR: architecture and concept chosen, budgets with margin, ICDs drafted, top risks mitigated.
- CDR: design complete, analyses close, drawings and verification plan ready; go to build.
Publish entry/exit criteria, invite outside reviewers, log actions with owners and dates.

## Configuration management
Baseline at each review. Part number plus revision on every item; one source of truth (PDM or git). Change requests state impact on mass, power, cost, schedule and interfaces before approval. Track released vs work-in-progress, as-designed vs as-built.

## Budgets with margin
Mass, power, cost (also volume, time, data rate). Columns: item, estimate, maturity, contingency, allocation. Rule-of-thumb contingency: estimated 20-30%, calculated 10-15%, measured 2-5%. Margin = allocation - (estimate + contingency); keep a system reserve and plot the trend each review.

## Pitfalls
Requirements written after the design; "TBD" never closed; weights tuned to a favorite; risks with no owner; ICDs living in someone's head; margin spent silently by one subsystem.

## Verify
A verification matrix where every shall has a method, an evidence link and a pass/fail result.
