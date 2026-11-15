---
name: fits-and-fasteners
description: Choose shaft/hole fits (ISO 286 H7/g6, H7/p6), bearing seats, general tolerances, bolt size, class, engagement, torque and locking.
source: you
uses: 0
category: Mechanical Engineering
triggers: which bolts, bolt size, screw size, fasteners, press fit, h7/g6, h7/p6, iso 286 fit, press fit interference, clearance fit, transition fit, iso 2768, bearing seat fit, bolt preload, bolt torque spec, nut factor, thread engagement, property class 8.8, grade 8 bolt, threaded insert for plastic, nord-lock
---

## When
Picking a fit for a shaft/hole or bearing, or sizing a bolted joint. Multi-part stacks: tolerance-stackup. Drawing callouts: gdt-drawings. Bolt stress and fatigue: stress-and-strength. FRC hardware (#10-32, rivets, hex shafts): frc-design-fasteners-bearings. All numbers are rules of thumb; confirm against ISO 286 / ASME B4.2 tables, fastener standards and the bearing or insert maker's data before release.

## Fits (hole basis)
- Hole is H (lower deviation 0); pick the shaft letter. a-h clearance, js-n transition, p-u interference. Grade: IT6 ground, IT7 reamed/fine bored, IT8-9 normal machining, IT11+ rough.
- H9/d9 free running (dirty, loose). H8/f7 close running (plain bearings). H7/g6 precise sliding/location (pins, removable gears). H7/h6 snug, hand assembly. H7/k6 transition (location, light mallet). H7/p6 locating press (bushings, dowels; do not count on it for torque). H7/s6 drive fit (permanent, carries torque).
- Example 20 mm: H7 = +0/+21 um, g6 = -7/-20 um, p6 = +22/+35 um, so H7/g6 clears 7-41 um and H7/p6 interferes 1-35 um. Compute limits in code, never by eye.
- Press fits: interference about 0.05-0.1% of diameter for steel; check hub hoop stress (thick-wall cylinder) and plan press force. Ream the bore, 15-30 deg lead-in chamfer. Aluminum hubs lose grip when hot; plastics creep, so add mechanical retention. Thermal assembly: heat the hub (bearings <= ~120 C) or chill the shaft.
- Bearing seats: the ring that rotates relative to the load gets interference; the other gets clearance/transition. Rotating shaft: shaft k5/k6/m6, housing H7. Heavy interference on both rings eats internal clearance. Shoulder height and fillet radius come from the bearing catalog.

## General tolerances
"ISO 2768-mK" in the title block covers untoleranced features: class m is +/-0.2 mm for 6-30 mm and +/-0.3 for 30-120. Inch shops often use .XX +/-0.01, .XXX +/-0.005. Tighten only functional features; each extra decimal costs.

## Fastener selection
- Metric coarse: M3 0.5, M4 0.7, M5 0.8, M6 1.0, M8 1.25, M10 1.5 pitch. Inch: #4-40, #6-32, #8-32, #10-32, 1/4-20, 5/16-18, 3/8-16. Prefer coarse; fine for thin walls or adjustment.
- Strength: class 8.8 general (proof ~600 MPa), 10.9 high, 12.9 socket heads; SAE grade 5 ~ 8.8, grade 8 ~ 10.9. Stainless A2/A4-70 is weaker and galls; use anti-seize. Match nut class to bolt.
- Engagement: steel into steel ~1-1.5D; into aluminum or cast iron ~2D; into plastic use inserts. Threads past ~2D add little.
- Preload ~75% of proof load for reusable joints: F = 0.75 x At x Sp. Torque T = K x F x d, K ~0.2 dry steel, ~0.15 lubricated or plated. Torque control scatters preload +/-25%.
- Worked: M8 8.8, At 36.6 mm2, Sp 600 MPa: F = 16.5 kN; T = 0.2 x 16.5 kN x 8 mm = 26 N m.
- Washers spread load on aluminum and plastic; hardened washers under 10.9/12.9. Split lock washers do little.
- Locking: correct preload first, then nylon-insert or all-metal prevailing-torque nuts, medium threadlocker, wedge-lock washers (Nord-Lock), safety wire. Threadlockers crack polycarbonate and acrylic.
- Plastics/sheet: heat-set brass inserts, thread-forming plastic screws, molded inserts; PEM clinch nuts or rivnuts in thin sheet.
- Blind rivets: shear joints, edge distance >= 2D, pitch >= 3D, weak in tension, not removable.

## Joint pitfalls
- Bolts in clearance holes as shear pins: the joint lives on friction from preload; locate with dowels or shoulder bolts.
- Short grip in stiff joints loses preload to embedding; use longer bolts or spacers.
- Repeated tapping of aluminum or plastic: use inserts if serviced more than ~10 times.
- Plastic or gasket in the clamp creeps; add compression limiters.
- Stainless in aluminum when wet corrodes; isolate. Mixed inch and metric hardware in one assembly.

## Verify
Script min/max clearance from table limits; check press-fit hub stress and force; put torque and threadlocker on the drawing; inspect bores with pin gauges.
