import { execFileSync } from 'node:child_process'
import { totalmem } from 'node:os'
import type { ModelInfo, ProviderId } from '@shared/types'
import { estimateMemory, gpuBudgetGB, lookup, paramsFromName, prettyName, tierOf } from './catalog'
import { anthropicModelCatalog } from './anthropic'
import { isLocal, listModels } from './client'

interface OllamaFacts {
  sizeBytes?: number
  kvBytesPerToken?: number
  vision?: boolean
  tools?: boolean
}

export const root = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

/** The GPU memory limit set with `sysctl iogpu.wired_limit_mb` (0 = macOS default). Re-read when asked. */
let wiredMB: number | null = null
export function wiredLimitMB(refresh = false): number {
  if (wiredMB === null || refresh) {
    try { wiredMB = Number(execFileSync('sysctl', ['-n', 'iogpu.wired_limit_mb'], { encoding: 'utf8', timeout: 2000 }).trim()) || 0 } catch { wiredMB = 0 }
  }
  return wiredMB
}

/** RAM the GPU may use on this Mac (FOREMAN_RAM_GB simulates another machine). */
export function machine(): { totalGB: number; budgetGB: number; raisedLimit: boolean } {
  const totalGB = Number(process.env.FOREMAN_RAM_GB) || totalmem() / 1024 ** 3
  const wired = process.env.FOREMAN_RAM_GB ? 0 : wiredLimitMB()
  // A raised limit counts, minus a little headroom for the app itself.
  const budget = wired > 0 ? wired / 1024 - 1 : gpuBudgetGB(totalGB)
  return { totalGB: Math.round(totalGB), budgetGB: Math.round(budget * 10) / 10, raisedLimit: wired > 0 }
}

/** Ollama exposes real file sizes and architecture; other servers fall back to the catalog. */
async function ollamaFacts(baseUrl: string, ids: string[]): Promise<Map<string, OllamaFacts>> {
  const out = new Map<string, OllamaFacts>()
  try {
    const tags = (await (await fetch(`${root(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(2500) })).json()) as {
      models?: Array<{ name: string; model?: string; size: number }>
    }
    for (const m of tags.models ?? []) out.set(m.name, { sizeBytes: m.size })
  } catch {
    return out
  }
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${root(baseUrl)}/api/show`, {
        method: 'POST',
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(2500)
      })
      const show = (await res.json()) as { model_info?: Record<string, unknown>; capabilities?: string[] }
      const info = show.model_info ?? {}
      const arch = info['general.architecture'] as string | undefined
      const num = (k: string): number | undefined => (arch ? (info[`${arch}.${k}`] as number | undefined) : undefined)
      const layers = num('block_count')
      const kvHeads = num('attention.head_count_kv')
      const heads = num('attention.head_count')
      const embed = num('embedding_length')
      const keyLen = num('attention.key_length') ?? (heads && embed ? embed / heads : undefined)
      const valLen = num('attention.value_length') ?? keyLen
      const f = out.get(id) ?? {}
      if (layers && kvHeads && keyLen && valLen) f.kvBytesPerToken = layers * kvHeads * (keyLen + valLen) * 2
      if (show.capabilities) {
        f.vision = show.capabilities.includes('vision')
        f.tools = show.capabilities.includes('tools')
      }
      out.set(id, f)
    } catch {
      /* not Ollama, or model not pulled */
    }
  }))
  return out
}

/** One provider's models, with RAM fit for local ones. */
export async function providerModels(provider: ProviderId, providerName: string, baseUrl: string, apiKey: string | undefined, window: number): Promise<{ ok: boolean; error?: string; models: ModelInfo[] }> {
  const { budgetGB } = machine()
  let ids: string[]
  try {
    if (provider === 'anthropic' && apiKey) {
      const catalog = await anthropicModelCatalog(apiKey)
      return { ok: true, models: catalog.map((m) => ({
        id: m.id, label: m.display_name, provider, providerName, enabled: true, installed: true, fits: true,
        tier: tierOf(m.id), vision: m.capabilities?.image_input?.supported ?? true, tools: true, requiredGB: 0,
        maxFittingWindow: m.max_input_tokens ?? 131072, contextTokens: m.max_input_tokens ?? undefined,
        maxOutputTokens: m.max_tokens ?? undefined, note: 'remote'
      })) }
    }
    ids = await listModels(baseUrl, apiKey, AbortSignal.timeout(5000))
  } catch (e) {
    return { ok: false, error: (e as Error).message, models: [] }
  }
  // Embedding and speech models can't chat.
  ids = ids.filter((id) => !/embed|whisper|tts|rerank|moderation|dall-e|image|audio|realtime|transcribe|search-preview/i.test(id))
  const local = isLocal(baseUrl)
  const facts = local ? await ollamaFacts(baseUrl, ids) : new Map<string, OllamaFacts>()
  const models = ids.map((id): ModelInfo => {
    const cat = lookup(id)
    const f = facts.get(id) ?? {}
    const vision = f.vision ?? cat?.vision ?? false
    const base = { id, provider, providerName, enabled: true, installed: true, label: prettyName(id) ?? (cat?.label || undefined), vision, tools: f.tools ?? cat?.tools }
    const paramsB = cat?.paramsB ?? paramsFromName(id) ?? (f.sizeBytes ? f.sizeBytes / 0.61e9 : undefined)
    if (!local) return { ...base, tier: tierOf(id, paramsB), requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote' }
    const est = estimateMemory({ weightsBytes: f.sizeBytes, paramsB, kvBytesPerToken: f.kvBytesPerToken ?? cat?.kvBytesPerToken, window, budgetGB })
    let note: string | undefined
    if (!est.fits) note = est.maxFittingWindow ? `Fits at ${est.maxFittingWindow / 1024}k context` : `Needs ~${est.requiredGB} GB; this Mac allows ${budgetGB} GB`
    return { ...base, tier: tierOf(id, paramsB), sizeBytes: f.sizeBytes, ...est, note }
  })
  return { ok: true, models }
}

/**
 * How many helper agents this Mac can run with a model (Team of Experts). Cloud models run several at
 * once; a local model needs memory for one more conversation (its context) per agent running in
 * parallel, on top of the model itself. Not enough room: fewer agents, one at a time.
 */
export function teamCapacity(m: ModelInfo | undefined): { parallel: number; maxAgents: number; heavy: boolean; why: string } {
  if (!m || m.note === 'remote' || m.note === 'added by you') return { parallel: 6, maxAgents: 30, heavy: true, why: 'cloud model' }
  const { budgetGB } = machine()
  const weights = m.sizeBytes ? m.sizeBytes / 1024 ** 3 : m.requiredGB * 0.7
  // Context memory per agent at a 32k window, from the model's estimate.
  const perAgent = Math.max(0.5, (m.requiredGB - weights - 1.5) * (32768 / Math.max(16384, m.maxFittingWindow || 32768)))
  const room = budgetGB - weights - 1.5
  const parallel = Math.max(1, Math.min(6, Math.floor(room / perAgent)))
  const heavy = parallel >= 3
  return {
    parallel,
    maxAgents: heavy ? 30 : parallel >= 2 ? 8 : 3,
    heavy,
    why: heavy ? `room for ${parallel} at once` : `this Mac has room for ${parallel} at a time with ${m.label || m.id}`
  }
}
