---
name: frc-code-logging-replay
description: Log everything useful: WPILib DataLog/Epilogue or AdvantageKit (IO layers, @AutoLog inputs, replay), CTRE hoot logs, and reading them in AdvantageScope.
source: you
uses: 0
category: FRC Programming
---

## Pick a logging setup
| Setup | Effort | You get |
|---|---|---|
| WPILib DataLogManager + DriverStation.startDataLog | 2 lines | .wpilog with NT values, DS state, joysticks, console |
| WPILib Epilogue (`@Logged`) | annotations | automatic logging of fields/methods to NT or DataLog |
| AdvantageKit | IO-layer structure | every input logged deterministically → replay code changes against real match logs |
| CTRE SignalLogger (.hoot) | on by default with a CANivore/rio2 | high-rate Phoenix signals; convert to .wpilog with Tuner X/owlet |

## WPILib DataLog (minimum every team should have)
```java
// Robot constructor / robotInit
DataLogManager.start();                                  // USB stick "logs" folder if present, else /home/lvuser/logs
DriverStation.startDataLog(DataLogManager.getLog());     // DS:enabled, DS:autonomous, DS:test, DS:estop, joysticks
```
- Entries: NetworkTables values under `NT:/...`, `messages` (DataLogManager.log), `console` (stdout), `systemTime` (~5 s).
- Files are named FRC_yyyyMMdd_HHmmss.wpilog once the DS connects (FRC_TBD_* before).
- Custom fast entries: `DoubleLogEntry e = new DoubleLogEntry(DataLogManager.getLog(), "/Shooter/Rps"); e.append(v);`
- Epilogue: annotate `Robot` and subsystems with `@Logged`, call `Epilogue.bind(this)` in the Robot constructor; configure backend `new FileBackend(DataLogManager.getLog())` or NT. `@NotLogged` to skip; importance levels DEBUG/INFO/CRITICAL.

## AdvantageKit (2026: 26.0.x)
- Install: vendordep + build.gradle changes from the docs (annotation processor `akit-autolog` for @AutoLog, `replayWatch` task). Easiest: start from an AdvantageKit template project.
- Robot extends `LoggedRobot`. In the constructor:
```java
Logger.recordMetadata("ProjectName", BuildConstants.MAVEN_NAME);
switch (Constants.currentMode) {
  case REAL -> { Logger.addDataReceiver(new WPILOGWriter()); Logger.addDataReceiver(new NT4Publisher()); }   // /U/logs on a USB stick
  case SIM -> Logger.addDataReceiver(new NT4Publisher());
  case REPLAY -> { setUseTiming(false); String path = LogFileUtil.findReplayLog();
                   Logger.setReplaySource(new WPILOGReader(path)); Logger.addDataReceiver(new WPILOGWriter(LogFileUtil.addPathSuffix(path, "_sim"))); }
}
Logger.start();
```
- IO layer pattern:
```java
public interface ElevatorIO {
  @AutoLog class ElevatorIOInputs { public double positionMeters; public double velocityMps; public double appliedVolts; public double[] currentAmps = new double[] {}; public boolean connected; }
  default void updateInputs(ElevatorIOInputs inputs) {}
  default void setVoltage(double volts) {}
  default void setPosition(double meters) {}
}
// ElevatorIOTalonFX (real), ElevatorIOSim (physics sim), and `new ElevatorIO() {}` for replay.
public class Elevator extends SubsystemBase {
  private final ElevatorIO io; private final ElevatorIOInputsAutoLogged inputs = new ElevatorIOInputsAutoLogged();
  @Override public void periodic() { io.updateInputs(inputs); Logger.processInputs("Elevator", inputs); Logger.recordOutput("Elevator/GoalMeters", goal); }
}
```
- Rules for replay to work: all hardware access inside IO implementations; subsystems read only `inputs`; no reading time/sensors outside inputs (use Logger timestamps); don't change inputs mid-cycle.
- Built-in keys useful for debugging: /SystemStats/BatteryVoltage, /SystemStats/BrownedOut, /SystemStats/CANBus/Utilization (+ error counters), /DriverStation/Enabled|Autonomous|..., /PowerDistribution/ChannelCurrent, /RealOutputs/LoggedRobot/FullCycleMS and UserCodeMS (loop timing), /RealOutputs/Console.
- `Logger.recordOutput("Odometry/Robot", pose)` logs structs (Pose2d, SwerveModuleState[]) that AdvantageScope draws.

## CTRE hoot logs
SignalLogger auto-logs on a roboRIO 2 (roboRIO 1 needs a USB stick). Convert: Tuner X → Log Extractor → WPILOG, or `owlet -f wpilog in.hoot out.wpilog`. Exporting Pro-only signals needs a Pro-licensed device in the log.

## Getting logs off the robot
- AdvantageScope: File → Download Logs (robot address = team number or 172.22.11.2 over USB; default folder /U/logs, set /home/lvuser/logs for DataLogManager without USB).
- WPILib DataLogTool: download over SSH and export CSV.
- Name/organize logs by event + match (AdvantageKit records EventName/MatchNumber metadata).

## Viewing (AdvantageScope)
Line Graph (setpoint vs measurement, voltage, current), 2D/3D Field (poses, trajectories, vision), Swerve (module states), Mechanism, Console, Statistics, Joysticks. It opens .wpilog, .hoot, .revlog, .dslog/.dsevents.

## With SahilBot
Use `frc_code` wpilog_summary for a fast health check (brownouts, overruns, CAN, currents) and wpilog_series to pull signals into a Page chart (frc-code-log-analysis).

## Checks
- Logs actually written at events (USB stick present and FAT32/ext; space left).
- Loop time logged; battery voltage logged; mode changes logged; vision poses logged.
- Log volume: don't log huge arrays every loop on the rio (watch FullCycleMS).

Links: https://docs.wpilib.org/en/stable/docs/software/telemetry/datalog.html · https://docs.wpilib.org/en/stable/docs/software/telemetry/robot-telemetry-with-annotations.html · https://docs.advantagekit.org/data-flow/recording-inputs/io-interfaces · https://docs.advantagescope.org/overview/log-files · https://v6.docs.ctr-electronics.com/en/stable/docs/api-reference/api-usage/signal-logging.html
