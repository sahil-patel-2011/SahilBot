---
name: component-selection
description: Choose real components (ICs, passives, connectors) that are in stock and meet the specs.
source: you
uses: 0
category: Electrical Engineering
triggers: part number, digikey, mouser, choose a component, in stock, datasheet
---

1. Write requirements with margin (voltage at least 1.5x, current at least 1.25x, temperature range), package, cost, quantity.
2. Search distributors (Digi-Key, Mouser, LCSC) by parameters; prefer parts in stock, with second sources and an active lifecycle (not NRND/EOL).
3. Read each candidate's datasheet: absolute maximums, typical application circuit, thermal data, package drawing.
4. Compare 2-4 options in a table: key specs, price at quantity, stock, lifecycle, footprint.
5. Recommend one plus a second source, with links. Never invent part numbers: each must come from a page you opened.
