---
name: java-kotlin-wpilib
description: Work in Java or Kotlin Gradle projects, including FRC WPILib robots - gradlew build/test, JUnit 5, null safety, coroutines, robot loop rules.
source: you
uses: 0
category: Coding
triggers: gradlew, build.gradle, build.gradle.kts, gradle wrapper, junit 5, java nullpointerexception, equals and hashcode, java streams, kotlin coroutines, kotlin null safety, spotless, wpilib java project, frc robot code java, gradle test --tests
---

## When
JVM projects on Gradle (Maven: mvn -q test, mvn -Dtest=Class#method test). For FRC depth read frc-code-start-here first, then frc-code-command-based, frc-code-build-deploy, frc-code-sim-testing; the frc_code tool knows WPILib APIs.

## Tooling
- Always the wrapper: ./gradlew, never a global gradle. gradle/wrapper/gradle-wrapper.properties pins the Gradle version; JDK comes from the toolchain block or JAVA_HOME (java -version). WPILib ships its own JDK 17 under ~/wpilib/<year>/jdk.
- Build: ./gradlew build (compiles, tests, checks). Tests: ./gradlew test. One test: ./gradlew test --tests 'com.acme.CartTest.addsItem' (wildcards allowed). Add --info or see build/reports/tests/test/index.html for failure detail.
- Format/lint: ./gradlew spotlessCheck / spotlessApply, checkstyle, ktlintCheck or detekt, whichever the build declares.
- SahilBot: code(action="build"), code(action="run_tests", filter="CartTest").
- Layout: src/main/java|kotlin, src/test/java|kotlin, resources beside them; multi-project builds list modules in settings.gradle(.kts); run a module task as ./gradlew :core:test.

## Java idioms
- Override equals and hashCode together (or use a record); a mismatch breaks HashMap/HashSet.
- Compare strings and boxed numbers with equals; Integer == works only for -128..127 by cache accident.
- Optional for return values, not fields or parameters. Annotate @Nullable/@NonNull at API edges.
- Streams: no side effects in map/filter; Stream.toList() is unmodifiable; don't reuse a stream.
- Removing from a collection while iterating throws ConcurrentModificationException; use removeIf or an Iterator.
- try-with-resources for anything Closeable.

## Kotlin idioms
- ?. and ?: instead of !!; Java return values are platform types, so treat them as nullable.
- data class for values, sealed interface plus when for state; lateinit only for DI or test setup.
- Coroutines: structured concurrency with coroutineScope or a lifecycle scope, never GlobalScope. Blocking I/O in withContext(Dispatchers.IO). Rethrow CancellationException. Test with runTest from kotlinx-coroutines-test.

## JUnit 5
@Test, @BeforeEach, @ParameterizedTest with @CsvSource or @MethodSource, assertThrows, assertEquals(expected, actual) order, assertAll for grouped checks. Needs useJUnitPlatform() in the test task.

## FRC WPILib
- GradleRIO plugin version must match the installed WPILib year. ./gradlew build to compile, ./gradlew simulateJava for desktop sim, ./gradlew deploy only with the robot connected and the user's OK.
- vendordeps/*.json (REVLib, Phoenix 6, PathPlanner, PhotonVision): add via WPILib Manage Vendor Libraries or ./gradlew vendordep --url=<json>; keep versions on the same season.
- Command-based: subsystems own hardware and expose commands; commands declare requirements; RobotContainer binds triggers and default commands; Constants holds ports, gear ratios and gains.
- The loop runs every 20 ms. Never Thread.sleep, busy-wait, or block on network/file I/O in periodic, execute or init; loop overruns print warnings and stall the robot. Use timers, command sequences or Notifier.
- Units: use the WPILib Units library (Meters.of, Rotations) or unit-suffixed names (heightMeters); convert encoder rotations explicitly.
- Test mechanisms with sim classes and JUnit (HAL.initialize in setup).

## Pitfalls
- Running gradle with the wrong JDK (class file version errors).
- Editing build outputs under build/; ignoring deprecation warnings at season rollover.

## Verify
./gradlew build green (or the targeted --tests run, then the full test task); for robot code also a sim run with no loop overrun messages.

## Example
```java
@ParameterizedTest
@CsvSource({"0,0", "2048,1.0", "-1024,-0.5"})
void ticksToRotations(int ticks, double rotations) {
  assertEquals(rotations, Encoders.toRotations(ticks), 1e-9);
}
```
