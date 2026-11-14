// Optional meaning search: if an embedding model is installed in Ollama, passages get embeddings in the
// background. Nothing here is required; without a model the knowledge base uses keyword search alone.

/** Embedding models we know how to use, best first. Matched by name prefix ("nomic-embed-text:latest"). */
export const EMBED_MODELS = ['nomic-embed-text', 'mxbai-embed-large', 'embeddinggemma', 'snowflake-arctic-embed', 'bge-m3'] as const

/** The model the Settings hint suggests installing. */
export const SUGGESTED_EMBED_MODEL = 'nomic-embed-text'

export interface Embedder {
  readonly model: string
  /** Embeds passages ('document') or a search query ('query'). One vector per input, same order. */
  embed(texts: string[], kind: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
}

type Fetch = typeof fetch

const root = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

/** The best installed embedding model on an Ollama server, or null (none installed, or not running). */
export async function detectEmbedModel(baseUrl: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  // The user opted into OpenAI embeddings (Settings): that model wins over Ollama's.
  const openai = openaiEmbedModel()
  if (openai) return openai
  try {
    const res = await fetchImpl(`${root(baseUrl)}/api/tags`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) return null
    const tags = (await res.json()) as { models?: Array<{ name?: string; model?: string }> }
    const names = (tags.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean)
    return pickEmbedModel(names)
  } catch {
    return null
  }
}

/** Picks the preferred embedding model from installed model names. */
export function pickEmbedModel(names: string[]): string | null {
  for (const want of EMBED_MODELS) {
    const hit = names.find((n) => n.toLowerCase().split('/').pop()!.startsWith(want))
    if (hit) return hit
  }
  return null
}

/** Each model's recommended prefixes for passages and queries. */
export function prefixes(model: string): { document: string; query: string } {
  const m = model.toLowerCase()
  if (m.includes('nomic-embed')) return { document: 'search_document: ', query: 'search_query: ' }
  if (m.includes('mxbai-embed') || m.includes('snowflake-arctic-embed')) return { document: '', query: 'Represent this sentence for searching relevant passages: ' }
  if (m.includes('embeddinggemma')) return { document: 'title: none | text: ', query: 'task: search result | query: ' }
  return { document: '', query: '' }
}

/** Embeds through Ollama's /api/embed (batched; long inputs are truncated by the server). */
export function ollamaEmbedder(baseUrl: string, model: string, fetchImpl: Fetch = fetch): Embedder {
  // A model detectEmbedModel picked from OpenAI goes there instead.
  if (model.startsWith(OPENAI_EMBED_PREFIX) && embeddingProvider.openai) return openaiEmbedder(embeddingProvider.openai, model)
  const pre = prefixes(model)
  return {
    model,
    async embed(texts, kind, signal) {
      if (!texts.length) return []
      const input = texts.map((t) => `${pre[kind]}${t}`.slice(0, 8000))
      const timeout = AbortSignal.timeout(kind === 'query' ? 10_000 : 120_000)
      const res = await fetchImpl(`${root(baseUrl)}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input, truncate: true, keep_alive: '5m' }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      if (!res.ok) throw new Error(`Ollama embed answered ${res.status}`)
      const j = (await res.json()) as { embeddings?: number[][] }
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error('Ollama returned no embeddings')
      return j.embeddings.map((v) => Float32Array.from(v))
    }
  }
}

// ---------------------------------------------------------------- OpenAI embeddings (opt-in)
// Settings: "Use OpenAI for knowledge search embeddings" (openaiEmbeddings, off by default). Privacy:
// this sends passages of the user's indexed documents to OpenAI. While it is on (with an OpenAI key and
// cloud models on), detection picks the OpenAI model instead of Ollama's; vectors are stored per model,
// so switching back and forth keeps both sets. Every request is budget-checked and recorded.

/** Stored model name for OpenAI vectors ("openai:text-embedding-3-small"), never confused with an Ollama model. */
export const OPENAI_EMBED_PREFIX = 'openai:'
export const DEFAULT_OPENAI_EMBED_MODEL = 'text-embedding-3-small'

export interface OpenAIEmbedSource {
  /** Credentials when the setting is on, an OpenAI key is saved and cloud models are on; otherwise null. */
  creds(): { baseUrl: string; apiKey: string } | null
  model?(): string
  spend?: import('../apis/spend').Spend
  fetch?: Fetch
}

/** Set by the app (index.ts); tests set it directly. Null: Ollama only. */
export const embeddingProvider: { openai: OpenAIEmbedSource | null } = { openai: null }

/** The OpenAI model to use now, as stored ("openai:…"), or null when the option is off. */
export function openaiEmbedModel(): string | null {
  const o = embeddingProvider.openai
  if (!o?.creds()) return null
  return `${OPENAI_EMBED_PREFIX}${o.model?.() || DEFAULT_OPENAI_EMBED_MODEL}`
}

/** Embeds through OpenAI's /v1/embeddings, priced first against the cloud budget and recorded after. */
export function openaiEmbedder(source: OpenAIEmbedSource, stored: string): Embedder {
  const model = stored.startsWith(OPENAI_EMBED_PREFIX) ? stored.slice(OPENAI_EMBED_PREFIX.length) : stored
  return {
    model: stored,
    async embed(texts, kind, signal) {
      if (!texts.length) return []
      const c = source.creds()
      if (!c) throw new Error('OpenAI embeddings are off')
      const { embeddings, embeddingsUsd } = await import('../apis/openai')
      const { hookSpend } = await import('../apis/spend')
      const spend = source.spend ?? hookSpend
      // ~8,000 characters stays under the 8,192-token input limit.
      const input = texts.map((t) => t.slice(0, 8000))
      const est = input.reduce((n, t) => n + Math.ceil(t.length / 3), 0)
      spend.beforeUsd(c.baseUrl, model, embeddingsUsd(model, est))
      const timeout = AbortSignal.timeout(kind === 'query' ? 15_000 : 120_000)
      const r = await embeddings(c, model, input, signal ? AbortSignal.any([signal, timeout]) : timeout, source.fetch ?? fetch)
      spend.afterUsd(c.baseUrl, model, embeddingsUsd(model, r.tokens || est))
      return r.vectors.map((v) => Float32Array.from(v))
    }
  }
}
