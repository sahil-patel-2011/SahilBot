// The feature plan: what the agent intends to build, as data. Written once (cad_design action "plan"),
// checked here, then turned into Onshape REST calls (onshape-features.ts / onshape-build.ts) or a FreeCAD
// script (freecad-build.ts). Dimensions are numbers in the plan's units, or expressions with units or
// #variables ("40 mm", "#side - 2 * #wall"), so the Onshape model stays parametric.

export type PlanUnits = 'mm' | 'in'
/** A length: a number in the plan's units, or an expression ("40 mm", "1.5 in", "#side / 2"). */
export type Len = number | string
export type Plane = 'Top' | 'Front' | 'Right'

export interface PlanVariable { name: string; value: Len; type?: 'LENGTH' | 'ANGLE' | 'NUMBER'; description?: string }

export type SketchShape =
  | { kind: 'rect'; id?: string; x?: number; y?: number; w: number; h: number; centered?: boolean; construction?: boolean }
  | { kind: 'circle'; id?: string; x?: number; y?: number; r: number; construction?: boolean }
  | { kind: 'line'; id?: string; x1: number; y1: number; x2: number; y2: number; construction?: boolean }
  | { kind: 'polygon'; id?: string; points: Array<[number, number]>; construction?: boolean }

/** A sketch dimension or relation between sketch entities (ids like "r1.top", "c1", "axis"). */
export interface SketchConstraint { type: string; first: string; second?: string; value?: Len }

/** Edges or faces of an earlier feature: all of them, or only the end/start cap (extrudes, revolves). */
export interface EntityRef { of?: string; cap?: 'start' | 'end'; all?: boolean }

export type PlanFeature =
  | { op: 'cube'; id: string; name?: string; side: Len }
  | { op: 'sketch'; id: string; name?: string; plane?: Plane; on?: EntityRef; shapes: SketchShape[]; constraints?: SketchConstraint[]; constrain?: boolean }
  | { op: 'extrude'; id: string; name?: string; sketch: string; depth: Len; operation?: 'new' | 'add' | 'remove' | 'intersect'; opposite?: boolean; through?: boolean }
  | { op: 'revolve'; id: string; name?: string; sketch: string; axis: string; angle?: string; operation?: 'new' | 'add' | 'remove' | 'intersect' }
  | { op: 'fillet'; id: string; name?: string; edges: EntityRef; radius: Len }
  | { op: 'chamfer'; id: string; name?: string; edges: EntityRef; width: Len }
  | { op: 'shell'; id: string; name?: string; faces: EntityRef; thickness: Len }
  | { op: 'hole'; id: string; name?: string; on: EntityRef | Plane; at: Array<[number, number]>; diameter: Len; depth?: Len }
  | { op: 'linear_pattern'; id: string; name?: string; of: string[]; direction: 'X' | 'Y' | 'Z'; distance: Len; count: number; opposite?: boolean }
  | { op: 'circular_pattern'; id: string; name?: string; of: string[]; axis: 'X' | 'Y' | 'Z' | { sketch: string; line: string }; count: number; angle?: string }
  | { op: 'mirror'; id: string; name?: string; of: string[]; plane: Plane }
  | { op: 'raw'; id: string; name?: string; feature: Record<string, unknown> }

export interface PlanInstance { id: string; part: string; count?: number; offset_mm?: [number, number, number] }
export interface PlanMate { type: 'FASTENED' | 'REVOLUTE' | 'SLIDER' | 'CYLINDRICAL' | 'PLANAR' | 'BALL' | 'PARALLEL' | 'PIN_SLOT'; a: { instance: string; face_of: string }; b: { instance: string; face_of: string }; name?: string }

/** What the finished model must measure; the verify step checks each one. */
export interface PlanExpect {
  bbox_mm?: [number, number, number]
  tolerance_mm?: number
  volume_mm3?: number
  volume_tolerance_pct?: number
  parts?: number
  /** Default true when there are two or more parts. */
  no_interference?: boolean
  min_clearance_mm?: number
}

export interface CadPlan {
  name: string
  units?: PlanUnits
  variables?: PlanVariable[]
  features: PlanFeature[]
  assembly?: { name?: string; instances: PlanInstance[]; mates?: PlanMate[] }
  expect?: PlanExpect
  /** Exports to make when the model is delivered. */
  exports?: Array<'STEP' | 'STL'>
}

export const UNIT_MM: Record<PlanUnits, number> = { mm: 1, in: 25.4 }
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// ---------------------------------------------------------------- expressions

const UNIT_TO_MM: Record<string, number> = { mm: 1, millimeter: 1, millimeters: 1, cm: 10, m: 1000, meter: 1000, meters: 1000, in: 25.4, inch: 25.4, inches: 25.4, ft: 304.8, foot: 304.8, feet: 304.8 }
const ANGLE_UNITS: Record<string, number> = { deg: 1, degree: 1, degrees: 1, rad: 180 / Math.PI, radian: 180 / Math.PI, radians: 180 / Math.PI }

/**
 * Evaluates a length or angle expression to mm (or degrees): numbers with units, #variables, + - * / and
 * parentheses. A bare number takes the default unit. Throws on anything else (no code is ever run).
 */
export function evalExpr(expr: Len, vars: Record<string, number>, defaultUnitMm = 1, angle = false): number {
  if (typeof expr === 'number') { if (!Number.isFinite(expr)) throw new Error('not a finite number'); return expr * (angle ? 1 : defaultUnitMm) }
  const s = String(expr).trim()
  if (!s) throw new Error('is empty')
  if (s.length > 300) throw new Error('is longer than 300 characters')
  const toks = s.match(/#?[A-Za-z_][A-Za-z0-9_]*|\d*\.?\d+(?:[eE][-+]?\d+)?|[-+*/()]|\S/g) ?? []
  let i = 0
  const peek = (): string | undefined => toks[i]
  const units = angle ? ANGLE_UNITS : UNIT_TO_MM
  const prim = (): number => {
    const t = toks[i++]
    if (t === undefined) throw new Error('ends too early')
    if (t === '(') { const v = sum(); if (toks[i++] !== ')') throw new Error('has an unclosed "("'); return v }
    if (t === '-') return -prim()
    if (t === '+') return prim()
    if (t.startsWith('#')) {
      const n = t.slice(1)
      if (!(n in vars)) throw new Error(`uses #${n}, which isn't a variable of this plan`)
      return vars[n]
    }
    if (/^\d|^\./.test(t)) {
      const n = Number(t)
      const u = peek()
      if (u && u.toLowerCase() in units) { i++; return n * units[u.toLowerCase()] }
      return n * (angle ? 1 : defaultUnitMm)
    }
    throw new Error(`has "${t.slice(0, 20)}", which isn't a number, unit or #variable`)
  }
  const prod = (): number => {
    let v = prim()
    while (peek() === '*' || peek() === '/') {
      const op = toks[i++]
      const r = prim()
      if (op === '/' && r === 0) throw new Error('divides by zero')
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  const sum = (): number => {
    let v = prod()
    while (peek() === '+' || peek() === '-') { const op = toks[i++]; const r = prod(); v = op === '+' ? v + r : v - r }
    return v
  }
  const v = sum()
  if (i < toks.length) throw new Error(`has something unexpected after "${toks.slice(0, i).join(' ')}"`)
  if (!Number.isFinite(v)) throw new Error('is not a finite number')
  return v
}

/** An Onshape expression for a length: numbers get the plan's unit; expressions pass through. */
export function lenExpr(v: Len, units: PlanUnits): string {
  if (typeof v === 'number') return `${Number(v.toFixed(6))} ${units}`
  return String(v).trim()
}

/** Variable values in mm (lengths) or plain numbers/degrees, in order (later ones may use earlier ones). */
export function variableValues(plan: Pick<CadPlan, 'variables' | 'units'>): Record<string, number> {
  const out: Record<string, number> = {}
  const unit = UNIT_MM[plan.units ?? 'mm']
  for (const v of plan.variables ?? []) {
    const t = v.type ?? 'LENGTH'
    out[v.name] = evalExpr(v.value, out, t === 'LENGTH' ? unit : 1, t === 'ANGLE')
  }
  return out
}

// ---------------------------------------------------------------- checks

const OPS = new Set(['cube', 'sketch', 'extrude', 'revolve', 'fillet', 'chamfer', 'shell', 'hole', 'linear_pattern', 'circular_pattern', 'mirror', 'raw'])

/** Problems with a plan, in plain words (empty = it can be built). */
export function planProblems(plan: CadPlan): string[] {
  const errs: string[] = []
  if (!plan || typeof plan !== 'object') return ['plan must be an object.']
  if (!String(plan.name ?? '').trim()) errs.push('plan.name is required (the document / part name).')
  if (plan.units && !(plan.units in UNIT_MM)) errs.push('plan.units must be "mm" or "in".')
  if (!Array.isArray(plan.features) || !plan.features.length) errs.push('plan.features needs at least one feature.')
  if ((plan.features?.length ?? 0) > 80) errs.push('plan.features has more than 80 features; split the model into several part studios.')
  const unit = UNIT_MM[plan.units ?? 'mm'] ?? 1
  let vars: Record<string, number> = {}
  const seenVars = new Set<string>()
  for (const v of plan.variables ?? []) {
    if (!VAR_RE.test(String(v.name ?? ''))) { errs.push(`Variable "${String(v.name).slice(0, 30)}" needs a name of letters, digits and underscores.`); continue }
    if (seenVars.has(v.name)) errs.push(`Variable #${v.name} is listed twice.`)
    seenVars.add(v.name)
  }
  try { vars = variableValues(plan) } catch (e) { errs.push(`A variable ${(e as Error).message}.`) }
  const ids = new Map<string, PlanFeature>()
  const len = (what: string, v: Len | undefined, positive = true): void => {
    if (v === undefined) { errs.push(`${what} is required.`); return }
    try {
      const mm = evalExpr(v, vars, unit)
      if (positive && !(mm > 0)) errs.push(`${what} must be more than zero (got ${Number(mm.toFixed(4))} mm).`)
      if (mm > 100_000) errs.push(`${what} is over 100 m; check the units.`)
    } catch (e) { errs.push(`${what} ${(e as Error).message}.`) }
  }
  const ref = (what: string, id: string | undefined, ops?: string[]): void => {
    if (!id) { errs.push(`${what} must name an earlier feature id.`); return }
    const f = ids.get(id)
    if (!f) errs.push(`${what} names "${id}", which isn't an earlier feature (features build in order).`)
    else if (ops && !ops.includes(f.op)) errs.push(`${what} names "${id}", a ${f.op}; it needs a ${ops.join(' or ')}.`)
  }
  for (const [n, f] of (plan.features ?? []).entries()) {
    const at = `Feature ${n + 1}${f && (f as { id?: string }).id ? ` ("${(f as { id: string }).id}")` : ''}`
    if (!f || typeof f !== 'object' || !OPS.has((f as { op: string }).op)) { errs.push(`${at}: op must be one of ${[...OPS].join(', ')}.`); continue }
    if (!ID_RE.test(String(f.id ?? ''))) errs.push(`${at}: id must start with a letter (letters, digits, - and _; up to 40).`)
    else if (ids.has(f.id)) errs.push(`${at}: id "${f.id}" is used twice.`)
    switch (f.op) {
      case 'cube': len(`${at} side`, f.side); break
      case 'sketch': {
        if (!Array.isArray(f.shapes) || !f.shapes.length) errs.push(`${at}: a sketch needs shapes (rect, circle, line, polygon).`)
        if (f.plane && !['Top', 'Front', 'Right'].includes(f.plane)) errs.push(`${at}: plane must be Top, Front or Right.`)
        if (f.on) ref(`${at} on`, f.on.of)
        for (const s of f.shapes ?? []) {
          if (s.kind === 'rect' && !(s.w > 0 && s.h > 0)) errs.push(`${at}: a rect needs w and h above zero.`)
          else if (s.kind === 'circle' && !(s.r > 0)) errs.push(`${at}: a circle needs r above zero.`)
          else if (s.kind === 'polygon' && (!Array.isArray(s.points) || s.points.length < 3)) errs.push(`${at}: a polygon needs 3 or more points.`)
          else if (!['rect', 'circle', 'line', 'polygon'].includes(s.kind)) errs.push(`${at}: shape kind must be rect, circle, line or polygon.`)
        }
        for (const c of f.constraints ?? []) if (!c || !c.type || !c.first) errs.push(`${at}: each constraint needs type and first.`)
        break
      }
      case 'extrude': ref(`${at} sketch`, f.sketch, ['sketch']); if (!f.through) len(`${at} depth`, f.depth); break
      case 'revolve': ref(`${at} sketch`, f.sketch, ['sketch']); if (!f.axis) errs.push(`${at}: axis must name a line id in the sketch.`); break
      case 'fillet': if (f.edges?.of) ref(`${at} edges.of`, f.edges.of); len(`${at} radius`, f.radius); break
      case 'chamfer': if (f.edges?.of) ref(`${at} edges.of`, f.edges.of); len(`${at} width`, f.width); break
      case 'shell': ref(`${at} faces.of`, f.faces?.of); len(`${at} thickness`, f.thickness); break
      case 'hole':
        if (typeof f.on !== 'string') ref(`${at} on.of`, f.on?.of)
        if (!Array.isArray(f.at) || !f.at.length) errs.push(`${at}: at needs one or more [x, y] hole centers.`)
        len(`${at} diameter`, f.diameter)
        if (f.depth !== undefined) len(`${at} depth`, f.depth)
        break
      case 'linear_pattern': case 'circular_pattern': case 'mirror':
        if (!Array.isArray(f.of) || !f.of.length) errs.push(`${at}: of must list the feature ids whose bodies to copy.`)
        for (const x of f.of ?? []) ref(`${at} of`, x)
        if (f.op !== 'mirror' && !(Number.isInteger(f.count) && f.count >= 2 && f.count <= 500)) errs.push(`${at}: count must be a whole number from 2 to 500 (including the original).`)
        if (f.op === 'linear_pattern') len(`${at} distance`, f.distance)
        if (f.op === 'mirror' && !['Top', 'Front', 'Right'].includes(f.plane)) errs.push(`${at}: plane must be Top, Front or Right.`)
        break
      case 'raw': if (!f.feature || typeof f.feature !== 'object') errs.push(`${at}: raw needs feature (BTMFeature-134 JSON).`); break
    }
    if (ID_RE.test(String(f.id ?? ''))) ids.set(f.id, f)
  }
  if (plan.assembly) {
    const inst = new Set<string>()
    for (const i of plan.assembly.instances ?? []) {
      if (!ID_RE.test(String(i.id ?? ''))) errs.push('Each assembly instance needs an id.')
      inst.add(i.id)
      if (!i.part) errs.push(`Instance "${i.id}" needs part (a part name, or a feature id whose body it is).`)
    }
    for (const m of plan.assembly.mates ?? []) {
      for (const side of [m.a, m.b]) {
        if (!side || !inst.has(side.instance)) errs.push(`Mate ${m.name ?? m.type}: instance "${side?.instance}" isn't in assembly.instances.`)
        else ref(`Mate ${m.name ?? m.type} face_of`, side.face_of)
      }
    }
  }
  const e = plan.expect
  if (e?.bbox_mm && (!Array.isArray(e.bbox_mm) || e.bbox_mm.length !== 3 || e.bbox_mm.some((x) => !(x > 0)))) errs.push('expect.bbox_mm must be [x, y, z] in mm, each above zero.')
  return errs
}

/** One line per feature, for previews and summaries. */
export function featureLine(f: PlanFeature, units: PlanUnits): string {
  const L = (v: Len): string => lenExpr(v, units)
  switch (f.op) {
    case 'cube': return `cube ${L(f.side)}`
    case 'sketch': return `sketch on ${f.on ? `${f.on.cap ?? 'a'} face of ${f.on.of}` : f.plane ?? 'Top'}: ${f.shapes.map((s) => s.kind === 'rect' ? `rect ${s.w}×${s.h}` : s.kind === 'circle' ? `circle r${s.r}` : s.kind === 'line' ? 'line' : `polygon(${s.points.length})`).join(', ')}${f.constraints?.length ? `, ${f.constraints.length} constraint${f.constraints.length === 1 ? '' : 's'}` : ''}`
    case 'extrude': return `extrude ${f.sketch} ${f.through ? 'through all' : L(f.depth)} (${f.operation ?? 'new'})`
    case 'revolve': return `revolve ${f.sketch} about ${f.axis} ${f.angle ?? '360 deg'}`
    case 'fillet': return `fillet r${L(f.radius)} on ${f.edges?.of ? `${f.edges.cap ? `${f.edges.cap} cap ` : ''}edges of ${f.edges.of}` : 'all edges'}`
    case 'chamfer': return `chamfer ${L(f.width)} on ${f.edges?.of ? `edges of ${f.edges.of}` : 'all edges'}`
    case 'shell': return `shell ${L(f.thickness)} removing the ${f.faces.cap ?? 'end'} face of ${f.faces.of}`
    case 'hole': return `${f.at.length} hole${f.at.length === 1 ? '' : 's'} ⌀${L(f.diameter)} ${f.depth !== undefined ? L(f.depth) : 'through'}`
    case 'linear_pattern': return `linear pattern ×${f.count} along ${f.direction}, ${L(f.distance)} apart`
    case 'circular_pattern': return `circular pattern ×${f.count}`
    case 'mirror': return `mirror about ${f.plane}`
    case 'raw': return `raw ${String((f.feature as { featureType?: string }).featureType ?? 'feature')}`
  }
}
