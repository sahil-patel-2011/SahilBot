---
name: tolerance-stackup
description: Do a tolerance stack-up for an assembly (worst case and statistical).
source: you
uses: 0
category: Mechanical Engineering
triggers: tolerance stackup, stack-up, worst case tolerance, rss tolerance, tolerance chain
---

1. List the chain of dimensions that sets the gap or fit, with signs, nominals and tolerances.
2. Worst case: nominal sum +/- the sum of tolerances. Statistical (RSS): +/- sqrt(sum of tolerance^2). Compute in a short script.
3. Compare with the requirement (min/max gap, interference fit); note the biggest contributors.
4. Recommend tightening the biggest contributors, changing datums or redesigning; use ISO 286 fits (e.g. H7/g6) where relevant and cite the table.
