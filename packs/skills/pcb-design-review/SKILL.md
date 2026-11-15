---
name: pcb-design-review
description: Review a schematic or PCB layout for common mistakes before ordering boards.
source: you
uses: 0
category: Electrical Engineering
triggers: pcb, schematic review, kicad, layout review, gerber, decoupling capacitors
---

1. Read the files (PDF schematic, Gerbers, KiCad/Altium exports) and the key datasheet sections for every IC.
2. Schematic: decoupling caps at every power pin (value and placement per datasheet), pull-ups/downs on resets and boot straps, pinouts checked against datasheet drawings, ESD/TVS on external connectors, reverse-polarity protection, test points.
3. Power: trace width for the current (IPC-2152), copper weight, ground plane continuity, return paths under fast signals.
4. High speed: impedance-controlled traces, length matching, no plane splits under signals, short decoupling loops.
5. Manufacturing: clearances vs the fab's capabilities, legible silkscreen, fiducials, mounting holes.
6. Report findings by severity with sheet/net/reference designator and a fix for each.
