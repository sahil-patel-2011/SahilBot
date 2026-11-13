---
name: frc-code-can-power
description: Keep the CAN bus and the battery healthy: bus utilization, status frame rates, CANivore, CAN error diagnosis, current limits and brownout prevention.
source: you
uses: 0
category: FRC Programming
---

## CAN basics
- roboRIO CAN is CAN 2.0 at 1 Mbit/s; a CANivore adds a CAN FD bus (faster, more devices, timesync, 250 Hz swerve odometry). Each bus: one daisy chain, 120 Ω termination at both ends (the rio and PDH/terminator).
- IDs: unique per device type per bus (a TalonFX 5 and a CANcoder 5 can coexist; two TalonFX 5 cannot). Set IDs in Tuner X / REV Hardware Client; keep a CAN ID table in Constants and on the robot.
- Watch utilization: `RobotController.getCANStatus()` gives percentBusUtilization, busOffCount, txFullCount, receiveErrorCount, transmitErrorCount (AdvantageKit logs them under /SystemStats/CANBus/*); a CANivore reports its own status (`new CANBus("canivore").getStatus()`). Above ~90% frames go stale.

## Reduce bus load
- Phoenix 6: set the rates you need, turn off the rest:
```java
BaseStatusSignal.setUpdateFrequencyForAll(100, drivePos, driveVel);   // what control/odometry needs
BaseStatusSignal.setUpdateFrequencyForAll(10, temp, supplyCurrent);   // telemetry
ParentDevice.optimizeBusUtilizationForAll(leader, follower, cancoder);
```
  Followers need the leader's DutyCycle/MotorVoltage/TorqueCurrent signals kept enabled.
- REVLib: `config.signals.*PeriodMs(...)` (e.g. slow down absolute-encoder or analog frames you don't use).
- Move swerve (or the busiest devices) to a CANivore.

## Diagnosing CAN errors
1. Driver Station messages / log text: "CAN frame not received/too-stale", Phoenix status codes, REV "CAN timeout". Note which device IDs.
2. `frc_code` wpilog_summary: CAN utilization, error counter increases, CAN messages with timestamps.
3. If one device: its wiring/connector, ID, firmware. If everything after a point in the chain: a broken wire/connector at that point. If random: termination, loose crimp, utilization.
4. Tuner X / REV Hardware Client: devices visible? firmware current (must match the library year)?
5. Code: devices constructed with the right bus name/object; no config spam in loops.

## Power and brownouts
- roboRIO 2 brownout default 6.75 V (settable with `RobotController.setBrownoutVoltage`); roboRIO 1 is fixed (6.3 V). In brownout the rio disables outputs until voltage recovers — the robot "dies" for a moment.
- Causes: total current too high (drive accelerating + mechanisms), stalled motors, worn batteries, bad connections (main breaker, battery leads, Anderson connectors).
- Fixes in code:
  - Stator current limits on every motor (limits torque and heating); supply current limits to cap battery draw (Phoenix: Supply limit + lower limit; REV: smartCurrentLimit).
  - Drive: limit acceleration (slew rate), stator limit just under wheel slip.
  - Don't run everything at once: stage spin-up, idle mechanisms at low power.
  - Optionally scale down mechanism outputs when `RobotController.getBatteryVoltage()` drops (load shedding).
- Fixes outside code: fresh batteries (track them, use a battery beak/analyzer), tight terminals, short wire runs.
- Breakers: 40 A breakers on motor channels; sustained current above breaker rating trips them (sounds like the motor "cutting out" for seconds).

## Checks
- CAN ID table matches the robot; no duplicates (project_scan flags duplicates in code).
- Every motor has a current limit.
- Utilization < ~70% at rest on the rio bus.
- Logs include battery voltage, brownout flag, CAN status.

Links: https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/status-signals.html · https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/talonfx/improving-performance-with-current-limits.html · https://docs.wpilib.org/en/stable/docs/software/roborio-info/roborio-brownouts.html · https://docs.wpilib.org/en/stable/docs/software/can-devices/can-addressing.html
