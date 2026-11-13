---
name: frc-design-climbers
description: FRC climbers and winches: load, drum and rope, gearing, ratchets/brakes, hooks and alignment, testing at full robot weight.
source: you
uses: 0
category: FRC Design
---

## When to use
Endgame hang/climb mechanisms: telescoping hooks, winches, arms that lift the robot.

## Steps
1. Requirement: height to lift the robot, time available, alignment tolerance, whether the robot must stay up after the match (power off).
2. Load: full robot weight (up to ~135 lb with bumpers and battery in 2026; confirm) plus a dynamic factor of about 1.5-2× for jerks and swinging.
3. Winch: Dyneema/Spectra rope on a spool; effective diameter grows as rope layers build up; size for the largest diameter. Or a chain/belt-driven telescope.
4. Gearing: frc_mech mechanism kind=elevator with load_mass = robot mass and drum_diameter = spool diameter. Aim to use well under the current-limited force; check the climb time and the holding current.
5. Holding: a ratchet and pawl, a brake, or a non-backdrivable stage so the robot stays up when disabled. Make the pawl release for resets in the pit.
6. Hooks: passive capture where possible (funnel-shaped hooks, compliant guides); alignment aids for the driver (camera, marks).
7. Structure: climbing loads go through the strongest part of the frame; check tubes and shafts (frc_mech beam and shaft_torque_check) at the dynamic load.

## Rules of thumb
- Test climbs at full competition weight, many times, before the event.
- Keep the rope path free of sharp edges; use proper knots or crimped terminations and check them every match.
- A climber that works 95% of the time in 5 s beats one that works 70% in 3 s.

## Common mistakes
- Spool sized at the empty diameter; motor stalls near the top.
- No ratchet: the robot slides down at the buzzer.
- Hooks that need perfect alignment.
- Climb loads routed through thin 1/16 wall tube or rivets alone.

## Sources
- FRCDesign mechanism exercises (hooks): https://frcdesign.org/learning-course/stage1/1c/introduction/
- 2026 Game Manual (R103/R408 weights; game-specific endgame rules): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
- ReCalc linear mechanism calculator: https://www.reca.lc
