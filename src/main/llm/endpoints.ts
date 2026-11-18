import type { ModelInfo, ModelList, ProviderId, Settings } from '@shared/types'
import type { SettingsStore } from '../settings'
import { cost, priceFor } from './budget'
import { RECOMMENDED, estimateMemory, isMlx, prettyName, rankOf, recommendedFor, sameModel, tierOf } from './catalog'
import { claudeFamily, claudeInfo, claudeOptions, isPremiumClaude } from './claude-models'
import { isAuto, routingPrefs } from './router'
import { machine, providerModels, root } from './models'
import { DEFS, baseUrlOf, def, providerForUrl } from './providers'
import { olderOpenAI, openaiInfo } from './openai-models'
// xAI (Grok) model facts, and the monthly spending limit's mode (None keeps Auto off pay-per-use models).
import { olderXai, xaiInfo, xaiRank } from './xai-models'
import { spendingMode } from './budget'
import { payPerUse, spendingPrefs } from './routing-table'
// ChatGPT plan (via Codex): its models are listed while it's connected (llm/codex/plan.ts).
import { chatgptPlan } from './codex/plan'
import { CODEX_URL, PLAN_PROVIDER, isPlanModel } from './codex/ids'
// Local models are opt-in (shared/local-mode.ts): while they're off no local server is asked for models,
// no downloads are offered and Auto never routes to one.
import { localOn } from '@shared/local-mode'

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

/**
 * A model added by name on the Models page (an OpenRouter or newer Claude model the list doesn't show).
 * It can be picked only when a cloud provider claims the name and its key is saved: a local name no
 * running server lists isn't downloaded, so it isn't offered.
 */
export function addedModelStatus(id: string, s: Pick<Settings, 'keys' | 'cloud'>): { provider?: ProviderId; reason?: string } {
  const cloud = DEFS.find((d) => !d.local && d.claims?.test(id))
  if (!cloud) return { reason: 'No running model server has it' }
  if (!s.cloud.enabled) return { reason: 'Cloud models are off' }
  if (!s.keys[cloud.id]) return { reason: `Needs an ${cloud.name} API key` }
  return { provider: cloud.id }
}

/**
 * Whether a model can be picked right now: downloaded (listed by Ollama, LM Studio or the custom
 * server), or a cloud model whose provider has a key saved (and cloud models are on). Recommended models
 * that aren't downloaded yet, and models added by name that nothing serves, are false: they live on
 * Settings → Models, not in the picker.
 */
export function pickable(m: ModelInfo, s: Pick<Settings, 'keys' | 'cloud'>): boolean {
  if (!m.installed) return false
  if (def(m.provider).local) return true
  // ChatGPT plan models are listed only while the plan is connected; no API key involved.
  if (m.provider === PLAN_PROVIDER) return !!s.cloud?.enabled
  // No key info (a partial settings object): trust the listing, which only has keyed providers.
  return s.cloud.enabled && (s.keys ? !!s.keys[m.provider] : true)
}

/**
 * Why a chosen model (a chat's, a bot's or the default) can't be used any more, judged from a listing:
 * its cloud key was removed, cloud models were switched off, or a server that answered no longer has it
 * (deleted). undefined: it's fine, or there's no telling (its server isn't running, which is temporary).
 */
export function missingReason(id: string, list: ModelList | null, s: Pick<Settings, 'keys' | 'cloud'>): string | undefined {
  if (isAuto(id) || !list) return undefined
  const m = list.models.find((x) => x.id === id)
  // ChatGPT plan: off in Settings, or connected without this model. While it's being checked or signing in, no telling.
  if (isPlanModel(id)) {
    if (m?.installed) return s.cloud?.enabled ? undefined : 'cloud models are switched off'
    const plan = list.providers?.find((x) => x.id === PLAN_PROVIDER)
    if (!plan) return 'the ChatGPT plan isn\'t connected'
    return plan.ok ? 'your ChatGPT plan doesn\'t offer it' : undefined
  }
  const up = (p: ProviderId): boolean => !!list.providers?.find((x) => x.id === p)?.ok
  if (m?.installed) return pickable(m, s) ? undefined : !s.cloud.enabled ? 'cloud models are switched off' : `there's no ${def(m.provider).name} API key any more`
  // Added by name and nothing can run it (key removed, cloud off, or no server has it).
  if (m && !m.pull) return m.note && m.note !== 'added by you' ? `${m.note[0].toLowerCase()}${m.note.slice(1)}`.replace(/^needs/, 'it needs') : 'it isn\'t available'
  // A recommended model that isn't downloaded: only certain while Ollama answers.
  if (m) return up('ollama') ? 'it isn\'t downloaded' : undefined
  const cloud = DEFS.find((d) => !d.local && d.id !== 'openrouter' && d.claims?.test(id))
  if (cloud) {
    if (!s.cloud.enabled) return 'cloud models are switched off'
    if (!s.keys?.[cloud.id]) return `there's no ${cloud.name} API key any more`
    return up(cloud.id) ? `${cloud.name} doesn't offer it any more` : undefined
  }
  // Ollama names have a tag (name:tag); otherwise every local server that's on must have answered.
  if (id.includes(':')) return up('ollama') ? 'it was deleted from Ollama' : undefined
  const locals = (list.providers ?? []).filter((p) => def(p.id).local)
  return locals.length && locals.every((p) => p.ok) ? 'no model server has it any more' : undefined
}

export class Endpoints {
  private index = new Map<string, ProviderId>()
  last: ModelList | null = null
  /** Dollars left under this month's cloud cap (set by the app; undefined = no cap known). */
  budgetLeft?: () => number | undefined

  constructor(private settings: SettingsStore) {}

  private override(): string | undefined {
    return process.env.FOREMAN_BASE_URL || undefined
  }

  for(model: string): Endpoint {
    const s = this.settings.get()
    const o = this.override()
    // A cloud API named by URL is that provider (https://api.openai.com/v1 is OpenAI, not a custom server).
    if (o) return { provider: providerForUrl(o), baseUrl: o, apiKey: this.settings.keyFor(o) }
    // ChatGPT plan models run through Codex, never through an API key.
    if (isPlanModel(model)) return { provider: PLAN_PROVIDER, baseUrl: CODEX_URL }
    const at = (provider: ProviderId): Endpoint => {
      const baseUrl = baseUrlOf(provider, s.providers)
      return { provider, baseUrl, apiKey: this.settings.keyFor(baseUrl) }
    }
    // A model a local server listed stays there (LM Studio's "qwen/qwen3.6-35b-a3b" isn't OpenRouter's).
    const known = this.index.get(model)
    if (known && def(known).local) return at(known)
    for (const d of DEFS) if (d.claims?.test(model) && s.keys[d.id] && s.cloud.enabled) return at(d.id)
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
      ? [{ id: providerForUrl(o), name: providerForUrl(o) === 'custom' ? 'Model server' : def(providerForUrl(o)).name, baseUrl: o }]
      : DEFS.filter((d) => (d.local ? localOn(s) && (d.id === 'custom' ? s.providers.custom.enabled : s.providers[d.id as 'ollama' | 'lmstudio'].enabled) : s.keys[d.id] && s.cloud.enabled) && d.id !== 'openrouter')
        .map((d) => ({ id: d.id, name: d.id === 'custom' ? s.providers.custom.name || d.name : d.name, baseUrl: baseUrlOf(d.id, s.providers) }))

    const results = await Promise.all(targets.map(async (t) => ({ t, r: await providerModels(t.id, t.name, t.baseUrl, this.settings.keyFor(t.baseUrl), window) })))
    const models: ModelInfo[] = []
    const seen = new Set<string>()
    for (const { r } of results) for (const m of r.models) if (!seen.has(m.id)) { seen.add(m.id); models.push(m) }
    // ChatGPT plan (via Codex), when switched on: its models while connected and cloud models are allowed.
    const plan = !o && chatgptPlan.prefs().enabled ? await chatgptPlan.refreshIfStale().catch(() => chatgptPlan.status()) : undefined
    if (plan && s.cloud.enabled) for (const m of chatgptPlan.models()) if (!seen.has(m.id)) { seen.add(m.id); models.push(m) }

    // Models added by name (an OpenRouter or newer Claude model the list doesn't show).
    // Only ones a keyed cloud provider claims can be picked; the rest are listed (not installed) with why.
    for (const id of s.customModels) {
      if (seen.has(id)) continue
      seen.add(id)
      const st = this.override() ? { provider: this.for(id).provider } : addedModelStatus(id, s)
      const provider = st.provider ?? 'custom'
      models.push({ id, provider, providerName: st.provider ? def(provider).name : 'Added by you', enabled: true, installed: !!st.provider, label: prettyName(id), vision: false, tier: tierOf(id), requiredGB: 0, maxFittingWindow: 131072, fits: true, note: st.reason ?? 'added by you' })
    }

    // Recommended models not downloaded yet, for Settings → Models (never pickable). Listed whenever Ollama
    // is on, running or not (downloading starts it), unless something overrides the servers.
    if (!o && localOn(s) && s.providers.ollama.enabled) {
      for (const rec of RECOMMENDED) {
        if (models.some((m) => m.provider === 'ollama' && m.installed && sameModel(m.id, rec.pull))) continue
        if (seen.has(rec.pull)) continue
        const est = estimateMemory({ weightsBytes: rec.sizeGB * 1024 ** 3, paramsB: rec.paramsB, window, budgetGB })
        models.push({
          id: rec.pull, provider: 'ollama', providerName: 'Ollama', enabled: false, installed: false, label: rec.label, vision: rec.vision, tools: rec.tools,
          tier: rec.tier, blurb: rec.blurb, pull: rec.pull, sizeBytes: rec.sizeGB * 1024 ** 3, ...est,
          note: est.fits ? `${rec.sizeGB} GB download` : `Too big for this Mac (needs ~${est.requiredGB} GB)`
        })
      }
    }

    // LM Studio says which of its models are MLX builds (faster on Apple Silicon than GGUF).
    const mlx = new Set<string>()
    await Promise.all(results.filter(({ t, r }) => t.id === 'lmstudio' && r.ok).map(async ({ t }) => {
      try {
        const j = (await (await fetch(`${root(t.baseUrl)}/api/v0/models`, { signal: AbortSignal.timeout(1500) })).json()) as { data?: Array<{ id?: string; compatibility_type?: string }> }
        for (const x of j.data ?? []) if (x.id && /mlx/i.test(x.compatibility_type ?? '')) mlx.add(x.id)
      } catch { /* older LM Studio: names still tell (…-mlx, mlx-community/…) */ }
    }))

    // OpenAI lists image, audio, video and realtime models too: only chat models belong in the picker.
    for (let i = models.length - 1; i >= 0; i--) if (models[i].provider === 'openai' && /sora|gpt-live|computer-use|moderation|babbage|davinci|-instruct\b/i.test(models[i].id)) models.splice(i, 1)

    // xAI lists image, video and voice models too: only the chat models SahilBot knows (xai-models.ts) stay.
    for (let i = models.length - 1; i >= 0; i--) if (models[i].provider === 'xai' && models[i].note === 'remote' && !xaiInfo(models[i].id)) models.splice(i, 1)

    // Cloud models: real context window, output cap and the price the budget charges.
    for (const m of models) {
      if (m.note !== 'remote' && m.provider !== 'anthropic') continue
      // xAI (xai-models.ts): window, output cap, tier, label, vision and price; a newer grok id is estimated.
      const grok = m.provider === 'xai' || /^grok-/i.test(m.id) ? xaiInfo(m.id) : undefined
      if (grok) {
        m.contextTokens = grok.contextTokens
        m.maxOutputTokens = grok.maxOutput
        m.tier = grok.tier
        m.label = grok.label
        m.vision = grok.vision
        m.tools ??= grok.tools
        const p = priceFor(m.id)
        m.price = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) }
        if (!p.known) m.priceEstimated = true
        continue
      }
      // OpenAI (openai-models.ts): window, output cap, tier, label and price; a GPT id newer than the table is estimated.
      const gpt = !claudeFamily(m.id) ? openaiInfo(m.id) : undefined
      if (gpt) {
        if (gpt.contextTokens) m.contextTokens = gpt.contextTokens
        if (gpt.maxOutput) m.maxOutputTokens = gpt.maxOutput
        m.tier = gpt.tier
        m.vision = true
        m.tools ??= true
        const p = priceFor(m.id)
        m.price = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) }
        if (!p.known) m.priceEstimated = true
        continue
      }
      // A Claude id newer than SahilBot's table gets its family's facts; its price is then an estimate.
      const spec = claudeInfo(m.id)
      if (spec?.contextTokens) m.contextTokens = spec.contextTokens
      if (spec?.maxOutput) m.maxOutputTokens = spec.maxOutput
      const p = priceFor(m.id)
      if (p.known || p.estimated) m.price = { input: p.input, output: p.output, ...(p.cacheRead !== undefined ? { cacheRead: p.cacheRead } : {}) }
      if (!p.known) m.priceEstimated = true
      if (claudeFamily(m.id)) { m.vision = true; m.tools ??= true }
    }
    // Older models start off: earlier Claude of each family, and every OpenAI model but the current lineup.
    this.older = new Set([...olderClaude(models.filter((m) => m.provider === 'anthropic').map((m) => m.id)), ...olderOpenAI(models.filter((m) => m.provider === 'openai').map((m) => m.id)), ...olderXai(models.filter((m) => m.provider === 'xai').map((m) => m.id))].filter((id) => !s.customModels.includes(id)))

    // On by default only if it fits this Mac comfortably (or you switched it on yourself).
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    for (const m of models) {
      if (m.installed) m.enabled = this.isOn(m, hidden, shown)
      // Installed builds of a recommended model (qwen3.8:27b-mlx too) keep its name, tier and download tag.
      const rec = m.provider === 'ollama' ? recommendedFor(m.id) : undefined
      if (rec) { m.label ??= rec.label; m.blurb ??= rec.blurb; m.tier = rec.tier; m.pull ??= rec.pull; m.tools ??= rec.tools }
      m.rank = rankOf(m.id, isMlx(m.id) || mlx.has(m.id))
      if (m.provider === 'xai') m.rank = xaiRank(m.id) ?? m.rank
    }
    this.index = new Map(models.filter((m) => m.installed).map((m) => [m.id, m.provider]))
    const providers = results.map(({ t, r }) => ({ id: t.id, name: t.name, ok: r.ok, error: r.error, count: r.models.length }))
    if (plan) providers.push({ id: PLAN_PROVIDER, name: def(PLAN_PROVIDER).name, ok: plan.connected, error: plan.connected ? undefined : plan.problem, count: plan.connected ? plan.models.length : 0 })
    const ok = results.some(({ r }) => r.ok)
    const off = !o && !localOn(s)
    // Cloud only (local off): a ChatGPT plan that's connected counts as answering.
    const okAll = ok || (off && !!plan?.connected)
    this.last = { ok: okAll, error: okAll ? undefined : results.map(({ t, r }) => `${t.name}: ${r.error}`).join(' · ') || (off ? 'No cloud model is connected yet. Add a Claude, OpenAI or Grok key, or your ChatGPT plan, in Settings → Models.' : 'No model server is set up.'), models, budgetGB, totalGB, providers, ...(off ? { localOff: true } : {}) }
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
    const installed = (this.last?.models ?? []).filter((m) => m.installed && m.provider === 'ollama').map((m) => m.id)
    return picks.map(({ r, role }) => ({ pull: r.pull, label: r.label, blurb: r.blurb, sizeGB: r.sizeGB, tier: r.tier, installed: installed.some((id) => sameModel(id, r.pull)), role }))
  }

  /** Older Claude models (off unless switched on), from the last listing. */
  private older = new Set<string>()

  private isOn(m: ModelInfo, hidden: Set<string>, shown: Set<string>): boolean {
    return shown.has(m.id) || (!hidden.has(m.id) && !this.older.has(m.id) && (m.fits || m.maxFittingWindow >= 32768))
  }

  /** The budget could pay for a typical step on this cloud model (local models are always affordable). */
  affordable(m: ModelInfo): boolean {
    if (m.note !== 'remote' || !this.budgetLeft || m.provider === PLAN_PROVIDER) return true
    // undefined: no cap this month (Unlimited, or None, where routing keeps Auto off pay-per-use models).
    const left = this.budgetLeft()
    return left === undefined || left >= cost(m.id, TYPICAL_STEP.input, TYPICAL_STEP.output)
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
    if (pref && !/^(opus|sonnet|haiku|fable|mythos|astra|sol|terra|luna)$/i.test(pref)) return pref
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    const cloud = (this.last?.models ?? []).filter((m) => m.note === 'remote' && m.installed && this.isOn(m, hidden, shown))
    const best = (ms: ModelInfo[]): string | undefined => [...ms].sort((a, b) => b.tier - a.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]?.id
    const family = (pref || 'opus').toLowerCase()
    // An OpenAI role by name (astra, sol…); with no Claude key, '' / 'opus' means GPT Sol's tier (GPT-6.2 Sol: near Astra at a quarter of the price).
    const gpt = (m: ModelInfo): boolean => !!openaiInfo(m.id) && !claudeFamily(m.id) && !openaiInfo(m.id)!.premium
    return best(cloud.filter((m) => claudeFamily(m.id) === family)) ?? best(cloud.filter((m) => gpt(m) && openaiInfo(m.id)!.role === family))
      ?? (family === 'opus' ? best(cloud.filter((m) => gpt(m) && openaiInfo(m.id)!.role === 'sol')) : undefined)
      ?? best(cloud.filter((m) => !isPremiumClaude(m.id) && !openaiInfo(m.id)?.premium)) ?? best(cloud)
  }

  /** Models Auto may use: on, downloaded, fitting this Mac, and (cloud ones) allowed and affordable. */
  usable(): ModelInfo[] {
    // On/off choices are read now, not from the last listing, so a change applies to the next message.
    const s = this.settings.get()
    const hidden = new Set(s.hiddenModels)
    const shown = new Set(s.shownModels)
    // Cloud first when chosen, or by default once a Claude key is saved (Settings → Models can say Local first).
    const o = claudeOptions(s)
    // A saved OpenAI or xAI key, or a connected ChatGPT plan, makes Auto cloud-first too, unless Settings say Local
    // first (same rule as Claude's key). With local models off there's nothing local to prefer: cloud first.
    routingPrefs.localOn = localOn(s)
    routingPrefs.preferCloud = s.cloud.enabled && (o.preferCloud || (s.cloud.prefer === undefined && (!!s.keys?.openai || !!s.keys?.xai || chatgptPlan.available())) || !localOn(s))
    routingPrefs.fableForHardest = s.cloud.enabled && o.fableForHardest
    // Monthly spending limit: None keeps Auto on the ChatGPT plan and local models (routing-table.ts).
    spendingPrefs.mode = spendingMode(s)
    const local = localOn(s)
    return (this.last?.models ?? []).filter((m) => m.installed && this.isOn(m, hidden, shown) &&
      // Local models off: never a local one (FOREMAN_BASE_URL's single server is never second-guessed).
      (local || !!this.override() || !def(m.provider).local) &&
      // Cloud switched off or its key removed (since the last listing): nothing goes to that cloud model.
      (this.override() ? m.note !== 'remote' || s.cloud.enabled : pickable(m, s)) && (m.note !== 'remote' || this.affordable(m)) &&
      // ChatGPT plan: its models only while it can take requests (not over its limit); "Use my ChatGPT plan first" keeps the pay-per-token OpenAI API out.
      chatgptPlan.allows(m) &&
      // Monthly limit None: no pay-per-use model (only the ChatGPT plan and local models).
      (spendingPrefs.mode !== 'none' || !payPerUse(m)))
  }

  /**
   * Why a chosen model can't be used any more (see missingReason), checked against a fresh listing
   * before saying so: a model downloaded since the last listing is fine. undefined = use it. Servers
   * pointed elsewhere (FOREMAN_BASE_URL) are never second-guessed.
   */
  async missing(id: string): Promise<string | undefined> {
    if (this.override() || isAuto(id)) return undefined
    if (!missingReason(id, this.last, this.settings.get())) return undefined
    await this.list().catch(() => undefined)
    return missingReason(id, this.last, this.settings.get())
  }
}
