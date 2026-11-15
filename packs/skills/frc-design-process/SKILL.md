---
name: frc-design-process
description: FRC robot design process from kickoff to competition: requirements, archetypes, prototyping, layout, CAD, reviews and iteration.
source: you
uses: 0
category: FRC Design
triggers: frc robot design, robot design process, kickoff, robot archetype, prototype, frc mechanism design, design season
---

## When to use
Kickoff weekend, starting any new mechanism, or when a team is "designing in circles". Pair with frc-design-strategy (what to build) and frc-design-onshape (how to model it).

## Steps
1. Read the Game Manual as a team (game sections and robot rules), then list every way to score, the scoring values and the robot limits (perimeter, extension, height, weight). Check Team Updates weekly; rules change every season.
2. Strategy first (frc-design-strategy): ranked priority list of robot abilities ("must / should / could / won't"), with an estimated cycle time for each.
3. Archetypes: sketch 2-4 whole-robot concepts in a quick "crayon" CAD (simple blocks; FRCDesign's KrayonCAD helps). Compare against the priority list, weight, complexity and the team's real build capacity.
4. Prototype the riskiest interactions in the first 1-2 weeks: intake grip, game piece path, shooter consistency. Use wood, 1x1 tube, printed parts and adjustable spacing. Change one variable at a time and record numbers (compression, roller speed, success rate out of 10-20 tries, video).
5. Layout sketch: drivebase, bumpers, extension limits, field elements, motion paths and game piece path (frc-design-onshape). Every major dimension traces to a rule, a field element or a prototype result.
6. Detailed CAD per subsystem, with mechanism math (frc_mech: gearing, speeds, currents, feedforward numbers for programmers).
7. Design review before cutting metal (frc-design-review). Freeze interfaces (mounting, shafts, electrical space) before details.
8. Manufacture and assemble the drivetrain first so programmers get it early.
9. Test against the requirement numbers, fix, iterate. Plan a version 2 of the weakest mechanism before the first event.

## Rules of thumb
- Typical 6-8 week build: week 1 strategy + prototypes; week 2 layout + drivetrain CAD; weeks 3-4 mechanism CAD and manufacturing; weeks 5-6 integration and driver practice; any slack goes to driver practice, which usually beats an extra feature.
- Simple and reliable beats clever and fragile. Score the main objective very well before adding a secondary one.
- Prototype numbers you should capture: roller surface speed, compression, contact time, success rate, cycle time, current draw.
- Design for serviceability: any part that can break must be swappable in about 10 minutes.

## Checks
- Does each subsystem have a requirement with a number (speed, time, reach, capacity)?
- Is the riskiest part of the robot prototyped, not just modeled?
- Is there a weight budget (frc_mech weight_budget) and a frame-perimeter / extension check in the layout?

## Common mistakes
- Picking an archetype before doing strategy; copying last year's champion without the same resources.
- Jumping into detailed CAD before prototyping the game-piece interaction.
- No owner per subsystem, no deadlines, and no review before manufacturing.
- Leaving driver practice for the last week.

## Sources
- FRCDesign learning course (design methodology, top-down design): https://frcdesign.org/learning-course/stage1/1d/top-down-design/
- FRCDesign resources (KrayonCAD, design challenges): https://frcdesign.org/resources/
- FRC Game Manual (current season): https://www.firstinspires.org/resource-library/frc/competition-manual-qa-system
