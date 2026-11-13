---
name: frc-design-belts-chain
description: Belts and chain in FRC: HTD 5mm vs GT2 3mm, #25 vs #35 chain, pitch diameters, exact center distances, wrap, tensioning and when to use which.
source: you
uses: 0
category: FRC Design
---

## When to use
Any belt or chain run. Compute centers with frc_mech center_distance (drive htd5, gt2_3mm, chain25, chain35).

## Steps
1. Choose:
   - HTD 5 mm belt (9 or 15 mm wide): near-zero backlash, quiet, light, no lubrication; great for rollers, shooters, elevators and moderate-torque pivots. Weaker than chain at high torque; needs wrap and tension.
   - GT2 3 mm belt: small, light, low-torque runs (sensors, small rollers).
   - #25 chain (0.25 in pitch): the FRC default for high torque (arms, drivetrains); strong and light enough. Stretches: plan tensioning.
   - #35 chain (0.375 in pitch): very high torque only; heavy and bulky.
2. Pitch diameters: belt pulley PD = teeth × pitch / π; sprocket PD = pitch / sin(180° / teeth). Clearance for a sprocket ≈ PD + one pitch.
3. Center distance: pick tooth counts, then use frc_mech center_distance with the belt teeth/links, or give a target center to get the nearest stock sizes and their exact centers. In Onshape, use FRCDesign's #BeltCTC_5mm / #ChainCTC_25 so CAD stays parametric.
4. Wrap: keep at least ~6 belt teeth engaged on the small pulley; add an idler if wrap is low. For flywheels FRCDesign suggests pulleys above 24T with good engagement.
5. Tension: exact center plus a small allowance for belts (teams differ; some add a few thousandths), slotted mounts or cam/idler tensioners for chain, turnbuckle links on long chain runs.
6. Retention: sprockets and pulleys located with spacers/collars; chain guards where it could throw.

## Rules of thumb
- Even link counts (no half links).
- Belts in 5-tooth steps are the common stock assumption; confirm the vendor list.
- Small loaded pulleys skip: prefer 16-18T+ on high-torque belt stages.
- Chain that's too tight wears fast; too loose throws or skips.

## Checks
- Belt/chain clears all structure through the mechanism's full motion.
- Tension can be adjusted in the pit with common tools.
- Width and center match what's in stock in the pit.

## Common mistakes
- Using a "close enough" center distance from a sketch without the belt formula.
- Odd links; no tensioner on a long chain.
- Thin belts on high-torque pivots (they skip under load).

## Sources
- FRCDesign belts (pitch, widths, PD/CTC functions): https://frcdesign.org/learning-course/stage1/1b/belts/
- FRCDesign chain (#25 vs #35, even links, clearance): https://frcdesign.org/learning-course/stage1/1b/chain/
- FRCDesign controllability (backlash, tensioning): https://frcdesign.org/design-handbook/design-writeups/designing-for-controllability/
- WCP belts and pulleys docs: https://docs.wcproducts.com/welcome/frc-build-system/belts-chain-and-gears/belts-and-pulleys
- ReCalc belt and chain calculators: https://www.reca.lc
