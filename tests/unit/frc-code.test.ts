import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import { frcCodeTool } from '../../src/main/agent/tools/frc_code'
import { extractSeries, formatSummary, isBatteryVoltage, isCurrent, isTemp, lttb, modeKey, seriesCsv, summarizeWpilog } from '../../src/main/frc/logsummary'
import { checkVendordeps, compareVersions, formatScan, formatVendordeps, gradleRioVersion, methodBodies, scanProject, stripJava } from '../../src/main/frc/project'
import { clearScoutingCache, epaTotal, eventKey, formatEvent, formatSbMatches, formatTbaMatches, formatTbaRankings, getJson, teamNum } from '../../src/main/frc/scouting'
import { decodeValue, readHeader, scanWpilog, StructSchemas, WpilogWriter } from '../../src/main/frc/wpilog'

// ---------------------------------------------------------------- synthetic match log

/** A 150 s practice-match log the way DataLogManager + AdvantageKit would write it, with known problems. */
function matchLog(): Buffer {
  const w = new WpilogWriter('SahilBot test fixture')
  const s = (sec: number): number => Math.round(sec * 1e6)
  w.int64('systemTime', s(0.5), Date.UTC(2026, 2, 14, 18, 30) * 1000)
  w.string('/DriverStation/EventName', s(0.5), 'CASJ')
  w.int64('/DriverStation/MatchNumber', s(0.5), 42)
  w.boolean('DS:enabled', s(1), false)
  w.boolean('DS:autonomous', s(1), false)
  w.append('/.schema/struct:Translation2d', 'structschema', s(1), 'double x;double y')
  w.append('/.schema/struct:Rotation2d', 'structschema', s(1), 'double value')
  w.append('/.schema/struct:Pose2d', 'structschema', s(1), 'Translation2d translation;Rotation2d rotation')
  // Auto 10–25 s, teleop 28–163 s.
  w.boolean('DS:autonomous', s(10), true)
  w.boolean('DS:enabled', s(10), true)
  w.boolean('DS:enabled', s(25), false)
  w.boolean('DS:autonomous', s(25), false)
  w.boolean('DS:enabled', s(28), true)
  w.boolean('DS:enabled', s(163), false)
  for (let i = 0; i <= 8000; i++) {
    const t = i * 0.02
    // Battery: 12.6 V sagging under load, a 6.5 V brownout dip at 60 s and a 7.2 V dip at 100 s.
    const v = t >= 60 && t < 60.3 ? 6.5 : t >= 100 && t < 100.5 ? 7.2 : 12.6 - (t > 28 && t < 163 ? 1.2 : 0)
    w.double('/SystemStats/BatteryVoltage', s(t), v)
    w.double('/RealOutputs/LoggedRobot/FullCycleMS', s(t), i % 200 === 0 ? 34 : 9.5)
    w.double('/SystemStats/CANBus/Utilization', s(t), t > 28 ? 0.93 : 0.6)
    w.append('/Drive/Module0/DriveCurrentAmps', 'double', s(t), t > 28 ? 40 + 60 * Math.max(0, Math.sin(t)) : 2)
    w.append('/Drive/Module0/DriveTempCelsius', 'double', s(t), 30 + t * 0.3)
    w.append('/PowerDistribution/ChannelCurrent', 'double[]', s(t), Array.from({ length: 24 }, (_, c) => (c === 3 ? 55 : c)))
    if (i % 10 === 0) {
      w.int64('/SystemStats/CANBus/ReceiveErrorCount', s(t), Math.floor(t / 30))
      w.append('/Odometry/Robot', 'struct:Pose2d', s(t), poseBytes(t / 10, 4, t / 100))
    }
  }
  w.boolean('/SystemStats/BrownedOut', s(0), false)
  w.boolean('/SystemStats/BrownedOut', s(60.1), true)
  w.boolean('/SystemStats/BrownedOut', s(60.4), false)
  w.string('console', s(40), 'Loop time of 0.02s overrun\n  teleopPeriodic(): 0.031s')
  w.string('console', s(41), 'Loop time of 0.02s overrun')
  w.string('console', s(90), 'CAN: Phoenix status code -3: CAN frame not received/too-stale (TalonFX 12)')
  w.string('messages', s(5), 'Warning: Joystick Button 3 on port 0 not available')
  return w.toBuffer()
}

function poseBytes(x: number, y: number, rot: number): Buffer {
  const b = Buffer.alloc(24)
  b.writeDoubleLE(x, 0); b.writeDoubleLE(y, 8); b.writeDoubleLE(rot, 16)
  return b
}

describe('wpilog format (spec examples)', () => {
  test('writer emits the exact bytes from the spec for an int64 entry', () => {
    const w = new WpilogWriter()
    w.start('test', 'int64', 1_000_000)
    w.int64('test', 1_000_000, 3)
    const hex = w.toBuffer().toString('hex').match(/../g)!.join(' ')
    // Header, Start control record (32 bytes), then the 14-byte data record from the spec.
    expect(hex).toBe([
      '57 50 49 4c 4f 47 00 01 00 00 00 00',
      '20 00 1a 40 42 0f 00 01 00 00 00 04 00 00 00 74 65 73 74 05 00 00 00 69 6e 74 36 34 00 00 00 00',
      '20 01 08 40 42 0f 03 00 00 00 00 00 00 00'
    ].join(' '))
  })

  test('reads header, start/finish/metadata and every standard type', () => {
    const w = new WpilogWriter('hello')
    w.double('d', 5, 1.5)
    w.append('f', 'float', 6, 2.25)
    w.int64('i', 7, -42)
    w.boolean('b', 8, true)
    w.string('s', 9, 'héllo')
    w.append('da', 'double[]', 10, [1, 2, 3])
    w.append('ba', 'boolean[]', 11, [true, false])
    w.append('ia', 'int64[]', 12, [7, -8])
    w.append('sa', 'string[]', 13, ['a', 'bc'])
    w.setMetadata('d', 14, '{"source":"NT"}')
    w.finish('d', 15)
    w.double('d', 16, 9) // a new entry id after Finish
    const buf = w.toBuffer()
    expect(readHeader(buf)).toMatchObject({ version: 0x0100, extraHeader: 'hello' })
    const vals: Record<string, unknown> = {}
    const res = scanWpilog(buf, { data: (e, _us, p) => { vals[`${e.name}:${e.id}`] = decodeValue(e.type, p) } })
    expect(vals).toMatchObject({ 'd:1': 1.5, 'f:2': 2.25, 'i:3': -42, 'b:4': true, 's:5': 'héllo', 'da:6': [1, 2, 3], 'ba:7': [true, false], 'ia:8': [7, -8], 'sa:9': ['a', 'bc'], 'd:10': 9 })
    expect(res.entries.find((e) => e.id === 1)?.metadata).toBe('{"source":"NT"}')
    expect(res.truncated).toBe(false)
  })

  test('a log cut off mid-record still reads up to the cut', () => {
    const buf = matchLog()
    const res = scanWpilog(buf.subarray(0, buf.length - 5))
    expect(res.truncated).toBe(true)
    expect(res.records).toBeGreaterThan(1000)
    expect(() => readHeader(Buffer.from('NOTALOG12345'))).toThrow(/WPILOG/)
  })

  test('struct schemas decode nested structs, arrays, enums and char arrays', () => {
    const sc = new StructSchemas()
    sc.add('Translation2d', 'double x;double y')
    sc.add('Rotation2d', 'double value')
    sc.add('Pose2d', 'Translation2d translation;Rotation2d rotation')
    sc.add('Thing', 'enum {a=1, b=2} int8 mode; char name[4]; float q[2]; bool ok')
    expect(sc.size('Pose2d')).toBe(24)
    expect(sc.decode('Pose2d', poseBytes(1, 2, 0.5))).toEqual({ 'translation.x': 1, 'translation.y': 2, 'rotation.value': 0.5 })
    const t = Buffer.alloc(14)
    t.writeInt8(2, 0); t.write('ab', 1); t.writeFloatLE(1.5, 5); t.writeFloatLE(-2, 9); t[13] = 1
    expect(sc.decode('Thing', t)).toEqual({ mode: 2, name: 'ab', 'q[0]': 1.5, 'q[1]': -2, ok: true })
    expect(sc.decodeArray('Pose2d', Buffer.concat([poseBytes(1, 2, 3), poseBytes(4, 5, 6)]))?.[1]).toEqual({ 'translation.x': 4, 'translation.y': 5, 'rotation.value': 6 })
    sc.add('Bits', 'uint8 a:4; uint8 b:4')
    expect(sc.decode('Bits', Buffer.from([0x21]))).toBeNull()
  })
})

describe('wpilog_summary', () => {
  const s = summarizeWpilog(matchLog())

  test('duration, wall clock and match info', () => {
    expect(s.durationS).toBe(163)
    expect(s.wallClockStart).toBe('2026-03-14T18:30:00.000Z')
    expect(s.match).toMatchObject({ EventName: 'CASJ', MatchNumber: '42' })
  })

  test('mode timeline and enabled time', () => {
    expect(s.modes.timeline.map((t) => t.mode)).toEqual(['auto', 'disabled', 'teleop', 'disabled'])
    expect(s.modes.autoS).toBeCloseTo(15, 1)
    expect(s.modes.teleopS).toBeCloseTo(135, 1)
  })

  test('battery dips and brownouts', () => {
    expect(s.voltage?.entry).toBe('/SystemStats/BatteryVoltage')
    expect(s.voltage?.min).toBe(6.5)
    expect(s.voltage?.minAtS).toBeCloseTo(60, 1)
    expect(s.voltage?.dips.length).toBe(2)
    expect(s.voltage?.brownoutDips).toBe(1)
    expect(s.brownedOut[0]).toMatchObject({ entry: '/SystemStats/BrownedOut', events: 1, firstAtS: 60.1 })
  })

  test('loop overruns, CAN, currents and temperatures', () => {
    expect(s.loop.entries[0]).toMatchObject({ entry: '/RealOutputs/LoggedRobot/FullCycleMS', maxMs: 34, over: 41 })
    expect(s.loop.overrunMessages).toBe(2)
    expect(s.can.utilization[0]).toMatchObject({ maxPct: 93 })
    expect(s.can.errors[0]).toMatchObject({ entry: '/SystemStats/CANBus/ReceiveErrorCount', increase: 5 })
    expect(s.can.messages).toBe(1)
    expect(s.currents[0].max).toBeCloseTo(100, 0)
    expect(s.currents.some((c) => c.entry === '/PowerDistribution/ChannelCurrent[3]' && c.max === 55)).toBe(true)
    expect(s.temps[0]).toMatchObject({ entry: '/Drive/Module0/DriveTempCelsius', hot: true })
    expect(s.structs).toContain('Pose2d')
  })

  test('report text has flags and the heuristics disclaimer', () => {
    const text = formatSummary(s)
    expect(text).toMatch(/## Flags: .*brownout-level voltage dip/)
    expect(text).toMatch(/2 loop overrun message/)
    expect(text).toMatch(/CAN utilization peaked at 93%/)
    expect(text).toMatch(/heuristics/)
  })

  test('name heuristics', () => {
    expect(modeKey('DS:enabled')).toBe('enabled')
    expect(modeKey('/DriverStation/EmergencyStop')).toBe('estop')
    expect(modeKey('/Drive/Enabled')).toBeNull()
    expect(isBatteryVoltage('/SystemStats/BatteryVoltage')).toBe(true)
    expect(isBatteryVoltage('/Elevator/AppliedVoltage')).toBe(false)
    expect(isBatteryVoltage('/SystemStats/BrownoutVoltage')).toBe(false)
    expect(isCurrent('/Arm/StatorCurrent')).toBe(true)
    expect(isCurrent('/Arm/CurrentLimit')).toBe(false)
    expect(isTemp('/Shooter/TempCelsius')).toBe(true)
    expect(isTemp('/Auto/TemplateName')).toBe(false)
  })
})

describe('wpilog_series', () => {
  const buf = matchLog()
  test('downsamples numeric series and keeps the brownout spike', () => {
    const r = extractSeries(buf, ['BatteryVoltage'], { maxPoints: 100 })
    expect(r.series).toHaveLength(1)
    expect(r.series[0].total).toBe(8001)
    expect(r.series[0].points).toHaveLength(100)
    expect(Math.min(...r.series[0].points.map((p) => p[1] as number))).toBe(6.5)
  })
  test('array element, struct field and time window', () => {
    const r = extractSeries(buf, ['/PowerDistribution/ChannelCurrent[3]', '/Odometry/Robot#translation.x'], { startS: 10, endS: 20 })
    expect(r.series.map((s) => s.name)).toEqual(['/PowerDistribution/ChannelCurrent[3]', '/Odometry/Robot#translation.x'])
    expect(r.series[0].points.every(([t, v]) => t >= 10 && t <= 20 && v === 55)).toBe(true)
    expect(r.series[1].points.at(-1)).toEqual([20, 2])
  })
  test('struct without a field gives every field; booleans become change points; unmatched reported', () => {
    const r = extractSeries(buf, ['/Odometry/Robot', 'DS:enabled', 'NoSuchThing'])
    expect(r.series.map((s) => s.name)).toEqual(expect.arrayContaining(['/Odometry/Robot#translation.x', '/Odometry/Robot#translation.y', '/Odometry/Robot#rotation.value', 'DS:enabled']))
    expect(r.series.find((s) => s.name === 'DS:enabled')!.points.map((p) => p[1])).toEqual([0, 1, 0, 1, 0])
    expect(r.unmatched).toEqual(['NoSuchThing'])
    expect(seriesCsv(r).split('\n')[0]).toBe('series,t_s,value')
  })
  test('wide arrays fall back to the max element with a note', () => {
    const r = extractSeries(buf, ['ChannelCurrent'], { maxPoints: 20 })
    expect(r.series[0].name).toBe('/PowerDistribution/ChannelCurrent[max]')
    expect(r.notes.join(' ')).toMatch(/24 elements/)
  })
  test('lttb keeps endpoints and size', () => {
    const d = Array.from({ length: 1000 }, (_, i) => [i, i === 500 ? 99 : 0] as [number, number])
    const o = lttb(d, 50)
    expect(o).toHaveLength(50)
    expect(o[0]).toEqual([0, 0]); expect(o[49]).toEqual([999, 0])
    expect(o.some((p) => p[1] === 99)).toBe(true)
  })
})

// ---------------------------------------------------------------- robot project fixtures

function robotProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'frc-'))
  writeFileSync(join(root, 'build.gradle'), 'plugins {\n  id "java"\n  id "edu.wpi.first.GradleRIO" version "2026.2.1"\n}\n')
  mkdirSync(join(root, '.wpilib'))
  writeFileSync(join(root, '.wpilib', 'wpilib_preferences.json'), JSON.stringify({ currentLanguage: 'java', projectYear: '2026', teamNumber: 9999 }))
  const vd = join(root, 'vendordeps')
  mkdirSync(vd)
  const dep = (file: string, j: object): void => writeFileSync(join(vd, file), JSON.stringify(j))
  dep('WPILibNewCommands.json', { fileName: 'WPILibNewCommands.json', name: 'WPILib-New-Commands', version: '1.0.0', uuid: '111', frcYear: '2026', javaDependencies: [{ groupId: 'edu.wpi.first.wpilibNewCommands', artifactId: 'wpilibNewCommands-java', version: 'wpilib' }] })
  dep('Phoenix6-frc2026-latest.json', { fileName: 'Phoenix6-frc2026-latest.json', name: 'CTRE-Phoenix (v6)', version: '26.1.0', uuid: 'e995de00-2c64-4df5-8831-c1441420ff19', frcYear: '2026', jsonUrl: 'https://maven.ctr-electronics.com/release/com/ctre/phoenix6/latest/Phoenix6-frc2026-latest.json', javaDependencies: [] })
  dep('REVLib.json', { fileName: 'REVLib.json', name: 'REVLib', version: '2025.0.3', uuid: '3f48eb8c-50fe-43a6-9cb7-44c86353c4cb', frcYear: '2025', javaDependencies: [] })
  dep('REVLib-old-copy.json', { fileName: 'REVLib.json', name: 'REVLib', version: '2025.0.0', uuid: '3f48eb8c-50fe-43a6-9cb7-44c86353c4cb', frcYear: '2025', javaDependencies: [] })
  dep('broken.json', '{ nope' as unknown as object)
  writeFileSync(join(vd, 'broken.json'), '{ nope')
  const src = join(root, 'src', 'main', 'java', 'frc', 'robot')
  mkdirSync(join(src, 'subsystems'), { recursive: true })
  mkdirSync(join(src, 'commands'), { recursive: true })
  writeFileSync(join(src, 'Robot.java'), `package frc.robot;
import edu.wpi.first.wpilibj.TimedRobot;
public class Robot extends TimedRobot {
  private RobotContainer container = new RobotContainer();
  @Override public void robotPeriodic() { /* CommandScheduler.getInstance().run() was forgotten */ }
}
`)
  writeFileSync(join(src, 'Constants.java'), `package frc.robot;
public final class Constants {
  public static final int kElevatorLeaderId = 5;
  public static final double kElevatorP = 2.0;
  public static final double kMaxHeight = 1.2;
  public static final double kMinHeight = 0.0;
  public static final double kStowSetpoint = 0.1;
  public static final double kArmLengthMeters = 0.5;
}
`)
  writeFileSync(join(src, 'RobotContainer.java'), `package frc.robot;
import edu.wpi.first.wpilibj2.command.button.CommandXboxController;
import com.pathplanner.lib.auto.NamedCommands;
public class RobotContainer {
  private final Elevator elevator = new Elevator();
  private final CommandXboxController driver = new CommandXboxController(0);
  public RobotContainer() {
    NamedCommands.registerCommand("score", elevator.toHeight(1.0));
    driver.a().onTrue(elevator.toHeight(0.5));
    elevator.setDefaultCommand(elevator.runOnce(() -> elevator.stop()));
  }
}
`)
  writeFileSync(join(src, 'subsystems', 'Elevator.java'), `package frc.robot.subsystems;
import com.ctre.phoenix6.hardware.TalonFX;
import com.ctre.phoenix6.configs.TalonFXConfiguration;
import edu.wpi.first.wpilibj2.command.SubsystemBase;
import edu.wpi.first.wpilibj2.command.Command;
public class Elevator extends SubsystemBase {
  private final TalonFX leader = new TalonFX(Constants.kElevatorLeaderId);
  private final TalonFX follower = new TalonFX(5, "canivore");
  private final TalonFX other = new TalonFX(5);
  public Command toHeight(double meters) { return run(() -> leader.setVoltage(meters * 12.7 + 0.35)); }
  public void stop() { leader.stopMotor(); }
  @Override
  public void periodic() {
    var pid = new PIDController(3.1, 0, 0.07);
    leader.getConfigurator().apply(new TalonFXConfiguration());
    while (!atBottom()) { }
    System.out.println("height " + 4.5);
    double ff = 0.42 * 9.81 + 1.37;
  }
  boolean atBottom() { return true; } // "Thread.sleep(" in a comment is ignored
}
`)
  writeFileSync(join(src, 'commands', 'ManualElevator.java'), `package frc.robot.commands;
import edu.wpi.first.wpilibj2.command.Command;
import frc.robot.subsystems.Elevator;
public class ManualElevator extends Command {
  private final Elevator elevator;
  public ManualElevator(Elevator elevator) { this.elevator = elevator; }
  @Override public void execute() { try { Thread.sleep(5); } catch (Exception e) {} }
}
`)
  return root
}

describe('vendordep_check', () => {
  test('flags wrong season, outdated versions, duplicates and broken files', () => {
    const root = robotProject()
    const r = checkVendordeps(root)
    expect(r.gradleRio).toBe('2026.2.1')
    expect(r.projectYear).toBe('2026')
    const text = formatVendordeps(r, root).replace(/\s+/g, ' ')
    expect(text).toMatch(/REVLib\.json: frcYear 2025 does not match/)
    expect(text).toMatch(/Phoenix6-frc2026-latest\.json: 26\.1\.0 is older than 26\.3\.0/)
    expect(text).toMatch(/same uuid/)
    expect(text).toMatch(/broken\.json is not valid JSON/)
    expect(text).toMatch(/confirm the current version online/)
  })
  test('version helpers', () => {
    expect(gradleRioVersion('id "org.wpilib.GradleRIO" version "2027.0.0-alpha-8"')).toBe('2027.0.0-alpha-8')
    expect(compareVersions('2026.1.1-beta-2', '2026.1.1')).toBe(-1)
    expect(compareVersions('v2026.3.4', '2026.3.10')).toBe(-1)
    expect(compareVersions('26.3.0', '26.3.0')).toBe(0)
  })
})

describe('project_scan', () => {
  const root = robotProject()
  const s = scanProject(root)
  const rules = (r: string): string[] => s.findings.filter((f) => f.rule === r).map((f) => `${f.file.split('/').pop()}:${f.line}`)

  test('finds structure', () => {
    expect(s.team).toBe('9999')
    expect(s.robotClass).toBe('Robot')
    expect(s.subsystems.map((x) => x.name)).toEqual(['Elevator'])
    expect(s.subsystems[0].factories).toEqual(['toHeight'])
    expect(s.commands.map((c) => c.name)).toEqual(['ManualElevator'])
    expect(s.bindings[0].text).toMatch(/driver\.a\(\)\.onTrue/)
    expect(s.namedCommands).toEqual(['score'])
  })

  test('heuristic findings', () => {
    expect(rules('scheduler-not-run')).toHaveLength(1)
    expect(rules('default-command-ends')).toEqual(['RobotContainer.java:10'])
    expect(rules('duplicate-can-id')).toEqual(['Elevator.java:9'])
    expect(rules('new-in-loop')).toEqual(['Elevator.java:14', 'Elevator.java:15'])
    expect(rules('config-in-loop')).toEqual(['Elevator.java:15'])
    expect(rules('loop-in-periodic')).toEqual(['Elevator.java:16'])
    expect(rules('print-in-loop')).toEqual(['Elevator.java:17'])
    expect(rules('blocking-sleep')).toEqual(['ManualElevator.java:7'])
    expect(rules('missing-requirements')).toEqual(['ManualElevator.java:6'])
    expect(rules('magic-numbers')).toHaveLength(1)
    expect(rules('units')).toEqual(['Constants.java:1'])
    expect(s.findings.some((f) => f.rule === 'version-sensitive' && /CANBus object/.test(f.message))).toBe(true)
    expect(formatScan(s)).toMatch(/text-pattern heuristics/)
  })

  test('comment and string stripping keeps line numbers', () => {
    const code = 'a // Thread.sleep(1)\nb "x\\"y" /* q\nr */ c'
    const st = stripJava(code)
    expect(st.length).toBe(code.length)
    expect(st).not.toMatch(/sleep|q|r \*/)
    expect(st.split('\n')).toHaveLength(3)
    expect(methodBodies('void periodic() { if (x) { y(); } z(); } void other() {}', /periodic/)[0].body).toBe(' if (x) { y(); } z(); ')
  })
})

// ---------------------------------------------------------------- scouting (no network)

const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init })

describe('scouting', () => {
  beforeEach(() => clearScoutingCache())

  test('Statbotics team lookup is formatted and cached', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(String(url))
      if (String(url).endsWith('/team/254')) return json({ team: 254, name: 'The Cheesy Poofs', state: 'CA', country: 'USA', rookie_year: 1999, record: { wins: 900, losses: 200, ties: 5, winrate: 0.81 }, norm_epa: { current: 2100, recent: 2050, max: 2200 } })
      return json({ team: 254, year: 2026, epa: { total_points: { mean: 61.24, sd: 9 }, stats: { start: 40, pre_champs: 58, max: 63 }, ranks: { total: { rank: 2, team_count: 3700 } }, breakdown: { auto_points: 15, rp_1: 0.7 } }, record: { wins: 40, losses: 5, ties: 0 } })
    }) as unknown as typeof fetch
    const tool = frcCodeTool({ workspace: () => tmpdir(), tbaKey: () => undefined, fetchImpl: fake })
    const ctx = { state: { roots: [] }, signal: new AbortController().signal } as never
    const out = await tool.run({ action: 'scouting', query: 'team', team: 'frc254', year: 2026 }, ctx)
    expect(out.text).toMatch(/Team 254: The Cheesy Poofs/)
    expect(out.text).toMatch(/EPA 61\.2 points/)
    expect(out.text).toMatch(/world #2\/3700/)
    expect(out.text).not.toMatch(/rp_1/)
    await tool.run({ action: 'scouting', query: 'team', team: 254, year: 2026 }, ctx)
    expect(calls).toHaveLength(2)
  })

  test('Statbotics outage (500 with empty body) and missing TBA key give clear errors', async () => {
    const fake = (async () => json('{}', { status: 500 })) as unknown as typeof fetch
    await expect(getJson('https://api.statbotics.io/v3/team/1', { fetchImpl: fake })).rejects.toThrow(/unavailable right now \(500, empty body\)/)
    const tool = frcCodeTool({ workspace: () => tmpdir(), tbaKey: () => undefined, fetchImpl: fake })
    await expect(tool.run({ action: 'scouting', query: 'tba_rankings', event: '2026casj' }, { state: { roots: [] }, signal: new AbortController().signal } as never)).rejects.toThrow(/thebluealliance\.com\/account/)
  })

  test('TBA requests send the key and revalidate with ETag', async () => {
    const seen: Array<Record<string, string>> = []
    let n = 0
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      n++
      if (n === 1) return json([{ key: '2026casj_qm2', comp_level: 'qm', set_number: 1, match_number: 2, alliances: { red: { score: 80, team_keys: ['frc254', 'frc1', 'frc2'] }, blue: { score: 70, team_keys: ['frc3', 'frc4', 'frc5'] } }, winning_alliance: 'red', actual_time: 1774000000 }, { key: '2026casj_qm1', comp_level: 'qm', set_number: 1, match_number: 1, alliances: { red: { score: -1, team_keys: ['frc6'] }, blue: { score: -1, team_keys: ['frc7'] } }, winning_alliance: '' }], { headers: { etag: 'W/"abc"', 'cache-control': 'max-age=0' } })
      return new Response(null, { status: 304 })
    }) as unknown as typeof fetch
    const tool = frcCodeTool({ workspace: () => tmpdir(), tbaKey: () => 'k123', fetchImpl: fake })
    const ctx = { state: { roots: [] }, signal: new AbortController().signal } as never
    const a = await tool.run({ action: 'scouting', query: 'tba_matches', event: '2026CASJ' }, ctx)
    const b = await tool.run({ action: 'scouting', query: 'tba_matches', event: '2026casj' }, ctx)
    expect(seen[0]['X-TBA-Auth-Key']).toBe('k123')
    expect(seen[1]['if-none-match']).toBe('W/"abc"')
    expect(b.text).toBe(a.text)
    const lines = a.text.split('\n')
    expect(lines[3]).toMatch(/^\| qm1 \| 6 \| 7 \| – \| – \|/)
    expect(lines[4]).toMatch(/^\| qm2 \| 254 1 2 \| 3 4 5 \| 80-70 \| red \| 2026-03-20/)
  })

  test('formatters and validators', () => {
    expect(epaTotal({ total_points: 50 })).toBe(50)
    expect(epaTotal({ total_points: { mean: 40 } })).toBe(40)
    expect(teamNum('frc604')).toBe(604)
    expect(() => teamNum('abc')).toThrow(/team number/)
    expect(eventKey('2026CASJ')).toBe('2026casj')
    expect(() => eventKey('casj')).toThrow(/event key/)
    const ev = formatEvent({ key: '2026casj', name: 'Silicon Valley Regional', epa: { max: 70, top_8: 50, top_24: 40, mean: 30 } }, [{ team: 1, epa: { total_points: 10 }, record: { qual: { rank: 3 } } }, { team: 2, epa: { total_points: 60 }, record: { qual: { rank: 1 }, elim: { alliance: 1, is_captain: true, wins: 4, losses: 0, ties: 0 } } }])
    expect(ev.split('\n').find((l) => l.startsWith('| 1 |'))).toMatch(/\| 1 \| 2 .*\| 60\.0 \| 1 \|.*alliance 1 \(captain\)/)
    const m = formatSbMatches([{ key: 'x_qm1', match_name: 'Qual 1', alliances: { red: { team_keys: [1, 2, 3] }, blue: { team_keys: [4, 5, 6] } }, pred: { winner: 'red', red_win_prob: 0.72, red_score: 120, blue_score: 95 }, result: { winner: 'blue', red_score: 90, blue_score: 100 } }])
    expect(m).toMatch(/120-95 \(72%\) \| 90-100 blue/)
    expect(m).toMatch(/winner in 0 of 1/)
    expect(formatTbaRankings({ sort_order_info: [{ name: 'Ranking Score' }], rankings: [{ rank: 1, team_key: 'frc254', record: { wins: 10, losses: 0, ties: 0 }, matches_played: 10, sort_orders: [3.5] }] })).toMatch(/\| 1 \| 254 \| 10-0-0 \| 10 \| 3\.50 \|/)
    expect(formatTbaMatches([])).toMatch(/^\| Match/)
  })
})

// ---------------------------------------------------------------- the tool end to end

describe('frc_code tool', () => {
  test('summarizes a .wpilog in the workspace and refuses paths outside it', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    writeFileSync(join(ws, 'match.wpilog'), matchLog())
    writeFileSync(join(ws, 'notes.txt'), 'hello')
    const tool = frcCodeTool({ workspace: () => ws, tbaKey: () => undefined })
    const ctx = { state: { roots: [] }, signal: new AbortController().signal } as never
    const out = await tool.run({ action: 'wpilog_summary', path: 'match.wpilog' }, ctx)
    expect(out.text).toMatch(/# WPILib log summary: match\.wpilog/)
    expect(out.display).toMatch(/match\.wpilog/)
    const list = await tool.run({ action: 'wpilog_series', path: 'match.wpilog' }, ctx)
    expect(list.text).toMatch(/\/SystemStats\/BatteryVoltage \(double\)/)
    const ser = await tool.run({ action: 'wpilog_series', path: 'match.wpilog', entries: ['FullCycleMS'], max_points: 50 }, ctx)
    expect(JSON.parse(ser.text.slice(ser.text.indexOf('\n\n') + 2))[0].points).toHaveLength(50)
    await expect(tool.run({ action: 'wpilog_summary', path: 'notes.txt' }, ctx)).rejects.toThrow(/not a WPILib \.wpilog/)
    await expect(tool.run({ action: 'wpilog_summary', path: '/etc/hosts' }, ctx)).rejects.toThrow(/outside the workspace/)
    expect(tool.effect).toBe('read')
  })

  test('project actions work on an attached folder', async () => {
    const root = robotProject()
    const tool = frcCodeTool({ workspace: () => mkdtempSync(join(tmpdir(), 'ws-')), tbaKey: () => undefined })
    const ctx = { state: { roots: [root] }, signal: new AbortController().signal } as never
    expect((await tool.run({ action: 'project_scan', path: root }, ctx)).text).toMatch(/## Subsystems \(1\)/)
    expect((await tool.run({ action: 'vendordep_check', path: root }, ctx)).display).toMatch(/Vendordeps: \d+ libraries/)
  })
})
