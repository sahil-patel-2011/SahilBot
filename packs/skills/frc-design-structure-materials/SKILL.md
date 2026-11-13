---
name: frc-design-structure-materials
description: FRC robot structure and materials: box tube sizes and walls, plates and gussets, polycarbonate, aluminum vs steel, tube plugs, crush blocks, stiffness and weight.
source: you
uses: 0
category: FRC Design
---

## When to use
Choosing tube, plate and material for frames and superstructures; checking spans with frc_mech beam.

## Steps
1. Default stock: 2x1 and 1x1 6061-T6 box tube; 1/8 in wall for drivetrain outer rails (FRCDesign recommendation), 1/16 in wall for lighter superstructure where loads are low.
2. Plates and gussets: ~0.09 in (1/16 class) aluminum for gussets and bellypans, 1/8 in for general plates, 1/4 in for high-load pivots and mounts.
3. Polycarbonate: 1/4 in for impact parts outside the frame (intakes); thin sheet for covers/guards. Keep threadlocker off it (most Loctites crack it). SRPP is lighter, stiffer and tougher than polycarbonate but costs more.
4. Steel: only where strength in a small size matters, or as low ballast (steel bellypan). Usually outsourced.
5. Joints: gussets with rivets plus at least one bolt, tube plugs for tube-to-tube joints (made for 1/8 in wall), crush blocks where bolts pass through thin tube.
6. Check spans: frc_mech beam with section ("2x1x1/16", "1x1x1/8"…), orientation, span, load and case; aim for SF ≥ 2 on static loads and apply an impact factor of 2-3× for parts that get hit.
7. Weight: track every subsystem with frc_mech weight_budget; pocket plates where they're not loaded.

## Material numbers (typical, verify with your supplier)
- 6061-T6: yield ~276 MPa (40 ksi), E ~69 GPa, 2.70 g/cm³.
- 7075-T6: yield ~503 MPa (73 ksi); used for hex shafts and gears; harder to machine.
- Polycarbonate: yield ~60 MPa, very tough, flexible (E ~2.4 GPa).
- Wood: prototypes only (brittle).
- "1/4 in" polycarbonate is sometimes 6 mm; measure stock before cutting slots.

## Checks
- Is every structural member loaded in the strong direction (2x1 "tall" in bending)?
- Are long unsupported spans braced (cross members, triangulation)?
- Bolted thin-wall joints have crush blocks or plugs.

## Common mistakes
- 1/16 wall tube where it gets hit or bolted hard (it dents and crushes).
- Rivets alone in shear-critical joints.
- Threadlocker on polycarbonate.
- Over-building everything and blowing the weight budget.

## Sources
- FRCDesign materials (alloys, thicknesses, polycarbonate, SRPP, steel): https://frcdesign.org/design-handbook/structure/materials/
- FRCDesign structure (tube plugs, crush blocks): https://frcdesign.org/design-handbook/structure/structure/
- FRCDesign Stage 1A plates and frames: https://frcdesign.org/learning-course/
- MatWeb material data: https://www.matweb.com
