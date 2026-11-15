import type { Db } from '../db'

export type AuditEvent =
  | 'unlock' | 'unlock_failed' | 'lock' | 'fill' | 'fill_blocked' | 'reveal' | 'reauth' | 'reauth_failed'
  | 'export' | 'import' | 'item_added' | 'item_changed' | 'item_removed'
  | 'master_password' | 'migration' | 'tamper'

export interface AuditEntry {
  id: number
  at: number
  event: AuditEvent
  /** Item name (never a value). */
  item?: string
  /** Site origin or host involved. */
  site?: string
  outcome: 'ok' | 'denied' | 'failed' | 'blocked'
  /** Short human text: why it failed, what kind of fill. Never a secret value. */
  detail?: string
}

export interface AuditLog {
  add(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): void
  list(limit?: number): AuditEntry[]
  clear(): void
}

const MAX_ROWS = 5000
const cleanText = (s: unknown, n: number): string | undefined => {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)
  return t || undefined
}

/**
 * The vault's audit trail: unlocks, fills, reveals, exports and failures with time, site, item name and
 * outcome. Values are never written: callers pass names and hosts only, and `scrub` (set by the vault)
 * masks any saved secret that slipped into the text anyway.
 */
export class SqliteAuditLog implements AuditLog {
  scrub: (s: string) => string = (s) => s
  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS vault_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, item TEXT, site TEXT, outcome TEXT NOT NULL, detail TEXT)`)
  }

  add(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): void {
    try {
      const f = (s: unknown, n: number): string | null => { const t = cleanText(s, n); return t ? this.scrub(t) : null }
      this.db.sql.prepare('INSERT INTO vault_audit(at, event, item, site, outcome, detail) VALUES(?, ?, ?, ?, ?, ?)')
        .run(e.at ?? this.now(), e.event, f(e.item, 80), f(e.site, 120), e.outcome, f(e.detail, 200))
      this.db.sql.prepare('DELETE FROM vault_audit WHERE id <= (SELECT MAX(id) FROM vault_audit) - ?').run(MAX_ROWS)
    } catch { /* the audit log never breaks a vault operation */ }
  }

  list(limit = 200): AuditEntry[] {
    const rows = this.db.sql.prepare('SELECT id, at, event, item, site, outcome, detail FROM vault_audit ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(MAX_ROWS, limit))) as Array<Record<string, unknown>>
    return rows.map((r) => ({ id: Number(r.id), at: Number(r.at), event: r.event as AuditEvent, outcome: r.outcome as AuditEntry['outcome'], ...(r.item ? { item: String(r.item) } : {}), ...(r.site ? { site: String(r.site) } : {}), ...(r.detail ? { detail: String(r.detail) } : {}) }))
  }

  clear(): void {
    this.db.sql.exec('DELETE FROM vault_audit')
  }
}

export class MemoryAuditLog implements AuditLog {
  entries: AuditEntry[] = []
  scrub: (s: string) => string = (s) => s
  private seq = 0
  constructor(private now: () => number = Date.now) {}
  add(e: Omit<AuditEntry, 'id' | 'at'> & { at?: number }): void {
    const f = (s: unknown, n: number): string | undefined => { const t = cleanText(s, n); return t ? this.scrub(t) : undefined }
    this.entries.unshift({ id: ++this.seq, at: e.at ?? this.now(), event: e.event, outcome: e.outcome, ...(f(e.item, 80) ? { item: f(e.item, 80) } : {}), ...(f(e.site, 120) ? { site: f(e.site, 120) } : {}), ...(f(e.detail, 200) ? { detail: f(e.detail, 200) } : {}) })
    if (this.entries.length > MAX_ROWS) this.entries.length = MAX_ROWS
  }
  list(limit = 200): AuditEntry[] { return this.entries.slice(0, limit) }
  clear(): void { this.entries = [] }
}
