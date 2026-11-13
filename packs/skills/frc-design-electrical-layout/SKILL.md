---
name: frc-design-electrical-layout
description: Electrical layout for FRC mechanical designers: space and access for battery, main breaker, PDH, roboRIO, radio, CAN, wire gauge, routing and strain relief.
source: you
uses: 0
category: FRC Design
---

## When to use
Laying out the bellypan and superstructure so electrical can be built, inspected and repaired; reviewing a robot for "where does the wiring go?".

## Steps
1. Reserve space in the layout early: battery (about 7.1 × 3.0 × 6.6 in, 11-14.5 lb in 2026), main breaker, power distribution (PDH/PDP), roboRIO, radio, pneumatics hub if used, motor controllers not integrated into motors, and any coprocessors/cameras.
2. Battery: low and central for CG, quick swap (strap or latch, no tools), protected from impacts, Anderson connector accessible.
3. Main breaker and robot signal light: easy to reach and see from outside the robot (inspectors and field staff use them).
4. Wire gauge follows breaker size (2026 R622: 12 AWG for 31-40 A, 14 AWG for 21-30 A, 18 AWG for up to 20 A; check the table). Motor controllers ≤ 40 A breakers.
5. CAN bus: a planned daisy chain with termination; short stubs; connectors secured; avoid running CAN next to high-current motor wires where possible.
6. Routing: wires along structure, tied every few inches, off moving parts; service loops or cable carriers (drag chains) on elevators and arms; slip rings or a cable wrap on turrets.
7. Protection: covers against metal chips and game pieces; grommets where wires pass through metal; strain relief at every connector.
8. Access: the roboRIO USB/ethernet, radio, and breaker panel reachable in the pit without removing mechanisms.

## Checks
- Can you swap a battery in under 30 seconds?
- Can you replace any motor controller or sensor without removing a mechanism?
- Any wire that moves: does it flex the same way every cycle without rubbing?

## Common mistakes
- Electronics placed last, wherever space remains.
- Wires crossing pinch points of intakes or elevators.
- Unreachable main breaker; loose Anderson connectors; metal shavings in electronics.

## Sources
- FRCDesign Stage 1E (battery mounting, electronics): https://frcdesign.org/learning-course/stage1/1e/electronics/
- 2026 Game Manual section 8.6 (R601 battery, R619-R622 breakers and wire): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
- WPILib wiring the control system: https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-1/intro-to-frc-robot-wiring.html
