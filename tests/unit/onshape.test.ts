import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { explainStatus, OnshapeClient, ONSHAPE_API_VERSION } from '../../src/main/cad/onshape-client'
import { clean, configInputs, featureRows, fmt, formatAssembly, formatBox, formatFeatures, formatMass, fsRefusal, fsValue, pickMass, variableFeatures, variableTables } from '../../src/main/cad/onshape-format'
import { basicAuth, createSignature, makeNonce, signedHeaders, stringToSign } from '../../src/main/cad/onshape-sign'
import { onshapeOrigin, onshapeUrl, parseOnshapeUrl, refFromArgs } from '../../src/main/cad/onshape-url'
import { decide } from '../../src/main/agent/permissions'
import { configUpdateBody, featureProblem, mergedVariables, onshapeEffect, onshapeTool, planVariableChanges, resolveConfigValues, testOnshapeKeys, unitProblem, type OnshapeArgs } from '../../src/main/agent/tools/onshape'
import { emptyState, type ToolContext, type ToolDef } from '../../src/main/agent/types'

const DID = '0123456789abcdef01234567'
const WID = '1123456789abcdef01234567'
const PS = '2123456789abcdef01234567'
const ASM = '3123456789abcdef01234567'
const VS = '4123456789abcdef01234567'
const DRW = '5123456789abcdef01234567'
const VID = '6123456789abcdef01234567'
const KEYS = { accessKey: 'ACCESSKEY0123456789', secretKey: 'S3cr3t-secret-key-for-tests' }
const url = (eid: string, wvm = 'w', id = WID): string => `https://cad.onshape.com/documents/${DID}/${wvm}/${id}/e/${eid}`

// ---------------------------------------------------------------- signing

describe('Onshape request signing', () => {
  test('signs the documented string: method, nonce, date, content type, path, query, trailing newline, lowercased', () => {
    const i = { method: 'GET', url: 'https://cad.onshape.com/api/v17/documents?q=Robot%20Arm&limit=20', nonce: 'AbCdEfGhIjKlMnOpQrStUvWxY', date: 'Mon, 11 Apr 2016 20:08:56 GMT', contentType: 'application/json' }
    const expected = 'get\nabcdefghijklmnopqrstuvwxy\nmon, 11 apr 2016 20:08:56 gmt\napplication/json\n/api/v17/documents\nq=robot%20arm&limit=20\n'
    expect(stringToSign(i)).toBe(expected)
    // Fixture computed independently from the literal string above.
    const hmac = createHmac('sha256', KEYS.secretKey).update(expected).digest('base64')
    expect(createSignature({ ...i, ...KEYS })).toBe(`On ${KEYS.accessKey}:HmacSHA256:${hmac}`)
  })
  test('a URL without a query signs an empty query line', () => {
    expect(stringToSign({ method: 'POST', url: 'https://cad.onshape.com/api/v17/documents/d/x/versions', nonce: 'n', date: 'd', contentType: 'application/json' })).toBe('post\nn\nd\napplication/json\n/api/v17/documents/d/x/versions\n\n')
  })
  test('nonces are 25 alphanumeric characters and unique; headers carry the date they were signed with', () => {
    const a = makeNonce(), b = makeNonce()
    expect(a).toMatch(/^[A-Za-z0-9]{25}$/)
    expect(a).not.toBe(b)
    const now = new Date('2026-11-14T12:00:00Z')
    const h = signedHeaders({ method: 'GET', url: 'https://cad.onshape.com/api/v17/users/sessioninfo', contentType: 'application/json', ...KEYS, now, nonce: 'N'.repeat(25) })
    expect(h.Date).toBe('Sat, 14 Nov 2026 12:00:00 GMT')
    expect(h['On-Nonce']).toBe('N'.repeat(25))
    expect(h.Authorization).toBe(createSignature({ method: 'GET', url: 'https://cad.onshape.com/api/v17/users/sessioninfo', nonce: 'N'.repeat(25), date: h.Date, contentType: 'application/json', ...KEYS }))
    expect(basicAuth('a', 'b')).toBe(`Basic ${Buffer.from('a:b').toString('base64')}`)
  })
})

// ---------------------------------------------------------------- URLs

describe('Onshape URLs', () => {
  test('parses workspace, version and microversion URLs, enterprise stacks and /documents/d/ links', () => {
    expect(parseOnshapeUrl(url(PS))).toEqual({ did: DID, wvm: 'w', wvmid: WID, eid: PS, origin: 'https://cad.onshape.com' })
    expect(parseOnshapeUrl(`https://acme.onshape.com/documents/${DID}/v/${VID}/e/${ASM}?configuration=default#x`)).toEqual({ did: DID, wvm: 'v', wvmid: VID, eid: ASM, origin: 'https://acme.onshape.com' })
    expect(parseOnshapeUrl(`cad.onshape.com/documents/${DID}/m/${VID}`)).toEqual({ did: DID, wvm: 'm', wvmid: VID, origin: 'https://cad.onshape.com' })
    expect(parseOnshapeUrl(`https://cad.onshape.com/documents/d/${DID}/w/${WID}`)?.wvmid).toBe(WID)
    expect(parseOnshapeUrl(`https://cad.onshape.com/documents/${DID.toUpperCase()}`)).toEqual({ did: DID, origin: 'https://cad.onshape.com' })
  })
  test('rejects other hosts and malformed ids', () => {
    expect(parseOnshapeUrl(`https://cad.onshape.com.evil.com/documents/${DID}/w/${WID}`)).toBeNull()
    expect(parseOnshapeUrl(`https://onshape.com/documents/${DID}`)).toBeNull()
    expect(parseOnshapeUrl(`https://evil.com/documents/${DID}/w/${WID}/e/${PS}`)).toBeNull()
    expect(parseOnshapeUrl(`https://cad.onshape.com/documents/${DID}/w/notanid`)).toBeNull()
    expect(parseOnshapeUrl('https://cad.onshape.com/documents/123')).toBeNull()
    expect(onshapeOrigin('cad.onshape.com')).toBe('https://cad.onshape.com')
    expect(onshapeOrigin('x.onshape.com.attacker.net')).toBeNull()
  })
  test('ids can come separately and fill in or override; mistakes are explained', () => {
    expect(refFromArgs({ document_id: DID, workspace_id: WID, element_id: PS })).toEqual({ did: DID, wvm: 'w', wvmid: WID, eid: PS, origin: 'https://cad.onshape.com' })
    expect(refFromArgs({ url: `https://cad.onshape.com/documents/${DID}/w/${WID}`, element_id: VS }).eid).toBe(VS)
    expect(() => refFromArgs({ url: 'https://example.com/x' })).toThrow(/not an Onshape document URL/)
    expect(() => refFromArgs({ document_id: 'abc' })).toThrow(/24 hex/)
    expect(() => refFromArgs({})).toThrow(/Name the Onshape document/)
    expect(() => refFromArgs({ document_id: DID, workspace_id: WID, version_id: VID })).toThrow(/not both/)
    expect(onshapeUrl({ did: DID, wvm: 'v', wvmid: VID, eid: ASM })).toBe(`https://cad.onshape.com/documents/${DID}/v/${VID}/e/${ASM}`)
  })
})

// ---------------------------------------------------------------- request building and errors

describe('Onshape client requests', () => {
  test('builds versioned URLs on the document stack, never off onshape.com', () => {
    const c = new OnshapeClient({ keys: () => KEYS })
    expect(ONSHAPE_API_VERSION).toBe('v17')
    expect(c.url('/documents', { query: { q: 'arm v2', limit: 20, skip: undefined } })).toBe('https://cad.onshape.com/api/v17/documents?q=arm+v2&limit=20')
    expect(c.url(`/parts/d/${DID}/w/${WID}/e/${PS}`, { origin: 'https://acme.onshape.com', rawQuery: 'configuration=List_abc%3D_500_mm' })).toBe(`https://acme.onshape.com/api/v17/parts/d/${DID}/w/${WID}/e/${PS}?configuration=List_abc%3D_500_mm`)
    expect(c.url('/x', { origin: 'https://evil.example.com', query: { partId: ['a', 'b'] } })).toBe('https://cad.onshape.com/api/v17/x?partId=a&partId=b')
  })
  test('errors say what to fix', () => {
    expect(explainStatus(401, '')).toMatch(/dev-portal\.onshape\.com\/keys/)
    expect(explainStatus(401, '')).toMatch(/clock/)
    expect(explainStatus(403, 'nope')).toMatch(/Write.*edit access|shared with the account/)
    expect(explainStatus(404, '')).toMatch(/check the document URL/)
    expect(explainStatus(429, '', 30)).toMatch(/Wait about 30 s/)
    expect(explainStatus(402, '')).toMatch(/annual API call allowance/)
  })
  test('missing keys say how to set them up', async () => {
    const c = new OnshapeClient({ keys: () => undefined })
    await expect(c.get('/documents')).rejects.toThrow(/Settings → Models & Keys → Advanced → Keys for tools \(Onshape\)/)
  })
})

// ---------------------------------------------------------------- summaries

const FEATURES = {
  btType: 'BTFeatureListResponse-2457', rollbackIndex: -1,
  features: [
    { btType: 'BTMSketch-151', name: 'Layout', featureId: 'F1', featureType: 'newSketch', suppressed: false, parameters: [] },
    { btType: 'BTMFeature-134', name: 'Plate extrude', featureId: 'F2', featureType: 'extrude', suppressed: false, parameters: [
      { btType: 'BTMParameterEnum-145', parameterId: 'operationType', value: 'NEW' },
      { btType: 'BTMParameterQueryList-148', parameterId: 'entities', queries: [{}, {}] },
      { btType: 'BTMParameterQuantity-147', parameterId: 'depth', expression: '#plate_t', value: 0.00635 },
      { btType: 'BTMParameterBoolean-144', parameterId: 'hasSecondDirection', value: false }
    ] },
    { btType: 'BTMFeature-134', name: 'Arm length', featureId: 'F3', featureType: 'assignVariable', suppressed: false, parameters: [
      { btType: 'BTMParameterEnum-145', parameterId: 'variableType', value: 'LENGTH' },
      { btType: 'BTMParameterString-149', parameterId: 'name', value: 'arm_len' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'lengthValue', expression: '24 in' }
    ] },
    { btType: 'BTMFeature-134', name: 'Broken fillet', featureId: 'F4', featureType: 'fillet', suppressed: true, parameters: [] }
  ],
  featureStates: { F1: { featureStatus: 'OK' }, F2: { featureStatus: 'OK' }, F3: { featureStatus: 'OK' }, F4: { featureStatus: 'ERROR' } }
}

describe('Onshape summaries', () => {
  test('feature tree: type, suppressed, errors and key parameters, compact', () => {
    const rows = featureRows(FEATURES)
    expect(rows[0]).toMatchObject({ index: 1, type: 'sketch', name: 'Layout' })
    expect(rows[1].params).toEqual(['operationType=NEW', 'entities: 2 selected', 'depth=#plate_t', 'hasSecondDirection=false'])
    const t = formatFeatures(FEATURES, { elementName: 'Arm' })
    expect(t).toContain('4. Broken fillet · fillet · [SUPPRESSED, ERROR]')
    expect(t).toMatch(/⚠ 1 feature has errors/)
    expect(t).toContain('1 suppressed feature')
    expect(variableFeatures(FEATURES)).toEqual([{ name: 'arm_len', value: '24 in', type: 'LENGTH', featureName: 'Arm length' }])
  })
  test('mass properties in SI become lb/in and kg/mm; missing materials are flagged', () => {
    const body = { bodies: { '-all-': { mass: [10, 9.9, 10.1], volume: [0.0037, 0.0037, 0.0037], centroid: [0.0254, 0, 0.254, 0, 0, 0, 0, 0, 0], inertia: [1, 0, 0, 0, 2, 0, 0, 0, 3, ...Array(18).fill(0)], principalInertia: [1, 2, 3], hasMass: true, massMissingCount: 2 } } }
    const t = formatMass(pickMass(body), { units: 'both', label: 'Robot' })
    expect(t).toContain('Mass: 22.046 lb (10 kg)')
    expect(t).toContain('Center of mass (x, y, z from the origin): 1 in (25.4 mm), 0 in (0 mm), 10 in (254 mm)')
    expect(t).toContain('[3417.2, 0, 0; 0, 6834.3, 0; 0, 0, 10251.5]')
    expect(t).toMatch(/2 parts have no material/)
    expect(formatMass(pickMass({ mass: [1], volume: [0.001] }), { units: 'metric' })).toContain('Mass: 1 kg')
  })
  test('bounding boxes, values and small helpers', () => {
    expect(formatBox({ lowX: 0, lowY: 0, lowZ: 0, highX: 0.0254, highY: 0.0508, highZ: 0.762 }, { units: 'imperial' })).toContain('1 in × 2 in × 30 in')
    expect(fmt(0.000123456)).toBe('0.00012346')
    expect(clean('a\nb\u0000c'.padEnd(200, 'x'), 10)).toBe('a b cxxxx…')
    expect(fsValue({ btType: 'BTFSValueMap-2062', value: [
      { key: { btType: 'BTFSValueString-1422', value: 'minCorner' }, value: { btType: 'BTFSValueArray-1499', value: [{ btType: 'BTFSValueWithUnits-1817', value: 0.1, unitToPower: { METER: 1 } }] } },
      { key: { btType: 'BTFSValueString-1422', value: 'n' }, value: { btType: 'BTFSValueNumber-772', value: 3 } }
    ] })).toEqual({ minCorner: [{ value: 0.1, units: 'm' }], n: 3 })
  })
  test('assembly: instances grouped with counts, mates by type', () => {
    const t = formatAssembly({ rootAssembly: { instances: [
      { name: 'MAXSwerve Module <1>', type: 'Assembly' }, { name: 'MAXSwerve Module <2>', type: 'Assembly' }, { name: 'Bellypan <1>', type: 'Part', suppressed: true }
    ], features: [
      { featureType: 'mate', id: 'm1', featureData: { name: 'Fastened 1', mateType: 'FASTENED' } },
      { featureType: 'mate', id: 'm2', featureData: { name: 'Revolute 1', mateType: 'REVOLUTE' }, status: 'ERROR' }
    ] }, subAssemblies: [{}], parts: [{}, {}] }, 'Robot')
    expect(t).toContain('- MAXSwerve Module ×2 (Assembly)')
    expect(t).toContain('Bellypan ×1 (Part, 1 suppressed)')
    expect(t).toContain('Mates: 2 (fastened 1, revolute 1)')
    expect(t).toMatch(/1 mate\/feature with errors: Revolute 1/)
  })
  test('FeatureScript: lambdas that only query run; anything that builds geometry is refused', () => {
    expect(fsRefusal('function(context is Context, queries) { return evVolume(context, { "entities" : qEverything(EntityType.BODY) }); }')).toBeNull()
    expect(fsRefusal('function(context is Context, queries) { opExtrude(context, id, {}); }')).toMatch(/opExtrude/)
    expect(fsRefusal('function(context is Context, queries) { setVariable(context, "x", 1); }')).toMatch(/setVariable/)
    expect(fsRefusal('evVolume(context, {})')).toMatch(/must be a lambda/)
    expect(fsRefusal('')).toMatch(/empty/)
  })
})

// ---------------------------------------------------------------- change planning

describe('Onshape change planning', () => {
  const current = [{ name: 'arm_len', type: 'LENGTH', expression: '24 in' }, { name: 'gear_teeth', type: 'NUMBER', expression: '48' }, { name: 'tilt', type: 'ANGLE', expression: '15 deg', description: 'pivot' }]
  test('old → new per variable; bare numbers for lengths, unknown names without a type and bad names are refused', () => {
    expect(planVariableChanges(current, [{ name: '#arm_len', expression: '26 in' }]).rows).toEqual([{ name: 'arm_len', type: 'LENGTH', old: '24 in', next: '26 in', description: undefined }])
    expect(planVariableChanges(current, [{ name: 'arm_len', expression: '26' }]).errors[0]).toMatch(/no units/)
    expect(planVariableChanges(current, [{ name: 'gear_teeth', expression: '52' }]).errors).toEqual([])
    expect(planVariableChanges(current, [{ name: 'new_one', expression: '1 in' }]).errors[0]).toMatch(/give its type/)
    expect(planVariableChanges(current, [{ name: 'bad name', expression: '1 in' }]).errors[0]).toMatch(/not a valid variable name/)
    expect(unitProblem('ANGLE', '#a + 5 deg')).toBeNull()
  })
  test('the posted table keeps every other variable (setVariables replaces the whole table)', () => {
    const plan = planVariableChanges(current, [{ name: 'arm_len', expression: '26 in' }, { name: 'spacer', expression: '0.5 in', type: 'LENGTH' }])
    expect(mergedVariables(current, plan.rows)).toEqual([
      { name: 'arm_len', type: 'LENGTH', expression: '26 in', description: '' },
      { name: 'gear_teeth', type: 'NUMBER', expression: '48', description: '' },
      { name: 'tilt', type: 'ANGLE', expression: '15 deg', description: 'pivot' },
      { name: 'spacer', type: 'LENGTH', expression: '0.5 in', description: '' }
    ])
  })
  const CONFIG = {
    configurationParameters: [
      { btType: 'BTMConfigurationParameterEnum-105', parameterId: 'Ratio', parameterName: 'Gear ratio', defaultValue: 'R9', options: [{ option: 'R9', optionName: '9:1' }, { option: 'R12', optionName: '12:1' }] },
      { btType: 'BTMConfigurationParameterQuantity-1826', parameterId: 'Len', parameterName: 'Tube length', quantityType: 'LENGTH', rangeAndDefault: { minValue: 1, maxValue: 40, defaultValue: 20, units: 'inch' } },
      { btType: 'BTMConfigurationParameterBoolean-2550', parameterId: 'Pocket', parameterName: 'Pocketed', defaultValue: true }
    ],
    currentConfiguration: [
      { btType: 'BTMParameterEnum-145', parameterId: 'Ratio', value: 'R9', enumName: 'Ratio_conf' },
      { btType: 'BTMParameterQuantity-147', parameterId: 'Len', expression: '20 in', value: 0.508 },
      { btType: 'BTMParameterBoolean-144', parameterId: 'Pocket', value: true }
    ],
    serializationVersion: '1.2.3', sourceMicroversion: 'mv1'
  }
  test('configuration values resolve by name or id; enum options by name', () => {
    const inputs = configInputs(CONFIG)
    expect(inputs.map((c) => [c.id, c.kind, c.current])).toEqual([['Ratio', 'enum', 'R9'], ['Len', 'quantity', '20 in'], ['Pocket', 'boolean', 'true']])
    const r = resolveConfigValues(inputs, { 'gear ratio': '12:1', Len: '24 in', pocketed: false })
    expect(r.errors).toEqual([])
    expect(r.entries.map((e) => [e.parameterId, e.parameterValue])).toEqual([['Ratio', 'R12'], ['Len', '24 in'], ['Pocket', 'false']])
    expect(resolveConfigValues(inputs, { Ratio: '7:1' }).errors[0]).toMatch(/not an option.*9:1, 12:1/)
    expect(resolveConfigValues(inputs, { Len: '24' }).errors[0]).toMatch(/no units/)
    expect(resolveConfigValues(inputs, { Nope: 'x' }).errors[0]).toMatch(/No configuration input/)
    const body = configUpdateBody(CONFIG, r.entries) as { btType: string; currentConfiguration: Array<Record<string, unknown>>; sourceMicroversion: string }
    expect(body.btType).toBe('BTConfigurationUpdateCall-2933')
    expect(body.sourceMicroversion).toBe('mv1')
    expect(body.currentConfiguration).toEqual([
      { btType: 'BTMParameterEnum-145', parameterId: 'Ratio', value: 'R12', enumName: 'Ratio_conf' },
      { btType: 'BTMParameterQuantity-147', isInteger: false, parameterId: 'Len', expression: '24 in' },
      { btType: 'BTMParameterBoolean-144', parameterId: 'Pocket', value: false }
    ])
  })
  test('feature JSON is checked before it is sent', () => {
    expect(featureProblem({ btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube 1', parameters: [] })).toBeNull()
    expect(featureProblem({ featureType: 'cube', name: 'x' })).toMatch(/btType/)
    expect(featureProblem({ btType: 'BTMFeature-134', name: 'x' })).toMatch(/featureType/)
    expect(featureProblem([])).toMatch(/JSON object/)
  })
})

// ---------------------------------------------------------------- approval and effects

describe('Onshape approvals', () => {
  const tool = onshapeTool({ keys: () => KEYS, workspace: () => tmpdir() })
  const effect = (a: Partial<OnshapeArgs>): string => (tool.effect as (a: OnshapeArgs, c: { roots: string[] }) => string)(a as OnshapeArgs, { roots: [] })
  test('reads are reads; previews are reads; applying changes, features and versions are outside actions; exports write locally', () => {
    for (const action of ['documents', 'document', 'parts', 'features', 'variables', 'configuration', 'mass_properties', 'bounding_box', 'assembly', 'thumbnail', 'eval_featurescript', 'versions'] as const) expect(effect({ action })).toBe('read')
    expect(effect({ action: 'set_variables' })).toBe('read')
    expect(effect({ action: 'set_variables', apply: true })).toBe('write_external')
    expect(effect({ action: 'set_configuration', apply: true })).toBe('write_external')
    expect(effect({ action: 'add_feature' })).toBe('write_external')
    expect(effect({ action: 'create_version' })).toBe('write_external')
    expect(effect({ action: 'export' })).toBe('write_local')
    expect(onshapeEffect({ action: 'set_configuration', apply: false })).toBe('read')
    expect(tool.consequential!({} as OnshapeArgs, { threadId: 't' })).toBe(true)
    expect(tool.core).toBeFalsy()
    expect(tool.group).toBe('CAD')
    expect(tool.untrusted).toBe(true)
  })
  test('every CAD change asks in Ask mode; Auto makes it unless outside content steered it; previews and reads run', () => {
    const base = { tool: 'onshape', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true }
    expect(decide({ ...base, mode: 'auto', effect: 'write_external' }).verdict).toBe('allow')
    expect(decide({ ...base, mode: 'auto', effect: 'write_external', tainted: true }).verdict).toBe('ask')
    expect(decide({ ...base, mode: 'auto', effect: 'destructive' }).verdict).toBe('allow')
    expect(decide({ ...base, mode: 'ask', effect: 'destructive' }).verdict).toBe('ask')
    expect(decide({ ...base, mode: 'ask', effect: 'write_external' }).verdict).toBe('ask')
    expect(decide({ ...base, mode: 'auto', effect: 'read' }).verdict).toBe('allow')
    expect(decide({ ...base, mode: 'auto', effect: 'write_local' }).verdict).toBe('allow')
  })
})

// ---------------------------------------------------------------- fake Onshape server

interface Seen { method: string; path: string; query: string; body?: unknown; signed: boolean }

function verify(req: IncomingMessage, secret: string, access: string): boolean {
  const auth = String(req.headers.authorization ?? '')
  const m = /^On ([^:]+):HmacSHA256:(.+)$/.exec(auth)
  if (!m || m[1] !== access) return false
  const u = new URL(req.url!, 'http://x')
  const nonce = String(req.headers['on-nonce'] ?? '')
  if (!/^[A-Za-z0-9]{16,}$/.test(nonce)) return false
  const str = `${req.method}\n${nonce}\n${req.headers.date}\n${req.headers['content-type']}\n${u.pathname}\n${u.search.slice(1)}\n`.toLowerCase()
  return createHmac('sha256', secret).update(str).digest('base64') === m[2]
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

function fakeOnshape(): { server: Server; seen: Seen[]; state: { vars: Array<Record<string, string>>; polls: number; limited: boolean; config: any } } {
  const state = {
    vars: [{ name: 'arm_len', type: 'LENGTH', expression: '24 in', description: 'pivot to tip' }, { name: 'teeth', type: 'NUMBER', expression: '48', description: '' }] as Array<Record<string, string>>,
    polls: 0, limited: true,
    config: {
      configurationParameters: [{ btType: 'BTMConfigurationParameterEnum-105', parameterId: 'Ratio', parameterName: 'Gear ratio', defaultValue: 'R9', options: [{ option: 'R9', optionName: '9:1' }, { option: 'R12', optionName: '12:1' }] }],
      currentConfiguration: [{ btType: 'BTMParameterEnum-145', parameterId: 'Ratio', value: 'R9' }], sourceMicroversion: 'mv1'
    } as any
  }
  const seen: Seen[] = []
  const P = `/api/${ONSHAPE_API_VERSION}`
  const els = [
    { id: PS, name: 'Arm', elementType: 'PARTSTUDIO' }, { id: ASM, name: 'Robot', elementType: 'ASSEMBLY' },
    { id: VS, name: 'Robot Variables', elementType: 'VARIABLESTUDIO' }, { id: DRW, name: 'Plate drawing', elementType: 'DRAWING' }
  ]
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x')
      const p = u.pathname
      const body = raw ? JSON.parse(raw) : undefined
      const signed = verify(req, KEYS.secretKey, KEYS.accessKey)
      seen.push({ method: req.method!, path: p, query: u.search.slice(1), body, signed })
      const json = (code: number, v: unknown): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
      if (!signed) return json(401, { message: 'Unauthenticated API request', status: 401 })
      const ws = `${P}/documents/d/${DID}/w/${WID}`
      const e = (eid: string): string => `d/${DID}/w/${WID}/e/${eid}`
      const route = `${req.method} ${p}`
      switch (route) {
        case `GET ${P}/users/sessioninfo`: return json(200, { name: 'Team 9999 CAD', id: 'u1' })
        case `GET ${P}/documents`:
          if (state.limited) { state.limited = false; res.writeHead(429, { 'retry-after': '1' }); return res.end('{}') }
          return json(200, { items: [{ id: DID, name: '2026 Robot', owner: { name: 'Team 9999' }, modifiedAt: '2026-11-01T10:00:00Z', defaultWorkspace: { id: WID } }] })
        case `GET ${P}/documents/${DID}`: return json(200, { id: DID, name: '2026 Robot', defaultWorkspace: { id: WID } })
        case `GET ${P}/documents/d/${DID}/workspaces`: return json(200, [{ id: WID, name: 'Main', isReadOnly: false }])
        case `GET ${ws}/elements`: return json(200, u.searchParams.get('elementId') ? els.filter((x) => x.id === u.searchParams.get('elementId')) : els)
        case `GET ${P}/variables/${e(VS)}/variables`: return json(200, [{ variables: state.vars.map((v) => ({ ...v, value: v.expression })) }])
        case `POST ${P}/variables/${e(VS)}/variables`: state.vars = body; return json(200, {})
        case `GET ${P}/elements/${e(VS)}/configuration`: return json(200, { configurationParameters: [], currentConfiguration: [] })
        case `GET ${P}/elements/${e(PS)}/configuration`: return json(200, state.config)
        case `POST ${P}/elements/${e(PS)}/configuration`: state.config = { ...state.config, currentConfiguration: body.currentConfiguration }; return json(200, state.config)
        case `POST ${P}/elements/d/${DID}/e/${PS}/configurationencodings`: return json(200, { encodedId: `Ratio=${body.parameters[0].parameterValue}`, queryParam: `configuration=Ratio%3D${body.parameters[0].parameterValue}` })
        case `GET ${P}/parts/${e(PS)}`: return json(200, [{ partId: 'JHD', name: 'Arm plate', material: { displayName: 'Aluminum - 6061' }, appearance: { color: { red: 255, green: 128, blue: 0 }, opacity: 255 } }, { partId: 'JHK', name: 'Spacer' }])
        case `GET ${P}/partstudios/${e(PS)}/features`: return json(200, FEATURES)
        case `GET ${P}/partstudios/${e(PS)}/massproperties`: return json(200, { bodies: { '-all-': { mass: [1.5, 1.5, 1.5], volume: [0.00055], centroid: [0, 0, 0.1], hasMass: true, massMissingCount: 0 } } })
        case `GET ${P}/assemblies/${e(ASM)}/massproperties`: return json(200, { mass: [52.2, 52, 52.4], volume: [0.02], centroid: [0, 0, 0.15], hasMass: false, massMissingCount: 3 })
        case `GET ${P}/assemblies/${e(ASM)}/boundingboxes`: return json(200, { lowX: -0.4, lowY: -0.4, lowZ: 0, highX: 0.4, highY: 0.4, highZ: 1.2 })
        case `GET ${P}/assemblies/${e(ASM)}`: return json(200, { rootAssembly: { instances: [{ name: 'Arm <1>', type: 'Part' }], features: [] }, subAssemblies: [], parts: [{}] })
        case `POST ${P}/partstudios/${e(PS)}/translations`: return json(200, { id: 'tr1', requestState: 'ACTIVE' })
        case `GET ${P}/translations/tr1`:
          state.polls++
          return json(200, state.polls < 3 ? { id: 'tr1', requestState: 'ACTIVE' } : { id: 'tr1', requestState: 'DONE', resultExternalDataIds: ['fid1'], resultDocumentId: DID })
        case `GET ${P}/documents/d/${DID}/externaldata/fid1`: res.writeHead(307, { location: `${P}/blobs/fid1?sig=abc` }); return res.end()
        case `GET ${P}/blobs/fid1`: res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end('ISO-10303-21;\nHEADER;\nENDSEC;\n')
        case `GET ${P}/partstudios/${e(PS)}/shadedviews`: return json(200, { images: [[PNG.toString('base64')]] })
        case `POST ${P}/partstudios/${e(PS)}/featurescript`: return json(200, { result: { btType: 'BTFSValueWithUnits-1817', value: 0.00055, unitToPower: { METER: 3 } }, console: '', notices: [] })
        case `POST ${P}/partstudios/${e(PS)}/features`: return json(200, { feature: { ...body.feature, featureId: 'FNEW' }, featureState: { featureStatus: 'OK' } })
        case `GET ${P}/documents/d/${DID}/versions`: return json(200, [{ id: VID, name: 'V1 kickoff', createdAt: '2026-01-10T12:00:00Z', creator: { name: 'Sam' } }])
        case `POST ${P}/documents/d/${DID}/versions`: return json(200, { id: VID, name: body.name })
        default: return json(404, { message: `No route ${route}` })
      }
    })
  })
  return { server, seen, state }
}

describe('onshape tool against a fake Onshape server', () => {
  let fake: ReturnType<typeof fakeOnshape>
  let origin = ''
  let ws = ''
  let tool: ToolDef<OnshapeArgs>
  const ctx = (): ToolContext => ({ threadId: 't1', signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, askUser: async () => '', state: emptyState(), loadTools: () => [], searchTools: () => [], readResult: () => undefined })
  const call = (a: OnshapeArgs) => tool.run(a, ctx())
  beforeAll(async () => {
    fake = fakeOnshape()
    await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', () => r()))
    origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => fake.server.close(() => r())))
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'onshape-ws-'))
    tool = onshapeTool({ keys: () => KEYS, workspace: () => ws, testOrigin: origin, sleep: async () => undefined })
    fake.seen.length = 0
  })

  test('every request is HMAC-signed the way Onshape checks it (the fake server verifies each one)', async () => {
    const out = await call({ action: 'documents', query: 'Robot' })
    expect(out.text).toContain('2026 Robot (owner Team 9999), modified 2026-11-01')
    expect(out.text).toContain(`https://cad.onshape.com/documents/${DID}/w/${WID}`)
    // First answer was a 429 with Retry-After: 1; the client waited and retried once.
    expect(fake.seen.filter((s) => s.path.endsWith('/documents')).length).toBe(2)
    expect(fake.seen.every((s) => s.signed)).toBe(true)
    expect(fake.seen[0].query).toBe('q=Robot&sortColumn=modifiedAt&sortOrder=desc&limit=20')
  })

  test('wrong keys get a 401 that says how to fix them; Test reports the account', async () => {
    const bad = onshapeTool({ keys: () => ({ ...KEYS, secretKey: 'wrong' }), workspace: () => ws, testOrigin: origin })
    await expect(bad.run({ action: 'document', url: url(PS) }, ctx())).rejects.toThrow(/401 Unauthorized.*dev-portal\.onshape\.com\/keys/)
    expect(await testOnshapeKeys({ keys: () => KEYS, testOrigin: origin })).toEqual({ ok: true, name: 'Team 9999 CAD' })
    expect((await testOnshapeKeys({ keys: () => undefined, testOrigin: origin })).ok).toBe(false)
  })

  test('document lists workspaces and tabs with their types and URLs', async () => {
    const out = await call({ action: 'document', url: `https://cad.onshape.com/documents/${DID}` })
    expect(out.text).toContain('Workspaces (editable branches): Main [default]')
    expect(out.text).toMatch(/- Variable Studio: Robot Variables .*\/e\/4123/)
    expect(out.text).toContain(`- Part Studio: Arm  https://cad.onshape.com/documents/${DID}/w/${WID}/e/${PS}`)
    expect(out.text.indexOf('Variable Studio')).toBeLessThan(out.text.indexOf('Part Studio'))
  })

  test('parts, features, mass properties, bounding box and assembly reads are compact', async () => {
    expect((await call({ action: 'parts', url: url(PS) })).text).toMatch(/JHD · Arm plate · Aluminum - 6061 · #ff8000[\s\S]*1 part has no material/)
    expect((await call({ action: 'features', url: url(PS) })).text).toContain('2. Plate extrude · extrude · operationType=NEW')
    expect((await call({ action: 'mass_properties', url: url(PS), units: 'imperial' })).text).toContain('Mass: 3.307 lb')
    const asm = await call({ action: 'mass_properties', url: url(ASM) })
    expect(asm.text).toContain('Mass: 115.1 lb (52.2 kg)')
    expect(asm.text).toMatch(/3 parts have no material.*sub-assemblies/)
    expect((await call({ action: 'bounding_box', url: url(ASM), units: 'imperial' })).text).toContain('31.496 in × 31.496 in × 47.244 in')
    expect((await call({ action: 'assembly', url: url(ASM) })).text).toContain('- Arm ×1 (Part)')
    await expect(call({ action: 'features', url: url(ASM) })).rejects.toThrow(/"Robot" is a Assembly; features works on Part Studio tabs/)
  })

  test('a configuration is encoded by Onshape and passed to reads without changing anything', async () => {
    const out = await call({ action: 'parts', url: url(PS), configuration: { 'Gear ratio': '12:1' } })
    expect(out.text).toContain('Configuration: Gear ratio=R12')
    const partsCall = fake.seen.find((s) => s.path.endsWith(`/parts/d/${DID}/w/${WID}/e/${PS}`))!
    expect(partsCall.query).toBe('configuration=Ratio%3DR12')
    expect(fake.seen.some((s) => s.method === 'POST' && s.path.endsWith('/configuration'))).toBe(false)
  })

  test('set_variables previews old → new, then applies with the whole table kept and re-read', async () => {
    const preview = await call({ action: 'set_variables', url: url(VS), variables: [{ name: 'arm_len', expression: '26 in' }] })
    expect(preview.text).toContain('Preview only, nothing changed yet.')
    expect(preview.text).toContain('#arm_len (LENGTH): 24 in → 26 in')
    expect(fake.seen.some((s) => s.method === 'POST')).toBe(false)
    // The approval card for the real change shows document, element and old → new.
    const card = tool.describe!({ action: 'set_variables', url: url(VS), variables: [{ name: 'arm_len', expression: '26 in' }], apply: true })
    expect(card).toBe('Change Onshape variables in "Robot Variables" in "2026 Robot" (workspace): #arm_len: 24 in → 26 in')
    const done = await call({ action: 'set_variables', url: url(VS), variables: [{ name: 'arm_len', expression: '26 in' }], apply: true })
    expect(done.text).toContain('Changed 1 variable in "Robot Variables" in "2026 Robot"')
    const post = fake.seen.find((s) => s.method === 'POST' && s.path.endsWith('/variables'))!
    expect(post.body).toEqual([{ name: 'arm_len', type: 'LENGTH', expression: '26 in', description: 'pivot to tip' }, { name: 'teeth', type: 'NUMBER', expression: '48', description: '' }])
    expect(fake.state.vars[0].expression).toBe('26 in')
  })

  test('writes never go to a version; set_variables only writes Variable Studios', async () => {
    await expect(call({ action: 'set_variables', url: url(VS, 'v', VID), variables: [{ name: 'arm_len', expression: '26 in' }], apply: true })).rejects.toThrow(/version \(a read-only snapshot\)/)
    await expect(call({ action: 'add_feature', url: url(PS, 'v', VID), feature: { btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube 1' } })).rejects.toThrow(/read-only snapshot/)
    await expect(call({ action: 'set_variables', url: url(PS), variables: [{ name: 'x', expression: '1 in' }], apply: true })).rejects.toThrow(/set_variables works on Variable Studio tabs/)
    expect(fake.seen.some((s) => s.method === 'POST')).toBe(false)
    expect(tool.describe!({ action: 'set_variables', url: url(VS, 'v', VID), variables: [{ name: 'a', expression: '1 in' }], apply: true })).toMatch(/a version: will be refused/)
  })

  test('set_configuration previews, then posts the updated current configuration', async () => {
    const pre = await call({ action: 'set_configuration', url: url(PS), values: { 'Gear ratio': '12:1' } })
    expect(pre.text).toContain('- Gear ratio: R9 → 12:1')
    expect(tool.describe!({ action: 'set_configuration', url: url(PS), values: { 'Gear ratio': '12:1' }, apply: true })).toBe('Change the default configuration of "Arm" in "2026 Robot" (workspace): Gear ratio: R9 → 12:1')
    const done = await call({ action: 'set_configuration', url: url(PS), values: { 'Gear ratio': '12:1' }, apply: true })
    expect(done.text).toContain('Gear ratio: now R12')
    const post = fake.seen.find((s) => s.method === 'POST' && s.path.endsWith(`/elements/d/${DID}/w/${WID}/e/${PS}/configuration`))!
    expect((post.body as { btType: string }).btType).toBe('BTConfigurationUpdateCall-2933')
  })

  test('export starts a translation, polls until DONE, follows the signed redirect and saves into exports/onshape', async () => {
    const progress: string[] = []
    const out = await tool.run({ action: 'export', url: url(PS), format: 'STEP' }, { ...ctx(), progress: (t) => progress.push(t) })
    expect(out.path).toBe(join(ws, 'exports', 'onshape', '2026 Robot - Arm.step'))
    expect(readFileSync(out.path!, 'utf8')).toContain('ISO-10303-21')
    expect(out.text).toMatch(/export from a named version/)
    const start = fake.seen.find((s) => s.method === 'POST' && s.path.endsWith('/translations'))!
    expect(start.body).toEqual({ formatName: 'STEP', storeInDocument: false })
    expect(fake.seen.filter((s) => s.path.endsWith('/translations/tr1')).length).toBe(3)
    // The redirect target was signed again (and the server checked it).
    expect(fake.seen.find((s) => s.path.endsWith('/blobs/fid1'))?.signed).toBe(true)
    expect(progress.some((p) => /active/.test(p))).toBe(true)
    await expect(call({ action: 'export', url: url(PS), format: 'PDF' })).rejects.toThrow(/PDF export works on Drawing tabs/)
  })

  test('thumbnail returns an image; FeatureScript returns values with units; refused scripts never reach Onshape', async () => {
    const pic = await call({ action: 'thumbnail', url: url(PS), view: 'front' })
    expect(pic.images?.[0]).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
    expect(fake.seen.find((s) => s.path.endsWith('/shadedviews'))?.query).toContain('viewMatrix=front')
    const fs = await call({ action: 'eval_featurescript', url: url(PS), script: 'function(context is Context, queries) { return evVolume(context, { "entities" : qEverything(EntityType.BODY) }); }' })
    expect(fs.text).toContain('{"value":0.00055,"units":"m^3"}')
    fake.seen.length = 0
    await expect(call({ action: 'eval_featurescript', url: url(PS), script: 'function(context is Context, queries) { opDeleteBodies(context, id, {}); }' })).rejects.toThrow(/Refused/)
    expect(fake.seen.some((s) => s.path.endsWith('/featurescript'))).toBe(false)
  })

  test('add_feature posts a BTFeatureDefinitionCall and reports status; versions list and create', async () => {
    const feature = { btType: 'BTMFeature-134', featureType: 'cube', name: 'Cube 1', parameters: [{ btType: 'BTMParameterQuantity-147', parameterId: 'sideLength', expression: '1 in', isInteger: false }] }
    await call({ action: 'features', url: url(PS) })
    expect(tool.describe!({ action: 'add_feature', url: url(PS), feature })).toBe('Add a feature to "Arm" in "2026 Robot" (workspace): Cube 1 (cube): sideLength=1 in')
    const out = await call({ action: 'add_feature', url: url(PS), feature })
    expect(out.text).toContain('featureId FNEW, status OK')
    expect(fake.seen.find((s) => s.method === 'POST' && s.path.endsWith('/features'))?.body).toEqual({ btType: 'BTFeatureDefinitionCall-1406', feature })
    expect((await call({ action: 'versions', url: url(PS) })).text).toContain('V1 kickoff · 2026-01-10 12:00 · Sam')
    const v = await call({ action: 'create_version', url: url(PS), name: 'Week 3 - for manufacturing' })
    expect(v.text).toContain(`/documents/${DID}/v/${VID}`)
    expect(fake.seen.find((s) => s.method === 'POST' && s.path.endsWith('/versions'))?.body).toEqual({ documentId: DID, workspaceId: WID, name: 'Week 3 - for manufacturing', description: '' })
  })

  test('variables: Variable Studio table, and a Part Studio\'s #variable features', async () => {
    expect((await call({ action: 'variables', url: url(VS) })).text).toContain('- #arm_len (LENGTH) = ')
    expect((await call({ action: 'variables', url: url(PS) })).text).toContain('- #arm_len (LENGTH) = 24 in')
    expect(variableTables([{ variableStudioReference: { referenceElementId: VS }, variables: [{ name: 'a', type: 'NUMBER', expression: '1' }] }]).referenced[0].from).toBe(VS)
  })
})
