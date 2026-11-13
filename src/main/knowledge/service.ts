import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { KnowledgeHit, KnowledgeSearchResult, KnowledgeSource, KnowledgeStatus } from '@shared/types'
import { detectEmbedModel, ollamaEmbedder, SUGGESTED_EMBED_MODEL, type Embedder } from './embeddings'
import { refuseRoot } from './ignore'
import { Indexer } from './indexer'
import { queryTerms, rrf, tokenize } from './rank'
import { KnowledgeStore, type ChunkHit, type StoreOptions } from './store'
import { FolderWatcher } from './watcher'

// The knowledge base: which folders are sources, keeping their index current (startup scan, file
// watching, a periodic rescan), background embeddings when an Ollama embedding model is installed,
// and hybrid search (BM25 + cosine, fused with reciprocal rank fusion; BM25 alone otherwise).

export interface KnowledgeDeps {
  sql: DatabaseSync
  workspace: () => string
  /** Project bots and their folders. */
  projects: () => Array<{ id: string; name: string; folder: string | null }>
  /** Ollama's base URL; null when it isn't configured. */
  ollamaUrl: () => string | null
  /** True while any chat, routine or helper is running: embeddings wait, indexing slows down. */
  busy: () => boolean
  /** Status changed (throttled by the caller if needed). */
  onChange?: () => void
  home?: string
  store?: StoreOptions
  /** Tests: a fixed embedder (or null for keyword only) instead of detecting one in Ollama. */
  embedder?: Embedder | null
  maxFiles?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
// The native realpath also gives the disk's own spelling of each name (~/library → ~/Library).
const real = (p: string): string => { try { return realpathSync.native(p) } catch { return resolve(p) } }

const EMBED_BATCH = 16
const RESCAN_MS = 3 * 60 * 60 * 1000
const DETECT_MS = 10 * 60 * 1000

export class KnowledgeService {
  readonly store: KnowledgeStore
  readonly indexer: Indexer
  private watcher: FolderWatcher
  private embedder: Embedder | null = null
  private lastDetect = 0
  private timers: Array<ReturnType<typeof setTimeout>> = []
  private disposed = false
  private embedding = false
  private embedBackoff = 0
  private lastScan: number | null = null
  private scanning: Promise<void> | null = null
  private started = false
  private lastRoots = ''
  private again = false
  private rescanTimer: ReturnType<typeof setTimeout> | null = null
  private embedTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private d: KnowledgeDeps) {
    this.store = new KnowledgeStore(d.sql, d.store)
    this.indexer = new Indexer(this.store, { home: d.home, maxFiles: d.maxFiles, pace: () => this.pace(), onProgress: () => this.changed() })
    this.watcher = new FolderWatcher((paths) => void this.onPaths(paths))
    if (d.embedder !== undefined) this.embedder = d.embedder
    const last = Number(this.store.meta('lastScan'))
    this.lastScan = Number.isFinite(last) && last > 0 ? last : null
  }

  private get home(): string {
    return this.d.home ?? homedir()
  }

  get paused(): boolean {
    return this.store.meta('paused') === '1'
  }

  // ---------------------------------------------------------------- sources

  /** Every source folder: the workspace, each project's folder, and folders the user added. */
  sources(): Array<Omit<KnowledgeSource, 'files' | 'chunks' | 'skipped' | 'lastIndexed'>> {
    const out: Array<Omit<KnowledgeSource, 'files' | 'chunks' | 'skipped' | 'lastIndexed'>> = []
    const add = (path: string, kind: KnowledgeSource['kind'], label: string, spaceId: string | null, removable: boolean): void => {
      const p = real(path)
      if (out.some((s) => s.path === p)) return
      const problem = !existsSync(p) ? 'Folder not found.' : refuseRoot(p, this.home) || (statSync(p).isDirectory() ? '' : 'Not a folder.')
      out.push({ path: p, kind, label, spaceId, removable, ...(problem ? { problem } : {}), ...(this.indexer.truncated.has(p) ? { truncated: true } : {}) })
    }
    const ws = this.d.workspace()
    if (ws) add(ws, 'workspace', 'Workspace', null, false)
    for (const p of this.d.projects()) if (p.folder) add(p.folder, 'project', p.name, p.id, false)
    for (const s of this.store.userSources()) add(s.path, s.kind, basename(s.path) || s.path, s.spaceId, true)
    return out
  }

  /** Folders to walk and watch: usable sources that aren't inside another source. */
  roots(): string[] {
    const ok = this.sources().filter((s) => !s.problem).map((s) => s.path)
    return ok.filter((p) => !ok.some((o) => o !== p && inside(o, p)))
  }

  /** Adds a folder the user picked (Settings) or attached to a chat (opt-in). */
  addFolder(path: string, kind: 'folder' | 'attached' = 'folder', spaceId: string | null = null): void {
    const p = real(path)
    const why = refuseRoot(p, this.home)
    if (why) throw new Error(why)
    if (!existsSync(p) || !statSync(p).isDirectory()) throw new Error('Choose a folder.')
    this.store.addSource(p, kind, spaceId)
    this.changed()
    void this.refresh(false)
  }

  /** Removes a folder the user added; its files leave the index unless another source covers them. */
  removeFolder(path: string): void {
    const p = real(path)
    this.store.removeSource(p)
    this.store.removeSource(path)
    const covered = this.roots()
    for (const doc of this.store.paths(p)) if (!covered.some((r) => inside(r, doc))) this.store.remove(doc)
    this.watcher.set(covered)
    this.changed()
  }

  /** Folders attached to chats (thread roots) that aren't sources yet: candidates for "Add to knowledge". */
  attachedCandidates(): string[] {
    const out = new Set<string>()
    try {
      for (const r of this.d.sql.prepare(`SELECT data FROM thread_state WHERE data LIKE '%"roots"%'`).all() as Array<{ data: string }>) {
        const roots = (JSON.parse(r.data) as { roots?: unknown }).roots
        if (Array.isArray(roots)) for (const x of roots) if (typeof x === 'string') out.add(x)
      }
    } catch { /* no chats table (tests) */ }
    const covered = this.sources().map((s) => s.path)
    return [...out].filter((p) => {
      try { return statSync(p).isDirectory() && !refuseRoot(real(p), this.home) && !covered.some((c) => inside(c, real(p))) } catch { return false }
    }).slice(0, 30)
  }

  // ---------------------------------------------------------------- indexing

  /** Starts indexing: a scan soon after launch, file watching, periodic rescans and embeddings. */
  start(delayMs = 8000): void {
    this.started = true
    this.later(() => void this.refresh(true), delayMs)
    this.scheduleEmbed(delayMs + 5000)
    this.later(() => this.watchSources(), delayMs + 60_000)
  }

  /** New or removed projects and folders: index the new ones without waiting for the next rescan. */
  private watchSources(): void {
    if (!this.scanning && this.roots().join('\n') !== this.lastRoots) void this.refresh(false)
    this.later(() => this.watchSources(), 60_000)
  }

  /** The next background embedding step (one pending step at a time). */
  private scheduleEmbed(ms: number): void {
    if (!this.started || this.disposed) return
    if (this.embedTimer) clearTimeout(this.embedTimer)
    this.embedTimer = setTimeout(() => { this.embedTimer = null; void this.embedTick() }, ms)
  }

  private later(fn: () => void, ms: number): void {
    if (this.disposed) return
    const t = setTimeout(() => { this.timers = this.timers.filter((x) => x !== t); fn() }, ms)
    this.timers.push(t)
  }

  /** Scans every source (picking up changes made while SahilBot was closed), then reads what changed. */
  refresh(full = true): Promise<void> {
    // Already scanning: scan again right after (a folder was just added).
    if (this.scanning) { this.again = true; return this.scanning }
    this.scanning = (async () => {
      await Promise.resolve()
      try {
        const roots = this.roots()
        this.lastRoots = roots.join('\n')
        this.watcher.set(roots)
        this.changed()
        // Files under no current source (a project or folder was removed) leave the index.
        if (!full) for (const p of this.store.paths()) if (!roots.some((r) => inside(r, p))) this.store.remove(p)
        await this.indexer.scan(roots, full)
        this.lastScan = Date.now()
        this.store.setMeta('lastScan', String(this.lastScan))
        this.changed()
        await this.indexer.drain()
      } finally {
        this.scanning = null
        this.changed()
        if (full && this.started && !this.disposed) {
          if (this.rescanTimer) clearTimeout(this.rescanTimer)
          this.rescanTimer = setTimeout(() => { this.rescanTimer = null; void this.refresh(true) }, RESCAN_MS)
        }
        if (this.again && !this.disposed) { this.again = false; void this.refresh(false) }
      }
    })()
    return this.scanning
  }

  private async onPaths(paths: string[]): Promise<void> {
    if (this.disposed) return
    await this.indexer.changed(paths, this.roots())
    this.changed()
    await this.indexer.drain()
    this.changed()
  }

  /** Between files: wait while paused; go gently while a chat is running. */
  private async pace(): Promise<void> {
    while (this.paused && !this.disposed) await sleep(1000)
    await sleep(this.d.busy() ? 250 : 5)
  }

  setPaused(on: boolean): void {
    this.store.setMeta('paused', on ? '1' : '0')
    this.changed()
    if (!on) this.scheduleEmbed(1000)
  }

  /** Forgets the whole index and reads every source again. */
  async rebuild(): Promise<void> {
    this.indexer.clearQueue()
    if (this.scanning) await this.scanning.catch(() => undefined)
    this.store.clear()
    this.changed()
    await this.refresh(true)
  }

  // ---------------------------------------------------------------- embeddings

  /** The embedding model in use (detected in Ollama, re-checked every few minutes). */
  async embedModel(force = false): Promise<string | null> {
    if (this.d.embedder !== undefined) return this.d.embedder?.model ?? null
    if (!force && Date.now() - this.lastDetect < DETECT_MS) return this.embedder?.model ?? null
    this.lastDetect = Date.now()
    const url = this.d.ollamaUrl()
    const model = url ? await detectEmbedModel(url) : null
    if (model !== (this.embedder?.model ?? null)) {
      this.embedder = model && url ? ollamaEmbedder(url, model) : null
      this.changed()
    }
    return model
  }

  /** One background step: embeds a batch of passages when idle (never while a chat is running). */
  async embedTick(): Promise<number> {
    if (this.disposed || this.embedding) return 0
    let done = 0
    let next = 30_000
    this.embedding = true
    try {
      if (this.paused || this.d.busy() || Date.now() < this.embedBackoff) return 0
      const model = await this.embedModel()
      const emb = this.embedder
      if (!model || !emb) { next = DETECT_MS; return 0 }
      const batch = this.store.unembedded(model, EMBED_BATCH)
      if (!batch.length) { next = 60_000; return 0 }
      // A chat starting mid-batch cancels it: chats always come first.
      const ctl = new AbortController()
      const watch = setInterval(() => { if (this.d.busy() || this.paused || this.disposed) ctl.abort() }, 250)
      try {
        const vecs = await emb.embed(batch.map((c) => `${basename(c.path)}${c.heading ? ` · ${c.heading}` : ''}\n${c.text}`), 'document', ctl.signal)
        if (ctl.signal.aborted) return 0
        vecs.forEach((v, i) => this.store.setEmbedding(batch[i].id, v, model))
        done = vecs.length
        next = 400
        this.changed()
      } catch {
        if (!ctl.signal.aborted) { this.embedBackoff = Date.now() + 60_000; next = 60_000 } else next = 5000
      } finally {
        clearInterval(watch)
      }
      return done
    } finally {
      this.embedding = false
      this.scheduleEmbed(next)
    }
  }

  // ---------------------------------------------------------------- search

  /**
   * Hybrid search: BM25 keyword results and (when passages have embeddings) cosine results, fused
   * with reciprocal rank fusion. `scope`: folders to search in (default: everything indexed).
   */
  async search(query: string, opts: { scope?: string[]; k?: number; signal?: AbortSignal } = {}): Promise<KnowledgeSearchResult> {
    const k = Math.max(1, Math.min(20, opts.k ?? 6))
    const scope = opts.scope?.length ? opts.scope.map(real) : this.roots()
    if (!scope.length) return { hits: [], mode: 'keyword' }
    const keyword = this.store.keyword(query, scope, 60)
    let semantic: Array<{ id: number; score: number }> = []
    const model = await this.embedModel().catch(() => null)
    if (model && this.embedder && this.store.embeddedCount(model, scope) > 0) {
      try {
        const [q] = await this.embedder.embed([query], 'query', opts.signal)
        const raw = this.store.vector(q, model, scope, 30)
        // Meaning results always return something; keep only those near the best match.
        const best = raw[0]?.score ?? 0
        semantic = raw.filter((r) => r.score >= Math.max(0.2, best - 0.2))
      } catch { /* Ollama busy or gone: keyword results alone */ }
    }
    const fused = semantic.length ? rrf([keyword.map((r) => r.id), semantic.map((r) => r.id)]) : keyword
    // At most 2 passages from one file, so one long document doesn't crowd out the rest.
    const perFile = new Map<string, number>()
    const hits: KnowledgeHit[] = []
    const pool = this.store.hits(fused.slice(0, k * 5).map((r) => r.id))
    const scoreOf = new Map(fused.map((r) => [r.id, r.score]))
    for (const h of pool) {
      const n = perFile.get(h.path) ?? 0
      if (n >= 2) continue
      perFile.set(h.path, n + 1)
      hits.push(toHit(h, query, scoreOf.get(h.id) ?? 0))
      if (hits.length >= k) break
    }
    return { hits, mode: semantic.length ? 'hybrid' : 'keyword' }
  }

  /** The scope for a chat: its project folder when it has one. */
  folderFor(spaceId: string | undefined): string | null {
    if (!spaceId) return null
    return this.d.projects().find((p) => p.id === spaceId)?.folder ?? null
  }

  /** True when `path` is a file in the index (the UI may open or reveal only those). */
  isIndexed(path: string): boolean {
    return !!this.store.doc(path)
  }

  // ---------------------------------------------------------------- status

  status(): KnowledgeStatus {
    const sources = this.sources().map((s) => ({ ...s, ...(s.problem ? { files: 0, chunks: 0, skipped: 0, lastIndexed: null } : this.store.totals([s.path])) }))
    const roots = this.roots()
    const totals = roots.length ? this.store.totals(roots) : { files: 0, chunks: 0, skipped: 0, lastIndexed: null }
    const model = this.embedder?.model ?? null
    return {
      sources,
      totals: { files: totals.files, chunks: totals.chunks, skipped: totals.skipped },
      embedModel: model,
      embedded: model ? this.store.embeddedCount(model) : 0,
      paused: this.paused,
      indexing: !!this.scanning || this.indexer.busy,
      queued: this.indexer.queued,
      current: this.indexer.current,
      keyword: this.store.mode,
      lastScan: this.lastScan,
      suggestedModel: SUGGESTED_EMBED_MODEL,
      attached: this.attachedCandidates()
    }
  }

  private changed(): void {
    try { this.d.onChange?.() } catch { /* the window may be gone */ }
  }

  dispose(): void {
    this.disposed = true
    this.indexer.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.embedTimer) clearTimeout(this.embedTimer)
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.watcher.dispose()
  }
}

// ---------------------------------------------------------------- snippets and citations

/** The most relevant few lines of a passage, with their line range when the file has lines. */
export function snippetOf(h: Pick<ChunkHit, 'text' | 'startLine' | 'endLine'>, query: string, maxLines = 10, maxChars = 700): { text: string; startLine: number | null; endLine: number | null } {
  const lines = h.text.split('\n')
  const terms = new Set(queryTerms(query))
  const hitsPer = lines.map((l) => tokenize(l).filter((t) => terms.has(t)).length)
  let best = 0
  let bestScore = -1
  for (let i = 0; i < lines.length; i++) {
    let s = 0
    for (let j = i; j < Math.min(lines.length, i + maxLines); j++) s += hitsPer[j]
    if (s > bestScore) { bestScore = s; best = i }
  }
  // Start a line or two before the first hit, for context.
  if (bestScore > 0) { const first = hitsPer.findIndex((n, i) => i >= best && n > 0); best = Math.max(0, first - 1) }
  const out: string[] = []
  let chars = 0
  let end = best
  for (let i = best; i < lines.length && out.length < maxLines; i++) {
    if (chars + lines[i].length > maxChars && out.length) break
    out.push(lines[i].length > maxChars ? lines[i].slice(0, maxChars) + '…' : lines[i])
    chars += lines[i].length + 1
    end = i
  }
  // Line numbers are exact only when the passage's lines map one to one onto the file's.
  const exact = h.startLine !== null && h.endLine !== null && h.endLine - h.startLine + 1 === lines.length
  return {
    text: out.join('\n').trim(),
    startLine: exact ? h.startLine! + best : h.startLine,
    endLine: exact ? h.startLine! + end : h.endLine
  }
}

export function citationOf(path: string, o: { startLine: number | null; endLine: number | null; page: number | null }): string {
  if (o.page) return `${path}#page=${o.page}`
  if (o.startLine) return `${path}#L${o.startLine}${o.endLine && o.endLine !== o.startLine ? `-L${o.endLine}` : ''}`
  return path
}

function toHit(h: ChunkHit, query: string, score: number): KnowledgeHit {
  const s = snippetOf(h, query)
  return {
    path: h.path,
    citation: citationOf(h.path, { startLine: s.startLine, endLine: s.endLine, page: h.page }),
    heading: h.heading,
    page: h.page,
    startLine: s.startLine,
    endLine: s.endLine,
    snippet: s.text,
    score: Math.round(score * 10000) / 10000,
    modified: h.mtime,
    kind: h.kind
  }
}
