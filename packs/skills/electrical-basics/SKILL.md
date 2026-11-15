---
name: electrical-basics
description: Size power budgets, batteries, wire gauge, fuses and connectors; set up grounding, polarity protection and safe battery handling for DC builds.
source: you
uses: 0
category: Electrical Engineering
triggers: power budget, wire gauge for amps, awg voltage drop, fuse sizing, breaker size for wire, battery runtime, battery capacity ah, star ground, ground loop, reverse polarity protection, lipo safety, lead acid battery, crimp terminal, strain relief, esd strap, inrush current
---

## When
Wiring a robot, bench rig, vehicle or product. Codes and mains: electrical-safety-codes. Regulators and converters: power-supply-design. Node and mesh math: circuit-analysis. FRC wiring: frc-design-electrical-layout, frc-code-can-power. Values are rules of thumb; confirm with datasheets and the applicable code.

## Safety first
- Mains (120/240 VAC): never work live. De-energize, lock out, verify dead with a meter tested on a live source. Building wiring, panels and new circuits go to a licensed electrician. Prefer listed, enclosed supplies over building mains-side circuits.
- LiPo/Li-ion: balance charger, fireproof bag or surface, attended; never charge puffed, punctured or hot packs. 4.2 V/cell max, ~3.0-3.3 V/cell min under load, store at ~3.8 V/cell. Fuse at the pack.
- Lead-acid/AGM: vents hydrogen while charging (ventilate), acid, huge short-circuit current; cover terminals, strap the battery down.
- Remove rings and watches; any battery can weld a wrench.

## Steps
1. **Power budget per rail**: load, voltage, average current, peak current, duty. Average sets energy; coincident peaks set wire, fuse and supply size. Add 20-30% margin. Converter input = output power / efficiency.
2. **Battery**: runtime = Ah x usable fraction / average A. Usable ~80% Li-ion, ~50% lead-acid for cycle life; derate further for cold and high current (Peukert in lead-acid). Peak current must be within the pack's continuous rating.
3. **Wire**: pick gauge by ampacity (insulation rating, bundling, enclosure), then check drop over the round trip: Vdrop = I x (ohm/m) x 2L. Target <= 3%, max 5%. Copper ~mOhm/m: 22 AWG 53, 20 AWG 33, 18 AWG 21, 16 AWG 13.2, 14 AWG 8.3, 12 AWG 5.2, 10 AWG 3.3. Rough short-run chassis ampacity (not building code): 22 AWG 3-5 A, 18 AWG ~10 A, 16 AWG ~13 A, 14 AWG 15-20 A, 12 AWG 20-25 A, 10 AWG 30-40 A.
4. **Fuses/breakers protect the wire**: rating <= wire ampacity and >= ~125% of continuous load, slow enough for motor and capacitor inrush, DC-rated at or above system voltage, at the source end of each branch.
5. **Connectors**: current per contact (derate multi-pin), keyed and latching, voltage rated. Crimp with the terminal's tool, pull-test each crimp, heat-shrink; strain relief so the jacket carries load; service loops. Do not tin wire before crimping.
6. **Grounding**: each circuit returns on its own conductor; star point for power returns; keep motor current out of signal ground; bond chassis at one point; twist supply/return pairs to cut loop area and noise.
7. **Polarity and transients**: keyed connectors; series Schottky (0.3-0.5 V loss) or P-MOSFET ideal diode (low loss); TVS on long or motor lines.
8. **ESD**: wrist strap and mat for bare boards, shielded bags, protection on exposed connectors.

## Example
12 V load, 8 A, 3 m away (6 m round trip). 16 AWG: 6 x 0.0132 x 8 = 0.63 V (5.3%, too much). 14 AWG: 0.40 V (3.3%). 12 AWG: 0.25 V (2.1%). Use 12 AWG with a 10-15 A fuse at the battery. Run the numbers in Python, not by hand.

## Pitfalls
- Sizing fuses to the load instead of the wire; one fuse for many thin branches.
- Ignoring voltage drop on long runs and brownouts at peak current.
- AC-only fuses or switches in DC circuits (arcs do not self-extinguish).
- Bad crimps (pliers, wrong die); solder joints in vibrating harnesses cracking at the wick point.
- Ground loops through shields or chassis; shared returns between motors and sensors.

## Verify
Continuity and polarity check before first power-up; first power through a current-limited bench supply; measure voltage at the load at peak current; feel or thermal-image connectors after a load run (warm = bad crimp or undersized).
