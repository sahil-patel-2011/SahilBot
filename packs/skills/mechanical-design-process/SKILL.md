---
name: mechanical-design-process
description: Run a mechanical design from numbered requirements through Pugh concept scoring, first-order analysis, detail design, reviews and test.
source: you
uses: 0
category: Mechanical Engineering
triggers: design a bracket, design a part, bracket, mechanical design process, design a mechanism, pugh matrix, pugh chart, concept selection, concept generation, design requirements table, first-order analysis, back of the envelope sizing, design for assembly, design for serviceability, prototype test plan, detailed design phase, product development stages
---

## When
Any part, mechanism or machine beyond a quick sketch. FRC robots: frc-design-process. Many subsystems, teams or formal milestones: systems-engineering. Phase details live in stress-and-strength, tolerance-stackup, material-selection, design-for-manufacturing and fits-and-fasteners; modeling in cad-workflow / cad-onshape-api.

## Steps
1. **Requirements table first.** Columns: ID, requirement, number + unit, source (user, rule, physics), must/want, verification (test/analysis/inspection). Cover function, loads, speed, envelope, mass, environment (temp, dust, impact, water), life (cycles), interfaces (mounts, power, data), safety, cost, quantity, deadline. "Strong and light" is not a requirement; "holds 200 N at the tip with < 2 mm deflection, < 0.8 kg" is.
2. **Concepts.** Make 3-6 that differ in working principle (screw vs belt vs linkage), not in dimensions. One sketch and a one-line "how it fails" each.
3. **Pugh selection.** Pick a datum (simplest or current design). Score each concept per criterion +1 / 0 / -1 vs datum. Musts are pass/fail gates, not scores. Merge the best features of the top two, rescore once. Use a weighted matrix with sensitivity only when criteria differ greatly in importance (systems-engineering).
4. **First-order analysis before CAD.** Script the driving numbers at the worst case (pose, speed, load, temperature): forces and torques, required power, motor/gear ratio, key stresses and safety factor, deflection, mass estimate, critical fit or stack. Follow engineering-calculations. A >2x miss means change the concept, not the details.
5. **Layout, then detail.** Skeleton sketch with envelope, motion paths and interfaces; freeze interfaces; then parts. Choose process, material, fits and fasteners as you detail, not after.
6. **Reviews.** Concept review (requirements + Pugh + first-order numbers) and release review before cutting material. Check against the table with evidence: load path traced end to end, what breaks first and what happens then, assembly sequence possible, tool access, safety (pinch points, stored energy, sharp edges), cost, tolerances only on functional features.
7. **Prototype and test.** Prototype the riskiest unknown first and cheaply (print, wood, COTS). Per requirement: quantity measured, instrument, pass criterion, sample size, owner. One variable at a time; record data and video.
8. **Close out.** Mark each requirement met/not met with an evidence link; log changes with rationale; update CAD, drawings and BOM to as-built.

## Design for assembly and service
- For every part ask: does it move relative to its neighbor, need a different material, or need removal for service? If all no, merge it.
- Self-locating features (pins, tabs, shoulders); assemble from one direction; make wrong-way assembly impossible (asymmetric holes, keyed parts).
- One or two fastener sizes, one tool; no blind nuts without captive hardware.
- Wear and likely-failure parts swap in minutes without removing others; leave wrench swing and hex-key length clearance; service loops on cables and hoses.

## Pitfalls
- Requirements without numbers, so "done" is undefined.
- Detailed CAD before any hand calculation; analyzing the nominal case, not the worst.
- Choosing the first concept; scoring a concept that already fails a must.
- Ignoring deflection, friction and tolerance until assembly.
- Reviews that judge looks instead of requirements; tests with no pass criterion.

## Verify
Every must requirement shows evidence (test data, calc sheet, inspection record). The final status table is the proof; never report a design done without it.

## Example
| ID | Requirement | Value | Verify |
|---|---|---|---|
| R1 | Lift payload | 5 kg, 0.8 m in <= 1.5 s | Test, 10 runs |
| R2 | Added mass | <= 2.0 kg | Inspection (scale) |
| R3 | Life | 50k cycles, no loosening | Test + fatigue analysis |
