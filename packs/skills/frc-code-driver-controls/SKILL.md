---
name: frc-code-driver-controls
description: Design driver and operator controls: CommandXboxController bindings, deadbands, input shaping, slew limits, field-relative driving, rumble feedback, and a bindings map for the drive team.
source: you
uses: 0
category: FRC Programming
---

## Principles
- Ask the drive team. Write the bindings map first (a table/diagram), then code it.
- Driver drives (and maybe intakes/scores with one button); operator handles mechanisms and overrides. Fewer buttons, more automation.
- Every automated action needs a manual override and a "cancel/stow" button.
- Feedback: rumble when a game piece is acquired, LEDs for state.

## Code
```java
private final CommandXboxController driver = new CommandXboxController(0);
private final CommandXboxController operator = new CommandXboxController(1);

private double shape(double v) { v = MathUtil.applyDeadband(v, 0.08); return Math.copySign(v * v, v); } // squared for fine control
private final SlewRateLimiter xLimiter = new SlewRateLimiter(3.0), yLimiter = new SlewRateLimiter(3.0);  // units/s of stick

drivetrain.setDefaultCommand(drivetrain.driveFieldRelative(
    () -> xLimiter.calculate(-shape(driver.getLeftY())) * kMaxSpeed,   // forward on the stick is negative Y
    () -> yLimiter.calculate(-shape(driver.getLeftX())) * kMaxSpeed,   // left on the stick is negative X; +Y is left in WPILib
    () -> -shape(driver.getRightX()) * kMaxAngular));                    // CCW positive
driver.leftTrigger().whileTrue(intake.intake());
driver.rightBumper().whileTrue(drivetrain.slowMode());
driver.start().onTrue(drivetrain.resetHeading());
operator.y().onTrue(superstructure.goTo(State.HIGH));
operator.a().onTrue(superstructure.goTo(State.STOW));
operator.back().onTrue(Commands.runOnce(() -> CommandScheduler.getInstance().cancelAll()));   // panic: cancel everything
```
- Triggers: `leftTrigger()` uses a 0.5 threshold by default (or pass one); `povUp()` etc. for the D-pad; `axisGreaterThan(axis, t)`.
- 2026 additions: `Trigger.multiPress(presses, windowSec)` for double-taps; `MathUtil.applyDeadband` 2D overload for joystick vectors (VERSION-SENSITIVE: check the javadoc).
- Read sticks inside suppliers (lambdas) so they're read every loop.
- Field-relative: re-zero heading button; with alliance-based operator perspective (CTRE swerve) "forward" is away from the driver on both alliances.

## Rumble feedback
```java
intake.hasPiece.onTrue(Commands.startEnd(() -> driver.getHID().setRumble(RumbleType.kBothRumble, 0.6),
                                         () -> driver.getHID().setRumble(RumbleType.kBothRumble, 0)).withTimeout(0.3).ignoringDisable(true));
```

## Checks
- Bindings map document matches code (project_scan lists bindings).
- No two bindings for the same button doing conflicting things (unless intentional with modifiers).
- Deadband big enough that a released stick never creeps.
- Controller port numbers documented; DS USB order set (drag in the DS USB tab, lock it).
- Works with the controller unplugged/replugged (DS warns; nothing crashes).

## Common bugs
- Sign errors (stick forward drives backward; strafe reversed).
- `onTrue` used where `whileTrue` was meant (mechanism keeps running after release).
- Joystick read once at construction (value instead of supplier).
- Slew limiter shared between axes or recreated every loop.

Links: https://docs.wpilib.org/en/stable/docs/software/commandbased/binding-commands-to-triggers.html · https://docs.wpilib.org/en/stable/docs/software/basic-programming/joystick.html · https://docs.wpilib.org/en/stable/docs/software/advanced-controls/filters/slew-rate-limiter.html
