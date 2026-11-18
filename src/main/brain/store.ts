import type { BrainJobLine, BrainPrompt, BrainPromptAction, BrainPromptKind, BrainSourceKind, BrainSyncRow, SourceChip } from '@shared/brain'
import type { Db } from '../db'
import { uid } from '../db'

// The brain's own tables, next to the entity graph (which holds every fact): which items were read
// (for dedupe, chips and "forget everything from <source>"), the commitments found in them, the briefs
// written about entities, Agent mode's prompts, and one ledger row per sync. Made with CREATE IF NOT
// EXISTS (like the graph) so they never collide with numbered migrations. Item text is kept only until
// it's been read by the extraction pass.

type Row = Record<string, unknown>

export interface StoredItem {
  source: string
  id: string
  kind: BrainSourceKind
  at: number
  title: string
  from: string | null
  link: string | null
  noun: string | null
  hash: string
  status: 'pending' | 'done' | 'dropped'
  reason: string | null
  /** The item as read (JSON of RawItem), while it waits for extraction. */
  raw: string | null
}

export interface StoredCommitment {
  id: string
  entityId: string | null
  who: string
  what: string
  dueAt: number | null
  dueWords: string
  owner: 'user' | 'them'
  ref: string
  status: 'open' | 'done' | 'dismissed'
  createdAt: number
}

export interface StoredBrief { entityId: string; text: string; chips: SourceChip[]; hash: string; model: string | null; at: number; edited: boolean }

export interface StoredPrompt extends BrainPrompt { ref: string; score: number; surfacedAt: number | null; snoozeUntil: number | null; answer: string | null }

export class BrainStore {
  constructor(readonly db: Db, private clock: () => number = Date.now) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS brain_items (
        source TEXT NOT NULL, item_id TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL, title TEXT NOT NULL, sender TEXT, link TEXT, noun TEXT,
        hash TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, raw TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (source, item_id));
      CREATE INDEX IF NOT EXISTS brain_items_hash ON brain_items(hash);
      CREATE INDEX IF NOT EXISTS brain_items_status ON brain_items(status, at);
      CREATE TABLE IF NOT EXISTS brain_commitments (
        id TEXT PRIMARY KEY, entity_id TEXT, who TEXT NOT NULL, what TEXT NOT NULL, due_at INTEGER, due_words TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL,
        ref TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, norm TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS brain_briefs (
        entity_id TEXT PRIMARY KEY, text TEXT NOT NULL, chips TEXT NOT NULL, hash TEXT NOT NULL, model TEXT, at INTEGER NOT NULL, edited INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS brain_prompts (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL UNIQUE, entity_id TEXT, entity_name TEXT, text TEXT NOT NULL, detail TEXT, due_at INTEGER,
        score REAL NOT NULL, actions TEXT NOT NULL, chips TEXT NOT NULL, question INTEGER NOT NULL DEFAULT 0, placeholder TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, surfaced_at INTEGER, snooze_until INTEGER, answered_at INTEGER, answer TEXT, thread_id TEXT, auto INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS brain_syncs (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, trigger TEXT NOT NULL, read INTEGER NOT NULL, kept INTEGER NOT NULL, dropped INTEGER NOT NULL, facts INTEGER NOT NULL,
        briefs INTEGER NOT NULL, prompts INTEGER NOT NULL, usd REAL NOT NULL, jobs TEXT NOT NULL, note TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS brain_syncs_at ON brain_syncs(at);`)
  }

  private now(): number { return this.clock() }

  // ---------------------------------------------------------------- items

  hasHash(hash: string): boolean { return !!this.db.sql.prepare("SELECT 1 FROM brain_items WHERE hash = ? AND status != 'dropped' LIMIT 1").get(hash) }
  hasItem(source: string, id: string): boolean { return !!this.db.sql.prepare('SELECT 1 FROM brain_items WHERE source = ? AND item_id = ?').get(source, id) }

  addItem(x: { source: string; id: string; kind: BrainSourceKind; at: number; title: string; from?: string; link?: string; noun?: string }, hash: string, status: StoredItem['status'], o: { reason?: string; raw?: string } = {}): void {
    this.db.sql.prepare('INSERT OR IGNORE INTO brain_items(source, item_id, kind, at, title, sender, link, noun, hash, status, reason, raw, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(x.source, x.id, x.kind, x.at, x.title.slice(0, 200), x.from?.slice(0, 200) ?? null, x.link ?? null, x.noun ?? null, hash, status, o.reason ?? null, o.raw ?? null, this.now())
  }

  item(source: string, id: string): StoredItem | undefined {
    const r = this.db.sql.prepare('SELECT * FROM brain_items WHERE source = ? AND item_id = ?').get(source, id) as Row | undefined
    return r ? toItem(r) : undefined
  }

  pending(limit: number, sources?: string[]): StoredItem[] {
    const rows = this.db.sql.prepare("SELECT * FROM brain_items WHERE status = 'pending' ORDER BY at DESC LIMIT ?").all(limit * 4) as Row[]
    return rows.map(toItem).filter((x) => !sources || sources.includes(x.source)).slice(0, limit)
  }

  pendingCount(): number { return Number((this.db.sql.prepare("SELECT COUNT(*) AS n FROM brain_items WHERE status = 'pending'").get() as Row).n) }

  /** Read: the text goes (the facts and the item's metadata stay). */
  markDone(source: string, id: string): void {
    this.db.sql.prepare("UPDATE brain_items SET status = 'done', raw = NULL WHERE source = ? AND item_id = ?").run(source, id)
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.db.sql.prepare("SELECT source, COUNT(*) AS n FROM brain_items WHERE status != 'dropped' GROUP BY source").all() as Row[]) out[r.source as string] = Number(r.n)
    return out
  }

  /** Everything read from a source goes: its items, commitments and the prompts about them. Returns the item refs. */
  purgeSource(source: string): void {
    const prefix = `brain:${source}:`
    const like = `${prefix.replace(/[%_]/g, (c) => `\\${c}`)}%`
    const cids = (this.db.sql.prepare("SELECT id FROM brain_commitments WHERE ref LIKE ? ESCAPE '\\'").all(like) as Row[]).map((r) => r.id as string)
    for (const id of cids) this.db.sql.prepare('DELETE FROM brain_prompts WHERE ref = ?').run(`commitment:${id}`)
    this.db.sql.prepare("DELETE FROM brain_commitments WHERE ref LIKE ? ESCAPE '\\'").run(like)
    this.db.sql.prepare('DELETE FROM brain_items WHERE source = ?').run(source)
  }

  // ---------------------------------------------------------------- commitments

  addCommitment(c: Omit<StoredCommitment, 'id' | 'status' | 'createdAt'>): { id: string; added: boolean } {
    const norm = `${c.who.toLowerCase().replace(/\s+/g, ' ')}|${c.what.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}`
    const cur = this.db.sql.prepare('SELECT id FROM brain_commitments WHERE norm = ?').get(norm) as Row | undefined
    if (cur) {
      if (c.dueAt) this.db.sql.prepare('UPDATE brain_commitments SET due_at = COALESCE(due_at, ?) WHERE id = ?').run(c.dueAt, cur.id as string)
      return { id: cur.id as string, added: false }
    }
    const id = uid()
    this.db.sql.prepare('INSERT INTO brain_commitments(id, entity_id, who, what, due_at, due_words, owner, ref, status, created_at, norm) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, c.entityId, c.who, c.what, c.dueAt ?? null, c.dueWords, c.owner, c.ref, 'open', this.now(), norm)
    return { id, added: true }
  }

  commitment(id: string): StoredCommitment | undefined {
    const r = this.db.sql.prepare('SELECT * FROM brain_commitments WHERE id = ?').get(id) as Row | undefined
    return r ? toCommitment(r) : undefined
  }

  commitments(o: { status?: StoredCommitment['status']; entityId?: string } = {}): StoredCommitment[] {
    const rows = this.db.sql.prepare('SELECT * FROM brain_commitments ORDER BY COALESCE(due_at, 9e15), created_at DESC').all() as Row[]
    return rows.map(toCommitment).filter((c) => (!o.status || c.status === o.status) && (!o.entityId || c.entityId === o.entityId))
  }

  setCommitment(id: string, status: StoredCommitment['status']): void { this.db.sql.prepare('UPDATE brain_commitments SET status = ? WHERE id = ?').run(status, id) }

  forgetEntity(entityId: string): void {
    const cids = this.commitments({ entityId }).map((c) => c.id)
    for (const id of cids) this.db.sql.prepare('DELETE FROM brain_prompts WHERE ref = ?').run(`commitment:${id}`)
    this.db.sql.prepare('DELETE FROM brain_commitments WHERE entity_id = ?').run(entityId)
    this.db.sql.prepare('DELETE FROM brain_prompts WHERE entity_id = ?').run(entityId)
    this.db.sql.prepare('DELETE FROM brain_briefs WHERE entity_id = ?').run(entityId)
  }

  // ---------------------------------------------------------------- briefs

  brief(entityId: string): StoredBrief | undefined {
    const r = this.db.sql.prepare('SELECT * FROM brain_briefs WHERE entity_id = ?').get(entityId) as Row | undefined
    return r ? toBrief(r) : undefined
  }

  briefs(): StoredBrief[] { return (this.db.sql.prepare('SELECT * FROM brain_briefs ORDER BY at DESC').all() as Row[]).map(toBrief) }

  setBrief(b: StoredBrief): void {
    this.db.sql.prepare('INSERT OR REPLACE INTO brain_briefs(entity_id, text, chips, hash, model, at, edited) VALUES(?,?,?,?,?,?,?)')
      .run(b.entityId, b.text, JSON.stringify(b.chips), b.hash, b.model, b.at, b.edited ? 1 : 0)
  }

  // ---------------------------------------------------------------- prompts

  prompt(id: string): StoredPrompt | undefined {
    const r = this.db.sql.prepare('SELECT * FROM brain_prompts WHERE id = ?').get(id) as Row | undefined
    return r ? toPrompt(r) : undefined
  }

  promptByRef(ref: string): StoredPrompt | undefined {
    const r = this.db.sql.prepare('SELECT * FROM brain_prompts WHERE ref = ?').get(ref) as Row | undefined
    return r ? toPrompt(r) : undefined
  }

  prompts(o: { status?: StoredPrompt['status'][] } = {}): StoredPrompt[] {
    return (this.db.sql.prepare('SELECT * FROM brain_prompts ORDER BY score DESC, created_at DESC').all() as Row[]).map(toPrompt).filter((p) => !o.status || o.status.includes(p.status))
  }

  addPrompt(p: { kind: BrainPromptKind; ref: string; entityId?: string; entityName?: string; text: string; detail?: string; dueAt?: number; score: number; actions: BrainPromptAction[]; chips: SourceChip[]; question?: boolean; placeholder?: string; surfaced: boolean }): StoredPrompt {
    const id = uid()
    const now = this.now()
    this.db.sql.prepare('INSERT INTO brain_prompts(id, kind, ref, entity_id, entity_name, text, detail, due_at, score, actions, chips, question, placeholder, status, created_at, surfaced_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, p.kind, p.ref, p.entityId ?? null, p.entityName ?? null, p.text, p.detail ?? null, p.dueAt ?? null, p.score, JSON.stringify(p.actions), JSON.stringify(p.chips), p.question ? 1 : 0, p.placeholder ?? null, 'open', now, p.surfaced ? now : null)
    return this.prompt(id)!
  }

  updatePrompt(id: string, patch: Partial<{ status: StoredPrompt['status']; snoozeUntil: number | null; answeredAt: number; answer: string | null; threadId: string; auto: boolean; surfacedAt: number | null }>): void {
    const cols: Record<string, string> = { status: 'status', snoozeUntil: 'snooze_until', answeredAt: 'answered_at', answer: 'answer', threadId: 'thread_id', auto: 'auto', surfacedAt: 'surfaced_at' }
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in cols)) continue
      this.db.sql.prepare(`UPDATE brain_prompts SET ${cols[k]} = ? WHERE id = ?`).run(typeof v === 'boolean' ? (v ? 1 : 0) : (v as never), id)
    }
  }

  /** Prompts that reached the user since `since` (for the daily cap). */
  surfacedSince(since: number): number {
    return Number((this.db.sql.prepare('SELECT COUNT(*) AS n FROM brain_prompts WHERE surfaced_at >= ?').get(since) as Row).n)
  }

  /** The user's past answers to each kind: accepted (draft, answer, remind) vs dismissed. */
  outcomes(): Record<BrainPromptKind, { accepted: number; dismissed: number }> {
    const out: Record<BrainPromptKind, { accepted: number; dismissed: number }> = { commitment: { accepted: 0, dismissed: 0 }, gap: { accepted: 0, dismissed: 0 } }
    for (const r of this.db.sql.prepare("SELECT kind, status, COUNT(*) AS n FROM brain_prompts WHERE status IN ('accepted','answered','dismissed','snoozed') GROUP BY kind, status").all() as Row[]) {
      const k = (r.kind as BrainPromptKind) in out ? r.kind as BrainPromptKind : 'commitment'
      if (r.status === 'dismissed') out[k].dismissed += Number(r.n)
      else out[k].accepted += Number(r.n)
    }
    return out
  }

  // ---------------------------------------------------------------- the ledger

  addSync(r: Omit<BrainSyncRow, 'id'>): BrainSyncRow {
    const id = uid()
    this.db.sql.prepare('INSERT INTO brain_syncs(id, at, trigger, read, kept, dropped, facts, briefs, prompts, usd, jobs, note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, r.at, r.trigger, r.read, r.kept, r.dropped, r.facts, r.briefs, r.prompts, r.usd, JSON.stringify(r.jobs), r.note)
    // A year of syncs is plenty.
    this.db.sql.prepare('DELETE FROM brain_syncs WHERE at < ?').run(this.now() - 366 * 86_400_000)
    return { id, ...r }
  }

  syncs(limit = 10): BrainSyncRow[] {
    return (this.db.sql.prepare('SELECT * FROM brain_syncs ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id as string, at: Number(r.at), trigger: r.trigger === 'manual' ? 'manual' : 'schedule', read: Number(r.read), kept: Number(r.kept), dropped: Number(r.dropped),
      facts: Number(r.facts), briefs: Number(r.briefs), prompts: Number(r.prompts), usd: Number(r.usd), jobs: parse<BrainJobLine[]>(r.jobs, []), note: String(r.note)
    }))
  }

  /** Brain spend since `since` (local midnight for "today"). */
  spentSince(since: number): number {
    return Number((this.db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM brain_syncs WHERE at >= ?').get(since) as Row).s)
  }
}

const parse = <T>(v: unknown, def: T): T => { try { return JSON.parse(String(v)) as T } catch { return def } }

const toItem = (r: Row): StoredItem => ({
  source: r.source as string, id: r.item_id as string, kind: r.kind as BrainSourceKind, at: Number(r.at), title: r.title as string, from: (r.sender as string | null) ?? null,
  link: (r.link as string | null) ?? null, noun: (r.noun as string | null) ?? null, hash: r.hash as string, status: r.status as StoredItem['status'], reason: (r.reason as string | null) ?? null, raw: (r.raw as string | null) ?? null
})

const toCommitment = (r: Row): StoredCommitment => ({
  id: r.id as string, entityId: (r.entity_id as string | null) ?? null, who: r.who as string, what: r.what as string, dueAt: r.due_at === null || r.due_at === undefined ? null : Number(r.due_at),
  dueWords: String(r.due_words ?? ''), owner: r.owner === 'them' ? 'them' : 'user', ref: r.ref as string, status: r.status as StoredCommitment['status'], createdAt: Number(r.created_at)
})

const toBrief = (r: Row): StoredBrief => ({ entityId: r.entity_id as string, text: r.text as string, chips: parse<SourceChip[]>(r.chips, []), hash: r.hash as string, model: (r.model as string | null) ?? null, at: Number(r.at), edited: !!r.edited })

const toPrompt = (r: Row): StoredPrompt => ({
  id: r.id as string, kind: r.kind as BrainPromptKind, ref: r.ref as string, entityId: (r.entity_id as string | null) ?? undefined, entityName: (r.entity_name as string | null) ?? undefined,
  text: r.text as string, detail: (r.detail as string | null) ?? undefined, dueAt: r.due_at === null || r.due_at === undefined ? undefined : Number(r.due_at), score: Number(r.score),
  actions: parse<BrainPromptAction[]>(r.actions, []), chips: parse<SourceChip[]>(r.chips, []), question: !!r.question, placeholder: (r.placeholder as string | null) ?? undefined,
  status: r.status as StoredPrompt['status'], createdAt: Number(r.created_at), surfacedAt: r.surfaced_at === null || r.surfaced_at === undefined ? null : Number(r.surfaced_at),
  snoozeUntil: r.snooze_until === null || r.snooze_until === undefined ? null : Number(r.snooze_until), answer: (r.answer as string | null) ?? null,
  threadId: (r.thread_id as string | null) ?? undefined, auto: !!r.auto
})
