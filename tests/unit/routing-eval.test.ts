import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Attachment, Effort, Tier } from '@shared/types'
import { CONFIDENT, RULE_CONFIDENCE, TASK_CATEGORIES, classifyTask, consistent, type TaskCategory, type TaskClass } from '../../src/main/llm/task-classifier'
import { classifyTask as classifyKind } from '../../src/main/agent/intent'

// The routing eval: tests/fixtures/routing-eval.json (hand-labelled requests, labels per the rubrics in
// docs/model-routing.md "Rubrics"), scored per field. `dev` is what the rules were tuned on; `holdout` was
// written after tuning and only measured. Run with --silent=false to see the report and confusion matrix.
//
// Baseline (before the rework: router.ts decide() + the old task-classifier + the old intent.ts, effort as
// loop.ts combined them), on the 343 dev items:
//   category 67.3% · chat-vs-agent 78.7% strict / 81.3% lenient (18.7% agent work run as chat) ·
//   difficulty 61.5% · effort exact 60.3%, within one 95.9%, under-effort 28.0%.

interface EvalItem {
  id: string; split: 'dev' | 'holdout' | 'holdout2' | 'holdout3' | 'domains'; text: string
  ctx?: {
    files?: Array<{ name: string; tokens?: number }>; folders?: number; images?: number; voice?: boolean; codeProject?: boolean; openPlan?: boolean
    flags?: Record<string, boolean>; prev?: { category: TaskCategory; difficulty: Tier; kind: 'chat' | 'agent'; effort: Effort; text?: string }
    bot?: { name: string; role: string }; routine?: boolean; group?: boolean; helper?: boolean
  }
  category: TaskCategory; kind: 'chat' | 'agent'; difficulty: Tier; effort: Effort; tags?: string[]; note?: string
}
const EVAL = JSON.parse(readFileSync(join(__dirname, '../fixtures/routing-eval.json'), 'utf8')) as { items: EvalItem[] }
const LV: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The item as loop.ts would see it: the routing decision, and intent.ts given that decision. */
function predict(it: EvalItem): { d: TaskClass; kind: 'chat' | 'agent'; alone: 'chat' | 'agent' } {
  const c = it.ctx ?? {}
  const attachments: Attachment[] = [...(c.files ?? []).map((x) => ({ kind: 'file' as const, path: `/tmp/${x.name}`, name: x.name })), ...Array.from({ length: c.folders ?? 0 }, (_, i) => ({ kind: 'folder' as const, path: `/tmp/f${i}`, name: `f${i}` }))]
  const inputTokens = Math.round(it.text.length / 4) + (c.files ?? []).reduce((n, x) => n + (x.tokens ?? 0), 0)
  const d = classifyTask(it.text, {
    attachments, images: c.images, voice: c.voice, openPlan: c.openPlan, codeProject: c.codeProject,
    previousTier: c.prev?.difficulty, previousCategory: c.prev?.category, previousKind: c.prev?.kind, previousEffort: c.prev?.effort,
    role: c.bot ? `${c.bot.name}: ${c.bot.role}` : undefined, helper: c.helper, unattended: c.routine, group: c.group,
    inputTokens, contextTokens: inputTokens, ...c.flags
  })
  const ictx = { flags: c.flags, files: (c.files ?? []).length, folders: c.folders, openPlan: c.openPlan, previous: c.prev?.kind, previousCategory: c.prev?.category, helper: c.helper, unattended: c.routine, group: c.group, codeProject: c.codeProject, role: c.bot ? `${c.bot.name}: ${c.bot.role}` : undefined }
  return { d, kind: classifyKind(it.text, { ...ictx, route: d }).kind, alone: classifyKind(it.text, ictx).kind }
}

interface Report {
  n: number; category: number; kindStrict: number; kindLenient: number; chatToAgent: number; agentToChat: number
  difficulty: number; effortExact: number; effortWithinOne: number; effortUnder: number; effortOverTwo: number; ece: number
}

function score(items: EvalItem[]): { r: Report; confusion: Record<string, Record<string, number>>; misses: string[]; rules: Record<string, { n: number; ok: number }> } {
  const n = items.length
  let cat = 0, kindStrict = 0, kindOk = 0, overAgent = 0, underAgent = 0, diff = 0, effExact = 0, effWithin = 0, effUnder = 0, effOver2 = 0
  const confusion: Record<string, Record<string, number>> = {}
  const rules: Record<string, { n: number; ok: number }> = {}
  const misses: string[] = []
  const show = (it: EvalItem): string => `"${it.text.replace(/\s+/g, ' ').slice(0, 70)}"`
  for (const it of items) {
    const { d, kind } = predict(it)
    const ok = d.category === it.category
    if (ok) cat++
    else misses.push(`cat  ${it.id}: ${it.category} → ${d.category} [${d.rule}] ${show(it)}`)
    ;(confusion[it.category] ??= {})[d.category] = (confusion[it.category]?.[d.category] ?? 0) + 1
    const r = (rules[d.rule] ??= { n: 0, ok: 0 }); r.n++; if (ok) r.ok++
    if (kind === it.kind) { kindStrict++; kindOk++ } else if (kind === 'agent') { kindOk++; overAgent++; misses.push(`kind ${it.id}: chat → agent (ok) ${show(it)}`) } else { underAgent++; misses.push(`kind ${it.id}: agent → chat ${show(it)}`) }
    if (d.difficulty === it.difficulty) diff++
    const delta = LV.indexOf(d.effort) - LV.indexOf(it.effort)
    if (delta === 0) effExact++
    if (Math.abs(delta) <= 1) effWithin++
    if (delta < 0) { effUnder++; misses.push(`eff- ${it.id}: ${it.effort} → ${d.effort} (d${it.difficulty}→d${d.difficulty}) ${show(it)}`) }
    if (delta > 1) { effOver2++; misses.push(`eff+ ${it.id}: ${it.effort} → ${d.effort} (d${it.difficulty}→d${d.difficulty}) ${show(it)}`) }
  }
  // Expected calibration error: |confidence - accuracy| per confidence bin, weighted by the bin's size.
  const bins = new Map<number, { n: number; ok: number; conf: number }>()
  for (const it of items) {
    const { d } = predict(it)
    const b = Math.min(9, Math.floor(d.confidence * 10))
    const x = bins.get(b) ?? { n: 0, ok: 0, conf: 0 }
    x.n++; x.conf += d.confidence; if (d.category === it.category) x.ok++
    bins.set(b, x)
  }
  const ece = [...bins.values()].reduce((s, x) => s + (x.n / n) * Math.abs(x.conf / x.n - x.ok / x.n), 0)
  const pct = (k: number): number => Math.round((k / n) * 1000) / 10
  return {
    r: { n, category: pct(cat), kindStrict: pct(kindStrict), kindLenient: pct(kindOk), chatToAgent: pct(overAgent), agentToChat: pct(underAgent), difficulty: pct(diff), effortExact: pct(effExact), effortWithinOne: pct(effWithin), effortUnder: pct(effUnder), effortOverTwo: pct(effOver2), ece: Math.round(ece * 1000) / 1000 },
    confusion, misses, rules
  }
}

const ALL = score(EVAL.items)

describe('routing eval set', () => {
  test('at least 400 labelled requests across every category, kind, difficulty and effort', () => {
    expect(EVAL.items.length).toBeGreaterThanOrEqual(400)
    for (const c of TASK_CATEGORIES) expect(EVAL.items.filter((i) => i.category === c).length, c).toBeGreaterThanOrEqual(8)
    for (const k of ['chat', 'agent']) expect(EVAL.items.some((i) => i.kind === k)).toBe(true)
    for (const d of [0, 1, 2, 3]) expect(EVAL.items.some((i) => i.difficulty === d)).toBe(true)
    for (const e of LV) expect(EVAL.items.some((i) => i.effort === e), e).toBe(true)
    for (const tag of ['followup', 'multilingual', 'typo', 'mixed', 'attachment', 'bot', 'routine', 'adversarial', 'mode']) expect(EVAL.items.some((i) => i.tags?.includes(tag)), tag).toBe(true)
    expect(new Set(EVAL.items.map((i) => i.id)).size).toBe(EVAL.items.length)
  })
})

describe('routing eval: accuracy per field', () => {
  test('report (per split, confusion matrix, misses)', () => {
    for (const split of ['dev', 'holdout', 'holdout2', 'holdout3', 'domains'] as const) {
      const items = EVAL.items.filter((i) => i.split === split)
      if (items.length) console.log(`[routing-eval] ${split}`, JSON.stringify(score(items).r))
    }
    console.log('[routing-eval] all', JSON.stringify(ALL.r))
    const cols = TASK_CATEGORIES
    console.log(['label \\ predicted', ...cols.map((c) => c.slice(0, 6))].join('\t'))
    for (const row of cols) console.log([row.padEnd(17), ...cols.map((c) => String(ALL.confusion[row]?.[c] ?? 0))].join('\t'))
    console.log(ALL.misses.join('\n'))
    console.log('[routing-eval] rules', JSON.stringify(Object.fromEntries(Object.entries(ALL.rules).map(([k, x]) => [k, `${x.ok}/${x.n}`]))))
    expect(ALL.r.n).toBe(EVAL.items.length)
  })

  test('category ≥ 92%', () => expect(ALL.r.category).toBeGreaterThanOrEqual(92))
  // The domain set (medical, travel, business, engineering, coding agents) scored category 67.5%, difficulty 42.5%
  // and ran 7 agent tasks as chats before its rules; it was tuned on, so this guards against regressions only.
  test('domain set: no agent work as chat, category ≥ 95%, clinical questions at the top tier', () => {
    const r = score(EVAL.items.filter((i) => i.split === 'domains')).r
    expect(r.agentToChat).toBe(0)
    expect(r.category).toBeGreaterThanOrEqual(95)
    for (const t of ["What's the usual starting dose of tamsulosin?", 'Can I take finasteride and tamsulosin together?', 'My creatinine came back at 1.8, what does that mean?']) expect(classifyTask(t, {}).difficulty, t).toBe(3)
    expect(classifyTask('Explain what PSA density is', {}).difficulty).toBe(1)
    expect(classifyTask('Hand this bug to Cursor: the login page crashes. Have it open a PR', {}).category).toBe('coding')
  })
  test('chat vs agent ≥ 95% (running a chat as the agent counts as acceptable), and not everything as the agent', () => {
    expect(ALL.r.kindLenient).toBeGreaterThanOrEqual(95)
    expect(ALL.r.kindStrict).toBeGreaterThanOrEqual(88)
  })
  test('effort within one level ≥ 97%, too low ≤ 2%', () => {
    expect(ALL.r.effortWithinOne).toBeGreaterThanOrEqual(97)
    expect(ALL.r.effortUnder).toBeLessThanOrEqual(2)
  })
  // Calibration. The rules were tuned on these items, so their precision here is near 100% and says little;
  // RULE_CONFIDENCE comes from the blind batches instead (holdout2 measured before any fix: the specific paths
  // were right on every item they fired on, the fallbacks were not: chat 5/12, chat:question 5/9, connector 2/4).
  // What must hold on any data: the fallbacks sit below CONFIDENT, the specific paths above it, and confident
  // decisions are right more often than unsure ones.
  test('confidence: fallbacks are unsure, specific paths confident, and confident decisions are more often right', () => {
    for (const r of ['chat', 'chat:question', 'imperative', 'office:weak', 'agent-tools:weak']) expect(RULE_CONFIDENCE[r], r).toBeLessThan(CONFIDENT)
    for (const r of ['voice', 'long-context', 'follow-up', 'computer-use', 'cad', 'coding', 'code-quick', 'math', 'research', 'office', 'vision', 'agent-tools:self', 'agent-tools:mine']) expect(RULE_CONFIDENCE[r], r).toBeGreaterThanOrEqual(CONFIDENT)
    let sure = 0, sureOk = 0, unsure = 0, unsureOk = 0
    for (const it of EVAL.items) {
      const { d } = predict(it)
      if (d.confident) { sure++; if (d.category === it.category) sureOk++ } else { unsure++; if (d.category === it.category) unsureOk++ }
    }
    console.log(`[routing-eval] confident ${sureOk}/${sure}, unsure ${unsureOk}/${unsure}, ECE ${ALL.r.ece}`)
    expect(sureOk / sure).toBeGreaterThanOrEqual(0.95)
    expect(unsure).toBeGreaterThan(0)
  })
})

describe('one decision: chat-vs-agent and category never contradict', () => {
  test('intent.ts (with or without the routed decision) agrees with the router on every item', () => {
    for (const it of EVAL.items) {
      const { d, kind, alone } = predict(it)
      expect(kind, it.id).toBe(d.kind)
      // Called alone, intent.ts knows less (no images, no token counts): it may only lean toward the agent.
      if (alone !== d.kind) expect(alone, `${it.id}: ${it.text}`).toBe('agent')
      expect(consistent(d), `${it.id}: ${d.category}/${d.kind} (${d.kindWhy})`).toBe(true)
    }
  })
})

describe('CAD: the CAD module\'s signals (cad/cad-intent.ts) are part of the decision', () => {
  test('a CAD build is cad, always the agent, High; an assembly Extra; a CAD question stays a chat', () => {
    const part = classifyTask('Model a bracket with two M4 holes in Onshape')
    expect(part).toMatchObject({ category: 'cad', kind: 'agent' })
    expect(['high', 'xhigh']).toContain(part.effort)
    expect(classifyKind('Model a bracket with two M4 holes in Onshape').kind).toBe('agent')
    expect(classifyTask('Design an intake for our FRC robot, full assembly with mates').effort).toBe('xhigh')
    expect(classifyTask('What tolerance should I use for a press fit 608 bearing in a PLA print?')).toMatchObject({ category: 'cad', kind: 'chat' })
  })
})
