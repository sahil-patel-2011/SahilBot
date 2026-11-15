---
name: engineering-calculations
description: Do an engineering calculation reliably with units in code (pint), stated assumptions, cited formulas, sanity checks and a calc sheet.
source: you
uses: 0
category: Engineering
triggers: calculate, calculation, torque needed, force needed, how much torque, units conversion, pint units, dimensional analysis, calc sheet, calculation sheet, hand calculation, check my math, sanity check a result, order of magnitude estimate, significant figures, design factor, knowns and unknowns, lbf vs lbm, unit mismatch
---

## When
Any number that will drive a decision: sizing, loads, power, flow, heat, timing. Domain models live in stress-and-strength, thermal-analysis, circuit-analysis, tolerance-stackup; this skill is the discipline around them.

## Steps
1. **State the question** as one sentence with the unknown and its unit: "Bending stress at the root of the bracket, MPa."
2. **Table of knowns, unknowns, assumptions**: symbol, value, unit, source (measured, datasheet, requirement, guess). Mark guesses; they are the first thing to vary.
3. **Formula with source**: textbook, standard, datasheet or derivation. Note its validity limits (linear elastic, thin wall, laminar, steady state).
4. **Compute in code**, never multi-step arithmetic in your head. Use run_command with Python and pint; work in SI internally and convert only for display. If pint is missing: run_command("python3 -m pip install pint").
5. **Dimensional check**: convert the result to the expected unit; pint raises an error if dimensions disagree. For hand derivations, check every term has the same dimensions.
6. **Sanity checks** (at least two): order of magnitude; limiting cases (load 0, length to infinity, thickness doubled) move the right way; a second method or a simpler bound; comparison with a known design or catalog value.
7. **Significant figures**: report about 2-3, no more than the worst input supports. Keep full precision inside the code.
8. **Safety factor**: governing code or standard first. Otherwise, rules of thumb: 1.5-2 for well-known loads and ductile materials; 2-3 for uncertain loads or environment; 3-4+ for brittle materials, impact or unknown fatigue. State which load (yield, ultimate, buckling, fatigue) it is against.
9. **Calc sheet**: title, purpose, references, inputs table, assumptions, formulas, results with units, checks done, conclusion, date, revision, checker.

## Example
```python
import pint
u = pint.UnitRegistry()
F = 50 * u.N           # tip load, requirement R2
L = 300 * u.mm         # lever arm
b, h = 25 * u.mm, 6 * u.mm
Sy = 276 * u.MPa       # 6061-T6 yield, datasheet
M = F * L
I = b * h**3 / 12
sigma = (M * (h / 2) / I).to(u.MPa)   # errors if units are wrong
print(f"sigma = {sigma:.3g~P}, SF = {(Sy / sigma).to(''):.2f}")
```
Result ~100 MPa, SF ~2.8. Check: doubling h should cut stress 4x; rerun to confirm.

## Pitfalls
- lbf vs lbm, psi vs psia/psig, gauge vs absolute pressure.
- rpm vs rad/s; trig in degrees instead of radians.
- mm-based section properties mixed with m-based loads (I in mm^4, M in N m).
- Temperature differences vs absolute temperature (pint distinguishes delta_degC).
- kW vs kWh, N m torque vs J energy, mass flow vs volume flow.
- Using a formula outside its validity range; forgetting dynamic, impact or stress-concentration factors.
- Rounding intermediate values, then reporting 5 significant figures.

## Verify
The calc sheet reruns from the saved script and reproduces the result; every input has a source; two independent sanity checks agree within the expected range. Never present a number you did not compute in a run.
