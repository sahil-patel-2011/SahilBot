import type { TodoItem } from '../agent/types'
import { featureLine, lenExpr, type CadPlan, type PlanExpect, type PlanUnits } from './plan'

// The design workflow the agent follows for "build this in CAD": think about the whole problem before
// touching the model, then build, measure and look at the result. Five phases show as the chat's plan card
// (Design brief → Concepts → Plan → Build → Verify); the cad_design tool (design-tool.ts) moves through them.
//
//   1. Design brief: restate requirements and constraints (dimensions, units, loads, materials, how it is
//      made, tolerances and fits, interfaces, standards); research what isn't known (standard part sizes,
//      fastener specs, material properties) and cite sources.
//   2. Concepts: 2-4 genuinely different designs with trade-offs; pick one and say why. A user who is
//      watching can choose another; an unattended run goes ahead with the recommendation.
//   3. Plan: sketches, features and parameters as variables; the assembly and mate plan; what it must measure.
//   4. Build in CAD (Onshape with the user's API keys, else FreeCAD on this Mac).
//   5. Verify: bounding box, volume/mass, feature errors, interference and clearance between parts, and
//      pictures of the model to look at; fix and rebuild until the checks pass; then deliver a summary with
//      the parameters, exported STEP/STL when asked, and the document link.

export const PHASES = ['Design brief', 'Concepts', 'Plan', 'Build', 'Verify'] as const
export type Phase = typeof PHASES[number]

/** The progress checklist with `current` in progress (everything before it done); 'done' ticks them all. */
export function phaseItems(current: Phase | 'done', details: Partial<Record<Phase, string>> = {}): TodoItem[] {
  const at = current === 'done' ? PHASES.length : PHASES.indexOf(current)
  return PHASES.map((p, i) => ({ text: details[p] ? `${p}: ${details[p]}` : p, status: i < at ? 'done' : i === at ? 'in_progress' : 'pending' }))
}

// ---------------------------------------------------------------- 1. the brief

export type Process = 'fdm' | 'sla' | 'sls' | 'cnc' | 'laser' | 'waterjet' | 'sheet_metal' | 'injection' | 'casting' | 'manual' | 'other'

export interface DesignBrief {
  goal: string
  units?: PlanUnits
  dimensions?: string[]
  loads?: string
  material?: string
  process?: Process
  tolerances?: string
  interfaces?: string[]
  standards?: string[]
  constraints?: string[]
  assumptions?: string[]
  /** Things to look up before designing (standard dimensions, fastener specs, material data). */
  research?: string[]
  sources?: Array<{ title: string; url: string }>
  /** One part, or a whole assembly / mechanism (several parts that fit or move together). */
  scope?: 'part' | 'assembly'
}

const PROCESS_NOTES: Record<Process, string> = {
  fdm: 'FDM printing: walls ≥ 1.2 mm (3 perimeters at 0.4 mm), overhangs ≤ 45° or supported, holes print ~0.2-0.3 mm small (add clearance), flat face on the bed, layer lines are the weak direction',
  sla: 'resin (SLA/MSLA): walls ≥ 1 mm, drain holes in hollow parts, small features to ~0.2 mm, brittle under impact',
  sls: 'SLS nylon: walls ≥ 0.8 mm, no supports, powder escape holes for enclosed voids, ~0.3 mm clearance for moving fits',
  cnc: 'CNC milling: inside corners need a radius ≥ the tool radius (≥ 1/3 of pocket depth), avoid deep narrow pockets (depth ≤ 4× tool diameter), fixturing faces, standard drill sizes',
  laser: 'laser cutting: 2D profiles from sheet stock of a set thickness, kerf ~0.1-0.2 mm, slots and tabs sized to the real stock thickness, min feature ≈ thickness',
  waterjet: 'waterjet: 2D profiles, taper on thick stock, pierce holes ≥ ~1.5× stream width, kerf ~0.8-1 mm',
  sheet_metal: 'sheet metal: uniform thickness, bend radius ≥ thickness, bend reliefs, holes ≥ 2× thickness from bends, flange length ≥ 4× thickness',
  injection: 'injection molding: uniform walls (2-3 mm typical), draft 1-2°, ribs ≤ 60% of wall, no undercuts without side actions',
  casting: 'casting: generous fillets, draft, uniform sections, machining allowance on precision faces',
  manual: 'hand tools: simple straight cuts, drilled holes at standard sizes, forgiving tolerances',
  other: 'state the process and its limits explicitly'
}

/** The checklist items a good brief covers, with what is still missing. */
export function briefGaps(b: DesignBrief): string[] {
  const gaps: string[] = []
  if (!b.dimensions?.length) gaps.push('key dimensions (overall size, hole sizes, wall thickness) with units')
  if (!b.material) gaps.push('material')
  if (!b.process) gaps.push('manufacturing method (3D print FDM/SLA/SLS, CNC, laser, sheet metal…)')
  if (!b.loads) gaps.push('loads and how it is used (forces, impacts, temperature)')
  if (!b.tolerances) gaps.push('tolerances and fits (clearance / press fits, critical dimensions)')
  if (!b.interfaces?.length) gaps.push('interfaces (what it attaches to, fasteners, mating parts)')
  return gaps
}

export function formatBrief(b: DesignBrief): string {
  const L: string[] = [`Goal: ${b.goal}`, `Units: ${b.units ?? 'mm'}${b.scope ? `; scope: ${b.scope}` : ''}`]
  const list = (k: string, v?: string[]): void => { if (v?.length) L.push(`${k}: ${v.join('; ')}`) }
  list('Dimensions', b.dimensions)
  if (b.loads) L.push(`Loads / use: ${b.loads}`)
  if (b.material) L.push(`Material: ${b.material}`)
  if (b.process) L.push(`Manufacturing: ${b.process} (${PROCESS_NOTES[b.process] ?? ''})`)
  if (b.tolerances) L.push(`Tolerances / fits: ${b.tolerances}`)
  list('Interfaces', b.interfaces)
  list('Standards', b.standards)
  list('Constraints', b.constraints)
  list('Assumptions', b.assumptions)
  if (b.sources?.length) L.push(`Sources: ${b.sources.map((s, i) => `[${i + 1}] ${s.title} ${s.url}`).join('; ')}`)
  return L.join('\n')
}

// ---------------------------------------------------------------- 2. concepts

export interface Concept {
  name: string
  summary: string
  /** Scores 1 (poor) - 5 (excellent); higher is better for every one (5 = light, cheap, easy). */
  scores?: Partial<Record<Criterion, number>>
  pros?: string[]
  cons?: string[]
}
export const CRITERIA = ['strength', 'weight', 'manufacturability', 'cost', 'assembly'] as const
export type Criterion = typeof CRITERIA[number]

/** The instructions for generating concepts: what makes them distinct and how to compare them. */
export function conceptPrompt(b: DesignBrief): string {
  const n = b.scope === 'assembly' ? '3-4' : '2-3'
  return [
    `Generate ${n} genuinely different concepts for: ${b.goal}.`,
    'Different means a different load path, construction or manufacturing approach (e.g. solid vs ribbed vs shelled; one piece vs bolted parts; printed vs machined vs sheet), not the same design at another size.',
    `For each: a name, a 1-2 sentence summary, scores 1-5 for ${CRITERIA.join(', ')} (5 is best: strongest, lightest, easiest to make, cheapest, easiest to assemble), and the main pros and cons.`,
    b.process ? `Judge manufacturability for ${b.process}: ${PROCESS_NOTES[b.process]}.` : 'Judge manufacturability for the likely process and say which one you assumed.',
    b.loads ? `Check each against the loads: ${b.loads}.` : 'State the loads you assumed.',
    'Recommend one, with the reasons that decided it. Then call cad_design with action "concepts".'
  ].join('\n')
}

/** Problems with a concept list (2-4, distinct names and summaries, scores 1-5, a valid recommendation). */
export function conceptProblems(list: Concept[] | undefined, recommended: number | undefined): string[] {
  const errs: string[] = []
  if (!Array.isArray(list) || list.length < 2 || list.length > 4) return ['Give 2 to 4 concepts.']
  const names = new Set<string>()
  const summaries = new Set<string>()
  for (const [i, c] of list.entries()) {
    const n = String(c?.name ?? '').trim().toLowerCase()
    const s = String(c?.summary ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
    if (!n || !s) errs.push(`Concept ${i + 1} needs a name and a summary.`)
    if (n && names.has(n)) errs.push(`Two concepts are both named "${c.name}".`)
    if (s && summaries.has(s)) errs.push(`Concepts ${i + 1} and an earlier one have the same summary: make them really different.`)
    names.add(n); summaries.add(s)
    for (const [k, v] of Object.entries(c?.scores ?? {})) if (!(CRITERIA as readonly string[]).includes(k) || !(Number.isFinite(v) && v >= 1 && v <= 5)) errs.push(`Concept "${c.name}": score ${k} must be a criterion (${CRITERIA.join(', ')}) scored 1-5.`)
  }
  if (recommended === undefined || !Number.isInteger(recommended) || recommended < 0 || recommended >= list.length) errs.push(`recommended must be the index (0-${list.length - 1}) of the concept you pick.`)
  return errs
}

/** A compact comparison table of the concepts, the recommended one marked. */
export function conceptTable(list: Concept[], recommended: number): string {
  const head = `| Concept | ${CRITERIA.map((c) => c[0].toUpperCase() + c.slice(1)).join(' | ')} | Total |`
  const rows = list.map((c, i) => {
    const s = CRITERIA.map((k) => c.scores?.[k])
    const total = s.reduce((a: number, x) => a + (x ?? 0), 0)
    return `| ${i === recommended ? '**' : ''}${c.name}${i === recommended ? '** (recommended)' : ''} | ${s.map((x) => x ?? '–').join(' | ')} | ${total || '–'} |`
  })
  const detail = list.map((c, i) => `${i + 1}. ${c.name}: ${c.summary}${c.pros?.length ? ` Pros: ${c.pros.join('; ')}.` : ''}${c.cons?.length ? ` Cons: ${c.cons.join('; ')}.` : ''}`)
  return [head, `|${' --- |'.repeat(CRITERIA.length + 2)}`, ...rows, '', ...detail].join('\n')
}

// ---------------------------------------------------------------- where to build

export type Backend = 'onshape' | 'freecad' | 'setup'

/** Onshape when its keys are saved; otherwise FreeCAD if it is installed; otherwise the one-time setup. */
export function pickBackend(o: { onshapeKeys: boolean; freecad: boolean; prefer?: 'onshape' | 'freecad' }): Backend {
  if (o.prefer === 'onshape' && o.onshapeKeys) return 'onshape'
  if (o.prefer === 'freecad' && o.freecad) return 'freecad'
  if (o.onshapeKeys) return 'onshape'
  if (o.freecad) return 'freecad'
  return 'setup'
}

export const SETUP_TEXT = [
  'No CAD program is set up yet. One-time setup, either one:',
  '- Onshape (browser CAD, free plan works): create an API key pair at https://dev-portal.onshape.com/keys (Read and Write scopes), then paste the access key and secret key in Settings → API Keys & Servers → Onshape and press Test.',
  '- FreeCAD (free, runs on this Mac): download it from https://www.freecad.org/downloads.php and drag FreeCAD.app into Applications; SahilBot finds it automatically (restart SahilBot after installing).',
  'Until then I can still do the design brief, concepts and feature plan, and write a CadQuery/OpenSCAD script you can run.'
].join('\n')

// ---------------------------------------------------------------- 3. the plan preview

export function formatPlan(plan: CadPlan): string {
  const u = plan.units ?? 'mm'
  const L: string[] = [`Feature plan "${plan.name}" (${u}):`]
  if (plan.variables?.length) L.push(`Variables: ${plan.variables.map((v) => `#${v.name} = ${v.type === 'NUMBER' ? v.value : v.type === 'ANGLE' ? v.value : lenExpr(v.value, u)}`).join(', ')}`)
  plan.features.forEach((f, i) => L.push(`${i + 1}. [${f.id}] ${f.name ? `${f.name}: ` : ''}${featureLine(f, u)}`))
  if (plan.assembly) {
    L.push(`Assembly: ${plan.assembly.instances.map((x) => `${x.id} = ${x.part}${(x.count ?? 1) > 1 ? ` ×${x.count}` : ''}`).join(', ')}`)
    for (const m of plan.assembly.mates ?? []) L.push(`- ${m.type} mate: ${m.a.instance} ↔ ${m.b.instance}`)
  }
  const e = plan.expect
  if (e) L.push(`Must measure: ${[e.bbox_mm ? `box ${e.bbox_mm.join(' × ')} mm ±${e.tolerance_mm ?? 0.05}` : '', e.volume_mm3 ? `volume ≈ ${e.volume_mm3} mm³ ±${e.volume_tolerance_pct ?? 2}%` : '', e.parts ? `${e.parts} part${e.parts === 1 ? '' : 's'}` : '', e.min_clearance_mm !== undefined ? `clearance ≥ ${e.min_clearance_mm} mm` : ''].filter(Boolean).join(', ') || 'no checks given'}`)
  return L.join('\n')
}

// ---------------------------------------------------------------- 5. checks

export interface ModelFacts {
  bbox_mm?: [number, number, number]
  volume_mm3?: number
  parts?: number
  errors?: string[]
  interferences?: number
  minGap_mm?: number
  valid?: boolean
}

export interface Check { name: string; pass: boolean; detail: string }

/** The plan's expectations against what the model measures. Size compares each axis, in any order. */
export function checkModel(expect: PlanExpect | undefined, m: ModelFacts): Check[] {
  const checks: Check[] = []
  const e = expect ?? {}
  checks.push({ name: 'Regenerates', pass: !(m.errors?.length) && m.valid !== false, detail: m.errors?.length ? m.errors.join('; ') : m.valid === false ? 'the geometry is not valid' : 'no features in error' })
  if (e.bbox_mm) {
    const tol = e.tolerance_mm ?? 0.05
    if (!m.bbox_mm) checks.push({ name: 'Size', pass: false, detail: 'no bounding box (nothing solid was made?)' })
    else {
      const want = [...e.bbox_mm].sort((a, b) => a - b)
      const got = [...m.bbox_mm].sort((a, b) => a - b)
      const off = want.map((w, i) => Math.abs(w - got[i]))
      const pass = off.every((d) => d <= tol)
      checks.push({ name: 'Size', pass, detail: `${m.bbox_mm.map((x) => Number(x.toFixed(3))).join(' × ')} mm vs ${e.bbox_mm.join(' × ')} mm (±${tol})${pass ? '' : `: off by up to ${Number(Math.max(...off).toFixed(3))} mm`}` })
    }
  } else if (m.bbox_mm) checks.push({ name: 'Size', pass: true, detail: `${m.bbox_mm.map((x) => Number(x.toFixed(3))).join(' × ')} mm (no target size in the plan)` })
  if (e.volume_mm3) {
    const pct = e.volume_tolerance_pct ?? 2
    if (m.volume_mm3 === undefined) checks.push({ name: 'Volume', pass: false, detail: 'no volume measured' })
    else {
      const d = (Math.abs(m.volume_mm3 - e.volume_mm3) / e.volume_mm3) * 100
      checks.push({ name: 'Volume', pass: d <= pct, detail: `${Number(m.volume_mm3.toFixed(1))} mm³ vs ${e.volume_mm3} mm³ (${Number(d.toFixed(2))}% off, ±${pct}% allowed)` })
    }
  } else if (m.volume_mm3 !== undefined) checks.push({ name: 'Volume', pass: m.volume_mm3 > 0, detail: `${Number(m.volume_mm3.toFixed(1))} mm³` })
  if (e.parts !== undefined) checks.push({ name: 'Parts', pass: m.parts === e.parts, detail: `${m.parts ?? '?'} part${m.parts === 1 ? '' : 's'} (expected ${e.parts})` })
  const multi = (m.parts ?? 0) >= 2
  if (multi && e.no_interference !== false) {
    checks.push(m.interferences === undefined
      ? { name: 'Interference', pass: false, detail: 'could not check (the interference query failed); check it in CAD before making parts' }
      : { name: 'Interference', pass: m.interferences === 0, detail: m.interferences === 0 ? 'no parts overlap' : `${m.interferences} overlapping pair${m.interferences === 1 ? '' : 's'}` })
  }
  if (multi && e.min_clearance_mm !== undefined) {
    checks.push(m.minGap_mm === undefined
      ? { name: 'Clearance', pass: false, detail: 'could not measure the gaps between parts' }
      : { name: 'Clearance', pass: m.minGap_mm >= e.min_clearance_mm, detail: `smallest gap ${m.minGap_mm} mm (need ≥ ${e.min_clearance_mm} mm)` })
  }
  return checks
}

export const formatChecks = (checks: Check[]): string => checks.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n')

/** The workflow, in a few lines, for the tool description and the skill. */
export const WORKFLOW_STEPS = 'brief (requirements, research gaps, backend) → concepts (2-4 with trade-offs, recommend one) → plan (variables, features, assembly/mates, expected measurements) → build → verify (size, volume, errors, interference, pictures; fix and rebuild until it passes) → deliver (summary, parameters, STEP/STL, link)'
