---
name: frc-code-debugging
description: Debug robot problems fast: no robot code, robot won't move, mechanism runs away, CAN errors, loop overruns, comms drops, brownouts — using Driver Station messages, logs and targeted experiments.
source: you
uses: 0
category: FRC Programming
---

## First questions (ask the user, quickly)
- What exactly happened, when (match/practice, auto/teleop, time), and what changed since it last worked (code, wiring, firmware, battery)?
- What does the Driver Station show: Communications / Robot Code / Joysticks lights, the message/console pane, battery voltage, brownout/CAN counters?
- Is there a log (.wpilog, .hoot, .dslog)? Attach it → frc-code-log-analysis.

## Symptom → likely causes → checks
| Symptom | Likely causes | Check |
|---|---|---|
| "No Robot Code" after deploy | Exception at startup (NPE in constructor, missing deploy file, vendordep/firmware mismatch) | Riolog / DS console: first stack trace; vendordep_check |
| Robot code restarts during a match | Uncaught exception in a loop | Log text / console for the stack trace and time |
| Nothing moves when enabled | CommandScheduler not run; no default command; motor safety (DifferentialDrive not fed); wrong CAN ID/bus; disabled by brownout | project_scan; DS messages; Tuner X device list |
| One motor dead | CAN ID/bus, unplugged, breaker, follower misconfigured, inverted fighting | Tuner X/REV client blink + self-test; current draw |
| Mechanism runs away / slams | Sensor direction ≠ motor direction (positive feedback), unit mismatch, encoder not zeroed, integral windup | Plot setpoint vs measurement; test with small kP |
| Oscillation | kP/kD too high, backlash, slow sensor update, gains in wrong units | Plot; halve kP; check status frame rate |
| "Loop time of 0.02s overrun" / "CommandScheduler loop overrun" | Blocking calls, config in loops, heavy logging/printing, allocation/GC, slow NT, vision on rio | Watchdog epoch printout names slow parts; FullCycleMS/UserCodeMS in logs; project_scan |
| CAN "frame not received/too stale", status code errors | Wiring break/termination, bus overload, wrong bus name, firmware | frc-code-can-power |
| Brownouts | Too much current, bad battery/connections | wpilog_summary battery section; current limits |
| Comms drops (DS "Communications" flickers) | Radio power/ethernet, rio reboot (brownout), field network, bandwidth (camera streams) | DS log viewer (.dslog) trip time/packet loss; radio status |
| Auto does nothing | Chooser default, auto built at wrong time, named commands not registered, alliance not set | Log/dashboard; frc-code-autonomous |
| Field-relative wrong | Gyro inverted/not seeded, operator perspective | Watch heading in AdvantageScope while rotating by hand |

## Method
1. Reproduce safely (robot on blocks, low speed). Get the exact error text.
2. Read the first stack trace frame in team code (`frc.robot...`); open that file.
3. One hypothesis at a time; cheapest test first (a log line, a dashboard value, a unit test, sim). Change one thing, redeploy only with the user's OK (frc-code-build-deploy).
4. Fix the cause, not the symptom; add a check or test that would have caught it.
5. Record it (team engineering notebook / issue) so the pit crew knows.

## Useful tools
- Driver Station: diagnostics tab, log viewer (.dslog/.dsevents: voltage, CPU, packet loss, trip time).
- Riolog (WPILib VS Code) or `ssh lvuser@roboRIO-TEAM-frc.local` → `/home/lvuser/FRC_UserProgram.log`.
- Phoenix Tuner X: device list, self-test snapshot, plotter, firmware; REV Hardware Client.
- AdvantageScope live (NT4) and logs; WPILib Glass for NT/Field2d.

Links: https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station-errors-warnings.html · https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station-log-viewer.html · https://docs.wpilib.org/en/stable/docs/software/vscode-overview/viewing-console-output.html · https://www.chiefdelphi.com/c/technical/programming/
