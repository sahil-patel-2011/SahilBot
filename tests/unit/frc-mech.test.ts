import { describe, expect, test } from 'vitest'
import {
  beamCase, beltCenter, beltLength, boxSection, chainCenter, chainLinks, findMotor, frcMechTool, limitTorque, MOTORS,
  outFree, outStall, runFrcMech, searchRatios, sig, type Drive
} from '../../src/main/agent/tools/frc_mech'

const IN = 0.0254

describe('frc_mech motor data', () => {
  test('finds motors by loose names and every entry is physically sane', () => {
    expect(findMotor('Kraken X60')?.id).toBe('kraken_x60')
    expect(findMotor('kraken x60 foc')?.id).toBe('kraken_x60_foc')
    expect(findMotor('NEO 550')?.id).toBe('neo_550')
    expect(findMotor('vortex')?.id).toBe('neo_vortex')
    expect(findMotor('banana')).toBeUndefined()
    for (const m of MOTORS) {
      expect(m.freeRpm, m.id).toBeGreaterThan(1000)
      expect(m.stallA, m.id).toBeGreaterThan(m.freeA)
      expect(m.stallNm, m.id).toBeGreaterThan(0.1)
    }
  })
  test('motor_data lists the table with sources and a check date', () => {
    const t = runFrcMech({ action: 'motor_data' })
    expect(t).toContain('| kraken_x60 | Kraken X60 (trapezoidal) | 6065 | 7.16 | 374 |')
    expect(t).toContain('reca.lc')
    expect(t).toMatch(/checked 20\d\d-\d\d-\d\d/)
    expect(() => runFrcMech({ action: 'motor_data', motor: 'banana' })).toThrow(/Unknown motor/)
  })
  test('the tool is read-only and not always loaded', () => {
    const t = frcMechTool()
    expect(t.effect).toBe('read')
    expect(t.core).toBeFalsy()
  })
})

describe('frc_mech motor model', () => {
  const d: Drive = { motor: findMotor('kraken_x60')!, count: 2, ratio: 10, efficiency: 1, volts: 12 }
  test('free speed and stall torque scale with the ratio and motor count', () => {
    expect((outFree(d) * 60) / (2 * Math.PI)).toBeCloseTo(606.5, 1)
    expect(outStall(d)).toBeCloseTo(2 * 10 * 7.16, 6)
  })
  test('a current limit caps torque linearly between free and stall current', () => {
    const lim = { ...d, currentLimit: 40 }
    expect(limitTorque(lim)).toBeCloseTo((7.16 * (40 - 2.8)) / (374 - 2.8), 6)
    expect(outStall(lim)).toBeCloseTo(20 * limitTorque(lim), 6)
  })
})

describe('frc_mech mechanisms', () => {
  test('swerve L2 on a Kraken with 4 in wheels is about 15.7 ft/s', () => {
    const t = runFrcMech({ action: 'mechanism', kind: 'drivetrain', motor: 'kraken_x60', motor_count: 4, gear_ratio: 6.75, wheel_diameter: 4, robot_mass: 135 })
    expect(t).toContain('Theoretical free speed 15.7 ft/s')
    expect(t).toMatch(/traction-limited|current-limited/)
    expect(t).toContain('Assumptions:')
  })
  test('arm kG matches the hand calculation', () => {
    // 10 lb at 15 in: 16.9 N·m. One Kraken, 100:1, 85%: 7.16*100*0.85/12 = 50.7 N·m per volt → kG ≈ 0.334 V.
    const t = runFrcMech({ action: 'mechanism', kind: 'arm', motor: 'kraken_x60', gear_ratio: 100, arm_mass: 10, com_distance: 15, start_deg: 0, end_deg: 90 })
    expect(t).toContain('kG ≈ 0.334 V')
    expect(t).toContain('Gravity torque at horizontal: 16.9 N·m')
  })
  test('an arm that cannot lift itself is flagged', () => {
    const t = runFrcMech({ action: 'mechanism', kind: 'arm', motor: 'neo_550', gear_ratio: 5, arm_mass: 15, com_distance: 20, current_limit: 25 })
    expect(t).toContain('Cannot lift at horizontal')
  })
  test('flywheel surface speed, unreachable targets and spin-up', () => {
    const ok = runFrcMech({ action: 'mechanism', kind: 'flywheel', motor: 'kraken_x60', motor_count: 2, gear_ratio: 1, wheel_diameter: 4, target_rpm: 4000, moi: 10 })
    expect(ok).toContain('Surface speed at target: 69.8 ft/s')
    expect(ok).toMatch(/Spin-up 0 → 4000 RPM: ~\d/)
    const bad = runFrcMech({ action: 'mechanism', kind: 'flywheel', motor: 'kraken_x60', gear_ratio: 1, wheel_diameter: 4, target_rpm: 7000, moi: 10 })
    expect(bad).toContain('unreachable')
  })
  test('elevator from a #25 sprocket and cascade rigging', () => {
    const t = runFrcMech({ action: 'mechanism', kind: 'elevator', motor: 'neo_vortex', motor_count: 2, gear_ratio: 9, load_mass: 20, sprocket_teeth: 22, chain: '25', rigging_ratio: 2, travel: 48 })
    expect(t).toContain('Pitch diameter 1.76 in')
    expect(t).toMatch(/Time to travel 48 in/)
    expect(t).toMatch(/kG ≈ [\d.]+ V/)
  })
  test('bad inputs give clear errors', () => {
    expect(() => runFrcMech({ action: 'mechanism', kind: 'arm', motor: 'neo', arm_mass: 5, com_distance: 10 })).toThrow(/gear_ratio/)
    expect(() => runFrcMech({ action: 'mechanism', kind: 'flywheel', motor: 'neo', gear_ratio: 1, wheel_diameter: 4, target_rpm: 3000 })).toThrow(/moi or flywheel_mass/)
  })
})

describe('frc_mech gear ratio search', () => {
  test('finds an exact two-stage 25:1 and never puts a motor pinion after stage 1', () => {
    const r = searchRatios(25, { maxStages: 2 })
    expect(r.length).toBeGreaterThan(0)
    expect(Math.abs(r[0].error)).toBeLessThan(1e-9)
    for (const x of r) expect(x.stages.slice(1).every((s) => !s.pinion)).toBe(true)
  })
  test('planetary stages stack first and multiply', () => {
    const r = searchRatios(45, { types: ['maxplanetary', 'belt'], maxStages: 2 })
    expect(r[0].stages.map((s) => s.type)).toEqual(['maxplanetary', 'maxplanetary'])
    for (const x of r) {
      const firstNon = x.stages.findIndex((s) => !s.type.endsWith('planetary'))
      if (firstNon >= 0) expect(x.stages.slice(firstNon).some((s) => s.type.endsWith('planetary'))).toBe(false)
    }
  })
  test('upductions work for shooters', () => {
    const r = searchRatios(0.5, { maxStages: 1, types: ['belt'] })
    expect(r[0].ratio).toBeCloseTo(0.5, 9)
  })
  test('text output and the no-match message', () => {
    expect(runFrcMech({ action: 'gear_ratio_search', target_ratio: 12, max_stages: 2 })).toContain('12:1 (exact)')
    expect(runFrcMech({ action: 'gear_ratio_search', target_ratio: 1000, max_stages: 1 })).toContain('No combination')
  })
})

describe('frc_mech center distance', () => {
  test('1:1 belts and chain reduce to the simple formulas', () => {
    expect(beltCenter(5, 60, 24, 24)).toBeCloseTo(((60 - 24) * 5) / 2, 6) // 90 mm (3.543 in)
    expect(chainCenter(6.35, 60, 16, 16)).toBeCloseTo(((60 - 16) * 6.35) / 2, 6)
  })
  test('length and center are inverses', () => {
    const C = beltCenter(5, 80, 18, 36)
    expect(beltLength(5, C, 18, 36)).toBeCloseTo(80, 6)
    const Cc = chainCenter(6.35, 80, 16, 48)
    expect(chainLinks(6.35, Cc, 16, 48)).toBeCloseTo(80, 6)
  })
  test('nearest stock sizes bracket the target', () => {
    const t = runFrcMech({ action: 'center_distance', drive: 'htd5', teeth_1: 18, teeth_2: 36, target_center: 5 })
    expect(t).toContain('75 T belt')
    expect(t).toContain('80 T belt')
    const c = runFrcMech({ action: 'center_distance', drive: 'chain25', teeth_1: 16, teeth_2: 16, links: 61 })
    expect(c).toContain('Odd link count')
  })
})

describe('frc_mech structure', () => {
  test('box tube section properties', () => {
    const { I } = boxSection(1 * IN, 2 * IN, 0.0625 * IN)
    expect(I / IN ** 4).toBeCloseTo((1 * 8 - 0.875 * 1.875 ** 3) / 12, 6)
  })
  test('simply supported center load deflection is PL³/48EI', () => {
    const r = beamCase('simply_supported_center', 1, 100, 0, 70e9, 1e-8)
    expect(r.defl).toBeCloseTo(100 / (48 * 70e9 * 1e-8), 9)
    expect(r.M).toBeCloseTo(25, 9)
  })
  test('beam and shaft checks report a safety factor and warn when low', () => {
    expect(runFrcMech({ action: 'beam', section: '2x1x1/16', span: 26, load: 150 })).toMatch(/safety factor \d/)
    expect(runFrcMech({ action: 'beam', section: '1x1x1/16', span: 30, load: 400, case: 'cantilever_end' })).toContain('⚠')
    const s = runFrcMech({ action: 'shaft_torque_check', shape: 'hex', size: 0.5, torque: 2000 })
    expect(s).toContain('⚠')
    expect(runFrcMech({ action: 'shaft_torque_check', shape: 'hex', size: 0.5, motor: 'kraken_x60', gear_ratio: 25, current_limit: 60 })).toContain('stall at this shaft')
  })
})

describe('frc_mech weight budget', () => {
  test('sums by subsystem, keeps excluded items out and flags overweight', () => {
    const t = runFrcMech({ action: 'weight_budget', items: [{ name: 'modules', mass: 6.5, qty: 4, subsystem: 'drive' }, { name: 'elevator', mass: 30, subsystem: 'elevator' }, { name: 'bumpers', mass: 15, excluded: true }] })
    expect(t).toContain('# Weight budget: 56 lb')
    expect(t).toContain('Excluded from the limit')
    const over = runFrcMech({ action: 'weight_budget', items: [{ name: 'everything', mass: 120 }] })
    expect(over).toContain('Over by 5 lb')
  })
  test('sig never shows false precision', () => {
    expect(sig(15.6789)).toBe('15.7')
    expect(sig(6065, 3)).toBe('6070')
    expect(sig(Infinity)).toBe('∞')
  })
})
