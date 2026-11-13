---
name: frc-code-review-checklist
description: Review FRC robot code like a top team's software lead: run the project scan, then check units, inversions, conversions, requirements, blocking code, allocation in loops, enable/disable behavior, safety and style.
source: you
uses: 0
category: FRC Programming
---

## Steps
1. Scope: a PR/diff (`git diff main...`), a subsystem, or the whole repo. Read the team's conventions (README, Constants style) first. Use code-review for the generic parts.
2. Run `frc_code` action=project_scan path=<root> and action=vendordep_check. Treat their output as leads to confirm in the code, not verdicts.
3. Build: `./gradlew build` (catches compile errors and runs tests).
4. Walk the checklist below, file by file. For each finding: file:line, what goes wrong on the robot (concrete), the fix. Rank: robot-safety > match-losing bugs > reliability > style.
5. Offer to fix; for big refactors, hand a well-scoped brief to Cursor (cursor-coding-handoff) and review its diff after.

## Checklist
Safety and states
- Motors stop when the command ends/interrupts (`end()`, `finallyDo`, `startEnd`).
- Nothing moves on enable unless intended (default commands safe; no setpoints left over from the last enable — reset goals to current position on enable).
- Soft limits and current limits on every mechanism; homing for relative encoders.
- Disabled behavior: brake/coast as intended; things that must run while disabled use `ignoringDisable(true)`.
- E-stop/disable resilience: no code assumes it was enabled continuously.

Units and directions
- Units in names/types; conversion factors correct (ratio direction, /60 for RPM, circumference vs radius).
- Inversions verified (motor, encoder, gyro CCW+); followers aligned/opposed correctly.
- Field coordinate conventions (blue origin, +X away from blue wall, +Y left); alliance flipping only where intended.
- Degrees vs radians; rotations vs radians (Phoenix uses rotations).

Command-based correctness
- `CommandScheduler.getInstance().run()` in robotPeriodic.
- Requirements on every command that drives a subsystem; no two commands writing the same motor.
- Factories return new commands; no command instance reused in two compositions.
- Suppliers for live inputs; no joystick objects inside subsystems.
- Default commands never end (no runOnce defaults).
- Auto named commands registered before building autos.

Loop health
- No `Thread.sleep`, `Timer.delay`, or waiting `while` loops in robot code.
- No configuration calls (`getConfigurator().apply`, REV `configure`) in periodic/execute.
- No `new` of hardware/controllers in loops; reuse control requests; avoid heavy allocation and string building every loop.
- Batched status-signal refresh; no blocking `waitForUpdate` with long timeouts in the main loop.
- No printing every loop.

Hardware/API versions
- Vendordeps all same season; deprecated APIs (CommandBase, PIDSubsystem, setReference → setSetpoint, String CAN bus, getLatestResult, deadlineWith, schedule()) noted with the replacement.
- CAN IDs unique per type per bus and matching the robot's table.

Vision and pose
- Vision uses capture timestamps, std devs scaled by distance/tag count, rejects bad frames; robot-to-camera transforms in meters/radians.

Telemetry and logs
- Logs written (DataLog/AdvantageKit), loop time and battery logged, setpoint + measurement per mechanism.

Style (lower priority)
- Constants grouped per subsystem; no magic numbers; clear names; comments say why. Dead code and commented-out experiments removed before competition.

## Output format
```
### Must fix before next match
1. Elevator.java:57 — periodic() applies TalonFXConfiguration every loop → CAN spam, 30 ms loops. Move to constructor.
### Should fix
...
### Nice to have
...
### Verified OK
(short list of things checked and fine)
```

Links: https://docs.wpilib.org/en/stable/docs/software/commandbased/index.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/control-requests.html
