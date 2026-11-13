import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

// Static helpers for FRC robot projects (WPILib GradleRIO, Java). Everything here is heuristic text
// scanning, not compilation: findings are hints for a human (or the model) to confirm in the code.

// ---------------------------------------------------------------- vendordeps

export interface Vendordep {
  file: string
  name: string
  fileName?: string
  version: string
  uuid?: string
  frcYear?: string
  jsonUrl?: string
  javaArtifacts: string[]
  error?: string
}

/**
 * Curated "latest known" vendor library versions. Versions move during the season, so this table is
 * only a hint: the model must check online (the jsonUrl, or the vendor's docs) before telling a team
 * to update. KNOWN_AS_OF says when it was last checked.
 */
export const KNOWN_AS_OF = '2026-11-13'
export interface KnownVendor { match: RegExp; vendor: string; latest: Record<string, string>; docs: string; note?: string }
export const KNOWN_VENDORS: KnownVendor[] = [
  { match: /WPILibNewCommands|wpilibj2/i, vendor: 'WPILib command-based', latest: { '2026': '1.0.0' }, docs: 'https://docs.wpilib.org/en/stable/docs/software/commandbased/index.html', note: 'Ships with WPILib; its version stays 1.0.0 and follows GradleRIO.' },
  { match: /Phoenix6|phoenix6|\(v6\)/i, vendor: 'CTRE Phoenix 6', latest: { '2026': '26.3.0' }, docs: 'https://v6.docs.ctr-electronics.com/en/stable/docs/yearly-changes/yearly-changelog.html' },
  { match: /Phoenix5|phoenix5|\(v5\)/i, vendor: 'CTRE Phoenix 5', latest: { '2026': '5.36.0' }, docs: 'https://v5.docs.ctr-electronics.com/', note: 'Phoenix 5 is legacy (Talon SRX / Victor SPX), deprecated and slated for removal for 2027; Talon FX, CANcoder and Pigeon 2 use Phoenix 6.' },
  { match: /REVLib|revrobotics/i, vendor: 'REVLib', latest: { '2026': '2026.0.5', '2027': '2027.0.0-alpha-9' }, docs: 'https://docs.revrobotics.com/revlib/changelog' },
  { match: /PathplannerLib|pathplanner/i, vendor: 'PathPlannerLib', latest: { '2026': '2026.1.2' }, docs: 'https://pathplanner.dev/pplib-getting-started.html' },
  { match: /ChoreoLib|choreo/i, vendor: 'ChoreoLib', latest: { '2026': '2026.0.3' }, docs: 'https://choreo.autos/choreolib/getting-started/', note: 'In Nov 2026 the hosted ChoreoLib2026.json briefly served a 2027 alpha build; for the 2026 season keep 2026.0.x.' },
  { match: /AdvantageKit|akit|littletonrobotics/i, vendor: 'AdvantageKit', latest: { '2026': '26.0.2' }, docs: 'https://docs.advantagekit.org/' },
  { match: /photonlib|PhotonVision/i, vendor: 'PhotonLib (PhotonVision)', latest: { '2026': 'v2026.3.4' }, docs: 'https://docs.photonvision.org/', note: 'PhotonLib must match the PhotonVision version running on the coprocessor.' },
  { match: /yagsl/i, vendor: 'YAGSL', latest: {}, docs: 'https://yagsl.yassrobotics.com/', note: 'YAGSL moved to yassrobotics.com; builds from 2026.8.05 on are a rewrite on YAMS with a changed JSON schema (2026 season used 2026.1.x–2026.4.x). Read its changelog before updating.' },
  { match: /ReduxLib|redux/i, vendor: 'ReduxLib', latest: {}, docs: 'https://docs.reduxrobotics.com/' },
  { match: /Studica|navx/i, vendor: 'Studica (navX)', latest: {}, docs: 'https://docs.studica.com/' },
  { match: /ThriftyLib|thrifty/i, vendor: 'ThriftyLib', latest: {}, docs: 'https://docs.thethriftybot.com/' },
  { match: /maple-?sim|MapleSim/i, vendor: 'maple-sim', latest: {}, docs: 'https://shenzhen-robotics-alliance.github.io/maple-sim/' }
]

export function readVendordeps(projectDir: string): Vendordep[] {
  const dir = join(projectDir, 'vendordeps')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort().map((f) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, any>
      return {
        file: f, name: String(j.name ?? f), fileName: j.fileName, version: String(j.version ?? '?'), uuid: j.uuid,
        frcYear: j.frcYear !== undefined ? String(j.frcYear) : undefined, jsonUrl: j.jsonUrl,
        javaArtifacts: Array.isArray(j.javaDependencies) ? j.javaDependencies.map((d: any) => `${d.groupId}:${d.artifactId}:${d.version}`) : []
      }
    } catch (e) {
      return { file: f, name: f, version: '?', javaArtifacts: [], error: `not valid JSON (${(e as Error).message.slice(0, 80)})` }
    }
  })
}

/** "2026.2.1" from build.gradle's GradleRIO plugin line. */
export function gradleRioVersion(buildGradle: string): string | undefined {
  return buildGradle.match(/(?:edu\.wpi\.first|org\.wpilib)\.GradleRIO["']?\s*\)?\s*version\s*["']([^"']+)["']/)?.[1]
}

/** Compares dotted versions with optional suffixes ("2026.1.1-beta-2" < "2026.1.1"). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = v.replace(/^v/i, '').split('-')
    return { nums: core.split('.').map((x) => parseInt(x, 10) || 0), pre: rest.join('-') }
  }
  const x = split(a), y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return Math.sign(d)
  }
  if (x.pre && !y.pre) return -1
  if (!x.pre && y.pre) return 1
  return x.pre.localeCompare(y.pre, 'en', { numeric: true })
}

export interface VendordepReport {
  projectYear?: string
  gradleRio?: string
  deps: Array<Vendordep & { vendor?: string; latestKnown?: string; status: string; docs?: string }>
  findings: string[]
}

export function checkVendordeps(projectDir: string): VendordepReport {
  const build = readIf(join(projectDir, 'build.gradle'))
  const gradleRio = build ? gradleRioVersion(build) : undefined
  const prefs = readJson(join(projectDir, '.wpilib', 'wpilib_preferences.json'))
  const projectYear = gradleRio?.split('.')[0] ?? (prefs?.projectYear ? String(prefs.projectYear).replace(/beta|alpha/i, '') : undefined)
  const deps = readVendordeps(projectDir)
  const findings: string[] = []
  if (!build) findings.push('No build.gradle here: is this the robot project root (the folder with build.gradle and vendordeps/)?')
  if (!deps.length) findings.push('No vendordeps/*.json files found.')
  const out: VendordepReport['deps'] = []
  const seenUuid = new Map<string, string>()
  const vendorFiles = new Map<string, string[]>()
  for (const d of deps) {
    if (d.error) { out.push({ ...d, status: `broken: ${d.error}` }); findings.push(`${d.file} is ${d.error}. Re-install it from the vendor's JSON URL.`); continue }
    const k = KNOWN_VENDORS.find((v) => v.match.test(`${d.file} ${d.name} ${d.fileName ?? ''} ${d.javaArtifacts.join(' ')}`))
    const latest = k && d.frcYear ? k.latest[d.frcYear] : undefined
    let status = 'ok'
    if (projectYear && d.frcYear && d.frcYear !== projectYear) {
      status = `wrong season: built for ${d.frcYear}, project is ${projectYear}`
      findings.push(`${d.file}: frcYear ${d.frcYear} does not match the project (GradleRIO ${gradleRio ?? projectYear}). Install the ${projectYear} version of ${d.name}; mixed seasons usually fail to build or crash at startup.`)
    } else if (latest && compareVersions(d.version, latest) < 0) {
      status = `older than ${latest} (latest known on ${KNOWN_AS_OF})`
      findings.push(`${d.file}: ${d.version} is older than ${latest} (latest we knew of on ${KNOWN_AS_OF}). Check the vendor's release notes, then update via WPILib: Manage Vendor Libraries → Check for updates.`)
    }
    if (/beta|alpha|rc/i.test(d.version) && !/beta|alpha/i.test(gradleRio ?? '')) findings.push(`${d.file}: ${d.version} is a pre-release. Fine for testing; use a release for competition.`)
    if (d.uuid) {
      const prev = seenUuid.get(d.uuid)
      if (prev) findings.push(`${d.file} and ${prev} have the same uuid: the same library is installed twice. Delete the older file.`)
      else seenUuid.set(d.uuid, d.file)
    }
    if (k) vendorFiles.set(k.vendor, [...(vendorFiles.get(k.vendor) ?? []), d.file])
    out.push({ ...d, vendor: k?.vendor, latestKnown: latest, status, docs: k?.docs })
    if (k?.note && /Phoenix 5|YAGSL|ChoreoLib/.test(k.vendor)) findings.push(`${d.file}: ${k.note}`)
  }
  for (const [v, files] of vendorFiles) if (files.length > 1 && v !== 'WPILib command-based') findings.push(`${v} appears in ${files.length} files (${files.join(', ')}). Keep one.`)
  const usesCommands = existsSync(join(projectDir, 'src')) && grepTree(join(projectDir, 'src'), /edu\.wpi\.first\.wpilibj2\.command/)
  if (usesCommands && !deps.some((d) => /WPILibNewCommands/i.test(d.file + d.name))) findings.push('The code imports edu.wpi.first.wpilibj2.command but vendordeps/WPILibNewCommands.json is missing: add the command-based library (WPILib: Manage Vendor Libraries → WPILib New Commands).')
  return { projectYear, gradleRio, deps: out, findings }
}

export function formatVendordeps(r: VendordepReport, dir: string): string {
  const lines = [`# Vendor libraries in ${dir}`, `GradleRIO ${r.gradleRio ?? '(not found)'} → season ${r.projectYear ?? '?'}`, '']
  for (const d of r.deps) lines.push(`- ${d.name} ${d.version}${d.frcYear ? ` (frcYear ${d.frcYear})` : ''} — ${d.file}${d.vendor ? ` [${d.vendor}]` : ''}: ${d.status}${d.jsonUrl ? `\n  update URL: ${d.jsonUrl}` : ''}`)
  lines.push('', '## Findings', ...(r.findings.length ? r.findings.map((f) => `- ${f}`) : ['- No mismatches found.']))
  lines.push('', `Latest-version hints come from a table last checked on ${KNOWN_AS_OF}. Before recommending an update, confirm the current version online (fetch the jsonUrl or the vendor docs). Vendor libraries must all target the same season as GradleRIO.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- project scan

export interface Finding { severity: 'error' | 'warn' | 'info'; file: string; line: number; rule: string; message: string }
export interface ProjectScan {
  root: string
  gradleRio?: string
  team?: string
  language?: string
  javaFiles: number
  robotClass?: string
  advantageKit: boolean
  epilogue: boolean
  subsystems: Array<{ name: string; file: string; motors: string[]; hasPeriodic: boolean; factories: string[] }>
  commands: Array<{ name: string; file: string; style: 'class' | 'group' }>
  ioLayers: string[]
  bindings: Array<{ file: string; line: number; text: string }>
  defaultCommands: Array<{ file: string; line: number; text: string }>
  namedCommands: string[]
  autos: string[]
  constants: Array<{ file: string; fields: number }>
  canIds: Array<{ device: string; id: string; file: string; line: number }>
  findings: Finding[]
  truncated: boolean
}

const SKIP_DIRS = new Set(['build', 'bin', '.gradle', '.git', 'node_modules', 'out', '.vscode', '.idea'])
const HW = /\bnew\s+(TalonFX|TalonFXS|TalonSRX|VictorSPX|SparkMax|SparkFlex|CANSparkMax|CANSparkFlex|CANcoder|CANCoder|Pigeon2|AHRS|DigitalInput|Encoder|DutyCycleEncoder|AnalogInput|Solenoid|DoubleSolenoid|Compressor|PowerDistribution|PhotonCamera|XboxController|CommandXboxController|PS4Controller|CommandPS4Controller|PS5Controller|CommandPS5Controller|Joystick|CommandJoystick|PIDController|ProfiledPIDController|TalonFXConfiguration|SparkMaxConfig|SparkFlexConfig|SwerveDrivePoseEstimator|SendableChooser)\s*\(/

function walkJava(dir: string, out: string[], max: number): boolean {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return false }
  for (const n of entries) {
    if (out.length >= max) return true
    if (n.startsWith('.') || SKIP_DIRS.has(n)) continue
    const p = join(dir, n)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { if (walkJava(p, out, max)) return true }
    else if (n.endsWith('.java') && st.size < 1_000_000) out.push(p)
  }
  return false
}

/** Body of every method named `name` (brace-matched; strings and comments stripped first). */
export function methodBodies(code: string, names: RegExp): Array<{ name: string; start: number; body: string }> {
  const out: Array<{ name: string; start: number; body: string }> = []
  const re = new RegExp(`\\b(?:void|boolean|Command)\\s+(${names.source})\\s*\\([^)]*\\)\\s*(?:throws [\\w., ]+)?\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    let depth = 1
    let i = m.index + m[0].length
    const s = i
    while (i < code.length && depth > 0) { const c = code[i++]; if (c === '{') depth++; else if (c === '}') depth-- }
    out.push({ name: m[1], start: s, body: code.slice(s, i - 1) })
  }
  return out
}

/** Replaces comments and string contents with spaces, keeping offsets (so line numbers stay right). */
export function stripJava(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const c = code[i], d = code[i + 1]
    if (c === '/' && d === '/') { while (i < code.length && code[i] !== '\n') { out += ' '; i++ } continue }
    if (c === '/' && d === '*') { while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++ } out += '  '; i += 2; continue }
    if (c === '"' && code.startsWith('"""', i)) {
      out += '"""'; i += 3
      while (i < code.length && !code.startsWith('"""', i)) { out += code[i] === '\n' ? '\n' : ' '; i++ }
      out += '"""'; i += 3; continue
    }
    if (c === '"' || c === "'") {
      const q = c; out += q; i++
      while (i < code.length && code[i] !== q && code[i] !== '\n') { if (code[i] === '\\') { out += ' '; i++ } out += ' '; i++ }
      out += q; i++; continue
    }
    out += c; i++
  }
  return out
}

const lineAt = (code: string, idx: number): number => code.slice(0, idx).split('\n').length

export function scanProject(root: string, maxFiles = 1500): ProjectScan {
  const build = readIf(join(root, 'build.gradle')) ?? ''
  const prefs = readJson(join(root, '.wpilib', 'wpilib_preferences.json'))
  const files: string[] = []
  const srcRoot = existsSync(join(root, 'src', 'main', 'java')) ? join(root, 'src', 'main', 'java') : existsSync(join(root, 'src')) ? join(root, 'src') : root
  const truncated = walkJava(srcRoot, files, maxFiles)
  const scan: ProjectScan = {
    root, gradleRio: gradleRioVersion(build), team: prefs?.teamNumber !== undefined ? String(prefs.teamNumber) : undefined, language: prefs?.currentLanguage,
    javaFiles: files.length, advantageKit: /littletonrobotics|akit/i.test(build) || existsSync(join(root, 'vendordeps', 'AdvantageKit.json')), epilogue: false,
    subsystems: [], commands: [], ioLayers: [], bindings: [], defaultCommands: [], namedCommands: [], autos: [], constants: [], canIds: [], findings: [], truncated
  }
  const add = (severity: Finding['severity'], file: string, line: number, rule: string, message: string): void => {
    if (scan.findings.length < 300) scan.findings.push({ severity, file, line, rule, message })
  }
  const constInts = new Map<string, string>()
  const sources = files.map((f) => {
    const raw = readFileSync(f, 'utf8')
    return { f, rel: relative(root, f), raw, code: stripJava(raw) }
  })
  // Integer constants, so CAN IDs given as Constants.X resolve.
  for (const s of sources) for (const m of s.code.matchAll(/static\s+final\s+int\s+(\w+)\s*=\s*(\d+)\s*;/g)) constInts.set(m[1], m[2])
  const subsystemNames = new Set<string>()
  for (const s of sources) for (const m of s.code.matchAll(/class\s+(\w+)\s+extends\s+SubsystemBase\b|class\s+(\w+)[^{]*implements[^{]*\bSubsystem\b/g)) subsystemNames.add(m[1] ?? m[2])

  let sawScheduler = false
  let robotJava: string | undefined
  const seenIds = new Map<string, { file: string; line: number }>()

  for (const { rel, raw, code } of sources) {
    const name = basename(rel, '.java')
    if (/@Logged\b/.test(code)) scan.epilogue = true
    if (/CommandScheduler\.getInstance\(\)\s*\.run\(\)/.test(code)) sawScheduler = true
    if (/class\s+\w+\s+extends\s+(TimedRobot|LoggedRobot|TimesliceRobot|IterativeRobotBase)\b/.test(code)) { scan.robotClass = name; robotJava = rel }

    // Structure
    const sub = subsystemNames.has(name) && new RegExp(`class\\s+${name}\\b`).test(code)
    if (sub) {
      const motors = [...code.matchAll(/new\s+(TalonFX|TalonFXS|SparkMax|SparkFlex|CANSparkMax|TalonSRX|VictorSPX)\s*\(/g)].map((m) => m[1])
      const factories = [...code.matchAll(/public\s+Command\s+(\w+)\s*\(/g)].map((m) => m[1])
      scan.subsystems.push({ name, file: rel, motors, hasPeriodic: /void\s+periodic\s*\(\)/.test(code), factories })
    }
    const cmd = code.match(/class\s+(\w+)\s+extends\s+(Command|CommandBase|SequentialCommandGroup|ParallelCommandGroup|ParallelRaceGroup|ParallelDeadlineGroup)\b/)
    if (cmd) scan.commands.push({ name: cmd[1], file: rel, style: /Group$/.test(cmd[2]) ? 'group' : 'class' })
    for (const m of code.matchAll(/interface\s+(\w+IO)\b/g)) scan.ioLayers.push(m[1])
    if (/^\s*public\s+(?:final\s+)?class\s+\w*Constants\b/m.test(code)) scan.constants.push({ file: rel, fields: (code.match(/static\s+final\s+/g) ?? []).length })
    for (const m of raw.matchAll(/NamedCommands\.registerCommand\(\s*"([^"]+)"/g)) scan.namedCommands.push(m[1])
    for (const m of raw.matchAll(/new\s+PathPlannerAuto\(\s*"([^"]+)"|\.trajectory\(\s*"([^"]+)"/g)) scan.autos.push(m[1] ?? m[2])

    const lines = code.split('\n')
    const rawLines = raw.split('\n')
    lines.forEach((l, i) => {
      if (/\.(onTrue|onFalse|whileTrue|whileFalse|toggleOnTrue|toggleOnFalse)\s*\(/.test(l) && scan.bindings.length < 80) scan.bindings.push({ file: rel, line: i + 1, text: rawLines[i].trim().slice(0, 160) })
      if (/setDefaultCommand\s*\(/.test(l)) {
        scan.defaultCommands.push({ file: rel, line: i + 1, text: rawLines[i].trim().slice(0, 160) })
        if (/setDefaultCommand\s*\([^;]*\b(runOnce|Commands\.runOnce|InstantCommand)\b/.test(rawLines.slice(i, i + 3).join(' '))) add('warn', rel, i + 1, 'default-command-ends', 'Default command built with runOnce/InstantCommand ends right away, so the scheduler restarts it every loop. Use run(...) for a continuous default.')
      }
      const dev = l.match(/new\s+(TalonFX|TalonFXS|SparkMax|SparkFlex|CANSparkMax|CANSparkFlex|CANcoder|Pigeon2|TalonSRX|VictorSPX)\s*\(\s*([\w.]+)/)
      if (dev) {
        const idTok = dev[2].split('.').pop()!
        const id = /^\d+$/.test(idTok) ? idTok : constInts.get(idTok)
        const bus = rawLines[i].match(/,\s*"([^"]+)"/)?.[1] ?? (/,\s*\w*(canivore|CANIVORE|kCanBus|CANBus)\w*/.test(rawLines[i]) ? 'canivore?' : 'rio')
        if (id) {
          const family = /Spark/.test(dev[1]) ? 'REV Spark' : dev[1]
          scan.canIds.push({ device: dev[1], id, file: rel, line: i + 1 })
          const key = `${family}|${bus}|${id}`
          const prev = seenIds.get(key)
          if (prev && !(prev.file === rel && prev.line === i + 1)) add('error', rel, i + 1, 'duplicate-can-id', `${dev[1]} CAN ID ${id} is also used at ${prev.file}:${prev.line} (same device type on the same bus). Each device of a type needs its own ID.`)
          else seenIds.set(key, { file: rel, line: i + 1 })
        }
      }
      if (/\bThread\.sleep\s*\(/.test(l)) add('error', rel, i + 1, 'blocking-sleep', 'Thread.sleep in robot code blocks the main loop (watchdog overruns, robot stops responding). Use a command (Commands.waitSeconds / withTimeout) or a Timer check instead.')
      if (/\bTimer\.delay\s*\(/.test(l)) add('error', rel, i + 1, 'blocking-delay', 'Timer.delay blocks the main loop. Use Commands.waitSeconds or a Timer-based condition.')
      if (/\bCommandBase\b/.test(l) && /extends|import/.test(l)) add('warn', rel, i + 1, 'deprecated-api', 'CommandBase was deprecated in 2024 and removed in 2025; extend Command instead.')
      if (/\b(PIDCommand|ProfiledPIDCommand|PIDSubsystem|ProfiledPIDSubsystem|TrapezoidProfileCommand|TrapezoidProfileSubsystem)\b/.test(l) && /extends|new|import/.test(l)) add('warn', rel, i + 1, 'deprecated-api', 'The PID/TrapezoidProfile command and subsystem wrappers are deprecated (2025); put the controller inside the subsystem and expose command factories.')
      if (/\bCANSparkMax\b|\bCANSparkFlex\b/.test(l) && /import|new/.test(l)) add('warn', rel, i + 1, 'old-revlib', 'CANSparkMax/CANSparkFlex are the pre-2025 REVLib names (now SparkMax/SparkFlex with SparkMaxConfig). Check the REVLib version.')
      if (/com\.ctre\.phoenix\.(motorcontrol|sensors)/.test(l) && /TalonFX|CANCoder|Pigeon/.test(rawLines.slice(i, i + 1).join(''))) add('warn', rel, i + 1, 'phoenix5-device', 'Phoenix 5 API used for a Talon FX / CANcoder / Pigeon 2; current firmware for these is Phoenix 6 only.')
      if (/new\s+Follower\s*\([^)]*,\s*(true|false)\s*\)/.test(l)) add('warn', rel, i + 1, 'version-sensitive', 'Phoenix 6 2026: Follower takes (leaderId, MotorAlignmentValue.Aligned/Opposed), not a boolean.')
      if (/new\s+(TalonFX|TalonFXS|CANcoder|Pigeon2|CANdle|CANrange)\s*\([^)]*,\s*"[^"]*"\s*\)/.test(rawLines[i])) add('info', rel, i + 1, 'version-sensitive', 'Phoenix 6 2026 deprecates the String CAN bus constructor (removal planned for 2027); pass a CANBus object, e.g. new CANBus("canivore").')
      if (/\.setReference\s*\(/.test(l) && /revrobotics|SparkMax|SparkFlex|ClosedLoopController/.test(code)) add('info', rel, i + 1, 'version-sensitive', 'REVLib 2026 deprecates setReference(...) in favor of setSetpoint(...); 2027 removes it.')
      if (/\.getLatestResult\s*\(/.test(l)) add('warn', rel, i + 1, 'version-sensitive', 'PhotonCamera.getLatestResult() is deprecated; loop over getAllUnreadResults() so no frames are dropped or reused.')
      if (/new\s+PhotonPoseEstimator\s*\([^)]*PoseStrategy/.test(rawLines.slice(i, i + 3).join(' '))) add('info', rel, i + 1, 'version-sensitive', 'PhotonLib 2026 deprecates the PoseStrategy constructor and update(); use new PhotonPoseEstimator(layout, robotToCamera) with estimateCoprocMultiTagPose(result), falling back to estimateLowestAmbiguityPose(result).')
      if (/\.deadlineWith\s*\(/.test(l)) add('info', rel, i + 1, 'version-sensitive', 'deadlineWith(...) is deprecated (2025); use deadlineFor(...).')
      if (/\)\s*\.schedule\s*\(\s*\)|\b\w+Command\s*\.schedule\s*\(\s*\)/.test(l)) add('info', rel, i + 1, 'version-sensitive', 'Command.schedule() is deprecated in 2026; use CommandScheduler.getInstance().schedule(cmd), or bind it to a Trigger.')
      if (/\.setInverted\s*\(/.test(l)) add('info', rel, i + 1, 'version-sensitive', 'setInverted(...) on motor objects is deprecated or removed in recent Phoenix 6 / REVLib; set inversion in the motor configuration (MotorOutput.Inverted / config.inverted).')
      if (/\bnew\s+(XboxController|CommandXboxController|Joystick|CommandJoystick|PS4Controller|PS5Controller|CommandPS4Controller|CommandPS5Controller)\s*\(/.test(l) && sub) add('warn', rel, i + 1, 'controller-in-subsystem', 'Controller created inside a subsystem. Keep controllers in RobotContainer and pass values in through command factories (suppliers).')
    })

    // Per-loop methods: allocations, configuration calls, blocking loops, console spam.
    for (const b of methodBodies(code, /periodic|robotPeriodic|teleopPeriodic|autonomousPeriodic|disabledPeriodic|testPeriodic|simulationPeriodic|execute|isFinished/)) {
      const base = lineAt(code, b.start)
      const bl = b.body.split('\n')
      let allocs = 0
      bl.forEach((l, j) => {
        const ln = base + j
        const hw = l.match(HW)
        if (hw) add('error', rel, ln, 'new-in-loop', `new ${hw[1]}(...) inside ${b.name}() creates a new device/controller object every 20 ms loop. Create it once (field or constructor).`)
        else if (/\bnew\s+[A-Z]\w*\s*[(<]/.test(l)) allocs++
        if (/getConfigurator\(\)\s*\.apply\s*\(|\.configure\s*\(\s*\w+\s*,\s*\w*ResetMode/.test(l)) add('error', rel, ln, 'config-in-loop', `Applying motor configuration inside ${b.name}() is a slow blocking CAN call every loop. Configure once at startup.`)
        if (/\bwhile\s*\(/.test(l)) add('warn', rel, ln, 'loop-in-periodic', `while loop inside ${b.name}(): if it waits on a sensor or time it blocks the robot loop. Let the scheduler call you again next cycle instead.`)
        if (/System\.(out|err)\.print/.test(l)) add('warn', rel, ln, 'print-in-loop', `Printing inside ${b.name}() floods the console and costs loop time. Log with Logger/DataLog or SmartDashboard, or print on change.`)
      })
      if (allocs > 3) add('info', rel, base, 'alloc-in-loop', `${allocs} object allocations inside ${b.name}(). Small value objects (Rotation2d, ChassisSpeeds) are usually fine, but heavy allocation adds garbage-collector pauses on the roboRIO.`)
    }

    // Old-style command classes: requirements.
    if (cmd && !/Group$/.test(cmd[2])) {
      const ctor = code.match(new RegExp(`(?:public|protected|private)?\\s*${cmd[1]}\\s*\\(([^)]*)\\)\\s*\\{`))
      const usesSubsystem = ctor && ([...subsystemNames].some((s) => new RegExp(`\\b${s}\\b`).test(ctor[1])) || /Subsystem\b/.test(ctor[1]))
      if (usesSubsystem && !/addRequirements\s*\(/.test(code)) add('error', rel, lineAt(code, ctor!.index ?? 0), 'missing-requirements', `${cmd[1]} takes a subsystem but never calls addRequirements(...). Two commands can then drive the same mechanism at once and the default command won't be interrupted.`)
      if (!/boolean\s+isFinished\s*\(/.test(code) && !/\.until\(|withTimeout/.test(code)) add('info', rel, 1, 'never-finishes', `${cmd[1]} has no isFinished(); it runs until interrupted. Fine for default/held-button commands; in autos add .withTimeout() or .until().`)
    }

    // Magic numbers in subsystems (outside constant declarations).
    if (sub) {
      let n = 0
      const ex: string[] = []
      lines.forEach((l, i) => {
        if (/static\s+final|@|^\s*(import|package)\b/.test(l)) return
        const nums = (l.match(/(?<![\w.])-?\d+\.\d+|(?<![\w.])-?\d{2,}(?![\w.])/g) ?? []).filter((x) => !/^-?(0|1|0\.0|1\.0|0\.5|2|2\.0|100|1000|20|50|360|180|90)$/.test(x))
        if (nums.length && !/new\s+(TalonFX|SparkMax|SparkFlex|CANcoder|Pigeon2)\s*\(/.test(l)) { n += nums.length; if (ex.length < 3) ex.push(`line ${i + 1}: ${rawLines[i].trim().slice(0, 90)}`) }
      })
      if (n >= 3) add('info', rel, 1, 'magic-numbers', `${n} unnamed numbers in ${name}. Move gains, ratios, limits and setpoints to Constants with unit names (e.g. kElevatorMaxHeightMeters) or WPILib Units types. Examples: ${ex.join(' | ')}`)
    }

    // Constants without units.
    if (/Constants/.test(name)) {
      const unitless: string[] = []
      lines.forEach((l, i) => {
        const m = l.match(/static\s+final\s+double\s+(\w+)\s*=\s*([^;]+);/)
        if (!m) return
        if (/meter|mps|radian|rad(?![a-z])|deg|rotation|rot(?![a-z])|rps|rpm|inch|feet|ft(?![a-z])|sec|volt|amp|ms$|kg|lbs|ratio|gear|percent|pct|scale|factor|deadband|hz|celsius|watts?$|newton|joule/i.test(m[1]) || /^k\w*(P|I|D|S|V|A|G|FF|Kp|Ki|Kd)$/.test(m[1])) return
        if (/Units\.|\.in\(|\/\/|\/\*/.test(rawLines[i])) return
        unitless.push(m[1])
      })
      if (unitless.length >= 3) add('info', rel, 1, 'units', `${unitless.length} double constants have no unit in the name or a comment (${unitless.slice(0, 6).join(', ')}${unitless.length > 6 ? ', …' : ''}). Add units (kArmLengthMeters) or use the WPILib Units library (Meters.of(0.5)).`)
    }
  }

  if (scan.robotClass && !sawScheduler && (scan.commands.length || scan.subsystems.length)) add('error', robotJava ?? 'Robot.java', 1, 'scheduler-not-run', 'Command-based code, but CommandScheduler.getInstance().run() was not found (normally in Robot.robotPeriodic). Without it no commands or default commands run.')
  if (!scan.robotClass) add('info', '.', 0, 'no-robot-class', 'No class extending TimedRobot/LoggedRobot found. Is this the robot project root?')
  scan.namedCommands = [...new Set(scan.namedCommands)]
  scan.autos = [...new Set(scan.autos)]
  scan.ioLayers = [...new Set(scan.ioLayers)]
  return scan
}

export function formatScan(s: ProjectScan): string {
  const L: string[] = [`# Robot project scan: ${s.root}`]
  L.push(`GradleRIO ${s.gradleRio ?? '?'} · team ${s.team ?? '?'} · ${s.language ?? 'java'} · ${s.javaFiles} Java files${s.truncated ? ' (stopped at the file limit)' : ''} · robot class ${s.robotClass ?? 'not found'}${s.advantageKit ? ' · AdvantageKit' : ''}${s.epilogue ? ' · Epilogue @Logged' : ''}`)
  L.push('', `## Subsystems (${s.subsystems.length})`)
  for (const x of s.subsystems) L.push(`- ${x.name} (${x.file}): motors ${x.motors.join(', ') || 'none constructed here'}; command factories: ${x.factories.join(', ') || 'none'}${x.hasPeriodic ? '; has periodic()' : ''}`)
  L.push('', `## Command classes (${s.commands.length})`, ...s.commands.slice(0, 40).map((c) => `- ${c.name} (${c.file})${c.style === 'group' ? ' [group]' : ''}`))
  if (s.ioLayers.length) L.push('', `IO layers: ${s.ioLayers.join(', ')}`)
  L.push('', `## Bindings (${s.bindings.length})`, ...s.bindings.slice(0, 40).map((b) => `- ${b.file}:${b.line} ${b.text}`))
  L.push('', `## Default commands (${s.defaultCommands.length})`, ...s.defaultCommands.map((b) => `- ${b.file}:${b.line} ${b.text}`))
  if (s.namedCommands.length) L.push('', `Named commands (PathPlanner): ${s.namedCommands.join(', ')}`)
  if (s.autos.length) L.push(`Autos referenced: ${s.autos.join(', ')}`)
  if (s.constants.length) L.push('', `Constants: ${s.constants.map((c) => `${c.file} (${c.fields} fields)`).join(', ')}`)
  if (s.canIds.length) L.push('', `CAN devices: ${s.canIds.slice(0, 40).map((c) => `${c.device} #${c.id}`).join(', ')}`)
  const order = { error: 0, warn: 1, info: 2 }
  const f = [...s.findings].sort((a, b) => order[a.severity] - order[b.severity])
  L.push('', `## Heuristic findings (${f.filter((x) => x.severity === 'error').length} likely bugs, ${f.filter((x) => x.severity === 'warn').length} warnings, ${f.filter((x) => x.severity === 'info').length} notes)`)
  L.push(...(f.length ? f.slice(0, 80).map((x) => `- [${x.severity}] ${x.file}:${x.line} (${x.rule}) ${x.message}`) : ['- Nothing flagged.']))
  L.push('', 'These are text-pattern heuristics, not a compiler: open each file and confirm before changing anything. Build with ./gradlew build to catch real errors.')
  return L.join('\n')
}

// ---------------------------------------------------------------- helpers

function readIf(p: string): string | undefined {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : undefined } catch { return undefined }
}
function readJson(p: string): Record<string, any> | undefined {
  try { const t = readIf(p); return t ? JSON.parse(t) : undefined } catch { return undefined }
}
function grepTree(dir: string, re: RegExp): boolean {
  const files: string[] = []
  walkJava(dir, files, 800)
  return files.some((f) => { try { return re.test(readFileSync(f, 'utf8')) } catch { return false } })
}
