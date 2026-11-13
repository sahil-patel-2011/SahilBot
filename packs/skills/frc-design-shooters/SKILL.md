---
name: frc-design-shooters
description: FRC shooters and flywheels: surface speed and exit velocity, inertia and spin-up/recovery, compression and wrap, hoods, wheels, gearing.
source: you
uses: 0
category: FRC Design
---

## When to use
Launching game pieces (balls, notes, discs). Use frc_mech mechanism kind=flywheel for the numbers.

## Steps
1. Requirement: range of distances and heights, shot rate (seconds between shots), shoot while moving or not.
2. Projectile physics: estimate required exit speed and angle for near and far shots (simple ballistics, add drag margin for foam). FRCDesign's reference shooter aims for over ~12 m/s exit speed.
3. Architecture: single flywheel with a hood (wrap), top-and-bottom flywheels (spin control, often faster exit for the same RPM), or a flywheel plus backroller. Fixed or adjustable hood; turret or drivetrain aiming.
4. Prototype: adjustable compression, hood angle and wheel speed. Measure exit speed (slow-motion video) and spread over 10-20 shots.
5. Size the flywheel: frc_mech kind=flywheel with wheel diameter, target RPM, inertia (lb·in² or from mass), piece mass and exit speed → spin-up time, RPM dip per shot, recovery time, kV/kA for programmers.
6. Gear it so the target is about 60-80% of free speed (headroom for battery sag and recovery). Belts from motor to flywheel; FRCDesign suggests flywheel pulleys above 24T with good wrap to avoid skipping.
7. Structure: rigid side plates, flywheel shafts supported on both ends, balanced wheels, guarded pinch points.

## Numbers and rules of thumb
- Surface speed = π × D × RPM / 60. A 4 in wheel at 4000 RPM ≈ 70 ft/s surface speed.
- Exit speed is well below surface speed: very roughly half for one wheel against a fixed hood, closer to surface speed for matched top/bottom wheels. Always measure.
- More inertia = smaller RPM drop per shot and more consistent shots, but slower first spin-up. Add mass at the rim (brass/steel flywheel weights).
- Common wheels: Stealth/Colson/solid roller wheels; avoid compliant or treaded wheels at high RPM (they expand or fail).
- Compression and wrap transfer energy; too little slips, too much wastes energy and reduces consistency. Tune on a prototype.
- Two Krakens or Vortexes on a flywheel is common; current-limit them and use velocity control with feedforward.

## Checks
- Spin-up time fits the match flow (pre-spin while driving?).
- Recovery time ≤ the time between shots.
- Shot spread acceptable at the far distance with a low battery (~11.5 V).

## Common mistakes
- Gearing so the target is near free speed (slow, inconsistent when the battery sags).
- Low-inertia wheels that drop hundreds of RPM per shot.
- Single-sided shaft support; wheels wobbling.
- Inconsistent piece feed into the shooter (fix the indexer first).

## Sources
- FRCDesign exit velocity (inertia, gearing, ReCalc flywheel calc): https://frcdesign.org/learning-course/stage2/2a/exit-velocity/
- FRCDesign compression and wrap: https://frcdesign.org/learning-course/stage2/2a/compression-wrap/
- FRCDesign shooter examples: https://frcdesign.org/mechanism-examples/shooter/
- ReCalc flywheel calculator: https://www.reca.lc/flywheel
