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
