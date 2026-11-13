---
name: frc-code-mechanisms
description: Recipes for elevator, arm/pivot, flywheel/shooter, intake and turret subsystems with command factories, safety limits, state triggers, and matching WPILib physics sims.
source: you
uses: 0
category: FRC Programming
---

## Shape of every mechanism subsystem
1. Hardware fields + one `configure()` (frc-code-motor-controllers).
2. Sensors read once per loop in `periodic()` (cache values, log them).
3. Command factories: `toPosition(x)`, `hold()`, `home()`, `stop()`. Setpoints from constants or suppliers.
4. State as Triggers: `atSetpoint`, `hasPiece`, `isHomed`. Debounce them.
5. Safety: soft limits, current limit, a homing routine for relative encoders, refuse setpoints outside the range (clamp).
6. Simulation: a physics sim updated in `simulationPeriodic()` (WPILib sims below), plus a Mechanism2d (or AdvantageKit LoggedMechanism2d) to see it.

## Elevator
```java
public Command toHeight(DoubleSupplier meters) {
  return run(() -> motor.setControl(mm.withPosition(MathUtil.clamp(meters.getAsDouble(), kMin, kMax) / kMetersPerRot)))
      .withName("Elevator to height");
}
public final Trigger atGoal = new Trigger(() -> Math.abs(getHeight() - goal) < kTolMeters).debounce(0.1);
public Command home() {   // relative encoder: drive down slowly until current spikes, then zero
  return runEnd(() -> motor.setControl(volts.withOutput(-1.5)), () -> motor.setControl(volts.withOutput(0)))
      .until(new Trigger(() -> motor.getStatorCurrent().getValueAsDouble() > 30).debounce(0.2))
      .finallyDo(() -> motor.setPosition(0));
}
```
Sim: `new ElevatorSim(DCMotor.getKrakenX60(2), kGearRatio, kCarriageMassKg, kDrumRadiusM, kMin, kMax, true, 0)`; each sim loop: `sim.setInputVoltage(appliedVolts); sim.update(0.02);` then feed the position back to the motor sim state (Phoenix: `motor.getSimState().setRawRotorPosition(...)`, `setRotorVelocity(...)`, and `setSupplyVoltage(RobotController.getBatteryVoltage())`).

## Arm / pivot
- Absolute encoder (CANcoder, through-bore) so no homing; set the offset so 0 = horizontal (or store the offset).
- Gravity: Arm_Cosine (Phoenix) or ArmFeedforward with radians.
- Interlocks with other mechanisms (e.g. don't swing through the elevator) as Triggers that gate commands: `toAngle(x).onlyIf(elevator.isClear)` or sequence them.
Sim: `new SingleJointedArmSim(DCMotor.getKrakenX60(1), kGearRatio, SingleJointedArmSim.estimateMOI(kLengthM, kMassKg), kLengthM, kMinRad, kMaxRad, true, kStartRad)`.

## Flywheel / shooter
```java
private final VelocityVoltage vel = new VelocityVoltage(0);
public Command spinUp(DoubleSupplier rps) { return run(() -> motor.setControl(vel.withVelocity(rps.getAsDouble()))); }
public final Trigger atSpeed = new Trigger(() -> Math.abs(getRps() - target) < kTolRps).debounce(0.1);
// Score: spin up, wait for speed, feed, stop.
Commands.sequence(shooter.spinUp(() -> kShotRps).until(shooter.atSpeed), Commands.parallel(shooter.spinUp(() -> kShotRps), indexer.feed()).withTimeout(0.6));
```
- Coast mode; current limit; distance → speed lookup with `InterpolatingDoubleTreeMap` (tune points on the field).
Sim: `new FlywheelSim(LinearSystemId.createFlywheelSystem(DCMotor.getKrakenX60(2), kMoiKgM2, kGearRatio), DCMotor.getKrakenX60(2))` (2025+ constructor takes a plant).

## Intake / indexer
- Voltage control is usually enough. Detect pieces with a beam break / CANrange / current spike (debounced).
- End the intake command on `hasPiece`; rumble the controller (frc-code-driver-controls).
- Stall protection: current limit 20–40 A on small motors (NEO 550 especially).

## Turret
- Continuous-rotation limits (cable wrap): clamp target angle into the allowed range, pick the equivalent angle closest to the current one within limits.
- Aim = robot heading + target bearing (from pose or vision); feedforward from robot rotation rate.

## Sim wiring tips
- `DCMotorSim` for generic rotating things: `new DCMotorSim(LinearSystemId.createDCMotorSystem(DCMotor.getNEO(1), J, ratio), DCMotor.getNEO(1))`.
- Battery sag in sim: `RoboRioSim.setVInVoltage(BatterySim.calculateDefaultBatteryLoadedVoltage(sim.getCurrentDrawAmps()))`.
- Mechanism2d: `var mech = new Mechanism2d(1, 2); var root = mech.getRoot("base", 0.5, 0); var stage = root.append(new MechanismLigament2d("elevator", 0.2, 90)); SmartDashboard.putData("Mech", mech);` update `stage.setLength(...)` every loop. VERSION-SENSITIVE: SmartDashboard is deprecated for 2027.

## Checks
- Every mechanism has: limits, current limit, a stop path, sim, logged setpoint + measurement.
- Commands end (or are default/held) — no surprise "stuck running".
- Setpoints in constants with units.

Links: https://docs.wpilib.org/en/stable/docs/software/wpilib-tools/robot-simulation/physics-sim.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/simulation/simulation-intro.html · https://docs.wpilib.org/en/stable/docs/software/dashboards/glass/mech2d-widget.html
