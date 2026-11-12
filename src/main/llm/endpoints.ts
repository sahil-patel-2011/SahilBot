import type { ModelInfo, ModelList, ProviderId } from '@shared/types'
import type { SettingsStore } from '../settings'
import { RECOMMENDED, estimateMemory, prettyName, rankOf, tierOf } from './catalog'
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
export class Endpoints {
  private index = new Map<string, ProviderId>()
  last: ModelList | null = null

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

    // On by default only if it fits this Mac comfortably (or you switched it on yourself).
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    for (const m of models) {
      if (m.installed) m.enabled = shown.has(m.id) || (!hidden.has(m.id) && (m.fits || m.maxFittingWindow >= 32768))
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
    add(fit.filter((r) => r.tier <= 1).sort((a, b) => b.rank - a.rank)[0] ?? fit[fit.length - 1], 'Fast: quick chats and voice')
    for (const r of fit) { if (picks.length >= 3) break; add(r, 'Also great') }
    const installed = new Set((this.last?.models ?? []).filter((m) => m.installed).map((m) => m.id.replace(/:latest$/, '')))
    return picks.map(({ r, role }) => ({ pull: r.pull, label: r.label, blurb: r.blurb, sizeGB: r.sizeGB, tier: r.tier, installed: installed.has(r.pull), role }))
  }

  /** The best cloud model to consult (hybrid mode), if cloud is on and a key is saved. */
  advisor(): string | undefined {
    const s = this.settings.get()
    if (!s.cloud.enabled || !s.cloud.hybrid) return undefined
    if (s.cloud.advisorModel) return s.cloud.advisorModel
    const cloud = (this.last?.models ?? []).filter((m) => m.note === 'remote' && !s.hiddenModels.includes(m.id))
    return cloud.sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id
  }

  /** Models Auto may use: on, downloaded, and fitting this Mac. */
  usable(): ModelInfo[] {
    // On/off choices are read now, not from the last listing, so a change applies to the next message.
    const s = this.settings.get()
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    return (this.last?.models ?? []).filter((m) => m.installed && (shown.has(m.id) || (!hidden.has(m.id) && (m.fits || m.maxFittingWindow >= 32768))))
  }
}
