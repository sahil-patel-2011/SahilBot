import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// A stateful stand-in for Onshape's REST API (v17) for CAD tests: it verifies every request's HMAC signature
// the way Onshape does, keeps documents, tabs and feature lists, and answers with the request/response shapes
// of the public OpenAPI spec (BTDocumentInfo, BTFeatureDefinitionResponse-1617, BTFeatureSpecsResponse-664,
// BTBoundingBoxInfo, mass properties, shaded views). Geometry is computed for the features tests use: a cube
// (sideLength, through #variables) with a fillet on its edges. A fillet radius of half the side or more fails
// to regenerate, like the real thing.

export const FAKE_KEYS = { accessKey: 'ACCESSKEY0123456789', secretKey: 'S3cr3t-secret-key-for-tests' }
export const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')

export interface Seen { method: string; path: string; query: string; body?: any; signed: boolean }

interface Feature { featureId: string; feature: Record<string, any>; status: 'OK' | 'ERROR' }
interface Element { id: string; name: string; elementType: string; features: Feature[]; instances: Array<Record<string, any>>; contents?: string }
interface Doc { id: string; name: string; wid: string; elements: Element[] }

export interface FakeOnshape {
  url: string
  seen: Seen[]
  docs: Map<string, Doc>
  close(): Promise<void>
}

const hex24 = (n: number, p: string): string => `${p}${n.toString(16).padStart(24 - p.length, '0')}`

function verify(req: IncomingMessage): boolean {
  const auth = String(req.headers.authorization ?? '')
  const m = /^On ([^:]+):HmacSHA256:(.+)$/.exec(auth)
  if (!m || m[1] !== FAKE_KEYS.accessKey) return false
  const u = new URL(req.url!, 'http://x')
  const nonce = String(req.headers['on-nonce'] ?? '')
  if (!/^[A-Za-z0-9]{16,}$/.test(nonce)) return false
  const str = `${req.method}\n${nonce}\n${req.headers.date}\n${req.headers['content-type']}\n${u.pathname}\n${u.search.slice(1)}\n`.toLowerCase()
  return createHmac('sha256', FAKE_KEYS.secretKey).update(str).digest('base64') === m[2]
}

const spec = (featureType: string, params: Array<[string, string, string?, string[]?]>): Record<string, unknown> => ({
  btType: 'BTFeatureSpec-129', featureType, featureTypeName: featureType,
  parameters: params.map(([parameterId, kind, enumName, options]) => ({ btType: `BTParameterSpec${kind}`, parameterId, ...(enumName ? { enumName, namespace: '', options } : {}) }))
})

/** Feature specs in the BTFeatureSpecsResponse-664 shape, for the features the CAD workflow uses. */
export const FEATURE_SPECS = {
  btType: 'BTFeatureSpecsResponse-664',
  featureSpecs: [
    spec('cube', [['sideLength', 'Quantity-173']]),
    spec('newSketch', [['sketchPlane', 'Query-174']]),
    spec('extrude', [['bodyType', 'Enum-171', 'ExtendedToolBodyType', ['SOLID', 'SURFACE', 'THIN']], ['operationType', 'Enum-171', 'NewBodyOperationType', ['NEW', 'ADD', 'REMOVE', 'INTERSECT']], ['entities', 'Query-174'], ['endBound', 'Enum-171', 'BoundingType', ['BLIND', 'SYMMETRIC', 'UP_TO_NEXT', 'UP_TO_SURFACE', 'UP_TO_BODY', 'UP_TO_VERTEX', 'THROUGH_ALL']], ['depth', 'Quantity-173'], ['oppositeDirection', 'Boolean-170']]),
    spec('fillet', [['entities', 'Query-174'], ['radius', 'Quantity-173']]),
    spec('chamfer', [['entities', 'Query-174'], ['chamferType', 'Enum-171', 'ChamferType', ['EQUAL_OFFSETS', 'TWO_OFFSETS', 'OFFSET_ANGLE']], ['width', 'Quantity-173']]),
    spec('shell', [['entities', 'Query-174'], ['thickness', 'Quantity-173']]),
    spec('linearPattern', [['patternType', 'Enum-171', 'PatternType', ['PART', 'FEATURE', 'FACE']], ['entities', 'Query-174'], ['directionOne', 'Query-174'], ['distance', 'Quantity-173'], ['instanceCount', 'Quantity-173'], ['oppositeDirection', 'Boolean-170']]),
    spec('circularPattern', [['patternType', 'Enum-171', 'PatternType', ['PART', 'FEATURE', 'FACE']], ['entities', 'Query-174'], ['axis', 'Query-174'], ['angle', 'Quantity-173'], ['instanceCount', 'Quantity-173'], ['equalSpace', 'Boolean-170']]),
    spec('mirror', [['patternType', 'Enum-171', 'MirrorType', ['PART', 'FEATURE', 'FACE']], ['entities', 'Query-174'], ['mirrorPlane', 'Query-174']]),
    spec('assignVariable', [['name', 'String-172'], ['variableType', 'Enum-171', 'VariableType', ['LENGTH', 'ANGLE', 'NUMBER', 'ANY']], ['lengthValue', 'Quantity-173'], ['angleValue', 'Quantity-173'], ['numberValue', 'Quantity-173'], ['description', 'String-172']])
  ]
}

/** A length expression in mm: "40 mm", "1.5 in", "#side", "#side / 8". */
function mmOf(expr: string, vars: Record<string, number>): number {
  const s = expr.replace(/#(\w+)/g, (_, n) => (n in vars ? `${vars[n]} mm` : 'NaN')).trim()
  const m = /^([\d.]+) ?(mm|in|m)(?: ?([*/]) ?([\d.]+))?$/.exec(s)
  if (!m) return NaN
  const v = Number(m[1]) * (m[2] === 'in' ? 25.4 : m[2] === 'm' ? 1000 : 1)
  return m[3] === '*' ? v * Number(m[4]) : m[3] === '/' ? v / Number(m[4]) : v
}
const param = (f: Record<string, any>, id: string): Record<string, any> | undefined => (f.parameters ?? []).find((p: any) => p.parameterId === id)

/** Size and volume of a Part Studio's features (cube + fillet); undefined when nothing solid is there. */
export function geometry(el: Element): { side: number; volume: number; error?: string } | undefined {
  const vars: Record<string, number> = {}
  let side = 0
  let volume = 0
  for (const f of el.features) {
    const x = f.feature
    if (x.featureType === 'assignVariable') vars[param(x, 'name')?.value] = mmOf(String(param(x, 'lengthValue')?.expression ?? ''), vars)
    if (x.featureType === 'cube') { side = mmOf(String(param(x, 'sideLength')?.expression ?? ''), vars); volume = side ** 3 }
    if (x.featureType === 'fillet' && side) {
      const r = mmOf(String(param(x, 'radius')?.expression ?? ''), vars)
      if (!(r > 0) || r >= side / 2) { f.status = 'ERROR'; continue }
      volume -= 12 * (side - 2 * r) * (r * r - (Math.PI * r * r) / 4) + 8 * (r ** 3 - (Math.PI * r ** 3) / 6)
    }
  }
  return side > 0 ? { side, volume } : undefined
}

export async function startFakeOnshape(): Promise<FakeOnshape> {
  const seen: Seen[] = []
  const docs = new Map<string, Doc>()
  let n = 0
  const P = '/api/v17'
  const newDoc = (name: string): Doc => {
    n++
    const d: Doc = { id: hex24(n, 'd'), name, wid: hex24(n, 'a'), elements: [] }
    d.elements.push({ id: hex24(n, 'b'), name: 'Part Studio 1', elementType: 'PARTSTUDIO', features: [], instances: [] }, { id: hex24(n, 'c'), name: 'Assembly 1', elementType: 'ASSEMBLY', features: [], instances: [] })
    docs.set(d.id, d)
    return d
  }
  let fseq = 0
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x')
      const p = u.pathname
      let body: any
      try { body = raw ? JSON.parse(raw) : undefined } catch { body = raw }
      const signed = verify(req)
      seen.push({ method: req.method!, path: p, query: u.search.slice(1), body, signed })
      const json = (code: number, v: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (!signed) return json(401, { message: 'Unauthenticated API request', status: 401 })
      if (!p.startsWith(P)) return json(404, { message: 'wrong API version' })
      const path = p.slice(P.length)
      let m: RegExpExecArray | null
      const docOr404 = (did: string): Doc | undefined => docs.get(did)
      const el = (d: Doc, eid: string): Element | undefined => d.elements.find((e) => e.id === eid)

      if (req.method === 'GET' && path === '/users/sessioninfo') return json(200, { name: 'Fake CAD user', id: 'u1' })
      if (req.method === 'POST' && path === '/documents') {
        const d = newDoc(String(body?.name ?? 'Untitled'))
        return json(200, { id: d.id, name: d.name, jsonType: 'document', defaultWorkspace: { id: d.wid, name: 'Main' }, defaultElementId: d.elements[0].id })
      }
      if ((m = /^\/documents\/(\w{24})$/.exec(path)) && req.method === 'GET') {
        const d = docOr404(m[1]); if (!d) return json(404, { message: 'no document' })
        return json(200, { id: d.id, name: d.name, defaultWorkspace: { id: d.wid } })
      }
      if ((m = /^\/documents\/d\/(\w{24})\/w\/(\w{24})\/elements$/.exec(path)) && req.method === 'GET') {
        const d = docOr404(m[1]); if (!d) return json(404, { message: 'no document' })
        const want = u.searchParams.get('elementId')
        return json(200, d.elements.filter((e) => !want || e.id === want).map((e) => ({ id: e.id, name: e.name, elementType: e.elementType })))
      }
      if ((m = /^\/(partstudios|assemblies|featurestudios)\/d\/(\w{24})\/w\/(\w{24})$/.exec(path)) && req.method === 'POST') {
        const d = docOr404(m[2]); if (!d) return json(404, { message: 'no document' })
        n++
        const e: Element = { id: hex24(n, 'e'), name: String(body?.name ?? 'Tab'), elementType: m[1] === 'partstudios' ? 'PARTSTUDIO' : m[1] === 'assemblies' ? 'ASSEMBLY' : 'FEATURESTUDIO', features: [], instances: [] }
        d.elements.push(e)
        return json(200, { id: e.id, name: e.name, elementType: e.elementType })
      }
      if ((m = /^\/variables\/d\/(\w{24})\/w\/(\w{24})\/variablestudio$/.exec(path)) && req.method === 'POST') {
        const d = docOr404(m[1]); if (!d) return json(404, { message: 'no document' })
        n++
        const e: Element = { id: hex24(n, 'f'), name: String(body?.name), elementType: 'VARIABLESTUDIO', features: [], instances: [] }
        d.elements.push(e)
        return json(200, { id: e.id, name: e.name })
      }
      if ((m = /^\/featurestudios\/d\/(\w{24})\/w\/(\w{24})\/e\/(\w{24})$/.exec(path))) {
        const d = docOr404(m[1]); const e = d && el(d, m[3]); if (!e) return json(404, { message: 'no element' })
        if (req.method === 'GET') return json(200, { btType: 'BTFeatureStudioContents-2239', contents: e.contents ?? 'FeatureScript 2144;\nimport(path : "onshape/std/common.fs", version : "2144.0");\n', serializationVersion: '1.2.3', sourceMicroversion: 'mv1' })
        if (body?.serializationVersion !== '1.2.3' || body?.sourceMicroversion !== 'mv1') return json(400, { message: 'missing serializationVersion/sourceMicroversion' })
        e.contents = body.contents
        return json(200, { btType: 'BTFeatureStudioContents-2239', contents: e.contents, notices: [] })
      }
      // Part Studio and assembly features
      if ((m = /^\/(partstudios|assemblies)\/d\/(\w{24})\/([wvm])\/(\w{24})\/e\/(\w{24})\/(features|featurespecs|boundingboxes|massproperties|shadedviews|featurescript|instances|occurrencetransforms|translations)(?:\/featureid\/(\w+))?$/.exec(path)) || (m = /^\/(assemblies)\/d\/(\w{24})\/([wvm])\/(\w{24})\/e\/(\w{24})()$/.exec(path))) {
        const [, kind, did, , , eid, what, fid] = m
        const d = docOr404(did); const e = d && el(d, eid); if (!e) return json(404, { message: `no element ${eid}` })
        if (what === 'featurespecs') return json(200, FEATURE_SPECS)
        if (what === 'features' && req.method === 'GET') {
          geometry(e)
          return json(200, { features: e.features.map((f) => ({ ...f.feature, featureId: f.featureId })), featureStates: Object.fromEntries(e.features.map((f) => [f.featureId, { featureStatus: f.status }])), defaultFeatures: [] })
        }
        if (what === 'features' && req.method === 'POST') {
          const feature = kind === 'partstudios' ? body?.feature : body?.feature
          if (kind === 'partstudios' && body?.btType !== 'BTFeatureDefinitionCall-1406') return json(400, { message: 'expected BTFeatureDefinitionCall-1406' })
          if (!feature?.btType) return json(400, { message: 'feature.btType missing' })
          if (feature.btType === 'BTMSketch-151' && (feature.constraints ?? []).some((c: any) => c.constraintType === 'FIX')) return json(400, { message: 'Could not solve sketch constraints' })
          if (fid) {
            const f = e.features.find((x) => x.featureId === fid)
            if (!f) return json(404, { message: 'no feature' })
            f.feature = { ...feature }
            f.status = 'OK'
            geometry(e)
            return json(200, { feature: { ...f.feature, featureId: fid }, featureState: { featureStatus: f.status }, serializationVersion: '1.2.3', sourceMicroversion: 'mv2' })
          }
          const f: Feature = { featureId: `F${(++fseq).toString(36)}`, feature: { ...feature }, status: 'OK' }
          e.features.push(f)
          geometry(e)
          return json(200, { feature: { ...f.feature, featureId: f.featureId }, featureState: { featureStatus: f.status }, serializationVersion: '1.2.3', sourceMicroversion: 'mv2' })
        }
        if (what === 'features' && req.method === 'DELETE') {
          const i = e.features.findIndex((x) => x.featureId === fid)
          if (i < 0) return json(404, { message: 'no feature' })
          e.features.splice(i, 1)
          return json(200, {})
        }
        if (what === 'boundingboxes') {
          const g = geometry(e)
          if (!g) return json(200, {})
          const s = g.side / 1000
          return json(200, { btType: 'BTBoundingBoxInfo', lowX: 0, lowY: 0, lowZ: 0, highX: s, highY: s, highZ: s })
        }
        if (what === 'massproperties') {
          const g = geometry(e)
          return json(200, { bodies: { '-all-': { mass: [0, 0, 0], volume: [(g?.volume ?? 0) / 1e9], centroid: [0.02, 0.02, 0.02], hasMass: false, massMissingCount: g ? 1 : 0 } } })
        }
        if (what === 'shadedviews') return json(200, { images: [TINY_PNG.toString('base64')] })
        if (what === 'featurescript') {
          const s = String(body?.script ?? '')
          if (/evCollision/.test(s)) return json(200, { result: { btType: 'BTFSValueMap-1062', value: [{ key: { btType: 'BTFSValueString-1422', value: 'bodies' }, value: { btType: 'BTFSValueNumber-772', value: 1 } }, { key: { btType: 'BTFSValueString-1422', value: 'interferences' }, value: { btType: 'BTFSValueNumber-772', value: 0 } }, { key: { btType: 'BTFSValueString-1422', value: 'minGap' }, value: { btType: 'BTFSValueNumber-772', value: -1 } }] }, notices: [] })
          if (/transientQueriesToStrings/.test(s)) return json(200, { result: { btType: 'BTFSValueArray-1499', value: [{ btType: 'BTFSValueString-1422', value: /FACE/.test(s) ? 'JFC' : 'JHD' }] } })
          return json(200, { result: { btType: 'BTFSValueNumber-772', value: 1 } })
        }
        if (what === 'instances') { e.instances.push({ id: `I${e.instances.length + 1}`, partId: body?.partId, name: `Part <${e.instances.length + 1}>`, type: 'Part' }); return json(200, {}) }
        if (what === 'occurrencetransforms') return json(200, {})
        if (what === '' && req.method === 'GET') return json(200, { rootAssembly: { instances: e.instances, features: [] }, subAssemblies: [], parts: [] })
        if (what === 'translations') return json(200, { id: 'tr1', requestState: 'DONE', resultExternalDataIds: ['fid1'], resultDocumentId: did })
      }
      if ((m = /^\/parts\/d\/(\w{24})\/w\/(\w{24})\/e\/(\w{24})$/.exec(path))) {
        const d = docOr404(m[1]); const e = d && el(d, m[3]); if (!e) return json(404, { message: 'no element' })
        return json(200, geometry(e) ? [{ partId: 'JHD', name: 'Part 1', bodyType: 'solid' }] : [])
      }
      if (path === '/translations/tr1') return json(200, { id: 'tr1', requestState: 'DONE', resultExternalDataIds: ['fid1'] })
      if ((m = /^\/documents\/d\/(\w{24})\/externaldata\/fid1$/.exec(path))) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('ISO-10303-21;\nHEADER;\nENDSEC;\n') }
      return json(404, { message: `No route ${req.method} ${path}` })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen, docs,
    close: () => new Promise<void>((r) => server.close(() => r()))
  }
}
