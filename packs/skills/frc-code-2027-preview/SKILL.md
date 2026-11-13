---
name: frc-code-2027-preview
description: What changes for the 2027 FRC season (SystemCore controller, WPILib 2027 alpha, Java 25, org.wpilib packages, Commands v3, vendor alphas) and how to prepare a 2026 codebase. Version-sensitive: verify online first.
source: you
uses: 0
category: FRC Programming
---

Everything here was checked on 2026-11-13 against alpha releases and the "latest" WPILib docs. It WILL change before kickoff: always re-check https://docs.wpilib.org/en/latest/docs/yearly-overview/yearly-changelog.html and each vendor's notes before advising.

## Status (Nov 2026)
- WPILib 2027.0.0-alpha-8 (Oct 30, 2026): a stepping stone; a Beta 1 that breaks vendordeps is expected next. Gradle plugin id becomes `org.wpilib.GradleRIO`.
- Vendor alphas exist: REVLib 2027.0.0-alpha-9, AdvantageKit 27.0.0-alpha-7 (no 2027 templates yet), AdvantageScope 27 alphas, PhotonVision 2027 alpha, ChoreoLib 2027 alpha, YAGSL builds targeting 2027 alpha. No public Phoenix 6 frc2027 vendordep was found (Phoenix 5 is slated for removal for 2027).
- Don't move a competition robot to alpha software. Use a separate branch or a test project.

## Big changes (from the 2027 changelog)
- Controller: SystemCore replaces the roboRIO (deploy target `systemcore`, deploy dir /home/systemcore/deploy). CAN classes take a `CANPort`.
- Java 25 (from 17); C++23.
- Packages `edu.wpi.first.*` → `org.wpilib.*` (C++ `frc::` → `wpi::`); constants style becomes ALL_CAPS.
- Commands v3 (`org.wpilib.command3`): coroutine-style commands, `Mechanism` interface, `CommandGamepad`, multi-press triggers, a v3 SysIdRoutine. Commands v2 continues (minus RamseteCommand/SwerveControllerCommand/Mecanum commands).
- `robotInit()` removed (use the Robot constructor); Test mode renamed "Utility"; an OpMode framework is added; `Main` uses `Robot::new`.
- NetworkTables 3 removed (NT4 only). SmartDashboard/Shuffleboard/Sendable → Telemetry and Tunables; SendableChooser → `Selectable`.
- Measures become immutable; AprilTag and CameraServer become vendordeps; AprilTagFields moves into a `Fields` class.
- Timestamps change from microseconds to nanoseconds in the new APIs (check before reusing log tools; the frc_code wpilog reader follows the published .wpilog 1.0 spec).

## Preparing a 2026 codebase now
1. Keep code command-factory style with suppliers (maps cleanly to either commands version).
2. Isolate hardware behind small classes/IO layers (AdvantageKit style) so vendor API changes touch few files.
3. Remove deprecated APIs now (frc-code-review-checklist list): they are the ones removed in 2027.
4. Stop depending on SmartDashboard/Shuffleboard for logic (choosers, tuning); log with DataLog/AdvantageKit/Epilogue.
5. Pass `CANBus` objects (Phoenix 2026), use `setSetpoint` (REV 2026).
6. Try the alpha on a copy: import into WPILib 2027 alpha, fix compile errors, run the simulator.

Links: https://docs.wpilib.org/en/latest/docs/yearly-overview/yearly-changelog.html · https://github.com/wpilibsuite/allwpilib/releases · https://docs.wpilib.org/en/latest/
