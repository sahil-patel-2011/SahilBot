# Engineering work

Mechanical, electrical and software engineering with SahilBot's tools. Read the matching skill first
(memory(action="read_skill", name)); handbook-engineering and handbook-code are the overviews.

## Which tool for which ask
| The user asks | Use | Skills |
|---|---|---|
| Design or build a part or assembly in CAD | cad_design: brief → concepts → plan → build → verify → deliver (docs/cad.md). Builds in Onshape (the user's keys) or FreeCAD (on this Mac) | cad-design-workflow, mechanical-design-process, design-for-manufacturing |
| Read or change an existing Onshape document | find_tools("onshape"): documents, parts, features, variables, set_variables, configuration, mass_properties, bounding_box, assembly, export, thumbnail… (changes ask the user) | cad-onshape-api, frc-design-onshape |
| Inspect a local STEP / STL / FreeCAD file | freecad: inspect (size, volume, mass for a material), measure, convert | cad-workflow |
| A calculation (stress, deflection, thermal, fits, tolerances) | run_command with a short Python script, or a sheet (doc_create type "sheet") so the user can change inputs | engineering-calculations, stress-and-strength, thermal-analysis, tolerance-stackup, fits-and-fasteners, material-selection |
| An engineering report or design review | doc_create type "doc" (then doc_export pdf/docx) with the method, assumptions, results and margins | engineering-report, gdt-drawings, systems-engineering |
| Circuits, power, PCBs, firmware | the skill, then calculations with run_command; datasheets with fetch_page | circuit-analysis, power-supply-design, pcb-design-review, embedded-firmware, electrical-basics, electrical-safety-codes, signal-processing |
| Choosing parts, ordering | web research, compare-products; a sheet as the BOM | component-selection, parts-procurement |
| FRC robot mechanisms and code | find_tools("frc"): frc_mech (motor_data, mechanism, gear_ratio_search, center_distance, beam, shaft_torque_check, weight_budget) and frc_code (wpilog_summary, wpilog_series, vendordep_check, project_scan, scouting) | frc-design-*, frc-code-* (start with frc-code-start-here or frc-design-process) |
| Software: features, bugs, refactors | code, git, run_command, jobs (docs/coding.md); hand off to Cursor when it fits (docs/coding-agents.md) | coding-agent-loop, debug-systematically, plan-a-code-change |
| Data analysis, plots, ML | run_command with Python (pandas, numpy, matplotlib), office sheet_summarize for a quick look | python-data-analysis, data-ml-engineering |
| A dev server, watcher, long build | run_command with background: true, then jobs (list, output, wait, stop) | docker-and-deploy, ci-pipeline |
| Hard problem with one right answer | max(strategy="heavy"): independent attempts plus a judge | algorithms-problem-solving |

## Habits that keep engineering work correct
- Units on every number, and one unit system per calculation. Convert at the edges, not in the middle.
- State the assumptions (loads, material properties, safety factor, temperature) and where they came from.
- Sanity-check every result: order of magnitude, a hand estimate, a limit case. A 3 mm bracket holding a car
  is a red flag, not an answer.
- Give margins, not just pass/fail: "stress 120 MPa vs yield 275 MPa, safety factor 2.3".
- Code changes: reproduce first, minimal diff, then typecheck and tests (code run_tests); say only what a run
  showed. The runtime also runs the project's tests before accepting "done" after code changes.
- CAD: verify after building (cad_design verify: size, volume, interference, pictures) before delivering.

## Pitfalls
- Material properties vary by alloy, temper and process: cite the source and the grade.
- Datasheets beat blog posts. Standards (ASME, ISO, NEC, IPC) beat both; say which edition.
- Electrical safety: mains voltage, batteries and high current need the electrical-safety-codes skill and a
  plain warning. Never tell someone to work on live mains.
- FRC rules change each season: check the current game manual before rule claims.

## Verify before you hand it over
Re-run the calculation or test; re-read the file or document you wrote; check the user's constraints
(weight, cost, size, deadline, process) are met; list what's unverified.
