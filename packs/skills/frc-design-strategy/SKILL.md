---
name: frc-design-strategy
description: Strategy-driven FRC design: scoring analysis, cycle-time math, priority lists and turning the game into robot requirements.
source: you
uses: 0
category: FRC Design
---

## When to use
Kickoff, mid-season redesigns, or deciding whether a feature is worth its weight and build time.

## Steps
1. List every scoring action with its points in auto, teleop and endgame, plus ranking-point bonuses. Note which actions are limited (finite game pieces, time windows, alliance caps).
2. Estimate a cycle: drive to pickup + acquire + drive to score + align + score. Use realistic speeds: about 60-70% of theoretical drive speed over short field runs, plus 0.5-1.5 s per acquisition and per score for a good robot. Points per match ≈ teleop time / cycle time × points per cycle + auto + endgame.
3. Compare robot concepts with a small table: expected points, build difficulty, weight, risk, and how much each depends on driver skill. Use code or a spreadsheet; show assumptions.
4. Consider the alliance: what partners at your events usually do, what the third robot can do, and whether defense matters this year.
5. Write a priority list: Must (needed to be competitive), Should, Could, Won't. Each item gets a requirement with numbers (e.g. "intake from the floor at full drive speed, < 0.5 s").
6. Turn requirements into design constraints in the layout sketch (heights, reach, extension limits, game-piece path).
7. Revisit after week 0 / first event using real match data (scouting).

## Rules of thumb
- Endgame and auto points are often cheap per unit of robot complexity; check them before adding a second scoring mechanism.
- A mechanism that scores 90% of the time beats one that scores more points 60% of the time.
- Cycle time is usually dominated by acquisition and alignment, not top speed: a faster intake often beats a faster drivetrain.
- Every extra degree of freedom costs build time, weight, programming time and failure modes.

## Checks
- Can you state the robot's job in one sentence?
- Does every mechanism map to a Must or Should item?
- Do your cycle-time assumptions survive a stopwatch test on a prototype?

## Common mistakes
- Designing for the best case (no defense, perfect pickups).
- Ignoring endgame until week 5.
- Over-valuing top speed; under-valuing driver practice and reliability.

## Sources
- FRCDesign design challenges (architecture practice): https://frcdesign.org/resources/design-challenges/
- FRC Game Manual and Q&A: https://www.firstinspires.org/resource-library/frc/competition-manual-qa-system
- Chief Delphi forum (strategy and scouting discussions): https://www.chiefdelphi.com
