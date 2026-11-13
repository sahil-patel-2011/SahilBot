---
name: frc-design-bumpers-cg
description: FRC bumpers (rule-driven construction and mounting) and center of gravity / tipping analysis for tall or extending robots.
source: you
uses: 0
category: FRC Design
---

## When to use
Designing bumpers, placing heavy parts, or when a robot with an elevator or arm tips during driving or defense.

## Steps (bumpers)
1. Read the current BUMPER section of the manual (2026: section 8.4, R401-R410) and Team Updates; bumper rules change often.
2. Put the bumper zone and bumper outline into the layout sketch so intakes, wheels and frame members clear it.
3. Design mounting that is fast (quick-release pins, latches or bolts you can reach) and strong (bumpers take the hardest hits on the robot). Make both alliance colors or reversible covers as the rules require.
4. Weigh bumpers and include them in the total-weight check.

## 2026 numbers (confirm for your season)
- Padding backing must cover a zone about 2.5-5.75 in above the floor; bumpers may extend at most 4 in beyond the robot perimeter; hard parts at most 1.25 in beyond it; corners must be padded.
- Robot weight limit 115 lb without bumpers and battery (R103); total with bumpers 135 lb (R408).

## Steps (center of gravity)
1. Get the CG from Onshape mass properties (assign real materials; add the battery, ~12-13 lb, and electronics).
2. Tip check on hard braking or acceleration: the robot tips when a × h > g × d, so the tipping acceleration is a_tip = g × d / h, where h is CG height and d is the horizontal distance from the CG to the wheel contact edge in that direction.
3. Compare a_tip with the drivetrain's max acceleration (frc_mech drivetrain reports it, roughly μ × g if traction-limited). If a_tip is lower, lower the CG, widen the base, or have programmers limit acceleration when the mechanism is extended.
4. Repeat with the elevator/arm extended and with a game piece.

## Rules of thumb
- Battery, gearboxes, bellypan electronics as low as possible; a steel bellypan or ballast can be worth its weight if you have weight margin.
- Example: d = 12 in, h = 15 in → a_tip ≈ 0.8 g, which a traction-limited swerve (~1 g) can exceed: limit acceleration when extended.

## Common mistakes
- Bumpers designed last and not fitting around intakes or swerve modules.
- Bumper mounts that need tools you don't have in the queue.
- Checking CG only in the stowed configuration.

## Sources
- 2026 Game Manual section 8 (R103, R104, R401-R410, R408): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
- FRCDesign Stage 1E (bumpers, battery mounting): https://frcdesign.org/learning-course/stage1/1e/introduction/
- FRCDesign materials (steel ballast bellypans): https://frcdesign.org/design-handbook/structure/materials/
