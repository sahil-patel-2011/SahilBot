---
name: frc-code-sim-testing
description: Test robot code without a robot: WPILib simulation (physics sims, sim GUI, AdvantageScope), vendor sim support, and JUnit unit tests with the HAL and the CommandScheduler.
source: you
uses: 0
category: FRC Programming
---

## Why
Most bugs (wrong signs, units, command logic, auto sequencing) show up in simulation. Teams that sim ship working code to the robot on day one of build season and between matches.

## Simulation
1. build.gradle: `def includeDesktopSupport = true`. Run `./gradlew simulateJava` (run_command in the background; stop it when done). The sim GUI lets you enable modes and map keyboard/gamepad joysticks.
2. Physics: in each subsystem's `simulationPeriodic()` (or an AdvantageKit `XIOSim`), feed applied voltage into a WPILib sim and write the result back into the motor/encoder sim state:
```java
@Override public void simulationPeriodic() {
  var motorSim = motor.getSimState();                       // Phoenix 6
  motorSim.setSupplyVoltage(RobotController.getBatteryVoltage());
  elevatorSim.setInputVoltage(motorSim.getMotorVoltage());
  elevatorSim.update(0.02);
  double rotorRot = elevatorSim.getPositionMeters() / kMetersPerMotorRotation;
  motorSim.setRawRotorPosition(rotorRot);
  motorSim.setRotorVelocity(elevatorSim.getVelocityMetersPerSecond() / kMetersPerMotorRotation);
}
```
   REV: `SparkMaxSim`/`SparkFlexSim` with `iterate(velocity, batteryVoltage, dt)`. Sims: ElevatorSim, SingleJointedArmSim, FlywheelSim, DCMotorSim, DifferentialDrivetrainSim (2025+ constructors take a LinearSystem plant from `LinearSystemId`). Swerve: the CTRE generator and AdvantageKit templates include swerve sim; maple-sim adds field physics and game pieces.
3. Vision sim: PhotonVision `VisionSystemSim` + `PhotonCameraSim`.
4. Watch it: AdvantageScope connected to the sim (NT4, localhost) → 3D field, mechanism, line graphs. Glass/sim GUI also shows Field2d and Mechanism2d.
5. Test autos in sim with the alliance switched to red and blue.

## Unit tests (JUnit 5, src/test/java, run by ./gradlew build)
```java
class ElevatorTest {
  Elevator elevator;
  @BeforeEach void setup() { assert HAL.initialize(500, 0); elevator = new Elevator(); }
  @AfterEach void teardown() { CommandScheduler.getInstance().cancelAll(); CommandScheduler.getInstance().unregisterAllSubsystems(); elevator.close(); }

  @Test void clampsSetpoint() { assertEquals(ElevatorConstants.kMaxMeters, Elevator.clampGoal(99), 1e-9); }

  @Test void reachesHeight() {
    DriverStationSim.setEnabled(true); DriverStationSim.notifyNewData();
    CommandScheduler.getInstance().schedule(elevator.toHeight(() -> 1.0));
    for (int i = 0; i < 150; i++) { CommandScheduler.getInstance().run(); elevator.simulationPeriodic(); SimHooks.stepTiming(0.02); }
    assertEquals(1.0, elevator.getHeightMeters(), 0.05);
  }
}
```
- Make hardware classes `AutoCloseable` and close them in `@AfterEach` (HAL handles are global: tests otherwise collide on CAN IDs/ports).
- Pure logic (shot tables, state machines, unit conversions, alliance flipping math) needs no HAL: test it as plain Java — the cheapest, most valuable tests.
- `SimHooks.pauseTiming()/stepTiming(dt)` control time; `DriverStationSim` sets enabled/alliance (check its current API).
- Keep tests fast (< a few seconds): `./gradlew build` runs them before every deploy.

## What to test first
1. Conversions (one motor rotation = expected distance).
2. Setpoint clamping and interlocks (arm can't move while elevator is low).
3. Command logic: intake ends when the beam break trips; score sequence order.
4. Auto selection and flipping math.

## Common bugs
- Sim "works" because the sim has no friction/backlash: still tune on the robot.
- Forgetting to update the encoder sim state → mechanism never moves in sim.
- Static subsystem singletons → tests leak state between cases.

Links: https://docs.wpilib.org/en/stable/docs/software/wpilib-tools/robot-simulation/introduction.html · https://docs.wpilib.org/en/stable/docs/software/wpilib-tools/robot-simulation/unit-testing.html · https://docs.wpilib.org/en/stable/docs/software/wpilib-tools/robot-simulation/physics-sim.html · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/simulation/simulation-intro.html
