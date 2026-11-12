---
name: cad-workflow
description: Create or change 3D models with code-driven CAD (CadQuery, OpenSCAD, FreeCAD) and export STEP/STL.
source: you
uses: 0
category: Mechanical Engineering
---

1. Check what's installed (python3 -c "import cadquery", openscad --version). If nothing, ask before installing.
2. Write a parametric script: all key dimensions as named variables at the top, in mm.
3. Build features in order: base sketch, extrude, holes/pockets, fillets and chamfers last (they fail most often).
4. Export STEP for CAD and STL for printing; render a PNG preview if possible and show it.
5. Report file paths, key dimensions and how to change parameters. For SolidWorks/Fusion files, explain the steps or use computer use with the user's OK.
