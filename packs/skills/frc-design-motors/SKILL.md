---
name: frc-design-motors
description: Choosing FRC motors (Kraken X60/X44, Falcon 500, NEO, NEO Vortex, NEO 550, Minion), current limits (stator vs supply), thermals, controllers and mounting.
source: you
uses: 0
category: FRC Design
---

## When to use
Picking a motor for a mechanism, setting current limits, or diagnosing hot, slow or browning-out mechanisms. Get specs with frc_mech motor_data.

## Steps
1. Size by power and duty: frc_mech mechanism with the candidate motor and ratio. Big, high-power or long-duty jobs (drive, elevator, flywheel, big arm) → Kraken X60 / NEO Vortex / Falcon / NEO class. Small, light jobs (rollers, wrists, indexers) → Kraken X44, Minion, NEO 550 (with care).
2. Check legality: only motors in the current manual's motor table are allowed (2026: Table 8-1, R501); check limits on drive motor count (2026 R502).
3. Controller: Kraken X60/X44 and Falcon have integrated Talon FX; Minion runs on Talon FXS; NEO/NEO 550 on SPARK MAX; Vortex on SPARK Flex. Confirm firmware and CAN IDs early.
4. Current limits (give these numbers to programmers):
   - Stator (motor) current limit caps torque and heat in the motor: set from the mechanism (traction current for drive from frc_mech, or what the mechanism needs).
   - Supply current limit caps what's drawn from the battery/breaker: protects against brownouts and breaker trips with many motors.
   - Each motor controller sits on a breaker of at most 40 A (2026 R621); breakers tolerate short peaks but trip on sustained overcurrent.
5. Thermals: stalling (holding an arm, intake jammed) turns all power into heat. Small motors (NEO 550) burn out quickly; limit to about 20-30 A and avoid stall holds.
6. Mounting: CIM-class motors use a 2 in bolt circle with #10-32 screws; allow wire bend radius and access to the connector; keep metal chips out of motors.

## Rules of thumb
- Gear so the mechanism's working point is well below stall (ideally under ~1/3 of current-limited torque for things fighting gravity).
- FOC (Phoenix Pro) on Kraken/Falcon gives noticeably more torque; note it if the team has a license.
- Battery sag: plan for 10-11 V under load, not 12 V.
- Vendor and calculator numbers differ (test conditions); frc_mech shows ReCalc values with vendor notes.

## Common mistakes
- No current limits; robot browns out when everything moves at once.
- NEO 550 on a high-torque, stalled job.
- Choosing by stall torque alone; ignoring free speed and power.

## Sources
- ReCalc motor table: https://www.reca.lc/motors
- REV NEO Vortex docs: https://docs.revrobotics.com/brushless/neo/vortex
- REV NEO 550: https://www.revrobotics.com/rev-21-1651/
- REV NEO V1.1: https://www.revrobotics.com/rev-21-1650/
- CTRE Minion: https://store.ctr-electronics.com/products/minion-brushless-motor
- FRCDesign motors (mounting pattern): https://frcdesign.org/learning-course/stage1/1b/motors/
- 2026 Game Manual 8.5-8.6 (R501, R502, R621): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
