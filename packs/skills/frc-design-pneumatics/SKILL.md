---
name: frc-design-pneumatics
description: FRC pneumatics basics and rules: legal system layout, pressures, cylinder force and air use, when pneumatics beat motors.
source: you
uses: 0
category: FRC Design
---

## When to use
Two-position actions (deploy/retract, grab/release, brake) where a cylinder is simpler than a motor and sensor; or checking a pneumatic system for inspection.

## Steps
1. Decide: pneumatics are binary, fast and self-holding with the right valve, but add a compressor, tank, tubing and weight, and the air supply is limited. Motors win for positions in between and for anything that needs feedback.
2. Layout (check the current manual; 2026 values): one compressor (≤ 1.1 cfm), relief valve set to 125 psi, pressure switch/sensor on the stored side, vent plug, two gauges, one primary regulator, stored pressure ≤ 120 psi, working pressure ≤ 60 psi, tubing ≤ 1/4 in OD, solenoid ports ≤ 1/8 in NPT. Components must carry the required pressure ratings.
3. Cylinder force: F = P × A. Extend: 60 psi × π × bore² / 4. Retract: subtract the rod area. Example: 3/4 in bore at 60 psi ≈ 26 lbf extending.
4. Air budget: volume per stroke = area × stroke (× 2 for double-acting); total per match vs stored volume and compressor output. Add tanks if pressure drops too far.
5. Control: Pneumatic Hub (REV) or PCM (CTRE); single vs double solenoids (double holds position when disabled).
6. Mount the compressor on vibration isolation; protect tubing from pinch points; label the vent plug.

## Checks
- All required components present and in the right place (inspection checklist).
- Cylinder force at 60 psi enough with a 1.5-2× margin, at the end of the match's air use.
- Tubing routed away from moving parts; fittings tight (soapy-water leak test).

## Common mistakes
- Undersized air storage; last actions fail late in matches.
- Forgetting retract force is lower than extend force.
- Missing gauges or relief valve at inspection.

## Sources
- 2026 Game Manual section 8.8 (R802-R814): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
- WPILib pneumatics docs: https://docs.wpilib.org/en/stable/docs/software/hardware-apis/pneumatics/index.html
