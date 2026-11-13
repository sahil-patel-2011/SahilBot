---
name: frc-design-arms-pivots
description: FRC arms and pivots: gravity torque, gearing, backlash, dead vs live axle pivots, encoders, hard stops, counterbalance and kG/kV/kA for programmers.
source: you
uses: 0
category: FRC Design
---

## When to use
Any rotating mechanism under gravity: scoring arms, wrists, intake pivots, hoods. Use frc_mech mechanism kind=arm.

## Steps
1. Requirement: range of angles, positions to hold, time between positions, payload (piece mass), accuracy needed at the end effector (angle error × arm length = position error).
2. Mass and center of mass from CAD (with the piece). Gravity torque at horizontal = m × g × r.
3. Gearing: run frc_mech with motor, count, ratio, current limit. Target: gravity torque under about a third of the current-limited output torque, a move time that meets the requirement, holding current that won't overheat the motor.
4. Reduction layout: 3 stages or fewer (each adds backlash); put a large final reduction on the arm itself (big sprocket or pulley on a dead-axle pivot, or a big gear). Planetary + chain/belt final stage is common.
5. Pivot: dead axle (a tube or shoulder bolt; the arm spins on bearings, the sprocket bolts to the arm) for big, high-torque arms; live axle (hex shaft) for small ones. Large bearings or X-contact bearings resist moment loads.
6. Sensing: an absolute encoder on the pivot (through-bore on a live axle, or belted 1:1 from the pivot for a dead axle) so the arm knows its angle at power-on.
7. Hard stops at both ends of travel (soft face) and a known stowed position.
8. Counterbalance with gas springs or surgical tubing when gravity torque is large; check the spring torque curve across the full range.
9. Hand programmers kG, kV, kA (from frc_mech), the gear ratio, encoder offset convention (0 = horizontal) and soft limits.

## Rules of thumb
- Long arms need big total reductions (often 50-150:1 with a Kraken/NEO); short wrists much less.
- Backlash at the pivot × arm length = slop at the end; a chain final stage needs tensioning, shim tape fixes loose hex fits.
- Mount the encoder after the backlash (on the arm), not on the motor.
- Shock loads (arm slamming into a stop or a robot) can exceed the stall torque: check shafts (frc_mech shaft_torque_check) and gearbox ratings.

## Checks
- Holding current at worst angle with the piece.
- Behavior when disabled (does it slam down?).
- Clearance through the whole sweep in the layout sketch (construction circles), including bumpers and other mechanisms.

## Common mistakes
- Under-geared arms that can hold but can't move fast against gravity.
- Encoders on the motor shaft with a backlash-y gearbox.
- Thin pivot shafts cantilevered far from their bearings.
- Forgetting the game piece in the mass estimate.

## Sources
- FRCDesign dead-axle pivot project (strength, friction, tensioning, backlash): https://frcdesign.org/learning-course/stage2/2b/backlash/
- FRCDesign designing for controllability (hard stops, encoders, backlash): https://frcdesign.org/design-handbook/design-writeups/designing-for-controllability/
- FRCDesign pivot examples (6328, 2910): https://frcdesign.org/mechanism-examples/pivots/
- ReCalc arm calculator: https://www.reca.lc
