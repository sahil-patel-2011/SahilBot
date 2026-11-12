---
name: power-supply-design
description: Design or review a power supply (LDO, buck, boost): component values, efficiency, heat.
source: you
uses: 0
category: Electrical Engineering
---

1. Pin down specs: Vin range, Vout, Iout max, ripple, efficiency target, size and cost limits.
2. Pick the topology: LDO when Vin-Vout is small and current low (P = (Vin-Vout)*I); buck to step down efficiently; boost or buck-boost otherwise.
3. Find a real controller on the manufacturer's site (TI, Analog Devices, MPS) and use its datasheet design equations for L, Cout, Cin and the feedback divider.
4. Compute with code: duty cycle, inductor ripple dI = (Vin-Vout)*D/(f*L), output ripple, losses, junction temperature = Ta + P*thetaJA.
5. Check: inductor saturation current above peak with margin, capacitor voltage rating at least 1.5x (MLCC capacitance drops with DC bias), thermal OK at max ambient.
6. Report the parts list with part numbers and links, the calculations, and the datasheet sections used.
