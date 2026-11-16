import { randomUUID } from 'node:crypto'
import type { Db } from './db'
import { digest } from './agent/runtime/store'
import type { Embedder } from './knowledge/embeddings'
import { rankBm25, termFreq, tokenize, rrf } from './knowledge/rank'
import { fuzzyScore, type MemoryStore } from './memory'

type Row = Record<string, unknown>
export interface RecallHit { id: string; kind: 'memory' | 'chat' | 'file' | 'vault'; text: string; score: number; at: number; source: { threadId?: string; messageId?: string; memoryId?: string; path?: string }; quoted: boolean }
export interface PreferenceConditions { task?: string; audience?: string; application?: string; output?: string }
export interface ConditionalPreference { id: string; key: string; value: string; scope: 'global' | 'bot' | 'project'; scopeId: string | null; conditions: PreferenceConditions; confidence: number; at: number; evidence: string }
export interface ProjectItem { id: string; key: string; text: string; kind: 'requirement' | 'decision' | 'question' | 'artifact' | 'next'; version: number; dependencies: string[]; stale: boolean; quoted: boolean; at: number }
export interface Experience { id: string; task: string; procedure: string; model: string; environment: string; successes: number; failures: number; verified: boolean; at: number }

/** Cross-chat state uses the same bot/project boundaries as the original memory store. */
export class MemorySystem {
  constructor(readonly db: Db, readonly memory: MemoryStore, readonly now: () => number = Date.now) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT NOT NULL, model TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(id,model));
      CREATE TABLE IF NOT EXISTS memory_preferences (
        id TEXT PRIMARY KEY, key TEXT NOT NULL, value TEXT NOT NULL, scope TEXT NOT NULL,
        scope_id TEXT REFERENCES spaces(id) ON DELETE CASCADE, conditions TEXT NOT NULL, confidence REAL NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS project_state (
        id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, version INTEGER NOT NULL, dependencies TEXT NOT NULL,
        stale INTEGER NOT NULL DEFAULT 0, quoted INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, UNIQUE(space_id,key));
      CREATE TABLE IF NOT EXISTS project_state_history (
        id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES project_state(id) ON DELETE CASCADE, snapshot TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_experiences (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, task TEXT NOT NULL, procedure TEXT NOT NULL,
        model TEXT NOT NULL, environment TEXT NOT NULL, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, UNIQUE(thread_id,procedure,environment));
    `)
    memory.onRemove?.((m) => db.sql.prepare('DELETE FROM memory_vectors WHERE id=?').run(`memory:${m.id}`))
    db.sql.exec(`CREATE TRIGGER IF NOT EXISTS memory_vectors_forget_chat AFTER DELETE ON messages BEGIN DELETE FROM memory_vectors WHERE id LIKE 'chat:' || OLD.id || ':%'; END;`)
  }

  async recall(query: string, spaceId: string | null, o: { limit?: number; embedder?: Embedder | null; signal?: AbortSignal; extra?: RecallHit[] } = {}): Promise<RecallHit[]> {
    if (!this.memory.enabled) return []
    const pool: RecallHit[] = this.memory.list(spaceId).map((m) => ({ id: `memory:${m.id}`, kind: 'memory', text: m.content, score: 0, at: m.updatedAt, source: { memoryId: m.id }, quoted: m.provenance === 'untrusted' }))
    // Read exact passages, never another bot's private chats; no hidden reminders or tool output.
    const rows = this.db.sql.prepare(`SELECT m.id,m.thread_id,m.content,m.created_at,m.data FROM messages m JOIN threads t ON t.id=m.thread_id
      WHERE t.space_id=? AND m.role IN ('user','assistant') AND m.kind='normal' AND m.status='done' ORDER BY m.created_at DESC LIMIT 1200`).all(spaceId ?? '') as Row[]
    for (const r of rows) {
      const data = JSON.parse(String(r.data)) as { meta?: Record<string, unknown> }
      if (data.meta?.hidden || data.meta?.superseded || data.meta?.helperTask || data.meta?.fromApp) continue
      const content = String(r.content)
      for (let start = 0; start < Math.min(content.length, 16_000); start += 1600) pool.push({ id: `chat:${r.id}:${start}`, kind: 'chat', text: content.slice(start, start + 2000), score: 0, at: Number(r.created_at), source: { threadId: String(r.thread_id), messageId: String(r.id) }, quoted: true })
    }
    pool.push(...(o.extra ?? []))
    if (!query.trim() || !pool.length) return []
    const docs = pool.map((h, id) => { const ts = tokenize(h.text); return { id, tf: termFreq(ts), length: ts.length } })
    const lexical = rankBm25(query, docs).map((x) => x.id)
    let semantic: number[] = []
    const embedder = o.embedder
    if (embedder) {
      try {
        // Persist only vectors + hashes; originals always come from live, permission-filtered sources.
        const candidates = [...new Set([...lexical.slice(0, 24), ...pool.map((_, i) => i).slice(0, 96)])]
        const vectors = new Map<number, Float32Array>()
        const missing: number[] = []
        for (const i of candidates) {
          const r = this.db.sql.prepare('SELECT vector FROM memory_vectors WHERE id=? AND model=? AND hash=?').get(pool[i].id, embedder.model, digest(pool[i].text)) as Row | undefined
          if (r) vectors.set(i, Float32Array.from(JSON.parse(String(r.vector)))); else missing.push(i)
        }
        for (let j = 0; j < Math.min(96, missing.length); j += 16) {
          if (o.signal?.aborted) throw new Error('Recall stopped')
          const ids = missing.slice(j, j + 16)
          const vs = await embedder.embed(ids.map((i) => pool[i].text), 'document', o.signal)
          ids.forEach((i, k) => {
            if (!vs[k]?.length) return
            vectors.set(i, vs[k]); this.db.sql.prepare('INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?)').run(pool[i].id, embedder.model, digest(pool[i].text), JSON.stringify(Array.from(vs[k])))
          })
        }
        const [q] = await embedder.embed([query], 'query', o.signal)
        semantic = [...vectors].map(([i, v]) => ({ i, score: cosine(q, v) })).filter((x) => x.score > 0.25).sort((a, b) => b.score - a.score).map((x) => x.i)
      } catch { /* Keyword recall remains available when local embeddings are unavailable. */ }
    }
    const fused = rrf([lexical, semantic].filter((x) => x.length))
    const seen = new Set<string>()
    return fused.map((r) => ({ ...pool[r.id], score: r.score + 0.01 * fuzzyScore(query, pool[r.id].text) }))
      .sort((a, b) => b.score - a.score).filter((h) => { const key = digest(h.text); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, Math.max(1, Math.min(30, o.limit ?? 10)))
  }

  savePreference(p: Omit<ConditionalPreference, 'id' | 'at'>): ConditionalPreference {
    if (!this.memory.enabled) throw new Error('Memory is off.')
    if (!p.key.trim() || !p.value.trim() || !p.evidence.trim()) throw new Error('A preference needs a key, value and the user evidence.')
    const conditions = Object.fromEntries(Object.entries(p.conditions).filter(([k, v]) => ['task', 'audience', 'application', 'output'].includes(k) && typeof v === 'string' && v.length <= 120))
    const old = this.preferences().find((x) => x.key === p.key && x.scope === p.scope && x.scopeId === p.scopeId && digest(x.conditions) === digest(conditions))
    const result = { ...p, conditions, id: old?.id ?? randomUUID(), at: this.now(), confidence: Math.max(0, Math.min(1, p.confidence)) }
    this.db.sql.prepare('INSERT OR REPLACE INTO memory_preferences VALUES(?,?,?,?,?,?,?,?,?)').run(result.id, result.key.slice(0, 100), result.value.slice(0, 1000), result.scope, result.scopeId, JSON.stringify(conditions), result.confidence, result.evidence.slice(0, 1000), result.at)
    return result
  }
  preferences(): ConditionalPreference[] {
    return (this.db.sql.prepare('SELECT * FROM memory_preferences ORDER BY at DESC').all() as Row[]).map((r) => ({ id: String(r.id), key: String(r.key), value: String(r.value), scope: r.scope as ConditionalPreference['scope'], scopeId: r.scope_id as string | null, conditions: JSON.parse(String(r.conditions)), confidence: Number(r.confidence), evidence: String(r.evidence), at: Number(r.at) }))
  }
  resolvePreferences(spaceId: string | null, context: PreferenceConditions, explicit: Record<string, string> = {}): Array<{ key: string; value: string; why: string; id?: string }> {
    if (!this.memory.enabled) return []
    const eligible = this.preferences().filter((p) => (p.scope === 'global' || p.scopeId === spaceId) && p.confidence >= 0.75 && Object.entries(p.conditions).every(([k, v]) => (context[k as keyof PreferenceConditions] ?? '').toLowerCase() === String(v).toLowerCase()))
    const weight = (p: ConditionalPreference): number => ({ global: 0, bot: 10, project: 20 }[p.scope]) + Object.keys(p.conditions).length
    eligible.sort((a, b) => weight(b) - weight(a) || b.at - a.at)
    const picked = new Map<string, { key: string; value: string; why: string; id?: string }>()
    Object.entries(explicit).forEach(([key, value]) => picked.set(key, { key, value, why: 'explicit instruction for this request' }))
    for (const p of eligible) if (!picked.has(p.key)) picked.set(p.key, { key: p.key, value: p.value, why: `${p.scope} preference; ${JSON.stringify(p.conditions)}; user evidence: ${p.evidence}`, id: p.id })
    return [...picked.values()]
  }
  forgetPreference(id: string, spaceId: string | null): boolean { return Number(this.db.sql.prepare("DELETE FROM memory_preferences WHERE id=? AND (scope='global' OR scope_id=?)").run(id, spaceId).changes) > 0 }

  project(spaceId: string): ProjectItem[] {
    return (this.db.sql.prepare('SELECT * FROM project_state WHERE space_id=? ORDER BY at,rowid').all(spaceId) as Row[]).map((r) => ({ id: String(r.id), key: String(r.key), text: String(r.text), kind: r.kind as ProjectItem['kind'], version: Number(r.version), dependencies: JSON.parse(String(r.dependencies)), stale: !!r.stale, quoted: !!r.quoted, at: Number(r.at) }))
  }
  putProject(spaceId: string, item: Omit<ProjectItem, 'id' | 'version' | 'stale' | 'at'>): ProjectItem {
    if (!this.memory.enabled) throw new Error('Memory is off.')
    if (!item.key.trim() || !item.text.trim() || item.text.length > 8000) throw new Error('Project items need a key and 1–8000 characters of text.')
    const all = this.project(spaceId), old = all.find((x) => x.key === item.key)
    if (item.dependencies.includes(item.key) || item.dependencies.some((key) => !all.some((x) => x.key === key))) throw new Error('Dependencies must name existing, different project keys.')
    const reaches = (key: string, seen = new Set<string>()): boolean => { if (key === item.key) return true; if (seen.has(key)) return false; seen.add(key); return (all.find((x) => x.key === key)?.dependencies ?? []).some((k) => reaches(k, seen)) }
    if (item.dependencies.some((key) => reaches(key))) throw new Error('Project dependencies would form a cycle.')
    if (old && old.text === item.text && digest(old.dependencies) === digest(item.dependencies) && old.quoted === item.quoted) return old
    const next: ProjectItem = { ...item, id: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, stale: false, at: this.now() }
    this.db.sql.exec('BEGIN IMMEDIATE')
    try {
      if (old) this.db.sql.prepare('INSERT INTO project_state_history VALUES(?,?,?,?)').run(randomUUID(), old.id, JSON.stringify(old), this.now())
      this.db.sql.prepare(`INSERT INTO project_state VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(space_id,key) DO UPDATE SET kind=excluded.kind,text=excluded.text,version=excluded.version,dependencies=excluded.dependencies,stale=0,quoted=excluded.quoted,at=excluded.at`).run(next.id, spaceId, next.key, next.kind, next.text, next.version, JSON.stringify(next.dependencies), 0, next.quoted ? 1 : 0, next.at)
      const stale = new Set([item.key])
      for (let changed = true; changed;) { changed = false; for (const x of all) if (!stale.has(x.key) && x.dependencies.some((k) => stale.has(k))) { stale.add(x.key); changed = true } }
      for (const key of stale) if (key !== item.key) this.db.sql.prepare('UPDATE project_state SET stale=1 WHERE space_id=? AND key=?').run(spaceId, key)
      this.db.sql.exec('COMMIT')
    } catch (e) { this.db.sql.exec('ROLLBACK'); throw e }
    return next
  }
  projectHistory(spaceId: string, key: string): ProjectItem[] {
    const item = this.project(spaceId).find((x) => x.key === key); if (!item) return []
    return [...(this.db.sql.prepare('SELECT snapshot FROM project_state_history WHERE item_id=? ORDER BY at').all(item.id) as Row[]).map((r) => JSON.parse(String(r.snapshot)) as ProjectItem), item]
  }
  experience(o: { threadId: string; spaceId: string; task: string; procedure: string; model: string; environment: string; verified: boolean }): void {
    if (!this.memory.enabled || !o.procedure.trim()) return
    this.db.sql.prepare(`INSERT INTO agent_experiences VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,procedure,environment) DO UPDATE SET successes=successes+excluded.successes,failures=failures+excluded.failures,verified=MAX(verified,excluded.verified),at=excluded.at`).run(randomUUID(), o.threadId, o.spaceId, o.task.slice(0, 1000), o.procedure.slice(0, 5000), o.model, o.environment.slice(0, 300), o.verified ? 1 : 0, o.verified ? 0 : 1, o.verified ? 1 : 0, this.now())
  }
  experiences(spaceId: string, query: string, environment?: string): Experience[] {
    if (!this.memory.enabled) return []
    return (this.db.sql.prepare('SELECT * FROM agent_experiences WHERE space_id=? ORDER BY at DESC LIMIT 200').all(spaceId) as Row[]).map((r) => ({ id: String(r.id), task: String(r.task), procedure: String(r.procedure), model: String(r.model), environment: String(r.environment), successes: Number(r.successes), failures: Number(r.failures), verified: !!r.verified, at: Number(r.at) }))
      .filter((x) => x.verified && (!environment || x.environment === environment) && fuzzyScore(query, x.task) > 0.25)
      .sort((a, b) => (b.successes + 1) / (b.successes + b.failures + 2) - (a.successes + 1) / (a.successes + a.failures + 2)).slice(0, 5)
  }
}
function cosine(a: Float32Array, b: Float32Array): number {
  if (!a || a.length !== b.length) return 0
  let d = 0, aa = 0, bb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2 }
  return aa && bb ? d / Math.sqrt(aa * bb) : 0
}
