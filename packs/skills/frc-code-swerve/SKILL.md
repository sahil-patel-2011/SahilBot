---
name: frc-code-swerve
description: Get a swerve drive driving well: choose CTRE generator vs AdvantageKit template vs YAGSL, set up modules/gyro/offsets, field-relative driving, odometry, and tune the modules.
source: you
uses: 0
category: FRC Programming
---

## Pick a base (don't write swerve from scratch in-season)
| Option | Best when | Notes |
|---|---|---|
| CTRE Tuner X Swerve Project Generator | All-CTRE drive (Kraken/Falcon + CANcoder + Pigeon 2) | Generates `TunerConstants` + `CommandSwerveDrivetrain`; odometry runs in a fast thread (250 Hz on CAN FD/CANivore, 100 Hz on CAN 2.0). Swerve requests API. All swerve devices must be on one bus. |
| AdvantageKit swerve templates (TalonFX, TalonFXS, Spark) | Team wants AdvantageKit logging + replay | IO layers (ModuleIO/GyroIO), high-frequency odometry thread, sim built in. Can import TunerConstants. |
| YAGSL | Mixed vendors, JSON config | VERSION-SENSITIVE: moved to yagsl.yassrobotics.com; from 2026.8.05 it is a rewrite on YAMS with a changed JSON schema (controllerproperties.json removed, renamed keys). The 2026 season used 2026.1.x–2026.4.x. Read its changelog before upgrading. |
| REV MAXSwerve template | SPARK MAX/Flex + MAXSwerve modules | Simple, well documented. |

## Setup steps (any base)
1. CAN IDs and bus: one ID per device type; drive, steer, encoder, gyro on the bus the base expects. Verify every device shows in Tuner X / REV Hardware Client.
2. Module geometry: module positions from robot center in meters (+X forward, +Y left). Wrong signs = robot spins when asked to translate.
3. Gear ratios and wheel radius: from the module vendor's docs (e.g. drive ratio, steer ratio, coupling ratio for CTRE). Measure the real wheel diameter (tread wears).
4. Absolute encoder offsets: point all wheels straight forward (bevel gears on the same side, as the base specifies), read the offsets, save them. Re-do after any module swap.
5. Inversions: steer motors must turn the right way with positive output; drive directions per module. Test: robot on blocks, push the stick forward slowly: all wheels point forward and spin forward.
6. Gyro: counter-clockwise positive (WPILib convention). If rotating left makes the heading decrease, invert.
7. Field-relative test on the ground at low speed: stick forward = away from the driver regardless of robot heading.

## CTRE generator usage (2026)
```java
private final double maxSpeed = TunerConstants.kSpeedAt12Volts.in(MetersPerSecond);
private final double maxAngular = RotationsPerSecond.of(0.75).in(RadiansPerSecond);
private final SwerveRequest.FieldCentric drive = new SwerveRequest.FieldCentric()
    .withDeadband(maxSpeed * 0.1).withRotationalDeadband(maxAngular * 0.1)
    .withDriveRequestType(DriveRequestType.OpenLoopVoltage);
drivetrain.setDefaultCommand(drivetrain.applyRequest(() ->
    drive.withVelocityX(-driver.getLeftY() * maxSpeed)      // stick forward is negative
         .withVelocityY(-driver.getLeftX() * maxSpeed)
         .withRotationalRate(-driver.getRightX() * maxAngular)));
driver.start().onTrue(drivetrain.runOnce(drivetrain::seedFieldCentric));   // re-zero heading
RobotModeTriggers.disabled().whileTrue(drivetrain.applyRequest(() -> new SwerveRequest.Idle()).ignoringDisable(true));
```
- Other requests: RobotCentric, SwerveDriveBrake (X-lock), PointWheelsAt, FieldCentricFacingAngle (snap to angle with a heading PID), ApplyRobotSpeeds/ApplyFieldSpeeds (for path following).
- Operator perspective: the generated drivetrain sets "forward" by alliance (0° blue, 180° red) when disabled, so field-centric matches the driver's view on either side.
- Vision: override `addVisionMeasurement` to convert timestamps with `Utils.fpgaToCurrentTime(t)` (the CTRE drivetrain uses its own time base).
- State: `drivetrain.getState().Pose`, `.Speeds`, `.ModuleStates`.

## Odometry and pose
- Odometry = wheel distances + gyro heading. Drifts with wheel slip; vision corrects it (frc-code-vision).
- Use `SwerveDrivePoseEstimator` (or the base's built-in estimator). `resetPose()` at auto start (PathPlanner/Choreo do it from the path's start pose).
- Log the pose (struct Pose2d) and view it on AdvantageScope's 2D/3D field; compare to where the robot really is.

## Module tuning
- Steer: position PID on the module angle (continuous input). Start kP high enough to snap without oscillation; add kS for small static friction. Steer should settle in <0.1 s with no buzz.
- Drive: velocity control with kS/kV(/kA) from SysId (frc-code-pid-feedforward) or open-loop voltage for teleop; small kP for closed-loop autos.
- Optimize module states every loop (`state.optimize(currentAngle)` in 2025+ instance form; `cosineScale` to slow wheels not yet pointed right). VERSION-SENSITIVE: the static `SwerveModuleState.optimize(desired, current)` is deprecated.
- Discretize chassis speeds (`ChassisSpeeds.discretize(speeds, 0.02)`) to stop drift while translating and rotating.
- Current limits: drive stator limit just under wheel slip (test on carpet), steer 20–40 A.
- Slew-rate limit driver inputs if the robot tips or wheels slip (frc-code-driver-controls).

## Common bugs
- Robot translates in a circle or "rotates with heading" when driving field-relative → gyro inverted or wrong module positions (YAGSL calls the fix sequence "the 8 steps").
- One module fights the others → wrong offset or inverted drive on that module.
- Jitter at rest → no deadband; steer kP too high.
- Autos drift → wrong wheel radius/ratio, no vision, slipping wheels (lower accel or current).
- Odometry runs at 50 Hz when it could run faster → enable the base's high-frequency odometry thread (CANivore helps).

Links: https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/mechanisms/swerve/swerve-overview.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/mechanisms/swerve/swerve-requests.html · https://docs.advantagekit.org/getting-started/template-projects/talonfx-swerve-template · https://yagsl.yassrobotics.com · https://docs.wpilib.org/en/stable/docs/software/kinematics-and-odometry/swerve-drive-kinematics.html
