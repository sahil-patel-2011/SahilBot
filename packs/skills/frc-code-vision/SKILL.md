---
name: frc-code-vision
description: Fuse AprilTag vision into the pose estimator with PhotonVision (2026 PhotonPoseEstimator API) or Limelight MegaTag2, with standard deviations that scale with distance and filters that reject bad measurements.
source: you
uses: 0
category: FRC Programming
---

## Pipeline
camera → AprilTag detections → robot pose estimate + timestamp → sanity filters → `poseEstimator.addVisionMeasurement(pose, timestampSeconds, stdDevs)`.
Odometry stays smooth; vision pulls it back toward the truth. Always pass the capture timestamp (not "now").

## Field layout
`AprilTagFieldLayout layout = AprilTagFieldLayout.loadField(AprilTagFields.k2026RebuiltWelded);` (2026 also has `k2026RebuiltAndymark`, lowercase m; welded vs AndyMark fields differ slightly: use the one your events use; `kDefaultField` is the welded one). VERSION-SENSITIVE: new game each year; 2027 moves AprilTag into a vendordep.

## PhotonVision (PhotonLib 2026.x)
```java
private final PhotonCamera cam = new PhotonCamera("front");
private final PhotonPoseEstimator est = new PhotonPoseEstimator(layout, kRobotToFrontCam);   // 2026 constructor
public void periodic() {
  for (PhotonPipelineResult r : cam.getAllUnreadResults()) {                               // every frame, not just the latest
    Optional<EstimatedRobotPose> e = est.estimateCoprocMultiTagPose(r);
    if (e.isEmpty()) e = est.estimateLowestAmbiguityPose(r);
    e.ifPresent(p -> {
      Pose2d pose = p.estimatedPose.toPose2d();
      if (!plausible(pose, p.targetsUsed)) return;
      drive.addVisionMeasurement(pose, p.timestampSeconds, stdDevs(p.targetsUsed, pose));
    });
  }
}
```
- VERSION-SENSITIVE (2026): the PoseStrategy constructor, `update()`, `setPrimaryStrategy` are deprecated for removal; use the per-strategy `estimate...Pose(result)` methods. `getLatestResult()` is deprecated: loop over `getAllUnreadResults()`. Trig-solve/constrained strategies need `est.addHeadingData(timestamp, heading)` every loop.
- PhotonLib version must match the PhotonVision version on the coprocessor.
- Camera calibration at the resolution you run; `kRobotToFrontCam` (Transform3d, meters/radians) measured from CAD — a wrong transform gives consistent offsets.
- Sim: `VisionSystemSim` + `PhotonCameraSim` with `SimCameraProperties` gives realistic detections in simulation.

## Limelight MegaTag2 (LimelightHelpers.java copied into the project)
```java
LimelightHelpers.SetRobotOrientation("limelight", drive.getPose().getRotation().getDegrees(), 0, 0, 0, 0, 0);  // every loop
var mt2 = LimelightHelpers.getBotPoseEstimate_wpiBlue_MegaTag2("limelight");                                     // blue origin always
boolean reject = mt2 == null || mt2.tagCount == 0 || Math.abs(gyroRateDegPerSec) > 360;
if (!reject) drive.addVisionMeasurement(mt2.pose, mt2.timestampSeconds, VecBuilder.fill(0.7, 0.7, 9999999));
```
- MegaTag2 uses your gyro heading, so it trusts vision for X/Y only (huge heading std dev). The gyro must be correct and field-oriented (blue-origin).
- Limelight 4 has an internal IMU: modes via `SetIMUMode` (seed from the robot gyro while disabled, then an assisted internal mode when enabled; landscape mount required). Check the current docs before choosing.
- Set the camera pose and field map in the Limelight web UI; throttle while disabled to reduce heat (`SetThrottle`).

## Standard deviations (how much to trust each measurement)
- Start from PhotonVision's example: single tag (4, 4, 8), multi-tag (0.5, 0.5, 1) meters/meters/radians, multiplied by (1 + avgDistance²/30); single tag farther than ~4 m → ignore.
- Lower = more trust. Heading std dev large unless multi-tag and close.
- Log the raw vision pose next to the fused pose (AdvantageScope field view) and tune by watching jumps.

## Reject bad measurements
- No tags, or only tags not in the layout.
- Pose outside the field (with a margin) or Z far from 0 (robot is not flying).
- Ambiguity > ~0.2 for single-tag solves.
- Robot rotating fast (> ~360 °/s for MegaTag2), or just collided / wheels slipping (optional).
- Timestamp older than the pose buffer or in the future.
- Far single tags (> 4–5 m).

## CTRE swerve specifics
Override `addVisionMeasurement` in CommandSwerveDrivetrain to convert the FPGA timestamp with `Utils.fpgaToCurrentTime(timestampSeconds)`.

## Common bugs
- Using `Timer.getFPGATimestamp()` instead of the frame timestamp → lagged pose fights odometry.
- Wrong robot-to-camera transform (signs, degrees vs radians) → pose offset that changes with heading.
- Red-origin pose used with a blue-origin estimator.
- Gyro not seeded before MegaTag2 → vision pose rotates around the robot.
- Calling `addVisionMeasurement` with the same frame repeatedly (latest-result polling).

Links: https://docs.photonvision.org/en/latest/docs/programming/photonlib/robot-pose-estimator.html · https://docs.limelightvision.io/docs/docs-limelight/pipeline-apriltag/apriltag-robot-localization-megatag2 · https://docs.wpilib.org/en/stable/docs/software/advanced-controls/state-space/state-space-pose-estimators.html · https://github.com/LimelightVision/limelightlib-wpijava
