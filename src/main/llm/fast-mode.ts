import type { FastChoice, FastModeSettings, FastSpeedOption, FastTier, Settings } from '@shared/types'
import { claudeInfo, claudeSpec } from './claude-models'
import { openaiSpec } from './openai-models'
import { xaiInfo } from './xai-models'

// Fast mode: each provider's official way to buy speed, per provider and per model (Settings → Models →
// Fast mode). Off unless switched on. Facts, read 2026-11-15 and again 2026-11-18 (quotes and links in
// docs/model-routing.md "Fast mode" and docs/grok.md):
//
// Anthropic (platform.claude.com/docs/en/build-with-claude/fast-mode, /about-claude/pricing): `speed: "fast"` on the
//   Messages request, "up to 2.5x higher output tokens per second" (OTPS, not time to first token). Available on
//   Claude Fable 5.2, Mythos 5.2 and Opus 5.5 with no beta header; research preview on Opus 5 and deprecated on
//   Opus 4.8 (removal Nov 30, 2026), both needing the `fast-mode-2026-02-01` beta header. Prices: Fable / Mythos 5.2
//   $16 / $80, Opus 5.5 $8 / $40, Opus 5 and 4.8 $10 / $50 per MTok: 2x each model's standard rate, across the whole
//   window; prompt-caching multipliers apply on top. "Fast mode has a dedicated rate limit"; "not available with the
//   Batch API". usage.speed says which speed ran; over the fast limit the API answers 429 / 529, and the documented
//   fallback is to resend without `speed` (standard price; "results in a prompt cache miss"). There is no tier above
//   fast mode on the Claude API (no "ultra" tier on the fast-mode or pricing pages, 2026-11-18).
// OpenAI (developers.openai.com/api/docs/guides/fast-mode, /ultrafast-mode, /pricing, models/gpt-6.2-*):
//   `service_tier: "fast"` (Priority was renamed Fast mode on July 30, 2026; "priority" behaves the same), "up to 2.5x
//   faster speeds", 2x the Standard rate on the GPT-6.x lineup ("2x Standard for the same context length"; gpt-5.5
//   2.5x; older models 1.67x-1.8x, per the Fast price table), on the Responses and Chat Completions APIs; "Fast mode
//   consumption counts toward rate limits the same way as Standard"; "the system may downgrade some Fast mode requests
//   to standard speeds and charge standard rates" (the response then says service_tier "default").
//   Ultrafast: `service_tier: "ultrafast"`, "the fastest service tier in the OpenAI API", on GPT-6.2 Astra, GPT-6.2
//   Sol, GPT-6 Astra and GPT-6.1 Sol; "Ultrafast has separate rate limits from Standard and Fast modes"; every
//   example (and every changelog entry) is the Responses API; GPT-6.2 and GPT-6 Astra Ultrafast is US data residency
//   only. Price: 6x Standard on gpt-6-astra and gpt-6.1-sol; on GPT-6.2 Astra and Sol "Ultrafast costs 3 times the
//   Standard rate through February 28, 2027, and 6 times the Standard rate starting March 1, 2027 (Pacific time)".
//   Speed: Ultrafast "generates tokens at up to 4.5 times the speed of Standard" on GPT-6.2 Astra and Sol (OpenAI's
//   Codex speed page; the API guide gives no figure).
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
  /** OpenAI Ultrafast: its multiplier now (6x on gpt-6-astra / gpt-6.1-sol; 3x on GPT-6.2 until Feb 28, 2027, then 6x). */
  ultrafast?: number
  /** A dated Ultrafast price: `factor` through `lastDay` (Pacific time), `then` after it. */
  ultrafastSchedule?: UltrafastPrice
  /** Anthropic: needs the fast-mode-2026-02-01 beta header (research preview / deprecated models). */
  beta?: boolean
  /** Shown next to the model: availability caveats. */
  note?: string
}

/** Anthropic: 2x on every model the fast-mode page lists. (Mythos 5.2 isn't in the Claude table yet: its $8 / $40 is the pricing page's.) */
const CLAUDE_FAST: Record<string, { beta?: boolean; note?: string; price?: { input: number; output: number } }> = {
  'claude-fable-5-2': {},
  'claude-mythos-5-2': { price: { input: 8, output: 40 } },
  'claude-opus-5-5': {},
  'claude-opus-5': { beta: true, note: 'Research preview: needs fast mode access from Anthropic (waitlist)' },
  'claude-opus-4-8': { beta: true, note: 'Deprecated: Anthropic removes fast mode on Opus 4.8 on Nov 30, 2026' }
}

/** OpenAI Fast multipliers, from the Fast price table (Fast rate ÷ Standard rate, the same for every token type). */
const OPENAI_FAST: Record<string, number> = {
  'gpt-6.2-astra': 2, 'gpt-6.2-sol': 2,
  'gpt-6-astra': 2, 'gpt-6.1-sol': 2, 'gpt-6.1-terra': 2, 'gpt-6-luna': 2, 'gpt-6-sol': 2,
  'gpt-5.6-sol': 2, 'gpt-5.6-terra': 2, 'gpt-5.6-luna': 2,
  // gpt-5.5: $12.50 / $75 vs $5 / $30. Its Fast row covers prompts under 272K only.
  'gpt-5.5': 2.5, 'gpt-5.4': 2, 'gpt-5.4-mini': 2, 'gpt-5.2': 2, 'gpt-5.1': 2, 'gpt-5': 2,
  'gpt-5-mini': 1.8, 'gpt-4.1': 1.75, 'gpt-4.1-mini': 1.75, 'gpt-4o': 1.7, 'gpt-4o-mini': 0.25 / 0.15, 'o3': 1.75
}
export interface UltrafastPrice {
  factor: number
  /** The last day `factor` applies (Pacific time, YYYY-MM-DD). */
  lastDay: string
  /** When `then` starts: midnight Pacific after lastDay, as a UTC timestamp. */
  switchAt: number
  then: number
}
/** GPT-6.2 Ultrafast: "3 times the Standard rate through February 28, 2027, and 6 times ... starting March 1, 2027 (Pacific time)". */
export const GPT62_ULTRAFAST: UltrafastPrice = { factor: 3, lastDay: '2027-02-28', switchAt: Date.UTC(2027, 2, 1, 8), then: 6 }
/** Ultrafast multipliers from the Ultrafast price table (every token type, long context too). */
const OPENAI_ULTRAFAST: Record<string, number | UltrafastPrice> = { 'gpt-6.2-astra': GPT62_ULTRAFAST, 'gpt-6.2-sol': GPT62_ULTRAFAST, 'gpt-6-astra': 6, 'gpt-6.1-sol': 6 }
/** OpenAI's Ultrafast speed claim, where it gives one ("up to 4.5 times the speed of Standard" on GPT-6.2). */
const ULTRAFAST_SPEED: Record<string, number> = { 'gpt-6.2-astra': 4.5, 'gpt-6.2-sol': 4.5 }
/** Ultrafast's data residency: US only on GPT-6.2 and GPT-6 Astra; GPT-6.1 Sol also EU. */
const ULTRAFAST_US_ONLY = new Set(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra'])

/** A dated price's multiplier at `now` (ms). */
export const ultrafastAt = (u: number | UltrafastPrice, now: number = Date.now()): number => (typeof u === 'number' ? u : now >= u.switchAt ? u.then : u.factor)
/** xAI Priority Processing: 2x for all token types. */
export const XAI_PRIORITY_FACTOR = 2

/** Which fast mechanism a model has (undefined: none; local and plan models never do). `now` sets a dated Ultrafast price. */
export function fastSupport(model: string, now: number = Date.now()): FastSupport | undefined {
  const id = model.trim().toLowerCase()
  if (/^claude-/.test(id)) {
    const spec = claudeSpec(id)
    // claudeSpec maps dated snapshots to their alias; mythos-5-2 isn't in the Claude table yet, so match by id too.
    const key = Object.keys(CLAUDE_FAST).find((k) => k === id || k === spec?.id || (id.startsWith(`${k}-`) && /^\d{8}$/.test(id.slice(k.length + 1))))
    if (!key) return undefined
    return { provider: 'anthropic', id: key, factor: 2, ...CLAUDE_FAST[key] }
  }
  const gpt = openaiSpec(id)
  if (gpt && OPENAI_FAST[gpt.id]) {
    const u = OPENAI_ULTRAFAST[gpt.id]
    return { provider: 'openai', id: gpt.id, factor: OPENAI_FAST[gpt.id], ...(u ? { ultrafast: ultrafastAt(u, now), ...(typeof u === 'object' ? { ultrafastSchedule: u } : {}) } : {}) }
  }
  const grok = xaiInfo(id)
  if (grok && !grok.special) return { provider: 'xai', id: grok.id, factor: XAI_PRIORITY_FACTOR }
  return undefined
}

/**
 * The price multiplier for a request run at `tier` (1 at standard speed, or when the model has no such tier), at the
 * price in force at `now` (GPT-6.2 Ultrafast: 3x through Feb 28, 2027 Pacific, 6x from Mar 1).
 */
export function fastFactor(model: string, tier: FastTier | 'standard' | null | undefined, now: number = Date.now()): number {
  if (!tier || tier === 'standard') return 1
  const s = fastSupport(model, now)
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

const x = (n: number): string => `${Math.round(n * 100) / 100}x`
const usd = (n: number): string => `$${Number.isInteger(n) ? n : Math.round(n * 100) / 100}`
const pacificDay = (d: string): string => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** A model's standard $ per 1M tokens (short context), for the penalty text. */
function standardPrice(s: FastSupport): { input: number; output: number } | undefined {
  if (s.provider === 'anthropic') return CLAUDE_FAST[s.id]?.price ?? claudeInfo(s.id)?.price
  if (s.provider === 'openai') return openaiSpec(s.id)?.price
  return xaiInfo(s.id)?.price
}

/**
 * The speed choices a model offers, each with its penalty spelled out (Settings → Models → Fast mode): Standard,
 * Fast (the provider's fast / priority tier) and, where OpenAI offers it, Ultrafast. `line` is what the row shows:
 *   "Ultrafast · up to 4.5x faster · 3x price ($6 / $30 per M) until Feb 28, 2027, then 6x ($12 / $60)"
 * and `tradeoffs` the other costs the provider's docs state. undefined: the model has no faster tier.
 */
export function speedOptions(model: string, now: number = Date.now()): FastSpeedOption[] | undefined {
  const s = fastSupport(model, now)
  if (!s) return undefined
  const p = standardPrice(s)
  const at = (f: number): string => (p ? `${usd(p.input * f)} / ${usd(p.output * f)}` : '')
  const priced = (f: number): string => `${x(f)} price${p ? ` (${at(f)} per M)` : ''}`
  const out: FastSpeedOption[] = [{ tier: 'standard', title: 'Standard', speed: 'normal speed', factor: 1, line: `Standard · normal speed · ${priced(1)}`, tradeoffs: [] }]
  if (s.provider === 'anthropic') {
    const tradeoffs = ['Its own rate limit: over it, SahilBot resends at standard speed and price (a prompt-cache miss)', 'Not with the Batch API', ...(s.note ? [s.note] : [])]
    out.push({ tier: 'fast', title: 'Fast', speed: 'up to 2.5x faster output', factor: s.factor, line: `Fast · up to 2.5x faster output · ${priced(s.factor)}`, tradeoffs })
  } else if (s.provider === 'openai') {
    out.push({ tier: 'fast', title: 'Fast', speed: 'up to 2.5x faster', factor: s.factor, line: `Fast · up to 2.5x faster · ${priced(s.factor)}`, tradeoffs: ['Counts against the same rate limits as Standard', 'OpenAI may downgrade it to standard speed, billed at the standard price'] })
    if (s.ultrafast) {
      const f = s.ultrafast
      const u = s.ultrafastSchedule
      const speed = ULTRAFAST_SPEED[s.id] ? `up to ${ULTRAFAST_SPEED[s.id]}x faster` : 'OpenAI’s fastest tier'
      // The dated price: today's multiplier, the day it ends and what it becomes (only while the switch is ahead).
      const ahead = u && f < u.then ? u : undefined
      out.push({
        tier: 'ultrafast', title: 'Ultrafast', speed, factor: f, ...(ahead ? { until: ahead.lastDay, then: ahead.then } : {}),
        line: `Ultrafast · ${speed} · ${priced(f)}${ahead ? ` until ${pacificDay(ahead.lastDay)}, then ${x(ahead.then)}${p ? ` (${at(ahead.then)})` : ''}` : ''}`,
        tradeoffs: ['Separate rate limits from Standard and Fast', 'Responses API only', ...(ULTRAFAST_US_ONLY.has(s.id) ? ['US data residency only'] : [])]
      })
    }
  } else {
    out.push({ tier: 'fast', title: 'Priority', speed: 'served ahead of standard traffic when capacity is free', factor: s.factor, line: `Priority · ahead of standard traffic when capacity is free · ${priced(s.factor)}`, tradeoffs: ['Billed at the priority price only when xAI confirms it ran'] })
  }
  return out
}

/** One line for the Models page: what fast mode buys and costs on this model (its Fast and Ultrafast penalty lines). */
export function fastTradeoff(model: string, now: number = Date.now()): string | undefined {
  const o = speedOptions(model, now)
  return o ? o.filter((v) => v.tier !== 'standard').map((v) => [v.line, ...v.tradeoffs].join(' · ')).join(' — ') : undefined
}
