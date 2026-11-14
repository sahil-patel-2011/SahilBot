// Compact, model-friendly summaries of Onshape API responses. Everything here is text from the user's
// (or someone else's) CAD documents: names are cleaned to one line and capped, and the tool marks the
// output untrusted.

/** One line, no control characters, at most n characters. */
export function clean(v: unknown, n = 80): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)
  // Control characters become spaces; bidi overrides/isolates and zero-width characters (which can make a
  // name read differently than it is, or hide text) are dropped.
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\u061c\u180e]/g, '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
/** Up to `d` significant decimals, no trailing zeros. */
export function fmt(x: number | undefined, d = 4): string {
  if (x === undefined) return '?'
  if (x === 0) return '0'
  const a = Math.abs(x)
  const digits = a >= 100 ? Math.max(0, d - 3) : a >= 1 ? d - 1 : d + Math.max(0, -Math.floor(Math.log10(a)))
  return String(Number(x.toFixed(Math.min(10, digits))))
}

export const KG_TO_LB = 2.2046226218
export const M_TO_IN = 39.37007874
export const KGM2_TO_LBIN2 = KG_TO_LB * M_TO_IN * M_TO_IN

export type Units = 'imperial' | 'metric' | 'both'
const len = (m: number | undefined, u: Units): string => m === undefined ? '?' : u === 'metric' ? `${fmt(m * 1000)} mm` : u === 'imperial' ? `${fmt(m * M_TO_IN)} in` : `${fmt(m * M_TO_IN)} in (${fmt(m * 1000)} mm)`
const mass = (kg: number | undefined, u: Units): string => kg === undefined ? '?' : u === 'metric' ? `${fmt(kg)} kg` : u === 'imperial' ? `${fmt(kg * KG_TO_LB)} lb` : `${fmt(kg * KG_TO_LB)} lb (${fmt(kg)} kg)`
const vol = (m3: number | undefined, u: Units): string => m3 === undefined ? '?' : u === 'metric' ? `${fmt(m3 * 1e6)} cm³` : u === 'imperial' ? `${fmt(m3 * M_TO_IN ** 3)} in³` : `${fmt(m3 * M_TO_IN ** 3)} in³ (${fmt(m3 * 1e6)} cm³)`

// ---------------------------------------------------------------- documents

export interface DocSummary { id: string; name: string; owner?: string; modified?: string; workspaceId?: string }

export function documentList(body: unknown): DocSummary[] {
  const items = (body as { items?: unknown[] } | undefined)?.items ?? (Array.isArray(body) ? body : [])
  return (items as Array<Record<string, any>>).filter((d) => d && typeof d.id === 'string').map((d) => ({
    id: d.id,
    name: clean(d.name, 100),
    owner: d.owner?.name ? clean(d.owner.name, 40) : undefined,
    modified: typeof d.modifiedAt === 'string' ? d.modifiedAt.slice(0, 10) : undefined,
    workspaceId: typeof d.defaultWorkspace?.id === 'string' ? d.defaultWorkspace.id : undefined
  }))
}

export function formatDocuments(docs: DocSummary[], origin: string, query: string): string {
  if (!docs.length) return `No Onshape documents matched "${clean(query, 60)}". Try a shorter part of the name, or paste the document URL.`
  const lines = docs.map((d, i) => `${i + 1}. ${d.name}${d.owner ? ` (owner ${d.owner})` : ''}${d.modified ? `, modified ${d.modified}` : ''}\n   ${origin}/documents/${d.id}${d.workspaceId ? `/w/${d.workspaceId}` : ''}`)
  return `${docs.length} document${docs.length === 1 ? '' : 's'}${query ? ` matching "${clean(query, 60)}"` : ''}:\n${lines.join('\n')}\nNext: action "document" with one of these URLs lists its workspaces and tabs (elements).`
}

export interface ElementSummary { id: string; name: string; type: string; dataType?: string }

export function elementList(body: unknown): ElementSummary[] {
  return ((Array.isArray(body) ? body : []) as Array<Record<string, any>>).filter((e) => e && typeof e.id === 'string').map((e) => ({
    id: e.id,
    name: clean(e.name, 80),
    type: String(e.elementType ?? e.type ?? 'UNKNOWN').toUpperCase(),
    dataType: typeof e.dataType === 'string' && e.dataType ? e.dataType : undefined
  }))
}

const PRETTY: Record<string, string> = { PARTSTUDIO: 'Part Studio', ASSEMBLY: 'Assembly', DRAWING: 'Drawing', VARIABLESTUDIO: 'Variable Studio', FEATURESTUDIO: 'Feature Studio', BLOB: 'File', BILLOFMATERIALS: 'BOM', APPLICATION: 'App', PUBLICATIONITEM: 'Publication', TABLE: 'Table', IMPORTSTUDIO: 'Import Studio' }
export const prettyType = (t: string): string => PRETTY[t] ?? t

export function formatDocument(o: { name: string; id: string; origin: string; workspaces: Array<{ id: string; name: string; isDefault?: boolean; readOnly?: boolean }>; wvm: string; wvmid: string; elements: ElementSummary[] }): string {
  const lines = [`Document "${clean(o.name, 100)}" (${o.id})`]
  if (o.workspaces.length) lines.push(`Workspaces (editable branches): ${o.workspaces.slice(0, 12).map((w) => `${clean(w.name, 40)}${w.isDefault ? ' [default]' : ''}${w.readOnly ? ' [read-only]' : ''} = ${w.id}`).join('; ')}`)
  lines.push(`Elements (tabs) in ${o.wvm === 'w' ? 'workspace' : o.wvm === 'v' ? 'version' : 'microversion'} ${o.wvmid}:`)
  const order = ['VARIABLESTUDIO', 'PARTSTUDIO', 'ASSEMBLY', 'DRAWING']
  const sorted = [...o.elements].sort((a, b) => (order.indexOf(a.type) + 1 || 9) - (order.indexOf(b.type) + 1 || 9))
  for (const e of sorted.slice(0, 120)) lines.push(`- ${prettyType(e.type)}: ${e.name}${e.dataType ? ` (${clean(e.dataType, 40)})` : ''}  ${o.origin}/documents/${o.id}/${o.wvm}/${o.wvmid}/e/${e.id}`)
  if (sorted.length > 120) lines.push(`… and ${sorted.length - 120} more`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- parts

const hex = (c: Record<string, number> | undefined): string | undefined => c && [c.red, c.green, c.blue].every((x) => typeof x === 'number') ? `#${[c.red, c.green, c.blue].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')}` : undefined

export function formatParts(body: unknown, elementName?: string): string {
  const parts = (Array.isArray(body) ? body : []) as Array<Record<string, any>>
  if (!parts.length) return `No parts${elementName ? ` in "${clean(elementName)}"` : ''}. (Parts only exist in Part Studios; sketches and surfaces aren't parts.)`
  const noMat = parts.filter((p) => !p.material?.displayName).length
  const lines = [`${parts.length} part${parts.length === 1 ? '' : 's'}${elementName ? ` in "${clean(elementName)}"` : ''} (partId · name · material · appearance):`]
  for (const p of parts.slice(0, 150)) {
    const bits = [p.partId, clean(p.name, 60), p.material?.displayName ? clean(p.material.displayName, 50) : 'no material']
    const color = hex(p.appearance?.color)
    if (color) bits.push(`${color}${typeof p.appearance?.opacity === 'number' && p.appearance.opacity < 255 ? ` ${Math.round((p.appearance.opacity / 255) * 100)}% opaque` : ''}`)
    if (p.partNumber) bits.push(`P/N ${clean(p.partNumber, 30)}`)
    if (p.bodyType && p.bodyType !== 'solid') bits.push(String(p.bodyType))
    if (p.isHidden) bits.push('hidden')
    lines.push(`- ${bits.join(' · ')}`)
  }
  if (parts.length > 150) lines.push(`… and ${parts.length - 150} more`)
  if (noMat) lines.push(`${noMat} part${noMat === 1 ? ' has' : 's have'} no material, so mass properties can't count them: assign materials in Onshape (right-click the part → Assign material).`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- features

/** A feature parameter as "id=value" (quantities show their expression). */
export function paramText(p: Record<string, any>): string | null {
  const id = clean(p.parameterId ?? p.parameterName ?? '?', 40)
  const t = String(p.btType ?? '')
  if (t.startsWith('BTMParameterQuantity') || t.startsWith('BTMParameterNullableQuantity')) return `${id}=${clean(p.expression ?? p.value ?? '', 40)}`
  if (t.startsWith('BTMParameterEnum')) return `${id}=${clean(p.value, 40)}`
  if (t.startsWith('BTMParameterBoolean')) return `${id}=${p.value === true}`
  if (t.startsWith('BTMParameterString')) return p.value ? `${id}="${clean(p.value, 40)}"` : null
  if (t.startsWith('BTMParameterQueryList') || t.startsWith('BTMParameterQueryWithOccurrenceList')) return `${id}: ${Array.isArray(p.queries) ? p.queries.length : 0} selected`
  if (t.startsWith('BTMParameterFeatureList')) return `${id}: ${Array.isArray(p.featureIds) ? p.featureIds.length : 0} features`
  if (t.startsWith('BTMParameterArray')) return `${id}: ${Array.isArray(p.items) ? p.items.length : 0} items`
  if (t.startsWith('BTMParameterReference')) return `${id}: reference`
  return null
}

export interface FeatureRow { index: number; id: string; name: string; type: string; suppressed: boolean; status?: string; params: string[] }

export function featureRows(body: unknown, maxParams = 6): FeatureRow[] {
  const b = (body ?? {}) as { features?: Array<Record<string, any>>; featureStates?: Record<string, { featureStatus?: string }> }
  return (b.features ?? []).map((f, i) => ({
    index: i + 1,
    id: String(f.featureId ?? ''),
    name: clean(f.name, 60),
    type: String(f.btType ?? '').startsWith('BTMSketch') ? 'sketch' : clean(f.featureType, 40),
    suppressed: f.suppressed === true,
    status: b.featureStates?.[f.featureId]?.featureStatus,
    params: (Array.isArray(f.parameters) ? f.parameters : []).map(paramText).filter((x: string | null): x is string => !!x).slice(0, maxParams)
  }))
}

export function formatFeatures(body: unknown, opts: { elementName?: string; max?: number } = {}): string {
  const rows = featureRows(body)
  const b = (body ?? {}) as { rollbackIndex?: number }
  if (!rows.length) return 'This Part Studio has no features yet.'
  const max = opts.max ?? 200
  const bad = rows.filter((r) => r.status && r.status !== 'OK')
  const lines = [`${rows.length} feature${rows.length === 1 ? '' : 's'}${opts.elementName ? ` in "${clean(opts.elementName)}"` : ''}${typeof b.rollbackIndex === 'number' && b.rollbackIndex >= 0 && b.rollbackIndex < rows.length ? ` (rollback bar after feature ${b.rollbackIndex})` : ''}. # · name · type · [status] · key parameters (featureId):`]
  for (const r of rows.slice(0, max)) {
    const flags = [r.suppressed ? 'SUPPRESSED' : '', r.status && r.status !== 'OK' ? r.status : ''].filter(Boolean).join(', ')
    lines.push(`${r.index}. ${r.name} · ${r.type}${flags ? ` · [${flags}]` : ''}${r.params.length ? ` · ${r.params.join(', ')}` : ''} (${r.id})`)
  }
  if (rows.length > max) lines.push(`… and ${rows.length - max} more`)
  if (bad.length) lines.push(`⚠ ${bad.length} feature${bad.length === 1 ? ' has' : 's have'} errors or warnings: ${bad.slice(0, 8).map((r) => `${r.index}. ${r.name} (${r.status})`).join('; ')}. Fix the first one first; later errors often cascade from it.`)
  const sup = rows.filter((r) => r.suppressed).length
  if (sup) lines.push(`${sup} suppressed feature${sup === 1 ? '' : 's'}.`)
  return lines.join('\n')
}

/** Part Studio "#variables": Variable features in the feature list. */
export function variableFeatures(body: unknown): Array<{ name: string; value: string; type: string; featureName: string }> {
  const feats = ((body as { features?: Array<Record<string, any>> } | undefined)?.features ?? []).filter((f) => f.featureType === 'assignVariable')
  return feats.map((f) => {
    const ps = (Array.isArray(f.parameters) ? f.parameters : []) as Array<Record<string, any>>
    const by = (id: string): Record<string, any> | undefined => ps.find((p) => p.parameterId === id)
    const type = String(by('variableType')?.value ?? 'ANY')
    const valueParam = by(`${type.toLowerCase()}Value`) ?? ps.find((p) => /Value$/.test(String(p.parameterId)) && String(p.btType).startsWith('BTMParameterQuantity'))
    return { name: clean(by('name')?.value ?? f.name, 60), value: clean(valueParam?.expression ?? valueParam?.value ?? '', 60), type, featureName: clean(f.name, 60) }
  })
}

// ---------------------------------------------------------------- variables

export interface VariableRow { name: string; type: string; expression: string; value?: string; description?: string }
export interface VariableTable { own: VariableRow[]; referenced: Array<{ from: string; rows: VariableRow[] }> }

export function variableTables(body: unknown): VariableTable {
  const tables = (Array.isArray(body) ? body : []) as Array<{ variableStudioReference?: { referenceElementId?: string }; variables?: Array<Record<string, any>> }>
  const rows = (vs: Array<Record<string, any>> | undefined): VariableRow[] => (vs ?? []).map((v) => ({ name: clean(v.name, 60), type: String(v.type ?? 'ANY'), expression: clean(v.expression ?? '', 120), value: v.value !== undefined && v.value !== null ? clean(v.value, 60) : undefined, description: v.description ? clean(v.description, 80) : undefined }))
  const out: VariableTable = { own: [], referenced: [] }
  for (const t of tables) {
    if (t.variableStudioReference) out.referenced.push({ from: String(t.variableStudioReference.referenceElementId ?? '?'), rows: rows(t.variables) })
    else out.own.push(...rows(t.variables))
  }
  return out
}

export function formatVariables(t: VariableTable, elementName?: string): string {
  const row = (v: VariableRow): string => `- #${v.name} (${v.type}) = ${v.expression}${v.value && v.value !== v.expression ? `  → ${v.value}` : ''}${v.description ? `  // ${v.description}` : ''}`
  const lines: string[] = []
  lines.push(t.own.length ? `${t.own.length} variable${t.own.length === 1 ? '' : 's'}${elementName ? ` in "${clean(elementName)}"` : ''} (name (type) = expression → evaluated value):` : `No variables of its own${elementName ? ` in "${clean(elementName)}"` : ''}.`)
  lines.push(...t.own.slice(0, 200).map(row))
  for (const r of t.referenced.slice(0, 10)) {
    lines.push(`Referenced from Variable Studio ${r.from} (change them there):`)
    lines.push(...r.rows.slice(0, 80).map(row))
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- configuration

export interface ConfigInput { id: string; name: string; kind: 'enum' | 'quantity' | 'boolean' | 'string' | 'other'; options?: Array<{ option: string; name: string }>; range?: { min?: number; max?: number; default?: number; units?: string; quantityType?: string }; default?: string; current?: string }

export function configInputs(body: unknown): ConfigInput[] {
  const b = (body ?? {}) as { configurationParameters?: Array<Record<string, any>>; currentConfiguration?: Array<Record<string, any>> }
  const cur = new Map<string, string>()
  for (const c of b.currentConfiguration ?? []) cur.set(String(c.parameterId), clean(c.expression ?? c.value ?? '', 60))
  return (b.configurationParameters ?? []).map((p) => {
    const t = String(p.btType ?? '')
    const base = { id: String(p.parameterId ?? ''), name: clean(p.parameterName ?? p.parameterId, 60), current: cur.get(String(p.parameterId)) }
    if (t.startsWith('BTMConfigurationParameterEnum')) return { ...base, kind: 'enum' as const, options: (p.options ?? []).map((o: Record<string, any>) => ({ option: String(o.option), name: clean(o.optionName ?? o.option, 50) })), default: clean(p.defaultValue, 50) }
    if (t.startsWith('BTMConfigurationParameterQuantity')) return { ...base, kind: 'quantity' as const, range: { min: num(p.rangeAndDefault?.minValue), max: num(p.rangeAndDefault?.maxValue), default: num(p.rangeAndDefault?.defaultValue), units: p.rangeAndDefault?.units ? clean(p.rangeAndDefault.units, 20) : undefined, quantityType: p.quantityType ? String(p.quantityType) : undefined } }
    if (t.startsWith('BTMConfigurationParameterBoolean')) return { ...base, kind: 'boolean' as const, default: String(p.defaultValue === true) }
    if (t.startsWith('BTMConfigurationParameterString')) return { ...base, kind: 'string' as const, default: clean(p.defaultValue, 50) }
    return { ...base, kind: 'other' as const }
  })
}

export function formatConfiguration(inputs: ConfigInput[], elementName?: string): string {
  if (!inputs.length) return `${elementName ? `"${clean(elementName)}"` : 'This element'} has no configuration inputs.`
  const lines = [`${inputs.length} configuration input${inputs.length === 1 ? '' : 's'}${elementName ? ` in "${clean(elementName)}"` : ''} (name [id]: kind; current default):`]
  for (const c of inputs.slice(0, 60)) {
    let what = c.kind as string
    if (c.kind === 'enum') {
      const opts = c.options ?? []
      what = `list of ${opts.length}: ${opts.slice(0, 15).map((o) => (o.name === o.option ? o.name : `${o.name} (${o.option})`)).join(' | ')}${opts.length > 15 ? ' | …' : ''}`
    } else if (c.kind === 'quantity' && c.range) {
      what = `${(c.range.quantityType ?? 'quantity').toLowerCase()} ${fmt(c.range.min)} to ${fmt(c.range.max)}${c.range.units ? ` ${c.range.units}` : ''}`
    }
    lines.push(`- ${c.name} [${c.id}]: ${what}; current ${c.current ?? c.default ?? '?'}`)
  }
  lines.push('Read parts, mass_properties, bounding_box, export or thumbnail with a configuration by passing configuration: {"<input name or id>": "<value>"}.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- mass properties and boxes

export interface MassInfo { mass?: number[]; volume?: number[]; centroid?: number[]; inertia?: number[]; principalInertia?: number[]; hasMass?: boolean; massMissingCount?: number }

/** The "all bodies" entry of a Part Studio response, or an assembly's own info. */
export function pickMass(body: unknown): MassInfo | undefined {
  const b = (body ?? {}) as { bodies?: Record<string, MassInfo> } & MassInfo
  if (b.bodies && typeof b.bodies === 'object') {
    const keys = Object.keys(b.bodies)
    return b.bodies['-all-'] ?? (keys.length === 1 ? b.bodies[keys[0]] : undefined) ?? (keys.length ? sumBodies(keys.map((k) => b.bodies![k])) : undefined)
  }
  return b.mass || b.volume ? b : undefined
}

function sumBodies(list: MassInfo[]): MassInfo {
  const m = list.reduce((s, x) => s + (x.mass?.[0] ?? 0), 0)
  const v = list.reduce((s, x) => s + (x.volume?.[0] ?? 0), 0)
  const c = [0, 1, 2].map((i) => (m ? list.reduce((s, x) => s + (x.mass?.[0] ?? 0) * (x.centroid?.[i] ?? 0), 0) / m : 0))
  return { mass: [m], volume: [v], centroid: c, hasMass: list.every((x) => x.hasMass !== false), massMissingCount: list.reduce((s, x) => s + (x.massMissingCount ?? 0), 0) }
}

export function formatMass(info: MassInfo | undefined, o: { units: Units; label?: string; assembly?: boolean }): string {
  if (!info) return 'Onshape returned no mass properties (no solid parts?).'
  const u = o.units
  const m = info.mass?.[0]
  const lines = [`Mass properties${o.label ? ` of ${clean(o.label, 80)}` : ''} (Onshape computes in SI; converted):`]
  lines.push(`- Mass: ${mass(m, u)}${info.mass && info.mass.length >= 3 && info.mass[1] !== info.mass[2] ? ` (tolerance range ${mass(Math.min(info.mass[1], info.mass[2]), u)} to ${mass(Math.max(info.mass[1], info.mass[2]), u)})` : ''}`)
  lines.push(`- Volume: ${vol(info.volume?.[0], u)}`)
  if (info.centroid?.length) lines.push(`- Center of mass (x, y, z from the origin): ${[0, 1, 2].map((i) => len(info.centroid![i], u)).join(', ')}`)
  if (info.inertia && info.inertia.length >= 9) {
    const f = u === 'metric' ? 1 : KGM2_TO_LBIN2
    const unit = u === 'metric' ? 'kg·m²' : 'lb·in²'
    const t = info.inertia.slice(0, 9).map((x) => fmt(x * f))
    lines.push(`- Inertia tensor about the center of mass (${unit}): [${t.slice(0, 3).join(', ')}; ${t.slice(3, 6).join(', ')}; ${t.slice(6, 9).join(', ')}]`)
  }
  if (info.principalInertia?.length) lines.push(`- Principal moments (${u === 'metric' ? 'kg·m²' : 'lb·in²'}): ${info.principalInertia.slice(0, 3).map((x) => fmt(x * (u === 'metric' ? 1 : KGM2_TO_LBIN2))).join(', ')}`)
  if (info.hasMass === false || (info.massMissingCount ?? 0) > 0) lines.push(`⚠ ${info.massMissingCount ? `${info.massMissingCount} part${info.massMissingCount === 1 ? ' has' : 's have'}` : 'Some parts have'} no material/density, so the mass is too low. Assign materials (or mass overrides) in Onshape${o.assembly ? ', including inside sub-assemblies and library parts' : ''}.`)
  return lines.join('\n')
}

export interface Box { lowX?: number; lowY?: number; lowZ?: number; highX?: number; highY?: number; highZ?: number }

export function formatBox(b: Box | undefined, o: { units: Units; label?: string }): string {
  if (!b || [b.lowX, b.lowY, b.lowZ, b.highX, b.highY, b.highZ].some((x) => typeof x !== 'number')) return 'Onshape returned no bounding box (empty element?).'
  const u = o.units
  const dx = b.highX! - b.lowX!, dy = b.highY! - b.lowY!, dz = b.highZ! - b.lowZ!
  return [
    `Bounding box${o.label ? ` of ${clean(o.label, 80)}` : ''} (axis-aligned, Onshape's world axes; Z is up in a default part studio):`,
    `- Size X × Y × Z: ${len(dx, u)} × ${len(dy, u)} × ${len(dz, u)}`,
    `- From (${len(b.lowX, u)}, ${len(b.lowY, u)}, ${len(b.lowZ, u)}) to (${len(b.highX, u)}, ${len(b.highY, u)}, ${len(b.highZ, u)})`,
    'It is a loose box around everything visible; for a tight box or one part use eval_featurescript with evBox3d.'
  ].join('\n')
}

// ---------------------------------------------------------------- assemblies

export function formatAssembly(body: unknown, label?: string): string {
  const b = (body ?? {}) as { rootAssembly?: Record<string, any>; subAssemblies?: unknown[]; parts?: unknown[] }
  const root = b.rootAssembly ?? {}
  const inst = (root.instances ?? []) as Array<Record<string, any>>
  const feats = (root.features ?? []) as Array<Record<string, any>>
  const lines = [`Assembly${label ? ` "${clean(label)}"` : ''}: ${inst.length} top-level instance${inst.length === 1 ? '' : 's'}, ${(b.subAssemblies ?? []).length} sub-assembly definition${(b.subAssemblies ?? []).length === 1 ? '' : 's'}, ${(b.parts ?? []).length} distinct part${(b.parts ?? []).length === 1 ? '' : 's'} in all.`]
  // "MAXSwerve Module <3>" → "MAXSwerve Module" ×4
  const groups = new Map<string, { n: number; type: string; suppressed: number; std: boolean }>()
  for (const i of inst) {
    const name = clean(String(i.name ?? '?').replace(/\s*<\d+>\s*$/, ''), 70)
    const g = groups.get(name) ?? { n: 0, type: String(i.type ?? '?'), suppressed: 0, std: i.isStandardContent === true }
    g.n++
    if (i.suppressed) g.suppressed++
    groups.set(name, g)
  }
  const sorted = [...groups.entries()].sort((a, b2) => b2[1].n - a[1].n)
  lines.push('Instances (name ×count, type):')
  for (const [name, g] of sorted.slice(0, 80)) lines.push(`- ${name} ×${g.n} (${g.type}${g.std ? ', standard content' : ''}${g.suppressed ? `, ${g.suppressed} suppressed` : ''})`)
  if (sorted.length > 80) lines.push(`… and ${sorted.length - 80} more kinds`)
  const mates = feats.filter((f) => f.featureType === 'mate')
  const other = feats.filter((f) => f.featureType !== 'mate')
  if (feats.length) {
    const byType = new Map<string, number>()
    for (const m of mates) byType.set(String(m.featureData?.mateType ?? 'UNKNOWN'), (byType.get(String(m.featureData?.mateType ?? 'UNKNOWN')) ?? 0) + 1)
    lines.push(`Mates: ${mates.length}${byType.size ? ` (${[...byType.entries()].map(([t, n]) => `${t.toLowerCase()} ${n}`).join(', ')})` : ''}${other.length ? `; other assembly features: ${other.length} (${[...new Set(other.map((f) => String(f.featureType)))].slice(0, 6).join(', ')})` : ''}`)
    const bad = feats.filter((f) => f.status && f.status !== 'OK')
    const sup = feats.filter((f) => f.suppressed).length
    for (const m of mates.slice(0, 40)) lines.push(`- ${clean(m.featureData?.name ?? m.id, 60)}: ${String(m.featureData?.mateType ?? '?').toLowerCase()}${m.suppressed ? ' [suppressed]' : ''}${m.status && m.status !== 'OK' ? ` [${m.status}]` : ''}`)
    if (mates.length > 40) lines.push(`… and ${mates.length - 40} more mates`)
    if (bad.length) lines.push(`⚠ ${bad.length} mate/feature${bad.length === 1 ? '' : 's'} with errors: ${bad.slice(0, 6).map((f) => clean(f.featureData?.name ?? f.id, 40)).join(', ')}`)
    if (sup) lines.push(`${sup} suppressed.`)
  } else {
    lines.push('No mates at this level (parts may be fixed or grouped, or mates live in sub-assemblies).')
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- versions

export function formatVersions(body: unknown, max = 25): string {
  const vs = ((Array.isArray(body) ? body : []) as Array<Record<string, any>>).filter((v) => v && v.id)
  if (!vs.length) return 'No versions yet (only the workspace).'
  const sorted = [...vs].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  const lines = [`${vs.length} version${vs.length === 1 ? '' : 's'} (newest first; versions are read-only snapshots):`]
  for (const v of sorted.slice(0, max)) lines.push(`- ${clean(v.name, 60)} · ${String(v.createdAt ?? '').slice(0, 16).replace('T', ' ')}${v.creator?.name ? ` · ${clean(v.creator.name, 30)}` : ''}${v.description ? ` · ${clean(v.description, 80)}` : ''} (${v.id})`)
  if (vs.length > max) lines.push(`… and ${vs.length - max} older`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- FeatureScript values

const UNIT_NAMES: Record<string, string> = { METER: 'm', KILOGRAM: 'kg', SECOND: 's', RADIAN: 'rad', AMPERE: 'A', KELVIN: 'K', MOLE: 'mol', CANDELA: 'cd' }

/** A BTFSValue (evalFeatureScript result) as plain JSON. Values with units become { value, units }. */
export function fsValue(v: unknown, depth = 0): unknown {
  if (depth > 20 || !v || typeof v !== 'object') return null
  const x = v as Record<string, any>
  const t = String(x.btType ?? x.typeTag ?? '')
  if (t.startsWith('BTFSValueWithUnits')) {
    const u = Object.entries((x.unitToPower ?? {}) as Record<string, number>).filter(([, p]) => p).map(([k, p]) => `${UNIT_NAMES[k] ?? k.toLowerCase()}${p === 1 ? '' : `^${p}`}`).join('·')
    return u ? { value: x.value, units: u } : x.value
  }
  if (t.startsWith('BTFSValueArray')) return (Array.isArray(x.value) ? x.value : []).map((e: unknown) => fsValue(e, depth + 1))
  if (t.startsWith('BTFSValueMap')) {
    const out: Record<string, unknown> = {}
    for (const e of (Array.isArray(x.value) ? x.value : []) as Array<{ key?: unknown; value?: unknown }>) {
      const k = fsValue(e.key, depth + 1)
      out[typeof k === 'string' ? k : JSON.stringify(k)] = fsValue(e.value, depth + 1)
    }
    return out
  }
  if (t.startsWith('BTFSValueUndefined')) return null
  if ('value' in x) return x.value
  return null
}

/**
 * FeatureScript that changes the model (op* operations, attributes, variables, feature definitions).
 * evalFeatureScript runs in a throwaway context, but this tool only runs read-only queries.
 */
const FS_WRITES = /\b(op[A-Z]\w*|set(Variable|Attribute|Property|FeatureComputedParameter|ExternalDisambiguation|ErrorEntities|HighlightedEntities)|removeAttributes|startFeature|endFeature|abortFeature|defineFeature|reportFeature\w*|addDebug\w*|newSketch\w*|sk[A-Z]\w*|skSolve)\s*\(/

export function fsRefusal(script: string): string | null {
  if (!script.trim()) return 'script is empty.'
  if (script.length > 20_000) return 'script is too long (max 20,000 characters): ask for less at once.'
  if (!/^\s*function\s*\(\s*context\s+is\s+Context\s*(,[^)]*)?\)/.test(script)) return 'script must be a lambda: function(context is Context, queries) { return …; }  (only lambdas can be evaluated).'
  const m = FS_WRITES.exec(script)
  if (m) return `script calls ${m[1]}(), which builds or changes geometry. eval_featurescript is for read-only queries (ev*/q* functions like evBox3d, evVolume, evDistance, qEverything); to change the model, use variables or configurations (set_variables / set_configuration), or add_feature.`
  return null
}

// ---------------------------------------------------------------- feature JSON for approval cards

/** "Extrude 3 (extrude): depth=2 in, operationType=NEW, entities: 1 selected" */
export function featureSummary(f: unknown): string {
  const x = (f ?? {}) as Record<string, any>
  const params = (Array.isArray(x.parameters) ? x.parameters : []).map(paramText).filter(Boolean) as string[]
  return `${clean(x.name || '(unnamed)', 60)} (${clean(x.featureType || x.btType || '?', 40)})${x.suppressed ? ' [suppressed]' : ''}${params.length ? `: ${params.slice(0, 8).join(', ')}${params.length > 8 ? `, +${params.length - 8} more` : ''}` : ''}`
}
