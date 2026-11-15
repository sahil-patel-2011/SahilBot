import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Attachment, Effort, FastModeSettings, ModelInfo, Tier } from '@shared/types'
import { rankOf, tierOf } from '../../src/main/llm/catalog'
import { CLAUDE as CLAUDE_SPECS, isPremiumClaude } from '../../src/main/llm/claude-models'
import { OPENAI as OPENAI_SPECS, isPremiumOpenAI } from '../../src/main/llm/openai-models'
import { xaiInfo, xaiRank } from '../../src/main/llm/xai-models'
import { PLAN_PROVIDER, planModelId, isPlanModel } from '../../src/main/llm/codex/ids'
import { routingPrefs } from '../../src/main/llm/router'
import { ROUTING_TABLE, payPerUse, routeTier, slotOf, slotsFor, spendingPrefs, windowOf, type AutoPreference } from '../../src/main/llm/routing-table'
import { classifyTask, type TaskCategory, type TaskClass, type TaskContext } from '../../src/main/llm/task-classifier'
import { autoRoute, budgetTightFor, closeCall, slotPrice, slotTtft, type AutoRouteResult } from '../../src/main/llm/auto-route'
import { resolveEffort } from '../../src/main/llm/auto-effort'
import { fastSupport, fastTierFor, SPEED_SENSITIVE } from '../../src/main/llm/fast-mode'
import { ModelHealth } from '../../src/main/llm/model-health'
import { planFallback } from '../../src/main/llm/auto-route'
import { openaiError } from '../../src/main/llm/openai-responses'

// The Auto simulator (tests/unit/auto-matrix.test.ts): every realistic setup (keys, local models, preference,
// monthly limit, fast mode, Fable, an OpenAI account with no credit) × every request in the routing eval set,
// through the same pure decision the agent loop makes (llm/auto-route.ts autoRoute), with the invariants Auto
// must keep checked independently of how it keeps them. No network, no model calls.

// ---------------------------------------------------------------------------------------------------
// Models, as Endpoints lists them for each key.
// ---------------------------------------------------------------------------------------------------

const LABEL: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-fable-5-2': 'Claude Fable 5.2',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6-astra': 'GPT-6 Astra', 'gpt-5.5-pro': 'GPT-5.5 Pro', 'grok-4.7': 'Grok 4.7'
}

function claude(id: string): ModelInfo {
  const spec = CLAUDE_SPECS.find((c) => c.id === id)!
  return { id, provider: 'anthropic', providerName: 'Anthropic', enabled: true, installed: true, tier: tierOf(id), rank: rankOf(id), vision: true, tools: true, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote', contextTokens: spec.contextTokens, maxOutputTokens: spec.maxOutput, label: LABEL[id], price: spec.price ? { input: spec.price.input, output: spec.price.output } : undefined }
}
function gpt(id: string): ModelInfo {
  const spec = OPENAI_SPECS.find((o) => o.id === id)!
  return { id, provider: 'openai', providerName: 'OpenAI', enabled: true, installed: true, tier: tierOf(id), rank: rankOf(id), vision: true, tools: true, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote', contextTokens: spec.contextTokens ?? 1_050_000, label: LABEL[id], price: { input: spec.price.input, output: spec.price.output } }
}
function grok(id: string): ModelInfo {
  const g = xaiInfo(id)!
  return { id, provider: 'xai', providerName: 'xAI', enabled: true, installed: true, tier: g.tier, rank: xaiRank(id), vision: g.vision, tools: g.tools, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote', contextTokens: g.contextTokens, label: LABEL[id], price: { input: g.price.input, output: g.price.output } }
}
function plan(codexId: string): ModelInfo {
  const g = gpt(codexId)
  return { ...g, id: planModelId(codexId), provider: PLAN_PROVIDER, providerName: 'ChatGPT plan (via Codex)', label: `${g.label} · ChatGPT plan`, price: { input: 0, output: 0 } }
}
const local = (id: string, tier: Tier, o: Partial<ModelInfo>): ModelInfo => ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, tier, rank: rankOf(id), vision: false, tools: true, requiredGB: 8, maxFittingWindow: 65536, fits: true, label: id, ...o })

export const CLAUDE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2'].map(claude)
export const OPENAI_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5-pro'].map(gpt)
export const GROK_MODELS = [grok('grok-4.7')]
export const PLAN_MODELS = ['gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'].map(plan)
export const LOCAL_MODELS = [local('lfm3:1.7b', 0, {}), local('gemma4:12b', 1, { vision: true }), local('qwen3.8:27b', 2, { vision: true, maxFittingWindow: 131072 })]

// ---------------------------------------------------------------------------------------------------
// Setups.
// ---------------------------------------------------------------------------------------------------

export const KEY_SETUPS = ['claude', 'openai', 'grok', 'claude+openai', 'claude+grok', 'openai+grok', 'all3', 'plan', 'plan+claude', 'plan+all'] as const
export type Keys = typeof KEY_SETUPS[number]
export type Spending = 'plenty' | 'tight' | 'exhausted' | 'unlimited' | 'none'
export const SPENDING: Spending[] = ['plenty', 'tight', 'exhausted', 'unlimited', 'none']
export type FastSetting = 'off' | 'one' | 'speed'
export const FAST: FastSetting[] = ['off', 'one', 'speed']
export const PREFS: AutoPreference[] = ['best', 'balanced', 'cheapest']

export interface Setup { keys: Keys; local: boolean; preference: AutoPreference; spending: Spending; fable: boolean; noCredit: boolean }

const has = (k: Keys, p: 'claude' | 'openai' | 'grok' | 'plan'): boolean => k === 'all3' || k === 'plan+all' ? p !== 'plan' || k === 'plan+all' : k.split('+').includes(p)
export const hasOpenAIKey = (k: Keys): boolean => has(k, 'openai')

/** Every routing setup (fast mode doesn't change the pick, so it is checked per pick, not as a setup). */
export function setups(): Setup[] {
  const out: Setup[] = []
  for (const keys of KEY_SETUPS) for (const loc of [false, true]) for (const preference of PREFS) for (const spending of SPENDING) for (const fable of [false, true]) {
    for (const noCredit of hasOpenAIKey(keys) ? [false, true] : [false]) out.push({ keys, local: loc, preference, spending, fable, noCredit })
  }
  return out
}
export const setupName = (s: Setup): string => `${s.keys}${s.local ? '+local' : ''} · ${s.preference} · ${s.spending}${s.fable ? ' · fable' : ''}${s.noCredit ? ' · openai-no-credit' : ''}`

/** Everything the keys list (before the monthly limit and the model on/off choices). */
export function listed(s: Pick<Setup, 'keys' | 'local'>): ModelInfo[] {
  return [
    ...(s.local ? LOCAL_MODELS : []),
    ...(has(s.keys, 'claude') ? CLAUDE_MODELS : []),
    ...(has(s.keys, 'openai') ? OPENAI_MODELS : []),
    ...(has(s.keys, 'grok') ? GROK_MODELS : []),
    ...(has(s.keys, 'plan') ? PLAN_MODELS : [])
  ]
}

/** Endpoints.usable() for a setup: the monthly limit drops what it can't pay for (None: every pay-per-use model). */
export function usableFor(s: Setup): ModelInfo[] {
  let ms = listed(s)
  if (s.spending === 'none') ms = ms.filter((m) => !payPerUse(m))
  if (s.spending === 'exhausted') ms = ms.filter((m) => !payPerUse(m))
  return ms
}

export const CAP = 200
export const leftFor = (s: Setup): number => (s.spending === 'plenty' ? 150 : s.spending === 'tight' ? 12 : s.spending === 'exhausted' ? 0 : s.spending === 'unlimited' ? Infinity : 0)
export const modeFor = (s: Setup): 'amount' | 'unlimited' | 'none' => (s.spending === 'unlimited' ? 'unlimited' : s.spending === 'none' ? 'none' : 'amount')

/** The module-level preferences Endpoints.usable() sets before each pick. */
export function applyPrefs(s: Setup): void {
  const anyKey = has(s.keys, 'claude') || has(s.keys, 'openai') || has(s.keys, 'grok') || has(s.keys, 'plan')
  routingPrefs.preferCloud = anyKey || !s.local
  routingPrefs.fableForHardest = s.fable
  spendingPrefs.mode = modeFor(s)
}
export function resetPrefs(): void {
  routingPrefs.preferCloud = false
  routingPrefs.fableForHardest = false
  spendingPrefs.mode = 'amount'
}

export const fastSettingsFor = (f: FastSetting): { fastMode: FastModeSettings } => ({
  fastMode: f === 'off' ? { providers: { anthropic: false, openai: false, xai: false }, models: {}, auto: 'speed' }
    : f === 'one' ? { providers: { anthropic: true, openai: false, xai: false }, models: {}, auto: 'allowed' }
      : { providers: { anthropic: true, openai: true, xai: true }, models: {}, auto: 'speed' }
})

// ---------------------------------------------------------------------------------------------------
// The eval set, classified as loop.ts classifies a request.
// ---------------------------------------------------------------------------------------------------

export interface EvalItem {
  id: string; split: string; text: string
  ctx?: {
    files?: Array<{ name: string; tokens?: number }>; folders?: number; images?: number; voice?: boolean; codeProject?: boolean; openPlan?: boolean
    flags?: Record<string, boolean>; prev?: { category: TaskCategory; difficulty: Tier; kind: 'chat' | 'agent'; effort: Effort; text?: string }
    bot?: { name: string; role: string }; routine?: boolean; group?: boolean; helper?: boolean
  }
  category: TaskCategory; kind: 'chat' | 'agent'; difficulty: Tier; effort: Effort; tags?: string[]
}
export const EVAL = JSON.parse(readFileSync(join(__dirname, 'routing-eval.json'), 'utf8')) as { items: EvalItem[] }

export function contextOf(it: EvalItem): TaskContext {
  const c = it.ctx ?? {}
  const attachments: Attachment[] = [...(c.files ?? []).map((x) => ({ kind: 'file' as const, path: `/tmp/${x.name}`, name: x.name })), ...Array.from({ length: c.folders ?? 0 }, (_, i) => ({ kind: 'folder' as const, path: `/tmp/f${i}`, name: `f${i}` }))]
  const inputTokens = Math.round(it.text.length / 4) + (c.files ?? []).reduce((n, x) => n + (x.tokens ?? 0), 0)
  return {
    attachments, images: c.images, voice: c.voice, openPlan: c.openPlan, codeProject: c.codeProject,
    previousTier: c.prev?.difficulty, previousCategory: c.prev?.category, previousKind: c.prev?.kind, previousEffort: c.prev?.effort,
    role: c.bot ? `${c.bot.name}: ${c.bot.role}` : undefined, helper: c.helper, unattended: c.routine, group: c.group,
    inputTokens, contextTokens: inputTokens, ...c.flags
  }
}

/** The effort the loop sends on Auto (loop.ts effortNow before any mid-run bump). */
export function loopEffort(task: TaskClass, voice: boolean, ctx: TaskContext): Effort {
  const LV: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  const base = resolveEffort('auto', { category: task.category, difficulty: task.difficulty, task: task.kind === 'agent' && task.difficulty >= 2, voice, heavy: !!(ctx.heavy || ctx.deepResearch), council: !!ctx.council })
  if (voice) return base
  return LV.indexOf(task.effort) > LV.indexOf(base) ? task.effort : base
}

// ---------------------------------------------------------------------------------------------------
// One pick, and the invariants.
// ---------------------------------------------------------------------------------------------------

export { windowOf }
export const isPremium = (m: ModelInfo): boolean => isPremiumClaude(m.id) || isPremiumOpenAI(m.id)
export const isLocal = (m: ModelInfo): boolean => !(m.note === 'remote' || m.note === 'added by you' || ['anthropic', 'openai', 'openrouter', 'xai', 'chatgpt'].includes(m.provider))
const cheapTier = (m: ModelInfo): boolean => m.tier <= 1
const isGrokM = (m: ModelInfo): boolean => m.provider === 'xai'

export interface SimPick { result?: AutoRouteResult; error?: string; failed?: string[]; notes: string[] }

/**
 * Auto's pick for a request under a setup, as the loop makes it: autoRoute; then, on an OpenAI account with no
 * credit, the 402 (the stream error shape seen live) on any OpenAI model but the two cheapest, the health mark,
 * and planFallback, until a model answers (at most 3 tries, never the same model twice).
 */
export function pickFor(s: Setup, task: TaskClass, o: { voice?: boolean; previous?: { model: string; category?: TaskCategory }; health: ModelHealth; now: number; usable?: ModelInfo[] }): SimPick {
  const usable = o.usable ?? usableFor(s)
  const budgetTight = budgetTightFor(modeFor(s), CAP, leftFor(s), usable)
  const notes: string[] = []
  let r: AutoRouteResult
  try {
    r = autoRoute({ requested: 'auto', usable, task, preference: s.preference, budgetTight, voice: o.voice, previous: o.previous, health: o.health, now: o.now })
  } catch (e) { return { error: (e as Error).message, notes } }
  const failed: string[] = []
  const tried = new Set<string>([r.model])
  for (let i = 0; i < 3; i++) {
    const m = usable.find((x) => x.id === r.model)!
    if (!(s.noCredit && m.provider === 'openai' && !['gpt-6-luna', 'gpt-6.1-terra'].includes(m.id))) break
    // {type:'error', error:{code:'insufficient_quota'}} as streamResponses reads it.
    const err = openaiError(undefined, { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' }, undefined, m.id)
    failed.push(m.id)
    o.health.mark(m, err, o.now)
    const f = planFallback({ usable, task, current: m, err, tried, preference: s.preference, budgetTight, health: o.health, now: o.now })
    if (!f.model) return { error: f.note ?? 'no fallback', failed, notes }
    tried.add(f.model.id)
    notes.push(f.note!)
    r = { ...r, model: f.model.id, label: f.label ?? r.label, why: `${r.why} · ${f.note}` }
  }
  return { result: r, failed, notes }
}

export interface Check { s: Setup; item: EvalItem; task: TaskClass; pick: SimPick; usable: ModelInfo[]; fast?: FastSetting; previous?: string; health: ModelHealth; now: number }

/** The invariant violations of one pick (empty: all hold). Each is "name: detail". */
export function violations(c: Check): string[] {
  const out: string[] = []
  const { s, task, pick, usable } = c
  const r = pick.result
  const voice = !!c.item.ctx?.voice
  if (!r) {
    // An error is right only when nothing suitable is usable.
    const alive = c.health.filter(usable, c.now)
    const suitable = alive.filter((m) => !(isGrokM(m) && (task.category === 'computer-use' || task.category === 'voice' || voice)))
    if (suitable.length && !/no model to use|isn't available|Grok/.test(pick.error ?? '')) out.push(`error-with-models: ${pick.error}`)
    return out
  }
  const m = usable.find((x) => x.id === r.model)
  if (!m) { out.push(`unavailable: ${r.model}`); return out }
  if (c.health.blocked(m, c.now)) out.push(`cooling-down: ${m.id} is blocked (${c.health.blocked(m, c.now)!.kind})`)
  if (!s.local && isLocal(m)) out.push(`local-when-off: ${m.id}`)
  if (s.spending === 'none' && payPerUse(m)) out.push(`paid-in-none-mode: ${m.id}`)
  if ((s.spending === 'exhausted') && payPerUse(m)) out.push(`paid-when-exhausted: ${m.id}`)
  // Fast mode: only where Settings allow it, and on Auto's speed rule only for speed-sensitive requests.
  for (const f of FAST) {
    const tier = fastTierFor(m.id, fastSettingsFor(f), { auto: true, speedSensitive: voice || SPEED_SENSITIVE.has(task.category) })
    if (!tier) continue
    const sup = fastSupport(m.id)
    if (f === 'off') out.push(`fast-when-off: ${m.id}`)
    if (f === 'one' && sup?.provider !== 'anthropic') out.push(`fast-wrong-provider: ${m.id}`)
    if (f === 'speed' && !(voice || SPEED_SENSITIVE.has(task.category))) out.push(`fast-not-speed-sensitive: ${m.id} (${task.category})`)
    if (isPlanModel(m.id) || isLocal(m)) out.push(`fast-on-plan-or-local: ${m.id}`)
  }
  // Fable only with the setting (at the hardest tier of a row the evidence puts it first in).
  if (isPremiumClaude(m.id)) {
    const tier = routeTier(task.category, task.difficulty, budgetTightFor(modeFor(s), CAP, leftFor(s), usable) ? 'cheapest' : s.preference)
    // A Balanced close call routes at Best result's tier.
    const at = r.pick?.source === 'close-call' ? routeTier(task.category, task.difficulty, 'best') : tier
    const allowed = s.fable && ROUTING_TABLE[task.category].fable === true && (at === 3 || c.previous === m.id)
    if (!allowed && usable.some((x) => !isPremiumClaude(x.id) && !isPremiumOpenAI(x.id))) out.push(`fable-not-allowed: ${task.category} tier ${tier}`)
  }
  if (isPremiumOpenAI(m.id)) out.push(`gpt-pro: ${m.id}`)
  // The window must hold the prompt when any usable model can.
  const need = task.contextTokens > 0 ? task.contextTokens + 16_000 : 0
  if (need && windowOf(m) < need && usable.some((x) => windowOf(x) >= need)) out.push(`window-too-small: ${m.id} ${windowOf(m)} < ${need}`)
  if (task.needsVision && !m.vision && usable.some((x) => x.vision)) out.push(`no-vision: ${m.id}`)
  if (isGrokM(m) && (task.category === 'computer-use' || task.category === 'voice' || voice)) out.push(`grok-for-${voice ? 'voice' : task.category}`)
  // The ChatGPT plan can't pass screenshots back to the model (docs/chatgpt-plan.md): never for computer use
  // while another model can do it.
  if (isPlanModel(m.id) && task.category === 'computer-use' && usable.some((x) => !isPlanModel(x.id) && !isGrokM(x) && x.vision && c.health.filter(usable, c.now).includes(x))) out.push('plan-for-computer-use')
  // Effort: never below the rubric.
  const LV: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
  const e = loopEffort(task, voice, contextOf(c.item))
  if (!voice && LV.indexOf(e) < LV.indexOf(task.effort)) out.push(`effort-below-rubric: ${e} < ${task.effort}`)
  // The label names the model and the kind of task; the tooltip says why.
  if (!r.label.includes(m.label || m.id) && !r.label.includes(m.id)) out.push(`label-model: "${r.label}" for ${m.id}`)
  if (!r.why || !r.why.includes(task.why.split(' · ')[0])) out.push(`label-why: "${r.why}"`)
  if (c.previous && r.model === c.previous && r.pick?.source === 'sticky' && !/last reply|same model|same provider/.test(r.why)) out.push('label-sticky-unexplained')
  if (pick.failed?.length && !pick.notes.length) out.push('fallback-without-note')
  if (pick.failed?.some((id) => id === r.model)) out.push(`retried-failed-model: ${r.model}`)
  // Coding: the strongest coding model the table offers (Best result / Balanced, budget not tight).
  const tight = budgetTightFor(modeFor(s), CAP, leftFor(s), usable)
  const alive = c.health.filter(usable, c.now).filter((x) => !pick.failed?.includes(x.id))
  const eligible = (x: ModelInfo): boolean => x.tools !== false && (!task.needsVision || x.vision || !alive.some((y) => y.vision)) && (!need || windowOf(x) >= need || !alive.some((y) => windowOf(y) >= need))
  if (task.category === 'coding' && s.preference !== 'cheapest' && !tight) {
    const tier = routeTier('coding', task.difficulty, s.preference)
    const row = slotsFor('coding', tier, s.preference, s.fable)
    const hardest = slotsFor('coding', 3, 'best', s.fable)
    const cloud = alive.filter((x) => !isLocal(x) && eligible(x) && !isPremiumOpenAI(x.id) && (s.fable || !isPremiumClaude(x.id)))
    const first = row.find((slot) => cloud.some((x) => slotOf(x) === slot))
    const strength = (x: ModelInfo): number => { const i = hardest.indexOf(slotOf(x) as never); return i < 0 ? 99 : i }
    if (first) {
      if (isLocal(m)) out.push(`coding-local-over-cloud: ${m.id}`)
      else if (strength(m) > hardest.indexOf(first)) out.push(`coding-not-strongest: ${m.id} (table: ${first})`)
    }
  }
  // Quality bias: Best result at the hardest tier never answers with a light (cheap / fast) model when a
  // standard-or-better one is usable.
  if (s.preference === 'best' && !tight && routeTier(task.category, task.difficulty, 'best') === 3 && cheapTier(m)) {
    // "Stronger": a model the category's hardest row names (the table's own judgment of who is up to the hardest
    // work), or a standard-or-better local model when no cloud model is on (agent work goes to the cloud otherwise).
    const hardest = slotsFor(task.category, 3, 'best', s.fable)
    const cloudAlive = alive.some((x) => !isLocal(x) && eligible(x))
    const stronger = alive.filter((x) => eligible(x) && !isPremiumOpenAI(x.id) && (s.fable || !isPremiumClaude(x.id)) && !(isGrokM(x) && (task.category === 'computer-use' || voice)) && !(isPlanModel(x.id) && task.category === 'computer-use') &&
      (isLocal(x) ? !cloudAlive && !cheapTier(x) : hardest.includes(slotOf(x) as never)))
    if (stronger.length && !(slotOf(m) && hardest.includes(slotOf(m)!))) out.push(`best-hardest-got-light: ${m.id} (could use ${stronger[0].id})`)
  }
  // Balanced close calls: when Best result's pick differs, it is taken iff it costs at most 2x and isn't much slower.
  if (s.preference === 'balanced' && !tight && closeCall(task) && r.pick && r.pick.source !== 'sticky' && !pick.failed?.length) {
    const best = autoRoute({ requested: 'auto', usable, task, preference: 'best', voice, health: c.health, now: c.now })
    const bm = usable.find((x) => x.id === best.model)!
    if (best.model !== r.model && !isLocal(bm) && !isLocal(m)) {
      const sb = slotOf(bm), sm = slotOf(m)
      if (sb && sm && slotPrice(bm) <= 2 * slotPrice(m) + 1e-9 && slotTtft(sb) <= slotTtft(sm) + (SPEED_SENSITIVE.has(task.category) || voice ? 1 : 3)) out.push(`balanced-close-call-not-upgraded: ${m.id} (Best: ${bm.id})`)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// Multi-turn conversations, for stability (flip rate).
// ---------------------------------------------------------------------------------------------------

const FOLLOW_UPS = ['yes, go ahead', 'thanks!', 'continue', 'ok, do the same for the next one', 'perfect, thanks', 'try again']

export interface Turn { text: string; ctx: TaskContext; voice: boolean }
/**
 * Conversations built from the eval set: same-category runs (request, follow-up, request, follow-up, request),
 * deterministic. A turn's previous decision (tier, category, kind, effort) is filled in as the loop does.
 */
export function conversations(): Turn[][] {
  const byCat = new Map<TaskCategory, EvalItem[]>()
  for (const it of EVAL.items) if (!it.ctx?.prev && !it.ctx?.voice) (byCat.get(it.category) ?? byCat.set(it.category, []).get(it.category)!).push(it)
  const out: Turn[][] = []
  let f = 0
  for (const items of byCat.values()) {
    for (let i = 0; i + 2 < items.length; i += 3) {
      const turns: Turn[] = []
      for (let j = 0; j < 3; j++) {
        const it = items[i + j]
        turns.push({ text: it.text, ctx: contextOf(it), voice: false })
        if (j < 2) turns.push({ text: FOLLOW_UPS[f++ % FOLLOW_UPS.length], ctx: {}, voice: false })
      }
      out.push(turns)
    }
  }
  return out
}

/** Classify each turn with the previous turn's decision, as loop.ts chooseModel does. */
export function classifyConversation(turns: Turn[]): TaskClass[] {
  const out: TaskClass[] = []
  // The history goes with every request: the prompt grows by each turn (a long document stays in it).
  let history = 0
  for (const t of turns) {
    const p = out[out.length - 1]
    const own = t.ctx.inputTokens ?? Math.round(t.text.length / 4)
    out.push(classifyTask(t.text, { ...t.ctx, inputTokens: own, contextTokens: history + own, ...(p ? { previousTier: p.difficulty, previousCategory: p.category, previousKind: p.kind, previousEffort: p.effort } : {}) }))
    history += own + 400
  }
  return out
}

export const providerOfModel = (id: string, usable: ModelInfo[]): string => usable.find((m) => m.id === id)?.provider ?? '?'
