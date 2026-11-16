---
name: handbook-engineering
description: Choose and apply engineering methods with units, assumptions, uncertainty, traceable requirements and reproducible verification.
source: you
uses: 0
category: Engineering
triggers: engineering handbook, engineering foundations, engineering reference guide, engineering working methods, engineering knowledge guide, engineering best practice guide, engineering workflow overview, engineering learning guide
---

## Start from the physical question
Identify the system boundary, objective, constraints, unknowns, expected units and the decision the answer will support. Separate a school exercise from a real design: an exercise can be explained directly, while an actual build needs material properties, geometry, loads, operating conditions and a verification plan. Ask only for inputs that materially change the result; label provisional assumptions.

## Choose the specialist workflow
Read the most relevant pack through memory read_skill before detailed work. engineering-calculations covers consistent units and sanity checks; mechanical-design-process covers requirements and alternatives; stress-and-strength, thermal-analysis, circuit-analysis, signal-processing and tolerance-stackup provide domain methods. systems-engineering covers interfaces, verification matrices and change impact. engineering-report records the final calculation and evidence. frc-design-* packs add student robotics mechanisms, manufacturing, parts and rules; use the exact current season and vendor references.

## Working reference
Keep units alongside every input and output. Use consistent internal units; distinguish mass from force, energy from power, absolute from gauge pressure, and absolute temperature from temperature difference. Draw the load path and free-body diagram before solving a mechanical load case. Identify boundary conditions before thermal or electrical modeling. Check the equation's applicable regime before inserting numbers. Preserve full precision internally and report only justified significant figures. Use a runnable calculation for multi-step arithmetic; independently check dimensions and at least one limiting case.

## Uncertainty and verification
Identify dominant uncertain inputs and test plausible bounds. Do not hide uncertainty behind many decimal places. Separate nominal behavior, worst case and failure behavior. Record test conditions, instrument limitations, acceptance criteria and the result. A simulation or calculation is evidence about its assumptions, not proof that a physical assembly is safe. For a real safety-critical system, follow its applicable standards and obtain qualified review and physical validation; never invent a certification or standard clause.

## Durable learning
Save project requirements, decisions and dependent artifacts with project_memory. When an input changes, revisit dependent results rather than reusing stale numbers. A successful reusable procedure includes environment/software version, input assumptions, commands, measured checks and known failure cases. Keep reference URLs, document revision and access date; look up current standards and datasheets rather than copying values from memory.

Reference entry: [NIST SI guidance](https://www.nist.gov/pml/special-publication-811). It supports unit practice; it is not a substitute for a design-specific standard.
