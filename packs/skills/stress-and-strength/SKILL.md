---
name: stress-and-strength
description: Check whether a part or beam is strong and stiff enough (stress, deflection, safety factor).
source: you
uses: 0
category: Mechanical Engineering
triggers: stress analysis, bending stress, deflection, safety factor, beam bending, will it break, yield strength, shear, buckling
---

1. Define geometry, material (yield, ultimate, E), loads (size, direction, static or cyclic) and supports, in consistent units (SI preferred).
2. Pick the model: bending (sigma = M*c/I), torsion (tau = T*r/J), axial, combined stress (von Mises), buckling (Euler) for slender columns, fatigue (Goodman) for cyclic loads.
3. Compute with code, including section properties; show formulas and intermediate values.
4. Report the safety factor against yield (and fatigue if cyclic), max deflection vs allowable, the critical location and assumptions. Flag anything under 2 and say when FEA or testing is needed.
