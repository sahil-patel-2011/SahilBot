import { createHash } from 'node:crypto'
import type { AliasKind, EntityAttribute, EntityMention, EntityRelation, EntityType, FactSource, RelationType, SourceKind, Trust } from '@shared/context-engine'
import { ENTITY_TYPES, RELATION_TYPES } from '@shared/context-engine'
import type { Db } from '../db'
import { uid } from '../db'
import { nameMatch, normAlias, normName } from './resolve'

// The entity graph in SQLite. Tables are made here (CREATE IF NOT EXISTS, like the learning log) so they
// never collide with numbered migrations. "Forget" purges an entity's rows from the active tables and
// keeps one JSON snapshot in ce_trash for Undo (30 days, then it's gone too). Facts the user removed
// are remembered only as hashes (ce_rejected), so extraction doesn't add them back.

export interface StoredEntity {
  id: string
  type: EntityType
  name: string
  isUser: boolean
  trust: Trust
  confidence: number
  createdAt: number
  updatedAt: number
  lastSeen: number
  mentions: number
  /** null = every bot sees it; a bot id = only that bot (built from quoted facts in its chats). */
  scope: string | null
  vaultPath: string | null
}

export interface StoredAttribute extends EntityAttribute { entityId: string; category: string | null }
export interface StoredRelation { id: string; fromId: string; rel: RelationType; toId: string; trust: Trust; confidence: number; source: FactSource; at: number; note?: string; scope: string | null }

export interface NewAttribute {
  key: string
  value: string
  trust: Trust
  confidence: number
  source: FactSource
  at: number
  scope?: string | null
  corrected?: boolean
  category?: string | null
}

export const TRUST_RANK: Record<Trust, number> = { quoted: 0, observed: 1, user: 2 }
export const DAY = 86_400_000
const TRASH_DAYS = 30

/** Keys that hold one value at a time (a newer, stronger value replaces the old one). */
export const SINGLE_KEYS = new Set(['birthday', 'anniversary', 'date', 'when', 'start', 'end', 'relationship', 'role', 'title', 'age', 'address', 'timezone', 'status', 'kind', 'cuisine', 'due', 'deadline'])

const KEY_ALIAS: Record<string, string> = {
  bday: 'birthday', 'birth day': 'birthday', born: 'birthday', dob: 'birthday', 'date of birth': 'birthday',
  loves: 'likes', love: 'likes', like: 'likes', enjoys: 'likes', favorite: 'likes', favourite: 'likes', favorites: 'likes', 'is into': 'likes', interests: 'likes', interest: 'likes', hobby: 'likes', hobbies: 'likes',
  hates: 'dislikes', dislike: 'dislikes', 'does not like': 'dislikes', "doesn't like": 'dislikes',
  relation: 'relationship', 'relationship to user': 'relationship', relationship_to_user: 'relationship',
  job: 'role', occupation: 'role', 'job title': 'role', position: 'role', profession: 'role',
  'phone number': 'phone', mobile: 'phone', cell: 'phone', 'e-mail': 'email', mail: 'email',
  location: 'where', place: 'where', venue: 'where', time: 'when', datetime: 'when', 'start time': 'when',
  type: 'kind', category: 'kind', notes: 'note', description: 'note', summary: 'note', detail: 'note', details: 'note',
  'time zone': 'timezone', tz: 'timezone', 'home address': 'address'
}

export function normKey(k: string): string {
  const s = k.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (KEY_ALIAS[s] ?? s).replace(/\s+/g, '_').slice(0, 40) || 'note'
}

export const normValue = (v: string): string => normName(v).replace(/^(the|a|an) /, '')

/** A rejected fact's key: a hash of the entity's name, the key and the value (never the words). */
export function rejectHash(entityName: string, key: string, value: string): string {
  return createHash('sha256').update(`${normName(entityName)}|${normKey(key)}|${normValue(value)}`).digest('hex').slice(0, 32)
}

type Row = Record<string, unknown>

const src = (r: Row, p = 'source'): FactSource => ({
  kind: (r[`${p}_kind`] as SourceKind) ?? 'chat',
  ...(r[`${p}_ref`] ? { ref: r[`${p}_ref`] as string } : {}),
  ...(r[`${p}_label`] ? { label: r[`${p}_label`] as string } : {}),
  ...(r[`${p}_link`] ? { link: r[`${p}_link`] as string } : {})
})

const toEntity = (r: Row): StoredEntity => ({
  id: r.id as string, type: (ENTITY_TYPES.includes(r.type as EntityType) ? r.type : 'topic') as EntityType, name: r.name as string, isUser: !!r.is_user,
  trust: (r.trust as Trust) ?? 'observed', confidence: Number(r.confidence ?? 0.5), createdAt: r.created_at as number, updatedAt: r.updated_at as number,
  lastSeen: Number(r.last_seen ?? r.updated_at), mentions: Number(r.mentions ?? 0), scope: (r.scope as string | null) ?? null, vaultPath: (r.vault_path as string | null) ?? null
})

const toAttr = (r: Row): StoredAttribute => ({
  id: r.id as string, entityId: r.entity_id as string, key: r.key as string, value: r.value as string, trust: r.trust as Trust, confidence: Number(r.confidence),
  source: src(r), at: r.at as number, updatedAt: r.updated_at as number, corrected: !!r.corrected, scope: (r.scope as string | null) ?? null, category: (r.category as string | null) ?? null
})

const toRel = (r: Row): StoredRelation => ({
  id: r.id as string, fromId: r.from_id as string, rel: (RELATION_TYPES.includes(r.rel as RelationType) ? r.rel : 'related_to') as RelationType, toId: r.to_id as string,
  trust: r.trust as Trust, confidence: Number(r.confidence), source: src(r), at: r.at as number, ...(r.note ? { note: r.note as string } : {}), scope: (r.scope as string | null) ?? null
})

/** Two confidences that agree: stronger together (capped). */
const combine = (a: number, b: number): number => Math.min(0.98, 1 - (1 - a) * (1 - b))

export interface EntitySnapshot {
  entity: Row
  aliases: Row[]
  attributes: Row[]
  relations: Row[]
  mentions: Row[]
  /** Merged into another entity: that entity's id (Undo splits them again). */
  mergedInto?: string
  /** For a merge: the aliases, attributes, relations and mentions moved onto `mergedInto`. */
  moved?: { aliases: Row[]; attributes: string[]; relations: string[]; mentions: number[] }
}

export class GraphStore {
  private ver = 0
  private listeners = new Set<() => void>()

  constructor(readonly db: Db, private clock: () => number = Date.now) {
    db.sql.exec(`
      CREATE TABLE IF NOT EXISTS ce_entities (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, is_user INTEGER NOT NULL DEFAULT 0, trust TEXT NOT NULL DEFAULT 'observed',
        confidence REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, mentions INTEGER NOT NULL DEFAULT 0,
        scope TEXT, vault_path TEXT);
      CREATE TABLE IF NOT EXISTS ce_aliases (
        entity_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, norm TEXT NOT NULL, source TEXT, PRIMARY KEY (entity_id, kind, norm));
      CREATE INDEX IF NOT EXISTS ce_aliases_norm ON ce_aliases(kind, norm);
      CREATE TABLE IF NOT EXISTS ce_attributes (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, vnorm TEXT NOT NULL, trust TEXT NOT NULL, confidence REAL NOT NULL,
        source_kind TEXT NOT NULL, source_ref TEXT, source_label TEXT, source_link TEXT, at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        corrected INTEGER NOT NULL DEFAULT 0, scope TEXT, category TEXT);
      CREATE INDEX IF NOT EXISTS ce_attributes_entity ON ce_attributes(entity_id);
      CREATE INDEX IF NOT EXISTS ce_attributes_source ON ce_attributes(source_kind, source_ref);
      CREATE TABLE IF NOT EXISTS ce_attribute_history (
        id TEXT PRIMARY KEY, entity_id TEXT NOT NULL REFERENCES ce_entities(id) ON DELETE CASCADE,
        key TEXT NOT NULL, snapshot TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ce_attribute_history_entity ON ce_attribute_history(entity_id, key, valid_from);
      CREATE TABLE IF NOT EXISTS ce_relations (
        id TEXT PRIMARY KEY, from_id TEXT NOT NULL, rel TEXT NOT NULL, to_id TEXT NOT NULL, trust TEXT NOT NULL, confidence REAL NOT NULL,
        source_kind TEXT NOT NULL, source_ref TEXT, source_label TEXT, source_link TEXT, at INTEGER NOT NULL, created_at INTEGER NOT NULL, note TEXT, scope TEXT);
      CREATE INDEX IF NOT EXISTS ce_relations_from ON ce_relations(from_id);
      CREATE INDEX IF NOT EXISTS ce_relations_to ON ce_relations(to_id);
      CREATE TABLE IF NOT EXISTS ce_mentions (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, at INTEGER NOT NULL, source_kind TEXT NOT NULL, source_ref TEXT, source_label TEXT, source_link TEXT,
        snippet TEXT NOT NULL, trust TEXT NOT NULL, scope TEXT);
      CREATE INDEX IF NOT EXISTS ce_mentions_entity ON ce_mentions(entity_id, at DESC);
      CREATE TABLE IF NOT EXISTS ce_trash (id TEXT PRIMARY KEY, at INTEGER NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL, restored_at INTEGER);
      CREATE TABLE IF NOT EXISTS ce_rejected (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ce_distinct (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b));
      CREATE TRIGGER IF NOT EXISTS ce_forget_thread AFTER DELETE ON threads BEGIN
        DELETE FROM ce_mentions WHERE source_kind = 'chat' AND source_ref = OLD.id;
        DELETE FROM ce_attributes WHERE source_kind = 'chat' AND source_ref = OLD.id AND corrected = 0;
        DELETE FROM ce_relations WHERE source_kind = 'chat' AND source_ref = OLD.id; END;`)
    this.purgeTrash()
  }

  private now(): number { return this.clock() }

  /** Bumps on every write (the context cache keys on it). */
  get version(): number { return this.ver }

  onChange(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }

  private touch(): void {
    this.ver++
    for (const cb of this.listeners) { try { cb() } catch { /* a listener never blocks a write */ } }
  }

  private tx<T>(fn: () => T): T {
    this.db.sql.exec('SAVEPOINT ce')
    try { const r = fn(); this.db.sql.exec('RELEASE ce'); return r } catch (e) { this.db.sql.exec('ROLLBACK TO ce'); this.db.sql.exec('RELEASE ce'); throw e }
  }

  // ---------------------------------------------------------------- entities

  entity(id: string): StoredEntity | undefined {
    const r = this.db.sql.prepare('SELECT * FROM ce_entities WHERE id = ?').get(id) as Row | undefined
    return r ? toEntity(r) : undefined
  }

  entities(o: { type?: EntityType } = {}): StoredEntity[] {
    const rows = (o.type
      ? this.db.sql.prepare('SELECT * FROM ce_entities WHERE type = ? ORDER BY last_seen DESC').all(o.type)
      : this.db.sql.prepare('SELECT * FROM ce_entities ORDER BY last_seen DESC').all()) as Row[]
    return rows.map(toEntity)
  }

  /** The user's own entity ("You"), made on first use. */
  userEntity(name = 'You'): StoredEntity {
    const r = this.db.sql.prepare('SELECT * FROM ce_entities WHERE is_user = 1 LIMIT 1').get() as Row | undefined
    if (r) {
      const e = toEntity(r)
      if (name && name !== 'You' && e.name === 'You') { this.db.sql.prepare('UPDATE ce_entities SET name = ? WHERE id = ?').run(name, e.id); this.addAlias(e.id, 'name', name, 'you'); return { ...e, name } }
      return e
    }
    const e = this.create('person', name || 'You', { trust: 'user', confidence: 1, isUser: true })
    return e
  }

  create(type: EntityType, name: string, o: { trust: Trust; confidence: number; at?: number; isUser?: boolean; scope?: string | null }): StoredEntity {
    const now = this.now()
    const at = Math.min(o.at ?? now, now)
    const id = uid()
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120)
    this.db.sql.prepare('INSERT INTO ce_entities(id, type, name, is_user, trust, confidence, created_at, updated_at, last_seen, mentions, scope) VALUES(?,?,?,?,?,?,?,?,?,0,?)')
      .run(id, type, clean, o.isUser ? 1 : 0, o.trust, o.confidence, now, now, at, o.scope ?? null)
    this.addAlias(id, 'name', clean, o.trust)
    this.touch()
    return this.entity(id)!
  }

  rename(id: string, name: string): void {
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!clean) return
    this.db.sql.prepare('UPDATE ce_entities SET name = ?, updated_at = ? WHERE id = ?').run(clean, this.now(), id)
    this.addAlias(id, 'name', clean, 'you')
    this.touch()
  }

  setType(id: string, type: EntityType): void {
    this.db.sql.prepare('UPDATE ce_entities SET type = ?, updated_at = ? WHERE id = ?').run(type, this.now(), id)
    this.touch()
  }

  setVaultPath(id: string, path: string | null): void {
    this.db.sql.prepare('UPDATE ce_entities SET vault_path = ? WHERE id = ?').run(path, id)
  }

  /** Seen again: last-seen, mention count, the stronger trust, a shared scope wins over a bot's own. */
  seen(id: string, o: { at: number; trust: Trust; confidence: number; scope: string | null }): void {
    const e = this.entity(id)
    if (!e) return
    const trust = TRUST_RANK[o.trust] > TRUST_RANK[e.trust] ? o.trust : e.trust
    const scope = e.scope === null || o.scope === null ? null : e.scope === o.scope ? e.scope : null
    this.db.sql.prepare('UPDATE ce_entities SET last_seen = MAX(last_seen, ?), mentions = mentions + 1, trust = ?, confidence = ?, scope = ?, updated_at = ? WHERE id = ?')
      .run(Math.min(o.at, this.now()), trust, combine(e.confidence, o.confidence * 0.5), scope, this.now(), id)
  }

  // ---------------------------------------------------------------- aliases

  aliases(id: string): Array<{ kind: AliasKind; value: string; norm: string }> {
    return (this.db.sql.prepare('SELECT kind, value, norm FROM ce_aliases WHERE entity_id = ? ORDER BY rowid').all(id) as Row[]).map((r) => ({ kind: r.kind as AliasKind, value: r.value as string, norm: r.norm as string }))
  }

  allAliases(): Array<{ entityId: string; kind: AliasKind; value: string; norm: string }> {
    return (this.db.sql.prepare('SELECT entity_id, kind, value, norm FROM ce_aliases').all() as Row[]).map((r) => ({ entityId: r.entity_id as string, kind: r.kind as AliasKind, value: r.value as string, norm: r.norm as string }))
  }

  addAlias(id: string, kind: AliasKind, value: string, source = 'observed'): boolean {
    const v = value.replace(/\s+/g, ' ').trim().slice(0, 160)
    const norm = normAlias(kind, v)
    if (!norm || (kind === 'phone' && norm.length < 7)) return false
    const r = this.db.sql.prepare('INSERT OR IGNORE INTO ce_aliases(entity_id, kind, value, norm, source) VALUES(?,?,?,?,?)').run(id, kind, v, norm, source)
    if (Number(r.changes) > 0) { this.touch(); return true }
    return false
  }

  removeAlias(id: string, kind: AliasKind, value: string): void {
    this.db.sql.prepare('DELETE FROM ce_aliases WHERE entity_id = ? AND kind = ? AND norm = ?').run(id, kind, normAlias(kind, value))
    this.touch()
  }

  byAlias(kind: AliasKind, value: string): StoredEntity[] {
    const rows = this.db.sql.prepare('SELECT DISTINCT e.* FROM ce_aliases a JOIN ce_entities e ON e.id = a.entity_id WHERE a.kind = ? AND a.norm = ?').all(kind, normAlias(kind, value)) as Row[]
    return rows.map(toEntity)
  }

  /** The user said these two are different: never merged automatically. */
  markDistinct(a: string, b: string): void {
    const [x, y] = a < b ? [a, b] : [b, a]
    this.db.sql.prepare('INSERT OR IGNORE INTO ce_distinct(a, b) VALUES(?, ?)').run(x, y)
  }

  isDistinct(a: string, b: string): boolean {
    const [x, y] = a < b ? [a, b] : [b, a]
    return !!this.db.sql.prepare('SELECT 1 FROM ce_distinct WHERE a = ? AND b = ?').get(x, y)
  }

  /**
   * The existing entity a mention names, or undefined. Emails, phones and handles decide first (exact);
   * then names among entities of a compatible type. A bare first name only resolves when exactly one
   * person has it; a weak match never merges two people with different last names.
   */
  resolve(c: { type: EntityType; name?: string; emails?: string[]; phones?: string[]; handles?: string[]; scope?: string | null }): { entity: StoredEntity; score: number } | undefined {
    for (const [kind, vals] of [['email', c.emails], ['phone', c.phones], ['handle', c.handles]] as Array<[AliasKind, string[] | undefined]>) {
      for (const v of vals ?? []) {
        const hit = this.byAlias(kind, v).find((e) => compatible(e.type, c.type))
        if (hit) return { entity: hit, score: 1 }
      }
    }
    if (!c.name?.trim()) return undefined
    const name = c.name
    const exact = this.byAlias('name', name).concat(this.byAlias('nickname', name)).filter((e) => compatible(e.type, c.type))
    if (exact.length === 1) return { entity: exact[0], score: 1 }
    if (exact.length > 1) return { entity: [...exact].sort((a, b) => sameType(b.type, c.type) - sameType(a.type, c.type) || b.mentions - a.mentions)[0], score: 0.95 }
    let best: { entity: StoredEntity; score: number } | undefined
    const pool = this.entities().filter((e) => compatible(e.type, c.type))
    const matches: Array<{ entity: StoredEntity; score: number }> = []
    for (const e of pool) {
      let s = 0
      for (const a of this.aliases(e.id).filter((x) => x.kind === 'name' || x.kind === 'nickname')) s = Math.max(s, nameMatch(name, a.value, c.type))
      if (s >= 0.6) matches.push({ entity: e, score: s })
    }
    matches.sort((a, b) => b.score - a.score || b.entity.mentions - a.entity.mentions)
    best = matches[0]
    if (!best) return undefined
    // A first name alone ("Priya") must point at one person only.
    if (best.score < 0.8 && matches.filter((m) => m.score >= best!.score - 0.05).length > 1) return undefined
    return best
  }

  // ---------------------------------------------------------------- attributes

  attributes(entityId: string): StoredAttribute[] {
    return (this.db.sql.prepare('SELECT * FROM ce_attributes WHERE entity_id = ? ORDER BY corrected DESC, confidence DESC, rowid').all(entityId) as Row[]).map(toAttr)
  }

  attribute(id: string): StoredAttribute | undefined {
    const r = this.db.sql.prepare('SELECT * FROM ce_attributes WHERE id = ?').get(id) as Row | undefined
    return r ? toAttr(r) : undefined
  }

  /** Attributes that came from one source (a memory, a chat, a file). */
  attributesFrom(kind: SourceKind, ref: string): StoredAttribute[] {
    return (this.db.sql.prepare('SELECT * FROM ce_attributes WHERE source_kind = ? AND source_ref = ?').all(kind, ref) as Row[]).map(toAttr)
  }

  isRejected(key: string): boolean {
    return !!this.db.sql.prepare('SELECT 1 FROM ce_rejected WHERE key = ?').get(key)
  }

  reject(key: string): void {
    this.db.sql.prepare('INSERT OR REPLACE INTO ce_rejected(key, at) VALUES(?, ?)').run(key, this.now())
  }

  /**
   * Adds a fact. The same value again strengthens it (and a stronger trust upgrades it). For one-value
   * keys (a birthday), a newer value replaces an older one of equal or lower trust; a value the user
   * set or corrected is never replaced by extraction, and a value the user removed is never re-added.
   */
  addAttribute(entityId: string, a: NewAttribute): { result: 'added' | 'strengthened' | 'replaced' | 'kept' | 'rejected'; id?: string } {
    const e = this.entity(entityId)
    if (!e) return { result: 'rejected' }
    const key = normKey(a.key)
    const value = a.value.replace(/\s+/g, ' ').trim().slice(0, 400)
    if (!value) return { result: 'rejected' }
    const vnorm = normValue(value)
    if (!a.corrected && this.isRejected(rejectHash(e.name, key, value))) return { result: 'rejected' }
    const now = this.now()
    const at = Math.min(a.at, now)
    const scope = a.scope ?? null
    const cur = this.attributes(entityId).filter((x) => x.key === key)
    const same = cur.find((x) => normValue(x.value) === vnorm && (x.scope === scope || x.scope === null))
    if (same) {
      const trust = TRUST_RANK[a.trust] > TRUST_RANK[same.trust] ? a.trust : same.trust
      const upgraded = trust !== same.trust || (a.corrected && !same.corrected)
      this.db.sql.prepare('UPDATE ce_attributes SET trust = ?, confidence = ?, updated_at = ?, corrected = ?, at = MAX(at, ?), scope = ?, ' +
        'source_kind = CASE WHEN ? THEN ? ELSE source_kind END, source_ref = CASE WHEN ? THEN ? ELSE source_ref END, source_label = CASE WHEN ? THEN ? ELSE source_label END, source_link = CASE WHEN ? THEN ? ELSE source_link END WHERE id = ?')
        .run(trust, a.corrected ? 1 : combine(same.confidence, a.confidence * 0.5), now, a.corrected || same.corrected ? 1 : 0, at, scope === null ? null : same.scope,
          upgraded ? 1 : 0, a.source.kind, upgraded ? 1 : 0, a.source.ref ?? null, upgraded ? 1 : 0, a.source.label ?? null, upgraded ? 1 : 0, a.source.link ?? null, same.id)
      this.touch()
      return { result: 'strengthened', id: same.id }
    }
    if (SINGLE_KEYS.has(key) && cur.length) {
      const visible = cur.filter((x) => x.scope === null || x.scope === scope)
      const locked = visible.find((x) => x.corrected)
      if (locked && !a.corrected) return { result: 'kept', id: locked.id }
      const stronger = visible.find((x) => TRUST_RANK[x.trust] > TRUST_RANK[a.trust] && !a.corrected)
      if (stronger) return { result: 'kept', id: stronger.id }
      // Extraction order is not chronology: an old chat/file may be indexed after a recent one.
      const newer = visible.find((x) => x.at > at && !a.corrected)
      if (newer) return { result: 'kept', id: newer.id }
      // Replace: the old value goes (the newer or the user's word wins).
      for (const x of visible) {
        this.db.sql.prepare('INSERT INTO ce_attribute_history VALUES(?,?,?,?,?,?)').run(uid(), entityId, key, JSON.stringify(x), x.at, a.corrected ? now : at)
        this.db.sql.prepare('DELETE FROM ce_attributes WHERE id = ?').run(x.id)
      }
      const id = this.insertAttr(entityId, { ...a, key, value, at }, vnorm, scope)
      this.touch()
      return { result: 'replaced', id }
    }
    const id = this.insertAttr(entityId, { ...a, key, value, at }, vnorm, scope)
    this.db.sql.prepare('UPDATE ce_entities SET updated_at = ? WHERE id = ?').run(now, entityId)
    this.touch()
    return { result: 'added', id }
  }

  private insertAttr(entityId: string, a: NewAttribute, vnorm: string, scope: string | null): string {
    const id = uid()
    const now = this.now()
    this.db.sql.prepare('INSERT INTO ce_attributes(id, entity_id, key, value, vnorm, trust, confidence, source_kind, source_ref, source_label, source_link, at, created_at, updated_at, corrected, scope, category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, entityId, a.key, a.value, vnorm, a.trust, a.corrected ? 1 : a.confidence, a.source.kind, a.source.ref ?? null, a.source.label ?? null, a.source.link ?? null, a.at, now, now, a.corrected ? 1 : 0, scope, a.category ?? null)
    return id
  }

  /** Historical values are evidence, never current instructions. Forgetting the entity purges them. */
  history(entityId: string, key?: string): Array<{ fact: StoredAttribute; validFrom: number; validTo: number | null }> {
    const old = this.db.sql.prepare('SELECT * FROM ce_attribute_history WHERE entity_id=? ORDER BY valid_from').all(entityId) as Row[]
    return [...old.map((r) => ({ fact: JSON.parse(String(r.snapshot)) as StoredAttribute, validFrom: Number(r.valid_from), validTo: Number(r.valid_to) as number | null })),
      ...this.attributes(entityId).map((fact) => ({ fact, validFrom: fact.at, validTo: null as number | null }))].filter((x) => !key || x.fact.key === normKey(key))
  }

  atTime(entityId: string, at: number): StoredAttribute[] { return this.history(entityId).filter((x) => x.validFrom <= at && (x.validTo === null || x.validTo > at)).map((x) => x.fact) }

  /** Removes a fact; `byUser` also keeps a hash so extraction never adds it back. */
  removeAttribute(id: string, byUser = true): boolean {
    const a = this.attribute(id)
    if (!a) return false
    const e = this.entity(a.entityId)
    if (byUser && e) this.reject(rejectHash(e.name, a.key, a.value))
    this.db.sql.prepare('DELETE FROM ce_attributes WHERE id = ?').run(id)
    if (byUser) this.db.sql.prepare("DELETE FROM ce_attribute_history WHERE entity_id=? AND key=?").run(a.entityId, a.key)
    this.touch()
    return true
  }

  /** Facts and mentions from a removed source (a forgotten memory, a deleted chat). */
  purgeSource(kind: SourceKind, ref: string): number {
    const n = Number(this.db.sql.prepare('DELETE FROM ce_attributes WHERE source_kind = ? AND source_ref = ?').run(kind, ref).changes)
      + Number(this.db.sql.prepare('DELETE FROM ce_relations WHERE source_kind = ? AND source_ref = ?').run(kind, ref).changes)
      + Number(this.db.sql.prepare('DELETE FROM ce_mentions WHERE source_kind = ? AND source_ref = ?').run(kind, ref).changes)
      + Number(this.db.sql.prepare("DELETE FROM ce_attribute_history WHERE json_extract(snapshot, '$.source.kind')=? AND json_extract(snapshot, '$.source.ref')=?").run(kind, ref).changes)
    if (n) this.touch()
    return n
  }

  /** Every source item under a ref prefix (all of one connected app's items: "brain:gmail:"): the entities its facts are on. */
  entitiesFromPrefix(kind: SourceKind, prefix: string): string[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const ids = new Set<string>()
    for (const r of this.db.sql.prepare("SELECT entity_id AS id FROM ce_attributes WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\' UNION SELECT entity_id AS id FROM ce_mentions WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\'").all(kind, like, kind, like) as Row[]) ids.add(r.id as string)
    for (const r of this.db.sql.prepare("SELECT from_id, to_id FROM ce_relations WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\'").all(kind, like) as Row[]) { ids.add(r.from_id as string); ids.add(r.to_id as string) }
    return [...ids]
  }

  /** Facts, relations and mentions from every item under a ref prefix (a whole source). */
  purgeSourcePrefix(kind: SourceKind, prefix: string): number {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const n = Number(this.db.sql.prepare("DELETE FROM ce_attributes WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\' AND corrected = 0").run(kind, like).changes)
      + Number(this.db.sql.prepare("DELETE FROM ce_relations WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\'").run(kind, like).changes)
      + Number(this.db.sql.prepare("DELETE FROM ce_mentions WHERE source_kind = ? AND source_ref LIKE ? ESCAPE '\\'").run(kind, like).changes)
      + Number(this.db.sql.prepare("DELETE FROM ce_attribute_history WHERE json_extract(snapshot, '$.source.kind')=? AND json_extract(snapshot, '$.source.ref') LIKE ? ESCAPE '\\'").run(kind, like).changes)
    if (n) this.touch()
    return n
  }

  /** Of these entities, the ones left with nothing (no facts, relations or mentions) and not the user's own go. Returns those removed. */
  pruneEmpty(ids: string[]): string[] {
    const gone: string[] = []
    for (const id of ids) {
      const e = this.entity(id)
      if (!e || e.isUser || e.trust === 'user') continue
      const has = this.db.sql.prepare('SELECT 1 FROM ce_attributes WHERE entity_id = ? UNION SELECT 1 FROM ce_relations WHERE from_id = ? OR to_id = ? UNION SELECT 1 FROM ce_mentions WHERE entity_id = ? LIMIT 1').get(id, id, id, id)
      if (has) continue
      this.purge(id)
      gone.push(id)
    }
    if (gone.length) this.touch()
    return gone
  }

  // ---------------------------------------------------------------- relations

  relations(entityId: string): StoredRelation[] {
    return (this.db.sql.prepare('SELECT * FROM ce_relations WHERE from_id = ? OR to_id = ? ORDER BY confidence DESC, at DESC').all(entityId, entityId) as Row[]).map(toRel)
  }

  allRelations(): StoredRelation[] {
    return (this.db.sql.prepare('SELECT * FROM ce_relations').all() as Row[]).map(toRel)
  }

  addRelation(fromId: string, rel: RelationType, toId: string, o: { trust: Trust; confidence: number; source: FactSource; at: number; note?: string; scope?: string | null }): { result: 'added' | 'strengthened' | 'rejected'; id?: string } {
    if (fromId === toId) return { result: 'rejected' }
    const from = this.entity(fromId), to = this.entity(toId)
    if (!from || !to) return { result: 'rejected' }
    if (this.isRejected(rejectHash(from.name, `rel:${rel}`, to.name))) return { result: 'rejected' }
    const cur = this.db.sql.prepare('SELECT * FROM ce_relations WHERE from_id = ? AND rel = ? AND to_id = ?').get(fromId, rel, toId) as Row | undefined
    const now = this.now()
    if (cur) {
      const c = toRel(cur)
      const trust = TRUST_RANK[o.trust] > TRUST_RANK[c.trust] ? o.trust : c.trust
      this.db.sql.prepare('UPDATE ce_relations SET trust = ?, confidence = ?, at = MAX(at, ?), note = COALESCE(note, ?), scope = CASE WHEN ? IS NULL THEN NULL ELSE scope END WHERE id = ?')
        .run(trust, combine(c.confidence, o.confidence * 0.5), Math.min(o.at, now), o.note ?? null, o.scope ?? null, c.id)
      this.touch()
      return { result: 'strengthened', id: c.id }
    }
    const id = uid()
    this.db.sql.prepare('INSERT INTO ce_relations(id, from_id, rel, to_id, trust, confidence, source_kind, source_ref, source_label, source_link, at, created_at, note, scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, fromId, rel, toId, o.trust, o.confidence, o.source.kind, o.source.ref ?? null, o.source.label ?? null, o.source.link ?? null, Math.min(o.at, now), now, o.note?.slice(0, 120) ?? null, o.scope ?? null)
    this.touch()
    return { result: 'added', id }
  }

  removeRelation(id: string, byUser = true): boolean {
    const r = this.db.sql.prepare('SELECT * FROM ce_relations WHERE id = ?').get(id) as Row | undefined
    if (!r) return false
    const rel = toRel(r)
    const a = this.entity(rel.fromId), b = this.entity(rel.toId)
    if (byUser && a && b) this.reject(rejectHash(a.name, `rel:${rel.rel}`, b.name))
    this.db.sql.prepare('DELETE FROM ce_relations WHERE id = ?').run(id)
    this.touch()
    return true
  }

  // ---------------------------------------------------------------- mentions (interaction history)

  addMention(entityId: string, m: { at: number; source: FactSource; snippet: string; trust: Trust; scope?: string | null }): void {
    const at = Math.min(m.at, this.now())
    // One per entity and source item: a chat read twice doesn't add the same line twice.
    const dup = this.db.sql.prepare('SELECT rowid FROM ce_mentions WHERE entity_id = ? AND source_kind = ? AND IFNULL(source_ref, \'\') = ? AND snippet = ?').get(entityId, m.source.kind, m.source.ref ?? '', m.snippet)
    if (dup) return
    this.db.sql.prepare('INSERT INTO ce_mentions(entity_id, at, source_kind, source_ref, source_label, source_link, snippet, trust, scope) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(entityId, at, m.source.kind, m.source.ref ?? null, m.source.label ?? null, m.source.link ?? null, m.snippet.slice(0, 300), m.trust, m.scope ?? null)
    // Each entity keeps its 40 newest.
    this.db.sql.prepare('DELETE FROM ce_mentions WHERE entity_id = ? AND rowid NOT IN (SELECT rowid FROM ce_mentions WHERE entity_id = ? ORDER BY at DESC LIMIT 40)').run(entityId, entityId)
    this.touch()
  }

  mentions(entityId: string, limit = 10): Array<EntityMention & { scope: string | null }> {
    return (this.db.sql.prepare('SELECT * FROM ce_mentions WHERE entity_id = ? ORDER BY at DESC LIMIT ?').all(entityId, limit) as Row[])
      .map((r) => ({ at: r.at as number, source: src(r), snippet: r.snippet as string, trust: r.trust as Trust, scope: (r.scope as string | null) ?? null }))
  }

  // ---------------------------------------------------------------- forget, merge, undo

  private snapshot(id: string): EntitySnapshot | undefined {
    const e = this.db.sql.prepare('SELECT * FROM ce_entities WHERE id = ?').get(id) as Row | undefined
    if (!e) return undefined
    return {
      entity: e,
      aliases: this.db.sql.prepare('SELECT * FROM ce_aliases WHERE entity_id = ?').all(id) as Row[],
      attributes: this.db.sql.prepare('SELECT * FROM ce_attributes WHERE entity_id = ?').all(id) as Row[],
      relations: this.db.sql.prepare('SELECT * FROM ce_relations WHERE from_id = ? OR to_id = ?').all(id, id) as Row[],
      mentions: this.db.sql.prepare('SELECT * FROM ce_mentions WHERE entity_id = ?').all(id) as Row[]
    }
  }

  private purge(id: string): void {
    this.db.sql.prepare('DELETE FROM ce_aliases WHERE entity_id = ?').run(id)
    this.db.sql.prepare('DELETE FROM ce_attributes WHERE entity_id = ?').run(id)
    this.db.sql.prepare('DELETE FROM ce_relations WHERE from_id = ? OR to_id = ?').run(id, id)
    this.db.sql.prepare('DELETE FROM ce_mentions WHERE entity_id = ?').run(id)
    this.db.sql.prepare('DELETE FROM ce_entities WHERE id = ?').run(id)
  }

  /**
   * "Forget everything about X": the entity, its aliases, facts, relations and mentions leave the
   * active tables at once. A snapshot stays in the trash for Undo (purged after 30 days). Its name is
   * remembered as rejected, so the same words don't rebuild it on the next pass.
   */
  forget(id: string, extra: Record<string, unknown> = {}): { trashId: string; name: string } | undefined {
    const snap = this.snapshot(id)
    if (!snap) return undefined
    const name = snap.entity.name as string
    const trashId = uid()
    this.tx(() => {
      this.db.sql.prepare('INSERT INTO ce_trash(id, at, label, payload) VALUES(?,?,?,?)').run(trashId, this.now(), `Forgot ${name}`, JSON.stringify({ ...snap, ...extra }))
      this.purge(id)
      this.reject(rejectHash(name, 'entity', snap.entity.type as string))
    })
    this.touch()
    return { trashId, name }
  }

  /** Extraction asks: did the user forget an entity of this name and type? */
  forgotten(name: string, type: EntityType): boolean {
    return this.isRejected(rejectHash(name, 'entity', type))
  }

  /**
   * Merges `fromId` into `intoId`: aliases, facts, relations and mentions move over (duplicates
   * strengthen instead), `fromId` goes. The trash keeps what moved, so Undo splits them again.
   */
  merge(intoId: string, fromId: string): { trashId: string } | undefined {
    if (intoId === fromId) return undefined
    const into = this.entity(intoId), from = this.entity(fromId)
    if (!into || !from) return undefined
    const snap = this.snapshot(fromId)!
    const trashId = uid()
    const moved: NonNullable<EntitySnapshot['moved']> = { aliases: [], attributes: [], relations: [], mentions: [] }
    this.tx(() => {
      for (const a of snap.aliases) {
        const r = this.db.sql.prepare('INSERT OR IGNORE INTO ce_aliases(entity_id, kind, value, norm, source) VALUES(?,?,?,?,?)').run(intoId, a.kind as string, a.value as string, a.norm as string, (a.source as string) ?? 'merge')
        if (Number(r.changes) > 0) moved.aliases.push(a)
      }
      for (const a of snap.attributes) {
        const at = toAttr(a)
        const r = this.addAttribute(intoId, { key: at.key, value: at.value, trust: at.trust, confidence: at.confidence, source: at.source, at: at.at, scope: at.scope, corrected: at.corrected, category: at.category })
        if (r.result === 'added' || r.result === 'replaced') moved.attributes.push(r.id!)
      }
      for (const r of snap.relations) {
        const rel = toRel(r)
        const f = rel.fromId === fromId ? intoId : rel.fromId
        const t = rel.toId === fromId ? intoId : rel.toId
        const out = this.addRelation(f, rel.rel, t, { trust: rel.trust, confidence: rel.confidence, source: rel.source, at: rel.at, note: rel.note, scope: rel.scope })
        if (out.result === 'added') moved.relations.push(out.id!)
      }
      for (const m of snap.mentions) {
        const r = this.db.sql.prepare('INSERT INTO ce_mentions(entity_id, at, source_kind, source_ref, source_label, source_link, snippet, trust, scope) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(intoId, m.at as number, m.source_kind as string, (m.source_ref as string) ?? null, (m.source_label as string) ?? null, (m.source_link as string) ?? null, m.snippet as string, m.trust as string, (m.scope as string) ?? null)
        moved.mentions.push(Number(r.lastInsertRowid))
      }
      this.db.sql.prepare('UPDATE ce_entities SET mentions = mentions + ?, last_seen = MAX(last_seen, ?), updated_at = ?, scope = CASE WHEN ? IS NULL THEN NULL ELSE scope END WHERE id = ?')
        .run(from.mentions, from.lastSeen, this.now(), from.scope, intoId)
      this.db.sql.prepare('INSERT INTO ce_trash(id, at, label, payload) VALUES(?,?,?,?)').run(trashId, this.now(), `Merged ${from.name} into ${into.name}`, JSON.stringify({ ...snap, mergedInto: intoId, moved }))
      this.purge(fromId)
    })
    this.touch()
    return { trashId }
  }

  trash(limit = 30): Array<{ id: string; at: number; label: string }> {
    return (this.db.sql.prepare('SELECT id, at, label FROM ce_trash WHERE restored_at IS NULL ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({ id: r.id as string, at: r.at as number, label: r.label as string }))
  }

  trashPayload(id: string): (EntitySnapshot & { vault?: { path: string; movedTo?: string; changeId?: string; created?: boolean } }) | undefined {
    const r = this.db.sql.prepare('SELECT payload FROM ce_trash WHERE id = ? AND restored_at IS NULL').get(id) as Row | undefined
    if (!r) return undefined
    try { return JSON.parse(r.payload as string) as EntitySnapshot & { vault?: { path: string; movedTo?: string; changeId?: string; created?: boolean } } } catch { return undefined }
  }

  /** Undo a forget or a merge: the entity's rows come back as they were. Returns its id. */
  restore(trashId: string): string | undefined {
    const snap = this.trashPayload(trashId)
    if (!snap) return undefined
    const id = snap.entity.id as string
    if (this.entity(id)) throw new Error('That entity is already back.')
    this.tx(() => {
      if (snap.mergedInto && snap.moved) {
        // Split: what moved onto the other entity leaves it again.
        for (const a of snap.moved.aliases) this.db.sql.prepare('DELETE FROM ce_aliases WHERE entity_id = ? AND kind = ? AND norm = ?').run(snap.mergedInto, a.kind as string, a.norm as string)
        for (const aid of snap.moved.attributes) this.db.sql.prepare('DELETE FROM ce_attributes WHERE id = ?').run(aid)
        for (const rid of snap.moved.relations) this.db.sql.prepare('DELETE FROM ce_relations WHERE id = ?').run(rid)
        for (const mid of snap.moved.mentions) this.db.sql.prepare('DELETE FROM ce_mentions WHERE rowid = ?').run(mid)
        this.markDistinct(id, snap.mergedInto)
      }
      const ins = (table: string, row: Row): void => {
        const cols = Object.keys(row).filter((c) => c !== 'rowid')
        this.db.sql.prepare(`INSERT OR IGNORE INTO ${table}(${cols.join(', ')}) VALUES(${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c] as never))
      }
      ins('ce_entities', snap.entity)
      for (const r of snap.aliases) ins('ce_aliases', r)
      for (const r of snap.attributes) ins('ce_attributes', r)
      // Relations to entities that are gone since stay out.
      for (const r of snap.relations) if (this.entity(r.from_id as string) && this.entity(r.to_id as string)) ins('ce_relations', r)
      for (const r of snap.mentions) ins('ce_mentions', r)
      this.db.sql.prepare('UPDATE ce_trash SET restored_at = ? WHERE id = ?').run(this.now(), trashId)
      this.db.sql.prepare('DELETE FROM ce_rejected WHERE key = ?').run(rejectHash(snap.entity.name as string, 'entity', snap.entity.type as string))
    })
    this.touch()
    return id
  }

  private purgeTrash(): void {
    try { this.db.sql.prepare('DELETE FROM ce_trash WHERE at < ? OR (restored_at IS NOT NULL AND restored_at < ?)').run(this.now() - TRASH_DAYS * DAY, this.now() - DAY) } catch { /* fresh table */ }
  }

  // ---------------------------------------------------------------- stats and export

  stats(): { entities: number; facts: number; byType: Partial<Record<EntityType, number>> } {
    const byType: Partial<Record<EntityType, number>> = {}
    for (const r of this.db.sql.prepare('SELECT type, COUNT(*) AS n FROM ce_entities GROUP BY type').all() as Row[]) byType[r.type as EntityType] = Number(r.n)
    const facts = Number((this.db.sql.prepare('SELECT COUNT(*) AS n FROM ce_attributes').get() as Row).n) + Number((this.db.sql.prepare('SELECT COUNT(*) AS n FROM ce_relations').get() as Row).n)
    return { entities: Object.values(byType).reduce((a, b) => a + (b ?? 0), 0), facts, byType }
  }

  exportAll(): Record<string, unknown> {
    return {
      exportedAt: new Date(this.now()).toISOString(),
      entities: this.entities().map((e) => ({
        ...e,
        aliases: this.aliases(e.id).map(({ kind, value }) => ({ kind, value })),
        attributes: this.attributes(e.id).map(({ entityId: _e, ...a }) => a),
        relations: this.relations(e.id).filter((r) => r.fromId === e.id).map((r) => ({ ...r, to: this.entity(r.toId)?.name })),
        mentions: this.mentions(e.id, 40)
      }))
    }
  }

  /** For relation views: the other entity's name and type. */
  relationViews(entityId: string, scope?: string | null): EntityRelation[] {
    const out: EntityRelation[] = []
    for (const r of this.relations(entityId)) {
      if (scope !== undefined && r.scope !== null && r.scope !== scope) continue
      const outgoing = r.fromId === entityId
      const other = this.entity(outgoing ? r.toId : r.fromId)
      if (!other) continue
      if (scope !== undefined && other.scope !== null && other.scope !== scope) continue
      out.push({ id: r.id, rel: r.rel, otherId: other.id, otherName: other.name, otherType: other.type, outgoing, trust: r.trust, confidence: r.confidence, source: r.source, at: r.at, ...(r.note ? { note: r.note } : {}) })
    }
    return out
  }
}

/** Types that can name the same thing (a place and an organization are often the same restaurant or clinic). */
function compatible(a: EntityType, b: EntityType): boolean {
  if (a === b) return true
  const loose = new Set<EntityType>(['place', 'organization'])
  if (loose.has(a) && loose.has(b)) return true
  const things = new Set<EntityType>(['project', 'topic', 'goal'])
  return things.has(a) && things.has(b)
}
const sameType = (a: EntityType, b: EntityType): number => (a === b ? 1 : 0)
