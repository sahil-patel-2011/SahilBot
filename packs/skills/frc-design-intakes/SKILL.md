---
name: frc-design-intakes
description: FRC intake design: over vs under the bumper, roller surface speed, compression, compliance, deployment (slapdown, linkage), robustness and sensing.
source: you
uses: 0
category: FRC Design
---

## When to use
Any ground or station pickup. Intakes decide cycle time more than any other mechanism, so prototype early.

## Steps
1. Define the requirement: piece type(s), orientations it must accept, pickup at what drive speed, width, where the piece goes next (frc-design-indexers-handoffs).
2. Choose the architecture:
   - Over the bumper (OTB): deploys outside the frame (slapdown pivot or four-bar linkage). Wide, forgiving, can pick up while driving; must survive hits and stay within the extension limit.
   - Under / through the bumper: a gap in the bumper or a low intake inside the perimeter; protected and simpler, but narrower and only works when the piece fits under.
   - Fixed in-frame: simplest; only if the piece can be driven into.
3. Prototype with adjustable roller spacing (slots), swappable roller materials and a variable-speed motor. Record success rate at different speeds and angles.
4. Size the drive: roller surface speed at least about 2× the robot's top speed so the intake pulls the piece in faster than the robot drives over it. Surface speed = π × roller diameter × RPM. Use frc_mech gear_ratio_search for the ratio and mechanism kind=generic for speed/torque.
5. Deployment: slapdown pivot on a dead axle with hard stops at both ends (with a little soft stop), gearing or a gas spring so it deploys fast and stays down; or a linkage. Use frc_mech kind=arm for the pivot (gravity torque, time, kG).
6. Robustness: 1/4 in polycarbonate or SRPP side plates outside the perimeter, rollers on bearings, shafts supported on both ends, nothing sharp to snag other robots, wires routed inside.
7. Sensing: beam break, time-of-flight or a current spike to detect "have piece"; mount where the piece always passes and where it won't get smashed.

## Numbers and rules of thumb
- Surface speed ≥ ~2× drive speed (FRCDesign / 254's intake rules).
- Maximize grip: compliant wheels, silicone/flex wheels, grippy tubing, or tread, matched to the piece. Rigid rollers for squishy pieces; compliant rollers for hard pieces.
- Compression: start small and tune on a prototype (soft foam balls tolerate more; hard pieces need very little and compliance instead). Too much compression stalls and heats the motor.
- As wide as rules and packaging allow: "touch it, own it" is the goal.
- Intake motors: Kraken X44, Minion, NEO 550 (current-limit 20-30 A), or NEO/Vortex for wide or heavy rollers; ~3:1 to 5:1 is common for 1.5-2 in rollers.

## Checks
- Works across the whole range of piece positions and orientations the game allows?
- Survives a full-speed hit into a wall and into another robot?
- Stays within the extension limit (2026: 12 in, one side at a time; confirm)?
- Doesn't block bumpers or the frame perimeter rules when stowed?

## Common mistakes
- Roller speed matched to free speed instead of loaded speed; motor too small and stalling.
- Unsupported (cantilevered) rollers that bend.
- No hard stop on the deploy pivot, so the gearbox takes every impact.
- Intake narrower than the driver's real aim error.

## Sources
- FRCDesign intake golden rules: https://frcdesign.org/learning-course/stage2/2c/intake-golden-rules/
- FRCDesign intake examples (slapdown, linkage): https://frcdesign.org/mechanism-examples/
- FRCDesign materials (polycarbonate, SRPP): https://frcdesign.org/design-handbook/structure/materials/
- ReCalc intake calculator: https://www.reca.lc
