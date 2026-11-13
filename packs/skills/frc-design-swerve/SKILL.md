---
name: frc-design-swerve
description: Swerve drivetrain design for FRC: module choice (SDS, WCP, REV, Thrifty), gear ratio and free speed, frame size, bellypan, current limits.
source: you
uses: 0
category: FRC Design
---

## When to use
Choosing or gearing swerve modules, laying out a swerve frame, or debugging a slow/hot/tippy swerve. For tank drives use frc-design-tank-drive; for bumpers and tipping use frc-design-bumpers-cg.

## Steps
1. Decide the frame: square is simplest for swerve. Under a 110 in perimeter (2026 rule) a square frame is at most 27.5 in per side; leave room for bumpers (up to 4 in each side in 2026) and check field openings the robot must fit through.
2. Pick a module the team can buy spares for and maintain: SDS MK4i/MK4n/MK5n, WCP Swerve X2 family, REV MAXSwerve, Thrifty Swerve. Check motor compatibility (Kraken X60, NEO Vortex, Falcon, NEO), wheel size, weight, height and encoder options.
3. Gear for the field: run frc_mech mechanism kind=drivetrain with your motor, the module ratio, wheel diameter and full robot mass (with bumpers and battery). Compare free speed, time over a real cycle distance and whether you are traction- or current-limited.
4. Pick the current limit: frc_mech reports the current at the traction limit; a stator limit near that keeps full push without wheel spin. Add a supply limit (often 40-60 A per drive motor) to protect the battery from brownouts. Tell programmers both numbers.
5. Layout: modules in the corners (max wheelbase for stability and turning), bellypan (1/8 in polycarbonate or ~0.09 in aluminum) for electronics, battery low and central, space for the radio, PDH and CAN routing.
6. Encoders: absolute steering encoders (CANcoder, through-bore or module-native); give programmers each module's steering ratio and drive ratio and the measured (not nominal) wheel diameter.

## Numbers
- Common module ratios (verify on the vendor page): SDS MK4i L1 8.14:1, L2 6.75:1, L3 6.12:1, steering 150/7:1 (~21.4:1), 4 in wheel, ~6.0-6.3 lb per module; a 16T pinion kit makes each L ratio about 14% faster. REV MAXSwerve: 3 in wheel, 12/13/14T pinions (about 5.50/5.08/4.71:1), azimuth ~46.4:1, ~3.8 lb with a NEO. WCP Swerve X2S ratio sets X1/X2/X3 span roughly 15-25 ft/s with a Kraken X60.
- Competitive swerve robots are usually geared for about 14-18 ft/s theoretical; heavy or pushing-focused robots lower, open fields higher.
- Kraken X60 + 6.75:1 + 4 in wheel ≈ 15.7 ft/s theoretical (frc_mech).
- Tread wear shrinks wheel diameter: re-measure and update odometry; replace tread on a schedule.

## Checks
- Free speed and acceleration from frc_mech, not just the vendor chart.
- Tip check: deceleration at the current limit vs CG height (frc-design-bumpers-cg).
- Wire routing: steering wires can't wrap or rub; strain relief at the module.
- Bolts on modules Loctited (blue 243) and torque-checked; spares built and ready.

## Common mistakes
- Gearing for the highest speed on the chart, then losing pushing matches and browning out.
- No supply current limit (four to eight motors drawing stall current kill the battery voltage).
- Wrong wheel diameter in code; unbalanced weight making the robot tip under hard braking.
- Mixing module versions on one robot without updating ratios.

## Sources
- SDS MK4i (steering ratio, weights, pinion kit): https://www.swervedrivespecialties.com/products/mk4i-swerve-module
- REV MAXSwerve: https://www.revrobotics.com/rev-21-3005/
- WCP Swerve X2 ratio options: https://docs.wcproducts.com/welcome/gearboxes/wcp-swerve-x2/general-info/ratio-options
- FRCDesign swerve examples: https://frcdesign.org/mechanism-examples/drivebase/swerve/
- ReCalc drivetrain/linear calcs: https://www.reca.lc
- 2026 Game Manual section 8 (perimeter R104, bumpers 8.4): https://firstfrc.blob.core.windows.net/frc2026/Manual/HTML/2026GameManual.htm
