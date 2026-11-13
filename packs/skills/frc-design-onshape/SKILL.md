---
name: frc-design-onshape
description: Onshape CAD for FRC: document structure, layout (master) sketches, origin cube, part studios vs assemblies, variables, configurations, libraries, BOMs and drawings.
source: you
uses: 0
category: FRC Design
---

## When to use
Setting up a season's CAD, reviewing a student's model, or when CAD is slow, breaks on changes, or can't be manufactured from. If the user wants code-generated CAD, use cad-workflow instead.

## Steps
1. Documents: one "Concept" document (main layout sketch + crayon CAD), one document per subsystem (part studios, sub-assemblies, a subsystem top-level assembly), and one "Main Robot" document that assembles the subsystem top-levels. Version each document separately; release versions when they go to manufacturing.
2. Layout sketch (top-down design): in the concept part studio, sketch drivetrain, bumpers, starting configuration, extension limits, field elements (aligned to the bumpers), the game-piece path and every state of each moving mechanism (construction circles for pivot sweeps). One sketch per subsystem, named clearly. Leave plates, gussets and holes out.
3. Shared origin: robot center at floor level. Put FRCDesign's Origin Cube as the first feature of every part studio so all studios, assemblies and robot code agree on coordinates.
4. Part studios: start with a Derive of the layout sketches, then model only parts you make (plates, cut tubes, cut shafts, modified COTS). Unmodified COTS parts go straight into assemblies from the library. Model each identical part once.
5. Variables: put key dimensions (tube spacing, sprocket teeth, shaft lengths) in a variable table or #variables; use FRCDesign functions like #PulleyPD_5mm(n), #BeltCTC_5mm(belt, n1, n2), #SprocketPD_25(n) and #ChainCTC_25(links, n1, n2) so center distances stay right when teeth change.
6. Configurations: use them for real variants (gear ratio options, tube length families), not as a substitute for a clean model.
7. Assemblies: group each rigid sub-assembly; fasten its Origin Cube mate connector to the origin; put mate connectors for each degree of freedom on the layout sketch so moving sub-assemblies connect with one revolute or slider mate. Add hardware with Replicate. Use simplified library models (motors, modules, electronics).
8. Libraries: FRCDesignLib (and MKCad) for COTS parts and the FeatureScripts (Robot Shaft, Belt & Chain Gen, tube tools). Don't derive COTS geometry into part studios; sketch a pitch circle instead.
9. Manufacturing outputs: DXF exports of plates for the router/laser with hole sizes called out; drawings for lathe/mill parts (shaft lengths, retaining-ring grooves, tolerances only where they matter); a BOM table in the top-level assembly with part numbers, quantity, vendor and a "make/buy" property.
10. Check: section views at every shaft, interference check, motion study through every state, mass properties for CG.

## Rules of thumb
- Fewer mates and fewer derives = faster loading. Avoid heavy FeatureScripts in big studios.
- Name parts before assembling; sort instances into folders (tubes, modules, spacers).
- A change in the layout sketch should ripple through the robot without breaking; if it doesn't, the part was modeled bottom-up.

## Checks
- Can someone else open the robot and find the intake plate in under a minute?
- Do all moving mechanisms use mate connectors defined on the layout sketch?
- Are bearing bores, hex holes and rivet holes sized for your router and stock (frc-design-manufacturing)?

## Common mistakes
- One giant document for the whole robot.
- Dimensions that come from nothing ("looked right") instead of the layout.
- Modeling belt teeth or full-detail COTS everywhere (slow).
- Forgetting bumpers and extension limits in the layout.

## Sources
- FRCDesign document setup: https://frcdesign.org/best-practices/document-setup/
- Layout sketch best practices: https://frcdesign.org/best-practices/master-sketch-setup/
- Part studio best practices: https://frcdesign.org/best-practices/feature-tree-setup/
- Assembly best practices: https://frcdesign.org/best-practices/assembly-setup/
- FRCDesignLib and FeatureScripts: https://frcdesign.org/resources/frcdesignlib/ and https://frcdesign.org/resources/featurescripts/
- Belt/chain functions: https://frcdesign.org/learning-course/stage1/1b/belts/
