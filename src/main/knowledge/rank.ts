// Ranking pieces for the knowledge base: a tokenizer shared by indexing and queries, BM25 (used when
// SQLite has no FTS5, and to rank in tests), cosine similarity for embeddings, and reciprocal rank
// fusion to merge keyword and meaning results.

const STOP = new Set(('a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our she so ' +
  'than that the their them then there these they this to was we were what when where which who why will with you your do does did can could ' +
  'should would how about all any been being both each few more most other some such only own same too very just also').split(' '))

/** Splits camelCase, PascalCase and snake_case identifiers into their words (lowercased). */
export function subwords(word: string): string[] {
  const parts = word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[\s_\-.]+/)
  return parts.map((p) => p.toLowerCase()).filter((p) => p.length > 1)
}

/** A light English stemmer (plural, -ing, -ed), the same on both sides so "running" finds "runs". */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y'
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (w.endsWith('ing') && w.length > 5) { const b = w.slice(0, -3); return /(.)\1$/.test(b) && !/[lsz]$/.test(b) ? b.slice(0, -1) : b }
  if (w.endsWith('ed') && w.length > 4) { const b = w.slice(0, -2); return /(.)\1$/.test(b) && !/[lsz]$/.test(b) ? b.slice(0, -1) : b }
  if (w.endsWith('es') && /(sh|ch|x|z)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1)
  return w
}

/**
 * Index terms for a passage: words (letters and digits, any script), stemmed, without stop words;
 * identifiers also add their parts ("resolvePath" → resolvepath, resolve, path).
 */
export function tokenize(text: string, keepStop = false): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_]*/gu)) {
    const raw = m[0]
    const low = raw.toLowerCase()
    if (low.length > 40) continue
    if (keepStop || !STOP.has(low)) out.push(stem(low))
    if (/[a-z][A-Z]|_/.test(raw)) for (const s of subwords(raw)) if (s !== low && !STOP.has(s)) out.push(stem(s))
  }
  return out
}

/** Query terms: tokenize without duplicates, stop words dropped (unless that leaves nothing). */
export function queryTerms(q: string): string[] {
  const t = tokenize(q)
  const terms = t.length ? t : tokenize(q, true)
  return [...new Set(terms)].slice(0, 32)
}

export interface Bm25Doc { id: number; tf: Map<string, number>; length: number }

/** Term frequencies of a token list. */
export function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

export const BM25 = { k1: 1.2, b: 0.75 }

/** BM25's idf (always positive, the Lucene form). */
export function idf(n: number, df: number): number {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5))
}

/** BM25 score of one document for the query terms, given collection stats. */
export function bm25Score(terms: string[], tf: (term: string) => number, length: number, stats: { n: number; avgLength: number; df: (term: string) => number }): number {
  let s = 0
  for (const t of terms) {
    const f = tf(t)
    if (!f) continue
    const norm = f + BM25.k1 * (1 - BM25.b + BM25.b * (length / Math.max(1, stats.avgLength)))
    s += idf(stats.n, stats.df(t)) * ((f * (BM25.k1 + 1)) / norm)
  }
  return s
}

/** Ranks an in-memory corpus with BM25 (highest first; zero scores dropped). */
export function rankBm25(query: string, docs: Bm25Doc[]): Array<{ id: number; score: number }> {
  const terms = queryTerms(query)
  const n = docs.length
  const avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, n)
  const df = new Map<string, number>()
  for (const t of terms) df.set(t, docs.filter((d) => d.tf.has(t)).length)
  return docs
    .map((d) => ({ id: d.id, score: bm25Score(terms, (t) => d.tf.get(t) ?? 0, d.length, { n, avgLength: avg, df: (t) => df.get(t) ?? 0 }) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** Reciprocal rank fusion: each list adds 1/(k + rank) for its items. Ties keep first-list order. */
export function rrf(lists: number[][], k = 60): Array<{ id: number; score: number }> {
  const score = new Map<number, number>()
  const first = new Map<number, number>()
  let order = 0
  for (const list of lists) {
    list.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1))
      if (!first.has(id)) first.set(id, order++)
    })
  }
  return [...score].map(([id, s]) => ({ id, score: s })).sort((a, b) => b.score - a.score || first.get(a.id)! - first.get(b.id)!)
}

/** Unit-length copy of a vector (so cosine is a dot product). */
export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < len; i++) s += a[i] * b[i]
  return s
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return dot(normalize(a), normalize(b))
}

/** Float32 vector ⇄ SQLite blob. */
export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy: the blob's buffer may not be 4-byte aligned.
  const copy = new Uint8Array(b.byteLength)
  copy.set(b)
  return new Float32Array(copy.buffer)
}
