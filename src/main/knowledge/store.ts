import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { basename, sep } from 'node:path'
import type { Chunk } from './chunker'
import { bm25Score, dot, fromBlob, normalize, queryTerms, subwords, termFreq, toBlob, tokenize } from './rank'
import { KNOWLEDGE_SCHEMA } from './schema'

// The knowledge base's index in SQLite: files (kb_docs), their passages (kb_chunks, with optional
// embeddings as Float32 blobs) and a keyword index: FTS5 with BM25 when this SQLite has it, otherwise
// BM25 computed here over an inverted index (kb_terms).

type Row = Record<string, unknown>

export interface DocRecord {
  path: string
  root: string
  kind: string
  size: number
  mtime: number
  hash: string
  /** Why the file has no passages (secret, binary, no text…). */
  skipped?: string
}

export interface ChunkHit {
  id: number
  path: string
  kind: string
  heading: string | null
  startLine: number | null
  endLine: number | null
  page: number | null
  text: string
  mtime: number
}

export type Scope = string[] | undefined

export interface StoreOptions {
  /** false forces the kb_terms keyword index (tests); default: FTS5 when available. */
  fts?: boolean
}

const STOP_FTS = /^(a|an|and|are|as|at|be|by|for|from|in|is|it|of|on|or|the|to|was|with|what|how|who|why|when|where|which|do|does|my|i|me|you)$/

/** Raw (unstemmed) words for an FTS5 query; FTS5's porter tokenizer stems them itself. */
export function ftsQuery(q: string): string {
  const words: string[] = []
  for (const m of q.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_]*/gu)) {
    const raw = m[0]
    const low = raw.toLowerCase()
    if (low.length > 40) continue
    if (!STOP_FTS.test(low)) words.push(low)
    if (/[a-z][A-Z]|_/.test(raw)) words.push(...subwords(raw))
  }
  const list = [...new Set(words.length ? words : q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 32)
  return list.map((w) => `"${w.replace(/"/g, '""')}"`).join(' OR ')
}

/** Identifier parts that differ from the words themselves ("resolvePath" → "resolve path"). */
function extraTerms(text: string): string {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:[A-Z_][A-Za-z0-9]*)+/g)) for (const s of subwords(m[0])) out.add(s)
  return [...out].join(' ')
}

export class KnowledgeStore {
  readonly mode: 'fts5' | 'terms'

  constructor(readonly sql: DatabaseSync, opts: StoreOptions = {}) {
    sql.exec(KNOWLEDGE_SCHEMA)
    this.mode = opts.fts !== false && this.tryFts() ? 'fts5' : 'terms'
    // The keyword index type changed (a SQLite build with or without FTS5): rebuild it from the passages.
    if (this.meta('lexical') !== this.mode) {
      this.rebuildLexical()
      this.setMeta('lexical', this.mode)
    }
  }

  private stmts = new Map<string, StatementSync>()

  /** A prepared statement, cached (indexing runs the same few statements many times). */
  private st(q: string): StatementSync {
    let s = this.stmts.get(q)
    if (!s) { s = this.sql.prepare(q); this.stmts.set(q, s) }
    return s
  }

  private tryFts(): boolean {
    try {
      this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(text, heading, name, extra, tokenize = 'porter unicode61 remove_diacritics 2')`)
      this.sql.prepare('SELECT rowid FROM kb_fts LIMIT 0').all()
      return true
    } catch {
      return false
    }
  }

  // ---------------------------------------------------------------- meta and sources

  meta(key: string): string | undefined {
    return (this.sql.prepare('SELECT value FROM kb_meta WHERE key = ?').get(key) as Row | undefined)?.value as string | undefined
  }

  setMeta(key: string, value: string): void {
    this.sql.prepare('INSERT INTO kb_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /** Folders the user added (Settings, or "Add to knowledge" on an attached folder). */
  userSources(): Array<{ path: string; kind: 'folder' | 'attached'; spaceId: string | null; addedAt: number }> {
    return (this.sql.prepare('SELECT * FROM kb_sources ORDER BY added_at').all() as Row[]).map((r) => ({
      path: r.path as string, kind: r.kind as 'folder' | 'attached', spaceId: (r.space_id as string | null) ?? null, addedAt: r.added_at as number
    }))
  }

  addSource(path: string, kind: 'folder' | 'attached', spaceId: string | null = null): void {
    this.sql.prepare('INSERT INTO kb_sources(path, kind, space_id, added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING').run(path, kind, spaceId, Date.now())
  }

  removeSource(path: string): void {
    this.sql.prepare('DELETE FROM kb_sources WHERE path = ?').run(path)
  }

  // ---------------------------------------------------------------- documents

  doc(path: string): (DocRecord & { id: number; chunks: number; indexedAt: number }) | undefined {
    const r = this.st('SELECT * FROM kb_docs WHERE path = ?').get(path) as Row | undefined
    if (!r) return undefined
    return { id: r.id as number, path: r.path as string, root: r.root as string, kind: r.kind as string, size: r.size as number, mtime: r.mtime as number, hash: r.hash as string, skipped: (r.skipped as string | null) ?? undefined, chunks: r.chunks as number, indexedAt: r.indexed_at as number }
  }

  /** Every indexed path (optionally only under one folder). */
  paths(under?: string): string[] {
    const base = under ? trimSep(under) : ''
    const rows = base
      ? this.st('SELECT path FROM kb_docs WHERE path = ? OR substr(path, 1, ?) = ?').all(base, base.length + 1, withSep(base))
      : this.st('SELECT path FROM kb_docs').all()
    return (rows as Row[]).map((r) => r.path as string)
  }

  /** Same file, new modification time (contents unchanged). */
  touch(path: string, mtime: number, size: number): void {
    this.sql.prepare('UPDATE kb_docs SET mtime = ?, size = ? WHERE path = ?').run(mtime, size, path)
  }

  /** Replaces a file's passages. Unchanged passages keep their embeddings. */
  upsert(doc: DocRecord, chunks: Chunk[]): void {
    this.tx(() => {
      const old = this.doc(doc.path)
      const keep = new Map<string, { embedding: Uint8Array; model: string }>()
      if (old) {
        for (const r of this.sql.prepare('SELECT text, embedding, emb_model FROM kb_chunks WHERE doc_id = ? AND embedding IS NOT NULL').all(old.id) as Row[]) {
          keep.set(r.text as string, { embedding: r.embedding as Uint8Array, model: r.emb_model as string })
        }
        this.dropChunks(old.id)
        this.sql.prepare('UPDATE kb_docs SET root = ?, kind = ?, size = ?, mtime = ?, hash = ?, chunks = ?, skipped = ?, indexed_at = ? WHERE id = ?')
          .run(doc.root, doc.kind, doc.size, doc.mtime, doc.hash, chunks.length, doc.skipped ?? null, Date.now(), old.id)
      } else {
        this.sql.prepare('INSERT INTO kb_docs(path, root, kind, size, mtime, hash, chunks, skipped, indexed_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(doc.path, doc.root, doc.kind, doc.size, doc.mtime, doc.hash, chunks.length, doc.skipped ?? null, Date.now())
      }
      const docId = old?.id ?? (this.sql.prepare('SELECT id FROM kb_docs WHERE path = ?').get(doc.path) as Row).id as number
      const ins = this.st('INSERT INTO kb_chunks(doc_id, seq, text, heading, start_line, end_line, page, tokens, nterms, embedding, emb_model) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      const name = basename(doc.path)
      chunks.forEach((c, seq) => {
        const terms = tokenize(`${name} ${c.heading ?? ''} ${c.text}`)
        const k = keep.get(c.text)
        const r = ins.run(docId, seq, c.text, c.heading ?? null, c.startLine ?? null, c.endLine ?? null, c.page ?? null, c.tokens, terms.length, k?.embedding ?? null, k?.model ?? null)
        this.indexLexical(Number(r.lastInsertRowid), c.text, c.heading ?? '', name, terms)
      })
    })
  }

  remove(path: string): void {
    this.tx(() => {
      const d = this.doc(path)
      if (!d) return
      this.dropChunks(d.id)
      this.sql.prepare('DELETE FROM kb_docs WHERE id = ?').run(d.id)
    })
  }

  /** Removes a file, or every file under a folder. Returns how many were removed. */
  removeUnder(path: string): number {
    const list = this.paths(path)
    for (const p of list) this.remove(p)
    return list.length
  }

  /** Forgets everything (Rebuild). */
  clear(): void {
    this.tx(() => {
      if (this.mode === 'fts5') this.sql.exec('DELETE FROM kb_fts')
      this.sql.exec('DELETE FROM kb_terms; DELETE FROM kb_chunks; DELETE FROM kb_docs;')
    })
  }

  private dropChunks(docId: number): void {
    if (this.mode === 'fts5') this.sql.prepare('DELETE FROM kb_fts WHERE rowid IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(docId)
    else this.sql.prepare('DELETE FROM kb_terms WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(docId)
    this.sql.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId)
  }

  private indexLexical(id: number, text: string, heading: string, name: string, terms?: string[]): void {
    if (this.mode === 'fts5') {
      this.st('INSERT INTO kb_fts(rowid, text, heading, name, extra) VALUES(?,?,?,?,?)').run(id, text, heading, name, extraTerms(`${name} ${heading} ${text}`))
      return
    }
    const ins = this.st('INSERT INTO kb_terms(term, chunk_id, tf) VALUES(?,?,?)')
    for (const [t, f] of termFreq(terms ?? tokenize(`${name} ${heading} ${text}`))) ins.run(t, id, f)
  }

  private rebuildLexical(): void {
    this.tx(() => {
      if (this.mode === 'fts5') this.sql.exec('DELETE FROM kb_fts')
      this.sql.exec('DELETE FROM kb_terms')
      const rows = this.sql.prepare('SELECT c.id, c.text, c.heading, d.path FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id').all() as Row[]
      for (const r of rows) this.indexLexical(r.id as number, r.text as string, (r.heading as string | null) ?? '', basename(r.path as string))
    })
  }

  /** Runs `fn` in a savepoint (safe inside or outside another transaction). */
  private tx(fn: () => void): void {
    this.sql.exec('SAVEPOINT kb')
    try {
      fn()
      this.sql.exec('RELEASE kb')
    } catch (e) {
      this.sql.exec('ROLLBACK TO kb')
      this.sql.exec('RELEASE kb')
      throw e
    }
  }

  // ---------------------------------------------------------------- search

  private scopeSql(scope: Scope): { where: string; args: Array<string | number> } {
    if (!scope?.length) return { where: '1', args: [] }
    const parts: string[] = []
    const args: Array<string | number> = []
    for (const s of scope) {
      const base = trimSep(s)
      parts.push('(d.path = ? OR substr(d.path, 1, ?) = ?)')
      args.push(base, base.length + 1, withSep(base))
    }
    return { where: `(${parts.join(' OR ')})`, args }
  }

  /** Keyword search, best first (BM25). */
  keyword(query: string, scope: Scope, limit = 50): Array<{ id: number; score: number }> {
    const { where, args } = this.scopeSql(scope)
    if (this.mode === 'fts5') {
      const match = ftsQuery(query)
      if (!match) return []
      try {
        const rows = this.sql.prepare(`SELECT f.rowid AS id, bm25(kb_fts, 1.0, 2.0, 1.5, 0.5) AS s FROM kb_fts f
          JOIN kb_chunks c ON c.id = f.rowid JOIN kb_docs d ON d.id = c.doc_id
          WHERE kb_fts MATCH ? AND ${where} ORDER BY s LIMIT ?`).all(match, ...args, limit) as Row[]
        return rows.map((r) => ({ id: r.id as number, score: -(r.s as number) }))
      } catch {
        return []
      }
    }
    const terms = queryTerms(query)
    if (!terms.length) return []
    const stats = this.sql.prepare('SELECT COUNT(*) AS n, AVG(nterms) AS avg FROM kb_chunks').get() as Row
    const n = (stats.n as number) || 0
    if (!n) return []
    const avgLength = (stats.avg as number) || 1
    const df = new Map<string, number>()
    const tfs = new Map<number, { length: number; tf: Map<string, number> }>()
    const dfStmt = this.sql.prepare('SELECT COUNT(*) AS n FROM kb_terms WHERE term = ?')
    const postings = this.sql.prepare(`SELECT t.chunk_id AS id, t.tf, c.nterms FROM kb_terms t JOIN kb_chunks c ON c.id = t.chunk_id JOIN kb_docs d ON d.id = c.doc_id
      WHERE t.term = ? AND ${where} LIMIT 20000`)
    for (const t of terms) {
      df.set(t, (dfStmt.get(t) as Row).n as number)
      for (const r of postings.all(t, ...args) as Row[]) {
        const id = r.id as number
        const e = tfs.get(id) ?? { length: r.nterms as number, tf: new Map() }
        e.tf.set(t, r.tf as number)
        tfs.set(id, e)
      }
    }
    return [...tfs]
      .map(([id, e]) => ({ id, score: bm25Score(terms, (t) => e.tf.get(t) ?? 0, e.length, { n, avgLength, df: (t) => df.get(t) ?? 0 }) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Meaning search: cosine similarity against stored embeddings of one model, best first. */
  vector(query: Float32Array, model: string, scope: Scope, limit = 50, maxScan = 250_000): Array<{ id: number; score: number }> {
    const q = normalize(query)
    const { where, args } = this.scopeSql(scope)
    const top: Array<{ id: number; score: number }> = []
    let worst = -Infinity
    let scanned = 0
    const stmt = this.sql.prepare(`SELECT c.id, c.embedding FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.emb_model = ? AND c.embedding IS NOT NULL AND ${where}`)
    for (const r of stmt.iterate(model, ...args) as Iterable<Row>) {
      if (++scanned > maxScan) break
      const v = fromBlob(r.embedding as Uint8Array)
      if (v.length !== q.length) continue
      const s = dot(q, v)
      if (top.length < limit || s > worst) {
        top.push({ id: r.id as number, score: s })
        if (top.length > limit * 2) { top.sort((a, b) => b.score - a.score); top.length = limit; worst = top[top.length - 1].score }
      }
    }
    return top.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  hits(ids: number[]): ChunkHit[] {
    if (!ids.length) return []
    const rows = this.sql.prepare(`SELECT c.id, c.text, c.heading, c.start_line, c.end_line, c.page, d.path, d.kind, d.mtime
      FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]
    const byId = new Map(rows.map((r) => [r.id as number, r]))
    return ids.map((id) => byId.get(id)).filter((r): r is Row => !!r).map((r) => ({
      id: r.id as number, path: r.path as string, kind: r.kind as string, heading: (r.heading as string | null) ?? null,
      startLine: (r.start_line as number | null) ?? null, endLine: (r.end_line as number | null) ?? null, page: (r.page as number | null) ?? null,
      text: r.text as string, mtime: r.mtime as number
    }))
  }

  // ---------------------------------------------------------------- embeddings

  /** Passages still without an embedding from `model`, oldest first. */
  unembedded(model: string, limit: number): Array<{ id: number; text: string; heading: string | null; path: string }> {
    return (this.sql.prepare(`SELECT c.id, c.text, c.heading, d.path FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
      WHERE c.emb_model IS NULL OR c.emb_model != ? ORDER BY c.id LIMIT ?`).all(model, limit) as Row[])
      .map((r) => ({ id: r.id as number, text: r.text as string, heading: (r.heading as string | null) ?? null, path: r.path as string }))
  }

  setEmbedding(id: number, vec: Float32Array, model: string): void {
    this.sql.prepare('UPDATE kb_chunks SET embedding = ?, emb_model = ? WHERE id = ?').run(toBlob(normalize(vec)), model, id)
  }

  embeddedCount(model: string, scope?: Scope): number {
    const { where, args } = this.scopeSql(scope)
    return (this.sql.prepare(`SELECT COUNT(*) AS n FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.emb_model = ? AND ${where}`).get(model, ...args) as Row).n as number
  }

  // ---------------------------------------------------------------- the vault's document digests

  /**
   * Indexed documents worth a digest note (src/main/vault): prose kinds with passages, modified since
   * `since`, not under any `exclude` folder (the vault itself), newest first.
   */
  recentDocs(o: { since: number; exclude?: string[]; kinds?: string[]; minSize?: number; limit?: number }): Array<{ path: string; kind: string; size: number; mtime: number; chunks: number }> {
    const kinds = o.kinds ?? ['markdown', 'text', 'pdf', 'docx', 'pptx', 'html']
    const rows = this.sql.prepare(`SELECT path, kind, size, mtime, chunks FROM kb_docs WHERE chunks > 0 AND mtime >= ? AND size >= ?
      AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY mtime DESC LIMIT ?`).all(o.since, o.minSize ?? 400, ...kinds, Math.max(1, (o.limit ?? 50) * 4)) as Row[]
    const ex = (o.exclude ?? []).map(withSep)
    return rows
      .map((r) => ({ path: r.path as string, kind: r.kind as string, size: r.size as number, mtime: r.mtime as number, chunks: r.chunks as number }))
      .filter((d) => !ex.some((e) => d.path.startsWith(e) || withSep(d.path) === e))
      .slice(0, o.limit ?? 50)
  }

  /** A document's indexed text (passages in order, already redacted), up to `maxChars`. */
  docText(path: string, maxChars = 12_000): string {
    const rows = this.sql.prepare(`SELECT c.text, c.heading, c.page FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE d.path = ? ORDER BY c.seq`).all(path) as Row[]
    const out: string[] = []
    let used = 0
    for (const r of rows) {
      const head = r.page ? `[page ${r.page}] ` : r.heading ? `[${r.heading}] ` : ''
      const t = `${head}${r.text as string}`
      if (used + t.length > maxChars) { if (!out.length) out.push(t.slice(0, maxChars)); break }
      out.push(t)
      used += t.length + 2
    }
    return out.join('\n\n')
  }

  // ---------------------------------------------------------------- counts

  totals(scope?: Scope): { files: number; skipped: number; chunks: number; lastIndexed: number | null } {
    const { where, args } = this.scopeSql(scope)
    const r = this.sql.prepare(`SELECT SUM(CASE WHEN d.chunks > 0 THEN 1 ELSE 0 END) AS files, SUM(CASE WHEN d.chunks = 0 THEN 1 ELSE 0 END) AS skipped,
      COALESCE(SUM(d.chunks), 0) AS chunks, MAX(d.indexed_at) AS last FROM kb_docs d WHERE ${where}`).get(...args) as Row
    return { files: (r.files as number) ?? 0, skipped: (r.skipped as number) ?? 0, chunks: (r.chunks as number) ?? 0, lastIndexed: (r.last as number | null) ?? null }
  }
}

function withSep(p: string): string {
  return p.endsWith(sep) ? p : p + sep
}

function trimSep(p: string): string {
  return p.length > 1 ? p.replace(/[\\/]+$/, '') || p : p
}
