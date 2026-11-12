import type { Sampling, Tier } from '@shared/types'

// Models SahilBot knows by name. Anything else still works; it just gets
// generic sampling and a size estimate from the name or the server.
export interface CatalogEntry {
  match: RegExp
  label: string
  vision: boolean
  /** Parameter count in billions, used only when the server can't report file size. */
  paramsB?: number
  /** KV-cache bytes per token at f16, if the architecture is known. */
  kvBytesPerToken?: number
  /** Sampling from the model card. */
  sampling: Sampling
  /** Emits <think> blocks / reasoning fields. */
  thinks: boolean
  /** Capability for Auto routing: 0 instant, 1 light, 2 standard, 3 heavy. */
  tier?: Tier
  /** Reliable native tool calling. */
  tools?: boolean
  blurb?: string
}

/** The short list SahilBot recommends and can download through Ollama. Few on purpose. */
export interface Recommended {
  pull: string
  label: string
  tier: Tier
  paramsB: number
  /** Download size, GB (the larger Apple-Silicon build, to be safe). */
  sizeGB: number
  vision: boolean
  blurb: string
  /** Quality within its tier: Auto picks the best model at the level a request needs. */
  rank: number
}

// Qwen3-family card (thinking mode): temperature 0.6, top_p 0.95, top_k 20, min_p 0.
const QWEN: Sampling = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }
// Llama 3.3 generation_config.json: temperature 0.6, top_p 0.9.
const LLAMA: Sampling = { temperature: 0.6, top_p: 0.9, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }
const GENERIC_REMOTE: Sampling = { temperature: 0.7, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }
export const GENERIC: Sampling = { temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, presence_penalty: 0, repeat_penalty: 1 }

export const CATALOG: CatalogEntry[] = [
  { match: /qwen3\.8.*(flash|next)/i, label: 'Qwen3.8 Flash Next', vision: true, paramsB: 125, sampling: QWEN, thinks: true, tier: 3, tools: true },
  { match: /^flint/i, label: 'Flint 40B', vision: false, paramsB: 39.8, sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, thinks: true, tier: 2, tools: true },
  { match: /^lfm3/i, label: 'LFM3 1.7B', vision: false, paramsB: 1.7, sampling: GENERIC, thinks: true, tier: 0, tools: true },
  { match: /^qwen3\.5[-:_]?9b/i, label: 'Qwen3.5 9B', vision: true, paramsB: 9, sampling: QWEN, thinks: true, tier: 1, tools: true },
  { match: /^gemma4[-:_]?12b/i, label: 'Gemma 4 12B', vision: true, paramsB: 12, sampling: GENERIC, thinks: true, tier: 1, tools: true },
  { match: /^gemma4[-:_]?26b/i, label: 'Gemma 4 26B', vision: true, paramsB: 25.2, sampling: GENERIC, thinks: true, tier: 2, tools: true },
  { match: /^gpt-oss[-:_]?20b/i, label: 'gpt-oss 20B', vision: false, paramsB: 21, sampling: GENERIC, thinks: true, tier: 2, tools: true },
  { match: /qwen3\.8[-:_]?27b/i, label: 'Qwen3.8 27B', vision: true, paramsB: 27, sampling: QWEN, thinks: true, tier: 2, tools: true },
  // 80 layers x 8 KV heads x 128 head dim x (K+V) x 2 bytes
  // Outclassed by Qwen3.8 27B, so it isn't treated as a step up.
  { match: /llama[-_]?3\.3.*70b/i, label: 'Llama 3.3 70B', vision: false, paramsB: 70.6, kvBytesPerToken: 80 * 8 * 128 * 2 * 2, sampling: LLAMA, thinks: false, tier: 2, tools: true },
  { match: /^claude-fable/i, label: 'Claude Fable', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 3, tools: true },
  { match: /^claude-opus/i, label: 'Claude Opus', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 3, tools: true },
  { match: /^claude-sonnet/i, label: 'Claude Sonnet', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 2, tools: true },
  { match: /^claude-haiku/i, label: 'Claude Haiku', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 1, tools: true },
  { match: /^gpt-.*nano/i, label: '', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 0, tools: true },
  { match: /^gpt-.*mini/i, label: '', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 1, tools: true },
  { match: /^(gpt-|o\d)/i, label: '', vision: true, sampling: { ...GENERIC_REMOTE }, thinks: false, tier: 3, tools: true },
  { match: /qwen/i, label: '', vision: false, sampling: QWEN, thinks: true },
  { match: /llama/i, label: '', vision: false, sampling: LLAMA, thinks: false }
]

/**
 * The best model at each size, checked on ollama.com on 2026-11-12. Few on purpose: download the ones
 * that fit and Auto uses them. ("Qwen 3.8 9B" doesn't exist; Qwen 3.5 9B is the newest official 9B.)
 */
export const RECOMMENDED: Recommended[] = [
  { pull: 'lfm3:1.7b', label: 'LFM3 1.7B', tier: 0, rank: 1, paramsB: 1.7, sizeGB: 1.7, vision: false, blurb: 'Instant replies and voice. Tiny, fast, good at tool calls; not for hard questions.' },
  { pull: 'qwen3.5:9b', label: 'Qwen3.5 9B', tier: 1, rank: 1, paramsB: 9, sizeGB: 7.6, vision: true, blurb: 'Quick everyday questions and simple tasks. Sees images.' },
  { pull: 'gemma4:12b', label: 'Gemma 4 12B', tier: 1, rank: 2, paramsB: 12, sizeGB: 8, vision: true, blurb: 'Everyday questions and lighter agent work; strong tool use for its size. Sees images.' },
  { pull: 'gemma4:26b', label: 'Gemma 4 26B', tier: 2, rank: 1, paramsB: 25.2, sizeGB: 19, vision: true, blurb: 'Fast mid-size model (only 3.8B active per word). Research, files and tasks.' },
  { pull: 'qwen3.8:27b', label: 'Qwen3.8 27B', tier: 2, rank: 2, paramsB: 27, sizeGB: 18, vision: true, blurb: 'The best all-rounder that fits most Macs: agent tasks, research, code. Sees images.' },
  { pull: 'flint', label: 'Flint 40B', tier: 2, rank: 1.5, paramsB: 39.8, sizeGB: 23, vision: false, blurb: 'Fast, strong agent and coding model (40B, only 2.5B active per word). Runs as MLX on Apple Silicon; needs a 32 GB+ Mac.' },
  { pull: 'llama3.3:70b', label: 'Llama 3.3 70B', tier: 2, rank: 0, paramsB: 70.6, sizeGB: 43, vision: false, blurb: 'Large and steady for long writing; needs a 64 GB Mac. Qwen3.8 27B is usually better.' }
]

/** Claude's display names: claude-opus-5-5 -> Claude Opus 5.5. */
export function prettyName(id: string): string | undefined {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i)
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  return undefined
}

/** Capability tier for Auto: from the catalog, else from the parameter count, else "standard". */
export function tierOf(id: string, paramsB?: number): Tier {
  const t = lookup(id)?.tier
  if (t !== undefined) return t
  const p = paramsB ?? paramsFromName(id)
  if (p === undefined) return 2
  return p <= 3 ? 0 : p <= 14 ? 1 : p <= 40 ? 2 : 3
}

/** Quality within a tier (higher is better), from the recommended list and known cloud models. */
export function rankOf(id: string): number {
  const r = RECOMMENDED.find((x) => x.pull === id || `${x.pull}:latest` === id)
  if (r) return r.rank
  // Claude: by family, then the newer version (haiku-5-5 over haiku-4-5).
  const v = id.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i)
  const ver = v ? (Number(v[1]) + (v[2] && v[2].length < 3 ? Number(v[2]) / 10 : 0)) / 100 : 0
  if (/^claude-(opus|fable)/i.test(id)) return 5 + ver
  if (/^claude-sonnet/i.test(id)) return 4 + ver
  if (/^claude-haiku/i.test(id)) return 3 + ver
  return 0
}

export function lookup(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.match.test(id))
}

export function samplingFor(id: string, overrides: Record<string, Partial<Sampling>>): Sampling {
  return { ...(lookup(id)?.sampling ?? GENERIC), ...(overrides[id] ?? {}) }
}

/** "qwen3.8:27b" -> 27, "llama3.3:70b-instruct-q4" -> 70 */
export function paramsFromName(id: string): number | undefined {
  const m = id.match(/(\d+(?:\.\d+)?)\s*b(?![a-z])/i)
  return m ? Number(m[1]) : undefined
}

export const WINDOWS = [16384, 32768, 65536, 131072] as const
const GB = 1024 ** 3

export interface MemoryEstimate {
  requiredGB: number
  maxFittingWindow: number
  fits: boolean
}

/**
 * Apple Silicon shares RAM with the GPU, and Metal caps the GPU working set at
 * roughly 75% of RAM on large machines (about two thirds on small ones).
 */
export function gpuBudgetGB(totalGB: number): number {
  return totalGB * (totalGB >= 36 ? 0.75 : 0.66)
}

export function estimateMemory(opts: {
  weightsBytes?: number
  paramsB?: number
  kvBytesPerToken?: number
  window: number
  budgetGB: number
}): MemoryEstimate {
  const paramsB = opts.paramsB ?? 8
  // Q4_K_M averages ~4.85 bits/param.
  const weights = opts.weightsBytes ?? paramsB * 1e9 * 0.61
  // Unknown architecture: deliberately pessimistic (~8 KB per B params per token).
  const kv = opts.kvBytesPerToken ?? paramsB * 8000
  const overhead = 1.5 * GB
  const need = (w: number): number => (weights + kv * w + overhead) / GB
  const requiredGB = need(opts.window)
  let maxFittingWindow = 0
  for (const w of WINDOWS) if (need(w) <= opts.budgetGB) maxFittingWindow = w
  return { requiredGB: Math.round(requiredGB * 10) / 10, maxFittingWindow, fits: requiredGB <= opts.budgetGB }
}
