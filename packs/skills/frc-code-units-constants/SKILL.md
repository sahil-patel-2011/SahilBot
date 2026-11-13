---
name: frc-code-units-constants
description: Keep units straight in robot code: WPILib Units library (Measure types), constants classes, naming with units, conversion factors, and the classic unit bugs.
source: you
uses: 0
category: FRC Programming
---

## Why
The most common "the mechanism goes the wrong distance" bug is a unit mix-up: rotations vs radians, motor vs mechanism rotations, inches vs meters, RPM vs rotations per second, degrees vs radians. Make units impossible to miss.

## Rules
1. Every constant has a unit in its name (`kElevatorMaxHeightMeters`, `kShooterIdleRps`, `kArmKgVolts`) or is a Measure type (`Meters.of(1.2)`).
2. Use SI inside the code (meters, seconds, radians or rotations, volts, amps, kg). Convert at the edges (driver display, CAD numbers in inches).
3. WPILib geometry (Pose2d, Translation2d, ChassisSpeeds) is meters, meters/second, radians.
4. Phoenix 6 reports rotations and rotations/second (after SensorToMechanismRatio, mechanism rotations). REVLib reports whatever the conversion factor makes it (default motor rotations and RPM!).
5. Gains have units: kV in volts per (unit/s), kP in volts (or amps, or duty cycle) per unit of error. Write them in the name or a comment.
6. No magic numbers in subsystems: gains, ratios, limits, setpoints and CAN IDs live in constants.

## WPILib Units library (2025+ API)
```java
import static edu.wpi.first.units.Units.*;
import edu.wpi.first.units.measure.*;

public static final Distance kMaxHeight = Meters.of(1.25);
public static final LinearVelocity kMaxSpeed = MetersPerSecond.of(4.5);
public static final AngularVelocity kShooterIdle = RotationsPerSecond.of(20);
public static final Voltage kHoldVolts = Volts.of(0.4);

double heightMeters = kMaxHeight.in(Meters);           // back to a double in a chosen unit
Distance h = Inches.of(30).plus(Meters.of(0.1));       // arithmetic converts for you
boolean high = h.gt(Meters.of(0.8));
Angle a = Rotations.of(motor.getPosition().getValueAsDouble()); // Phoenix 6 values are also unit-typed: getValue()
```
- Types: Distance, LinearVelocity, LinearAcceleration, Angle, AngularVelocity, Voltage, Current, Time, Mass, MomentOfInertia.
- Methods: `of`, `in(unit)`, `plus/minus/times/div`, `gt/lt/gte/lte`, `isNear(other, tolerance)`. `divide`/`negate` are deprecated (use `div`/`unaryMinus`).
- Mutable versions (`MutDistance`, `Meters.mutable(0)`) avoid allocation in tight loops; most teams only need them in SysId logging.
- VERSION-SENSITIVE: 2027 makes Measures immutable and moves packages to org.wpilib.

## Conversion factors (write them once, test them)
```java
// Elevator: Kraken -> 9:1 gearbox -> 22T #25 sprocket (pitch 0.25 in)
public static final double kGearRatio = 9.0;                             // motor rotations per sprocket rotation
public static final double kSprocketCircumferenceMeters = 22 * Units.inchesToMeters(0.25);
public static final double kMetersPerMotorRotation = kSprocketCircumferenceMeters / kGearRatio;
```
- Phoenix 6: `cfg.Feedback.SensorToMechanismRatio = kGearRatio;` → position in mechanism (sprocket) rotations; multiply by circumference for meters.
- REVLib: `config.encoder.positionConversionFactor(kMetersPerMotorRotation).velocityConversionFactor(kMetersPerMotorRotation / 60.0);` (velocity is per minute by default).
- Cascade/continuous elevators: the carriage moves 2× (or n×) the first stage: include it in the ratio.
- Sanity test: a unit test that one motor rotation moves the expected distance, or measure with a tape: command 0.5 m, measure, compare.

## Classic bugs
- Degrees passed where radians are expected (`Math.sin(deg)`, ArmFeedforward angle).
- Velocity conversion forgot "/60" on REV.
- Gear ratio inverted (multiplied instead of divided).
- Encoder zero not set at a known position (arms, elevators) → every setpoint offset.
- Mixing robot-relative and field-relative speeds.
- Absolute encoder offset in rotations vs degrees.

Links: https://docs.wpilib.org/en/stable/docs/software/basic-programming/java-units.html · https://docs.wpilib.org/en/stable/docs/software/basic-programming/coordinate-system.html
