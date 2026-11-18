import type { Db } from '../db'
import type { ContextEngine } from '../context-engine/service'
import type { Memory } from '../memory'
import type { VaultService } from '../vault/service'
import { BrainReader, type RawCommitment } from './reader'

// The brain reader for the main process: the context engine's graph, the knowledge vault's search, shared
// memories, and (when the brain keeps them, src/main/brain) its commitments and briefs, read straight from
// its tables, read-only, so nothing here depends on how the brain service is put together.

type Row = Record<string, unknown>

function hasTable(db: Db, name: string): boolean {
  try { return !!db.sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) } catch { return false }
}

export function brainReader(d: {
  db: Db
  world: () => ContextEngine | undefined
  vault: () => VaultService | undefined
  memory: { enabled: boolean; search(query: string, spaceId?: string | null, limit?: number): Memory[] }
  secretValues: () => string[]
}): BrainReader {
  return new BrainReader({
    graph: () => d.world()?.store ?? null,
    engineOn: () => { try { return !!d.world()?.settings().enabled } catch { return false } },
    vault: {
      search: (q, sections, k) => d.vault()?.search(q, sections, k) ?? [],
      body: (path) => { try { return d.vault()?.read(path)?.body ?? null } catch { return null } },
      sectionFor: (spaceId) => d.vault()?.sectionFor(spaceId) ?? null
    },
    memory: d.memory,
    commitments: () => {
      if (!hasTable(d.db, 'brain_commitments')) return []
      return (d.db.sql.prepare("SELECT * FROM brain_commitments WHERE status = 'open' ORDER BY COALESCE(due_at, 9e15) LIMIT 500").all() as Row[]).map((r): RawCommitment => ({
        id: String(r.id), entityId: (r.entity_id as string | null) ?? null, who: String(r.who ?? ''), what: String(r.what ?? ''), dueAt: r.due_at == null ? null : Number(r.due_at),
        dueWords: String(r.due_words ?? ''), owner: r.owner === 'user' ? 'user' : 'them', ref: String(r.ref ?? ''), status: String(r.status ?? ''), createdAt: Number(r.created_at ?? 0)
      }))
    },
    brief: (entityId) => {
      if (!hasTable(d.db, 'brain_briefs')) return null
      const r = d.db.sql.prepare('SELECT text FROM brain_briefs WHERE entity_id = ?').get(entityId) as Row | undefined
      return r && typeof r.text === 'string' && r.text.trim() ? { text: r.text } : null
    },
    secretValues: d.secretValues
  })
}
