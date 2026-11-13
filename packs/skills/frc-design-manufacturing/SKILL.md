---
name: frc-design-manufacturing
description: Making FRC parts: CNC router plates, laser cutting, 3D printing (PLA, PETG, TPU, nylon-CF, PC), lathe/mill parts, sheet metal, tolerances and DXF/drawing prep.
source: you
uses: 0
category: FRC Design
---

## When to use
Turning CAD into parts with the team's tools (or a vendor), or when parts come out wrong-sized. For general DFM rules see design-for-manufacturing.

## Steps
1. Know your machines and their real tolerances: run test cuts/prints of bearing bores, hex holes, rivet holes and slots, then record the CAD offsets that work. Keep a team "fit sheet".
2. CNC router (aluminum and polycarbonate plates, tube): inside corners get at least the tool radius (dogbone corners for slot-and-tab fits); hold-downs and tabs planned; DXF exported from the part's face with hole sizes the CAM recognizes.
3. Tube work: drilling jigs or router tube fixtures; standard hole patterns (e.g. 0.5 in spacing) speed assembly.
4. Laser cutting: wood/acrylic for prototypes and jigs. Don't laser polycarbonate (it chars and gives off harmful fumes); route or waterjet it.
5. 3D printing:
   - PLA: easy, stiff, brittle; prototypes and low-load parts.
   - PETG: tougher than PLA; general robot parts.
   - TPU: flexible; bumpers for sensors, compliant wheels/rollers, soft stops.
   - Nylon / nylon-CF (PA-CF): strong and stiff brackets, spacers; needs dry filament and a hardened nozzle.
   - Polycarbonate filament: strong when properly printed and annealed.
   Orient so loads run along layers (strongest in X-Y), use 4-6 walls for strength, teardrop holes to avoid supports, chamfers instead of fillets on the bed, metal hex inserts for torque-carrying bores, no printed motor pinions.
6. Lathe/mill: shafts cut to length, retaining-ring grooves, turned-down ends, spacers. Make a drawing with only the dimensions that matter.
7. Sheet metal (vendor): bend radius ≥ thickness, holes away from bends (≥ ~2× thickness), relief cuts; order early.
8. Tolerances that matter: bearing bores (press), hex bores (slip or snug), center distances (belt/chain/gear), and anything that must line up across two plates (cut them as a pair or use dowels).

## Rules of thumb
- 3D printer hole allowance: start ~0.1-0.5 mm oversize depending on the fit, then tune per printer and material.
- Two plates that hold one shaft should be cut from the same program and ideally the same sheet.
- Deburr and wash polycarbonate before assembly; label parts with part numbers.

## Common mistakes
- Designing to nominal sizes without testing your machine's fit.
- Square inside corners on routed parts.
- Printed parts loaded across layers (they split).
- Lasering polycarbonate.

## Sources
- FRCDesign design for 3D printing: https://frcdesign.org/design-handbook/structure/design-for-3d-printing/
- FRCDesign intro to 3D printing: https://frcdesign.org/design-handbook/structure/intro-to-3d-printing/
- FRCDesign community parts (printed/laser parts): https://frcdesign.org/resources/community-parts/
- FRCDesign structure (crush blocks, print walls): https://frcdesign.org/design-handbook/structure/structure/
