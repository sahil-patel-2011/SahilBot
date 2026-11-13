---
name: frc-code-motor-controllers
description: Configure TalonFX/Kraken (CTRE Phoenix 6) and SPARK MAX/Flex (REVLib) correctly: config objects, inversion, neutral mode, current limits, closed loop, followers, status signals. 2026 APIs with version flags.
source: you
uses: 0
category: FRC Programming
---

## Principles
- Configure once at startup with a full config object, then never touch configuration in periodic (it's a blocking CAN call).
- Factory-default by applying a complete config (Phoenix 6 `apply(fullConfig)` overwrites everything; REV `ResetMode.kResetSafeParameters`).
- Set inversion, neutral mode, current limits, gear ratio and gains in the config — not with setter methods sprinkled around.
- Reuse control request objects (Phoenix) to avoid garbage.

## CTRE Phoenix 6 (2026: v26.x) — TalonFX / Kraken X60 / X44
```java
private final CANBus bus = new CANBus("canivore");               // or CANBus.roboRIO()
private final TalonFX motor = new TalonFX(ElevatorConstants.kLeaderId, bus);
private final TalonFX follower = new TalonFX(ElevatorConstants.kFollowerId, bus);
private final MotionMagicVoltage mmReq = new MotionMagicVoltage(0);

void configure() {
  var cfg = new TalonFXConfiguration();
  cfg.MotorOutput.Inverted = InvertedValue.Clockwise_Positive;      // decide by testing slowly
  cfg.MotorOutput.NeutralMode = NeutralModeValue.Brake;
  cfg.CurrentLimits.StatorCurrentLimit = 80;  cfg.CurrentLimits.StatorCurrentLimitEnable = true;
  cfg.CurrentLimits.SupplyCurrentLimit = 50;  cfg.CurrentLimits.SupplyCurrentLimitEnable = true;
  cfg.Feedback.SensorToMechanismRatio = ElevatorConstants.kGearRatio; // positions in mechanism rotations
  cfg.Slot0.kS = 0.12; cfg.Slot0.kG = 0.35; cfg.Slot0.kV = 1.1; cfg.Slot0.kA = 0.02; cfg.Slot0.kP = 8;
  cfg.Slot0.GravityType = GravityTypeValue.Elevator_Static;          // Arm_Cosine for arms
  cfg.MotionMagic.MotionMagicCruiseVelocity = 4;                      // mechanism rot/s
  cfg.MotionMagic.MotionMagicAcceleration = 12;                       // rot/s^2
  cfg.SoftwareLimitSwitch.ForwardSoftLimitThreshold = ElevatorConstants.kMaxRot; cfg.SoftwareLimitSwitch.ForwardSoftLimitEnable = true;
  StatusCode status = StatusCode.StatusCodeNotInitialized;
  for (int i = 0; i < 5 && !status.isOK(); i++) status = motor.getConfigurator().apply(cfg);
  if (!status.isOK()) DriverStation.reportError("Elevator config failed: " + status, false);
  follower.setControl(new Follower(motor.getDeviceID(), MotorAlignmentValue.Opposed)); // 2026 signature
}
public Command toHeight(double rot) { return run(() -> motor.setControl(mmReq.withPosition(rot))); }
```
- Control requests: VoltageOut, DutyCycleOut, PositionVoltage, VelocityVoltage, MotionMagicVoltage, MotionMagicVelocityVoltage, MotionMagicExpoVoltage, DynamicMotionMagicVoltage, TorqueCurrentFOC (FOC/torque modes need Phoenix Pro). CTRE recommends voltage or torque-current output over duty cycle so gains don't change with battery voltage.
- Status signals: `motor.getPosition()` returns a StatusSignal; read `.getValueAsDouble()` or `.getValue()` (unit typed). For several signals, `BaseStatusSignal.refreshAll(pos, vel, current)` once per loop. Set rates with `BaseStatusSignal.setUpdateFrequencyForAll(50, pos, vel)` then `ParentDevice.optimizeBusUtilizationForAll(motor, follower)` to turn off unused frames (2026: optimized signals drop to 4 Hz, not 0).
- Current limit defaults in 2026 firmware: stator 120 A, supply 70 A (lowering to 40 A after 1 s). CTRE does not prescribe one number: find the stator limit from testing (e.g. drive wheels just below slip), add a supply limit to protect breakers/battery.
- VERSION-SENSITIVE (2026): `new TalonFX(id, "canivore")` String bus is deprecated (pass a CANBus); `Follower(id, boolean)` became `Follower(id, MotorAlignmentValue.Aligned/Opposed)`; `setInverted()` on the device was removed earlier (use MotorOutput.Inverted). Phoenix 5 is legacy and cannot drive Talon FX/CANcoder/Pigeon 2 on current firmware.
- Tools: Phoenix Tuner X (firmware, CAN IDs, plotting, self-test, swerve and elevator generators, log extractor for .hoot).

## REVLib (2026: 2026.0.x) — SPARK MAX / SPARK Flex with NEO / NEO Vortex / NEO 550
```java
import com.revrobotics.PersistMode; import com.revrobotics.ResetMode;      // 2026: top-level enums
import com.revrobotics.spark.*; import com.revrobotics.spark.config.*;
import com.revrobotics.spark.SparkLowLevel.MotorType;

private final SparkMax motor = new SparkMax(ArmConstants.kId, MotorType.kBrushless);
private final SparkClosedLoopController pid = motor.getClosedLoopController();

void configure() {
  var cfg = new SparkMaxConfig();
  cfg.inverted(false).idleMode(SparkBaseConfig.IdleMode.kBrake).smartCurrentLimit(40).voltageCompensation(12);
  cfg.encoder.positionConversionFactor(1.0 / ArmConstants.kGearRatio)           // arm rotations
             .velocityConversionFactor(1.0 / ArmConstants.kGearRatio / 60.0);    // arm rot/s (REV default is RPM)
  cfg.closedLoop.feedbackSensor(FeedbackSensor.kPrimaryEncoder).p(2.0).d(0.05).outputRange(-1, 1);
  cfg.closedLoop.maxMotion.cruiseVelocity(1.5).maxAcceleration(4).allowedProfileError(0.01); // 2026 names
  cfg.softLimit.forwardSoftLimit(0.30).forwardSoftLimitEnabled(true);
  cfg.signals.primaryEncoderPositionPeriodMs(20);
  motor.configure(cfg, ResetMode.kResetSafeParameters, PersistMode.kPersistParameters);
}
public Command toAngle(double rot) { return run(() -> pid.setSetpoint(rot, SparkBase.ControlType.kMAXMotionPositionControl, ClosedLoopSlot.kSlot0)); }
```
- Followers: `followerCfg.follow(leader, true)` (invert through follow; `inverted()` has no effect on a follower).
- Current limits (REV guidance): NEO 40–60 A; NEO 550 20–40 A (it overheats fast at stall); Vortex: use the motor curves (default 80 A). For MAXSwerve drive start low (~20 A) and raise until the wheel just breaks traction.
- `kPersistParameters` writes flash: only at startup, never in a loop.
- VERSION-SENSITIVE (2026.0.0 changelog): `setReference()` deprecated → `setSetpoint()`; ResetMode/PersistMode moved to `com.revrobotics`; SmartMotion removed; MAXMotion `maxVelocity`→`cruiseVelocity`, `allowedClosedLoopError`→`allowedProfileError`; feedforward gains now kS/kV/kA/kG (kV replaced kF). Pre-2025 names `CANSparkMax`/`CANSparkFlex` are gone. REV's online codedocs show the 2027 alpha API: use the 2026 examples repo for 2026 code.
- REV Hardware Client: firmware updates, CAN IDs, testing (firmware must match the REVLib year).

## Checks
- Each motor: CAN ID unique for its device type on its bus, inversion verified at low power, brake/coast correct, current limit set, followers configured.
- Positive voltage moves the mechanism in the positive direction of its sensor (else the loop runs away).
- Configs applied once; errors from apply/configure reported.

Links: https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/configuration.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/status-signals.html · https://v6.docs.ctr-electronics.com/en/stable/docs/hardware-reference/talonfx/improving-performance-with-current-limits.html · https://docs.revrobotics.com/revlib/changelog · https://github.com/REVrobotics/REVLib-Examples · https://docs.revrobotics.com/brushless/faq
