---
name: frc-design-indexers-handoffs
description: Moving game pieces inside an FRC robot: funnels, indexers, conveyors, handoffs between intake, storage and scorer, and piece sensing.
source: you
uses: 0
category: FRC Design
---

## When to use
Anything between "intake has it" and "scorer releases it": serializers, hoppers, belts, handoffs to an arm or shooter.

## Steps
1. Draw the game-piece path in the layout sketch for every robot state; mark every handoff point.
2. Minimize handoffs: each one is a chance to jam. Prefer one continuous path with a consistent grip.
3. Control the piece at all times: always at least one powered contact or a guide; avoid free-fall drops.
4. Use funnels and guides to center the piece before it reaches a narrow mechanism (chamfered entries, polycarbonate guides, low-friction surfaces).
5. Sense the piece at the key points (entry, staged, ready to score); programmers need these to automate.
6. Gear the indexer so its surface speed is equal to or a bit faster than the stage feeding it; slower stages cause pile-ups.

## Rules of thumb
- Equal or increasing surface speed along the path.
- Compression consistent along the path; a sudden pinch point jams.
- Leave clearance for the largest legal piece in its worst orientation, and test damaged/deformed pieces.
- Belts (polycord, flat belts, HTD with grip) are good for long runs; rollers for short ones.

## Checks
- 20-30 back-to-back cycles with no jam on the prototype.
- What happens with two pieces at once (if allowed) or a piece entering backwards?
- Can a jam be cleared by reversing, without opening the robot?

## Common mistakes
- Designing the intake and shooter separately and hoping they meet.
- Free-floating pieces in a hopper that bridge or stack.
- No sensor, so the software can't know where the piece is.

## Sources
- FRCDesign practice mechanisms (rollers, indexers): https://frcdesign.org/learning-course/stage1/1c/introduction/
- FRCDesign layout sketch (game-piece path): https://frcdesign.org/best-practices/master-sketch-setup/
