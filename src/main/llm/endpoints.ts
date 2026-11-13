import type { ModelInfo, ModelList, ProviderId } from '@shared/types'
import type { SettingsStore } from '../settings'
import { cost, priceFor } from './budget'
import { RECOMMENDED, estimateMemory, prettyName, rankOf, tierOf } from './catalog'
import { claudeFamily, claudeSpec, isPremiumClaude } from './claude-models'
import { routingPrefs } from './router'
import { machine, providerModels } from './models'
import { DEFS, baseUrlOf, def, isAnthropic } from './providers'

export interface Endpoint {
  provider: ProviderId
  baseUrl: string
  apiKey?: string
}

/**
 * Where each model lives. Cloud providers claim models by name ("claude-…" → Anthropic when a key is
 * saved); local models go to whichever server listed them last. FOREMAN_BASE_URL sends everything to
 * one server (tests, power users).
 */
/** A typical agent step on a cloud model (30K in, 32K out): Auto skips models the budget couldn't pay for. */
export const TYPICAL_STEP = { input: 30_000, output: 32_000 }

/**
 * Claude models listed by the API that start switched off: every older model of a family once a newer
 * one is listed (claude-sonnet-4-6 when claude-sonnet-5-5 is there). The picker stays short; the Models
 * page lists them all and any can be switched on.
 */
export function olderClaude(ids: string[]): Set<string> {
  const newest = new Map<string, { id: string; rank: number }>()
  for (const id of ids) {
    const fam = claudeFamily(id)
    if (!fam) continue
    const r = rankOf(id)
    const cur = newest.get(fam)
    // Same rank (an alias and its dated snapshot): the alias wins.
    if (!cur || r > cur.rank || (r === cur.rank && id.length < cur.id.length)) newest.set(fam, { id, rank: r })
  }
  return new Set(ids.filter((id) => { const fam = claudeFamily(id); return !!fam && newest.get(fam)?.id !== id }))
}

export class Endpoints {
  private index = new Map<string, ProviderId>()
  last: ModelList | null = null
  /** Dollars left under this month's cloud cap (set by the app; undefined = no cap known). */
  budgetLeft?: () => number

  constructor(private settings: SettingsStore) {}

  private override(): string | undefined {
    return process.env.FOREMAN_BASE_URL || undefined
  }

  for(model: string): Endpoint {
    const s = this.settings.get()
    const o = this.override()
    if (o) return { provider: isAnthropic(o) ? 'anthropic' : 'custom', baseUrl: o, apiKey: this.settings.keyFor(o) }
    const at = (provider: ProviderId): Endpoint => {
      const baseUrl = baseUrlOf(provider, s.providers)
      return { provider, baseUrl, apiKey: this.settings.keyFor(baseUrl) }
    }
    for (const d of DEFS) if (d.claims?.test(model) && s.keys[d.id] && s.cloud.enabled) return at(d.id)
    const known = this.index.get(model)
    if (known) return at(known)
    if (s.providers.ollama.enabled) return at('ollama')
    return { provider: 'custom', baseUrl: s.baseUrl, apiKey: this.settings.apiKey() }
  }

  /** Every model from every server that's on, plus SahilBot's recommended downloads. */
  async list(): Promise<ModelList> {
    const s = this.settings.get()
    const { totalGB, budgetGB } = machine()
    // Auto: estimate at 32k for the list; each run then takes the largest window that fits.
    const window = s.contextWindow || 32768
    const o = this.override()
    const targets: Array<{ id: ProviderId; name: string; baseUrl: string }> = o
      ? [{ id: isAnthropic(o) ? 'anthropic' : 'custom', name: isAnthropic(o) ? 'Anthropic' : 'Model server', baseUrl: o }]
      : DEFS.filter((d) => (d.local ? (d.id === 'custom' ? s.providers.custom.enabled : s.providers[d.id as 'ollama' | 'lmstudio'].enabled) : s.keys[d.id] && s.cloud.enabled) && d.id !== 'openrouter')
        .map((d) => ({ id: d.id, name: d.id === 'custom' ? s.providers.custom.name || d.name : d.name, baseUrl: baseUrlOf(d.id, s.providers) }))

    const results = await Promise.all(targets.map(async (t) => ({ t, r: await providerModels(t.id, t.name, t.baseUrl, this.settings.keyFor(t.baseUrl), window) })))
    const models: ModelInfo[] = []
    const seen = new Set<string>()
    for (const { r } of results) for (const m of r.models) if (!seen.has(m.id)) { seen.add(m.id); models.push(m) }

    // Models added by name (an OpenRouter or newer Claude model the list doesn't show).
    for (const id of s.customModels) {
      if (seen.has(id) || (!s.cloud.enabled && DEFS.some((d) => !d.local && d.claims?.test(id)))) continue
      const e = this.for(id)
      seen.add(id)
      models.push({ id, provider: e.provider, providerName: def(e.provider).name, enabled: true, installed: true, label: prettyName(id), vision: false, tier: tierOf(id), requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'added by you' })
    }

    // Recommended models not downloaded yet (only when Ollama is running and nothing overrides it).
    const ollamaUp = results.some(({ t, r }) => t.id === 'ollama' && r.ok)
    if (ollamaUp) {
      for (const rec of RECOMMENDED) {
        if (models.some((m) => m.id === rec.pull || m.id === `${rec.pull}:latest`)) continue
        const est = estimateMemory({ weightsBytes: rec.sizeGB * 1024 ** 3, paramsB: rec.paramsB, window, budgetGB })
        models.push({
          id: rec.pull, provider: 'ollama', providerName: 'Ollama', enabled: false, installed: false, label: rec.label, vision: rec.vision,
          tier: rec.tier, blurb: rec.blurb, pull: rec.pull, sizeBytes: rec.sizeGB * 1024 ** 3, ...est,
          note: est.fits ? `${rec.sizeGB} GB download` : `Too big for this Mac (needs ~${est.requiredGB} GB)`
        })
      }
    }

    // Cloud models: real context window, output cap and the price the budget charges.
    for (const m of models) {
      if (m.note !== 'remote' && m.provider !== 'anthropic') continue
      const spec = claudeSpec(m.id)
      if (spec?.contextTokens) m.contextTokens = spec.contextTokens
      if (spec?.maxOutput) m.maxOutputTokens = spec.maxOutput
      const p = priceFor(m.id)
      if (p.known) m.price = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) }
      if (claudeFamily(m.id)) { m.vision = true; m.tools ??= true }
    }
    this.older = new Set([...olderClaude(models.filter((m) => m.provider === 'anthropic').map((m) => m.id))].filter((id) => !s.customModels.includes(id)))

    // On by default only if it fits this Mac comfortably (or you switched it on yourself).
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    for (const m of models) {
      if (m.installed) m.enabled = this.isOn(m, hidden, shown)
      const rec = RECOMMENDED.find((r) => r.pull === m.id || `${r.pull}:latest` === m.id)
      if (rec) { m.label ??= rec.label; m.blurb ??= rec.blurb; m.tier = rec.tier }
      m.rank = rankOf(m.id)
    }
    this.index = new Map(models.filter((m) => m.installed).map((m) => [m.id, m.provider]))
    const providers = results.map(({ t, r }) => ({ id: t.id, name: t.name, ok: r.ok, error: r.error, count: r.models.length }))
    const ok = results.some(({ r }) => r.ok)
    this.last = { ok, error: ok ? undefined : results.map(({ t, r }) => `${t.name}: ${r.error}`).join(' · ') || 'No model server is set up.', models, budgetGB, totalGB, providers }
    return this.last
  }

  /**
   * First-run picks: the three best recommended models that fit this Mac: the strongest one, a fast
   * one for chat and voice, and the next strongest. Ones that don't fit aren't offered.
   */
  setupPicks(): Array<{ pull: string; label: string; blurb: string; sizeGB: number; tier: number; installed: boolean; role: string }> {
    const { budgetGB } = machine()
    const fit = RECOMMENDED.filter((r) => estimateMemory({ weightsBytes: r.sizeGB * 1024 ** 3, paramsB: r.paramsB, window: 32768, budgetGB }).fits)
      .sort((a, b) => b.tier - a.tier || b.rank - a.rank)
    const picks: Array<{ r: typeof RECOMMENDED[number]; role: string }> = []
    const add = (r: typeof RECOMMENDED[number] | undefined, role: string): void => { if (r && !picks.some((p) => p.r === r)) picks.push({ r, role }) }
    add(fit[0], 'Best for agent work on this Mac')
    // The fast one: the smallest light model that isn't already the best pick.
    add(fit.filter((r) => r.tier <= 1 && r !== fit[0]).sort((a, b) => a.tier - b.tier || a.sizeGB - b.sizeGB)[0], 'Fast: quick chats and voice')
    for (const r of fit) { if (picks.length >= 3) break; add(r, 'Also great') }
    const installed = new Set((this.last?.models ?? []).filter((m) => m.installed).map((m) => m.id.replace(/:latest$/, '')))
    return picks.map(({ r, role }) => ({ pull: r.pull, label: r.label, blurb: r.blurb, sizeGB: r.sizeGB, tier: r.tier, installed: installed.has(r.pull), role }))
  }

  /** Older Claude models (off unless switched on), from the last listing. */
  private older = new Set<string>()

  private isOn(m: ModelInfo, hidden: Set<string>, shown: Set<string>): boolean {
    return shown.has(m.id) || (!hidden.has(m.id) && !this.older.has(m.id) && (m.fits || m.maxFittingWindow >= 32768))
  }

  /** The budget could pay for a typical step on this cloud model (local models are always affordable). */
  affordable(m: ModelInfo): boolean {
    if (m.note !== 'remote' || !this.budgetLeft) return true
    return this.budgetLeft() >= cost(m.id, TYPICAL_STEP.input, TYPICAL_STEP.output)
  }

  /**
   * The cloud model a local model consults in hybrid mode. Setting: '' or 'opus' = the best Opus,
   * 'sonnet' = the best Sonnet (any family name works), or an exact model id. Falls back to the best
   * non-premium cloud model on, then any.
   */
  advisor(): string | undefined {
    const s = this.settings.get()
    if (!s.cloud.enabled || !s.cloud.hybrid) return undefined
    const pref = s.cloud.advisorModel.trim()
    if (pref && !/^(opus|sonnet|haiku|fable|mythos)$/i.test(pref)) return pref
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    const cloud = (this.last?.models ?? []).filter((m) => m.note === 'remote' && m.installed && this.isOn(m, hidden, shown))
    const best = (ms: ModelInfo[]): string | undefined => [...ms].sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id
    const family = (pref || 'opus').toLowerCase()
    return best(cloud.filter((m) => claudeFamily(m.id) === family)) ?? best(cloud.filter((m) => !isPremiumClaude(m.id))) ?? best(cloud)
  }

  /** Models Auto may use: on, downloaded, fitting this Mac, and (cloud ones) allowed and affordable. */
  usable(): ModelInfo[] {
    // On/off choices are read now, not from the last listing, so a change applies to the next message.
    const s = this.settings.get()
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    routingPrefs.preferCloud = s.cloud.enabled && s.cloud.prefer === 'cloud'
    return (this.last?.models ?? []).filter((m) => m.installed && this.isOn(m, hidden, shown) &&
      // Cloud switched off (since the last listing): nothing goes to a cloud model.
      (m.note !== 'remote' || (s.cloud.enabled && this.affordable(m))))
  }
}
