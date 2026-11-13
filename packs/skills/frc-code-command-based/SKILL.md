---
name: frc-code-command-based
description: Structure robot code with WPILib command-based (v2): subsystems with command factories, triggers, default commands, requirements, composition, and the mistakes that break it.
source: you
uses: 0
category: FRC Programming
---

## The model in one paragraph
A subsystem owns hardware (motors, sensors) and exposes small Commands that use it. The CommandScheduler (run every 20 ms from Robot.robotPeriodic) runs commands, and makes sure only one command at a time requires each subsystem: scheduling a new one interrupts the old one. Triggers (buttons, sensor conditions, robot modes) schedule commands. A default command runs whenever nothing else requires the subsystem.

## Preferred style (2025–2026): command factories, not command classes
```java
public class Intake extends SubsystemBase {
  private final TalonFX roller = new TalonFX(IntakeConstants.kRollerId, CANBus.roboRIO()); // 2026: pass a CANBus, not a String
  private final DigitalInput beamBreak = new DigitalInput(IntakeConstants.kBeamBreakPort);
  private final VoltageOut volts = new VoltageOut(0);           // reuse control requests

  public final Trigger hasPiece = new Trigger(() -> !beamBreak.get()).debounce(0.06);

  /** Runs the rollers in until a game piece is seen. */
  public Command intake() {
    return startEnd(() -> roller.setControl(volts.withOutput(8)), () -> roller.setControl(volts.withOutput(0)))
        .until(hasPiece).withName("Intake");
  }
  public Command eject() { return runEnd(() -> roller.setControl(volts.withOutput(-6)), this::stop).withTimeout(0.5); }
  public Command stopCmd() { return runOnce(this::stop); }
  private void stop() { roller.setControl(volts.withOutput(0)); }
}
```
- `run`, `runOnce`, `startEnd`, `runEnd`, `startRun`, `defer`, `idle()` (new in 2026) on Subsystem automatically require the subsystem.
- `Commands.*` static factories (sequence, parallel, race, deadline, either, select, defer, waitSeconds, waitUntil, none) take requirements explicitly: `Commands.run(() -> ..., intake)`.
- Return `Command` from public methods; keep hardware private. Expose state as `Trigger`s or getters.

## Bindings (RobotContainer)
```java
driver.rightTrigger().whileTrue(intake.intake());
driver.a().onTrue(Commands.sequence(elevator.toHeight(ElevatorConstants.kL2), shooter.shoot()));
intake.hasPiece.onTrue(Commands.runOnce(() -> driver.getHID().setRumble(RumbleType.kBothRumble, 0.5))
    .andThen(Commands.waitSeconds(0.3)).finallyDo(() -> driver.getHID().setRumble(RumbleType.kBothRumble, 0)));
RobotModeTriggers.autonomous().whileTrue(autoChooser.selectedCommandScheduler()); // Choreo pattern
```
Trigger verbs: `onTrue` (start on press), `whileTrue` (run while held, cancel on release), `toggleOnTrue`, `onFalse`, `whileFalse`, `onChange`; combine with `.and()`, `.or()`, `.negate()`, `.debounce(s)`.

## Default commands
- `drivetrain.setDefaultCommand(drivetrain.driveFieldRelative(() -> -driver.getLeftY(), ...))` — pass suppliers (lambdas), not values, or the joystick is read once.
- A default command should normally never end: build it with `run(...)`, not `runOnce(...)` (a runOnce default ends instantly and restarts every loop).
- Good defaults: drive with sticks, hold position, stow/idle mechanisms, run a slow "hold" voltage.

## Composition decorators
`andThen`, `alongWith`, `raceWith`, `deadlineFor` (2025+ name; `deadlineWith` is deprecated), `withTimeout`, `until`, `onlyWhile`, `onlyIf`, `unless`, `repeatedly`, `finallyDo`, `handleInterrupt`, `withName`, `ignoringDisable(true)` (runs while disabled, e.g. LEDs, resetting gyro), `asProxy` (lets a group schedule a command without taking its requirements for the whole group).
A composed command requires the union of its parts' requirements for its whole duration; a command instance can be in only one composition (create a new one per use: that's why factories return new commands).

## Old-style command classes (still valid)
If you write `class X extends Command`: call `addRequirements(subsystem)` in the constructor, implement `initialize/execute/isFinished/end(boolean interrupted)`. Use them for complex logic with state; otherwise prefer factories.

## VERSION-SENSITIVE
- `CommandBase` was removed in 2025 → extend `Command`.
- PIDCommand/PIDSubsystem/ProfiledPIDCommand/TrapezoidProfileCommand/Subsystem are deprecated (2025): put the controller in the subsystem.
- `command.schedule()` is deprecated in 2026: use `CommandScheduler.getInstance().schedule(cmd)` or a Trigger.
- 2027 adds "Commands v3" (org.wpilib.command3, coroutines, Mechanism); v2 still exists. See frc-code-2027-preview.

## Common bugs (check every time)
- Forgot `CommandScheduler.getInstance().run()` in robotPeriodic → nothing runs.
- Missing requirements (old-style class without addRequirements, or `Commands.run(...)` without the subsystem) → two commands fight over a motor; default command never interrupted.
- Reusing one Command object in two bindings/groups → "Commands that have been composed may not be added to another composition".
- Values instead of suppliers in factories → joystick/sensor read once at construction.
- Blocking calls (Thread.sleep, while-loops waiting for sensors) inside execute/periodic.
- Logic in `periodic()` that fights commands (e.g. periodic sets motor output every loop). Periodic should update sensors/telemetry, commands set outputs.
- Motors not stopped in `end()`/`finallyDo` → keeps running after the button is released.

Links: https://docs.wpilib.org/en/stable/docs/software/commandbased/index.html · https://docs.wpilib.org/en/stable/docs/software/commandbased/command-compositions.html · https://docs.wpilib.org/en/stable/docs/software/commandbased/binding-commands-to-triggers.html
