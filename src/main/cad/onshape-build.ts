import { markCreated } from './created'
import { OnshapeError, type OnshapeClient } from './onshape-client'
import { elementList, fsValue, pickMass, type Box } from './onshape-format'
import { addFeatureBody, draftsFor, materialize, specIndex, variableDrafts, withAxisSketches, type FeatureDraft, type SpecIndex } from './onshape-features'
import { dwvm, dwvme, onshapeUrl, type DocRef } from './onshape-url'
import type { CadPlan } from './plan'

// Runs a feature plan in Onshape through the REST API and reads the result back for verification.
// Endpoints (all in the v17 OpenAPI spec, https://cad.onshape.com/glassworks/explorer/):
//   POST /documents                                   createDocument (a new, private document)
//   POST /partstudios/d/{did}/w/{wid}                 createPartStudio
//   GET  /partstudios/d/{did}/w/{wid}/e/{eid}/featurespecs   getPartStudioFeatureSpecs (parameter checks)
//   POST /partstudios/d/{did}/w/{wid}/e/{eid}/features       addPartStudioFeature
//   POST /partstudios/d/{did}/w/{wid}/e/{eid}/features/featureid/{fid}   updatePartStudioFeature
//   POST /partstudios/…/featurescript                 evalFeatureScript (part ids, face ids, collisions)
//   POST /assemblies/d/{did}/w/{wid}                  createAssembly
//   POST /assemblies/…/instances, …/occurrencetransforms, …/features (mate connectors, mates)
//   GET  …/boundingboxes, …/massproperties, /parts/…, …/shadedviews
// Nothing here deletes anything: a rebuild updates the features it made earlier and adds new ones.

/** Named shaded-view directions; isometric is Onshape's documented approximate matrix. */
export const SHADED_VIEWS: Record<string, string> = { isometric: '0.612,0.612,0,0,-0.354,0.354,0.707,0,0.707,-0.707,0.707,0', top: 'top', bottom: 'bottom', front: 'front', back: 'back', left: 'left', right: 'right' }

export interface BuiltFeature { planId: string; name: string; featureId?: string; status: string; error?: string; note?: string }

export interface BuildResult {
  /** The Part Studio the plan was built in (always a workspace). */
  ref: DocRef
  assemblyId?: string
  url: string
  assemblyUrl?: string
  documentName: string
  /** A new document made for this build (changes in it are routine). */
  created: boolean
  features: BuiltFeature[]
  ok: boolean
  calls: number
  notes: string[]
}

export interface BuildOptions {
  /** Build into this existing document (workspace) instead of a new one; with an element id of a Part Studio, append to it. */
  target?: DocRef
  /** An earlier build of this plan: features it made are updated in place, new ones added. */
  previous?: BuildResult
  signal?: AbortSignal
  progress?: (text: string) => void
}

const fsScript = (body: string): string => `function(context is Context, queries) { ${body} }`
const idsOf = (fid: string, what: 'BODY' | 'FACE', cap = false): string => fsScript(`return transientQueriesToStrings(evaluateQuery(context, ${cap ? `qCapEntity(makeId(${JSON.stringify(fid)}), CapType.END, EntityType.FACE)` : `qCreatedBy(makeId(${JSON.stringify(fid)}), EntityType.${what})`}));`)

/** Every solid against every other: interfering pairs (evCollision) and the smallest gap (evDistance), in meters. */
export const CLASH_SCRIPT = fsScript([
  'var bodies = evaluateQuery(context, qBodyType(qEverything(EntityType.BODY), BodyType.SOLID));',
  'var clashes = 0; var minGap = -1;',
  'for (var i = 0; i < size(bodies); i += 1) { for (var j = i + 1; j < size(bodies); j += 1) {',
  '  var hits = evCollision(context, { "tools" : bodies[i], "targets" : bodies[j] });',
  '  for (var h in hits) { if (h.type == ClashType.INTERFERE) { clashes += 1; } }',
  '  var gap = evDistance(context, { "side0" : bodies[i], "side1" : bodies[j] }).distance / meter;',
  '  if (minGap < 0 || gap < minGap) { minGap = gap; }',
  '} }',
  'return { "bodies" : size(bodies), "interferences" : clashes, "minGap" : minGap };'
].join(' '))

/** Builds (or rebuilds) a plan in Onshape. Stops at the first feature that fails to regenerate. */
export async function buildOnshape(client: OnshapeClient, plan: CadPlan, o: BuildOptions = {}): Promise<BuildResult> {
  let calls = 0
  const get = <T>(path: string, query?: Record<string, string | number | boolean | string[] | undefined>, origin?: string): Promise<T> => { calls++; return client.get<T>(path, { origin, query, signal: o.signal }) }
  const post = <T>(path: string, body: unknown, origin?: string): Promise<T> => { calls++; return client.post<T>(path, body, { origin, signal: o.signal }) }
  const notes: string[] = []
  const units = plan.units ?? 'mm'

  // ---- where
  let ref: DocRef
  let created = false
  let documentName = plan.name
  if (o.previous) {
    ref = o.previous.ref
    created = o.previous.created
    documentName = o.previous.documentName
  } else if (o.target) {
    let t = o.target
    if (t.wvm && t.wvm !== 'w') throw new OnshapeError('That URL is a version or microversion (read-only history). Builds go to a workspace: paste the URL with /w/ in it.', 0)
    const doc = await get<Record<string, any>>(`/documents/${t.did}`, undefined, t.origin)
    documentName = String(doc?.name ?? plan.name)
    if (!t.wvmid) {
      const wid = doc?.defaultWorkspace?.id
      if (typeof wid !== 'string') throw new OnshapeError('That document has no default workspace I can read; paste the workspace URL.', 0)
      t = { ...t, wvm: 'w', wvmid: wid }
    }
    let eid: string | undefined
    if (t.eid) {
      const els = elementList(await get(`/documents/${dwvm(t)}/elements`, { elementId: t.eid }, t.origin))
      if (els[0]?.type === 'PARTSTUDIO') eid = t.eid
    }
    if (!eid) {
      o.progress?.(`Adding a Part Studio "${plan.name}"…`)
      const ps = await post<Record<string, any>>(`/partstudios/d/${t.did}/w/${t.wvmid}`, { name: plan.name.slice(0, 100) }, t.origin)
      eid = String(ps?.id ?? '')
      if (!eid) throw new OnshapeError('Onshape did not create the Part Studio.', 0)
    }
    ref = { ...t, eid }
  } else {
    o.progress?.(`Creating Onshape document "${plan.name}"…`)
    const doc = await post<Record<string, any>>('/documents', { name: plan.name.slice(0, 200), isPublic: false, description: 'Made by SahilBot from a design plan.' })
    const did = String(doc?.id ?? '')
    const wid = doc?.defaultWorkspace?.id
    if (!did || typeof wid !== 'string') throw new OnshapeError('Onshape did not create the document (no id or workspace in the reply).', 0)
    markCreated(did)
    created = true
    documentName = String(doc?.name ?? plan.name)
    const base: DocRef = { did, wvm: 'w', wvmid: wid, origin: 'https://cad.onshape.com' }
    let eid = typeof doc?.defaultElementId === 'string' ? doc.defaultElementId : undefined
    const els = elementList(await get(`/documents/${dwvm(base)}/elements`))
    const ps = els.find((e) => e.id === eid && e.type === 'PARTSTUDIO') ?? els.find((e) => e.type === 'PARTSTUDIO')
    eid = ps?.id
    if (!eid) {
      const made = await post<Record<string, any>>(`/partstudios/d/${did}/w/${wid}`, { name: plan.name.slice(0, 100) })
      eid = String(made?.id ?? '')
    }
    ref = { ...base, eid }
  }
  const featuresPath = `/partstudios/d/${ref.did}/w/${ref.wvmid}/e/${ref.eid}/features`

  // ---- the Part Studio's own feature specs: parameter ids, enum names and options
  let specs: SpecIndex | undefined
  try {
    specs = specIndex(await get(`/partstudios/${dwvme(ref)}/featurespecs`, undefined, ref.origin))
    if (!specs.size) specs = undefined
  } catch (e) {
    notes.push(`Could not read the feature specs (${(e as Error).message.slice(0, 120)}); parameters were sent as planned, without the spec check.`)
  }

  // ---- features, in order
  const fids = new Map<string, string>(o.previous ? o.previous.features.filter((f) => f.featureId).map((f) => [f.planId, f.featureId!]) : [])
  const fid = (planId: string): string => fids.get(planId) ?? `<${planId}>`
  const results: BuiltFeature[] = []
  let ok = true
  const steps: Array<() => { drafts: FeatureDraft[]; problems: string[] }> = [
    () => ({ drafts: variableDrafts(plan.variables, units), problems: [] }),
    ...withAxisSketches(plan).map((f) => () => draftsFor(f, { units, fid }))
  ]
  outer: for (const step of steps) {
    const { drafts, problems } = step()
    if (problems.length) { results.push({ planId: drafts[0]?.planId ?? '?', name: drafts[0]?.name ?? '?', status: 'NOT_SENT', error: problems.join(' ') }); ok = false; break }
    for (const d of drafts) {
      const m = materialize(d, specs)
      if (m.problems.length) { results.push({ planId: d.planId, name: d.name, status: 'NOT_SENT', error: m.problems.join(' ') }); ok = false; break outer }
      o.progress?.(`Onshape: ${d.name}…`)
      const send = async (feature: Record<string, unknown>): Promise<Record<string, any>> => {
        const existing = fids.get(d.planId)
        return existing
          ? post<Record<string, any>>(`${featuresPath}/featureid/${encodeURIComponent(existing)}`, addFeatureBody({ ...feature, featureId: existing }), ref.origin)
          : post<Record<string, any>>(featuresPath, addFeatureBody(feature), ref.origin)
      }
      let res: Record<string, any> | undefined
      let note: string | undefined
      let error: string | undefined
      try { res = await send(m.feature) } catch (e) { error = (e as Error).message }
      const constraints = (m.feature.constraints as unknown[] | undefined) ?? []
      const status = (): string => String(res?.featureState?.featureStatus ?? (error ? 'REJECTED' : 'UNKNOWN'))
      // A sketch whose constraints Onshape won't solve is sent again without them: the geometry alone fixes its shape.
      if (d.sketch && constraints.length && (error || status() === 'ERROR')) {
        if (res?.feature?.featureId) fids.set(d.planId, String(res.feature.featureId))
        try { res = await send({ ...m.feature, constraints: [] }); error = undefined; note = `its ${constraints.length} sketch constraint${constraints.length === 1 ? ' was' : 's were'} dropped (Onshape couldn't solve them); the geometry is exact but not constrained` } catch (e) { error = (e as Error).message }
      }
      const featureId = res?.feature?.featureId ? String(res.feature.featureId) : fids.get(d.planId)
      if (featureId) fids.set(d.planId, featureId)
      const st = status()
      results.push({ planId: d.planId, name: d.name, featureId, status: st, error, note })
      if (error || st === 'ERROR' || st === 'REJECTED') { ok = false; break outer }
    }
  }

  // ---- assembly: instances of the parts, placed, then mated
  let assemblyId = o.previous?.assemblyId
  if (ok && plan.assembly?.instances?.length) {
    try {
      assemblyId = await buildAssembly()
    } catch (e) {
      ok = false
      notes.push(`Assembly: ${(e as Error).message}`)
    }
  }

  async function buildAssembly(): Promise<string> {
    const a = plan.assembly!
    const partsPath = `/partstudios/${dwvme(ref)}/featurescript`
    const partIdsOf = async (planId: string): Promise<string[]> => {
      const f = fids.get(planId)
      if (!f) return []
      const r = await post<Record<string, any>>(partsPath, { script: idsOf(f, 'BODY'), queries: {} }, ref.origin)
      const v = fsValue(r?.result)
      return Array.isArray(v) ? v.map(String) : []
    }
    let asm = assemblyId
    if (!asm) {
      o.progress?.('Onshape: creating the assembly…')
      const made = await post<Record<string, any>>(`/assemblies/d/${ref.did}/w/${ref.wvmid}`, { name: (a.name ?? `${plan.name} assembly`).slice(0, 100) }, ref.origin)
      asm = String(made?.id ?? '')
      if (!asm) throw new OnshapeError('Onshape did not create the assembly.', 0)
    } else {
      notes.push('The assembly from the earlier build was kept as it is (instances and mates are only added on the first build).')
      return asm
    }
    const parts = (await get<Array<Record<string, any>>>(`/parts/${dwvme(ref)}`, undefined, ref.origin)) ?? []
    const asmPath = `/assemblies/d/${ref.did}/w/${ref.wvmid}/e/${asm}`
    const placed = new Map<string, string[]>()
    for (const inst of a.instances) {
      let partId = parts.find((p) => String(p.name ?? '').toLowerCase() === inst.part.toLowerCase())?.partId as string | undefined
      if (!partId && fids.has(inst.part)) partId = (await partIdsOf(inst.part))[0]
      if (!partId) throw new OnshapeError(`no part "${inst.part}" (parts: ${parts.map((p) => p.name).join(', ') || 'none'}).`, 0)
      for (let k = 0; k < Math.min(50, inst.count ?? 1); k++) {
        o.progress?.(`Onshape: inserting ${inst.id}…`)
        await post(`${asmPath}/instances`, { documentId: ref.did, elementId: ref.eid, partId, isAssembly: false, isWholePartStudio: false, includePartTypes: ['PARTS'] }, ref.origin)
      }
      placed.set(inst.id, [partId])
    }
    // Instance ids, in insertion order per part.
    const def = await get<Record<string, any>>(asmPath, { includeMateFeatures: false }, ref.origin)
    const all = ((def?.rootAssembly?.instances ?? []) as Array<Record<string, any>>)
    const byPart = new Map<string, string[]>()
    for (const i of all) { const k = String(i.partId ?? ''); byPart.set(k, [...(byPart.get(k) ?? []), String(i.id)]) }
    const instanceIds = new Map<string, string[]>()
    for (const inst of a.instances) {
      const pid = placed.get(inst.id)![0]
      const list = byPart.get(pid) ?? []
      instanceIds.set(inst.id, list.splice(0, inst.count ?? 1))
      byPart.set(pid, list)
    }
    for (const inst of a.instances) {
      if (!inst.offset_mm) continue
      const [x, y, z] = inst.offset_mm.map((v) => v / 1000)
      for (const id of instanceIds.get(inst.id) ?? []) await post(`${asmPath}/occurrencetransforms`, { isRelative: true, occurrences: [{ path: [id] }], transform: [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1] }, ref.origin)
    }
    for (const [n, mate] of (a.mates ?? []).entries()) {
      const connector = async (side: { instance: string; face_of: string }, k: number): Promise<string> => {
        const f = fids.get(side.face_of)
        const path = instanceIds.get(side.instance)?.[0]
        if (!f || !path) throw new OnshapeError(`mate ${n + 1}: can't find ${!f ? `feature ${side.face_of}` : `instance ${side.instance}`}.`, 0)
        let faces = fsValue((await post<Record<string, any>>(partsPath, { script: idsOf(f, 'FACE', true), queries: {} }, ref.origin))?.result)
        if (!Array.isArray(faces) || !faces.length) faces = fsValue((await post<Record<string, any>>(partsPath, { script: idsOf(f, 'FACE'), queries: {} }, ref.origin))?.result)
        const face = Array.isArray(faces) ? String(faces[0] ?? '') : ''
        if (!face) throw new OnshapeError(`mate ${n + 1}: feature ${side.face_of} has no faces to put a mate connector on.`, 0)
        const r = await post<Record<string, any>>(`${asmPath}/features`, {
          feature: {
            btType: 'BTMMateConnector-66', featureType: 'mateConnector', name: `${mate.name ?? `Mate ${n + 1}`} ${k ? 'B' : 'A'}`,
            parameters: [
              { btType: 'BTMParameterEnum-145', enumName: 'Origin type', value: 'ON_ENTITY', parameterId: 'originType' },
              { btType: 'BTMParameterQueryWithOccurrenceList-67', parameterId: 'originQuery', queries: [{ btType: 'BTMInferenceQueryWithOccurrence-1083', inferenceType: 'CENTROID', path: [path], deterministicIds: [face] }] }
            ]
          }
        }, ref.origin)
        const id = r?.feature?.featureId
        if (!id) throw new OnshapeError(`mate ${n + 1}: Onshape did not create the mate connector.`, 0)
        return String(id)
      }
      const a1 = await connector(mate.a, 0)
      const b1 = await connector(mate.b, 1)
      const r = await post<Record<string, any>>(`${asmPath}/features`, {
        feature: {
          btType: 'BTMMate-64', featureType: 'mate', name: mate.name ?? `${mate.type.toLowerCase()} ${n + 1}`,
          parameters: [
            { btType: 'BTMParameterEnum-145', enumName: 'Mate type', value: mate.type, parameterId: 'mateType' },
            { btType: 'BTMParameterQueryWithOccurrenceList-67', parameterId: 'mateConnectorsQuery', queries: [a1, b1].map((id) => ({ btType: 'BTMFeatureQueryWithOccurrence-157', path: [], featureId: id, queryData: '' })) }
          ]
        }
      }, ref.origin)
      const st = String(r?.featureState?.featureStatus ?? 'UNKNOWN')
      results.push({ planId: `mate:${n + 1}`, name: mate.name ?? `${mate.type} mate`, featureId: r?.feature?.featureId, status: st })
      if (st === 'ERROR') throw new OnshapeError(`the ${mate.type} mate "${mate.name ?? n + 1}" did not solve.`, 0)
    }
    return asm
  }

  return {
    ref, assemblyId, created, documentName, features: results, ok, calls, notes,
    url: onshapeUrl(ref),
    assemblyUrl: assemblyId ? onshapeUrl({ ...ref, eid: assemblyId }) : undefined
  }
}

// ---------------------------------------------------------------- verification reads

export interface Measured {
  bbox_mm?: [number, number, number]
  box?: Box
  volume_mm3?: number
  mass_g?: number
  massMissing?: boolean
  parts?: string[]
  errors: string[]
  interferences?: number
  minGap_mm?: number
  images: string[]
  notes: string[]
  calls: number
}

/** Reads what was built: size, volume, parts, feature errors, clashes between parts, and pictures. */
export async function measureOnshape(client: OnshapeClient, ref: DocRef, o: { views?: string[]; signal?: AbortSignal; assemblyId?: string } = {}): Promise<Measured> {
  let calls = 0
  const out: Measured = { errors: [], images: [], notes: [], calls: 0 }
  const get = <T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> => { calls++; return client.get<T>(path, { origin: ref.origin, query, signal: o.signal }) }
  const tryRead = async (what: string, f: () => Promise<void>): Promise<void> => { try { await f() } catch (e) { out.notes.push(`${what}: ${(e as Error).message.slice(0, 200)}`) } }
  await tryRead('Feature tree', async () => {
    const body = await get<Record<string, any>>(`/partstudios/${dwvme(ref)}/features`, { includeGeometryIds: false, noSketchGeometry: true })
    const names = new Map(((body?.features ?? []) as Array<Record<string, any>>).map((f) => [String(f.featureId), String(f.name)]))
    for (const [id, st] of Object.entries((body?.featureStates ?? {}) as Record<string, any>)) if (st?.featureStatus === 'ERROR') out.errors.push(`${names.get(id) ?? id} is in error`)
  })
  await tryRead('Bounding box', async () => {
    const b = await get<Box>(`/partstudios/${dwvme(ref)}/boundingboxes`, { includeHidden: false })
    if ([b?.lowX, b?.lowY, b?.lowZ, b?.highX, b?.highY, b?.highZ].every((x) => typeof x === 'number')) {
      out.box = b
      out.bbox_mm = [(b.highX! - b.lowX!) * 1000, (b.highY! - b.lowY!) * 1000, (b.highZ! - b.lowZ!) * 1000].map((x) => Number(x.toFixed(4))) as [number, number, number]
    }
  })
  await tryRead('Mass properties', async () => {
    const m = pickMass(await get(`/partstudios/${dwvme(ref)}/massproperties`, { massAsGroup: true, useMassPropertyOverrides: true }))
    if (m?.volume?.[0] !== undefined) out.volume_mm3 = Number((m.volume[0] * 1e9).toFixed(3))
    if (m?.mass?.[0] && m.hasMass !== false) out.mass_g = Number((m.mass[0] * 1000).toFixed(3))
    out.massMissing = m?.hasMass === false || (m?.massMissingCount ?? 0) > 0
  })
  await tryRead('Parts', async () => {
    const parts = (await get<Array<Record<string, any>>>(`/parts/${dwvme(ref)}`)) ?? []
    out.parts = parts.map((p) => String(p.name ?? p.partId))
  })
  if ((out.parts?.length ?? 0) >= 2) {
    await tryRead('Interference check', async () => {
      calls++
      const r = await client.post<Record<string, any>>(`/partstudios/${dwvme(ref)}/featurescript`, { script: CLASH_SCRIPT, queries: {} }, { origin: ref.origin, signal: o.signal })
      const v = fsValue(r?.result) as Record<string, unknown> | null
      if (v && typeof v === 'object') {
        out.interferences = Number(v.interferences ?? 0)
        const gap = Number(v.minGap)
        if (Number.isFinite(gap) && gap >= 0) out.minGap_mm = Number((gap * 1000).toFixed(4))
      }
    })
  }
  for (const view of (o.views?.length ? o.views : ['isometric']).slice(0, 4)) {
    await tryRead(`Shaded ${view} view`, async () => {
      const res = await get<{ images?: string[][] | string[] }>(`/partstudios/${dwvme(ref)}/shadedviews`, { viewMatrix: SHADED_VIEWS[view] ?? SHADED_VIEWS.isometric, outputWidth: 800, outputHeight: 600, pixelSize: 0, edges: 'show', useAntiAliasing: true })
      const first = res?.images?.[0]
      const b64 = Array.isArray(first) ? first[0] : first
      if (typeof b64 === 'string' && b64) out.images.push(`data:image/png;base64,${b64}`)
    })
  }
  out.calls = calls
  return out
}
