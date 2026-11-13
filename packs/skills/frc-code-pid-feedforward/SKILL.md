---
name: frc-code-pid-feedforward
description: Tune a mechanism the way top teams do: characterize with SysId, set feedforward (kS/kV/kA/kG), add motion profiling (Motion Magic, MAXMotion, ProfiledPIDController), then a small kP, with units checked.
source: you
uses: 0
category: FRC Programming
---

## The workflow
1. Make the mechanism safe to move: soft limits, current limits, a way to stop (disable).
2. Units first (frc-code-units-constants): know what one unit of position/velocity is.
3. Characterize with SysId → kS (static friction, V), kV (V per unit/s), kA (V per unit/s²), kG (gravity, V).
4. Feedforward does ~90% of the work; set it from SysId (or by hand: kG until it holds, kS until it barely moves, kV from free speed).
5. Motion profile the setpoint (trapezoid/expo) so the mechanism follows a feasible path.
6. Add kP until it tracks without oscillation; add kD only if it overshoots; kI almost never (use it only with an integrator zone/limit).
7. Check: log setpoint vs measurement (AdvantageScope line graph). Tune on the real robot, at full battery and low battery.

## SysId (WPILib SysIdRoutine)
```java
private final SysIdRoutine sysId = new SysIdRoutine(
    new SysIdRoutine.Config(null, Volts.of(4), null,                  // ramp 1 V/s default, step 4 V, timeout 10 s default
        state -> SignalLogger.writeString("state", state.toString())), // CTRE: log with SignalLogger (hoot)
    new SysIdRoutine.Mechanism(v -> motor.setControl(voltReq.withOutput(v.in(Volts))), null, this));
public Command sysIdQuasistatic(SysIdRoutine.Direction d) { return sysId.quasistatic(d); }
public Command sysIdDynamic(SysIdRoutine.Direction d) { return sysId.dynamic(d); }
```
- Bind the four tests (quasistatic fwd/rev, dynamic fwd/rev) to buttons; run each until the mechanism nears its limit (hold the button, release to stop). Arms/elevators: lower step voltage; stay inside the travel.
- CTRE: start `SignalLogger.start()` before and `stop()` after; convert the .hoot to .wpilog with Tuner X or owlet; in the SysId tool pick position, velocity and MotorVoltage signals. REV: log with the WPILib logger callback (or URCL).
- Open the log in the SysId tool (WPILib tools), choose the mechanism type (Simple, Elevator, Arm), check fit quality (r², the plots), copy kS/kV/kA/kG.
- Units of the gains = units you logged (rotations vs meters!). Phoenix 6 slot gains are per mechanism rotation (rot, rps); REVLib per conversion-factor unit.

## Where the gains go
- Phoenix 6: `Slot0.kS/kV/kA/kG/kP/kI/kD`, `GravityType = Elevator_Static | Arm_Cosine`; Motion Magic: `MotionMagicCruiseVelocity` (rot/s), `MotionMagicAcceleration` (rot/s²), `MotionMagicJerk`; or Expo profile (`MotionMagicExpo_kV/kA`). Control with `MotionMagicVoltage`. The profile and PID run on the motor at 1 kHz.
- REVLib 2026: `closedLoop.p/i/d`, `closedLoop.feedForward.kS/kV/kA/kG` (VERSION-SENSITIVE: new in 2026), `closedLoop.maxMotion.cruiseVelocity/maxAcceleration/allowedProfileError`; `setSetpoint(x, ControlType.kMAXMotionPositionControl)`.
- WPILib on the roboRIO (any motor):
```java
private final ProfiledPIDController pid = new ProfiledPIDController(kP, 0, kD, new TrapezoidProfile.Constraints(kMaxVel, kMaxAccel));
private final ElevatorFeedforward ff = new ElevatorFeedforward(kS, kG, kV, kA);
public Command toHeight(double goalMeters) {
  return run(() -> {
    double pidVolts = pid.calculate(getHeightMeters(), goalMeters);
    var sp = pid.getSetpoint();
    motor.setVoltage(pidVolts + ff.calculate(sp.velocity));            // 2025+: calculate(velocity) / calculateWithVelocities(cur, next)
  }).beforeStarting(() -> pid.reset(getHeightMeters(), getVelocity()));
}
```
  ArmFeedforward angles are radians with 0 = horizontal. VERSION-SENSITIVE: `calculate(vel, accel)` on SimpleMotor/Elevator feedforward is deprecated (2025) in favor of `calculateWithVelocities`.

## Mechanism-specific tips
- Flywheel: velocity control; feedforward kS+kV gets you close; small kP; no profile needed; consider TorqueCurrentFOC/bang-bang for fast recovery. "At speed" = within tolerance for a few loops (debounce).
- Elevator: kG constant; profile position; tune with the carriage loaded like in a match.
- Arm: kG·cos(angle) (Arm_Cosine); set the encoder zero at horizontal (or offset it); profile in radians/rotations.
- Turret/pivot without gravity: kS + kV + kP; watch cable limits (soft limits).
- Drivetrain: SysId per side or per module drive motor; translation kP for path following (frc-code-autonomous).

## Checks
- Positive voltage moves positive on the sensor (else PID runs away: disable immediately).
- Setpoints inside soft limits; profile constraints achievable (≤ ~80% of free speed).
- Gains logged and versioned in constants; no tuning numbers only on a dashboard.
- Re-run SysId after big mechanical changes (gearing, mass).

## Common bugs
- kV from SysId in volts per meter/s used with a controller in rotations.
- Integral windup at a hard stop → mechanism slams.
- Arm feedforward fed degrees.
- PID tuned on the bench, fails with a game piece or at low battery (tune under real load; voltage compensation helps).
- Resetting the profiled controller to the old setpoint instead of the current measurement → jump at command start.

Links: https://docs.wpilib.org/en/stable/docs/software/advanced-controls/introduction/index.html · https://docs.wpilib.org/en/stable/docs/software/advanced-controls/system-identification/index.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/device-specific/talonfx/motion-magic.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/wpilib-integration/sysid-integration/index.html
