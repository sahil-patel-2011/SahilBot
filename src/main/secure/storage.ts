import type { Db } from '../db'

/** One encrypted item as stored. `meta` is plaintext JSON (bound into the ciphertext's AAD); dk and body are packed AES-GCM. */
export interface VaultRow {
  id: string
  type: string
  ver: number
  meta: string
  dk: string
  body: string
  created: number
  updated: number
}

/** Where the vault keeps its rows, header and preferences. SQLite in the app; a Map in tests. */
export interface VaultStorage {
  rows(): VaultRow[]
  row(id: string): VaultRow | undefined
  put(r: VaultRow): void
  del(id: string): void
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  /** Runs fn atomically: everything it wrote is undone if it throws. */
  atomic<T>(fn: () => T): T
}

/** The settings database: its own table for items, the settings table (vault2:*) for the header and prefs. */
export class SqliteVaultStorage implements VaultStorage {
  constructor(private db: Db) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS vault_items (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, ver INTEGER NOT NULL, meta TEXT NOT NULL,
      dk TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`)
  }

  rows(): VaultRow[] {
    return this.db.sql.prepare('SELECT id, type, ver, meta, dk, body, created, updated FROM vault_items ORDER BY created').all() as unknown as VaultRow[]
  }

  row(id: string): VaultRow | undefined {
    return this.db.sql.prepare('SELECT id, type, ver, meta, dk, body, created, updated FROM vault_items WHERE id = ?').get(id) as unknown as VaultRow | undefined
  }

  put(r: VaultRow): void {
    this.db.sql.prepare(`INSERT INTO vault_items(id, type, ver, meta, dk, body, created, updated) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET type = excluded.type, ver = excluded.ver, meta = excluded.meta, dk = excluded.dk, body = excluded.body, updated = excluded.updated`)
      .run(r.id, r.type, r.ver, r.meta, r.dk, r.body, r.created, r.updated)
  }

  del(id: string): void {
    this.db.sql.prepare('DELETE FROM vault_items WHERE id = ?').run(id)
  }

  get<T>(key: string): T | undefined {
    return this.db.getSetting<T>(key)
  }

  set(key: string, value: unknown): void {
    this.db.setSetting(key, value)
  }

  private depth = 0
  atomic<T>(fn: () => T): T {
    if (this.depth > 0) return fn()
    this.db.sql.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const out = fn()
      this.db.sql.exec('COMMIT')
      return out
    } catch (e) {
      try { this.db.sql.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw e
    } finally {
      this.depth--
    }
  }
}

/** In-memory storage (tests). atomic() snapshots and restores on error, like a transaction. */
export class MemoryVaultStorage implements VaultStorage {
  items = new Map<string, VaultRow>()
  kv = new Map<string, string>()
  rows(): VaultRow[] { return [...this.items.values()].map((r) => ({ ...r })) }
  row(id: string): VaultRow | undefined { const r = this.items.get(id); return r ? { ...r } : undefined }
  put(r: VaultRow): void { this.items.set(r.id, { ...r }) }
  del(id: string): void { this.items.delete(id) }
  get<T>(key: string): T | undefined { const v = this.kv.get(key); return v === undefined ? undefined : (JSON.parse(v) as T) }
  set(key: string, value: unknown): void { if (value === undefined || value === null) this.kv.delete(key); else this.kv.set(key, JSON.stringify(value)) }
  atomic<T>(fn: () => T): T {
    const items = new Map([...this.items].map(([k, v]) => [k, { ...v }]))
    const kv = new Map(this.kv)
    try { return fn() } catch (e) { this.items = items; this.kv = kv; throw e }
  }
}
