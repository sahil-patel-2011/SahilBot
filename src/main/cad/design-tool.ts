import type { ToolEffect } from '@shared/types'
import type { OnshapeArgs } from '../agent/tools/onshape'
import type { ToolContext, ToolDef, ToolOutput } from '../agent/types'
import { isCreatedDoc } from './created'
import { buildFreecad, type FreecadBuild } from './freecad-build'
import { buildOnshape, measureOnshape, SHADED_VIEWS, type BuildResult } from './onshape-build'
import { OnshapeClient, OnshapeError, type OnshapeKeys } from './onshape-client'
import { parseOnshapeUrl, refFromArgs } from './onshape-url'
import { lenExpr, planProblems, type CadPlan } from './plan'
import { wireframeImages, type WireView } from './wire-png'
import {
  briefGaps, checkModel, conceptProblems, conceptPrompt, conceptTable, formatBrief, formatChecks, formatPlan, phaseItems, pickBackend,
  SETUP_TEXT, WORKFLOW_STEPS, type Backend, type Check, type Concept, type DesignBrief, type Phase
} from './workflow'

// cad_design: the design workflow as one tool. Each action records a step of the thinking (brief, concepts,
// plan), builds, or checks the result, and updates the chat's progress card (Design brief → Concepts → Plan
// → Build → Verify) through the tool result's meta.plan, the same card the todo tool drives.
// Building in a new Onshape document is routine; building into one of the user's existing documents is an
// outside change that asks first. The tool never deletes or overwrites anything (a rebuild updates the
// features it made itself).

export type CadAction = 'brief' | 'concepts' | 'plan' | 'build' | 'verify' | 'deliver'

export interface CadDesignArgs {
  action: CadAction
  brief?: DesignBrief
  concepts?: Concept[]
  recommended?: number
  reasons?: string
  confirm?: boolean
  plan?: CadPlan
  backend?: 'onshape' | 'freecad'
  url?: string
  fresh?: boolean
  views?: string[]
  exports?: Array<'STEP' | 'STL'>
  notes?: string
}

export interface DesignToolDeps {
  onshapeKeys: () => OnshapeKeys | undefined
  freecadBin: () => string | null
  workspace: () => string
  /** The onshape tool, for STEP/STL exports on delivery (its own export code and folder). */
  onshape?: ToolDef<OnshapeArgs>
  fetchImpl?: typeof fetch
  testOrigin?: string
  sleep?: (ms: number) => Promise<void>
  /** Tests: FreeCAD runs without FreeCAD. */
  runFreecad?: Parameters<typeof buildFreecad>[2]['run']
}

interface Session {
  brief?: DesignBrief
  concepts?: Concept[]
  chosen?: number
  plan?: CadPlan
  backend?: Backend
  onshape?: BuildResult
  freecad?: FreecadBuild
  checks?: Check[]
  details: Partial<Record<Phase, string>>
}

const MAX_SESSIONS = 200

export function cadDesignTool(d: DesignToolDeps): ToolDef<CadDesignArgs> {
  const sessions = new Map<string, Session>()
  const session = (id: string): Session => {
    let s = sessions.get(id)
    if (!s) {
      s = { details: {} }
      sessions.set(id, s)
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
    }
    return s
  }
  const backendFor = (a: Pick<CadDesignArgs, 'backend'>): Backend => pickBackend({ onshapeKeys: !!(d.onshapeKeys()?.accessKey && d.onshapeKeys()?.secretKey), freecad: !!d.freecadBin(), prefer: a.backend })
  const client = (): OnshapeClient => new OnshapeClient({ keys: d.onshapeKeys, fetchImpl: d.fetchImpl, testOrigin: d.testOrigin, sleep: d.sleep })

  /** The progress card and the agent's own todo list both follow the workflow. */
  const progress = (s: Session, current: Phase | 'done', ctx: ToolContext): Record<string, unknown> => {
    const items = phaseItems(current, s.details)
    ctx.state.todos = items
    return { plan: items, planTitle: 'Design' }
  }
  const out = (s: Session, ctx: ToolContext, current: Phase | 'done', o: Omit<ToolOutput, 'meta'>): ToolOutput => ({ ...o, meta: progress(s, current, ctx) })

  const effect = (a: CadDesignArgs): ToolEffect => {
    if (a.action === 'build') return backendFor(a) === 'freecad' ? 'write_local' : 'write_external'
    if (a.action === 'deliver' && a.exports?.length) return 'write_local'
    return 'read'
  }

  const run = async (a: CadDesignArgs, ctx: ToolContext): Promise<ToolOutput> => {
    const s = session(ctx.threadId)
    switch (a.action) {
      case 'brief': {
        const b = a.brief
        if (!b?.goal?.trim()) throw new Error('brief.goal is required: what is being designed and what it is for.')
        s.brief = b
        s.backend = backendFor(a)
        const gaps = briefGaps(b)
        const research = (b.research ?? []).filter(Boolean)
        const researching = research.length > 0 && !(b.sources?.length)
        s.details['Design brief'] = b.goal.slice(0, 60)
        const lines = [`Design brief recorded:\n${formatBrief(b)}`]
        if (gaps.length) lines.push(`Not stated yet: ${gaps.join('; ')}. If the user is watching and one of these changes the design, ask them once (ask_user with all questions together); otherwise pick sensible values and add them to assumptions.`)
        if (researching) lines.push(`Research before designing: ${research.join('; ')}. Look them up (web_search / fetch_page or the research tool), then call brief again with the facts in dimensions/standards and the pages in sources (cite them in the final summary).`)
        lines.push(s.backend === 'onshape' ? 'CAD: Onshape (the API keys are set up). The build goes into a new Onshape document unless the user gave a document URL.'
          : s.backend === 'freecad' ? `CAD: FreeCAD on this Mac (${d.freecadBin()}). The build saves an .FCStd plus STEP and STL in the workspace.`
            : SETUP_TEXT)
        if (!researching) lines.push(`Next, concepts:\n${conceptPrompt(b)}`)
        return out(s, ctx, researching ? 'Design brief' : 'Concepts', { text: lines.join('\n\n'), display: `Design brief: ${b.goal.slice(0, 60)}` })
      }
      case 'concepts': {
        const errs = conceptProblems(a.concepts, a.recommended)
        if (errs.length) throw new Error(errs.join(' '))
        const list = a.concepts!
        let chosen = a.recommended!
        let how = 'recommended'
        // Attended runs may ask; unattended ones (no plan approvals) go ahead with the recommendation.
        if (a.confirm && ctx.proposePlan) {
          const order = [chosen, ...list.map((_, i) => i).filter((i) => i !== chosen)].slice(0, 3)
          const answer = await ctx.askUser(`Which design should I build? I recommend "${list[chosen].name}"${a.reasons ? `: ${a.reasons}` : '.'}`, order.map((i, k) => `${list[i].name}${k === 0 ? ' (recommended)' : ''}`))
          const pick = list.findIndex((c) => answer.toLowerCase().startsWith(c.name.toLowerCase()))
          if (pick >= 0) { chosen = pick; how = pick === a.recommended ? 'recommended, confirmed by the user' : "the user's choice" }
          else if (answer.trim()) how = `recommended; the user said: "${answer.slice(0, 200)}"`
        }
        s.concepts = list
        s.chosen = chosen
        s.details.Concepts = `${list.length} options → ${list[chosen].name}`
        const text = [
          conceptTable(list, a.recommended!),
          `Chosen: "${list[chosen].name}" (${how})${a.reasons && chosen === a.recommended ? `. Why: ${a.reasons}` : ''}.`,
          a.confirm && ctx.proposePlan ? '' : 'Tell the user the options and the pick in one short paragraph and keep going; if they reply with another concept, switch to it.',
          'Next: write the feature plan (variables for every key dimension, features in build order, the assembly and mates if there are several parts, and expect: the size/volume/clearances it must measure), then call cad_design with action "plan".'
        ].filter(Boolean).join('\n\n')
        return out(s, ctx, 'Plan', { text, display: `Concepts: ${list.map((c) => c.name).join(' / ')} → ${list[chosen].name}` })
      }
      case 'plan': {
        const plan = a.plan
        if (!plan) throw new Error('plan is required.')
        const errs = planProblems(plan)
        if (errs.length) throw new Error(`The plan has problems:\n- ${errs.join('\n- ')}`)
        // A revised plan keeps the last Onshape build: building again updates those features in place.
        s.plan = plan
        s.backend = backendFor(a)
        const n = plan.features.length
        s.details.Plan = `${plan.variables?.length ?? 0} variable${plan.variables?.length === 1 ? '' : 's'}, ${n} feature${n === 1 ? '' : 's'}${plan.assembly ? `, ${plan.assembly.instances.length} instances` : ''}`
        const where = s.backend === 'onshape' ? 'Onshape (a new document unless you pass url)' : s.backend === 'freecad' ? 'FreeCAD' : 'nowhere yet: no CAD is set up'
        return out(s, ctx, 'Build', { text: `${formatPlan(plan)}\n\nBuilds in ${where}. Next: cad_design action "build".${s.backend === 'setup' ? `\n\n${SETUP_TEXT}` : ''}`, display: `Feature plan: ${n} feature${n === 1 ? '' : 's'}` })
      }
      case 'build': {
        const plan = a.plan ?? s.plan
        if (!plan) throw new Error('No feature plan yet: call cad_design with action "plan" first (or pass plan).')
        const errs = planProblems(plan)
        if (errs.length) throw new Error(`The plan has problems:\n- ${errs.join('\n- ')}`)
        if (a.plan) s.plan = plan
        const backend = backendFor(a)
        s.backend = backend
        if (backend === 'setup') throw new Error(SETUP_TEXT)
        if (backend === 'freecad') {
          ctx.progress?.('Building in FreeCAD…')
          const r = await buildFreecad(d.freecadBin()!, plan, { workspace: d.workspace(), signal: ctx.signal, run: d.runFreecad })
          s.freecad = r
          if (!r.ok) { s.details.Build = 'FreeCAD error'; return out(s, ctx, 'Build', { text: `FreeCAD could not build it: ${r.error}\nFix the plan (cad_design plan) and build again.`, display: 'FreeCAD build failed' }) }
          s.details.Build = `FreeCAD, ${r.result?.bodies ?? '?'} bod${r.result?.bodies === 1 ? 'y' : 'ies'}`
          return out(s, ctx, 'Verify', { text: `Built "${plan.name}" in FreeCAD:\n- ${r.files!.fcstd}\n- ${r.files!.step}\n- ${r.files!.stl}\nNext: cad_design action "verify" (measures it and draws views to look at).`, display: `Built "${plan.name}" in FreeCAD`, path: r.files!.fcstd })
        }
        const target = a.url ? refFromArgs({ url: a.url }) : undefined
        const previous = !a.fresh && s.onshape && (!target || target.did === s.onshape.ref.did) ? s.onshape : undefined
        let r: BuildResult
        try {
          r = await buildOnshape(client(), plan, { target: previous ? undefined : target, previous, signal: ctx.signal, progress: (t) => ctx.progress?.(t) })
        } catch (e) {
          if (e instanceof OnshapeError) throw new Error(e.message)
          throw e
        }
        s.onshape = r
        const lines = r.features.map((f) => `- ${f.name}: ${f.status}${f.featureId ? ` (featureId ${f.featureId})` : ''}${f.note ? `; ${f.note}` : ''}${f.error ? `: ${f.error}` : ''}`)
        s.details.Build = r.ok ? `${r.features.length} features OK` : 'a feature failed'
        const head = r.ok
          ? `Built "${plan.name}" in Onshape (${previous ? 'updated the features from the last build' : r.created ? 'a new document' : 'a new Part Studio tab in your document'}): ${r.url}${r.assemblyUrl ? `\nAssembly: ${r.assemblyUrl}` : ''}`
          : `The build stopped at a feature that didn't regenerate. Document: ${r.url}`
        const tail = r.ok ? 'Next: cad_design action "verify".' : 'Fix that feature in the plan (cad_design plan, same ids) and build again: the features already made are updated in place, nothing is deleted.'
        return out(s, ctx, r.ok ? 'Verify' : 'Build', { text: [head, ...lines, ...r.notes.map((n) => `Note: ${n}`), `(${r.calls} Onshape API calls)`, tail].join('\n'), display: r.ok ? `Built "${plan.name}" in Onshape` : 'Onshape build stopped at an error' })
      }
      case 'verify': {
        const plan = s.plan
        if (!plan || (!s.onshape && !s.freecad)) throw new Error('Nothing built yet in this chat: plan and build first.')
        let checks: Check[]
        let images: string[] = []
        const facts: string[] = []
        if (s.freecad?.ok && (!s.onshape || s.backend === 'freecad')) {
          const r = s.freecad.result ?? {}
          checks = checkModel(plan.expect, { bbox_mm: r.bbox_mm, volume_mm3: r.volume_mm3, parts: r.bodies, valid: r.valid, interferences: r.interferences, minGap_mm: typeof r.min_gap_mm === 'number' ? r.min_gap_mm : undefined })
          const views = (a.views?.length ? a.views : ['isometric', 'front', 'top']).filter((v): v is WireView => ['isometric', 'front', 'top', 'right'].includes(v))
          images = wireframeImages(r.polylines, views)
          facts.push(`Volume ${Number((r.volume_mm3 ?? 0).toFixed(1))} mm³, surface ${Number((r.area_mm2 ?? 0).toFixed(1))} mm², ${r.bodies ?? '?'} bod${r.bodies === 1 ? 'y' : 'ies'}.`)
          if (images.length) facts.push(`Wireframe ${views.join(', ')} views are attached: look at them for anything that doesn't match the intent (missing features, wrong side, odd proportions).`)
        } else if (s.onshape) {
          const m = await measureOnshape(client(), s.onshape.ref, { views: (a.views ?? []).filter((v) => v in SHADED_VIEWS), signal: ctx.signal })
          checks = checkModel(plan.expect, { bbox_mm: m.bbox_mm, volume_mm3: m.volume_mm3, parts: m.parts?.length, errors: m.errors, interferences: m.interferences, minGap_mm: m.minGap_mm })
          images = m.images
          if (m.mass_g !== undefined) facts.push(`Mass ${m.mass_g} g.`)
          else if (m.massMissing) facts.push('No material is assigned, so Onshape reports no mass; volume is the check (mass = volume × density).')
          if (m.parts?.length) facts.push(`${m.parts.length} part${m.parts.length === 1 ? '' : 's'} in the Part Studio.`)
          for (const n of m.notes) facts.push(`(${n.replace(/Onshape said: .*$/, 'see Onshape for details')})`)
          if (images.length) facts.push('Shaded views are attached: look at them for anything that does not match the intent.')
          facts.push(`(${m.calls} Onshape API calls)`)
        } else throw new Error('The last build failed; fix the plan and build again before verifying.')
        s.checks = checks
        const failed = checks.filter((c) => !c.pass)
        s.details.Verify = failed.length ? `${failed.length} check${failed.length === 1 ? '' : 's'} failing` : `${checks.length} checks pass`
        const next = failed.length
          ? 'Fix what failed: change the plan (same feature ids) with cad_design plan, build again (updates in place) and verify again. Stop after three rounds and tell the user what is still off.'
          : 'All checks pass. Next: cad_design action "deliver" (with exports if the user asked for STEP/STL), then give the user the summary.'
        return { ...out(s, ctx, failed.length ? 'Verify' : 'done', { text: [formatChecks(checks), ...facts, next].join('\n'), display: failed.length ? `Verify: ${failed.length} failing` : `Verify: all ${checks.length} checks pass` }), images: images.length ? images : undefined }
      }
      case 'deliver': {
        const plan = s.plan
        if (!plan || (!s.onshape && !s.freecad)) throw new Error('Nothing built yet in this chat.')
        const u = plan.units ?? 'mm'
        const lines = [`Design summary: ${plan.name}`]
        if (s.brief) lines.push(`Goal: ${s.brief.goal}`)
        if (s.concepts && s.chosen !== undefined) lines.push(`Concept: ${s.concepts[s.chosen].name} (of ${s.concepts.length}: ${s.concepts.map((c) => c.name).join(', ')})`)
        if (plan.variables?.length) lines.push(`Parameters (change these to resize it): ${plan.variables.map((v) => `#${v.name} = ${v.type === 'NUMBER' || v.type === 'ANGLE' ? v.value : lenExpr(v.value, u)}`).join(', ')}`)
        if (s.checks) lines.push(`Checks: ${s.checks.map((c) => `${c.pass ? '✓' : '✗'} ${c.name}`).join(', ')}`)
        let path: string | undefined
        const want = [...new Set([...(a.exports ?? []), ...(plan.exports ?? [])])].filter((x) => x === 'STEP' || x === 'STL')
        if (s.onshape) {
          lines.push(`Onshape: ${s.onshape.url}${s.onshape.assemblyUrl ? ` (assembly ${s.onshape.assemblyUrl})` : ''}`)
          for (const fmt of want) {
            if (!d.onshape) { lines.push(`${fmt}: export it from Onshape (right-click the Part Studio tab → Export).`); continue }
            try {
              const r = await d.onshape.run({ action: 'export', url: s.onshape.url, format: fmt, export_units: u === 'in' ? 'inch' : 'millimeter' }, ctx)
              lines.push(`${fmt}: ${r.path ?? r.text}`)
              path = path ?? r.path
            } catch (e) { lines.push(`${fmt}: export failed (${(e as Error).message.slice(0, 200)})`) }
          }
        }
        if (s.freecad?.files) {
          lines.push(`FreeCAD model: ${s.freecad.files.fcstd}`)
          if (want.includes('STEP') || !want.length) lines.push(`STEP: ${s.freecad.files.step}`)
          if (want.includes('STL') || !want.length) lines.push(`STL: ${s.freecad.files.stl}`)
          path = path ?? s.freecad.files.fcstd
        }
        if (s.brief?.sources?.length) lines.push(`Sources: ${s.brief.sources.map((x, i) => `[${i + 1}] ${x.title} ${x.url}`).join('; ')}`)
        if (a.notes) lines.push(`Notes: ${a.notes}`)
        lines.push('Give the user this summary in plain words: what was built and why this concept, the key parameters, the check results, the link and the files.')
        return out(s, ctx, 'done', { text: lines.join('\n'), display: `Delivered "${plan.name}"`, path })
      }
    }
    throw new Error(`Unknown action ${String(a.action)}.`)
  }

  return {
    name: 'cad_design',
    label: 'CAD design',
    group: 'CAD',
    // Not marked untrusted: its results are this workflow's own text and numbers. Names read back from the
    // user's Onshape documents (other people's text) are left out of them; the onshape tool shows those.
    effect,
    // A new document (or one this chat made) is routine; the user's existing documents always ask.
    consequential: (a) => {
      if (a.action !== 'build') return true
      if (!a.url) return false
      const ref = parseOnshapeUrl(a.url)
      return !(ref && isCreatedDoc(ref.did))
    },
    describe: (a) => {
      if (a.action !== 'build') return `CAD design: ${a.action}`
      const n = a.plan?.features.length
      const backend = backendFor(a)
      if (backend === 'freecad') return `Build ${a.plan?.name ? `"${a.plan.name}"` : 'the design'} with FreeCAD into the workspace exports folder`
      const ref = a.url ? parseOnshapeUrl(a.url) : null
      return a.url
        ? `Build ${a.plan?.name ? `"${a.plan.name}"` : 'the planned design'}${n ? ` (${n} features)` : ''} into your Onshape document ${ref?.did ?? a.url.slice(0, 80)}${ref?.eid ? ' (appends features to that tab, or adds a new Part Studio tab)' : ' (adds a new Part Studio tab)'}; nothing is deleted`
        : `Build ${a.plan?.name ? `"${a.plan.name}"` : 'the planned design'}${n ? ` (${n} features)` : ''} in a new Onshape document`
    },
    description: `Design and build a part or assembly in CAD (cad, onshape, freecad, 3d model, design, model, build). Use it whenever the user asks to design, model or build something in CAD: think through the whole problem first, then build and check it. Steps, in order: ${WORKFLOW_STEPS}. Actions: brief (brief: goal, units, dimensions, loads, material, process fdm|sla|sls|cnc|laser|waterjet|sheet_metal|injection|casting|manual|other, tolerances, interfaces, standards, constraints, assumptions, research = things to look up, sources [{title,url}], scope part|assembly); concepts (2-4 concepts [{name, summary, scores {strength, weight, manufacturability, cost, assembly} 1-5 where 5 is best, pros, cons}], recommended = index, reasons; confirm: true asks a watching user to choose); plan (plan: {name, units mm|in, variables [{name, value "40 mm" or number, type LENGTH|ANGLE|NUMBER}], features in build order, each with a unique id: cube {side} | sketch {plane Top|Front|Right or on {of, cap end|start}, shapes [rect {x,y,w,h,centered} | circle {x,y,r} | line {id,x1,y1,x2,y2} | polygon {points}], constraints [{type DISTANCE|RADIUS|DIAMETER|HORIZONTAL|…, first, second, value}]} | extrude {sketch, depth, operation new|add|remove|intersect, opposite, through} | revolve {sketch, axis = a line id in it, angle} | fillet {edges {of, cap}, radius} | chamfer {edges, width} | shell {faces {of, cap}, thickness} | hole {on (plane or {of, cap}), at [[x,y]], diameter, depth (omit = through)} | linear_pattern {of [ids], direction X|Y|Z, distance, count} | circular_pattern {of, axis X|Y|Z, count, angle} | mirror {of, plane} | raw {feature: BTMFeature JSON}; lengths are numbers in the plan's units or expressions with units or #variables like "#side - 2 * #wall"; assembly {instances [{id, part (part name or feature id), count, offset_mm}], mates [{type FASTENED|REVOLUTE|SLIDER|…, a {instance, face_of}, b {instance, face_of}}]}; expect {bbox_mm [x,y,z], tolerance_mm, volume_mm3, volume_tolerance_pct, parts, no_interference, min_clearance_mm}; exports [STEP, STL]}); build (Onshape when its keys are set, else FreeCAD if installed; a new Onshape document unless url names one of the user's documents, which asks first; a second build updates the same features in place); verify (size, volume, feature errors, interference and clearance between parts, plus pictures to look at; views isometric|front|top|right…); deliver (summary with parameters, checks, link; exports STEP/STL). Every action updates the chat's Design brief → Concepts → Plan → Build → Verify progress card. Read the cad-design-workflow skill.`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['brief', 'concepts', 'plan', 'build', 'verify', 'deliver'] },
        brief: {
          type: 'object',
          properties: {
            goal: { type: 'string' }, units: { type: 'string', enum: ['mm', 'in'] }, dimensions: { type: 'array', items: { type: 'string' }, maxItems: 30 },
            loads: { type: 'string' }, material: { type: 'string' }, process: { type: 'string', enum: ['fdm', 'sla', 'sls', 'cnc', 'laser', 'waterjet', 'sheet_metal', 'injection', 'casting', 'manual', 'other'] },
            tolerances: { type: 'string' }, interfaces: { type: 'array', items: { type: 'string' }, maxItems: 20 }, standards: { type: 'array', items: { type: 'string' }, maxItems: 20 },
            constraints: { type: 'array', items: { type: 'string' }, maxItems: 20 }, assumptions: { type: 'array', items: { type: 'string' }, maxItems: 20 }, research: { type: 'array', items: { type: 'string' }, maxItems: 10 },
            sources: { type: 'array', maxItems: 20, items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
            scope: { type: 'string', enum: ['part', 'assembly'] }
          },
          required: ['goal']
        },
        concepts: {
          type: 'array', minItems: 2, maxItems: 4,
          items: { type: 'object', properties: { name: { type: 'string' }, summary: { type: 'string' }, scores: { type: 'object', additionalProperties: { type: 'number' } }, pros: { type: 'array', items: { type: 'string' } }, cons: { type: 'array', items: { type: 'string' } } }, required: ['name', 'summary'] }
        },
        recommended: { type: 'integer', minimum: 0, maximum: 3, description: 'concepts: index of the one to build' },
        reasons: { type: 'string', description: 'concepts: why that one' },
        confirm: { type: 'boolean', description: 'concepts: ask a watching user to choose (unattended runs use the recommendation)' },
        plan: { type: 'object', description: 'plan / build: the feature plan (see the description)', properties: { name: { type: 'string' }, units: { type: 'string', enum: ['mm', 'in'] }, variables: { type: 'array' }, features: { type: 'array', minItems: 1, maxItems: 80 }, assembly: { type: 'object' }, expect: { type: 'object' }, exports: { type: 'array', items: { type: 'string', enum: ['STEP', 'STL'] } } }, required: ['name', 'features'] },
        backend: { type: 'string', enum: ['onshape', 'freecad'], description: 'Force a CAD program (default: Onshape if set up, else FreeCAD)' },
        url: { type: 'string', description: "build: one of the user's Onshape documents to build into (asks first); omit for a new document" },
        fresh: { type: 'boolean', description: 'build: start a new document instead of updating the last build' },
        views: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'verify: views to picture (isometric, front, top, right…)' },
        exports: { type: 'array', items: { type: 'string', enum: ['STEP', 'STL'] }, description: 'deliver: files to export' },
        notes: { type: 'string', description: 'deliver: anything else for the summary' }
      },
      required: ['action'],
      additionalProperties: false,
      allOf: [
        { if: { properties: { action: { const: 'brief' } } }, then: { required: ['brief'] } },
        { if: { properties: { action: { const: 'concepts' } } }, then: { required: ['concepts', 'recommended'] } },
        { if: { properties: { action: { const: 'plan' } } }, then: { required: ['plan'] } }
      ]
    },
    run
  }
}
