---
name: frc-code-project-setup
description: Create or audit a WPILib Java robot project: GradleRIO version, team number, folder layout, vendordeps (install, update, mismatches).
source: you
uses: 0
category: FRC Programming
---

## When to use
Starting a season, importing last year's code, adding a vendor library, or "it won't build after I added X".

## Steps
1. Find the project root: the folder with `build.gradle`, `gradlew`, `.wpilib/wpilib_preferences.json`, `vendordeps/`, `src/main/java/frc/robot/`. Ask the user to attach it if it is not in the workspace.
2. Run `frc_code` action=vendordep_check path=<root>. It reports GradleRIO version → season, every vendordep (name, version, frcYear) and mismatches.
3. Check `.wpilib/wpilib_preferences.json`: `teamNumber` must be the team's number (deploy finds the robot at roboRIO-TEAM-frc.local / 10.TE.AM.2). `projectYear` should match the season.
4. New season: use the WPILib VS Code "Import a WPILib 2025/2026 project" command (WPILib requires importing old projects rather than editing the plugin version by hand), then re-add vendordeps for the new year.
5. Vendordeps: install with WPILib VS Code → "Manage Vendor Libraries" → install online (or `./gradlew vendordep --url=<json url>`). Every vendordep JSON in `vendordeps/` must have the same `frcYear` as GradleRIO. One file per library (duplicate uuids break builds).
6. Build once: `./gradlew build` (see frc-code-build-deploy). Fix errors before anything else.

## Typical 2026 vendordeps (VERSION-SENSITIVE, checked 2026-11-13)
| Library | File | 2026 version | Install URL |
|---|---|---|---|
| WPILib New Commands | WPILibNewCommands.json | 1.0.0 (bundled) | built in |
| CTRE Phoenix 6 | Phoenix6-frc2026-latest.json | 26.3.0 | https://maven.ctr-electronics.com/release/com/ctre/phoenix6/latest/Phoenix6-frc2026-latest.json |
| REVLib | REVLib.json | 2026.0.5 | https://software-metadata.revrobotics.com/REVLib-2026.json |
| PathPlannerLib | PathplannerLib.json | 2026.1.2 | https://3015rangerrobotics.github.io/pathplannerlib/PathplannerLib.json |
| ChoreoLib | ChoreoLib2026.json | 2026.0.3 | https://choreo.autos/lib/ChoreoLib2026.json (check the version field: in Nov 2026 it briefly served a 2027 alpha) |
| AdvantageKit | AdvantageKit.json | 26.0.2 | https://github.com/Mechanical-Advantage/AdvantageKit/releases/latest/download/AdvantageKit.json (plus gradle changes, see frc-code-logging-replay) |
| PhotonLib | photonlib.json | v2026.3.4 | https://maven.photonvision.org/repository/internal/org/photonvision/photonlib-json/1.0/photonlib-json-1.0.json (must match the coprocessor's PhotonVision version) |
| Phoenix 5 (legacy, Talon SRX/Victor SPX only) | Phoenix5-frc2026-latest.json | 5.36.0 | needs Phoenix 6 too; deprecated for 2027 |
Limelight uses a single copied file, LimelightHelpers.java, not a vendordep.

## Layout that scales
```
frc/robot/
  Robot.java            // TimedRobot or LoggedRobot; runs the CommandScheduler
  RobotContainer.java   // subsystems, controllers, bindings, auto chooser
  Constants.java        // or one constants class per subsystem
  subsystems/<mech>/    // Elevator.java (+ ElevatorIO*.java if AdvantageKit)
  commands/             // only for complex multi-subsystem commands
  util/
src/main/deploy/        // pathplanner/, choreo/, swerve/ JSON: copied to the robot on deploy
src/test/java/          // JUnit 5 tests (run by ./gradlew build)
```

## Checks
- `Main.java` untouched (it starts Robot).
- `Robot.robotPeriodic()` calls `CommandScheduler.getInstance().run()`.
- `includeDesktopSupport = true` in build.gradle if you want simulation.
- No absolute paths to files on a laptop; robot files go in `src/main/deploy` and are read with `Filesystem.getDeployDirectory()`.

## Common bugs
- Vendordep from last season → build fails or "UnsatisfiedLinkError" at startup.
- PhotonLib version ≠ PhotonVision on the coprocessor → no results or errors.
- Two copies of the same vendordep (e.g. REVLib.json and REVLib-2025.json).
- Wrong team number → deploy can't find the robot.

Links: https://docs.wpilib.org/en/stable/docs/software/vscode-overview/3rd-party-libraries.html · https://docs.wpilib.org/en/stable/docs/yearly-overview/yearly-changelog.html
