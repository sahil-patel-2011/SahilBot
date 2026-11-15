import { lenExpr, UNIT_MM, type CadPlan, type EntityRef, type Len, type PlanFeature, type PlanUnits, type PlanVariable, type SketchConstraint, type SketchShape } from './plan'

// Plan features → Onshape feature JSON (BTMFeature-134 / BTMSketch-151), the shapes Onshape documents at
// https://onshape-public.github.io/docs/api-adv/featureaccess/ (feature, parameter and query types; the
// cube, sketch and extrude examples). Feature parameter ids follow the FeatureScript standard library
// (https://cad.onshape.com/FsDoc/library.html: extrude, linearPattern, circularPattern, assignVariable,
// opFillet, opChamfer, opShell…), and before anything is sent they are checked against the Part Studio's
// own feature specs (GET …/featurespecs), which also supply each enum's enumName and allowed values. A
// parameter the spec doesn't have is a clear error instead of a silently ignored value.
//
// Queries are FeatureScript query strings ("query=qCreatedBy(makeId(\"Top\"), EntityType.FACE);", the
// documented form), so features refer to earlier ones by featureId and stay valid when dimensions change.

export type ParamValue =
  | { quantity: string; integer?: boolean }
  | { enum: string }
  | { bool: boolean }
  | { queries: string[] }
  | { regions: string }
  | { str: string }

export interface DraftParam { id: string; aliases?: string[]; value: ParamValue; optional?: boolean }

export interface FeatureDraft {
  /** The plan feature this came from (a hole becomes a sketch plus a cut, both with the hole's id). */
  planId: string
  featureType: string
  name: string
  params: DraftParam[]
  sketch?: { entities: Array<Record<string, unknown>>; constraints: Array<Record<string, unknown>> }
  raw?: Record<string, unknown>
}

/** Enum names the docs give, used only when the Part Studio's feature specs couldn't be read. */
const FALLBACK_ENUMS: Record<string, string> = {
  'extrude.bodyType': 'ExtendedToolBodyType', 'extrude.operationType': 'NewBodyOperationType', 'extrude.endBound': 'BoundingType',
  'revolve.bodyType': 'ExtendedToolBodyType', 'revolve.operationType': 'NewBodyOperationType',
  'linearPattern.patternType': 'PatternType', 'circularPattern.patternType': 'PatternType', 'mirror.patternType': 'MirrorType',
  'chamfer.chamferType': 'ChamferType', 'assignVariable.variableType': 'VariableType'
}

const ENTITY = { edges: 'EntityType.EDGE', faces: 'EntityType.FACE', bodies: 'EntityType.BODY' } as const

const q = (s: string): string => JSON.stringify(s)
/** FeatureScript query string in the documented BTMIndividualQuery-138 form. */
export const queryString = (expr: string): string => `query=${expr};`
export const planeQuery = (p: 'Top' | 'Front' | 'Right'): string => `qCreatedBy(makeId(${q(p)}), EntityType.FACE)`

/** A query for the edges, faces or bodies of an earlier feature (all of them, or one cap). */
export function refQuery(r: EntityRef | undefined, kind: keyof typeof ENTITY, fid: (planId: string) => string): string {
  if (!r?.of) return kind === 'bodies' ? 'qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)' : `qBodyType(qEverything(${ENTITY[kind]}), BodyType.SOLID)`
  const id = `makeId(${q(fid(r.of))})`
  if (r.cap && kind !== 'bodies') return `qCapEntity(${id}, CapType.${r.cap === 'start' ? 'START' : 'END'}, ${ENTITY[kind]})`
  return `qCreatedBy(${id}, ${ENTITY[kind]})`
}

// ---------------------------------------------------------------- sketches

const round = (x: number): number => Number(x.toFixed(9))

/** Sketch entities and constraints for one shape, in meters (Onshape's sketch geometry units). */
export function shapeEntities(s: SketchShape, n: number, units: PlanUnits, constrain: boolean): { entities: Array<Record<string, unknown>>; constraints: Array<Record<string, unknown>>; ids: string[] } {
  const m = UNIT_MM[units] / 1000
  const id = s.id || `${s.kind}${n + 1}`
  const construction = !!s.construction
  const line = (eid: string, x1: number, y1: number, x2: number, y2: number): Record<string, unknown> => {
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy)
    return {
      btType: 'BTMSketchCurveSegment-155', entityId: eid, startPointId: `${eid}.start`, endPointId: `${eid}.end`, isConstruction: construction,
      startParam: 0, endParam: round(L * m),
      geometry: { btType: 'BTCurveGeometryLine-117', pntX: round(x1 * m), pntY: round(y1 * m), dirX: round(dx / L), dirY: round(dy / L) }
    }
  }
  const closed = (pts: Array<[number, number]>, names: string[]): { entities: Array<Record<string, unknown>>; constraints: Array<Record<string, unknown>> } => {
    const entities = pts.map((p, i) => line(names[i], p[0], p[1], pts[(i + 1) % pts.length][0], pts[(i + 1) % pts.length][1]))
    const constraints = constrain ? names.map((a, i) => constraint('COINCIDENT', `${id}.cc${i}`, `${a}.end`, `${names[(i + 1) % names.length]}.start`)) : []
    return { entities, constraints }
  }
  if (s.kind === 'circle') {
    return { ids: [id], constraints: [], entities: [{ btType: 'BTMSketchCurve-4', entityId: id, centerId: `${id}.center`, isConstruction: construction, geometry: { btType: 'BTCurveGeometryCircle-115', radius: round(s.r * m), xCenter: round((s.x ?? 0) * m), yCenter: round((s.y ?? 0) * m), xDir: 1, yDir: 0, clockwise: false } }] }
  }
  if (s.kind === 'line') return { ids: [id], constraints: [], entities: [line(id, s.x1, s.y1, s.x2, s.y2)] }
  if (s.kind === 'rect') {
    const x0 = s.centered === false ? s.x ?? 0 : (s.x ?? 0) - s.w / 2
    const y0 = s.centered === false ? s.y ?? 0 : (s.y ?? 0) - s.h / 2
    const names = ['bottom', 'right', 'top', 'left'].map((k) => `${id}.${k}`)
    const r = closed([[x0, y0], [x0 + s.w, y0], [x0 + s.w, y0 + s.h], [x0, y0 + s.h]], names)
    if (constrain) r.constraints.push(constraint('HORIZONTAL', `${id}.h1`, names[0]), constraint('HORIZONTAL', `${id}.h2`, names[2]), constraint('VERTICAL', `${id}.v1`, names[1]), constraint('VERTICAL', `${id}.v2`, names[3]))
    return { ids: names, ...r }
  }
  const names = s.points.map((_, i) => `${id}.e${i + 1}`)
  return { ids: names, ...closed(s.points, names) }
}

/** A sketch constraint (BTMSketchConstraint-2) between sketch entity ids, with an optional dimension. */
export function constraint(type: string, entityId: string, first: string, second?: string, value?: { length?: string; angle?: string }): Record<string, unknown> {
  const parameters: Array<Record<string, unknown>> = [{ btType: 'BTMParameterString-149', parameterId: 'localFirst', value: first }]
  if (second) parameters.push({ btType: 'BTMParameterString-149', parameterId: 'localSecond', value: second })
  if (value?.length) parameters.push({ btType: 'BTMParameterQuantity-147', parameterId: 'length', expression: value.length, isInteger: false })
  if (value?.angle) parameters.push({ btType: 'BTMParameterQuantity-147', parameterId: 'angle', expression: value.angle, isInteger: false })
  return { btType: 'BTMSketchConstraint-2', constraintType: type, entityId, parameters }
}

/** Sketch constraint types Onshape accepts (GBTConstraintType in the REST API's OpenAPI spec). */
export const CONSTRAINT_TYPES = new Set(['COINCIDENT', 'PARALLEL', 'VERTICAL', 'HORIZONTAL', 'PERPENDICULAR', 'CONCENTRIC', 'MIRROR', 'MIDPOINT', 'TANGENT', 'EQUAL', 'LENGTH', 'DISTANCE', 'ANGLE', 'RADIUS', 'NORMAL', 'FIX', 'DIAMETER'])

function planConstraints(list: SketchConstraint[] | undefined, units: PlanUnits, sketchId: string): { constraints: Array<Record<string, unknown>>; problems: string[] } {
  const problems: string[] = []
  const constraints = (list ?? []).map((c, i) => {
    const type = String(c.type ?? '').toUpperCase()
    if (!CONSTRAINT_TYPES.has(type)) problems.push(`sketch ${sketchId}: constraint type "${String(c.type).slice(0, 30)}" isn't one Onshape has (${[...CONSTRAINT_TYPES].join(', ')}).`)
    const value = c.value === undefined ? undefined : type === 'ANGLE' ? { angle: typeof c.value === 'number' ? `${c.value} deg` : String(c.value) } : { length: lenExpr(c.value, units) }
    return constraint(type, `${sketchId}.k${i + 1}`, c.first, c.second, value)
  })
  return { constraints, problems }
}

// ---------------------------------------------------------------- drafts

export interface DraftContext {
  units: PlanUnits
  /** The Onshape featureId of an earlier plan feature (placeholders like "<sketch1>" in previews). */
  fid: (planId: string) => string
}

const opType = (o: string | undefined): string => ({ new: 'NEW', add: 'ADD', remove: 'REMOVE', intersect: 'INTERSECT' } as Record<string, string>)[o ?? 'new'] ?? 'NEW'

/** Variable features (assignVariable) for the plan's variables: they go first in the Part Studio. */
export function variableDrafts(vars: PlanVariable[] | undefined, units: PlanUnits): FeatureDraft[] {
  return (vars ?? []).map((v) => {
    const type = v.type ?? 'LENGTH'
    const value = type === 'LENGTH' ? lenExpr(v.value, units) : type === 'ANGLE' ? (typeof v.value === 'number' ? `${v.value} deg` : String(v.value)) : String(v.value)
    const valueParam = type === 'LENGTH' ? 'lengthValue' : type === 'ANGLE' ? 'angleValue' : 'numberValue'
    const params: DraftParam[] = [
      { id: 'name', value: { str: v.name } },
      { id: 'variableType', value: { enum: type } },
      { id: valueParam, value: { quantity: value } }
    ]
    if (v.description) params.push({ id: 'description', value: { str: v.description.slice(0, 256) }, optional: true })
    return { planId: `var:${v.name}`, featureType: 'assignVariable', name: `#${v.name}`, params }
  })
}

/** The Onshape feature drafts for one plan feature (usually one; a hole is a sketch plus a cut). */
export function draftsFor(f: PlanFeature, c: DraftContext): { drafts: FeatureDraft[]; problems: string[] } {
  const L = (v: Len): string => lenExpr(v, c.units)
  const name = (fallback: string): string => (f.name ?? fallback).slice(0, 100)
  const regions = (sketch: string): DraftParam => ({ id: 'entities', value: { regions: c.fid(sketch) } })
  switch (f.op) {
    case 'cube':
      return { problems: [], drafts: [{ planId: f.id, featureType: 'cube', name: name('Cube'), params: [{ id: 'sideLength', value: { quantity: L(f.side) } }] }] }
    case 'sketch': {
      const parts = f.shapes.map((s, i) => shapeEntities(s, i, c.units, f.constrain === true))
      const pc = planConstraints(f.constraints, c.units, f.id)
      const plane = f.on ? refQuery({ ...f.on, cap: f.on.cap ?? 'end' }, 'faces', c.fid) : planeQuery(f.plane ?? 'Top')
      return { problems: pc.problems, drafts: [{ planId: f.id, featureType: 'newSketch', name: name('Sketch'), params: [{ id: 'sketchPlane', value: { queries: [plane] } }], sketch: { entities: parts.flatMap((p) => p.entities), constraints: [...parts.flatMap((p) => p.constraints), ...pc.constraints] } }] }
    }
    case 'extrude': {
      const params: DraftParam[] = [
        { id: 'bodyType', value: { enum: 'SOLID' } },
        { id: 'operationType', value: { enum: opType(f.operation) } },
        regions(f.sketch),
        { id: 'endBound', value: { enum: f.through ? 'THROUGH_ALL' : 'BLIND' } }
      ]
      if (!f.through) params.push({ id: 'depth', value: { quantity: L(f.depth) } })
      if (f.opposite) params.push({ id: 'oppositeDirection', value: { bool: true } })
      return { problems: [], drafts: [{ planId: f.id, featureType: 'extrude', name: name('Extrude'), params }] }
    }
    case 'revolve': {
      const params: DraftParam[] = [
        { id: 'bodyType', value: { enum: 'SOLID' } },
        { id: 'operationType', value: { enum: opType(f.operation) } },
        regions(f.sketch),
        { id: 'axis', value: { queries: [`sketchEntityQuery(makeId(${q(c.fid(f.sketch))}), EntityType.EDGE, ${q(f.axis)})`] } }
      ]
      if (f.angle && !/^\s*360(\.0*)?\s*(deg|degree|degrees)?\s*$/i.test(f.angle)) params.push({ id: 'revolveType', value: { enum: 'ONE_DIRECTION' } }, { id: 'angle', value: { quantity: f.angle } })
      else params.push({ id: 'revolveType', value: { enum: 'FULL' } })
      return { problems: [], drafts: [{ planId: f.id, featureType: 'revolve', name: name('Revolve'), params }] }
    }
    case 'fillet':
      return { problems: [], drafts: [{ planId: f.id, featureType: 'fillet', name: name('Fillet'), params: [{ id: 'entities', value: { queries: [refQuery(f.edges, 'edges', c.fid)] } }, { id: 'radius', value: { quantity: L(f.radius) } }] }] }
    case 'chamfer':
      return { problems: [], drafts: [{ planId: f.id, featureType: 'chamfer', name: name('Chamfer'), params: [{ id: 'entities', value: { queries: [refQuery(f.edges, 'edges', c.fid)] } }, { id: 'chamferType', value: { enum: 'EQUAL_OFFSETS' }, optional: true }, { id: 'width', value: { quantity: L(f.width) } }] }] }
    case 'shell':
      return { problems: [], drafts: [{ planId: f.id, featureType: 'shell', name: name('Shell'), params: [{ id: 'entities', value: { queries: [refQuery({ ...f.faces, cap: f.faces.cap ?? 'end' }, 'faces', c.fid)] } }, { id: 'thickness', value: { quantity: L(f.thickness) } }] }] }
    case 'hole': {
      // A hole is a sketch of circles on the face (or plane) and a cut through or to a depth: the plain,
      // documented sketch + extrude features (the Hole feature's many standard-specific options aren't needed).
      const sketchId = `${f.id}_sketch`
      const d = typeof f.diameter === 'number' ? f.diameter : NaN
      const r = Number.isFinite(d) ? d / 2 : NaN
      if (!Number.isFinite(r)) return { problems: [`hole ${f.id}: give diameter as a number (in the plan's units) so the circles can be drawn.`], drafts: [] }
      const sketch = draftsFor({ op: 'sketch', id: sketchId, name: `${name('Hole')} sketch`, ...(typeof f.on === 'string' ? { plane: f.on } : { on: f.on }), shapes: f.at.map(([x, y], i) => ({ kind: 'circle' as const, id: `${f.id}_c${i + 1}`, x, y, r })) }, c)
      const cutParams: DraftParam[] = [
        { id: 'bodyType', value: { enum: 'SOLID' } }, { id: 'operationType', value: { enum: 'REMOVE' } }, { id: 'entities', value: { regions: c.fid(sketchId) } },
        { id: 'endBound', value: { enum: f.depth === undefined ? 'THROUGH_ALL' : 'BLIND' } },
        // A hole sketched on a face goes into it (against the face's outward normal); on a plane it goes along the normal.
        ...(typeof f.on !== 'string' ? [{ id: 'oppositeDirection', value: { bool: true } }] : [])
      ]
      if (f.depth !== undefined) cutParams.push({ id: 'depth', value: { quantity: L(f.depth) } })
      return { problems: sketch.problems, drafts: [...sketch.drafts, { planId: f.id, featureType: 'extrude', name: name('Hole'), params: cutParams }] }
    }
    case 'linear_pattern':
      return {
        problems: [], drafts: [{
          planId: f.id, featureType: 'linearPattern', name: name('Linear pattern'), params: [
            { id: 'patternType', value: { enum: 'PART' } },
            { id: 'entities', value: { queries: f.of.map((x) => refQuery({ of: x }, 'bodies', c.fid)) } },
            { id: 'directionOne', value: { queries: [axisQuery(f.direction, c)] } },
            { id: 'distance', value: { quantity: L(f.distance) } },
            { id: 'instanceCount', value: { quantity: String(f.count), integer: true } },
            ...(f.opposite ? [{ id: 'oppositeDirection', value: { bool: true } }] : [])
          ]
        }]
      }
    case 'circular_pattern': {
      const axis = typeof f.axis === 'string' ? axisQuery(f.axis, c) : `sketchEntityQuery(makeId(${q(c.fid(f.axis.sketch))}), EntityType.EDGE, ${q(f.axis.line)})`
      return {
        problems: [], drafts: [{
          planId: f.id, featureType: 'circularPattern', name: name('Circular pattern'), params: [
            { id: 'patternType', value: { enum: 'PART' } },
            { id: 'entities', value: { queries: f.of.map((x) => refQuery({ of: x }, 'bodies', c.fid)) } },
            { id: 'axis', value: { queries: [axis] } },
            { id: 'angle', value: { quantity: f.angle ?? '360 deg' } },
            { id: 'instanceCount', value: { quantity: String(f.count), integer: true } },
            { id: 'equalSpace', value: { bool: true } }
          ]
        }]
      }
    }
    case 'mirror':
      return {
        problems: [], drafts: [{
          planId: f.id, featureType: 'mirror', name: name('Mirror'), params: [
            { id: 'patternType', value: { enum: 'PART' } },
            { id: 'entities', value: { queries: f.of.map((x) => refQuery({ of: x }, 'bodies', c.fid)) } },
            { id: 'mirrorPlane', aliases: ['plane', 'mirrorPlaneQuery'], value: { queries: [planeQuery(f.plane)] } }
          ]
        }]
      }
    case 'raw':
      return { problems: [], drafts: [{ planId: f.id, featureType: String(f.feature.featureType ?? ''), name: String(f.feature.name ?? f.name ?? 'Feature'), params: [], raw: f.feature }] }
  }
}

/** The edge of the axis sketch for X, Y or Z (withAxisSketches adds it), pointing along +X, +Y or +Z. */
const axisQuery = (a: 'X' | 'Y' | 'Z', c: DraftContext): string => `sketchEntityQuery(makeId(${q(c.fid(`axis_${a}`))}), EntityType.EDGE, ${q(`axis_${a}`)})`

/**
 * Patterns along or about X, Y or Z need an edge to select: a sketch with one line through the origin along
 * +X, +Y or +Z, added before the first pattern that uses it (on Top for X and Y, on Front for Z, whose
 * sketch y direction is +Z). An edge has a direction, so "along Y" is +Y, not a plane normal's sign.
 */
export function withAxisSketches(plan: Pick<CadPlan, 'features'>): PlanFeature[] {
  const out: PlanFeature[] = []
  const added = new Set<string>()
  for (const f of plan.features) {
    const axis = f.op === 'circular_pattern' && typeof f.axis === 'string' ? f.axis : f.op === 'linear_pattern' ? f.direction : undefined
    if (axis && !added.has(axis)) {
      added.add(axis)
      const id = `axis_${axis}`
      const line = axis === 'X' ? { x1: 0, y1: 0, x2: 10, y2: 0 } : { x1: 0, y1: 0, x2: 0, y2: 10 }
      out.push({ op: 'sketch', id, name: `${axis} axis`, plane: axis === 'Z' ? 'Front' : 'Top', shapes: [{ kind: 'line', id, ...line }] })
    }
    out.push(f)
  }
  return out
}

// ---------------------------------------------------------------- feature specs

export interface SpecParam { id: string; btType: string; enumName?: string; namespace?: string; options?: string[] }
export type SpecIndex = Map<string, Map<string, SpecParam>>

/** The Part Studio's feature specs (BTFeatureSpecsResponse-664) by featureType → parameterId. */
export function specIndex(body: unknown): SpecIndex {
  const out: SpecIndex = new Map()
  const specs = ((body as { featureSpecs?: unknown[] } | undefined)?.featureSpecs ?? []) as Array<Record<string, any>>
  for (const s of specs) {
    const type = String(s.featureType ?? '')
    if (!type) continue
    const params = new Map<string, SpecParam>()
    for (const p of [...(s.parameters ?? []), ...(s.allParameters ?? [])] as Array<Record<string, any>>) {
      if (typeof p.parameterId !== 'string' || params.has(p.parameterId)) continue
      params.set(p.parameterId, { id: p.parameterId, btType: String(p.btType ?? ''), enumName: p.enumName, namespace: p.namespace, options: Array.isArray(p.options) ? p.options.map(String) : undefined })
    }
    out.set(type, params)
  }
  return out
}

const KIND_OF_SPEC: Array<[RegExp, Array<keyof ParamValueKinds>]> = [
  [/Enum/, ['enum']], [/Quantity|Number|Integer|Real/, ['quantity']], [/Query/, ['queries', 'regions']], [/Boolean/, ['bool']], [/String/, ['str']]
]
type ParamValueKinds = { quantity: 1; enum: 1; bool: 1; queries: 1; regions: 1; str: 1 }
const kindOf = (v: ParamValue): keyof ParamValueKinds => Object.keys(v).find((k) => k !== 'integer') as keyof ParamValueKinds

/**
 * A draft as the JSON Onshape takes, checked against the feature specs when they are known: every parameter
 * id must exist (aliases are tried in order), enum values must be among the options, and kinds must match.
 */
export function materialize(d: FeatureDraft, specs?: SpecIndex): { feature: Record<string, unknown>; problems: string[] } {
  if (d.raw) return { feature: d.raw, problems: [] }
  const problems: string[] = []
  const spec = specs?.get(d.featureType)
  if (specs && specs.size && !spec) problems.push(`${d.name}: this Part Studio has no "${d.featureType}" feature.`)
  const parameters: Array<Record<string, unknown>> = []
  for (const p of d.params) {
    const id = spec ? [p.id, ...(p.aliases ?? [])].find((x) => spec.has(x)) : p.id
    if (!id) {
      if (!p.optional) problems.push(`${d.name}: the ${d.featureType} feature has no "${p.id}" parameter. It has: ${[...spec!.keys()].slice(0, 40).join(', ')}.`)
      continue
    }
    const sp = spec?.get(id)
    const kind = kindOf(p.value)
    if (sp?.btType) {
      const allowed = KIND_OF_SPEC.find(([re]) => re.test(sp.btType))?.[1]
      if (allowed && !allowed.includes(kind)) { problems.push(`${d.name}: parameter "${id}" is a ${sp.btType.replace(/^BTParameterSpec|-\d+$/g, '').toLowerCase()} in Onshape, not a ${kind}.`); continue }
    }
    const v = p.value
    if ('quantity' in v) parameters.push({ btType: 'BTMParameterQuantity-147', parameterId: id, expression: v.quantity, isInteger: !!v.integer })
    else if ('enum' in v) {
      if (sp?.options?.length && !sp.options.includes(v.enum)) {
        if (!p.optional) problems.push(`${d.name}: "${v.enum}" isn't an option of ${id} (options: ${sp.options.join(', ')}).`)
        continue
      }
      const enumName = sp?.enumName ?? FALLBACK_ENUMS[`${d.featureType}.${id}`]
      const e: Record<string, unknown> = { btType: 'BTMParameterEnum-145', parameterId: id, value: v.enum }
      if (enumName) e.enumName = enumName
      if (sp?.namespace !== undefined) e.namespace = sp.namespace
      parameters.push(e)
    } else if ('bool' in v) parameters.push({ btType: 'BTMParameterBoolean-144', parameterId: id, value: v.bool })
    else if ('str' in v) parameters.push({ btType: 'BTMParameterString-149', parameterId: id, value: v.str })
    // filterInnerLoops: a region inside another (a circle inside a rectangle) is left out, so it stays a hole.
    else if ('regions' in v) parameters.push({ btType: 'BTMParameterQueryList-148', parameterId: id, queries: [{ btType: 'BTMIndividualSketchRegionQuery-140', featureId: v.regions, filterInnerLoops: true }] })
    else parameters.push({ btType: 'BTMParameterQueryList-148', parameterId: id, queries: v.queries.map((s) => ({ btType: 'BTMIndividualQuery-138', queryString: queryString(s) })) })
  }
  if (d.sketch) return { problems, feature: { btType: 'BTMSketch-151', featureType: 'newSketch', name: d.name, parameters, entities: d.sketch.entities, constraints: d.sketch.constraints } }
  return { problems, feature: { btType: 'BTMFeature-134', featureType: d.featureType, name: d.name, parameters } }
}

/** The add-feature request body (documented BTFeatureDefinitionCall-1406 wrapper). */
export const addFeatureBody = (feature: Record<string, unknown>): Record<string, unknown> => ({ btType: 'BTFeatureDefinitionCall-1406', feature })
