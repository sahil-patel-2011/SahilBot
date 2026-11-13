---
name: frc-code-competition-day
description: Software checklist for an FRC event: before leaving, load-in, practice day, before each match, between matches, and after the event — versions, deploys, logs, field connection, radio and code freeze discipline.
source: you
uses: 0
category: FRC Programming
---

## Before the event (at the shop)
- [ ] Code freeze branch/tag for the event (e.g. `event/2026casj`), builds clean, tests pass, simulated autos checked (frc-code-team-git).
- [ ] Gradle offline cache warm: run `./gradlew build` once on every programming laptop with internet (events often have none); WPILib installer + vendordep files installed offline on each laptop.
- [ ] Versions: WPILib, vendordeps, roboRIO image, radio firmware, motor-controller firmware (Tuner X / REV client), PhotonVision/Limelight version, Driver Station — all current for the season and matching. Download installers/images ahead of time.
- [ ] Two laptops can deploy; DS laptop has the dashboard layout saved; power settings (no sleep, no updates).
- [ ] USB stick in the rio for logs; space free; old logs archived.
- [ ] Battery log sheet; batteries labeled.
- [ ] Printed bindings map and auto start-position guide for the drive team.
- [ ] Spare: radio, rio (imaged, team number set), ethernet cables, USB cable, CAN terminators, controllers.

## Load-in / practice day
- [ ] Radio programmed at the event's radio kiosk (field radio config); robot connects in the queue/field.
- [ ] Field calibration: measure a few AprilTag positions if allowed; check vision pose against known spots; calibrate cameras at the event lighting if needed.
- [ ] Run every auto on the practice field; note drift; adjust start positions not code if possible.
- [ ] Check dashboard on the field: auto chooser visible, camera stream within bandwidth limits.

## Before each match (queue)
- [ ] Correct auto selected and confirmed by the drive coach (dashboard shows it).
- [ ] Robot code running, joysticks in the right USB order (locked in DS), battery fresh (≥ 12.5 V resting).
- [ ] Gyro/pose: robot placed exactly per the guide; seed heading if the code needs it.
- [ ] No deploys in the queue unless the lead decides to; never deploy to a robot on the field.

## Between matches
1. Pull the log (USB stick or AdvantageScope download) → `frc_code` wpilog_summary: brownouts, loop overruns, CAN errors, hot motors, mode timeline.
2. Ask drivers what felt wrong; match it to the log.
3. Fix only what's needed; small, reviewed changes on the event branch; build + sim; deploy with the user's OK in the pit (robot on a cart/blocks), test the changed function.
4. Commit every deployed change (message: what + why + match number). Never deploy uncommitted code at an event.
5. Battery to the charger; record it.

## After the event
- [ ] Merge the event branch back; tag what played (`event/2026casj-final`).
- [ ] Archive logs by match; write down issues and fixes; update the CAN ID table, bindings map and checklists.
- [ ] Scouting review (frc-code-scouting-data) for the next event's picklist.

## Rules of thumb
- Don't refactor at competition. Don't update vendordeps or firmware mid-event unless fixing a known bug.
- One person owns deploys; announce before deploying.
- If in doubt, revert to the last code that played well (git tag).

Links: https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-4/index.html · https://docs.wpilib.org/en/stable/docs/networking/networking-introduction/index.html · https://docs.wpilib.org/en/stable/docs/software/driverstation/driver-station.html
