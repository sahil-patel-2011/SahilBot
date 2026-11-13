---
name: frc-code-log-analysis
description: Diagnose a match or practice run from a .wpilog with the frc_code tool (wpilog_summary, wpilog_series), chart signals in a Page, and turn findings into fixes.
source: you
uses: 0
category: FRC Programming
---

## When
"The robot died in Q42", "why did auto miss", "is our battery/CAN OK", "make a chart of shooter speed", post-event review.

## Steps
1. Get the file: ask the user to attach the .wpilog (or the folder of logs). Robot logs live on the USB stick (`/U/logs`) or `/home/lvuser/logs`; AdvantageScope's File → Download Logs fetches them. CTRE .hoot logs must be converted to .wpilog first (Tuner X Log Extractor or `owlet`). Driver Station .dslog/.dsevents are a different format: open those in AdvantageScope.
2. `frc_code` action=wpilog_summary path=<file>. Read the Flags line first, then the sections:
   - Robot modes: did the robot get enabled when expected? Gaps = comms loss or e-stop.
   - Battery: min voltage and dips; dips below ~6.75 V (roboRIO 2 default) brown out the rio (outputs disabled). A brownout during a match is usually high total current (drive + mechanisms) on a weak battery.
   - Loop timing: cycles over 20 ms and "Loop time of 0.02s overrun" / "CommandScheduler loop overrun" messages.
   - CAN: utilization > ~90%, rising error counters, "frame not received / too stale" messages → wiring or bus overload (frc-code-can-power).
   - Currents and temperatures: which motor pulled the most; anything ≥ 70 °C.
   - Errors and warnings text: exceptions, missing devices, unplugged joysticks.
3. Drill in: `wpilog_series` with entries (exact names from the summary, or a part of the name; "Pose#translation.x" picks a struct field, "ChannelCurrent[3]" an array element), optionally start_s/end_s around the event. Call it with no entries to list everything.
4. Correlate: plot voltage with the big currents at the same time; loop time with what was running; setpoint with measurement for a mechanism.
5. Show it: build a Page with create_page using the series JSON (a line chart per signal, shared time axis, markers at mode changes and dips). Keep it readable: 3–5 signals per chart.
6. Conclude with causes ranked by evidence, each tied to a time and signal, and concrete fixes (current limits, code changes, wiring checks). Say what the log can't tell (e.g. no CAN entries logged).

## Reading the numbers
- Brownout sequence on the roboRIO 2: below the brownout voltage, outputs are disabled until voltage recovers; the DS shows the brownout count.
- Battery resting ~12.5–13 V; under drive acceleration 9–10 V is normal; repeated < 8 V means too much current or a tired battery (test with a battery analyzer).
- FullCycleMS steady > 20 ms → code too slow (allocation, blocking CAN calls, heavy logging, vision processing on the rio). Occasional spikes at enable/disable are common.
- CAN utilization near 100% causes stale frames; Phoenix 6 `optimizeBusUtilization` and fewer status frames help; a CANivore moves devices off the rio bus.
- Motor current at the current limit for long stretches = mechanism stalled or fighting a hard stop.

## Heuristics disclaimer
The summary picks entries by name patterns (BatteryVoltage, BrownedOut, FullCycleMS, CANBus/Utilization, *Current*, *Temp*). Team-specific names may be missed or misclassified: check the entry list and ask the user which entries matter.

Links: https://docs.wpilib.org/en/stable/docs/software/telemetry/datalog.html · https://docs.wpilib.org/en/stable/docs/software/roborio-info/roborio-brownouts.html · https://docs.advantagescope.org
