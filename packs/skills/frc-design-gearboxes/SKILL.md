---
name: frc-design-gearboxes
description: FRC gearboxes: MAXPlanetary, VersaPlanetary, UltraPlanetary, custom spur gearboxes, picking reductions, stage order, shafts and load ratings.
source: you
uses: 0
category: FRC Design
---

## When to use
Picking or designing a reduction for any mechanism. Find ratios with frc_mech gear_ratio_search (stage_types include maxplanetary, versaplanetary, ultraplanetary, gear, belt, chain).

## Steps
1. Get the required output speed and torque from the mechanism math (frc_mech mechanism), then the ratio = motor free speed × (fraction you want to use) / required output speed.
2. Choose a family:
   - REV MAXPlanetary: 2:1, 3:1, 4:1, 5:1, 9:1 cartridges, up to 3 stages; 1/2 in hex or MAXSpline output; fits NEO, Vortex, Kraken X60 (shaft mod for some setups), Falcon, CIM, with 550/775 input kits.
   - WCP VersaPlanetary: 3, 4, 5, 7, 9, 10:1 stage kits; many motor inputs.
   - REV UltraPlanetary: small, for NEO 550-class motors; nominal 3/4/5:1 cartridges are really 2.89, 3.61 and 5.23:1 (use the actual values when multiplying).
   - Custom spur gearbox (20 DP COTS gears, 1/2 in hex): best for compact, high-torque, low-backlash final stages and drivetrains.
3. Check load ratings against the worst case: stall torque at the output (with your current limit) and shock loads. Note REV publishes static failure torques per MAXPlanetary stage (e.g. 9:1 lower than 3:1) and warns side loads lower capacity.
4. Stage order: in planetaries, put the highest reduction closest to the motor (it sees the least torque; REV recommends this). For the whole mechanism, put a large final reduction at the output (chain/belt/big gear) to cut backlash and gearbox load.
5. Spur gear center distance (20 DP): (N1 + N2) / 40 in. Many teams add a few thousandths for clearance.
6. Shafts: 1/2 in hex (7075 or steel), rounded hex (round bearings), MAXSpline for high torque. Check with frc_mech shaft_torque_check.

## Rules of thumb
- 3 stages or fewer for anything that needs position control.
- Motor pinions: avoid the smallest pinions on high-torque stages; 10T+ is more robust.
- A gearbox that can survive stall at your current limit is the minimum; impacts can be several times higher.
- Leave space and access to change a ratio at competition.

## Checks
- Ratio from frc_mech matches the CAD parts actually ordered.
- Output shaft supported by two bearings; no long cantilevers.
- Retention: snap rings, shaft collars or bolts on every shaft.

## Common mistakes
- Using nominal UltraPlanetary ratios in code.
- Stacking four planetary stages (backlash, length, weight).
- Ignoring that current limits change the maximum torque the gearbox sees.

## Sources
- REV MAXPlanetary (cartridges, max stages, static torque ratings): https://www.revrobotics.com/rev-21-2100/
- REV UltraPlanetary cartridge details (actual ratios): https://docs.revrobotics.com/rev-crossover-products/ultraplanetary/cartridge-details
- WCP VersaPlanetary: https://wcproducts.com/products/versaplanetary-gearbox
- FRCDesign gears / torque and speed: https://frcdesign.org/learning-course/stage1/1b/introduction/
- FRCDesign designing for controllability (fewer stages): https://frcdesign.org/design-handbook/design-writeups/designing-for-controllability/
