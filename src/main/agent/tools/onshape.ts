import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolEffect } from '@shared/types'
import { KEYS_URL, OnshapeClient, OnshapeError, type OnshapeKeys, type TranslationInfo } from '../../cad/onshape-client'
import {
  clean, configInputs, documentList, elementList, featureSummary, formatAssembly, formatBox, formatConfiguration, formatDocument, formatDocuments, formatFeatures,
  formatMass, formatParts, formatVariables, formatVersions, fsRefusal, fsValue, pickMass, prettyType, variableFeatures, variableTables,
  type Box, type ConfigInput, type ElementSummary, type Units, type VariableRow
} from '../../cad/onshape-format'
import { dwvm, dwvme, onshapeUrl, refFromArgs, type DocRef } from '../../cad/onshape-url'
import type { ToolContext, ToolDef, ToolOutput } from '../types'

// Onshape CAD through its REST API with the user's API keys (Settings → API Keys & Servers → Onshape).
// Reads are free to run. Anything that changes the user's CAD (variables, configuration defaults, a new
// feature, a new version) is an outside action that always asks, goes to a workspace only (never a
// version), and shows the document, element and old → new values on the approval card. Exports are
// saved into the workspace's exports/onshape folder.

export const ONSHAPE_ACTIONS = [
  'documents', 'document', 'parts', 'features', 'variables', 'set_variables', 'configuration', 'set_configuration',
  'mass_properties', 'bounding_box', 'assembly', 'export', 'thumbnail', 'eval_featurescript', 'add_feature', 'versions', 'create_version'
] as const
export type OnshapeAction = typeof ONSHAPE_ACTIONS[number]

export const EXPORT_FORMATS = {
  STEP: { formatName: 'STEP', ext: 'step', for: ['PARTSTUDIO', 'ASSEMBLY'] },
  STL: { formatName: 'STL', ext: 'stl', for: ['PARTSTUDIO', 'ASSEMBLY'] },
  PARASOLID: { formatName: 'PARASOLID', ext: 'x_t', for: ['PARTSTUDIO', 'ASSEMBLY'] },
  PDF: { formatName: 'PDF', ext: 'pdf', for: ['DRAWING'] },
  DWG: { formatName: 'DWG', ext: 'dwg', for: ['DRAWING'] },
  DXF: { formatName: 'DXF', ext: 'dxf', for: ['DRAWING'] }
} as const
export type ExportFormat = keyof typeof EXPORT_FORMATS

/** Named views for thumbnails; isometric is Onshape's documented approximate matrix. */
const VIEWS: Record<string, string> = { isometric: '0.612,0.612,0,0,-0.354,0.354,0.707,0,0.707,-0.707,0.707,0', top: 'top', bottom: 'bottom', front: 'front', back: 'back', left: 'left', right: 'right' }

export interface OnshapeArgs {
  action: OnshapeAction
  url?: string
  document_id?: string
  workspace_id?: string
  version_id?: string
  element_id?: string
  query?: string
  configuration?: Record<string, string | number | boolean>
  variables?: Array<{ name: string; expression: string; type?: 'LENGTH' | 'ANGLE' | 'NUMBER' | 'ANY'; description?: string }>
  values?: Record<string, string | number | boolean>
  apply?: boolean
  part_ids?: string[]
  format?: ExportFormat
  export_units?: 'inch' | 'millimeter' | 'meter'
  view?: keyof typeof VIEWS
  script?: string
  feature?: Record<string, unknown>
  name?: string
  description?: string
  units?: Units
  max?: number
}

export interface OnshapeDeps {
  keys: () => OnshapeKeys | undefined
  workspace: () => string
  fetchImpl?: typeof fetch
  /** Tests: a local fake Onshape server. */
  testOrigin?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

const WRITES = new Set<OnshapeAction>(['set_variables', 'set_configuration', 'add_feature', 'create_version'])

/** What a call does to the world: previews (no apply) are reads; exports write a local file; CAD changes are outside actions. */
export function onshapeEffect(a: Pick<OnshapeArgs, 'action' | 'apply'>): ToolEffect {
  if (a.action === 'set_variables' || a.action === 'set_configuration') return a.apply === true ? 'write_external' : 'read'
  if (a.action === 'add_feature' || a.action === 'create_version') return 'write_external'
  if (a.action === 'export') return 'write_local'
  return 'read'
}

/** Expressions that need units: a LENGTH or ANGLE given as a bare number is almost always a mistake. */
export function unitProblem(type: string | undefined, expression: string): string | null {
  const e = expression.trim()
  if (!e) return 'is empty'
  if (e.length > 300) return 'is longer than 300 characters'
  if ((type === 'LENGTH' || type === 'ANGLE') && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(e)) return `has no units (a ${type.toLowerCase()} needs them, e.g. "${e} ${type === 'LENGTH' ? 'in' : 'deg'}")`
  return null
}

/** Old → new for set_variables, against the current table. Unknown names need a type (they are new variables). */
export function planVariableChanges(current: VariableRow[], changes: NonNullable<OnshapeArgs['variables']>): { rows: Array<{ name: string; type: string; old?: string; next: string; description?: string }>; errors: string[] } {
  const errors: string[] = []
  const rows: Array<{ name: string; type: string; old?: string; next: string; description?: string }> = []
  const seen = new Set<string>()
  for (const c of changes) {
    const name = String(c.name ?? '').replace(/^#/, '').trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { errors.push(`"${clean(c.name, 40)}" is not a valid variable name (letters, digits, underscores; no spaces).`); continue }
    if (seen.has(name)) { errors.push(`#${name} is listed twice.`); continue }
    seen.add(name)
    const cur = current.find((v) => v.name === name)
    const type = cur?.type ?? c.type
    if (!type) { errors.push(`#${name} doesn't exist here. To add it as a new variable, give its type (LENGTH, ANGLE, NUMBER or ANY). Existing: ${current.slice(0, 30).map((v) => `#${v.name}`).join(', ') || 'none'}.`); continue }
    const bad = unitProblem(type, String(c.expression ?? ''))
    if (bad) { errors.push(`#${name}'s expression ${bad}.`); continue }
    rows.push({ name, type, old: cur?.expression, next: String(c.expression).trim(), description: c.description })
  }
  return { rows, errors }
}

/** The full table to POST: Onshape's setVariables replaces the table, so every existing variable is sent back. */
export function mergedVariables(current: VariableRow[], rows: ReturnType<typeof planVariableChanges>['rows']): Array<{ name: string; type: string; expression: string; description: string }> {
  const out = current.map((v) => ({ name: v.name, type: v.type, expression: v.expression, description: v.description ?? '' }))
  for (const r of rows) {
    const i = out.findIndex((v) => v.name === r.name)
    if (i >= 0) out[i] = { ...out[i], expression: r.next, description: r.description ?? out[i].description }
    else out.push({ name: r.name, type: r.type, expression: r.next, description: r.description ?? '' })
  }
  return out
}

/** Configuration values by input name or id → [{ parameterId, parameterValue }] (enum values by option id or name). */
export function resolveConfigValues(inputs: ConfigInput[], values: Record<string, string | number | boolean>): { entries: Array<{ parameterId: string; parameterValue: string; input: ConfigInput }>; errors: string[] } {
  const entries: Array<{ parameterId: string; parameterValue: string; input: ConfigInput }> = []
  const errors: string[] = []
  for (const [k, raw] of Object.entries(values)) {
    const key = k.trim().toLowerCase()
    const input = inputs.find((c) => c.id.toLowerCase() === key) ?? inputs.find((c) => c.name.toLowerCase() === key)
    if (!input) { errors.push(`No configuration input "${clean(k, 40)}". Inputs: ${inputs.map((c) => `${c.name} [${c.id}]`).join(', ') || 'none'}.`); continue }
    const v = String(raw).trim()
    if (input.kind === 'enum') {
      const opt = input.options?.find((o) => o.option.toLowerCase() === v.toLowerCase()) ?? input.options?.find((o) => o.name.toLowerCase() === v.toLowerCase())
      if (!opt) { errors.push(`"${clean(v, 40)}" is not an option of ${input.name}. Options: ${(input.options ?? []).map((o) => o.name).join(', ')}.`); continue }
      entries.push({ parameterId: input.id, parameterValue: opt.option, input })
    } else if (input.kind === 'boolean') {
      if (!/^(true|false)$/i.test(v)) { errors.push(`${input.name} is a checkbox: use true or false.`); continue }
      entries.push({ parameterId: input.id, parameterValue: v.toLowerCase(), input })
    } else if (input.kind === 'quantity') {
      const qt = input.range?.quantityType
      const bad = unitProblem(qt === 'LENGTH' || qt === 'ANGLE' ? qt : undefined, v)
      if (bad) { errors.push(`${input.name} ${bad}.`); continue }
      entries.push({ parameterId: input.id, parameterValue: v, input })
    } else {
      entries.push({ parameterId: input.id, parameterValue: v, input })
    }
  }
  return { entries, errors }
}

/** A configuration GET body with new current values written in, ready to POST back (updateConfiguration). */
export function configUpdateBody(raw: Record<string, any>, entries: Array<{ parameterId: string; parameterValue: string; input: ConfigInput }>): Record<string, unknown> {
  const current = ((raw.currentConfiguration ?? []) as Array<Record<string, any>>).map((p) => ({ ...p }))
  for (const e of entries) {
    const i = current.findIndex((p) => p.parameterId === e.parameterId)
    const base = i >= 0 ? current[i] : undefined
    let next: Record<string, any>
    if (e.input.kind === 'quantity') { next = { btType: 'BTMParameterQuantity-147', isInteger: false, ...base, parameterId: e.parameterId, expression: e.parameterValue }; delete next.value }
    else if (e.input.kind === 'enum') next = { btType: 'BTMParameterEnum-145', ...base, parameterId: e.parameterId, value: e.parameterValue }
    else if (e.input.kind === 'boolean') next = { btType: 'BTMParameterBoolean-144', ...base, parameterId: e.parameterId, value: e.parameterValue === 'true' }
    else next = { btType: 'BTMParameterString-149', ...base, parameterId: e.parameterId, value: e.parameterValue }
    if (i >= 0) current[i] = next
    else current.push(next)
  }
  const body: Record<string, unknown> = { btType: 'BTConfigurationUpdateCall-2933', configurationParameters: raw.configurationParameters ?? [], currentConfiguration: current }
  for (const k of ['serializationVersion', 'sourceMicroversion', 'libraryVersion']) if (raw[k] !== undefined) body[k] = raw[k]
  return body
}

/** A feature JSON the API will take, or why not. */
export function featureProblem(f: unknown): string | null {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return 'feature must be a JSON object (a BTMFeature-134, like the ones action "features" reads).'
  const x = f as Record<string, unknown>
  if (typeof x.btType !== 'string' || !/^BTM(Feature|Sketch)-\d+$/.test(x.btType)) return 'feature.btType must be "BTMFeature-134" (or "BTMSketch-151" for a sketch).'
  if (x.btType.startsWith('BTMFeature') && (typeof x.featureType !== 'string' || !x.featureType)) return 'feature.featureType is required (e.g. "extrude", "cube", "assignVariable").'
  if (typeof x.name !== 'string' || !x.name.trim()) return 'feature.name is required.'
  if (x.parameters !== undefined && !Array.isArray(x.parameters)) return 'feature.parameters must be an array.'
  if (JSON.stringify(f).length > 60_000) return 'feature JSON is too large (max 60,000 characters).'
  return null
}

const safeName = (s: string): string => s.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'onshape'

type Cached<T> = { at: number; value: T }
class Lru<T> {
  private m = new Map<string, Cached<T>>()
  constructor(private max = 300) {}
  get(k: string, maxAgeMs = Infinity): T | undefined {
    const c = this.m.get(k)
    if (!c || Date.now() - c.at > maxAgeMs) return undefined
    return c.value
  }
  set(k: string, v: T): void {
    this.m.delete(k)
    this.m.set(k, { at: Date.now(), value: v })
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!)
  }
}

export function onshapeTool(d: OnshapeDeps): ToolDef<OnshapeArgs> {
  const client = new OnshapeClient({ keys: d.keys, fetchImpl: d.fetchImpl, testOrigin: d.testOrigin, sleep: d.sleep, now: d.now })
  const docNames = new Lru<string>()
  const elements = new Lru<ElementSummary>()
  const readVars = new Lru<VariableRow[]>()
  const readConfig = new Lru<{ inputs: ConfigInput[]; raw: Record<string, any> }>()
  const ekey = (r: DocRef): string => `${r.did}/${r.eid}`
  const vkey = (r: DocRef): string => `${r.did}/${r.wvm}/${r.wvmid}/${r.eid}`

  /** Fills in the default workspace when only the document was named. */
  const complete = async (r: DocRef, ctx: ToolContext): Promise<DocRef> => {
    if (r.wvm && r.wvmid) return r
    const doc = await client.get<Record<string, any>>(`/documents/${r.did}`, { origin: r.origin, signal: ctx.signal })
    if (doc?.name) docNames.set(r.did, clean(doc.name, 100))
    const wid = doc?.defaultWorkspace?.id
    if (typeof wid !== 'string') throw new OnshapeError('That document has no default workspace I can read. Paste the URL of the tab you want (it includes /w/<workspace>/e/<element>).', 0)
    return { ...r, wvm: 'w', wvmid: wid }
  }
  const docName = async (r: DocRef, ctx: ToolContext): Promise<string> => {
    const hit = docNames.get(r.did)
    if (hit) return hit
    try {
      const doc = await client.get<Record<string, any>>(`/documents/${r.did}`, { origin: r.origin, signal: ctx.signal })
      const n = clean(doc?.name ?? r.did, 100)
      docNames.set(r.did, n)
      return n
    } catch { return r.did }
  }
  const element = async (r: DocRef, ctx: ToolContext): Promise<ElementSummary> => {
    if (!r.eid) throw new OnshapeError('Name the tab (element): pass the URL with /e/<element id> (open the tab in the browser and copy the address), or call action "document" to list the elements.', 0)
    const hit = elements.get(ekey(r))
    if (hit) return hit
    const list = elementList(await client.get(`/documents/${dwvm(r)}/elements`, { origin: r.origin, query: { elementId: r.eid }, signal: ctx.signal }))
    const e = list.find((x) => x.id === r.eid) ?? list[0]
    if (!e) throw new OnshapeError(`No element ${r.eid} in that ${r.wvm === 'w' ? 'workspace' : 'version'}. Call action "document" to list the elements.`, 404)
    elements.set(ekey(r), e)
    return e
  }
  const need = (e: ElementSummary, types: string[], action: string): void => {
    if (!types.includes(e.type)) throw new OnshapeError(`"${e.name}" is a ${prettyType(e.type)}; ${action} works on ${types.map(prettyType).join(' or ')} tabs. Call action "document" to find the right tab.`, 0)
  }
  /** Writes go to workspaces only: versions and microversions are immutable history. */
  const requireWorkspace = (r: DocRef): void => {
    if (r.wvm !== 'w') throw new OnshapeError(`That URL points to a ${r.wvm === 'v' ? 'version' : 'microversion'} (a read-only snapshot). Changes only go to a workspace: open the document's workspace in Onshape and paste that URL (it has /w/ in it), or call action "document" to list workspaces.`, 0)
  }
  const label = (doc: string, e?: ElementSummary): string => (e ? `"${e.name}" in "${doc}"` : `"${doc}"`)

  const config = async (r: DocRef, ctx: ToolContext, fresh = false): Promise<{ inputs: ConfigInput[]; raw: Record<string, any> }> => {
    const hit = fresh ? undefined : readConfig.get(vkey(r), 5 * 60_000)
    if (hit) return hit
    const raw = (await client.get<Record<string, any>>(`/elements/${dwvme(r)}/configuration`, { origin: r.origin, signal: ctx.signal })) ?? {}
    const v = { inputs: configInputs(raw), raw }
    readConfig.set(vkey(r), v)
    return v
  }
  /** Onshape's encoded configuration for a read: { encodedId, queryParam }, or undefined when none is asked for. */
  const encode = async (r: DocRef, values: OnshapeArgs['configuration'], ctx: ToolContext): Promise<{ encodedId: string; queryParam: string; text: string } | undefined> => {
    if (!values || !Object.keys(values).length) return undefined
    const { inputs } = await config(r, ctx)
    const { entries, errors } = resolveConfigValues(inputs, values)
    if (errors.length) throw new OnshapeError(errors.join(' '), 0)
    const res = await client.post<{ encodedId?: string; queryParam?: string }>(`/elements/d/${r.did}/e/${r.eid}/configurationencodings`, { parameters: entries.map((e) => ({ parameterId: e.parameterId, parameterValue: e.parameterValue })) }, { origin: r.origin, query: { versionId: r.wvm === 'v' ? r.wvmid : undefined }, signal: ctx.signal })
    if (!res?.encodedId) throw new OnshapeError('Onshape did not encode that configuration.', 0)
    return { encodedId: res.encodedId, queryParam: res.queryParam ?? `configuration=${encodeURIComponent(res.encodedId)}`, text: entries.map((e) => `${e.input.name}=${e.parameterValue}`).join(', ') }
  }

  const ownVariables = async (r: DocRef, ctx: ToolContext): Promise<VariableRow[]> => {
    const t = variableTables(await client.get(`/variables/${dwvme(r)}/variables`, { origin: r.origin, query: { includeValuesAndReferencedVariables: true }, signal: ctx.signal }))
    readVars.set(vkey(r), t.own)
    return t.own
  }

  // ---------------------------------------------------------------- the approval card

  const describe = (a: OnshapeArgs): string => {
    let r: DocRef | undefined
    try { r = refFromArgs(a) } catch { r = undefined }
    const doc = r ? docNames.get(r.did) ?? `document ${r.did}` : 'an Onshape document'
    const el = r?.eid ? elements.get(ekey(r))?.name ?? `element ${r.eid}` : undefined
    const where = `${el ? `"${el}" in ` : ''}${doc.startsWith('document ') ? doc : `"${doc}"`}${r?.wvm && r.wvm !== 'w' ? ` (${r.wvm === 'v' ? 'a version: will be refused' : 'a microversion: will be refused'})` : r?.wvm === 'w' ? ' (workspace)' : ''}`
    switch (a.action) {
      case 'set_variables': {
        const old = r ? readVars.get(vkey(r)) : undefined
        const changes = (a.variables ?? []).map((v) => {
          const name = String(v.name ?? '').replace(/^#/, '')
          const prev = old?.find((x) => x.name === name)?.expression
          return `#${name}: ${prev !== undefined ? `${prev} → ` : old ? '(new) → ' : '→ '}${clean(v.expression, 60)}`
        })
        return `${a.apply ? 'Change' : 'Preview changing'} Onshape variables in ${where}: ${changes.join('; ')}${a.apply && !old ? ' (current values not read yet)' : ''}`
      }
      case 'set_configuration': {
        const cur = r ? readConfig.get(vkey(r))?.inputs : undefined
        const changes = Object.entries(a.values ?? {}).map(([k, v]) => {
          const input = cur?.find((c) => c.id.toLowerCase() === k.toLowerCase() || c.name.toLowerCase() === k.toLowerCase())
          return `${input?.name ?? k}: ${input?.current !== undefined ? `${input.current} → ` : '→ '}${clean(v, 40)}`
        })
        return `${a.apply ? 'Change' : 'Preview changing'} the default configuration of ${where}: ${changes.join('; ')}`
      }
      case 'add_feature': return `Add a feature to ${where}: ${featureSummary(a.feature)}`
      case 'create_version': return `Create version "${clean(a.name, 60)}" of ${where}${a.description ? `: ${clean(a.description, 100)}` : ''}`
      case 'export': return `Export ${el ? `"${el}"` : 'an Onshape element'} as ${a.format ?? '?'} into the workspace exports folder`
      case 'documents': return `Search Onshape documents for "${clean(a.query, 60)}"`
      default: return `Onshape ${a.action.replace(/_/g, ' ')}${el ? ` of "${el}"` : ''}`
    }
  }

  // ---------------------------------------------------------------- actions

  const run = async (a: OnshapeArgs, ctx: ToolContext): Promise<ToolOutput> => {
    const units: Units = a.units ?? 'both'
    if (a.action === 'documents') {
      const origin = a.url ? refFromArgs(a).origin : undefined
      const body = await client.get(`/documents`, { origin, query: { q: (a.query ?? '').slice(0, 100), sortColumn: 'modifiedAt', sortOrder: 'desc', limit: Math.min(20, a.max ?? 20) }, signal: ctx.signal })
      const docs = documentList(body)
      for (const x of docs) docNames.set(x.id, x.name)
      return { text: formatDocuments(docs, origin ?? 'https://cad.onshape.com', a.query ?? ''), display: `Found ${docs.length} Onshape document${docs.length === 1 ? '' : 's'}` }
    }

    let r = refFromArgs(a)
    if (WRITES.has(a.action) && r.wvm && r.wvm !== 'w') requireWorkspace(r)
    r = await complete(r, ctx)
    const doc = await docName(r, ctx)

    switch (a.action) {
      case 'document': {
        const [ws, els] = await Promise.all([
          client.get<Array<Record<string, any>>>(`/documents/d/${r.did}/workspaces`, { origin: r.origin, signal: ctx.signal }).catch(() => []),
          client.get(`/documents/${dwvm(r)}/elements`, { origin: r.origin, signal: ctx.signal })
        ])
        const list = elementList(els)
        for (const e of list) elements.set(`${r.did}/${e.id}`, e)
        const docInfo = await client.get<Record<string, any>>(`/documents/${r.did}`, { origin: r.origin, signal: ctx.signal }).catch(() => undefined)
        const defaultWid = docInfo?.defaultWorkspace?.id
        const workspaces = (Array.isArray(ws) ? ws : []).map((w) => ({ id: String(w.id), name: String(w.name ?? 'Main'), isDefault: w.id === defaultWid, readOnly: w.isReadOnly === true }))
        return { text: formatDocument({ name: doc, id: r.did, origin: r.origin ?? 'https://cad.onshape.com', workspaces, wvm: r.wvm!, wvmid: r.wvmid!, elements: list }), display: `Read Onshape document "${doc}" (${list.length} tabs)` }
      }
      case 'parts': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO'], 'parts')
        const cfg = await encode(r, a.configuration, ctx)
        const body = await client.get(`/parts/${dwvme(r)}`, { origin: r.origin, rawQuery: cfg?.queryParam, signal: ctx.signal })
        return { text: `${cfg ? `Configuration: ${cfg.text}\n` : ''}${formatParts(body, e.name)}`, display: `Listed parts in "${e.name}"` }
      }
      case 'features': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO'], 'features')
        const cfg = await encode(r, a.configuration, ctx)
        const body = await client.get(`/partstudios/${dwvme(r)}/features`, { origin: r.origin, query: { includeGeometryIds: false, noSketchGeometry: true }, rawQuery: cfg?.queryParam, signal: ctx.signal })
        return { text: `${cfg ? `Configuration: ${cfg.text}\n` : ''}${formatFeatures(body, { elementName: e.name, max: a.max })}`, display: `Read the feature tree of "${e.name}"` }
      }
      case 'variables': {
        const e = await element(r, ctx)
        need(e, ['VARIABLESTUDIO', 'PARTSTUDIO', 'ASSEMBLY'], 'variables')
        const parts: string[] = []
        if (e.type === 'PARTSTUDIO') {
          const vf = variableFeatures(await client.get(`/partstudios/${dwvme(r)}/features`, { origin: r.origin, query: { includeGeometryIds: false, noSketchGeometry: true }, signal: ctx.signal }))
          parts.push(vf.length ? `${vf.length} Variable feature${vf.length === 1 ? '' : 's'} (#variables) in "${e.name}" (edit them in the feature tree; set_variables only writes Variable Studios):\n${vf.map((v) => `- #${v.name} (${v.type}) = ${v.value}`).join('\n')}` : `No Variable features in "${e.name}".`)
        }
        if (r.wvm !== 'm') {
          try {
            const t = variableTables(await client.get(`/variables/${dwvme(r)}/variables`, { origin: r.origin, query: { includeValuesAndReferencedVariables: true }, signal: ctx.signal }))
            readVars.set(vkey(r), t.own)
            if (e.type === 'VARIABLESTUDIO' || t.own.length || t.referenced.length) parts.push(formatVariables(t, e.name))
          } catch (err) {
            if (e.type === 'VARIABLESTUDIO') throw err
          }
        }
        return { text: parts.join('\n\n') || 'No variables.', display: `Read variables in "${e.name}"` }
      }
      case 'set_variables': {
        const e = await element(r, ctx)
        need(e, ['VARIABLESTUDIO'], 'set_variables')
        requireWorkspace(r)
        if (!a.variables?.length) throw new OnshapeError('variables is required: [{ "name": "armLength", "expression": "26 in" }].', 0)
        const { inputs } = await config(r, ctx, true).catch(() => ({ inputs: [] as ConfigInput[] }))
        if (inputs.length) throw new OnshapeError(`"${e.name}" is a configured Variable Studio (${inputs.length} configuration input${inputs.length === 1 ? '' : 's'}); writing it through the API could flatten per-configuration values. Change these in Onshape directly, or change the configuration instead (set_configuration).`, 0)
        const current = await ownVariables(r, ctx)
        const plan = planVariableChanges(current, a.variables)
        if (plan.errors.length) throw new OnshapeError(plan.errors.join(' '), 0)
        const changed = plan.rows.filter((x) => x.old !== x.next || (x.description !== undefined && x.description !== current.find((c) => c.name === x.name)?.description))
        const diff = changed.map((x) => `- #${x.name} (${x.type}): ${x.old ?? '(new)'} → ${x.next}`).join('\n')
        if (!changed.length) return { text: `Nothing to change: ${plan.rows.map((x) => `#${x.name} is already ${x.next}`).join(', ')}.`, display: 'No variable changes' }
        if (!a.apply) {
          return { text: `Preview only, nothing changed yet. In ${label(doc, e)} (workspace ${r.wvmid}):\n${diff}\nTo apply: call set_variables again with the same variables and apply: true (the user approves the change on a card showing old → new).`, display: `Previewed ${changed.length} variable change${changed.length === 1 ? '' : 's'}` }
        }
        await client.post(`/variables/d/${r.did}/w/${r.wvmid}/e/${r.eid}/variables`, mergedVariables(current, changed), { origin: r.origin, signal: ctx.signal })
        const after = await ownVariables(r, ctx)
        const now = changed.map((x) => { const v = after.find((y) => y.name === x.name); return `- #${x.name}: ${x.old ?? '(new)'} → ${v?.expression ?? x.next}${v?.value && v.value !== v.expression ? ` (= ${v.value})` : ''}` })
        return { text: `Changed ${changed.length} variable${changed.length === 1 ? '' : 's'} in ${label(doc, e)} (workspace ${r.wvmid}):\n${now.join('\n')}\nParts that use them regenerate in Onshape; check the feature tree (action features) for new errors. Undo is in Onshape's version history.`, display: `Changed ${changed.length} Onshape variable${changed.length === 1 ? '' : 's'}` }
      }
      case 'configuration': {
        const e = await element(r, ctx)
        const { inputs } = await config(r, ctx, true)
        return { text: formatConfiguration(inputs, e.name), display: `Read the configuration of "${e.name}"` }
      }
      case 'set_configuration': {
        const e = await element(r, ctx)
        requireWorkspace(r)
        if (!a.values || !Object.keys(a.values).length) throw new OnshapeError('values is required: { "<input name or id>": "<new default value>" }.', 0)
        const { inputs, raw } = await config(r, ctx, true)
        if (!inputs.length) throw new OnshapeError(`"${e.name}" has no configuration inputs.`, 0)
        const { entries, errors } = resolveConfigValues(inputs, a.values)
        if (errors.length) throw new OnshapeError(errors.join(' '), 0)
        const diff = entries.map((x) => `- ${x.input.name}: ${x.input.current ?? x.input.default ?? '?'} → ${x.input.kind === 'enum' ? x.input.options?.find((o) => o.option === x.parameterValue)?.name ?? x.parameterValue : x.parameterValue}`).join('\n')
        if (!a.apply) return { text: `Preview only, nothing changed yet. Default configuration of ${label(doc, e)}:\n${diff}\nTo apply: call set_configuration again with the same values and apply: true (the user approves it). To only READ a configuration, pass configuration to parts / mass_properties / export instead; that changes nothing.`, display: `Previewed ${entries.length} configuration change${entries.length === 1 ? '' : 's'}` }
        await client.post(`/elements/d/${r.did}/w/${r.wvmid}/e/${r.eid}/configuration`, configUpdateBody(raw, entries), { origin: r.origin, signal: ctx.signal })
        const after = await config(r, ctx, true)
        return { text: `Changed the default configuration of ${label(doc, e)}:\n${entries.map((x) => `- ${x.input.name}: now ${after.inputs.find((c) => c.id === x.parameterId)?.current ?? x.parameterValue}`).join('\n')}`, display: `Changed ${entries.length} configuration default${entries.length === 1 ? '' : 's'}` }
      }
      case 'mass_properties': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO', 'ASSEMBLY'], 'mass_properties')
        const cfg = await encode(r, a.configuration, ctx)
        const body = e.type === 'PARTSTUDIO'
          ? await client.get(`/partstudios/${dwvme(r)}/massproperties`, { origin: r.origin, query: { massAsGroup: true, useMassPropertyOverrides: true, partId: a.part_ids?.length ? a.part_ids : undefined }, rawQuery: cfg?.queryParam, signal: ctx.signal })
          : await client.get(`/assemblies/${dwvme(r)}/massproperties`, { origin: r.origin, rawQuery: cfg?.queryParam, signal: ctx.signal })
        const what = `${a.part_ids?.length ? `${a.part_ids.length} part${a.part_ids.length === 1 ? '' : 's'} of ` : ''}${label(doc, e)}${cfg ? ` [${cfg.text}]` : ''}`
        return { text: formatMass(pickMass(body), { units, label: what, assembly: e.type === 'ASSEMBLY' }), display: `Mass properties of "${e.name}"` }
      }
      case 'bounding_box': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO', 'ASSEMBLY'], 'bounding_box')
        const cfg = await encode(r, a.configuration, ctx)
        const kind = e.type === 'PARTSTUDIO' ? 'partstudios' : 'assemblies'
        const box = await client.get<Box>(`/${kind}/${dwvme(r)}/boundingboxes`, { origin: r.origin, query: { includeHidden: false }, rawQuery: cfg?.queryParam, signal: ctx.signal })
        return { text: formatBox(box, { units, label: `${label(doc, e)}${cfg ? ` [${cfg.text}]` : ''}` }), display: `Bounding box of "${e.name}"` }
      }
      case 'assembly': {
        const e = await element(r, ctx)
        need(e, ['ASSEMBLY'], 'assembly')
        const cfg = await encode(r, a.configuration, ctx)
        const body = await client.get(`/assemblies/${dwvme(r)}`, { origin: r.origin, query: { includeMateFeatures: true, includeNonSolids: false, includeMateConnectors: false, excludeSuppressed: false }, rawQuery: cfg?.queryParam, signal: ctx.signal })
        return { text: formatAssembly(body, e.name), display: `Read assembly "${e.name}"` }
      }
      case 'export': {
        const e = await element(r, ctx)
        const fmt = a.format ? EXPORT_FORMATS[a.format] : undefined
        if (!fmt) throw new OnshapeError(`format is required: ${Object.keys(EXPORT_FORMATS).join(', ')}.`, 0)
        need(e, [...fmt.for], `${a.format} export`)
        if (r.wvm === 'm') throw new OnshapeError('Exports need a workspace or version URL, not a microversion.', 0)
        const cfg = await encode(r, a.configuration, ctx)
        const kind = e.type === 'PARTSTUDIO' ? 'partstudios' : e.type === 'ASSEMBLY' ? 'assemblies' : 'drawings'
        const body: Record<string, unknown> = { formatName: fmt.formatName, storeInDocument: false }
        if (cfg) body.configuration = cfg.encodedId
        if (a.part_ids?.length && kind === 'partstudios') body.partIds = a.part_ids.join(',')
        if (a.format === 'STL') { body.stlMode = 'BINARY'; body.resolution = 'fine'; body.grouping = true }
        if (a.export_units && (a.format === 'STL' || a.format === 'STEP')) { body.unit = a.export_units.toUpperCase(); body.specifyUnits = true }
        const started = await client.post<TranslationInfo>(`/${kind}/${dwvme(r)}/translations`, body, { origin: r.origin, signal: ctx.signal })
        if (!started?.id) throw new OnshapeError('Onshape did not start the export.', 0)
        ctx.progress?.(`Exporting ${a.format} from Onshape…`)
        const done = await client.waitForTranslation(started.id, { origin: r.origin, signal: ctx.signal, onPoll: (s, n) => ctx.progress?.(`Onshape export ${s.toLowerCase()} (check ${n})`) })
        const fid = done.resultExternalDataIds?.[0]
        if (!fid) throw new OnshapeError('The export finished but Onshape returned no file.', 0)
        const file = await client.request('GET', `/documents/d/${done.resultDocumentId || r.did}/externaldata/${encodeURIComponent(fid)}`, { origin: r.origin, as: 'binary', signal: ctx.signal })
        const bytes = file.bytes ?? Buffer.alloc(0)
        if (!bytes.length) throw new OnshapeError('The exported file was empty.', 0)
        const zip = bytes[0] === 0x50 && bytes[1] === 0x4b
        const dir = join(d.workspace(), 'exports', 'onshape')
        mkdirSync(dir, { recursive: true })
        const base = safeName(`${doc} - ${e.name}${cfg ? ` (${cfg.text})` : ''}`)
        let path = join(dir, `${base}.${zip ? 'zip' : fmt.ext}`)
        if (existsSync(path)) path = join(dir, `${base} ${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${zip ? 'zip' : fmt.ext}`)
        writeFileSync(path, bytes)
        return { text: `Exported ${label(doc, e)} as ${a.format}${zip ? ' (several files, zipped)' : ''}: ${path} (${(bytes.length / 1024).toFixed(0)} KB).${r.wvm === 'w' ? ' Exported from the live workspace; for manufacturing, export from a named version so the file matches a known state.' : ''}`, display: `Exported ${a.format} of "${e.name}"`, path }
      }
      case 'thumbnail': {
        const e = await element(r, ctx)
        let png: Buffer | undefined
        if (e.type === 'PARTSTUDIO' || e.type === 'ASSEMBLY') {
          const cfg = await encode(r, a.configuration, ctx)
          const kind = e.type === 'PARTSTUDIO' ? 'partstudios' : 'assemblies'
          const res = await client.get<{ images?: string[][] | string[] }>(`/${kind}/${dwvme(r)}/shadedviews`, { origin: r.origin, query: { viewMatrix: VIEWS[a.view ?? 'isometric'] ?? VIEWS.isometric, outputWidth: 800, outputHeight: 600, pixelSize: 0, edges: 'show', useAntiAliasing: true }, rawQuery: cfg?.queryParam, signal: ctx.signal })
          const first = res?.images?.[0]
          const b64 = Array.isArray(first) ? first[0] : first
          if (typeof b64 === 'string' && b64) png = Buffer.from(b64, 'base64')
        } else {
          if (r.wvm === 'm') throw new OnshapeError('Thumbnails need a workspace or version URL.', 0)
          const res = await client.request('GET', `/thumbnails/d/${r.did}/${r.wvm}/${r.wvmid}/e/${r.eid}/s/600x340`, { origin: r.origin, as: 'binary', accept: 'image/*', signal: ctx.signal })
          png = res.bytes
        }
        if (!png?.length) throw new OnshapeError('Onshape returned no image (an empty element, or nothing visible).', 0)
        const mime = png[0] === 0xff && png[1] === 0xd8 ? 'image/jpeg' : 'image/png'
        return { text: `Shaded ${e.type === 'PARTSTUDIO' || e.type === 'ASSEMBLY' ? `${a.view ?? 'isometric'} view` : 'thumbnail'} of ${label(doc, e)} is attached below (if the current model can't see images, describe it from parts/features instead).`, images: [`data:${mime};base64,${png.toString('base64')}`], display: `Picture of "${e.name}"` }
      }
      case 'eval_featurescript': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO'], 'eval_featurescript')
        const why = fsRefusal(a.script ?? '')
        if (why) throw new OnshapeError(`Refused: ${why}`, 0)
        const cfg = await encode(r, a.configuration, ctx)
        const res = await client.post<Record<string, any>>(`/partstudios/${dwvme(r)}/featurescript`, { script: a.script, queries: {} }, { origin: r.origin, rawQuery: cfg?.queryParam, signal: ctx.signal })
        const value = JSON.stringify(fsValue(res?.result))
        const notices = ((res?.notices ?? []) as Array<Record<string, any>>).slice(0, 10).map((n) => `${n.level ?? 'INFO'}: ${clean(n.message, 200)}`)
        const out = [`Result (FeatureScript values; lengths in meters unless units shown): ${value.length > 8000 ? `${value.slice(0, 8000)}… (cut)` : value}`]
        if (res?.console) out.push(`Console:\n${String(res.console).slice(0, 3000)}`)
        if (notices.length) out.push(`Notices:\n${notices.join('\n')}`)
        return { text: out.join('\n'), display: `Ran a FeatureScript query on "${e.name}"` }
      }
      case 'add_feature': {
        const e = await element(r, ctx)
        need(e, ['PARTSTUDIO'], 'add_feature')
        requireWorkspace(r)
        const why = featureProblem(a.feature)
        if (why) throw new OnshapeError(why, 0)
        const res = await client.post<Record<string, any>>(`/partstudios/d/${r.did}/w/${r.wvmid}/e/${r.eid}/features`, { btType: 'BTFeatureDefinitionCall-1406', feature: a.feature }, { origin: r.origin, signal: ctx.signal })
        const status = res?.featureState?.featureStatus ?? 'unknown'
        const id = res?.feature?.featureId ?? '?'
        const ok = status === 'OK'
        return { text: `Added feature ${featureSummary(res?.feature ?? a.feature)} to ${label(doc, e)}: featureId ${id}, status ${status}.${ok ? '' : ' It did not regenerate cleanly: ask the user to open the Part Studio and fix or delete it (this tool never deletes features).'}`, display: `Added feature to "${e.name}" (${status})` }
      }
      case 'versions': {
        const body = await client.get(`/documents/d/${r.did}/versions`, { origin: r.origin, query: { limit: 100 }, signal: ctx.signal })
        return { text: `Versions of "${doc}":\n${formatVersions(body, a.max ?? 25)}`, display: `Listed versions of "${doc}"` }
      }
      case 'create_version': {
        requireWorkspace(r)
        const name = clean(a.name, 200)
        if (!name) throw new OnshapeError('name is required (e.g. "Week 3 intake v2 - for manufacturing").', 0)
        const v = await client.post<Record<string, any>>(`/documents/d/${r.did}/versions`, { documentId: r.did, workspaceId: r.wvmid, name, description: clean(a.description, 1000) }, { origin: r.origin, signal: ctx.signal })
        return { text: `Created version "${clean(v?.name ?? name, 100)}" of "${doc}" (${v?.id ?? '?'}): ${onshapeUrl({ did: r.did, wvm: 'v', wvmid: v?.id, origin: r.origin })}`, display: `Created Onshape version "${name}"` }
      }
    }
    throw new OnshapeError(`Unknown action ${a.action}.`, 0)
  }

  return {
    name: 'onshape',
    label: 'Onshape CAD',
    group: 'CAD',
    // Document names, part names, feature names and descriptions are other people's text: data, not instructions.
    untrusted: true,
    effect: (a) => onshapeEffect(a),
    consequential: () => true,
    describe,
    description: 'Onshape CAD (cad, onshape) through the user\'s API keys. Pass url = the Onshape document URL from the browser (https://cad.onshape.com/documents/<did>/w/<wid>/e/<eid>), or document_id/workspace_id|version_id/element_id. Reads: documents (query = name search), document (workspaces + tabs/elements with types), parts (Part Studio parts, materials, appearance), features (feature tree: name, type, suppressed, errors, key parameters), variables (Variable Studio table, or a Part Studio\'s #variable features), configuration (inputs and current defaults), mass_properties (mass, volume, center of mass, inertia; optional part_ids), bounding_box, assembly (instances ×count, mates), versions, thumbnail (shaded picture: view isometric/front/top/…), eval_featurescript (read-only lambda: script = "function(context is Context, queries) { return evVolume(context, {\\"entities\\": qEverything(EntityType.BODY)}); }"). Reads take configuration: {"<input>": "<value>"} to look at a configuration without changing anything. export (format STEP/STL/PARASOLID for Part Studios and Assemblies, PDF/DWG/DXF for Drawings; saved to the workspace exports/onshape folder). Changes (workspace only, never a version; the user approves each): set_variables (variables [{name, expression like "26 in", type for new ones}]; call first without apply to preview old → new, then with apply: true), set_configuration (values {input: new default}; same preview → apply), add_feature (advanced: feature = BTMFeature-134 JSON; prefer variables/configurations), create_version (name, description). Units: Onshape works in SI; results show imperial and metric (units: imperial|metric|both). Read the cad-onshape-api skill first.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ONSHAPE_ACTIONS] },
        url: { type: 'string', description: 'Onshape document URL (…/documents/<did>/w/<wid>/e/<eid>)' },
        document_id: { type: 'string' },
        workspace_id: { type: 'string' },
        version_id: { type: 'string' },
        element_id: { type: 'string', description: 'The tab: Part Studio, Assembly, Variable Studio, Drawing' },
        query: { type: 'string', description: 'documents: part of a document name' },
        configuration: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'Reads/exports: configuration to evaluate, by input name or id (changes nothing)' },
        variables: {
          type: 'array', maxItems: 50, description: 'set_variables: changes',
          items: { type: 'object', properties: { name: { type: 'string' }, expression: { type: 'string', description: 'With units, e.g. "26 in", "15 deg", "#base + 2 in"' }, type: { type: 'string', enum: ['LENGTH', 'ANGLE', 'NUMBER', 'ANY'] }, description: { type: 'string' } }, required: ['name', 'expression'], additionalProperties: false }
        },
        values: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] }, description: 'set_configuration: new default values by input name or id' },
        apply: { type: 'boolean', description: 'set_variables / set_configuration: true to make the change (after a preview); omitted = preview only' },
        part_ids: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'mass_properties / export: limit to these partIds (from parts)' },
        format: { type: 'string', enum: Object.keys(EXPORT_FORMATS) },
        export_units: { type: 'string', enum: ['inch', 'millimeter', 'meter'], description: 'export STL/STEP units' },
        view: { type: 'string', enum: Object.keys(VIEWS) },
        script: { type: 'string', description: 'eval_featurescript: a read-only FeatureScript lambda' },
        feature: { type: 'object', description: 'add_feature: BTMFeature-134 JSON (btType, featureType, name, parameters)' },
        name: { type: 'string', description: 'create_version: version name' },
        description: { type: 'string', description: 'create_version: notes' },
        units: { type: 'string', enum: ['imperial', 'metric', 'both'] },
        max: { type: 'integer', minimum: 1, maximum: 500, description: 'Most rows to list' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'documents' } } }, then: { required: ['query'] } },
        { if: { properties: { action: { const: 'set_variables' } } }, then: { required: ['variables'] } },
        { if: { properties: { action: { const: 'set_configuration' } } }, then: { required: ['values'] } },
        { if: { properties: { action: { const: 'export' } } }, then: { required: ['format'] } },
        { if: { properties: { action: { const: 'eval_featurescript' } } }, then: { required: ['script'] } },
        { if: { properties: { action: { const: 'add_feature' } } }, then: { required: ['feature'] } },
        { if: { properties: { action: { const: 'create_version' } } }, then: { required: ['name'] } }
      ]
    },
    async run(a, ctx) {
      try {
        return await run(a, ctx)
      } catch (e) {
        if (e instanceof OnshapeError) throw new Error(e.message)
        throw e
      }
    }
  }
}

/** Settings → Test: checks the saved keys against GET /users/sessioninfo. */
export async function testOnshapeKeys(d: Pick<OnshapeDeps, 'keys' | 'fetchImpl' | 'testOrigin'>): Promise<{ ok: boolean; name?: string; error?: string }> {
  const client = new OnshapeClient({ keys: d.keys, fetchImpl: d.fetchImpl, testOrigin: d.testOrigin, timeoutMs: 20_000 })
  if (!client.hasKeys()) return { ok: false, error: `Paste both the access key and the secret key first (create them at ${KEYS_URL}).` }
  try {
    const me = await client.get<Record<string, any>>('/users/sessioninfo')
    return { ok: true, name: clean(me?.name ?? me?.email ?? 'signed in', 80) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
