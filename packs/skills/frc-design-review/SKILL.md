---
name: frc-design-review
description: Run an FRC design review: a checklist for a subsystem or whole robot before manufacturing, with math, rules, manufacturability and serviceability checks.
source: you
uses: 0
category: FRC Design
---

## When to use
Before cutting parts for a subsystem, at weekly build-season reviews, and when a mechanism underperforms.

## Steps
1. Restate the requirement with numbers (from frc-design-strategy) and how it will be tested.
2. Math check with frc_mech: motor and ratio (speed, time, current, feedforward numbers), belts/chain centers, shaft torque, beam spans, weight budget.
3. Rules check (frc-design-rules-weight-perimeter): perimeter, extension, height, bumpers, legal motors.
4. Integration: game-piece path, clearances in every state, CG and tipping (frc-design-bumpers-cg), electrical space and wire routing.
5. Controllability: hard stops, sensors/encoders, backlash, how it behaves when disabled.
6. Manufacturability: can our machines make it (fit sheet tolerances, inside corner radii, print orientation)? Lead times on COTS?
7. Serviceability: can a broken part be replaced in about 10 minutes? Spares planned?
8. Risks: top three ways it fails in a match, and the mitigation for each.
9. Decision: go / changes needed / prototype more. Record actions with owners and dates.

## Output format
- Summary (one paragraph), numbers table (inputs, results, margins), issues by severity (blocker / should fix / nice to have), actions with owners.

## Common mistakes
- Reviewing looks instead of numbers.
- No one outside the subsystem in the review.
- Skipping review because "we're behind" (that's when it matters most).

## Sources
- FRCDesign learning course (design methodology, next steps: get feedback, study good CAD): https://frcdesign.org/learning-course/next-steps/
- FRCDesign best practices: https://frcdesign.org/best-practices/
