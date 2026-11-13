---
name: frc-design-fasteners-bearings
description: FRC fasteners, shafts and bearings: #10-32 and 1/4-20 sizes, hole and tap sizes, rivets, thread locking, hex/rounded hex/MAXSpline shafts, bearing types and retention.
source: you
uses: 0
category: FRC Design
---

## When to use
Detailing joints and rotating parts; choosing hardware; writing a hardware list for the pit.

## Fasteners
- #10-32 is the FRC default (motor mounts, superstructure, COTS); 1/4-20 for high-strength structural joints. Metric (M3-M6) shows up on some COTS parts.
- Close-fit clearance holes: #10 ≈ 0.196 in, 1/4 in ≈ 0.257 in. Tap drills: #10-32 → #21 (0.159 in); 1/4-20 → #7 (0.201 in).
- Thread engagement: aim for about 5 threads (thickness × threads per inch). Thin material: rivnuts or PEM nuts instead of tapping.
- Rivets: 3/16 in aluminum blind rivets are the most common (fit a #10 close-fit hole); multi-grip rivets simplify stock; check grip range. Riveted structural joints should include at least one bolt.
- Retention: nylock nuts first choice; Loctite 222 (low), 243 (blue, general), 263 (red, rarely), 680 (green, retaining bearings/shafts). Near polycarbonate use a polycarbonate-safe product (e.g. Loctite 425, Vibra-Tite VC-3).
- Shoulder bolts make good small dead axles for bearings and bushings.

## Shafts
- 1/2 in hex (most common) and 3/8 in hex; rounded hex (ThunderHex-style) lets you use cheaper round-bore bearings.
- MAXSpline / larger round tube for high torque; 2 in+ dead axles for big cantilevered arms.
- Live axle: spins and transmits torque. Dead axle: fixed, structural; the part spins on bearings around it.
- Check torsion with frc_mech shaft_torque_check (hex as the inscribed circle; grooves and cross-holes are stress raisers).

## Bearings and bushings
- Flanged ball bearings: the default; press into metal plates, flanges facing inward toward each other so the bearing and shaft are both captured.
- X-contact (four-point) bearings: thrust and moment loads (swerve, turrets).
- Needle bearings: thin, for round dead axles in roller end caps.
- Bushings (bronze, acetal): high-torque, low-speed pivots; smaller and lighter, more friction.
- Polycarbonate plates need bearing retainers ("hats") because the plate flexes.
- 3D-printed parts sliding on axles: ~0.005-0.010 in clearance; torque parts tighter.

## Checks
- Every shaft retained on both ends (snap ring, collar, bolt + washer into a tapped end).
- Every bolt has a nylock or threadlocker; witness marks on critical bolts at events.
- Hardware sizes standardized so the pit needs few drivers and wrenches.

## Common mistakes
- Mixed fastener sizes everywhere; missing spares.
- Bearings press-fit into polycarbonate with no retention.
- Collars as the only retention on high-load shafts.

## Sources
- FRCDesign fasteners (sizes, holes, rivets, Loctite): https://frcdesign.org/design-handbook/structure/fasteners/
- FRCDesign motion components (bearings, bushings, axles, retention): https://frcdesign.org/design-handbook/power-transmission/motion-components/
- FRCDesign shafts and bearings: https://frcdesign.org/learning-course/stage1/1b/shafts-bearings/
