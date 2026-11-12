---
name: circuit-analysis
description: Analyze a DC/AC circuit: node voltages, currents and power, with the math checked by code.
source: you
uses: 0
category: Electrical Engineering
---

1. Write the circuit as a netlist in your notes: nodes, components with values and units, sources.
2. Choose the method: Ohm/Kirchhoff for small circuits, nodal analysis for many nodes, Thevenin/Norton to simplify a load, phasors (jwL, 1/jwC) for steady-state AC.
3. Solve with code, not mental math: python3 with numpy (solve G*V = I). Keep SI units; convert mOhm/kOhm/uF explicitly.
4. Sanity checks: KCL at every node sums to about 0, power delivered = power absorbed, voltages within source limits, signs make sense.
5. Report a short table of node voltages, branch currents and power per component, the assumptions (ideal parts, temperature), and anything near a rating limit.
