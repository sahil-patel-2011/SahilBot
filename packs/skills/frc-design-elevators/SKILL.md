---
name: frc-design-elevators
description: FRC elevators: cascade vs continuous rigging, stages and overlap, bearing blocks, carriage, stiffness, hard stops, gearing, springs and kG for programmers.
source: you
uses: 0
category: FRC Design
---

## When to use
Lifting a scorer or intake vertically (or on a tilt). Use frc_mech mechanism kind=elevator for speed, time, current and feedforward.

## Steps
1. Requirement: max height (minus the 2026 30 in starting height and any extension limits; confirm rules), payload mass, time from bottom to top, and positions to hold.
2. Stages: as few as reach allows. Each stage adds weight, slop and rigging.
3. Rigging:
   - Cascade: each stage is pulled relative to the one below it. The carriage moves N× the speed of the first stage (N = number of moving stages), so the drum sees about N× the load. Simple to rig, fast, needs more torque.
   - Continuous: one cable path runs through all stages; the carriage force equals the load and the speed equals the cable speed, but stage order can be less predictable and the cable is longer.
   - Media: #25 chain (robust, stretches), HTD belt (light, low backlash, needs width), Dyneema/Spectra rope on a spool (light, needs good terminations and wraps). Plan tensioning (turnbuckles, cable clamps, in-line tensioners).
4. Structure: 2x1 or 1x1 tube stages riding on COTS bearing blocks (WCP, Thrifty Bot); keep overlap generous between stages so the elevator stays stiff at full extension; cross-bracing at the top of each stage.
5. Drive: 1-2 motors (Kraken X60, Vortex, NEO) through a reduction to a sprocket/pulley/spool. Run frc_mech: lift force should use under about a third of the available force for good speed and control; check holding current.
6. Counterbalance: constant-force springs or gas springs reduce holding current and make the elevator safer; include them as spring_assist in frc_mech.
7. Hard stops top and bottom with a soft face; a limit switch or the encoder zeroed at the bottom stop.
8. Give programmers kG, kV, kA, the meters-per-rotation (pitch circumference × rigging ratio / gear ratio) and the soft limits.

## Rules of thumb
- Stage overlap: commonly at least ~20-25% of a stage's length; more if the elevator is tall or carries side loads.
- Bearing blocks: tighten until there's no rattle, but stages still slide freely when the elevator is tilted.
- Tilted elevators: load is m × g × sin(angle); include incline_deg in frc_mech.
- Full-travel times around 0.5-1 s are typical for competitive robots; faster usually means harder control.

## Checks
- Does the elevator fall when disabled? (Brake mode alone often isn't enough under load: counterbalance or a lower ratio check.)
- Stiffness at full extension with the robot accelerating (frc-design-bumpers-cg for tipping).
- Cable/chain path doesn't rub; wires use a cable carrier or service loop.

## Common mistakes
- Forgetting that cascade rigging multiplies the force at the drum.
- No tensioning; slack rigging causing skipped teeth or derailing.
- Too little overlap; wobbly, binding stages.
- Hard stops that are the gearbox.

## Sources
- FRCDesign cascade elevator project (blocks, rigging, cable ends): https://frcdesign.org/learning-course/stage2/2d/rigging/
- FRCDesign elevator blocks (WCP / TTB blocks): https://frcdesign.org/learning-course/stage2/2d/elevator-blocks/
- FRCDesign elevator examples (continuous, cascade): https://frcdesign.org/mechanism-examples/
- ReCalc linear mechanism calculator: https://www.reca.lc
- WCP GreyT elevator docs: https://docs.wcproducts.com
