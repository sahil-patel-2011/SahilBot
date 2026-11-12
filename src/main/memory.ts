import type { Db } from './db'
import { uid } from './db'

export type MemoryCategory = 'profile' | 'work' | 'preference' | 'location' | 'person' | 'project' | 'trip' | 'link' | 'date' | 'other'

export interface Memory {
  id: string
  category: MemoryCategory
  content: string
  /** null = about the user, everywhere; a project id = shared by that project's chats. */
  projectId: string | null
  createdAt: number
  updatedAt: number
}

/** Long-term facts: about the user (everywhere) or about a project (shared by its chats). */
export class MemoryStore {
  constructor(private db: Db) {}

  /** Everything, or the user's memories plus one project's. */
  list(projectId?: string | null): Memory[] {
    const rows = (projectId === undefined
      ? this.db.sql.prepare('SELECT * FROM memories ORDER BY updated_at DESC').all()
      : this.db.sql.prepare('SELECT * FROM memories WHERE scope IS NULL OR scope = ? ORDER BY updated_at DESC').all(projectId ?? '')) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      id: r.id as string,
      category: r.category as MemoryCategory,
      content: r.content as string,
      projectId: (r.scope as string | null) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number
    }))
  }

  save(content: string, category: MemoryCategory = 'other', projectId: string | null = null): { memory: Memory; replaced?: string } {
    const text = content.trim()
    // Same fact restated: refresh it rather than piling up duplicates.
    const dup = this.list().find((m) => m.projectId === projectId && similar(m.content, text))
    const now = Date.now()
    if (dup) {
      this.db.sql.prepare('UPDATE memories SET content = ?, category = ?, updated_at = ? WHERE id = ?').run(text, category, now, dup.id)
      return { memory: { ...dup, content: text, category, updatedAt: now }, replaced: dup.content }
    }
    const m: Memory = { id: uid().slice(0, 8), category, content: text, projectId, createdAt: now, updatedAt: now }
    this.db.sql.prepare('INSERT INTO memories(id, category, content, created_at, updated_at, scope) VALUES(?,?,?,?,?,?)').run(m.id, m.category, m.content, now, now, projectId)
    return { memory: m }
  }

  update(id: string, content: string): void {
    this.db.sql.prepare('UPDATE memories SET content = ?, updated_at = ? WHERE id = ?').run(content.trim(), Date.now(), id)
  }

  remove(id: string): boolean {
    return Number(this.db.sql.prepare('DELETE FROM memories WHERE id = ?').run(id).changes) > 0
  }

  search(query: string, projectId?: string | null): Memory[] {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
    return this.list(projectId)
      .map((m) => ({ m, s: words.filter((w) => m.content.toLowerCase().includes(w)).length }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.m)
  }

  /** The block injected into each new thread's system prompt. Newest first, capped. */
  block(maxChars = 2400, projectId: string | null = null): string {
    const lines: string[] = []
    let used = 0
    for (const m of this.list(projectId).filter((x) => x.projectId === projectId)) {
      const line = `- [${m.id}] (${m.category}, ${new Date(m.updatedAt).toISOString().slice(0, 10)}) ${m.content}`
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    return lines.join('\n')
  }
}

function similar(a: string, b: string): boolean {
  const norm = (s: string): string[] => s.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
  const A = new Set(norm(a)), B = new Set(norm(b))
  if (!A.size || !B.size) return false
  const inter = [...A].filter((w) => B.has(w)).length
  return inter / Math.max(A.size, B.size) >= 0.8
}
