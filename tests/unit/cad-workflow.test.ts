import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { cadSignals, CAD_RE, isCadBuildRequest } from '../../src/main/cad/cad-intent'
import { clearCreated, isCreatedDoc } from '../../src/main/cad/created'
import { cadDesignTool, type CadDesignArgs } from '../../src/main/cad/design-tool'
import { compileForFreecad, PY_BUILD, PY_BUILD_HEADER } from '../../src/main/cad/freecad-build'
import { wrapScript } from '../../src/main/cad/freecad'
import { buildOnshape, CLASH_SCRIPT, measureOnshape } from '../../src/main/cad/onshape-build'
import { OnshapeClient } from '../../src/main/cad/onshape-client'
import { draftsFor, materialize, refQuery, shapeEntities, specIndex, variableDrafts, withAxisSketches } from '../../src/main/cad/onshape-features'
import { evalExpr, planProblems, type CadPlan } from '../../src/main/cad/plan'
import { encodePng, wireframeImages, wireframePng } from '../../src/main/cad/wire-png'
import { briefGaps, checkModel, conceptProblems, conceptPrompt, conceptTable, formatPlan, phaseItems, pickBackend, PHASES } from '../../src/main/cad/workflow'
import { intentTools, likelyTools } from '../../src/main/agent/intent'
import { decide } from '../../src/main/agent/permissions'
import { onshapeConsequential, onshapeEffect, onshapeTool, type OnshapeArgs } from '../../src/main/agent/tools/onshape'
import { emptyState, type ToolContext, type ToolDef } from '../../src/main/agent/types'
import { FAKE_KEYS, FEATURE_SPECS, startFakeOnshape, type FakeOnshape } from '../fixtures/fake-onshape'

const CUBE: CadPlan = {
  name: 'Filleted cube', units: 'mm',
  variables: [{ name: 'side', value: 40 }, { name: 'r', value: '5 mm' }],
  features: [
    { op: 'cube', id: 'body', name: 'Cube', side: '#side' },
    { op: 'fillet', id: 'round', name: 'Edge fillet', edges: { of: 'body' }, radius: '#r' }
  ],
  expect: { bbox_mm: [40, 40, 40], tolerance_mm: 0.01, volume_mm3: 61592.18, volume_tolerance_pct: 0.5, parts: 1 },
  exports: ['STEP']
}

// ---------------------------------------------------------------- listening

describe('listening: CAD requests', () => {
  test('build requests are agent work at high effort; whole assemblies at xhigh; questions and look-alikes are not builds', () => {
    expect(cadSignals('build a 40 mm cube with a 5 mm fillet in CAD')).toEqual({ cad: true, build: true, assembly: false, effort: 'high' })
    expect(cadSignals('go build this inside of CAD')).toMatchObject({ build: true, effort: 'high' })
    expect(cadSignals('design a two-stage gearbox assembly in Onshape with mates')).toMatchObject({ build: true, assembly: true, effort: 'xhigh' })
    expect(cadSignals('model a NEMA 17 motor bracket for 3d printing')).toMatchObject({ build: true })
    expect(cadSignals('make an enclosure for a Raspberry Pi, export STL')).toMatchObject({ build: true })
    expect(cadSignals('What is a fillet?')).toMatchObject({ cad: true, build: false, effort: undefined })
    for (const t of ['write a shell script that renames files', 'fix the brackets in my JSON', 'what is the mechanism of action of ibuprofen', 'sketch out a plan for my essay', 'housing prices in Austin']) expect(cadSignals(t).cad, t).toBe(false)
    expect(isCadBuildRequest('can you model a hinge in FreeCAD')).toBe(true)
  })

  test('the CAD intent group loads cad_design and onshape (and freecad when installed) up front, but stays out of the preloaded set', () => {
    const known = new Set(['cad_design', 'onshape', 'freecad', 'code', 'mail', 'read_result', 'research'])
    expect(intentTools('build a 40 mm cube with a 5 mm fillet in CAD', known)).toEqual(expect.arrayContaining(['cad_design', 'onshape', 'freecad']))
    expect(intentTools('build a 40 mm cube in CAD', new Set(['cad_design', 'onshape']))).toEqual(expect.arrayContaining(['cad_design', 'onshape']))
    expect(intentTools('reply to the email from Sam', known)).not.toContain('cad_design')
    expect(likelyTools(known)).not.toContain('cad_design')
    expect(likelyTools(known)).not.toContain('onshape')
    expect(CAD_RE.test('export the bracket.step file')).toBe(true)
  })
})

// ---------------------------------------------------------------- workflow steps

describe('workflow steps', () => {
  test('the progress view walks Design brief → Concepts → Plan → Build → Verify', () => {
    expect(PHASES).toEqual(['Design brief', 'Concepts', 'Plan', 'Build', 'Verify'])
    expect(phaseItems('Design brief').map((x) => x.status)).toEqual(['in_progress', 'pending', 'pending', 'pending', 'pending'])
    expect(phaseItems('Build', { Concepts: '3 options → Ribbed' }).map((x) => [x.text, x.status])).toEqual([['Design brief', 'done'], ['Concepts: 3 options → Ribbed', 'done'], ['Plan', 'done'], ['Build', 'in_progress'], ['Verify', 'pending']])
    expect(phaseItems('done').every((x) => x.status === 'done')).toBe(true)
  })

  test('the brief lists what is missing; the concept prompt asks for distinct options scored on the trade-offs', () => {
    expect(briefGaps({ goal: 'a bracket' })).toHaveLength(6)
    expect(briefGaps({ goal: 'x', dimensions: ['40 mm'], material: 'PLA', process: 'fdm', loads: 'none', tolerances: '±0.2', interfaces: ['M3'] })).toEqual([])
    const p = conceptPrompt({ goal: 'a NEMA 17 bracket', process: 'fdm', loads: '20 N cantilever' })
    expect(p).toMatch(/2-3 genuinely different concepts/)
    expect(p).toMatch(/strength, weight, manufacturability, cost, assembly/)
    expect(p).toMatch(/FDM printing: walls ≥ 1\.2 mm/)
    expect(p).toMatch(/20 N cantilever/)
    expect(conceptPrompt({ goal: 'an intake', scope: 'assembly' })).toMatch(/3-4 genuinely different/)
  })

  test('concepts: 2-4, distinct, scored 1-5, one recommended', () => {
    const a = { name: 'Solid block', summary: 'One printed block', scores: { strength: 5, weight: 2 } }
    const b = { name: 'Ribbed', summary: 'Thin walls with ribs', scores: { strength: 4, weight: 4 } }
    expect(conceptProblems([a], 0)).toEqual(['Give 2 to 4 concepts.'])
    expect(conceptProblems([a, { ...a }], 0).join(' ')).toMatch(/both named|same summary/)
    expect(conceptProblems([a, b], 2).join(' ')).toMatch(/recommended must be the index/)
    expect(conceptProblems([a, { ...b, scores: { strength: 9 } }], 0).join(' ')).toMatch(/scored 1-5/)
    expect(conceptProblems([a, b], 1)).toEqual([])
    const t = conceptTable([a, b], 1)
    expect(t).toContain('| **Ribbed** (recommended) | 4 | 4 | – | – | – | 8 |')
  })

  test('backend: Onshape with keys, else FreeCAD, else setup', () => {
    expect(pickBackend({ onshapeKeys: true, freecad: true })).toBe('onshape')
    expect(pickBackend({ onshapeKeys: false, freecad: true })).toBe('freecad')
    expect(pickBackend({ onshapeKeys: true, freecad: true, prefer: 'freecad' })).toBe('freecad')
    expect(pickBackend({ onshapeKeys: false, freecad: false })).toBe('setup')
  })

  test('plan checks: expressions, references, ids', () => {
    expect(evalExpr('#side - 2 * #wall', { side: 40, wall: 2 })).toBe(36)
    expect(evalExpr('1.5 in', {})).toBeCloseTo(38.1)
    expect(evalExpr(2, {}, 25.4)).toBeCloseTo(50.8)
    expect(() => evalExpr('#nope', {})).toThrow(/isn't a variable/)
    expect(() => evalExpr('process.exit()', {})).toThrow()
    expect(planProblems(CUBE)).toEqual([])
    const bad = planProblems({ name: 'x', features: [{ op: 'fillet', id: 'f', edges: { of: 'missing' }, radius: 0 }, { op: 'cube', id: 'f', side: 10 }] })
    expect(bad.join('\n')).toMatch(/"missing", which isn't an earlier feature/)
    expect(bad.join('\n')).toMatch(/radius must be more than zero/)
    expect(bad.join('\n')).toMatch(/id "f" is used twice/)
    expect(formatPlan(CUBE)).toContain('Variables: #side = 40 mm, #r = 5 mm')
    expect(formatPlan(CUBE)).toContain('2. [round] Edge fillet: fillet r#r on edges of body')
  })

  test('verification checks: size in any axis order, volume tolerance, feature errors, interference', () => {
    const pass = checkModel(CUBE.expect, { bbox_mm: [40, 40, 40.004], volume_mm3: 61600, parts: 1 })
    expect(pass.every((c) => c.pass)).toBe(true)
    const fail = checkModel({ bbox_mm: [10, 20, 30], volume_mm3: 1000 }, { bbox_mm: [30, 10, 21], volume_mm3: 1100, errors: ['Fillet 1 is in error'] })
    expect(fail.find((c) => c.name === 'Regenerates')!.pass).toBe(false)
    expect(fail.find((c) => c.name === 'Size')!.detail).toMatch(/off by up to 1 mm/)
    expect(fail.find((c) => c.name === 'Volume')!.pass).toBe(false)
    const two = checkModel({ min_clearance_mm: 0.3 }, { parts: 2, interferences: 1, minGap_mm: 0 })
    expect(two.find((c) => c.name === 'Interference')!.pass).toBe(false)
    expect(two.find((c) => c.name === 'Clearance')!.pass).toBe(false)
  })
})

// ---------------------------------------------------------------- plan → Onshape feature JSON

describe('feature plan → Onshape API calls', () => {
  const specs = specIndex(FEATURE_SPECS)
  const fid = (id: string): string => ({ body: 'FCUBE', sk: 'FSK', axis_X: 'FAX' } as Record<string, string>)[id] ?? `<${id}>`

  test('cube and fillet: documented parameter shapes, queries by featureId, enum names from the specs', () => {
    const [cube] = draftsFor(CUBE.features[0], { units: 'mm', fid }).drafts
    expect(materialize(cube, specs)).toEqual({ problems: [], feature: { btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube', parameters: [{ btType: 'BTMParameterQuantity-147', parameterId: 'sideLength', expression: '#side', isInteger: false }] } })
    const [fillet] = draftsFor(CUBE.features[1], { units: 'mm', fid }).drafts
    const f = materialize(fillet, specs).feature as any
    expect(f.parameters[0]).toEqual({ btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{ btType: 'BTMIndividualQuery-138', queryString: 'query=qCreatedBy(makeId("FCUBE"), EntityType.EDGE);' }] })
    expect(f.parameters[1].expression).toBe('#r')
    const vars = variableDrafts(CUBE.variables, 'mm').map((d) => materialize(d, specs).feature as any)
    expect(vars[0].featureType).toBe('assignVariable')
    expect(vars[0].parameters).toEqual([
      { btType: 'BTMParameterString-149', parameterId: 'name', value: 'side' },
      { btType: 'BTMParameterEnum-145', parameterId: 'variableType', value: 'LENGTH', enumName: 'VariableType', namespace: '' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'lengthValue', expression: '40 mm', isInteger: false }
    ])
  })

  test('sketch + extrude: geometry in meters, sketch regions with inner loops left out, a hole is a sketch and a cut', () => {
    const sk = draftsFor({ op: 'sketch', id: 'sk', plane: 'Front', shapes: [{ kind: 'rect', w: 20, h: 10 }, { kind: 'circle', id: 'c1', x: 0, y: 0, r: 2 }] }, { units: 'mm', fid }).drafts[0]
    const s = materialize(sk, specs).feature as any
    expect(s.btType).toBe('BTMSketch-151')
    expect(s.parameters[0].queries[0].queryString).toBe('query=qCreatedBy(makeId("Front"), EntityType.FACE);')
    expect(s.entities).toHaveLength(5)
    expect(s.entities[0]).toMatchObject({ btType: 'BTMSketchCurveSegment-155', entityId: 'rect1.bottom', startParam: 0, endParam: 0.02, geometry: { btType: 'BTCurveGeometryLine-117', pntX: -0.01, pntY: -0.005, dirX: 1, dirY: 0 } })
    expect(s.entities[4]).toMatchObject({ btType: 'BTMSketchCurve-4', entityId: 'c1', geometry: { btType: 'BTCurveGeometryCircle-115', radius: 0.002, xCenter: 0, yCenter: 0 } })
    const ex = materialize(draftsFor({ op: 'extrude', id: 'e', sketch: 'sk', depth: 5, operation: 'add' }, { units: 'mm', fid }).drafts[0], specs).feature as any
    expect(ex.parameters).toEqual([
      { btType: 'BTMParameterEnum-145', parameterId: 'bodyType', value: 'SOLID', enumName: 'ExtendedToolBodyType', namespace: '' },
      { btType: 'BTMParameterEnum-145', parameterId: 'operationType', value: 'ADD', enumName: 'NewBodyOperationType', namespace: '' },
      { btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{ btType: 'BTMIndividualSketchRegionQuery-140', featureId: 'FSK', filterInnerLoops: true }] },
      { btType: 'BTMParameterEnum-145', parameterId: 'endBound', value: 'BLIND', enumName: 'BoundingType', namespace: '' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'depth', expression: '5 mm', isInteger: false }
    ])
    const hole = draftsFor({ op: 'hole', id: 'h', on: { of: 'body' }, at: [[10, 10], [30, 10]], diameter: 3.4 }, { units: 'mm', fid })
    expect(hole.drafts.map((d) => d.featureType)).toEqual(['newSketch', 'extrude'])
    const holeSketch = materialize(hole.drafts[0], specs).feature as any
    expect(holeSketch.parameters[0].queries[0].queryString).toBe('query=qCapEntity(makeId("FCUBE"), CapType.END, EntityType.FACE);')
    expect(holeSketch.entities.map((e: any) => e.geometry.radius)).toEqual([0.0017, 0.0017])
    const cut = materialize(hole.drafts[1], specs).feature as any
    expect(cut.parameters.find((p: any) => p.parameterId === 'operationType').value).toBe('REMOVE')
    expect(cut.parameters.find((p: any) => p.parameterId === 'endBound').value).toBe('THROUGH_ALL')
  })

  test('patterns get an axis sketch along +X/+Y/+Z and select its edge; inch plans convert', () => {
    const feats = withAxisSketches({ features: [{ op: 'cube', id: 'body', side: 1 }, { op: 'linear_pattern', id: 'lp', of: ['body'], direction: 'X', distance: 2, count: 3 }] })
    expect(feats.map((f) => f.id)).toEqual(['body', 'axis_X', 'lp'])
    const lp = materialize(draftsFor(feats[2], { units: 'in', fid }).drafts[0], specs).feature as any
    expect(lp.parameters.find((p: any) => p.parameterId === 'directionOne').queries[0].queryString).toBe('query=sketchEntityQuery(makeId("FAX"), EntityType.EDGE, "axis_X");')
    expect(lp.parameters.find((p: any) => p.parameterId === 'distance').expression).toBe('2 in')
    expect(lp.parameters.find((p: any) => p.parameterId === 'instanceCount')).toMatchObject({ expression: '3', isInteger: true })
    expect(shapeEntities({ kind: 'circle', r: 1 }, 0, 'in', false).entities[0]).toMatchObject({ geometry: { radius: 0.0254 } })
    expect(refQuery(undefined, 'edges', fid)).toBe('qBodyType(qEverything(EntityType.EDGE), BodyType.SOLID)')
  })

  test('the spec check: unknown parameters and enum values are errors, aliases are tried, unknown specs fall back to documented enum names', () => {
    const bad = materialize({ planId: 'x', featureType: 'fillet', name: 'Fillet', params: [{ id: 'radius', value: { quantity: '1 mm' } }, { id: 'tangentPropagationX', value: { bool: true } }] }, specs)
    expect(bad.problems[0]).toMatch(/no "tangentPropagationX" parameter. It has: entities, radius/)
    const badEnum = materialize({ planId: 'x', featureType: 'extrude', name: 'E', params: [{ id: 'endBound', value: { enum: 'TO_INFINITY' } }] }, specs)
    expect(badEnum.problems[0]).toMatch(/isn't an option of endBound/)
    const kind = materialize({ planId: 'x', featureType: 'extrude', name: 'E', params: [{ id: 'depth', value: { enum: 'BLIND' } }] }, specs)
    expect(kind.problems[0]).toMatch(/"depth" is a quantity/)
    const alias = materialize({ planId: 'x', featureType: 'mirror', name: 'M', params: [{ id: 'plane', aliases: ['mirrorPlane'], value: { queries: ['q'] } }] }, specs)
    expect((alias.feature as any).parameters[0].parameterId).toBe('mirrorPlane')
    expect(materialize({ planId: 'x', featureType: 'nonsense', name: 'N', params: [] }, specs).problems[0]).toMatch(/no "nonsense" feature/)
    const noSpecs = materialize({ planId: 'x', featureType: 'extrude', name: 'E', params: [{ id: 'endBound', value: { enum: 'BLIND' } }] })
    expect((noSpecs.feature as any).parameters[0].enumName).toBe('BoundingType')
  })
})

// ---------------------------------------------------------------- against the fake Onshape server

describe('building in Onshape (fake server)', () => {
  let fake: FakeOnshape
  let ws = ''
  const client = (): OnshapeClient => new OnshapeClient({ keys: () => FAKE_KEYS, testOrigin: fake.url, sleep: async () => undefined })
  beforeAll(async () => { fake = await startFakeOnshape() })
  afterAll(() => fake.close())
  beforeEach(() => { fake.seen.length = 0; ws = mkdtempSync(join(tmpdir(), 'cad-ws-')); clearCreated() })

  test('a plan becomes a new document, variables first, then features in order with featureIds threaded through; every call signed', async () => {
    const r = await buildOnshape(client(), CUBE)
    expect(r.ok).toBe(true)
    expect(r.created).toBe(true)
    expect(isCreatedDoc(r.ref.did)).toBe(true)
    const calls = fake.seen.map((s) => `${s.method} ${s.path.replace(/\/api\/v17/, '').replace(/[0-9a-f]{24}/g, ':id')}`)
    expect(calls).toEqual([
      'POST /documents',
      'GET /documents/d/:id/w/:id/elements',
      'GET /partstudios/d/:id/w/:id/e/:id/featurespecs',
      'POST /partstudios/d/:id/w/:id/e/:id/features',
      'POST /partstudios/d/:id/w/:id/e/:id/features',
      'POST /partstudios/d/:id/w/:id/e/:id/features',
      'POST /partstudios/d/:id/w/:id/e/:id/features'
    ])
    expect(fake.seen.every((s) => s.signed)).toBe(true)
    expect(fake.seen[0].body).toMatchObject({ name: 'Filleted cube', isPublic: false })
    const sent = fake.seen.filter((s) => s.method === 'POST' && s.path.endsWith('/features')).map((s) => s.body)
    expect(sent.every((b) => b.btType === 'BTFeatureDefinitionCall-1406')).toBe(true)
    expect(sent.map((b) => b.feature.featureType)).toEqual(['assignVariable', 'assignVariable', 'cube', 'fillet'])
    const cubeId = r.features.find((f) => f.planId === 'body')!.featureId
    expect(sent[3].feature.parameters[0].queries[0].queryString).toBe(`query=qCreatedBy(makeId("${cubeId}"), EntityType.EDGE);`)
    expect(r.features.map((f) => f.status)).toEqual(['OK', 'OK', 'OK', 'OK'])

    // Verification reads: size, volume, parts, the picture; the checks pass against the plan.
    fake.seen.length = 0
    const m = await measureOnshape(client(), r.ref, { views: ['isometric'] })
    expect(m.bbox_mm).toEqual([40, 40, 40])
    expect(m.volume_mm3).toBeCloseTo(61592.18, 1)
    expect(m.parts).toEqual(['Part 1'])
    expect(m.images[0]).toMatch(/^data:image\/png;base64,/)
    expect(m.errors).toEqual([])
    expect(checkModel(CUBE.expect, { bbox_mm: m.bbox_mm, volume_mm3: m.volume_mm3, parts: m.parts!.length, errors: m.errors }).every((c) => c.pass)).toBe(true)
    expect(fake.seen.map((s) => s.path.split('/').pop())).toEqual(['features', 'boundingboxes', 'massproperties', expect.any(String), 'shadedviews'])
  })

  test('a feature that fails stops the build; fixing the plan and building again updates in place, never deletes', async () => {
    const tooBig: CadPlan = { ...CUBE, variables: [{ name: 'side', value: 40 }, { name: 'r', value: '25 mm' }] }
    const r1 = await buildOnshape(client(), tooBig)
    expect(r1.ok).toBe(false)
    expect(r1.features.at(-1)).toMatchObject({ planId: 'round', status: 'ERROR' })
    fake.seen.length = 0
    const r2 = await buildOnshape(client(), CUBE, { previous: r1 })
    expect(r2.ok).toBe(true)
    expect(r2.ref).toEqual(r1.ref)
    expect(fake.seen.some((s) => s.method === 'DELETE')).toBe(false)
    expect(fake.seen.some((s) => s.path === '/api/v17/documents')).toBe(false)
    const updates = fake.seen.filter((s) => /\/features\/featureid\//.test(s.path))
    expect(updates).toHaveLength(4)
    expect(updates.every((u) => u.body.feature.featureId)).toBe(true)
    expect(r2.features.map((f) => f.featureId)).toEqual(r1.features.map((f) => f.featureId))
  })

  test('a sketch whose constraints Onshape rejects is sent again without them, and says so', async () => {
    const plan: CadPlan = { name: 'Plate', features: [{ op: 'sketch', id: 'sk', shapes: [{ kind: 'rect', w: 20, h: 10 }], constraints: [{ type: 'FIX', first: 'rect1.bottom' }] }] }
    const r = await buildOnshape(client(), plan)
    expect(r.ok).toBe(true)
    expect(r.features[0].note).toMatch(/1 sketch constraint was dropped/)
  })

  test('building into an existing document adds a new Part Studio tab (an assembly with instances and a mate works too)', async () => {
    const existing = (await buildOnshape(client(), { name: 'Existing', features: [{ op: 'cube', id: 'c', side: 10 }] })).ref
    clearCreated()
    fake.seen.length = 0
    const r = await buildOnshape(client(), { name: 'Pair', features: [{ op: 'cube', id: 'a', side: 10 }], assembly: { instances: [{ id: 'one', part: 'a' }, { id: 'two', part: 'a', offset_mm: [20, 0, 0] }], mates: [{ type: 'FASTENED', a: { instance: 'one', face_of: 'a' }, b: { instance: 'two', face_of: 'a' } }] } }, { target: { did: existing.did, origin: existing.origin } })
    expect(r.ok).toBe(true)
    expect(r.created).toBe(false)
    expect(r.ref.eid).not.toBe(existing.eid)
    const paths = fake.seen.map((s) => `${s.method} ${s.path.replace(/\/api\/v17/, '').replace(/[0-9a-f]{24}/g, ':id')}`)
    expect(paths).toContain('POST /partstudios/d/:id/w/:id')
    expect(paths).toContain('POST /assemblies/d/:id/w/:id')
    expect(paths.filter((p) => p === 'POST /assemblies/d/:id/w/:id/e/:id/instances')).toHaveLength(2)
    expect(paths).toContain('POST /assemblies/d/:id/w/:id/e/:id/occurrencetransforms')
    const asmFeatures = fake.seen.filter((s) => /assemblies.*\/features$/.test(s.path)).map((s) => s.body.feature)
    expect(asmFeatures.map((f) => f.btType)).toEqual(['BTMMateConnector-66', 'BTMMateConnector-66', 'BTMMate-64'])
    expect(asmFeatures[0].parameters[1].queries[0]).toEqual({ btType: 'BTMInferenceQueryWithOccurrence-1083', inferenceType: 'CENTROID', path: ['I1'], deterministicIds: ['JFC'] })
    expect(asmFeatures[2].parameters[0]).toMatchObject({ parameterId: 'mateType', value: 'FASTENED' })
    expect(fake.seen.find((s) => s.path.endsWith('/occurrencetransforms'))!.body).toEqual({ isRelative: true, occurrences: [{ path: ['I2'] }], transform: [1, 0, 0, 0.02, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] })
  })

  test('the interference script is a read-only lambda (evCollision + evDistance)', () => {
    expect(CLASH_SCRIPT).toMatch(/^function\(context is Context, queries\)/)
    expect(CLASH_SCRIPT).toMatch(/evCollision/)
    expect(CLASH_SCRIPT).not.toMatch(/\bop[A-Z]\w*\(/)
  })

  // ---------------------------------------------------------------- the cad_design tool, end to end

  const ctx = (state = emptyState(), extra: Partial<ToolContext> = {}): ToolContext => ({ threadId: `t-${Math.random()}`, signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, askUser: async () => '', state, loadTools: () => [], searchTools: () => [], readResult: () => undefined, ...extra })
  const tools = (): { design: ToolDef<CadDesignArgs>; onshape: ToolDef<OnshapeArgs> } => {
    const onshape = onshapeTool({ keys: () => FAKE_KEYS, workspace: () => ws, testOrigin: fake.url, sleep: async () => undefined })
    return { onshape, design: cadDesignTool({ onshapeKeys: () => FAKE_KEYS, freecadBin: () => null, workspace: () => ws, onshape, testOrigin: fake.url, sleep: async () => undefined }) }
  }

  test('cad_design runs the whole workflow and drives the progress card: brief → concepts → plan → build → verify → deliver', async () => {
    const { design } = tools()
    const c = ctx()
    const phases = (o: { meta?: Record<string, unknown> }): string[] => (o.meta!.plan as Array<{ status: string }>).map((x) => x.status)
    const b = await design.run({ action: 'brief', brief: { goal: '40 mm cube with 5 mm fillets', units: 'mm', dimensions: ['40 mm cube', '5 mm fillet on every edge'] } }, c)
    expect(b.text).toMatch(/CAD: Onshape/)
    expect(b.text).toMatch(/Not stated yet: material/)
    expect(b.text).toMatch(/Next, concepts/)
    expect(b.meta!.planTitle).toBe('Design')
    expect(phases(b)).toEqual(['done', 'in_progress', 'pending', 'pending', 'pending'])
    expect(c.state.todos[0].text).toBe('Design brief: 40 mm cube with 5 mm fillets')

    const k = await design.run({ action: 'concepts', concepts: [{ name: 'Cube feature + fillet', summary: 'Onshape cube, then one fillet on all edges', scores: { manufacturability: 5 } }, { name: 'Sketch + extrude', summary: 'Square sketch extruded 40 mm, fillets after', scores: { manufacturability: 5 } }], recommended: 0, reasons: 'fewest features' }, c)
    expect(k.text).toMatch(/Chosen: "Cube feature \+ fillet" \(recommended\)/)
    expect(phases(k)).toEqual(['done', 'done', 'in_progress', 'pending', 'pending'])

    const p = await design.run({ action: 'plan', plan: CUBE }, c)
    expect(p.text).toMatch(/Builds in Onshape/)
    await expect(design.run({ action: 'plan', plan: { name: 'x', features: [] } as CadPlan }, c)).rejects.toThrow(/at least one feature/)

    const built = await design.run({ action: 'build' }, c)
    expect(built.text).toMatch(/Built "Filleted cube" in Onshape \(a new document\): http/)
    expect(phases(built)).toEqual(['done', 'done', 'done', 'done', 'in_progress'])

    const v = await design.run({ action: 'verify' }, c)
    expect(v.text).toMatch(/PASS Size: 40 × 40 × 40 mm/)
    expect(v.text).toMatch(/PASS Volume/)
    expect(v.images).toHaveLength(1)
    expect(phases(v)).toEqual(['done', 'done', 'done', 'done', 'done'])

    const d = await design.run({ action: 'deliver' }, c)
    expect(d.text).toMatch(/Parameters \(change these to resize it\): #side = 40 mm, #r = 5 mm/)
    expect(d.text).toMatch(/STEP: .*exports\/onshape\/.*\.step/)
    expect(existsSync(d.path!)).toBe(true)
    expect(readFileSync(d.path!, 'utf8')).toMatch(/^ISO-10303-21/)
  })

  test('iterating: a failed build, a revised plan and a second build update the same document in place', async () => {
    const { design } = tools()
    const c = ctx()
    await design.run({ action: 'plan', plan: { ...CUBE, variables: [{ name: 'side', value: 40 }, { name: 'r', value: '25 mm' }] } }, c)
    const b1 = await design.run({ action: 'build' }, c)
    expect(b1.text).toMatch(/stopped at a feature that didn't regenerate/)
    expect(b1.text).toMatch(/Edge fillet: ERROR/)
    expect((b1.meta!.plan as Array<{ status: string }>)[3].status).toBe('in_progress')
    fake.seen.length = 0
    await design.run({ action: 'plan', plan: CUBE }, c)
    const b2 = await design.run({ action: 'build' }, c)
    expect(b2.text).toMatch(/updated the features from the last build/)
    expect(fake.seen.some((x) => x.method === 'POST' && x.path === '/api/v17/documents')).toBe(false)
    expect(fake.seen.filter((x) => /featureid/.test(x.path))).toHaveLength(4)
    expect((await design.run({ action: 'verify' }, c)).text).toMatch(/PASS Volume/)
  })

  test('concepts: a watching user can pick another one; unattended runs take the recommendation without asking', async () => {
    const { design } = tools()
    const list = [{ name: 'A', summary: 'first' }, { name: 'B', summary: 'second' }]
    let asked = ''
    const watching = ctx(emptyState(), { proposePlan: async () => 'approve', askUser: async (q, opts) => { asked = `${q} ${opts?.join('|')}`; return 'B' } })
    const r = await design.run({ action: 'concepts', concepts: list, recommended: 0, confirm: true }, watching)
    expect(asked).toMatch(/I recommend "A".*A \(recommended\)\|B/)
    expect(r.text).toMatch(/Chosen: "B" \(the user's choice\)/)
    let unattendedAsked = false
    const unattended = ctx(emptyState(), { askUser: async () => { unattendedAsked = true; return '' } })
    const u = await design.run({ action: 'concepts', concepts: list, recommended: 1, confirm: true }, unattended)
    expect(unattendedAsked).toBe(false)
    expect(u.text).toMatch(/Chosen: "B" \(recommended\)/)
  })

  test('approvals: a new document is routine in Auto; the user\'s documents ask; deletes and code replacement always ask', async () => {
    const { design, onshape } = tools()
    const base = { mode: 'auto' as const, alwaysAllowed: false, hardStopsEnabled: true, tainted: false }
    const verdict = (t: ToolDef, a: any, mode: 'auto' | 'autonomous' = 'auto'): string => {
      const effect = typeof t.effect === 'function' ? t.effect(a, { roots: [] }) : t.effect
      return decide({ ...base, mode, tool: t.name, effect, hardStop: t.hardStop?.(a) ?? null, consequential: t.consequential?.(a, { threadId: 't' }) } as any).verdict
    }
    expect(verdict(design, { action: 'build', plan: CUBE })).toBe('allow')
    expect(verdict(design, { action: 'plan', plan: CUBE })).toBe('allow')
    const userDoc = 'https://cad.onshape.com/documents/0123456789abcdef01234567/w/1123456789abcdef01234567/e/2123456789abcdef01234567'
    expect(verdict(design, { action: 'build', plan: CUBE, url: userDoc })).toBe('ask')
    expect(design.describe!({ action: 'build', plan: CUBE, url: userDoc })).toMatch(/into your Onshape document .*nothing is deleted/)
    expect(verdict(onshape, { action: 'create_document', name: 'New' })).toBe('allow')
    expect(verdict(onshape, { action: 'update_feature', url: userDoc, feature_id: 'F1', feature: {} })).toBe('ask')
    expect(onshapeEffect({ action: 'delete_feature', url: userDoc })).toBe('destructive')
    expect(verdict(onshape, { action: 'delete_feature', url: userDoc, feature_id: 'F1' }, 'autonomous')).toBe('ask')
    expect(onshape.hardStop!({ action: 'delete_feature', url: userDoc, feature_id: 'F1' })).toMatch(/Deletes a feature/)
    expect(onshapeEffect({ action: 'write_featurestudio', url: userDoc })).toBe('destructive')
    expect(onshapeEffect({ action: 'write_featurestudio', url: userDoc.replace(/\/e\/.*$/, '') })).toBe('write_external')
    // A document this session created: changes inside it run in Auto (deleting still asks).
    const r = await buildOnshape(client(), { name: 'Mine', features: [{ op: 'cube', id: 'c', side: 5 }] })
    const mine = `https://cad.onshape.com/documents/${r.ref.did}/w/${r.ref.wvmid}/e/${r.ref.eid}`
    expect(onshapeConsequential({ action: 'update_feature', url: mine })).toBe(false)
    expect(verdict(onshape, { action: 'update_feature', url: mine, feature_id: 'F1', feature: {} })).toBe('allow')
    expect(verdict(design, { action: 'build', plan: CUBE, url: mine })).toBe('allow')
    expect(verdict(onshape, { action: 'delete_feature', url: mine, feature_id: 'F1' })).toBe('ask')
  })

  test('new onshape actions: create_document, create_element, feature_specs, update/delete_feature, insert/transform instances, write_featurestudio, interference, several views', async () => {
    const { onshape } = tools()
    const c = ctx()
    const made = await onshape.run({ action: 'create_document', name: 'Scratch' }, c)
    const did = /documents\/([0-9a-f]{24})\/w\/([0-9a-f]{24})/.exec(made.text)!
    const wsUrl = `https://cad.onshape.com/documents/${did[1]}/w/${did[2]}`
    const doc = fake.docs.get(did[1])!
    const ps = `${wsUrl}/e/${doc.elements[0].id}`
    const asm = `${wsUrl}/e/${doc.elements[1].id}`
    expect(made.text).toMatch(/Part Studio 1 \(Part Studio\)/)
    expect((await onshape.run({ action: 'create_element', url: wsUrl, kind: 'variablestudio', name: 'Params' }, c)).text).toMatch(/Added Variable Studio "Params"/)
    expect(fake.seen.at(-1)!.path).toMatch(/\/variables\/d\/\w+\/w\/\w+\/variablestudio$/)
    const specs = await onshape.run({ action: 'feature_specs', url: ps, query: 'fillet' }, c)
    expect(specs.text).toMatch(/fillet \(fillet\):\n {2}- entities: Query\n {2}- radius: Quantity/)
    const add = await onshape.run({ action: 'add_feature', url: ps, feature: { btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube 1', parameters: [{ btType: 'BTMParameterQuantity-147', parameterId: 'sideLength', expression: '1 in' }] } }, c)
    const fid = /featureId (\w+)/.exec(add.text)![1]
    const up = await onshape.run({ action: 'update_feature', url: ps, feature_id: fid, feature: { btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube 1', parameters: [{ btType: 'BTMParameterQuantity-147', parameterId: 'sideLength', expression: '2 in' }] } }, c)
    expect(up.text).toMatch(/status OK/)
    expect(fake.seen.at(-1)!.body.feature.featureId).toBe(fid)
    const shots = await onshape.run({ action: 'thumbnail', url: ps, views: ['isometric', 'front', 'top'] }, c)
    expect(shots.images).toHaveLength(3)
    expect((await onshape.run({ action: 'interference', url: ps }, c)).text).toMatch(/1 solid part, 0 overlapping pairs/)
    await onshape.run({ action: 'insert_instance', url: asm, source_url: ps }, c)
    expect(fake.seen.at(-1)!.body).toMatchObject({ documentId: did[1], elementId: doc.elements[0].id, isWholePartStudio: true })
    await onshape.run({ action: 'transform_instances', url: asm, instance_ids: ['I1'], translate_mm: [10, 0, 5] }, c)
    expect(fake.seen.at(-1)!.body.transform).toEqual([1, 0, 0, 0.01, 0, 1, 0, 0, 0, 0, 1, 0.005, 0, 0, 0, 1])
    const fs = await onshape.run({ action: 'write_featurestudio', url: wsUrl, name: 'Custom', script: 'FeatureScript 2144;\nimport(path : "onshape/std/common.fs", version : "2144.0");\n' }, c)
    expect(fs.text).toMatch(/Created Feature Studio/)
    expect(fake.seen.at(-1)!.body).toMatchObject({ btType: 'BTFeatureStudioContents-2239', serializationVersion: '1.2.3', sourceMicroversion: 'mv1' })
    await onshape.run({ action: 'delete_feature', url: ps, feature_id: fid }, c)
    expect(fake.seen.at(-1)!.method).toBe('DELETE')
    expect(doc.elements[0].features).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- FreeCAD

describe('building with FreeCAD', () => {
  test('the plan reaches FreeCAD as numbers in mm; the script is valid Python and takes everything from ARGS', () => {
    const c = compileForFreecad({ ...CUBE, units: 'in', variables: [{ name: 'side', value: 1 }], features: [{ op: 'cube', id: 'body', side: '#side' }, { op: 'hole', id: 'h', on: { of: 'body', cap: 'end' }, at: [[0.5, 0.5]], diameter: 0.25 }] })
    expect(c.problems).toEqual([])
    expect(c.ops[0]).toEqual({ op: 'cube', id: 'body', side: 25.4 })
    expect(c.ops[1]).toMatchObject({ op: 'hole', at: [[12.7, 12.7]], diameter: 6.35, depth: null, onFace: true })
    expect(c.params).toEqual([{ name: 'side', value: 25.4, unit: 'mm' }])
    expect(compileForFreecad({ name: 'r', features: [{ op: 'raw', id: 'x', feature: {} }] }).problems[0]).toMatch(/can't be built in FreeCAD/)
    const script = wrapScript(PY_BUILD_HEADER, PY_BUILD, { ops: c.ops, params: c.params, out: { fcstd: '/tmp/a "b".FCStd', step: 'x', stl: 'y' } }, '/tmp/r.json')
    expect(script).toContain('ARGS = json.loads(ARGS_JSON)')
    expect(script).not.toContain('a "b"')
    let py = ''
    try { py = execFileSync('which', ['python3']).toString().trim() } catch { /* no python */ }
    if (py) {
      const dir = mkdtempSync(join(tmpdir(), 'fc-py-'))
      const f = join(dir, 'build.py')
      writeFileSync(f, script)
      execFileSync(py, ['-I', '-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', f])
    }
  })

  test('cad_design builds and verifies with FreeCAD when there are no Onshape keys; the views are pictures to look at', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'fc-ws-'))
    const polylines = [[[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0], [0, 0, 0]], [[0, 0, 0], [0, 0, 40]], [[0, 0, 40], [40, 0, 40], [40, 40, 40]]]
    let script = ''
    const design = cadDesignTool({
      onshapeKeys: () => undefined, freecadBin: () => '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd', workspace: () => ws,
      runFreecad: async (_bin, make) => { script = make('/tmp/result.json'); return { ok: true, ms: 5, result: { bbox_mm: [40, 40, 40], volume_mm3: 61592.2, area_mm2: 9400, bodies: 1, valid: true, interferences: 0, min_gap_mm: null, polylines } } }
    })
    const c: ToolContext = { threadId: 'fc', signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, askUser: async () => '', state: emptyState(), loadTools: () => [], searchTools: () => [], readResult: () => undefined }
    expect(typeof design.effect === 'function' && design.effect({ action: 'build' }, { roots: [] })).toBe('write_local')
    await design.run({ action: 'plan', plan: CUBE }, c)
    const b = await design.run({ action: 'build' }, c)
    expect(b.text).toMatch(/Built "Filleted cube" in FreeCAD:\n- .*\.FCStd\n- .*\.step\n- .*\.stl/)
    // The plan is inside ARGS_JSON (a JSON string literal), never Python source.
    expect(script).toContain('\\"op\\":\\"fillet\\"')
    const v = await design.run({ action: 'verify' }, c)
    expect(v.text).toMatch(/PASS Size/)
    expect(v.images).toHaveLength(3)
    const png = Buffer.from(v.images![0].split(',')[1], 'base64')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.readUInt32BE(16)).toBe(640)
    expect((v.meta!.plan as Array<{ status: string }>).every((x) => x.status === 'done')).toBe(true)
  })

  test('without Onshape or FreeCAD, building explains the one-time setup', async () => {
    const design = cadDesignTool({ onshapeKeys: () => undefined, freecadBin: () => null, workspace: () => tmpdir() })
    const c: ToolContext = { threadId: 'none', signal: new AbortController().signal, workspaceDir: tmpdir(), docsDir: tmpdir(), askUser: async () => '', state: emptyState(), loadTools: () => [], searchTools: () => [], readResult: () => undefined }
    const b = await design.run({ action: 'brief', brief: { goal: 'a hook' } }, c)
    expect(b.text).toMatch(/One-time setup/)
    await expect(design.run({ action: 'build', plan: CUBE }, c)).rejects.toThrow(/dev-portal\.onshape\.com\/keys[\s\S]*freecad\.org/)
  })

  test('wireframe pictures: a valid PNG that draws the edges', () => {
    const png = wireframePng([[[0, 0, 0], [10, 10, 10]]], 'isometric', 64, 48)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(64)
    expect(png.readUInt32BE(20)).toBe(48)
    expect(encodePng(new Uint8Array(4).fill(255), 2, 2).length).toBeGreaterThan(40)
    expect(wireframeImages(undefined)).toEqual([])
  })
})
