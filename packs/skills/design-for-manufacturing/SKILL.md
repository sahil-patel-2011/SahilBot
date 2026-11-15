---
name: design-for-manufacturing
description: Make parts cheaper and right first time for FDM/SLA printing, CNC, sheet metal, laser/router cutting and injection molding (DFM rules).
source: you
uses: 0
category: Mechanical Engineering
triggers: dfm, design for manufacturing, 3d print overhang, print orientation strength, heat-set insert, cnc internal corner radius, pocket depth to diameter, number of setups, sheet metal bend radius, bend relief, k-factor flat pattern, laser kerf, draft angle, uniform wall thickness, undercut, machining quote too high
---

## When
Before sending a part to a printer, shop or vendor, or when a quote is high or parts come out wrong. FRC machines and plates: frc-design-manufacturing. Fits and hardware: fits-and-fasteners. Material: material-selection. Numbers are rules of thumb; the shop's own guide wins.

## Steps
1. Fix process and quantity first: 1-20 print/CNC/laser; 20-1000 CNC or sheet metal; 1000+ molding or casting.
2. Apply the rules below in CAD; ask the vendor for DFM feedback early.
3. Tolerance only functional features; let the rest default to the shop's general tolerance.
4. Print or cut a fit coupon (holes, slots, press bores) before the real part.
5. Report each change, why, and its effect on cost, lead time or yield.

## FDM / SLA printing
- Walls: FDM >= 2-3 perimeters (0.8-1.2 mm at 0.4 mm nozzle), 4-6 for loaded parts; SLA >= ~1 mm.
- Overhangs <= 45 deg from vertical without support; short bridges only; teardrop holes on horizontal axes; chamfer, not fillet, bed edges.
- Layer bonds are the weak plane (often half the in-plane strength or less): orient so bending and tension run along layers.
- Holes print ~0.1-0.3 mm small. Clearances: sliding ~0.2-0.4 mm FDM, ~0.1-0.2 mm SLA; snug ~0-0.1 mm. Tune per printer.
- Heat-set inserts: hole per the insert maker, boss OD ~2x insert OD, press in with a temperature-matched tip, square and flush. Better than tapping plastic for repeat assembly.
- Warping: avoid large flat bottoms, add brims; SLA hollows need 2+ drain holes.

## CNC milling and turning
- Internal corners radius >= tool radius, ideally >= 1/3 of pocket depth and slightly larger than the tool; dogbones where a square part must seat.
- Pocket depth <= 3-4x tool diameter cheap, 6x+ costly; avoid deep narrow slots.
- Holes: standard drill and reamer sizes, drilled depth <= ~4-6x D, blind holes end in a 118 deg cone; tap ~1.5D full thread plus a few pitches of drill.
- Every new direction is a setup (cost, alignment error). Machine from 1-2 sides; put features that must align in one setup.
- Walls >= ~1 mm metal, ~1.5 mm plastic; chamfers are cheaper than outside fillets; engrave text.
- Default +/-0.1 mm (+/-0.005 in); +/-0.025 mm only on bores and locating faces.

## Sheet metal
- Inside bend radius >= thickness T; 6061-T6 cracks, use 5052 or 2-3T; bend across the grain.
- Bend relief where a bend meets an edge: width >= T, depth >= R + T.
- Holes >= ~2-2.5T plus R from a bend line; flange length >= ~4T.
- Flat pattern: bend allowance BA = angle(rad) x (R + K x T), K ~0.3-0.5 (0.44 common). Use the shop's K or bend table in the CAD sheet-metal tool.
- One thickness per part, same radius throughout; PEM hardware instead of tapping thin sheet.

## Laser, router, waterjet
- Kerf: laser ~0.1-0.3 mm, waterjet ~0.8-1 mm, router = tool diameter. Offset in CAM unless the shop says otherwise; test slot-and-tab fits.
- Holes smaller than stock thickness cut poorly; thick laser edges taper.

## Injection molding
- Uniform walls ~1.5-3 mm, 3:1 tapers between thicknesses.
- Draft 1-2 deg per side, 3+ deg textured.
- Ribs 50-60% of wall, height <= 3x wall (avoid sink); core out bosses, tie them to walls with ribs.
- Avoid undercuts (slides and lifters cost); inside radii >= 0.5x wall; ask the molder for gate and knit-line review.

## Pitfalls
Tight tolerances everywhere; square inside pocket corners; printed parts loaded across layers; features that need a 5-axis machine for no reason; holes too close to bends; designing to nominal without a fit coupon.

## Verify
Coupon fits measured with calipers or pin gauges; first-article inspection of critical dimensions; vendor DFM report reviewed before ordering.
