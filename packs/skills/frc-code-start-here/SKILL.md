---
name: frc-code-start-here
description: Map of the FRC programming skills, the canonical resources, the 2026-vs-2027 version picture, and how to check an API before using it.
source: you
uses: 0
category: FRC Programming
---

Read this first for any FRC (FIRST Robotics Competition) software task, then load the specific skill.

## Which skill
- New project, vendor libraries, GradleRIO: frc-code-project-setup
- Build, simulate, deploy with ./gradlew (and when NOT to): frc-code-build-deploy
- Subsystems, commands, triggers, default commands: frc-code-command-based
- Units library, constants, naming: frc-code-units-constants
- TalonFX / Kraken (Phoenix 6) and SPARK MAX/Flex (REVLib) configuration: frc-code-motor-controllers
- Swerve (CTRE generator, YAGSL, AdvantageKit templates): frc-code-swerve
- PID + feedforward + SysId + Motion Magic: frc-code-pid-feedforward
- Elevator / arm / flywheel / turret recipes with simulation: frc-code-mechanisms
- Autos (PathPlanner, Choreo): frc-code-autonomous
- AprilTag pose estimation (PhotonVision, Limelight): frc-code-vision
- Logging, AdvantageKit IO layers, replay, AdvantageScope: frc-code-logging-replay
- Reading a match log (.wpilog) with the frc_code tool: frc-code-log-analysis
- Simulation and unit tests: frc-code-sim-testing
- CAN bus, status frames, CANivore, brownouts, current limits: frc-code-can-power
- Driver controls and button bindings: frc-code-driver-controls
- Reviewing team code: frc-code-review-checklist
- Something is broken (DS errors, CAN errors, loop overruns, robot won't move): frc-code-debugging
- Competition weekend: frc-code-competition-day
- Git for a robotics team: frc-code-team-git
- Statbotics / The Blue Alliance data: frc-code-scouting-data
- 2027 (SystemCore, WPILib 2027 alpha) questions: frc-code-2027-preview

## Tool
`frc_code` (load with find_tools "frc"): wpilog_summary, wpilog_series, vendordep_check, project_scan, scouting. All read-only. Building and deploying go through run_command.

## Canonical resources (as of Nov 2026)
- WPILib docs (official, current season under /en/stable/; 2027 under /en/latest/): https://docs.wpilib.org/en/stable/
- frcsoftware.org — community "comprehensive guide for learning FRC programming" (the software counterpart to frcdesign.org; started 2026, still growing): https://frcsoftware.org
- Note: "frccoding.org" does not exist (no DNS, unregistered as of 2026-11-13). If a user asks for it, they probably mean frcsoftware.org or the WPILib docs.
- CTRE Phoenix 6: https://v6.docs.ctr-electronics.com/en/stable/  · REVLib: https://docs.revrobotics.com/revlib
- PathPlanner: https://pathplanner.dev  · Choreo: https://choreo.autos
- AdvantageKit: https://docs.advantagekit.org  · AdvantageScope: https://docs.advantagescope.org
- PhotonVision: https://docs.photonvision.org  · Limelight: https://docs.limelightvision.io
- YAGSL (moved): https://yagsl.yassrobotics.com
- Chief Delphi programming forum: https://www.chiefdelphi.com/c/technical/programming/
- Statbotics: https://www.statbotics.io  · The Blue Alliance API: https://www.thebluealliance.com/apidocs
- Older material ("FRC 0 to Autonomous" videos, many team handbooks) is often out of date: check API names against the current docs.

## Version picture (checked 2026-11-13; re-check online, it changes)
- Competition season 2026 (game: REBUILT): WPILib/GradleRIO 2026.2.1, Java 17, roboRIO. Phoenix 6 26.3.0, REVLib 2026.0.5, PathPlannerLib 2026.1.2, ChoreoLib 2026.0.3, AdvantageKit 26.0.2, PhotonLib v2026.3.4.
- 2027 is in alpha (WPILib 2027.0.0-alpha-8): SystemCore replaces the roboRIO, Java 25, packages move from edu.wpi.first to org.wpilib. Docs sites (REV codedocs, Choreo) already show 2027 APIs by default: pin to the 2026 docs for a 2026 robot.
- Always ask or detect which year the team's project targets (frc_code vendordep_check reads GradleRIO). Never mix seasons.

## How to verify an API before writing it
1. Find the project's versions (vendordep_check).
2. Look up the exact class/method in that version's docs or javadoc (web_search + fetch_page). Names flagged VERSION-SENSITIVE in these skills changed recently.
3. If unsure, write the code, then run `./gradlew build` (run_command, in the project folder) and fix compile errors before claiming it works.
4. Tell the user what you could not verify.
