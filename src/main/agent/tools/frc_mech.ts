import type { ToolDef } from '../types'

// FRC mechanical design calculator: motor data, mechanism estimates (flywheel, arm, elevator, drivetrain),
// gear ratio search, belt/chain center distance, tube beam and shaft checks, and weight budgets.
// Pure math, no network. Everything is an engineering estimate from a simple DC motor model:
// say so, state the assumptions, and never print more digits than the inputs justify.

// ---------------------------------------------------------------- units

const LB = 0.45359237 // kg
const IN = 0.0254 // m
const LBF = 4.4482216 // N
const LBIN2 = LB * IN * IN // kg·m² per lb·in²
const G0 = 9.80665
const TAU = 2 * Math.PI

/** Rounds to `sig` significant figures for display (no false precision). */
export function sig(x: number, n = 3): string {
  if (!Number.isFinite(x)) return x > 0 ? '∞' : 'n/a'
  if (x === 0) return '0'
  const v = Number(x.toPrecision(n))
  return Math.abs(v) >= 1e6 || Math.abs(v) < 1e-4 ? v.toExponential(n - 1) : String(v)
}

type Units = 'imperial' | 'metric'
const len = (x: number | undefined, u: Units): number | undefined => (x === undefined ? undefined : u === 'metric' ? x : x * IN) // → m
const mass = (x: number | undefined, u: Units): number | undefined => (x === undefined ? undefined : u === 'metric' ? x : x * LB) // → kg
const force = (x: number | undefined, u: Units): number | undefined => (x === undefined ? undefined : u === 'metric' ? x : x * LBF) // → N
const moi = (x: number | undefined, u: Units): number | undefined => (x === undefined ? undefined : u === 'metric' ? x : x * LBIN2) // → kg·m²

const both = {
  len: (m: number): string => `${sig(m / IN)} in (${sig(m * 1000)} mm)`,
  mass: (kg: number): string => `${sig(kg / LB)} lb (${sig(kg)} kg)`,
  force: (n: number): string => `${sig(n / LBF)} lbf (${sig(n)} N)`,
  torque: (nm: number): string => `${sig(nm)} N·m (${sig((nm / LBF) / IN)} in·lbf)`,
  speed: (ms: number): string => `${sig(ms / 0.3048)} ft/s (${sig(ms)} m/s)`,
  moi: (j: number): string => `${sig(j / LBIN2)} lb·in² (${sig(j)} kg·m²)`
}

// ---------------------------------------------------------------- motors

export interface MotorSpec {
  id: string
  name: string
  freeRpm: number
  stallNm: number
  stallA: number
  freeA: number
  massLb: number
  controller: string
  notes: string
}

/** When the table was last checked against its sources. */
export const MOTOR_DATA_CHECKED = '2026-11-13'
export const MOTOR_SOURCES = [
  { title: 'ReCalc motor table (community calculator, 12 V model values)', url: 'https://www.reca.lc/motors' },
  { title: 'REV NEO Vortex docs', url: 'https://docs.revrobotics.com/brushless/neo/vortex' },
  { title: 'REV NEO 550 product page', url: 'https://www.revrobotics.com/rev-21-1651/' },
  { title: 'REV NEO V1.1 product page', url: 'https://www.revrobotics.com/rev-21-1650/' },
  { title: 'CTRE Minion product page', url: 'https://store.ctr-electronics.com/products/minion-brushless-motor' }
]

// Values: ReCalc's 12 V model table (what most teams cross-check against). Vendor-published figures that
// differ are in the notes. Masses are as listed there; vendor masses can be motor-only. Verify on vendor pages.
export const MOTORS: MotorSpec[] = [
  { id: 'kraken_x60', name: 'Kraken X60 (trapezoidal)', freeRpm: 6065, stallNm: 7.16, stallA: 374, freeA: 2.8, massLb: 1.2, controller: 'integrated Talon FX', notes: 'WCP/CTRE. FOC (Phoenix Pro) raises stall torque; see kraken_x60_foc.' },
  { id: 'kraken_x60_foc', name: 'Kraken X60 (FOC)', freeRpm: 5784, stallNm: 9.36, stallA: 476, freeA: 3.5, massLb: 1.2, controller: 'integrated Talon FX', notes: 'Needs a Phoenix Pro license for FOC commutation.' },
  { id: 'kraken_x44', name: 'Kraken X44 (trapezoidal)', freeRpm: 7757, stallNm: 4.11, stallA: 279, freeA: 3.2, massLb: 0.75, controller: 'integrated Talon FX', notes: 'Smaller Kraken for mechanisms.' },
  { id: 'kraken_x44_foc', name: 'Kraken X44 (FOC)', freeRpm: 7367, stallNm: 5.01, stallA: 329, freeA: 3.2, massLb: 0.75, controller: 'integrated Talon FX', notes: 'Phoenix Pro FOC.' },
  { id: 'falcon_500', name: 'Falcon 500 (trapezoidal)', freeRpm: 6380, stallNm: 4.69, stallA: 257, freeA: 1.5, massLb: 1.25, controller: 'integrated Talon FX', notes: 'Legacy motor; check availability and spare stock.' },
  { id: 'falcon_500_foc', name: 'Falcon 500 (FOC)', freeRpm: 6080, stallNm: 5.84, stallA: 304, freeA: 1.5, massLb: 1.25, controller: 'integrated Talon FX', notes: 'Phoenix Pro FOC.' },
  { id: 'neo_vortex', name: 'NEO Vortex', freeRpm: 6825, stallNm: 5.96, stallA: 391, freeA: 5.4, massLb: 1.29, controller: 'SPARK Flex (docked) or SPARK MAX + adapter', notes: 'REV publishes 6784 RPM, 3.6 N·m, 211 A, 3.6 A free, 0.99 lb (measured with its controller); ReCalc model values used here.' },
  { id: 'neo', name: 'NEO (V1.1)', freeRpm: 5906, stallNm: 4.2, stallA: 216, freeA: 1.8, massLb: 1.19, controller: 'SPARK MAX', notes: 'REV publishes 5676 RPM free; 2.6 N·m / 105 A measured (3.75 N·m / 150 A theoretical). V1.1 is discontinued, replaced by NEO 2.0.' },
  { id: 'neo_2', name: 'NEO 2.0', freeRpm: 5906, stallNm: 4.2, stallA: 216, freeA: 1.8, massLb: 1.11, controller: 'SPARK MAX', notes: 'ReCalc lists the same curve as the NEO.' },
  { id: 'neo_550', name: 'NEO 550', freeRpm: 11710, stallNm: 1.08, stallA: 111, freeA: 1.1, massLb: 0.56, controller: 'SPARK MAX', notes: 'REV publishes 11000 RPM, 0.97 N·m, 100 A, 0.313 lb (motor only). Small thermal mass: current-limit to about 20-30 A and avoid stalling.' },
  { id: 'minion', name: 'Minion', freeRpm: 7703, stallNm: 3.17, stallA: 212, freeA: 2.2, massLb: 0.95, controller: 'Talon FXS', notes: 'CTRE lists 3.1 N·m stall, 610 W peak, 0.65 lb.' },
  { id: 'thrifty_pulsar', name: 'Thrifty Pulsar', freeRpm: 7500, stallNm: 3.1, stallA: 189, freeA: 2.7, massLb: 0.86, controller: 'see The Thrifty Bot docs', notes: 'Values from ReCalc only; verify with The Thrifty Bot.' },
  { id: 'cim', name: 'CIM', freeRpm: 5330, stallNm: 2.41, stallA: 131, freeA: 2.7, massLb: 3.05, controller: 'brushed (Talon SRX, SPARK MAX brushed)', notes: 'Legacy brushed motor; heavy.' },
  { id: 'mini_cim', name: 'MiniCIM', freeRpm: 5840, stallNm: 1.41, stallA: 89, freeA: 3.0, massLb: 2.41, controller: 'brushed', notes: 'Legacy brushed motor.' },
  { id: '775pro', name: '775pro', freeRpm: 18730, stallNm: 0.71, stallA: 134, freeA: 0.7, massLb: 1.05, controller: 'brushed', notes: 'Legacy; burns out quickly when stalled.' },
  { id: 'bag', name: 'BAG', freeRpm: 13180, stallNm: 0.43, stallA: 53, freeA: 1.8, massLb: 0.96, controller: 'brushed', notes: 'Legacy brushed motor.' }
]

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const ALIASES: Record<string, string> = {
  kraken: 'kraken_x60', x60: 'kraken_x60', krakenx60: 'kraken_x60', krakenx60foc: 'kraken_x60_foc', x60foc: 'kraken_x60_foc',
  x44: 'kraken_x44', krakenx44: 'kraken_x44', krakenx44foc: 'kraken_x44_foc', falcon: 'falcon_500', falcon500: 'falcon_500', falcon500foc: 'falcon_500_foc',
  vortex: 'neo_vortex', neovortex: 'neo_vortex', neo: 'neo', neov11: 'neo', neo11: 'neo', neo20: 'neo_2', neo2: 'neo_2', neo550: 'neo_550', '550': 'neo_550',
  minion: 'minion', pulsar: 'thrifty_pulsar', thriftypulsar: 'thrifty_pulsar', cim: 'cim', minicim: 'mini_cim', '775pro': '775pro', '775': '775pro', bag: 'bag'
}
export function findMotor(name: string): MotorSpec | undefined {
  const k = norm(name)
  const id = ALIASES[k] ?? MOTORS.find((m) => norm(m.id) === k || norm(m.name) === k)?.id
  return MOTORS.find((m) => m.id === id)
}
const motorOrThrow = (name: string | undefined): MotorSpec => {
  const m = findMotor(name ?? '')
  if (!m) throw new Error(`Unknown motor "${name ?? ''}". Known: ${MOTORS.map((x) => x.id).join(', ')}.`)
  return m
}

/** Output-side model of n identical motors through a reduction G (motor turns per output turn). */
export interface Drive {
  motor: MotorSpec
  count: number
  ratio: number
  efficiency: number
  volts: number
  currentLimit?: number
}
const wFreeMotor = (m: MotorSpec): number => (m.freeRpm * TAU) / 60
/** Torque per motor (N·m) at motor speed wm (rad/s), clamped by the current limit (stator / motor current). */
export function motorTorque(d: Drive, wm: number): number {
  const m = d.motor
  const t = m.stallNm * (d.volts / 12) - (m.stallNm / wFreeMotor(m)) * wm
  const lim = limitTorque(d)
  return Math.max(-lim, Math.min(lim, t))
}
/** Max torque per motor allowed by the current limit (Infinity if none). */
export function limitTorque(d: Drive): number {
  const m = d.motor
  if (!d.currentLimit) return Infinity
  return Math.max(0, (m.stallNm * (d.currentLimit - m.freeA)) / (m.stallA - m.freeA))
}
export const outTorque = (d: Drive, wOut: number): number => d.count * d.ratio * d.efficiency * motorTorque(d, wOut * d.ratio)
/** Output free speed (rad/s) at the drive's voltage. */
export const outFree = (d: Drive): number => (wFreeMotor(d.motor) * (d.volts / 12)) / d.ratio
/** Output stall torque (N·m), with and without the current limit. */
export const outStall = (d: Drive, limited = true): number => d.count * d.ratio * d.efficiency * Math.min(d.motor.stallNm * (d.volts / 12), limited ? limitTorque(d) : Infinity)
/** Current per motor (A) to make torque tm (N·m) per motor. */
export const motorCurrent = (m: MotorSpec, tm: number): number => m.freeA + ((m.stallA - m.freeA) * Math.abs(tm)) / m.stallNm
/** Unlimited, nominal 12 V output torque per volt (for feedforward gains). */
const torquePerVolt = (d: Drive): number => (d.count * d.ratio * d.efficiency * d.motor.stallNm) / 12

/** Semi-implicit Euler integration until `done` (or tmax). */
function simulate(acc: (x: number, v: number) => number, x0: number, v0: number, done: (x: number, v: number) => boolean, tmax = 10, dt = 0.0005): { t: number; x: number; v: number; ok: boolean; vmax: number } {
  let x = x0
  let v = v0
  let t = 0
  let vmax = Math.abs(v0)
  while (t < tmax) {
    if (done(x, v)) return { t, x, v, ok: true, vmax }
    v += acc(x, v) * dt
    x += v * dt
    t += dt
    vmax = Math.max(vmax, Math.abs(v))
  }
  return { t, x, v, ok: done(x, v), vmax }
}

// ---------------------------------------------------------------- args

type Action = 'motor_data' | 'mechanism' | 'gear_ratio_search' | 'center_distance' | 'beam' | 'shaft_torque_check' | 'weight_budget'
type Kind = 'flywheel' | 'arm' | 'elevator' | 'drivetrain' | 'generic'
export interface FrcMechArgs {
  action: Action
  units?: Units
  // motors / mechanism
  motor?: string
  motor_count?: number
  gear_ratio?: number
  efficiency?: number
  current_limit?: number
  voltage?: number
  kind?: Kind
  // flywheel
  target_rpm?: number
  wheel_diameter?: number
  moi?: number
  flywheel_mass?: number
  flywheel_shape?: 'solid' | 'ring'
  piece_mass?: number
  exit_speed?: number
  // arm
  arm_mass?: number
  com_distance?: number
  start_deg?: number
  end_deg?: number
  // elevator
  load_mass?: number
  drum_diameter?: number
  sprocket_teeth?: number
  chain?: '25' | '35'
  pulley_teeth?: number
  rigging_ratio?: number
  travel?: number
  incline_deg?: number
  spring_assist?: number
  // drivetrain
  robot_mass?: number
  cof?: number
  distance?: number
  // gear search
  target_ratio?: number
  tolerance?: number
  max_stages?: number
  stage_types?: Array<'gear' | 'belt' | 'chain' | 'maxplanetary' | 'versaplanetary' | 'ultraplanetary'>
  max_results?: number
  // center distance
  drive?: 'htd5' | 'gt2_3mm' | 'chain25' | 'chain35'
  teeth_1?: number
  teeth_2?: number
  belt_teeth?: number
  links?: number
  target_center?: number
  extra_center?: number
  // beam
  section?: string
  orientation?: 'tall' | 'flat'
  outer_width?: number
  outer_height?: number
  wall?: number
  material?: string
  span?: number
  load?: number
  case?: 'simply_supported_center' | 'simply_supported_uniform' | 'cantilever_end' | 'cantilever_uniform' | 'fixed_fixed_center'
  self_weight?: boolean
  // shaft
  shape?: 'hex' | 'round'
  size?: number
  bore?: number
  torque?: number
  bending_moment?: number
  length?: number
  // weight
  items?: Array<{ name: string; mass: number; qty?: number; subsystem?: string; excluded?: boolean }>
  limit?: number
  margin?: number
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} is required (a number).`)
  return v
}
const pos = (v: unknown, what: string): number => {
  const n = num(v, what)
  if (n <= 0) throw new Error(`${what} must be greater than 0.`)
  return n
}

// ---------------------------------------------------------------- motor_data

export function motorData(a: FrcMechArgs): string {
  const one = a.motor ? motorOrThrow(a.motor) : undefined
  const rows = (one ? [one] : MOTORS).map((m) => {
    const R = 12 / m.stallA
    const kt = m.stallNm / m.stallA
    const kv = m.freeRpm / (12 - R * m.freeA)
    const peakW = (m.stallNm * wFreeMotor(m)) / 4
    return one
      ? [`# ${m.name}`, `Free speed ${m.freeRpm} RPM · stall torque ${m.stallNm} N·m (${sig(m.stallNm / LBF / IN)} in·lbf) · stall current ${m.stallA} A · free current ${m.freeA} A · mass ~${m.massLb} lb`,
          `Derived (12 V linear model): Kt ≈ ${sig(kt)} N·m/A · Kv ≈ ${sig(kv)} RPM/V · R ≈ ${sig(R * 1000)} mΩ · peak mechanical power ≈ ${sig(peakW)} W at half free speed`,
          `Controller: ${m.controller}. ${m.notes}`].join('\n')
      : `| ${m.id} | ${m.name} | ${m.freeRpm} | ${m.stallNm} | ${m.stallA} | ${m.freeA} | ${m.massLb} | ${sig(peakW)} |`
  })
  const head = one ? '' : '| id | motor | free RPM | stall N·m | stall A | free A | lb | peak W |\n|---|---|---|---|---|---|---|---|\n'
  return `${head}${rows.join('\n')}\n\nData: ReCalc 12 V model table, checked ${MOTOR_DATA_CHECKED}; vendor-measured numbers often differ (notes). Verify against the vendor page before final design. Real robots see 10-11 V under load, so free speeds are optimistic.\nSources: ${MOTOR_SOURCES.map((s) => s.url).join(' · ')}`
}

// ---------------------------------------------------------------- mechanism

function driveFrom(a: FrcMechArgs, defEff: number): Drive {
  const motor = motorOrThrow(a.motor)
  const count = a.motor_count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('motor_count must be a whole number from 1 to 12.')
  const ratio = pos(a.gear_ratio, 'gear_ratio (motor turns per output turn; below 1 means an upduction)')
  const efficiency = a.efficiency ?? defEff
  if (efficiency <= 0 || efficiency > 1) throw new Error('efficiency must be between 0 and 1 (e.g. 0.9).')
  const volts = a.voltage ?? 12
  if (a.current_limit !== undefined && a.current_limit <= motor.freeA) throw new Error(`current_limit must be above the free current (${motor.freeA} A).`)
  return { motor, count, ratio, efficiency, volts, currentLimit: a.current_limit }
}

const driveLine = (d: Drive): string => `${d.count}× ${d.motor.name}, ${sig(d.ratio, 4)}:1 ${d.ratio < 1 ? '(upduction)' : 'reduction'}, ${Math.round(d.efficiency * 100)}% efficiency, ${d.volts} V${d.currentLimit ? `, ${d.currentLimit} A current limit per motor` : ', no current limit'}`

export function mechanism(a: FrcMechArgs): string {
  const u: Units = a.units ?? 'imperial'
  const kind = a.kind ?? 'generic'
  const d = driveFrom(a, kind === 'drivetrain' ? 0.9 : 0.85)
  const lines: string[] = [`# ${kind[0].toUpperCase()}${kind.slice(1)} estimate`, `Drive: ${driveLine(d)}.`]
  const wf = outFree(d)
  const sUn = outStall(d, false)
  const sLim = outStall(d, true)
  lines.push(`Output free speed ${sig((wf * 60) / TAU)} RPM · stall torque ${both.torque(sUn)}${d.currentLimit ? ` · current-limited max torque ${both.torque(sLim)}` : ''}.`)
  const assumptions = ['linear DC motor model (torque falls linearly with speed)', `${d.volts} V at the motor (real batteries sag to ~10-11 V under load)`, 'efficiency applied to torque only']

  if (kind === 'flywheel') {
    const dia = len(pos(a.wheel_diameter, 'wheel_diameter'), u)!
    const r = dia / 2
    let J = moi(a.moi, u)
    if (J === undefined) {
      const m = mass(pos(a.flywheel_mass, 'moi or flywheel_mass'), u)!
      J = (a.flywheel_shape === 'ring' ? 1 : 0.5) * m * r * r
      assumptions.push(`inertia from ${a.flywheel_shape === 'ring' ? 'a thin ring (m·r²)' : 'a solid disc (½·m·r²)'} at the wheel radius`)
    }
    const target = pos(a.target_rpm, 'target_rpm (wheel RPM)')
    const wt = (target * TAU) / 60
    const freeRpm = (wf * 60) / TAU
    lines.push(`Inertia ${both.moi(J)}. Wheel free speed ${sig(freeRpm)} RPM; target ${target} RPM = ${sig((100 * target) / freeRpm, 2)}% of free.`)
    lines.push(`Surface speed at target: ${both.speed(wt * r)}. Rough exit speed: about half of surface speed for one wheel against a fixed hood, approaching surface speed for matched top/bottom wheels; measure it on a prototype.`)
    if (target >= freeRpm) lines.push('⚠ Target is at or above free speed: unreachable. Gear it faster (lower ratio) or use a faster motor.')
    else {
      if (target > 0.85 * freeRpm) lines.push('⚠ Target is above ~85% of free speed: slow spin-up, poor recovery and no headroom for battery sag. Aim for roughly 60-80%.')
      const s = simulate((_x, v) => outTorque(d, v) / J!, 0, 0, (_x, v) => v >= wt)
      lines.push(s.ok ? `Spin-up 0 → ${target} RPM: ~${sig(s.t, 2)} s.` : '⚠ Did not reach the target within 10 s.')
      lines.push(`Stored energy at target: ${sig(0.5 * J * wt * wt)} J.`)
      if (a.piece_mass !== undefined && a.exit_speed !== undefined) {
        const mp = mass(a.piece_mass, u)!
        const v = u === 'metric' ? a.exit_speed : a.exit_speed * 0.3048
        const e = 0.5 * mp * v * v
        const w2sq = wt * wt - (2 * e) / J
        if (w2sq <= 0) lines.push('⚠ One shot takes more energy than the flywheel stores: add inertia or a faster wheel.')
        else {
          const w2 = Math.sqrt(w2sq)
          const rec = simulate((_x, vv) => outTorque(d, vv) / J!, 0, w2, (_x, vv) => vv >= wt)
          lines.push(`Per shot (${both.mass(mp)} at ${both.speed(v)}, linear KE only, losses ignored): drops to ~${sig((w2 * 60) / TAU)} RPM (${sig((100 * (wt - w2)) / wt, 2)}% dip); recovery ~${sig(rec.t, 2)} s. Real dips are larger (spin, slip, compression).`)
        }
      }
      const tpv = torquePerVolt(d)
      lines.push(`Feedforward (wheel radians): kV ≈ ${sig(12 / ((wFreeMotor(d.motor)) / d.ratio))} V/(rad/s) = ${sig(12 / ((d.motor.freeRpm / d.ratio)))} V/RPM; kA ≈ ${sig(J / tpv)} V/(rad/s²). Tune kS and kV on the robot.`)
    }
  } else if (kind === 'arm') {
    const m = mass(pos(a.arm_mass, 'arm_mass'), u)!
    const rc = len(pos(a.com_distance, 'com_distance (pivot to center of mass)'), u)!
    let J = moi(a.moi, u)
    if (J === undefined) { J = m * rc * rc; assumptions.push('inertia as a point mass at the center of mass (m·r²); a real arm is somewhat higher') }
    const gT = m * G0 * rc
    const holdMotor = gT / (d.count * d.ratio * d.efficiency)
    const iHold = motorCurrent(d.motor, holdMotor)
    lines.push(`Gravity torque at horizontal: ${both.torque(gT)} = ${sig((100 * gT) / sLim, 2)}% of available output torque.`)
    lines.push(`Holding at horizontal: ~${sig(iHold, 2)} A per motor${d.currentLimit && iHold > d.currentLimit ? ' ⚠ above the current limit: it cannot hold' : ''}.`)
    if (gT > sLim) lines.push('⚠ Cannot lift at horizontal. More reduction, more motors, or counterbalance (gas spring / constant-force spring).')
    else if (gT > 0.5 * sLim) lines.push('⚠ Gravity uses over half the available torque: slow, hot and hard to control. Aim for under ~1/3, or counterbalance.')
    const free = (wf * 180) / Math.PI
    lines.push(`Output free speed ${sig(free)} °/s.`)
    const s0 = a.start_deg ?? 0
    const s1 = a.end_deg ?? 90
    if (s0 !== s1) {
      const dir = Math.sign(s1 - s0)
      const th1 = (s1 * Math.PI) / 180
      const s = simulate((th, w) => (dir * outTorque(d, dir * w) - gT * Math.cos(th)) / J!, (s0 * Math.PI) / 180, 0, (th) => dir * (th - th1) >= 0)
      lines.push(s.ok ? `Move ${s0}° → ${s1}° (0° = horizontal, 90° = straight up) at full output, no deceleration: ~${sig(s.t, 2)} s (lower bound; a profiled move takes longer).` : `⚠ Could not complete ${s0}° → ${s1}° within 10 s (stalls against gravity).`)
    }
    const tpv = torquePerVolt(d)
    lines.push(`Feedforward for programmers (WPILib ArmFeedforward, radians, 0 = horizontal): kG ≈ ${sig(gT / tpv)} V · kV ≈ ${sig(12 / (wFreeMotor(d.motor) / d.ratio))} V/(rad/s) · kA ≈ ${sig(J / tpv)} V/(rad/s²). Starting points from the model; characterize on the robot (SysId).`)
    lines.push('Backlash at the arm grows with every stage; keep stages ≤ 3 and put the largest reduction last (chain/belt or a big final gear).')
  } else if (kind === 'elevator') {
    const m = mass(pos(a.load_mass, 'load_mass (moving mass)'), u)!
    let dia = len(a.drum_diameter, u)
    if (dia === undefined && a.sprocket_teeth) { const p = (a.chain === '35' ? 0.375 : 0.25) * IN; dia = p / Math.sin(Math.PI / a.sprocket_teeth) }
    if (dia === undefined && a.pulley_teeth) dia = (a.pulley_teeth * 0.005) / Math.PI
    if (dia === undefined) throw new Error('Give drum_diameter (pitch diameter), or sprocket_teeth (+ chain "25"/"35"), or pulley_teeth (HTD 5 mm).')
    const r = dia / 2
    const rig = a.rigging_ratio ?? 1
    const inc = ((a.incline_deg ?? 90) * Math.PI) / 180
    const spring = force(a.spring_assist, u) ?? 0
    const wgt = m * G0 * Math.sin(inc)
    const net = wgt - spring
    const fPerV = torquePerVolt(d) / (r * rig)
    const vFree = wf * r * rig
    const fMax = sLim / (r * rig)
    lines.push(`Pitch diameter ${both.len(dia)}; carriage moves ${rig}× the chain/cable at the drum${rig !== 1 ? ' (cascade-style rigging)' : ''}.`)
    lines.push(`Carriage free speed ${both.speed(vFree)} · max lift force ${both.force(fMax)} vs load ${both.force(wgt)}${spring ? ` minus ${both.force(spring)} spring assist` : ''} (${sig((100 * net) / fMax, 2)}% of available).`)
    if (net > fMax) lines.push('⚠ Cannot lift the load. More reduction, more motors, a smaller drum, or a spring assist.')
    else if (net > 0.5 * fMax) lines.push('⚠ Load uses over half the available force: slow and hot. Aim for under ~1/3.')
    const holdM = (net * r * rig) / (d.count * d.ratio * d.efficiency)
    lines.push(`Holding current ~${sig(motorCurrent(d.motor, holdM), 2)} A per motor (brake mode does not hold an elevator by itself under load; use kG or a brake/ratchet).`)
    if (a.travel) {
      const h = len(a.travel, u)!
      const s = simulate((_x, v) => (outTorque(d, v / (r * rig)) / (r * rig) - net) / m, 0, 0, (x) => x >= h)
      lines.push(s.ok ? `Time to travel ${both.len(h)} at full output, no deceleration: ~${sig(s.t, 2)} s (lower bound).` : `⚠ Did not reach ${both.len(h)} within 10 s.`)
    }
    lines.push(`Feedforward (WPILib ElevatorFeedforward, meters): kG ≈ ${sig(net / fPerV)} V · kV ≈ ${sig(12 / (wFreeMotor(d.motor) / d.ratio * r * rig))} V/(m/s) · kA ≈ ${sig(m / fPerV)} V/(m/s²). Characterize on the robot.`)
    assumptions.push('load_mass is the effective moving mass (for cascades, lower stages move slower; count them at their speed fraction squared if you want precision)', 'friction in bearings and rigging ignored')
  } else if (kind === 'drivetrain') {
    const m = mass(pos(a.robot_mass, 'robot_mass (with bumpers and battery)'), u)!
    const dia = len(pos(a.wheel_diameter, 'wheel_diameter'), u)!
    const r = dia / 2
    const mu = a.cof ?? 1.1
    const vFree = wf * r
    const traction = mu * m * G0
    const motorF = sLim / r
    lines.push(`Theoretical free speed ${both.speed(vFree)}; expect roughly 80-90% of that on carpet. (${d.count} drive motors total.)`)
    lines.push(`Pushing force: motors ${both.force(motorF)} vs traction ${both.force(traction)} (μ = ${mu}) → ${motorF > traction ? 'traction-limited (wheels slip first: good, motors are not the bottleneck)' : 'motor/current-limited (you lose pushing matches before the wheels slip)'}.`)
    const tSlipMotor = (traction * r) / (d.count * d.ratio * d.efficiency)
    const iSlip = motorCurrent(d.motor, tSlipMotor)
    lines.push(`Current per motor at the traction limit: ~${sig(iSlip, 2)} A. A stator/motor current limit near that keeps full push without wheel spin${d.currentLimit ? ` (you set ${d.currentLimit} A)` : ''}.`)
    const a0 = Math.min(motorF, traction) / m
    lines.push(`Initial acceleration ~${sig(a0 / G0, 2)} g (${sig(a0 / 0.3048, 2)} ft/s²).`)
    const dist = len(a.distance, u) ?? 5
    const s = simulate((_x, v) => Math.min(outTorque(d, v / r) / r, traction) / m, 0, 0, (x) => x >= dist)
    const t90 = simulate((_x, v) => Math.min(outTorque(d, v / r) / r, traction) / m, 0, 0, (_x, v) => v >= 0.9 * vFree)
    lines.push(`Time to ${both.len(dist)}: ~${sig(s.t, 2)} s from rest (reaching ${both.speed(Math.abs(s.v))}). Time to 90% of free speed: ${t90.ok ? `~${sig(t90.t, 2)} s` : 'over 10 s'}.`)
    lines.push('Typical competitive swerve: ~14-18 ft/s theoretical. Faster gearing only helps if the field has long straight runs; check the acceleration and the time over your real cycle distance.')
    assumptions.push(`friction coefficient ${mu} (tread/carpet; measure yours)`, 'no rolling resistance, scrub or air drag', 'all motors share load equally')
  }
  if (kind === 'generic' && a.current_limit) {
    lines.push(`At the current limit each motor makes ${both.torque(limitTorque(d))}.`)
  }
  lines.push(`Assumptions: ${assumptions.join('; ')}. Treat results as ±10-20% estimates; prototype and measure. Cross-check with ReCalc (https://www.reca.lc).`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- gear ratio search

/** Common COTS tooth counts (20 DP gears, HTD 5 mm pulleys, #25 sprockets). Check vendor stock before ordering. */
export const COTS = {
  pinions: [8, 9, 10, 11, 12, 13, 14],
  gears: [12, 14, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 45, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 84],
  pulleys: [12, 15, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 40, 42, 44, 48, 54, 60],
  sprockets: [10, 12, 15, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 36, 40, 42, 44, 48, 54, 56, 60, 64, 66, 72],
  maxplanetary: [3, 4, 5, 9],
  versaplanetary: [3, 4, 5, 7, 9, 10],
  // REV UltraPlanetary actual ratios (nominal 3:1, 4:1, 5:1).
  ultraplanetary: [84 / 29, 76 / 21, 68 / 13]
}

interface Stage { type: string; label: string; ratio: number; teeth: number; pinion?: boolean }

function stageOptions(types: string[]): Stage[] {
  const out: Stage[] = []
  const add = (type: string, drivers: number[], driven: number[], pinion = false): void => {
    for (const a of drivers) for (const b of driven) {
      const ratio = b / a
      if (ratio < 0.25 || ratio > 7) continue
      out.push({ type, label: `${type} ${a}T → ${b}T${type === 'gear' ? ` (20 DP, center ${sig((a + b) / 40, 4)} in)` : ''}`, ratio, teeth: a + b, pinion })
    }
  }
  if (types.includes('gear')) { add('gear', COTS.pinions, COTS.gears, true); add('gear', COTS.gears, COTS.gears) }
  if (types.includes('belt')) add('belt', COTS.pulleys, COTS.pulleys)
  if (types.includes('chain')) add('chain', COTS.sprockets, COTS.sprockets)
  for (const p of ['maxplanetary', 'versaplanetary', 'ultraplanetary'] as const) {
    if (types.includes(p)) for (const r of COTS[p]) out.push({ type: p, label: `${p} ${sig(r, 4)}:1 stage`, ratio: r, teeth: 0 })
  }
  // One option per (type, ratio, pinion) — the smallest.
  const best = new Map<string, Stage>()
  for (const s of out) {
    const k = `${s.type}|${s.ratio.toFixed(6)}|${s.pinion ? 1 : 0}`
    const prev = best.get(k)
    if (!prev || s.teeth < prev.teeth) best.set(k, s)
  }
  return [...best.values()].sort((x, y) => x.ratio - y.ratio)
}

/** Small robustness penalties: tiny motor pinions, small loaded pulleys/sprockets, very large single stages. */
function stagePenalty(st: Stage[]): number {
  let p = 0
  for (const s of st) {
    const driver = Number(/ (\d+)T →/.exec(s.label)?.[1] ?? 99)
    if (s.type === 'gear' && driver < 10) p += 1
    if (s.type === 'belt' && driver < 16) p += 1
    if (s.type === 'chain' && driver < 12) p += 1
    if (s.ratio > 5) p += 0.5
  }
  return p
}

export interface RatioResult { stages: Stage[]; ratio: number; error: number }

export function searchRatios(target: number, opts: { tolerance?: number; maxStages?: number; types?: string[]; max?: number } = {}): RatioResult[] {
  const tol = opts.tolerance ?? 0.02
  const maxStages = Math.min(3, Math.max(1, opts.maxStages ?? 3))
  const all = stageOptions(opts.types?.length ? opts.types : ['gear', 'belt'])
  // A motor pinion only fits the first stage; planetary cartridges stack on the motor, before any other stage.
  const first = all
  const later = all.filter((s) => !s.pinion)
  const laterRatios = later.map((s) => s.ratio)
  const found: RatioResult[] = []
  const seen = new Set<string>()
  const planetary = (s: Stage): boolean => s.type.endsWith('planetary')
  const push = (st: Stage[]): void => {
    if (st.some((s, i) => i > 0 && (s.pinion || (planetary(s) && !planetary(st[i - 1]))))) return
    if (new Set(st.filter(planetary).map((s) => s.type)).size > 1) return
    if (st.length > 1 && st.some((s) => Math.abs(s.ratio - 1) < 1e-9)) return
    const ratio = st.reduce((p, s) => p * s.ratio, 1)
    const error = ratio / target - 1
    if (Math.abs(error) > tol) return
    // The same stages in another order are the same design choice.
    const key = st.map((s) => s.label).sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    found.push({ stages: st, ratio, error })
  }
  const nearest = (need: number, k: number): Stage[] => {
    let lo = 0
    let hi = laterRatios.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (laterRatios[mid] < need) lo = mid + 1; else hi = mid }
    const out: Stage[] = []
    for (let i = Math.max(0, lo - k); i < Math.min(later.length, lo + k); i++) out.push(later[i])
    return out
  }
  for (const s of first) push([s])
  if (maxStages >= 2) for (const s1 of first) for (const s2 of nearest(target / s1.ratio, 3)) push([s1, s2])
  const want = opts.max ?? 8
  if (maxStages >= 3 && found.filter((f) => Math.abs(f.error) < tol / 4).length < want) {
    for (const s1 of first) for (const s2 of later) {
      const need = target / (s1.ratio * s2.ratio)
      if (need < 0.25 || need > 7) continue
      for (const s3 of nearest(need, 2)) push([s1, s2, s3])
    }
  }
  // Rank: error (in 0.1% steps), then fewer stages, then robustness (no tiny pinions or pulleys), then size.
  const bucket = (r: RatioResult): number => Math.round(Math.abs(r.error) * 1000)
  const teeth = (r: RatioResult): number => r.stages.reduce((p, s) => p + s.teeth, 0)
  return found
    .sort((x, y) => bucket(x) - bucket(y) || x.stages.length - y.stages.length || stagePenalty(x.stages) - stagePenalty(y.stages) || teeth(x) - teeth(y))
    .slice(0, want)
}

function gearSearch(a: FrcMechArgs): string {
  const target = pos(a.target_ratio, 'target_ratio (motor turns per output turn)')
  const res = searchRatios(target, { tolerance: a.tolerance, maxStages: a.max_stages, types: a.stage_types, max: a.max_results })
  if (!res.length) return `No combination within ±${sig((a.tolerance ?? 0.02) * 100, 2)}% of ${target}:1 with ${a.max_stages ?? 3} stages of ${(a.stage_types ?? ['gear', 'belt']).join('/')}. Loosen tolerance, allow another stage type (chain, planetary), or another stage.`
  const errPct = (e: number): string => (Math.abs(e) < 1e-9 ? 'exact' : `${e >= 0 ? '+' : ''}${sig(e * 100, 2)}%`)
  const lines = res.map((r, i) => `${i + 1}. ${sig(r.ratio, 5)}:1 (${errPct(r.error)}) — ${r.stages.map((s, j) => `stage ${j + 1}: ${s.label}`).join(' · ')}`)
  return `Target ${target}:1 (reduction = motor turns per output turn). Best matches, fewest stages first when equal:\n${lines.join('\n')}\n\nTooth counts are common COTS sizes (20 DP gears incl. 8-14T motor pinions, HTD 5 mm pulleys, #25 sprockets, planetary cartridges); confirm the exact part exists for your shaft/bore before designing around it. Keep motor pinions ≥ 9-10T on high-torque stages, and belts ≥ ~16-18T on loaded pulleys to avoid skipping.`
}

// ---------------------------------------------------------------- center distance

const PITCH: Record<string, number> = { htd5: 5, gt2_3mm: 3, chain25: 6.35, chain35: 9.525 } // mm

/** Exact center distance (mm) for a belt of `n` teeth on pulleys z1, z2 (pitch circles, open belt). */
export function beltCenter(p: number, n: number, z1: number, z2: number): number {
  const d1 = (Math.min(z1, z2) * p) / Math.PI
  const d2 = (Math.max(z1, z2) * p) / Math.PI
  const L = n * p
  const f = (C: number): number => { const b = Math.asin((d2 - d1) / (2 * C)); return 2 * C * Math.cos(b) + (Math.PI * (d1 + d2)) / 2 + b * (d2 - d1) - L }
  let lo = (d2 - d1) / 2 + 1e-9
  let hi = L
  if (f(lo) > 0) return NaN
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) > 0) hi = mid; else lo = mid }
  return (lo + hi) / 2
}
/** Belt teeth (fractional) needed for center distance C (mm). */
export function beltLength(p: number, C: number, z1: number, z2: number): number {
  const d1 = (Math.min(z1, z2) * p) / Math.PI
  const d2 = (Math.max(z1, z2) * p) / Math.PI
  const b = Math.asin(Math.min(1, (d2 - d1) / (2 * C)))
  return (2 * C * Math.cos(b) + (Math.PI * (d1 + d2)) / 2 + b * (d2 - d1)) / p
}
/** Chain center distance (mm) for `links` links (standard ANSI approximation). */
export function chainCenter(p: number, links: number, z1: number, z2: number): number {
  const s = links - (z1 + z2) / 2
  const k = (z2 - z1) / (2 * Math.PI)
  const disc = s * s - 8 * k * k
  return disc < 0 ? NaN : (p / 4) * (s + Math.sqrt(disc))
}
export function chainLinks(p: number, C: number, z1: number, z2: number): number {
  const c = C / p
  return 2 * c + (z1 + z2) / 2 + ((z2 - z1) ** 2) / (4 * Math.PI * Math.PI * c)
}

export function centerDistance(a: FrcMechArgs): string {
  const u: Units = a.units ?? 'imperial'
  const kind = a.drive ?? 'htd5'
  const p = PITCH[kind]
  if (!p) throw new Error('drive must be htd5, gt2_3mm, chain25 or chain35.')
  const z1 = pos(a.teeth_1, 'teeth_1')
  const z2 = pos(a.teeth_2, 'teeth_2')
  const chain = kind.startsWith('chain')
  const pd = (z: number): number => (chain ? p / Math.sin(Math.PI / z) : (z * p) / Math.PI)
  const extra = (len(a.extra_center, u) ?? 0) * 1000 // mm
  const center = (n: number): number => (chain ? chainCenter(p, n, z1, z2) : beltCenter(p, n, z1, z2))
  const wrap = (C: number): string => {
    const small = Math.min(z1, z2)
    const ang = Math.PI - 2 * Math.asin((pd(Math.max(z1, z2)) - pd(small)) / (2 * C))
    const engaged = (small * ang) / TAU
    return `wrap on the ${small}T: ${sig((ang * 180) / Math.PI)}° (~${sig(engaged, 2)} teeth engaged${!chain && engaged < 6 ? ' ⚠ under ~6: risk of skipping, add an idler or bigger pulley' : ''})`
  }
  const mmIn = (mm: number): string => `${sig(mm / 25.4, 4)} in (${sig(mm, 4)} mm)`
  const name = { htd5: 'HTD 5 mm belt', gt2_3mm: 'GT2 3 mm belt', chain25: '#25 chain', chain35: '#35 chain' }[kind]
  const head = `${name}: ${z1}T and ${z2}T (pitch diameters ${mmIn(pd(z1))} and ${mmIn(pd(z2))}; ratio ${sig(z2 / z1, 4)}:1).`
  const lines = [head]
  if (a.belt_teeth || a.links) {
    const n = (chain ? a.links : a.belt_teeth) ?? a.belt_teeth ?? a.links!
    const C = center(n)
    if (!Number.isFinite(C)) throw new Error(`${n} ${chain ? 'links' : 'teeth'} is too short for these ${chain ? 'sprockets' : 'pulleys'}.`)
    lines.push(`${n} ${chain ? 'links' : 'tooth belt'} → center distance ${mmIn(C)}${extra ? `; with +${mmIn(extra)} extra: ${mmIn(C + extra)}` : ''}. ${wrap(C)}.`)
    if (chain && n % 2) lines.push('⚠ Odd link count needs a half (offset) link, which is weaker. Prefer an even count.')
  } else {
    const target = len(pos(a.target_center, 'belt_teeth / links, or target_center'), u)! * 1000
    const exact = chain ? chainLinks(p, target, z1, z2) : beltLength(p, target, z1, z2)
    const step = chain ? 2 : 5
    const lower = Math.floor(exact / step) * step
    const upper = Math.ceil(exact / step) * step
    lines.push(`Target center ${mmIn(target)} needs ${sig(exact, 4)} ${chain ? 'links' : 'teeth'}.`)
    for (const n of [...new Set([lower, upper])].filter((x) => x > 0)) {
      const C = center(n)
      if (!Number.isFinite(C)) continue
      lines.push(`- ${n} ${chain ? 'links' : 'T belt'}: center ${mmIn(C)} (${C - target >= 0 ? '+' : ''}${sig((C - target) / 25.4, 2)} in from target). ${wrap(C)}.`)
    }
    lines.push(chain ? 'Assumes even link counts. Plan a tensioner or slotted/eccentric mount: chain stretches.' : 'Assumes stock in 5-tooth steps (common for FRC belts; check your vendor, some sizes exist in between). Use the exact center (plus a few thousandths for HTD if your team does) or add a tensioner.')
  }
  lines.push(chain ? 'Chain math: ANSI pitch-polygon approximation (Machinery\'s Handbook style).' : 'Belt math: exact pitch-circle geometry for an open two-pulley drive.')
  lines.push('In Onshape, FRCDesign\'s Belt & Chain Gen / #BeltCTC_5mm and #ChainCTC_25 functions keep this parametric (https://frcdesign.org/learning-course/stage1/1b/belts/).')
  return lines.join('\n')
}

// ---------------------------------------------------------------- beam and shaft

export const MATERIALS: Record<string, { name: string; yieldMPa: number; eGPa: number; density: number }> = {
  '6061-t6': { name: '6061-T6 aluminum', yieldMPa: 276, eGPa: 68.9, density: 2700 },
  '7075-t6': { name: '7075-T6 aluminum', yieldMPa: 503, eGPa: 71.7, density: 2810 },
  steel: { name: 'alloy steel (4140/4130 class, untreated; verify your grade)', yieldMPa: 415, eGPa: 200, density: 7850 },
  polycarbonate: { name: 'polycarbonate', yieldMPa: 62, eGPa: 2.4, density: 1200 }
}
const materialOf = (s: string | undefined, def: string): { name: string; yieldMPa: number; eGPa: number; density: number } => {
  const k = (s ?? def).toLowerCase().replace(/\s|aluminum|aluminium/g, '')
  const m = MATERIALS[k] ?? MATERIALS[k + '-t6'] ?? (k.includes('steel') ? MATERIALS.steel : k.includes('poly') || k.includes('lexan') ? MATERIALS.polycarbonate : undefined)
  if (!m) throw new Error(`Unknown material "${s}". Known: ${Object.keys(MATERIALS).join(', ')}.`)
  return m
}

/** Standard FRC box tube sections (width × height × wall, inches). */
export const SECTIONS: Record<string, [number, number, number]> = {
  '2x1x1/16': [1, 2, 0.0625], '2x1x1/8': [1, 2, 0.125], '1x1x1/16': [1, 1, 0.0625], '1x1x1/8': [1, 1, 0.125],
  '2x2x1/8': [2, 2, 0.125], '1.5x1.5x1/16': [1.5, 1.5, 0.0625], '2x1x0.0625': [1, 2, 0.0625], '2x1x0.125': [1, 2, 0.125],
  '1x1x0.0625': [1, 1, 0.0625], '1x1x0.125': [1, 1, 0.125]
}

/** Box-tube section properties (SI) ignoring corner radii. h is the dimension in the bending direction. */
export function boxSection(b: number, h: number, t: number): { I: number; S: number; A: number } {
  const I = (b * h ** 3 - (b - 2 * t) * (h - 2 * t) ** 3) / 12
  return { I, S: I / (h / 2), A: b * h - (b - 2 * t) * (h - 2 * t) }
}

/** Max moment (N·m) and deflection (m) for standard cases. P point load (N), w uniform (N/m). */
export function beamCase(c: NonNullable<FrcMechArgs['case']>, L: number, P: number, w: number, E: number, I: number): { M: number; defl: number } {
  switch (c) {
    case 'simply_supported_center': return { M: (P * L) / 4 + (w * L * L) / 8, defl: (P * L ** 3) / (48 * E * I) + (5 * w * L ** 4) / (384 * E * I) }
    case 'simply_supported_uniform': { const wt = w + P / L; return { M: (wt * L * L) / 8, defl: (5 * wt * L ** 4) / (384 * E * I) } }
    case 'cantilever_end': return { M: P * L + (w * L * L) / 2, defl: (P * L ** 3) / (3 * E * I) + (w * L ** 4) / (8 * E * I) }
    case 'cantilever_uniform': { const wt = w + P / L; return { M: (wt * L * L) / 2, defl: (wt * L ** 4) / (8 * E * I) } }
    case 'fixed_fixed_center': return { M: (P * L) / 8 + (w * L * L) / 12, defl: (P * L ** 3) / (192 * E * I) + (w * L ** 4) / (384 * E * I) }
  }
}

export function beam(a: FrcMechArgs): string {
  const u: Units = a.units ?? 'imperial'
  const mat = materialOf(a.material, '6061-t6')
  let b: number
  let h: number
  let t: number
  let label: string
  if (a.outer_width && a.outer_height && a.wall) {
    b = len(a.outer_width, u)!; h = len(a.outer_height, u)!; t = len(a.wall, u)!
    label = `${sig(a.outer_width)}×${sig(a.outer_height)}×${sig(a.wall)} ${u === 'metric' ? 'm' : 'in'} tube`
  } else {
    const key = (a.section ?? '2x1x1/16').replace(/\s|"/g, '').toLowerCase()
    const s = SECTIONS[key]
    if (!s) throw new Error(`Unknown section "${a.section}". Use one of ${Object.keys(SECTIONS).slice(0, 6).join(', ')} or give outer_width, outer_height and wall.`)
    const [w0, h0, t0] = s
    const flat = a.orientation === 'flat'
    b = (flat ? h0 : w0) * IN; h = (flat ? w0 : h0) * IN; t = t0 * IN
    label = `${key} tube${w0 !== h0 ? `, ${flat ? 'flat (1" tall in bending)' : 'tall (2" in the bending direction)'}` : ''}`
  }
  if (2 * t >= Math.min(b, h)) throw new Error('Wall is too thick for that section.')
  const { I, S, A } = boxSection(b, h, t)
  const L = len(pos(a.span, 'span'), u)!
  const P = force(a.load ?? 0, u)!
  const c = a.case ?? 'simply_supported_center'
  const w = a.self_weight === false ? 0 : A * mat.density * G0
  const E = mat.eGPa * 1e9
  const r = beamCase(c, L, P, w, E, I)
  const stress = r.M / S
  const sf = (mat.yieldMPa * 1e6) / stress
  const lines = [
    `# ${label}, ${mat.name}, ${c.replace(/_/g, ' ')}, span ${both.len(L)}, load ${both.force(P)}${w ? ' + self-weight' : ''}`,
    `Section: I = ${sig(I / IN ** 4)} in⁴ · S = ${sig(S / IN ** 3)} in³ · ${sig((A * mat.density * IN) / LB)} lb/in (${sig(A * mat.density)} kg/m)`,
    `Max moment ${both.torque(r.M)} → bending stress ${sig(stress / 1e6)} MPa (${sig(stress / 6894.76)} psi); yield ${mat.yieldMPa} MPa → safety factor ${sig(sf, 2)}`,
    `Max deflection ${both.len(r.defl)} (${sig(r.defl / L * 1000, 2)} mm per m of span)`
  ]
  if (sf < 2) lines.push('⚠ Safety factor under 2 on a static load. Robots see impacts several times their static loads: go thicker, taller, shorter, or add a gusset/support.')
  else if (sf < 4) lines.push('Static SF is OK, but for parts that get hit (intakes, bumper mounts, arms that slam) use an impact factor of 2-3× first.')
  lines.push('Assumes ideal beam theory, no corner radii, no holes. Bolt/rivet holes and thin 1/16" walls crush and buckle locally long before this stress: add crush blocks or tube plugs at bolted joints. 6061 near welds drops to roughly half its strength.')
  return lines.join('\n')
}

export function shaftCheck(a: FrcMechArgs): string {
  const u: Units = a.units ?? 'imperial'
  const shape = a.shape ?? 'hex'
  const mat = materialOf(a.material, '7075-t6')
  const s = len(pos(a.size, 'size (across flats for hex, diameter for round)'), u)!
  const di = len(a.bore ?? 0, u)!
  if (di >= s) throw new Error('bore must be smaller than size.')
  // Hex: treat as the inscribed round (across flats), slightly conservative for strength and stiffness.
  const J = (Math.PI * (s ** 4 - di ** 4)) / 32
  const Ib = J / 2
  let T: number
  let why = ''
  if (a.torque !== undefined) T = u === 'metric' ? a.torque : a.torque * LBF * IN
  else {
    const d = driveFrom(a, 0.9)
    T = outStall(d, true)
    why = ` (stall at this shaft: ${driveLine(d)})`
  }
  const M = a.bending_moment === undefined ? 0 : u === 'metric' ? a.bending_moment : a.bending_moment * LBF * IN
  const tau = (T * (s / 2)) / J
  const sigma = (M * (s / 2)) / Ib
  const vm = Math.sqrt(sigma ** 2 + 3 * tau ** 2)
  const sf = (mat.yieldMPa * 1e6) / vm
  const lines = [`# ${shape === 'hex' ? `${sig(s / IN, 3)}" hex` : `${sig(s / IN, 3)}" round`}${di ? ` with ${sig(di / IN, 3)}" bore` : ''} shaft, ${mat.name}`,
    `Torque ${both.torque(T)}${why}${M ? `, bending moment ${both.torque(M)}` : ''}.`,
    `Shear ${sig(tau / 1e6)} MPa${M ? `, bending ${sig(sigma / 1e6)} MPa` : ''} → von Mises ${sig(vm / 1e6)} MPa vs yield ${mat.yieldMPa} MPa → safety factor ${sig(sf, 2)}.`]
  if (a.length) {
    const L = len(a.length, u)!
    const G = (mat.eGPa * 1e9) / 2.6
    lines.push(`Twist over ${both.len(L)}: ${sig(((T * L) / (G * J)) * (180 / Math.PI), 2)}°.`)
  }
  lines.push(sf < 1.5 ? '⚠ Under 1.5: expect twisting or failure under stall or shock loads. Bigger shaft (1/2" → MAXSpline/1.125" round), steel, or less torque (current limit, move the reduction later).' : sf < 3 ? 'Marginal for shock loads (drivetrain hits, arms slamming); 3+ is comfortable.' : 'Comfortable margin.')
  lines.push('Hex modeled as the inscribed circle (across flats), slightly conservative. Retaining-ring grooves and cross-holes are stress raisers (~2-3×): keep them out of high-torque sections.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- weight budget

export function weightBudget(a: FrcMechArgs): string {
  const u: Units = a.units ?? 'imperial'
  const items = a.items ?? []
  if (!items.length) throw new Error('items is required: [{ name, mass, qty?, subsystem?, excluded? }].')
  const kg = (x: number): number => mass(x, u)!
  const limit = kg(a.limit ?? (u === 'metric' ? 52.16 : 115))
  const margin = kg(a.margin ?? (u === 'metric' ? 2.3 : 5))
  const bySub = new Map<string, number>()
  let counted = 0
  let excluded = 0
  for (const it of items) {
    const m = kg(num(it.mass, `mass of ${it.name}`)) * (it.qty ?? 1)
    if (it.excluded) { excluded += m; continue }
    counted += m
    const k = it.subsystem || 'other'
    bySub.set(k, (bySub.get(k) ?? 0) + m)
  }
  const left = limit - counted
  const lines = [`# Weight budget: ${both.mass(counted)} of ${both.mass(limit)} (${sig((100 * counted) / limit, 3)}%)`,
    ...[...bySub].sort((x, y) => y[1] - x[1]).map(([k, m]) => `- ${k}: ${both.mass(m)} (${sig((100 * m) / counted, 2)}%)`)]
  if (excluded) lines.push(`Excluded from the limit (e.g. bumpers, battery): ${both.mass(excluded)}; robot + excluded = ${both.mass(counted + excluded)}.`)
  lines.push(left < 0 ? `⚠ Over by ${both.mass(-left)}. Cut weight now: pocket plates, thinner tube where stiffness allows, lighter motors/wheels, fewer fasteners.` : left < margin ? `⚠ Only ${both.mass(left)} left, under your ${both.mass(margin)} margin. Fixes and additions at events always add weight.` : `${both.mass(left)} under the limit (margin target ${both.mass(margin)}).`)
  lines.push('Add wire, fasteners, zip ties and electronics at ~5-10% of the robot if they aren\'t itemized. Limits: 2026 manual R103 = 115 lb without bumpers and battery; R408 = 135 lb with bumpers. Rules change every season: confirm in the current Game Manual.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- the tool

export function frcMechTool(): ToolDef<FrcMechArgs> {
  return {
    name: 'frc_mech',
    label: 'FRC mechanical calcs',
    group: 'FRC robotics',
    effect: 'read',
    description: 'FRC (FIRST Robotics) mechanical design calculator, offline. actions: motor_data (specs table, or motor: "kraken_x60", "neo_vortex", "neo_550", "minion", "falcon_500"…), mechanism (motor, motor_count, gear_ratio = motor turns per output turn, efficiency, current_limit; kind flywheel: wheel_diameter, target_rpm, moi or flywheel_mass, piece_mass+exit_speed → spin-up, recovery, kV/kA; arm: arm_mass, com_distance, start_deg/end_deg → gravity torque, holding current, move time, kG/kV/kA; elevator: load_mass, drum_diameter or sprocket_teeth+chain or pulley_teeth, rigging_ratio, travel, spring_assist → speed, time, kG/kV/kA; drivetrain: robot_mass, wheel_diameter, cof, distance, motor_count = all drive motors → free speed, push vs traction, slip current, time to distance), gear_ratio_search (target_ratio, tolerance, max_stages ≤3, stage_types gear/belt/chain/maxplanetary/versaplanetary/ultraplanetary), center_distance (drive htd5/gt2_3mm/chain25/chain35, teeth_1, teeth_2, belt_teeth or links → center; or target_center → nearest stock sizes), beam (section "2x1x1/16" etc. or outer_width/outer_height/wall, orientation, material, span, load, case), shaft_torque_check (shape hex/round, size, bore, torque or motor+ratio for stall), weight_budget (items [{name, mass, qty, subsystem, excluded}], limit, margin). units: imperial (lb, in, lbf, ft/s, lb·in², in·lbf; default) or metric (kg, m, N, m/s, kg·m², N·m). Results are model estimates: state assumptions, verify specs on vendor pages and rules in the current Game Manual.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['motor_data', 'mechanism', 'gear_ratio_search', 'center_distance', 'beam', 'shaft_torque_check', 'weight_budget'] },
        units: { type: 'string', enum: ['imperial', 'metric'] },
        motor: { type: 'string' },
        motor_count: { type: 'integer', minimum: 1, maximum: 12 },
        gear_ratio: { type: 'number', description: 'Motor turns per output turn (6.75 = 6.75:1 reduction; 0.67 = upduction)' },
        efficiency: { type: 'number', description: '0-1 (default 0.85 mechanisms, 0.9 drivetrains)' },
        current_limit: { type: 'number', description: 'Per-motor stator/motor current limit, A' },
        voltage: { type: 'number', description: 'Volts at the motor (default 12)' },
        kind: { type: 'string', enum: ['flywheel', 'arm', 'elevator', 'drivetrain', 'generic'] },
        target_rpm: { type: 'number' }, wheel_diameter: { type: 'number' }, moi: { type: 'number', description: 'lb·in² or kg·m²' },
        flywheel_mass: { type: 'number' }, flywheel_shape: { type: 'string', enum: ['solid', 'ring'] },
        piece_mass: { type: 'number' }, exit_speed: { type: 'number', description: 'ft/s or m/s' },
        arm_mass: { type: 'number' }, com_distance: { type: 'number' }, start_deg: { type: 'number' }, end_deg: { type: 'number' },
        load_mass: { type: 'number' }, drum_diameter: { type: 'number' }, sprocket_teeth: { type: 'integer' }, chain: { type: 'string', enum: ['25', '35'] },
        pulley_teeth: { type: 'integer' }, rigging_ratio: { type: 'number' }, travel: { type: 'number' }, incline_deg: { type: 'number' }, spring_assist: { type: 'number', description: 'lbf or N' },
        robot_mass: { type: 'number' }, cof: { type: 'number' }, distance: { type: 'number' },
        target_ratio: { type: 'number' }, tolerance: { type: 'number', description: 'Fraction, default 0.02' }, max_stages: { type: 'integer', minimum: 1, maximum: 3 },
        stage_types: { type: 'array', items: { type: 'string', enum: ['gear', 'belt', 'chain', 'maxplanetary', 'versaplanetary', 'ultraplanetary'] } },
        max_results: { type: 'integer', minimum: 1, maximum: 20 },
        drive: { type: 'string', enum: ['htd5', 'gt2_3mm', 'chain25', 'chain35'] },
        teeth_1: { type: 'integer' }, teeth_2: { type: 'integer' }, belt_teeth: { type: 'integer' }, links: { type: 'integer' },
        target_center: { type: 'number' }, extra_center: { type: 'number' },
        section: { type: 'string' }, orientation: { type: 'string', enum: ['tall', 'flat'] },
        outer_width: { type: 'number' }, outer_height: { type: 'number' }, wall: { type: 'number' },
        material: { type: 'string', description: '6061-t6, 7075-t6, steel, polycarbonate' },
        span: { type: 'number' }, load: { type: 'number' },
        case: { type: 'string', enum: ['simply_supported_center', 'simply_supported_uniform', 'cantilever_end', 'cantilever_uniform', 'fixed_fixed_center'] },
        self_weight: { type: 'boolean' },
        shape: { type: 'string', enum: ['hex', 'round'] }, size: { type: 'number' }, bore: { type: 'number' }, torque: { type: 'number' }, bending_moment: { type: 'number' }, length: { type: 'number' },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mass: { type: 'number' }, qty: { type: 'number' }, subsystem: { type: 'string' }, excluded: { type: 'boolean' } }, required: ['name', 'mass'] } },
        limit: { type: 'number' }, margin: { type: 'number' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a) {
      return { text: runFrcMech(a), display: `FRC ${a.action.replace(/_/g, ' ')}${a.kind ? ` (${a.kind})` : ''}` }
    }
  }
}

export function runFrcMech(a: FrcMechArgs): string {
  switch (a.action) {
    case 'motor_data': return motorData(a)
    case 'mechanism': return mechanism(a)
    case 'gear_ratio_search': return gearSearch(a)
    case 'center_distance': return centerDistance(a)
    case 'beam': return beam(a)
    case 'shaft_torque_check': return shaftCheck(a)
    case 'weight_budget': return weightBudget(a)
    default: throw new Error(`Unknown action ${String((a as { action?: string }).action)}.`)
  }
}
