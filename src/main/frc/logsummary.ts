import { decodeNumber, decodeNumberArray, decodeStringArray, isNumericArrayType, isNumericType, scanWpilog, schemaEntryName, StructSchemas, type WpilogEntry } from './wpilog'

// Health summary and chart series for WPILib .wpilog files (DataLogManager, AdvantageKit, Phoenix
// hoot→wpilog exports). Signal names differ between teams and libraries, so the categories below are
// name heuristics: the summary says which entries it used so the model (and the user) can check.

export interface SummaryOptions {
  /** Below this the roboRIO browns out (roboRIO 2 default 6.75 V, settable; roboRIO 1 fixed 6.3 V). */
  brownoutV?: number
  /** Below this counts as a voltage dip worth looking at. */
  lowV?: number
  /** Loop budget in ms (TimedRobot default period 20 ms). */
  loopBudgetMs?: number
  /** Motor temperature (°C) that counts as hot. */
  hotTempC?: number
}

interface Stat {
  e: WpilogEntry
  count: number
  firstUs: number
  lastUs: number
  min: number
  max: number
  sum: number
  n: number
  first: number
  last: number
  /** Per-index max for numeric arrays (first 64 indices). */
  arrMax?: number[]
  arrLen?: number
  /** Loop-time entries: samples over budget. */
  over?: number
}

interface Dip { startS: number; endS: number; minV: number }
interface ModeEvent { s: number; key: ModeKey; value: boolean }
type ModeKey = 'enabled' | 'autonomous' | 'test' | 'estop' | 'fms'

export interface LogSummary {
  file?: string
  extraHeader: string
  entries: number
  records: number
  truncated: boolean
  startS: number
  endS: number
  durationS: number
  wallClockStart?: string
  match?: Record<string, string>
  voltage?: { entry: string; min: number; minAtS: number; mean: number; dips: Dip[]; brownoutDips: number; lowV: number; brownoutV: number; others: Array<{ entry: string; min: number }> }
  brownedOut: Array<{ entry: string; events: number; firstAtS?: number }>
  modes: { timeline: Array<{ s: number; mode: string }>; enabledS: number; autoS: number; teleopS: number; entries: string[] }
  loop: { entries: Array<{ entry: string; maxMs: number; meanMs: number; over: number; samples: number }>; overrunMessages: number; samples: string[]; budgetMs: number }
  can: { utilization: Array<{ entry: string; maxPct: number; meanPct: number }>; errors: Array<{ entry: string; increase: number; max: number }>; messages: number; samples: string[] }
  currents: Array<{ entry: string; max: number; mean: number; channel?: number }>
  temps: Array<{ entry: string; max: number; hot: boolean }>
  hotTempC: number
  messages: Array<{ text: string; count: number; firstAtS: number }>
  top: Array<{ entry: string; type: string; count: number }>
  groups: Array<{ prefix: string; entries: number }>
  structs: string[]
}

// ---------------------------------------------------------------- name heuristics (exported for tests)

export function modeKey(name: string): ModeKey | null {
  const m = name.match(/(?:^DS:|(?:^|\/)DriverStation\/)(enabled|autonomous|test|estop|emergencystop|fmsattached)$/i)
  if (!m) return null
  const k = m[1].toLowerCase()
  return k === 'emergencystop' ? 'estop' : k === 'fmsattached' ? 'fms' : (k as ModeKey)
}
export const isBatteryVoltage = (name: string): boolean => /battery.?voltage|(^|[/:_])vbat$|powerdistribution\/voltage$|(^|\/)(input|bus|supply)voltage$|systemstats\/.*voltage$/i.test(name) && !/brownout|limit|threshold|setpoint|applied|output/i.test(name)
export const isBrownoutFlag = (name: string): boolean => /browned.?out/i.test(name)
export const isLoopTime = (name: string): boolean => /full.?cycle|user.?code.?ms|loop.?(time|period|cycle|duration)|cycle.?time|periodic.?ms|loopms/i.test(name)
export const isCanUtil = (name: string): boolean => /can.*(util|usage|load|percent)/i.test(name)
export const isCanError = (name: string): boolean => /can.*(error|bus.?off|off.?count|tx.?full|receive.?err|transmit.?err)/i.test(name)
export const isCurrent = (name: string): boolean => /current|amps?$|amperage/i.test(name) && !/limit|threshold|setpoint|reference|target|voltage|enable|command|mode|state/i.test(name)
export const isTemp = (name: string): boolean => /temp(erature)?/i.test(name) && !/limit|threshold|template|temporary|attempt/i.test(name)
const isMatchInfo = (name: string): string | null => {
  const m = name.match(/(?:^|\/)(eventname|matchnumber|matchtype|replaynumber|alliancestation|allianceid|gamespecificmessage)$/i)
  return m ? m[1] : null
}

const OVERRUN = /overrun|loop time of .* overrun/i
const CAN_MSG = /\b(CAN|CANivore|Phoenix|REV|Spark|TalonFX|status ?code)\b/i
const CAN_BAD = /error|timeout|timed out|stale|not received|fail|missing|could not|unable/i
const ERRORISH = /error|exception|warning|fault|unable|failed|overrun|brownout|not found/i

const r2 = (x: number): number => Math.round(x * 100) / 100
const s3 = (us: number): number => Math.round(us / 1000) / 1000

/** One pass over the log; builds the health summary. */
export function summarizeWpilog(buf: Uint8Array, opts: SummaryOptions = {}): LogSummary {
  const brownoutV = opts.brownoutV ?? 6.75
  const lowV = opts.lowV ?? 7.5
  const budget = opts.loopBudgetMs ?? 20
  const hotTempC = opts.hotTempC ?? 70
  const stats = new Map<number, Stat>()
  const byEntry = new Map<WpilogEntry, Stat>()
  const dips = new Map<WpilogEntry, { list: Dip[]; open: Dip | null; minAtUs: number; posMin: number }>()
  const brown = new Map<WpilogEntry, { events: number; last: boolean; firstUs?: number }>()
  const modeEvents: ModeEvent[] = []
  const modeLast = new Map<WpilogEntry, boolean>()
  const msgs = new Map<string, { text: string; count: number; firstUs: number }>()
  const loopSamples: string[] = []
  const canSamples: string[] = []
  let overrunMessages = 0
  let canMessages = 0
  let wall: number | undefined
  const match: Record<string, string> = {}
  let minUs = Infinity
  let maxUs = -Infinity
  const structs = new Set<string>()

  const stat = (e: WpilogEntry): Stat => {
    let s = byEntry.get(e)
    if (!s) {
      s = { e, count: 0, firstUs: Infinity, lastUs: -Infinity, min: Infinity, max: -Infinity, sum: 0, n: 0, first: NaN, last: NaN }
      byEntry.set(e, s)
      stats.set(e.id, s)
    }
    return s
  }

  const onText = (text: string, us: number): void => {
    for (const lineRaw of text.split(/\r?\n/)) {
      const line = lineRaw.trim()
      if (!line) continue
      if (OVERRUN.test(line)) { overrunMessages++; if (loopSamples.length < 5) loopSamples.push(`${s3(us)}s: ${line.slice(0, 200)}`) }
      if (CAN_MSG.test(line) && CAN_BAD.test(line)) { canMessages++; if (canSamples.length < 5) canSamples.push(`${s3(us)}s: ${line.slice(0, 200)}`) }
      if (ERRORISH.test(line)) {
        const key = line.replace(/\d+(\.\d+)?/g, '#').slice(0, 160)
        const m = msgs.get(key)
        if (m) m.count++
        else if (msgs.size < 400) msgs.set(key, { text: line.slice(0, 220), count: 1, firstUs: us })
      }
    }
  }

  const res = scanWpilog(buf, {
    start: (e) => { if (e.type.startsWith('struct:')) structs.add(e.type.replace(/^struct:/, '')) },
    data: (e, us, p) => {
      if (us < minUs) minUs = us
      if (us > maxUs) maxUs = us
      const s = stat(e)
      s.count++
      if (us < s.firstUs) s.firstUs = us
      if (us > s.lastUs) s.lastUs = us
      const t = e.type
      if (isNumericType(t)) {
        const v = decodeNumber(t, p)
        if (!Number.isFinite(v)) return
        if (s.n === 0) s.first = v
        s.last = v
        s.n++
        s.sum += v
        if (v < s.min) s.min = v
        if (v > s.max) s.max = v
        const name = e.name
        if (t === 'boolean') {
          const k = modeKey(name)
          const b = v !== 0
          if (k && modeLast.get(e) !== b) { modeLast.set(e, b); modeEvents.push({ s: us / 1e6, key: k, value: b }) }
          if (isBrownoutFlag(name)) {
            const st = brown.get(e) ?? { events: 0, last: false }
            if (b && !st.last) { st.events++; st.firstUs ??= us }
            st.last = b
            brown.set(e, st)
          }
          return
        }
        if (name === 'systemTime' || /(^|\/)(epochtimemicros|systemtime)$/i.test(name)) { if (wall === undefined && v > 1e15) wall = v; return }
        if (isBatteryVoltage(name)) {
          const d = dips.get(e) ?? { list: [], open: null, minAtUs: us, posMin: Infinity }
          if (v > 0.5 && v < d.posMin) { d.posMin = v; d.minAtUs = us }
          // Ignore 0 V samples: that is "no reading" (sim, unplugged), not a 0 V battery.
          if (v > 0.5 && v < lowV) {
            if (!d.open) d.open = { startS: us / 1e6, endS: us / 1e6, minV: v }
            d.open.endS = us / 1e6
            d.open.minV = Math.min(d.open.minV, v)
          } else if (d.open && v >= lowV + 0.2) {
            if (d.list.length < 200) d.list.push(d.open)
            d.open = null
          }
          dips.set(e, d)
        }
        if (isLoopTime(name)) {
          const ms = /ms|millis/i.test(name) || s.max > 1.5 ? v : v * 1000
          if (ms > budget) s.over = (s.over ?? 0) + 1
        }
        const mi = isMatchInfo(name)
        if (mi && v) match[mi] = String(v)
        return
      }
      if (isNumericArrayType(t) && (isCurrent(e.name) || isTemp(e.name))) {
        const a = decodeNumberArray(t, p)
        s.arrLen = Math.max(s.arrLen ?? 0, a.length)
        s.arrMax ??= []
        for (let i = 0; i < Math.min(a.length, 64); i++) if (Number.isFinite(a[i]) && !(a[i] <= (s.arrMax[i] ?? -Infinity))) s.arrMax[i] = a[i]
        return
      }
      if (t === 'string' || t === 'json') {
        const text = new TextDecoder().decode(p)
        const mi = isMatchInfo(e.name)
        if (mi && text.trim()) match[mi] = text.trim().slice(0, 40)
        if (t === 'string' && text.length < 20_000) onText(text, us)
        return
      }
      if (t === 'string[]' && /console|message|alert|error|warning|fault/i.test(e.name)) for (const x of decodeStringArray(p)) onText(x, us)
    }
  })

  const all = [...stats.values()]
  if (!Number.isFinite(minUs)) { minUs = 0; maxUs = 0 }

  // Battery voltage: the best-named entry drives brownout analysis; the rest are listed.
  const volts = all.filter((s) => isBatteryVoltage(s.e.name) && s.n > 0 && s.max > 0.5)
  const rank = (n: string): number => (/battery/i.test(n) ? 0 : /systemstats|powerdistribution/i.test(n) ? 1 : 2)
  volts.sort((a, b) => rank(a.e.name) - rank(b.e.name) || b.n - a.n)
  let voltage: LogSummary['voltage']
  if (volts.length) {
    const v = volts[0]
    const d = dips.get(v.e)
    const list = [...(d?.list ?? []), ...(d?.open ? [d.open] : [])].map((x) => ({ startS: r2(x.startS), endS: r2(x.endS), minV: r2(x.minV) }))
    const positive = d && Number.isFinite(d.posMin) ? d.posMin : v.min
    voltage = {
      entry: v.e.name, min: r2(positive), minAtS: r2((d?.minAtUs ?? v.firstUs) / 1e6), mean: r2(v.sum / v.n), dips: list.slice(0, 20),
      brownoutDips: list.filter((x) => x.minV < brownoutV).length, lowV, brownoutV,
      others: volts.slice(1, 6).map((o) => ({ entry: o.e.name, min: r2(o.min) }))
    }
  }

  // Robot mode timeline from the enabled / autonomous / test / e-stop booleans.
  modeEvents.sort((a, b) => a.s - b.s)
  const st: Record<ModeKey, boolean> = { enabled: false, autonomous: false, test: false, estop: false, fms: false }
  const modeName = (): string => (st.estop ? 'e-stopped' : !st.enabled ? 'disabled' : st.test ? 'test' : st.autonomous ? 'auto' : 'teleop')
  const timeline: Array<{ s: number; mode: string }> = []
  let enabledS = 0, autoS = 0, teleopS = 0
  let cur = 'disabled'
  let since = minUs / 1e6
  const account = (to: number): void => {
    const dt = Math.max(0, to - since)
    if (cur !== 'disabled' && cur !== 'e-stopped') enabledS += dt
    if (cur === 'auto') autoS += dt
    if (cur === 'teleop') teleopS += dt
  }
  for (const ev of modeEvents) {
    st[ev.key] = ev.value
    const m = modeName()
    if (m !== cur) {
      account(ev.s)
      cur = m
      since = ev.s
      if (timeline.length < 60) timeline.push({ s: r2(ev.s), mode: m })
    }
  }
  account(maxUs / 1e6)

  const loopEntries = all.filter((s) => isLoopTime(s.e.name) && s.n > 0 && s.e.type !== 'boolean').map((s) => {
    const scale = /ms|millis/i.test(s.e.name) || s.max > 1.5 ? 1 : 1000
    return { entry: s.e.name, maxMs: r2(s.max * scale), meanMs: r2((s.sum / s.n) * scale), over: s.over ?? 0, samples: s.n }
  })

  const canUtil = all.filter((s) => isCanUtil(s.e.name) && s.n > 0 && s.e.type !== 'boolean').map((s) => {
    const k = s.max <= 1.0001 ? 100 : 1
    return { entry: s.e.name, maxPct: r2(s.max * k), meanPct: r2((s.sum / s.n) * k) }
  })
  const canErr = all.filter((s) => isCanError(s.e.name) && s.n > 0 && s.e.type !== 'boolean').map((s) => ({ entry: s.e.name, increase: r2(Math.max(0, s.last - s.first)), max: r2(s.max) }))

  const currents: LogSummary['currents'] = []
  const temps: LogSummary['temps'] = []
  for (const s of all) {
    if (isCurrent(s.e.name)) {
      if (s.n > 0 && s.e.type !== 'boolean') currents.push({ entry: s.e.name, max: r2(s.max), mean: r2(s.sum / s.n) })
      else (s.arrMax ?? []).map((m, i) => ({ m, i })).filter((x) => x.m > 0).sort((x, y) => y.m - x.m).slice(0, 6).forEach(({ m, i }) => currents.push({ entry: `${s.e.name}[${i}]`, max: r2(m), mean: NaN, channel: i }))
    }
    if (isTemp(s.e.name)) {
      if (s.n > 0 && s.e.type !== 'boolean') temps.push({ entry: s.e.name, max: r2(s.max), hot: s.max >= hotTempC })
      else s.arrMax?.forEach((m, i) => temps.push({ entry: `${s.e.name}[${i}]`, max: r2(m), hot: m >= hotTempC }))
    }
  }
  currents.sort((a, b) => b.max - a.max)
  temps.sort((a, b) => b.max - a.max)

  const groups = new Map<string, number>()
  for (const e of res.entries) {
    const g = e.name.replace(/^\/+/, '').split(/[/:]/)[0] || e.name
    groups.set(g, (groups.get(g) ?? 0) + 1)
  }

  return {
    extraHeader: res.header.extraHeader,
    entries: res.entries.length,
    records: res.records,
    truncated: res.truncated,
    startS: r2(minUs / 1e6),
    endS: r2(maxUs / 1e6),
    durationS: r2((maxUs - minUs) / 1e6),
    wallClockStart: wall ? new Date(wall / 1000).toISOString() : undefined,
    match: Object.keys(match).length ? match : undefined,
    voltage,
    brownedOut: [...brown].map(([e, b]) => ({ entry: e.name, events: b.events, firstAtS: b.firstUs !== undefined ? r2(b.firstUs / 1e6) : undefined })),
    modes: { timeline, enabledS: r2(enabledS), autoS: r2(autoS), teleopS: r2(teleopS), entries: [...new Set([...modeLast.keys()].map((e) => e.name))] },
    loop: { entries: loopEntries, overrunMessages, samples: loopSamples, budgetMs: budget },
    can: { utilization: canUtil, errors: canErr, messages: canMessages, samples: canSamples },
    currents: currents.slice(0, 15),
    temps: temps.slice(0, 15),
    hotTempC,
    messages: [...msgs.values()].sort((a, b) => b.count - a.count).slice(0, 15).map((m) => ({ text: m.text, count: m.count, firstAtS: r2(m.firstUs / 1e6) })),
    top: all.sort((a, b) => b.count - a.count).slice(0, 20).map((s) => ({ entry: s.e.name, type: s.e.type, count: s.count })),
    groups: [...groups].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([prefix, entries]) => ({ prefix, entries })),
    structs: [...structs].slice(0, 20)
  }
}

/** Plain-text report for the model. */
export function formatSummary(s: LogSummary): string {
  const out: string[] = []
  const flags: string[] = []
  out.push(`# WPILib log summary${s.file ? `: ${s.file}` : ''}`)
  out.push(`${s.entries} entries, ${s.records.toLocaleString('en-US')} records, robot time ${s.startS}s → ${s.endS}s (${s.durationS}s)${s.wallClockStart ? `, wall clock start ${s.wallClockStart}` : ''}${s.truncated ? '. The file ends mid-record (log cut off, e.g. power loss); everything before that point was read.' : ''}`)
  if (s.extraHeader) out.push(`Header: ${s.extraHeader.slice(0, 120)}`)
  if (s.match) out.push(`Match info: ${Object.entries(s.match).map(([k, v]) => `${k}=${v}`).join(', ')}`)

  out.push('', '## Robot modes')
  if (s.modes.timeline.length) {
    out.push(`Enabled ${s.modes.enabledS}s (auto ${s.modes.autoS}s, teleop ${s.modes.teleopS}s). From: ${s.modes.entries.join(', ')}`)
    out.push(s.modes.timeline.map((t) => `${t.s}s ${t.mode}`).join(' → '))
  } else out.push('No mode entries found (expected DS:enabled / DS:autonomous from DriverStation.startDataLog, or /DriverStation/* from AdvantageKit).')

  out.push('', '## Battery and brownouts')
  if (s.voltage) {
    const v = s.voltage
    out.push(`${v.entry}: min ${v.min} V at ${v.minAtS}s, mean ${v.mean} V. Dips below ${v.lowV} V: ${v.dips.length}; below the ${v.brownoutV} V brownout level: ${v.brownoutDips}.`)
    if (v.dips.length) out.push(`Dips: ${v.dips.slice(0, 10).map((d) => `${d.startS}–${d.endS}s (min ${d.minV} V)`).join('; ')}`)
    if (v.others.length) out.push(`Other voltage entries: ${v.others.map((o) => `${o.entry} min ${o.min} V`).join('; ')}`)
    if (v.brownoutDips) flags.push(`${v.brownoutDips} brownout-level voltage dip(s)`)
    else if (v.min < 8) flags.push(`battery sagged to ${v.min} V`)
  } else out.push('No battery voltage entry found (AdvantageKit logs /SystemStats/BatteryVoltage; with plain WPILib, log RobotController.getBatteryVoltage()).')
  for (const b of s.brownedOut) {
    out.push(`${b.entry}: ${b.events} brownout event(s)${b.firstAtS !== undefined ? `, first at ${b.firstAtS}s` : ''}`)
    if (b.events) flags.push(`roboRIO reported ${b.events} brownout(s)`)
  }

  out.push('', '## Loop timing')
  for (const l of s.loop.entries) {
    out.push(`${l.entry}: max ${l.maxMs} ms, mean ${l.meanMs} ms, ${l.over} of ${l.samples} cycles over ${s.loop.budgetMs} ms`)
    if (l.over && l.samples && l.over / l.samples > 0.01) flags.push(`${l.entry} over budget in ${Math.round((100 * l.over) / l.samples)}% of cycles`)
  }
  out.push(`Loop overrun messages in console/log text: ${s.loop.overrunMessages}`)
  for (const x of s.loop.samples) out.push(`  ${x}`)
  if (s.loop.overrunMessages) flags.push(`${s.loop.overrunMessages} loop overrun message(s)`)

  out.push('', '## CAN bus')
  for (const u of s.can.utilization) { out.push(`${u.entry}: max ${u.maxPct}%, mean ${u.meanPct}%`); if (u.maxPct > 90) flags.push(`CAN utilization peaked at ${u.maxPct}%`) }
  for (const e of s.can.errors) { out.push(`${e.entry}: +${e.increase} over the log (max ${e.max})`); if (e.increase > 0) flags.push(`${e.entry} rose by ${e.increase}`) }
  out.push(`CAN-related error messages: ${s.can.messages}`)
  for (const x of s.can.samples) out.push(`  ${x}`)
  if (!s.can.utilization.length && !s.can.errors.length) out.push('(No CAN status entries; AdvantageKit logs /SystemStats/CANBus/*, or log RobotController.getCANStatus().)')
  if (s.can.messages) flags.push(`${s.can.messages} CAN error message(s)`)

  out.push('', '## Motor currents (highest max first)')
  out.push(s.currents.length ? s.currents.map((c) => `${c.entry}: max ${c.max} A${Number.isFinite(c.mean) ? `, mean ${c.mean} A` : ''}`).join('\n') : '(none found)')
  out.push('', '## Temperatures')
  out.push(s.temps.length ? s.temps.map((t) => `${t.entry}: max ${t.max} °C${t.hot ? '  ← hot' : ''}`).join('\n') : '(none found)')
  const hot = s.temps.filter((t) => t.hot)
  if (hot.length) flags.push(`${hot.length} temperature reading(s) at or above ${s.hotTempC} °C`)

  if (s.messages.length) {
    out.push('', '## Errors and warnings in log text (count × message)')
    for (const m of s.messages) out.push(`${m.count}× (first ${m.firstAtS}s) ${m.text}`)
  }
  out.push('', '## Busiest entries', s.top.map((t) => `${t.entry} (${t.type}) ×${t.count}`).join('\n'))
  out.push('', `Top-level groups: ${s.groups.map((g) => `${g.prefix} (${g.entries})`).join(', ')}`)
  if (s.structs.length) out.push(`Struct types: ${s.structs.join(', ')}`)
  out.splice(s.match ? 4 : 3, 0, '', `## Flags: ${flags.length ? flags.join('; ') : 'nothing alarming found by these checks'}`)
  out.push('', 'Categories come from entry-name heuristics; check the entry names above. Plot entries with wpilog_series, or open the file in AdvantageScope.')
  return out.join('\n')
}

// ---------------------------------------------------------------- series extraction

export interface SeriesRequest {
  /** Entry name, or a case-insensitive part of one. Suffix "[i]" picks an array element, "#field" a struct field. */
  entry: string
}
export interface Series { name: string; type: string; total: number; points: Array<[number, number | string]> }
export interface SeriesResult { series: Series[]; unmatched: string[]; notes: string[] }

export interface SeriesOptions { maxPoints?: number; startS?: number; endS?: number; maxSeries?: number }

type Pick = { entryName: string; index?: number; field?: string }

function parseSpec(spec: string): Pick {
  const f = spec.match(/^(.*)#([\w.[\]]+)$/)
  if (f) return { entryName: f[1], field: f[2] }
  const i = spec.match(/^(.*)\[(\d+)\]$/)
  if (i) return { entryName: i[1], index: Number(i[2]) }
  return { entryName: spec }
}

/** All entry names and types (first pass, no decoding). */
export function listEntries(buf: Uint8Array): WpilogEntry[] {
  return scanWpilog(buf).entries
}

export function extractSeries(buf: Uint8Array, specs: string[], o: SeriesOptions = {}): SeriesResult {
  const maxPoints = Math.max(10, Math.min(o.maxPoints ?? 400, 5000))
  const maxSeries = o.maxSeries ?? 8
  const entries = listEntries(buf)
  const notes: string[] = []
  const unmatched: string[] = []
  // name -> picks wanted for that entry
  const wanted = new Map<string, Pick[]>()
  let picked = 0
  for (const spec of specs) {
    const p = parseSpec(spec.trim())
    const exact = entries.filter((e) => e.name === p.entryName)
    const loose = exact.length ? exact : entries.filter((e) => e.name.toLowerCase().includes(p.entryName.toLowerCase()) && !schemaEntryName(e.name))
    const names = [...new Set(loose.map((e) => e.name))]
    if (!names.length) { unmatched.push(spec); continue }
    if (names.length > 4 && !exact.length) notes.push(`"${spec}" matched ${names.length} entries; using the first 4: ${names.slice(0, 4).join(', ')}. Be more specific for others.`)
    for (const n of names.slice(0, 4)) {
      if (picked >= maxSeries) break
      wanted.set(n, [...(wanted.get(n) ?? []), { ...p, entryName: n }])
      picked++
    }
  }

  const schemas = new StructSchemas()
  const raw = new Map<string, Map<string, { type: string; pts: Array<[number, number | string]> }>>()
  const lo = o.startS !== undefined ? o.startS * 1e6 : -Infinity
  const hi = o.endS !== undefined ? o.endS * 1e6 : Infinity
  const push = (entry: string, key: string, type: string, t: number, v: number | string): void => {
    let m = raw.get(entry)
    if (!m) raw.set(entry, (m = new Map()))
    let s = m.get(key)
    if (!s) m.set(key, (s = { type, pts: [] }))
    if (s.pts.length < 2_000_000) s.pts.push([t, v])
  }
  const arrayNoted = new Set<string>()

  scanWpilog(buf, {
    data: (e, us, p) => {
      const sn = schemaEntryName(e.name)
      if (sn && e.type === 'structschema') { schemas.add(sn, new TextDecoder().decode(p)); return }
      const picks = wanted.get(e.name)
      if (!picks || us < lo || us > hi) return
      const t = Math.round(us / 1000) / 1000
      const type = e.type
      for (const pk of picks) {
        if (isNumericType(type)) { push(e.name, e.name, type, t, decodeNumber(type, p)); continue }
        if (isNumericArrayType(type)) {
          const a = decodeNumberArray(type, p)
          if (pk.index !== undefined) { if (pk.index < a.length) push(e.name, `${e.name}[${pk.index}]`, type, t, a[pk.index]) }
          else if (a.length <= 8) a.forEach((x, i) => push(e.name, `${e.name}[${i}]`, type, t, x))
          else {
            if (!arrayNoted.has(e.name)) { arrayNoted.add(e.name); notes.push(`${e.name} has ${a.length} elements; showing the max element per sample. Ask for "${e.name}[i]" for one element.`) }
            push(e.name, `${e.name}[max]`, type, t, Math.max(...a))
          }
          continue
        }
        if (type === 'string' || type === 'json') { push(e.name, e.name, type, t, new TextDecoder().decode(p).slice(0, 200)); continue }
        if (type.startsWith('struct:')) {
          const name = type.slice(7).replace(/\[\]$/, '')
          const isArr = type.endsWith('[]')
          const recs = isArr ? schemas.decodeArray(name, p) : [schemas.decode(name, p)]
          if (!recs || recs[0] === null) {
            if (!arrayNoted.has(e.name)) { arrayNoted.add(e.name); notes.push(`${e.name} (${type}): no usable struct schema in the log, so it can't be decoded.`) }
            continue
          }
          recs.slice(0, isArr ? 4 : 1).forEach((r, i) => {
            for (const [k, v] of Object.entries(r ?? {})) {
              if (pk.field && k !== pk.field) continue
              if (typeof v === 'string') continue
              push(e.name, `${e.name}${isArr ? `[${i}]` : ''}#${k}`, type, t, typeof v === 'boolean' ? Number(v) : v)
            }
          })
          continue
        }
        if (!arrayNoted.has(e.name)) { arrayNoted.add(e.name); notes.push(`${e.name} has type ${type}, which can't be charted here.`) }
      }
    }
  })

  const series: Series[] = []
  for (const [, m] of raw) {
    for (const [key, s] of m) {
      if (series.length >= maxSeries * 3) break
      const numeric = s.pts.every((x) => typeof x[1] === 'number')
      const isBool = s.type === 'boolean' || s.type === 'boolean[]'
      let pts = s.pts
      if (isBool || !numeric) pts = changes(pts, maxPoints)
      else if (pts.length > maxPoints) pts = lttb(pts as Array<[number, number]>, maxPoints)
      series.push({ name: key, type: s.type, total: s.pts.length, points: pts.map(([t, v]) => [t, typeof v === 'number' ? round4(v) : v]) })
    }
  }
  for (const [n] of wanted) if (!raw.has(n)) notes.push(`${n}: no samples${o.startS !== undefined || o.endS !== undefined ? ' in that time window' : ''}.`)
  return { series, unmatched, notes }
}

const round4 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v)

/** Keeps only value changes (plus the last sample), capped. */
function changes(pts: Array<[number, number | string]>, max: number): Array<[number, number | string]> {
  const out: Array<[number, number | string]> = []
  for (let i = 0; i < pts.length; i++) if (i === 0 || pts[i][1] !== pts[i - 1][1]) out.push(pts[i])
  if (pts.length && out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1])
  return out.length > max ? out.filter((_, i) => i % Math.ceil(out.length / max) === 0) : out
}

/** Largest-Triangle-Three-Buckets downsampling: keeps the shape (spikes, dips) with few points. */
export function lttb(data: Array<[number, number]>, threshold: number): Array<[number, number]> {
  const n = data.length
  if (threshold >= n || threshold < 3) return data.slice()
  const out: Array<[number, number]> = [data[0]]
  const every = (n - 2) / (threshold - 2)
  let a = 0
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n)
    let ax = 0, ay = 0
    for (let j = avgStart; j < avgEnd; j++) { ax += data[j][0]; ay += data[j][1] }
    const len = Math.max(1, avgEnd - avgStart)
    ax /= len; ay /= len
    const rs = Math.floor(i * every) + 1
    const re = Math.floor((i + 1) * every) + 1
    let best = -1, pick = rs
    for (let j = rs; j < re; j++) {
      const area = Math.abs((data[a][0] - ax) * (data[j][1] - data[a][1]) - (data[a][0] - data[j][0]) * (ay - data[a][1]))
      if (area > best) { best = area; pick = j }
    }
    out.push(data[pick])
    a = pick
  }
  out.push(data[n - 1])
  return out
}

/** CSV with one row per point: series,t,value. */
export function seriesCsv(r: SeriesResult): string {
  const rows = ['series,t_s,value']
  for (const s of r.series) for (const [t, v] of s.points) rows.push(`${JSON.stringify(s.name)},${t},${typeof v === 'string' ? JSON.stringify(v) : v}`)
  return rows.join('\n')
}
