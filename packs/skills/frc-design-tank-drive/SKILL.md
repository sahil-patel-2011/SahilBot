---
name: frc-design-tank-drive
description: Tank / West Coast Drive / kitbot drivetrain design: wheel count and drop, gearbox ratio, chain or belt in tube, turning scrub.
source: you
uses: 0
category: FRC Design
---

## When to use
Rookie or resource-limited teams, pushing-heavy games, or when swerve isn't feasible. Also for evaluating the AndyMark kitbot chassis.

## Steps
1. Choose the base: the kit chassis (fast, proven, low skill) or a West Coast Drive (WCD): 2x1 tube rails, wheels cantilevered on live hex axles, chain or belt inside or beside the tube.
2. Wheel layout: 6 wheels with the center pair dropped about 1/16-1/8 in (drop center) so the robot pivots on the middle wheels and turns with less scrub. Or 4 wheels plus omni wheels on one end.
3. Turning: keep the wheelbase (front-back) no longer than the track width (left-right) when possible; long, narrow tank robots turn badly.
4. Gearing: frc_mech mechanism kind=drivetrain with motor_count = all drive motors. Typical single-speed targets are about 12-15 ft/s theoretical with 4-6 in wheels; check pushing force vs traction and the time over your cycle distance.
5. Power transmission: #25 or #35 chain (or HTD belts) with tensioning (cams, slotted bearing blocks, or in-tube tensioners). Even link counts; center distances from frc_mech center_distance.
6. Leave room for bumpers, battery, electronics, and mechanism mounting points on top of the rails.

## Numbers
- Pushing force is capped by traction: μ × robot weight (μ ≈ 1.0-1.2 for typical high-grip tread on carpet; measure yours).
- Each 1/16 in of drop is enough to lift the corner wheels slightly on carpet; too much drop makes the robot rock.
- Check the current Game Manual for limits on the number of drive (propulsion) motors; the 2026 manual capped it (R502).

## Checks
- Chain or belt tension adjustable without disassembling the drive.
- Wheels retained (snap rings, bolts with washers, or collars), bearings captured.
- Bellypan or crossmembers keep the frame square; diagonal measurement equal.

## Common mistakes
- Gearing too fast for the motor count and robot weight (slow acceleration, hot motors).
- Long wheelbase with traction wheels on all corners (won't turn).
- No tensioning, leading to thrown chains in matches.

## Sources
- FRCDesign Stage 1 power transmission (chain, belts, gears): https://frcdesign.org/learning-course/
- WCP docs (drive gearboxes): https://docs.wcproducts.com/frc-build-system/gearboxes/drive-gearboxes
- AndyMark (kitbot chassis docs): https://www.andymark.com
- 2026 Game Manual section 8.5 (motors): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
