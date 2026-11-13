---
name: frc-code-autonomous
description: Build reliable autos with PathPlanner (AutoBuilder, named commands, event triggers, pathfinding) or Choreo (AutoFactory, AutoRoutine), with correct alliance flipping and an auto chooser.
source: you
uses: 0
category: FRC Programming
---

## Choose
- PathPlanner: GUI paths with constraints, event markers, named commands, on-the-fly pathfinding. Easiest to start.
- Choreo: time-optimal trajectories from a robot model (mass, MOI, motor limits); code-defined routines with triggers. Great for fast, tight autos.
- Both need a holonomic (swerve) or differential drive with good odometry and tuned translation/rotation PID.

## PathPlanner (2026: PathPlannerLib 2026.1.x)
In the drive subsystem constructor (last thing):
```java
RobotConfig config;
try { config = RobotConfig.fromGUISettings(); } catch (Exception e) { DriverStation.reportError("PathPlanner config: " + e.getMessage(), e.getStackTrace()); return; }
AutoBuilder.configure(
    this::getPose, this::resetPose, this::getRobotRelativeSpeeds,
    (speeds, feedforwards) -> driveRobotRelative(speeds, feedforwards),
    new PPHolonomicDriveController(new PIDConstants(5.0, 0, 0), new PIDConstants(5.0, 0, 0)),  // translation, rotation
    config,
    () -> DriverStation.getAlliance().orElse(Alliance.Blue) == Alliance.Red,               // flip for red
    this);
```
In RobotContainer, BEFORE building any auto or chooser:
```java
NamedCommands.registerCommand("intake", intake.intake());
NamedCommands.registerCommand("score", superstructure.score());
autoChooser = AutoBuilder.buildAutoChooser();          // lists autos in deploy/pathplanner/autos
SmartDashboard.putData("Auto Chooser", autoChooser);
public Command getAutonomousCommand() { return autoChooser.getSelected(); }
```
- Robot settings (mass, MOI, wheel COF, module offsets, max speeds) are set in the PathPlanner GUI → saved in deploy/pathplanner/settings.json; keep them true to the robot.
- Event markers: `new EventTrigger("deployIntake").whileTrue(intake.intake())`; a triggered command that requires the drive will interrupt the auto.
- Pathfinding: `AutoBuilder.pathfindToPose(targetPose, new PathConstraints(3.0, 4.0, Units.degreesToRadians(540), Units.degreesToRadians(720)))`; needs deploy/pathplanner/navgrid.json; with AdvantageKit set `Pathfinding.setPathfinder(new LocalADStarAK())` first.
- CTRE drivetrain: output via `SwerveRequest.ApplyRobotSpeeds().withSpeeds(speeds).withWheelForceFeedforwardsX(ff.robotRelativeForcesXNewtons()).withWheelForceFeedforwardsY(ff.robotRelativeForcesYNewtons())` (check names in the CTRE SwerveWithPathPlanner example).
- Build autos once at startup (chooser), not inside getAutonomousCommand(); set `deleteOldFiles = true` in the deploy block so removed paths disappear from the robot.

## Choreo (2026: ChoreoLib 2026.0.x)
```java
autoFactory = new AutoFactory(drive::getPose, drive::resetPose, drive::followTrajectory, true /*alliance flipping*/, drive);
AutoRoutine twoPiece() {
  AutoRoutine r = autoFactory.newRoutine("twoPiece");
  AutoTrajectory toScore = r.trajectory("StartToScore"), toPickup = r.trajectory("ScoreToPickup");
  r.active().onTrue(Commands.sequence(toScore.resetOdometry(), toScore.cmd()));
  toScore.atTime("raise").onTrue(elevator.toHeight(() -> kScoreHeightMeters));
  toScore.done().onTrue(superstructure.score().andThen(toPickup.cmd()));
  return r;
}
// follow: field-relative speeds = sample feedforward + PID on pose error
public void followTrajectory(SwerveSample s) {
  Pose2d p = getPose();
  driveFieldRelative(new ChassisSpeeds(s.vx + xPid.calculate(p.getX(), s.x), s.vy + yPid.calculate(p.getY(), s.y),
      s.omega + headingPid.calculate(p.getRotation().getRadians(), s.heading)));   // headingPid.enableContinuousInput(-PI, PI)
}
autoChooser = new AutoChooser(); autoChooser.addRoutine("Two piece", this::twoPiece);
SmartDashboard.putData("Auto", autoChooser);
RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler());
```
- Starting PID gains from the Choreo docs: x/y kP ≈ 10, heading kP ≈ 7.5; tune on the field.
- VERSION-SENSITIVE: choreo.autos docs now show the 2027 API (ChassisVelocities, Tunables); for 2026 use ChassisSpeeds and SmartDashboard. Time parameters are seconds (double) in 2026.

## Alliance flipping
- Draw paths for the blue side; flip at runtime for red. The 2026 field (REBUILT) is treated as rotationally symmetric by PathPlanner and Choreo (their 2026 defaults); check each new game's symmetry (rotational vs mirrored) before trusting the default.
- Alliance is only known once the DS is connected (and FMS during matches): read it when the auto starts, not in a constructor.
- Reset odometry to the (flipped) start pose at auto start; vision should agree within a few cm.

## Checks
- Auto chooser visible on the dashboard; default is a safe auto (or "do nothing").
- Every named command used in the GUI is registered (unregistered names do nothing; the log warns).
- Paths start where the robot is placed; robot placement guide for drive team.
- Test each auto in simulation (AdvantageScope field view), then on the field at reduced speed.
- Auto finishes (or ends in a safe state) within the game's autonomous period: check the current game manual for its length.

## Common bugs
- NamedCommands registered after AutoBuilder.buildAutoChooser → markers do nothing.
- Wrong flip (robot drives to the wrong side on red) → shouldFlipPath logic or alliance read too early.
- Robot overshoots/lags → translation PID too low/high, RobotConfig mass/MOI wrong, max speed above what the robot can do.
- Gyro not reset/seeded from the path start → field-relative teleop wrong after auto (seed from pose, don't zero blindly).

Links: https://pathplanner.dev/pplib-getting-started.html · https://pathplanner.dev/pplib-build-an-auto.html · https://pathplanner.dev/pplib-named-commands.html · https://choreo.autos/choreolib/getting-started/ · https://choreo.autos/choreolib/auto-factory/
