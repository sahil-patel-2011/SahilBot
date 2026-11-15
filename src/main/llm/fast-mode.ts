import type { FastChoice, FastModeSettings, FastTier, Settings } from '@shared/types'
import { claudeSpec } from './claude-models'
import { openaiSpec } from './openai-models'
import { xaiInfo } from './xai-models'

// Fast mode: each provider's official way to buy speed, per provider and per model (Settings → Models →
// Fast mode). Off unless switched on. Facts, read 2026-11-15 (quotes and links in docs/model-routing.md
// "Fast mode" and docs/grok.md):
//
// Anthropic (platform.claude.com/docs/en/build-with-claude/fast-mode): `speed: "fast"` on the Messages request,
//   "up to 2.5x higher output tokens per second" (OTPS, not time to first token). Available on Claude Fable 5.2,
//   Mythos 5.2 and Opus 5.5 with no beta header; research preview on Opus 5 and deprecated on Opus 4.8 (removal
//   Nov 30, 2026), both needing the `fast-mode-2026-02-01` beta header. Prices: Fable / Mythos 5.2 $16 / $80,
//   Opus 5.5 $8 / $40, Opus 5 and 4.8 $10 / $50 per MTok: 2x each model's standard rate, across the whole window;
//   prompt-caching multipliers apply on top. usage.speed says which speed ran; over the fast limit the API
//   answers 429 / 529, and the documented fallback is to resend without `speed` (standard price).
// OpenAI (developers.openai.com/api/docs/guides/fast-mode, /ultrafast-mode, /pricing): `service_tier: "fast"`
//   (Priority was renamed Fast mode on July 30, 2026; "priority" behaves the same), "up to 2.5x faster", 2x the
//   Standard rate on most models (gpt-5.5 2.5x; older models 1.67x-1.8x, per the Fast price table), on the
//   Responses and Chat Completions APIs; a request may be downgraded to standard speed and standard price
//   (the response then says service_tier "default"). Ultrafast: `service_tier: "ultrafast"`, "the fastest service
//   tier", only gpt-6-astra and gpt-6.1-sol, 6x Standard for every token type, on the Responses API.
// xAI (docs.x.ai pricing and REST reference): `service_tier: "priority"` ("fast" is the same tier), on Chat
//   Completions and Responses, scheduled ahead of standard traffic when priority capacity is free, "billed at a
//   2x premium over standard rates", only "when the response confirms service_tier: priority". (Grok 4.7 Fast is
//   a separate model for Cursor and Grok Build only, "not available on the public xAI API".)

export type FastProvider = 'anthropic' | 'openai' | 'xai'

export interface FastSupport {
  provider: FastProvider
  /** The table id the support belongs to (dated snapshots and aliases map to it). */
  id: string
  /** Price multiplier on standard rates (every token type, caching discounts applied first). */
  factor: number
  /** OpenAI Ultrafast (gpt-6-astra, gpt-6.1-sol): 6x Standard. */
  ultrafast?: number
  /** Anthropic: needs the fast-mode-2026-02-01 beta header (research preview / deprecated models). */
  beta?: boolean
  /** Shown next to the model: availability caveats. */
  note?: string
}

/** Anthropic: 2x on every model the fast-mode page lists. */
const CLAUDE_FAST: Record<string, { beta?: boolean; note?: string }> = {
  'claude-fable-5-2': {},
  'claude-mythos-5-2': {},
  'claude-opus-5-5': {},
  'claude-opus-5': { beta: true, note: 'Research preview: needs fast mode access from Anthropic (waitlist)' },
  'claude-opus-4-8': { beta: true, note: 'Deprecated: Anthropic removes fast mode on Opus 4.8 on Nov 30, 2026' }
}

/** OpenAI Fast multipliers, from the Fast price table (Fast rate ÷ Standard rate, the same for every token type). */
const OPENAI_FAST: Record<string, number> = {
  'gpt-6-astra': 2, 'gpt-6.1-sol': 2, 'gpt-6.1-terra': 2, 'gpt-6-luna': 2, 'gpt-6-sol': 2,
  'gpt-5.6-sol': 2, 'gpt-5.6-terra': 2, 'gpt-5.6-luna': 2,
  // gpt-5.5: $12.50 / $75 vs $5 / $30. Its Fast row covers prompts under 272K only.
  'gpt-5.5': 2.5, 'gpt-5.4': 2, 'gpt-5.4-mini': 2, 'gpt-5.2': 2, 'gpt-5.1': 2, 'gpt-5': 2,
  'gpt-5-mini': 1.8, 'gpt-4.1': 1.75, 'gpt-4.1-mini': 1.75, 'gpt-4o': 1.7, 'gpt-4o-mini': 0.25 / 0.15, 'o3': 1.75
}
const OPENAI_ULTRAFAST: Record<string, number> = { 'gpt-6-astra': 6, 'gpt-6.1-sol': 6 }
/** xAI Priority Processing: 2x for all token types. */
export const XAI_PRIORITY_FACTOR = 2

/** Which fast mechanism a model has (undefined: none; local and plan models never do). */
export function fastSupport(model: string): FastSupport | undefined {
  const id = model.trim().toLowerCase()
  if (/^claude-/.test(id)) {
    const spec = claudeSpec(id)
    // claudeSpec maps dated snapshots to their alias; mythos-5-2 isn't in the Claude table yet, so match by id too.
    const key = Object.keys(CLAUDE_FAST).find((k) => k === id || k === spec?.id || (id.startsWith(`${k}-`) && /^\d{8}$/.test(id.slice(k.length + 1))))
    if (!key) return undefined
    return { provider: 'anthropic', id: key, factor: 2, ...CLAUDE_FAST[key] }
  }
  const gpt = openaiSpec(id)
  if (gpt && OPENAI_FAST[gpt.id]) return { provider: 'openai', id: gpt.id, factor: OPENAI_FAST[gpt.id], ...(OPENAI_ULTRAFAST[gpt.id] ? { ultrafast: OPENAI_ULTRAFAST[gpt.id] } : {}) }
  const grok = xaiInfo(id)
  if (grok && !grok.special) return { provider: 'xai', id: grok.id, factor: XAI_PRIORITY_FACTOR }
  return undefined
}

/** The price multiplier for a request run at `tier` (1 at standard speed, or when the model has no such tier). */
export function fastFactor(model: string, tier: FastTier | 'standard' | null | undefined): number {
  if (!tier || tier === 'standard') return 1
  const s = fastSupport(model)
  if (!s) return 1
  return tier === 'ultrafast' ? s.ultrafast ?? s.factor : s.factor
}

export const DEFAULT_FAST: FastModeSettings = { providers: { anthropic: false, openai: false, xai: false }, models: {}, auto: 'speed' }

/** The saved Fast mode settings, cleaned (unknown values dropped). */
export function fastSettings(s: Pick<Settings, 'fastMode'> | undefined): FastModeSettings {
  const f = s?.fastMode
  const models: FastModeSettings['models'] = {}
  for (const [k, v] of Object.entries(f?.models ?? {})) if (v === 'on' || v === 'off' || v === 'ultrafast') models[k.toLowerCase()] = v
  return {
    providers: { anthropic: !!f?.providers?.anthropic, openai: !!f?.providers?.openai, xai: !!f?.providers?.xai },
    models,
    auto: f?.auto === 'allowed' || f?.auto === 'never' ? f.auto : 'speed'
  }
}

/** What one model is set to: its own override, or 'inherit' (its provider's switch). */
export function fastChoice(model: string, s: Pick<Settings, 'fastMode'> | undefined): FastChoice {
  const sup = fastSupport(model)
  const f = fastSettings(s)
  return (sup && (f.models[sup.id] ?? f.models[model.toLowerCase()])) || 'inherit'
}

export interface FastContext {
  /** The model was picked by Auto (not chosen by name for the chat, bot or default). */
  auto?: boolean
  /** The request is speed-sensitive: voice, small talk, a quick code question. */
  speedSensitive?: boolean
}

/**
 * The tier a request to `model` runs at, or undefined for standard speed. Fast only when it's allowed: the
 * model's own override (on / ultrafast), else its provider's switch. Auto adds its own rule on top
 * (Settings → Fast mode → "When Auto picks the model"): 'speed' (default) only for speed-sensitive requests,
 * 'allowed' whenever allowed, 'never'. Ultrafast is used only where it was chosen for that model.
 */
export function fastTierFor(model: string, s: Pick<Settings, 'fastMode'> | undefined, ctx: FastContext = {}): FastTier | undefined {
  const sup = fastSupport(model)
  if (!sup) return undefined
  const f = fastSettings(s)
  const choice = fastChoice(model, s)
  if (choice === 'off') return undefined
  const allowed = choice === 'on' || choice === 'ultrafast' || (choice === 'inherit' && f.providers[sup.provider])
  if (!allowed) return undefined
  if (ctx.auto && (f.auto === 'never' || (f.auto === 'speed' && !ctx.speedSensitive))) return undefined
  return choice === 'ultrafast' && sup.ultrafast ? 'ultrafast' : 'fast'
}

/** Categories where a faster reply is what the request needs (Auto's 'speed' rule). */
export const SPEED_SENSITIVE = new Set(['chat', 'code-quick', 'voice'])

/**
 * Set by the app: the tier the current request runs at (reads the chat in progress: whether Auto picked
 * the model, and what kind of request it is). The client asks it for every paid request that doesn't
 * say; the per-step cost chip asks it too, so both price the same way.
 */
export const fastHooks: { resolve?: (model: string) => FastTier | undefined } = {}

/** The tier the hook gives for a model now (undefined: standard, or no hook). */
export function currentFastTier(model: string): FastTier | undefined {
  try { return fastHooks.resolve?.(model) } catch { return undefined }
}

/** One line for the Models page: what fast mode buys and costs on this model. */
export function fastTradeoff(model: string): string | undefined {
  const s = fastSupport(model)
  if (!s) return undefined
  const x = (n: number): string => `${Math.round(n * 100) / 100}x`
  if (s.provider === 'anthropic') return `Up to 2.5x faster output, ${x(s.factor)} price${s.note ? ` · ${s.note}` : ''}`
  if (s.provider === 'openai') return `Fast: up to 2.5x faster, ${x(s.factor)} price${s.ultrafast ? ` · Ultrafast: OpenAI's fastest tier, ${x(s.ultrafast)} price` : ''}`
  return `Priority: served ahead of standard traffic when capacity is free, ${x(s.factor)} price (only when granted)`
}
