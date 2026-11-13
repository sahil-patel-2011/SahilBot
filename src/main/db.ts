import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { LibraryItem, Message, PermissionMode, Space, Thread } from '@shared/types'
import { emptyState, type ThreadState } from './agent/types'

export const uid = (): string => randomUUID()

const MIGRATIONS: string[] = [
  `CREATE TABLE spaces (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE threads (
     id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
     title TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
     permission_mode TEXT NOT NULL DEFAULT 'auto', model TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX threads_space ON threads(space_id, updated_at DESC);
   CREATE TABLE messages (
     id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'done',
     data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
   CREATE INDEX messages_thread ON messages(thread_id, seq);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE thread_state (
     thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, data TEXT NOT NULL);
   CREATE TABLE memories (
     id TEXT PRIMARY KEY, category TEXT NOT NULL, content TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  `ALTER TABLE spaces ADD COLUMN shape TEXT NOT NULL DEFAULT 'blob';
   ALTER TABLE spaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'bot';
   ALTER TABLE spaces ADD COLUMN is_main INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE spaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE spaces ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE spaces ADD COLUMN members TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE spaces ADD COLUMN model TEXT;
   UPDATE spaces SET is_main = 1, name = CASE WHEN name = 'General' THEN 'Foreman' ELSE name END
     WHERE id = (SELECT id FROM spaces ORDER BY created_at LIMIT 1);`,
  `ALTER TABLE spaces ADD COLUMN folder TEXT;
   CREATE TABLE scheduled_tasks (
     id TEXT PRIMARY KEY, title TEXT NOT NULL, prompt TEXT NOT NULL, schedule TEXT NOT NULL,
     space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, thread_id TEXT,
     enabled INTEGER NOT NULL DEFAULT 1, next_run INTEGER, last_run INTEGER, last_status TEXT, created_at INTEGER NOT NULL);`,
  // Memories can belong to a project (shared by every chat in it) instead of everywhere.
  `ALTER TABLE memories ADD COLUMN scope TEXT;`,
  // The app is now called SahilBot; so is the main bot unless the user renamed it.
  `UPDATE spaces SET name = 'SahilBot' WHERE is_main = 1 AND name = 'Foreman';`,
  // Helper agents (Team of Experts) work in their own hidden threads under the chat that started them.
  `ALTER TABLE threads ADD COLUMN parent_id TEXT;`,
  // The main bot wears the hard-hat mascot unless you pick another shape.
  `UPDATE spaces SET shape = 'mascot' WHERE is_main = 1 AND shape = 'blob';`,
  // Routines (scheduled tasks) keep a short run history; bots get a label and a notifications switch.
  `CREATE TABLE routine_runs (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
     started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running',
     reason TEXT, thread_id TEXT, test INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX routine_runs_task ON routine_runs(task_id, started_at DESC);
   ALTER TABLE spaces ADD COLUMN label TEXT;
   ALTER TABLE spaces ADD COLUMN notify INTEGER NOT NULL DEFAULT 1;`,
  // Memory scopes: `scope` is the bot or project a memory belongs to (NULL = shared, about the user).
  // Memories remember where they came from, 'other' is now 'fact', and a bot's memories go with it.
  `ALTER TABLE memories ADD COLUMN source TEXT NOT NULL DEFAULT 'chat';
   UPDATE memories SET category = 'fact' WHERE category = 'other' OR category = '';
   CREATE INDEX memories_scope ON memories(scope, updated_at DESC);
   CREATE TRIGGER spaces_forget_memories AFTER DELETE ON spaces BEGIN DELETE FROM memories WHERE scope = OLD.id; END;`
]

type Row = Record<string, unknown>

export class Db {
  readonly sql: DatabaseSync

  constructor(file: string) {
    this.sql = new DatabaseSync(file)
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    const version = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec('BEGIN')
      this.sql.exec(MIGRATIONS[v])
      this.sql.exec(`PRAGMA user_version = ${v + 1}`)
      this.sql.exec('COMMIT')
    }
  }

  // ---------- settings (opaque JSON values) ----------
  getSetting<T>(key: string): T | undefined {
    const row = this.sql.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    return row ? (JSON.parse(row.value as string) as T) : undefined
  }

  setSetting(key: string, value: unknown): void {
    this.sql.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  // ---------- spaces ----------
  listSpaces(): Space[] {
    const rows = this.sql.prepare(`
      SELECT s.*, (
        SELECT m.content FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.space_id = s.id AND m.role IN ('user','assistant') AND m.content != '' AND json_extract(m.data, '$.meta.hidden') IS NULL
          AND json_extract(m.data, '$.meta.routineNotice') IS NULL
        ORDER BY m.created_at DESC, m.seq DESC LIMIT 1) AS last_preview,
        (SELECT MAX(t.updated_at) FROM threads t WHERE t.space_id = s.id) AS last_at,
        (SELECT COUNT(*) FROM threads t WHERE t.space_id = s.id AND t.unread = 1) AS unread_count
      FROM spaces s ORDER BY s.is_main DESC, s.pinned DESC, COALESCE(last_at, s.created_at) DESC`).all() as Row[]
    return rows.map((r) => ({
      ...toSpace(r),
      lastPreview: plain(r.last_preview as string | null),
      lastAt: (r.last_at as number | null) ?? undefined,
      unread: (r.unread_count as number) > 0
    }))
  }

  getSpace(id: string): Space | undefined {
    const r = this.sql.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Row | undefined
    return r ? toSpace(r) : undefined
  }

  createSpace(name: string, color: string, extra: Partial<Pick<Space, 'shape' | 'kind' | 'isMain' | 'members' | 'folder'>> = {}): Space {
    const id = uid()
    this.sql.prepare('INSERT INTO spaces(id, name, color, created_at, shape, kind, is_main, members, folder) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, name, color, Date.now(), extra.shape ?? 'blob', extra.kind ?? 'bot', extra.isMain ? 1 : 0, JSON.stringify(extra.members ?? []), extra.folder ?? null)
    return this.getSpace(id)!
  }

  mainSpace(): Space | undefined {
    const r = this.sql.prepare('SELECT * FROM spaces WHERE is_main = 1 LIMIT 1').get() as Row | undefined
    return r ? toSpace(r) : undefined
  }

  updateSpace(id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'folder' | 'label' | 'notify'>>): Space {
    const cur = this.getSpace(id)
    if (!cur) throw new Error(`No space ${id}`)
    const n = { ...cur, ...patch }
    const label = typeof n.label === 'string' ? n.label.replace(/\s+/g, ' ').trim().slice(0, 80) || null : null
    this.sql.prepare('UPDATE spaces SET name = ?, color = ?, shape = ?, pinned = ?, hidden = ?, members = ?, model = ?, folder = ?, label = ?, notify = ? WHERE id = ?')
      .run(n.name, n.color, n.shape, n.pinned ? 1 : 0, n.hidden ? 1 : 0, JSON.stringify(n.members), n.model, n.folder, label, n.notify === false ? 0 : 1, id)
    return this.getSpace(id)!
  }

  /** Files and links from one bot's chats, newest first: files it made, sources it cited, links you sent. */
  spaceLibrary(spaceId: string, limit = 200): LibraryItem[] {
    const files = this.sql.prepare(`
      SELECT json_extract(m.data, '$.meta.path') AS path, MAX(m.created_at) AS at, m.thread_id AS threadId
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.space_id = ? AND m.role = 'tool' AND json_extract(m.data, '$.meta.path') IS NOT NULL AND json_extract(m.data, '$.meta.status') = 'ok'
        AND json_extract(m.data, '$.toolName') IN ('file_write', 'create_document', 'file_manage', 'create_page', 'update_page')
      GROUP BY path ORDER BY at DESC LIMIT ?`).all(spaceId, limit) as Row[]
    const cited = this.sql.prepare(`
      SELECT json_extract(s.value, '$.url') AS url, json_extract(s.value, '$.title') AS title, MAX(m.created_at) AS at, m.thread_id AS threadId
      FROM messages m JOIN threads t ON t.id = m.thread_id, json_each(m.data, '$.meta.sources') s
      WHERE t.space_id = ? AND m.role = 'assistant' AND json_type(m.data, '$.meta.sources') = 'array'
      GROUP BY url ORDER BY at DESC LIMIT ?`).all(spaceId, limit) as Row[]
    const sent = this.sql.prepare(`
      SELECT m.content AS content, m.created_at AS at, m.thread_id AS threadId
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.space_id = ? AND m.role = 'user' AND m.content LIKE '%http%' AND json_extract(m.data, '$.meta.hidden') IS NULL
      ORDER BY m.created_at DESC LIMIT 300`).all(spaceId) as Row[]
    const out: LibraryItem[] = files.map((r) => ({ kind: 'file', title: basenameOf(r.path as string), path: r.path as string, at: r.at as number, threadId: r.threadId as string }))
    const links = new Map<string, LibraryItem>()
    const addLink = (url: string, title: string | null, at: number, threadId: string): void => {
      if (!/^https?:\/\//i.test(url)) return
      const key = url.replace(/#.*$/, '').replace(/\/$/, '')
      const cur = links.get(key)
      if (!cur || cur.at < at) links.set(key, { kind: 'link', title: title?.trim() || hostOf(url), url, at, threadId })
    }
    for (const r of cited) if (typeof r.url === 'string') addLink(r.url, (r.title as string | null) ?? null, r.at as number, r.threadId as string)
    for (const r of sent) for (const u of (r.content as string).match(/https?:\/\/[^\s<>()"'`\]]+/g) ?? []) addLink(u.replace(/[.,;:!?]+$/, ''), null, r.at as number, r.threadId as string)
    out.push(...links.values())
    return out.sort((a, b) => b.at - a.at).slice(0, limit)
  }

  deleteSpace(id: string): void {
    this.sql.prepare('DELETE FROM spaces WHERE id = ?').run(id)
  }

  // ---------- threads ----------
  private threadSelect = `
    SELECT t.*, (SELECT m.content FROM messages m WHERE m.thread_id = t.id
                 AND m.role IN ('user','assistant') AND m.content != '' AND json_extract(m.data, '$.meta.hidden') IS NULL
                 ORDER BY m.seq DESC LIMIT 1) AS last_preview
    FROM threads t`

  /** Files SahilBot made or changed, newest first (from successful file and document tool calls). */
  recentFiles(limit = 60): Array<{ path: string; threadId: string; threadTitle: string; createdAt: number; tool: string }> {
    const rows = this.sql.prepare(`
      SELECT json_extract(m.data, '$.meta.path') AS path, m.thread_id AS threadId, t.title AS threadTitle, MAX(m.created_at) AS createdAt, json_extract(m.data, '$.toolName') AS tool
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.role = 'tool' AND json_extract(m.data, '$.meta.path') IS NOT NULL AND json_extract(m.data, '$.meta.status') = 'ok'
        AND json_extract(m.data, '$.toolName') IN ('file_write', 'create_document', 'create_page', 'update_page')
      GROUP BY path ORDER BY createdAt DESC LIMIT ?`).all(limit) as Row[]
    return rows.map((r) => ({ path: r.path as string, threadId: r.threadId as string, threadTitle: r.threadTitle as string, createdAt: r.createdAt as number, tool: r.tool as string }))
  }

  /** Helper-agent threads started from a chat. */
  childThreads(parentId: string): Thread[] {
    return (this.sql.prepare(`${this.threadSelect} WHERE t.parent_id = ? ORDER BY t.created_at`).all(parentId) as Row[]).map(toThread)
  }

  listThreads(spaceId?: string): Thread[] {
    const rows = spaceId
      ? this.sql.prepare(`${this.threadSelect} WHERE t.space_id = ? AND t.parent_id IS NULL ORDER BY t.pinned DESC, t.updated_at DESC`).all(spaceId)
      : this.sql.prepare(`${this.threadSelect} WHERE t.parent_id IS NULL ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 200`).all()
    return (rows as Row[]).map(toThread)
  }

  searchThreads(q: string): Thread[] {
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`
    const rows = this.sql.prepare(`${this.threadSelect}
      WHERE t.parent_id IS NULL AND (t.title LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role IN ('user','assistant') AND m.content LIKE ? ESCAPE '\\'))
      ORDER BY t.updated_at DESC LIMIT 50`).all(like, like) as Row[]
    return rows.map(toThread)
  }

  getThread(id: string): Thread | undefined {
    const r = this.sql.prepare(`${this.threadSelect} WHERE t.id = ?`).get(id) as Row | undefined
    return r ? toThread(r) : undefined
  }

  createThread(spaceId: string, mode: PermissionMode, model: string | null, parentId: string | null = null): Thread {
    const now = Date.now()
    const id = uid()
    this.sql.prepare(`INSERT INTO threads(id, space_id, title, permission_mode, model, created_at, updated_at, parent_id)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, spaceId, 'New thread', mode, model, now, now, parentId)
    return this.getThread(id)!
  }

  updateThread(id: string, patch: Partial<Pick<Thread, 'title' | 'pinned' | 'unread' | 'permissionMode' | 'model' | 'spaceId'>>, touch = false): Thread {
    const cur = this.getThread(id)
    if (!cur) throw new Error(`No thread ${id}`)
    const n = { ...cur, ...patch }
    this.sql.prepare(`UPDATE threads SET title=?, pinned=?, unread=?, permission_mode=?, model=?, space_id=?, updated_at=? WHERE id=?`)
      .run(n.title, n.pinned ? 1 : 0, n.unread ? 1 : 0, n.permissionMode, n.model, n.spaceId, touch ? Date.now() : cur.updatedAt, id)
    return this.getThread(id)!
  }

  deleteThread(id: string): void {
    this.sql.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }

  // ---------- per-thread agent state ----------
  getState(threadId: string): ThreadState {
    const r = this.sql.prepare('SELECT data FROM thread_state WHERE thread_id = ?').get(threadId) as Row | undefined
    return r ? { ...emptyState(), ...(JSON.parse(r.data as string) as ThreadState) } : emptyState()
  }

  setState(threadId: string, state: ThreadState): void {
    this.sql.prepare('INSERT INTO thread_state(thread_id, data) VALUES(?, ?) ON CONFLICT(thread_id) DO UPDATE SET data = excluded.data')
      .run(threadId, JSON.stringify(state))
  }

  // ---------- messages ----------
  listMessages(threadId: string): Message[] {
    return (this.sql.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(threadId) as Row[]).map(toMessage)
  }

  insertMessage(m: Omit<Message, 'id' | 'createdAt'> & { id?: string; createdAt?: number }): Message {
    const full: Message = { ...m, id: m.id ?? uid(), createdAt: m.createdAt ?? Date.now() }
    const seq = (this.sql.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE thread_id = ?').get(m.threadId) as { n: number }).n
    this.sql.prepare(`INSERT INTO messages(id, thread_id, seq, role, content, kind, status, data, created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(full.id, full.threadId, seq, full.role, full.content, full.kind, full.status, JSON.stringify(dataOf(full)), full.createdAt)
    this.sql.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(full.createdAt, full.threadId)
    return full
  }

  updateMessage(m: Message): void {
    this.sql.prepare('UPDATE messages SET content = ?, kind = ?, status = ?, data = ? WHERE id = ?')
      .run(m.content, m.kind, m.status, JSON.stringify(dataOf(m)), m.id)
  }

  getMessage(id: string): Message | undefined {
    const r = this.sql.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return r ? toMessage(r) : undefined
  }

  /** who: 'user' reacts to assistant messages, 'bot' to user messages. null clears. */
  react(id: string, who: 'user' | 'bot', emoji: string | null): Message {
    const m = this.getMessage(id)
    if (!m) throw new Error('Message not found')
    const reactions = { ...((m.meta?.reactions ?? {}) as Record<string, unknown>) }
    if (emoji) {
      reactions[who] = emoji
      reactions[`${who}At`] = Date.now()
    } else {
      delete reactions[who]
      delete reactions[`${who}At`]
    }
    m.meta = { ...m.meta, reactions }
    this.updateMessage(m)
    return m
  }

  /** Removes every message after `messageId` (retry / edit-and-resend only ever touch the tail). */
  deleteAfter(threadId: string, messageId: string): void {
    const r = this.sql.prepare('SELECT seq FROM messages WHERE id = ?').get(messageId) as { seq: number } | undefined
    if (r) this.sql.prepare('DELETE FROM messages WHERE thread_id = ? AND seq > ?').run(threadId, r.seq)
  }

  /** Marks anything left 'streaming' by a crash or quit as stopped. */
  sweepStreaming(): void {
    this.sql.prepare(`UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`).run()
  }
}

/** Sidebar previews are plain text: drop Markdown punctuation and collapse whitespace. */
export function plain(md: string | null | undefined): string | undefined {
  if (!md) return undefined
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function dataOf(m: Message): Record<string, unknown> {
  const { reasoning, toolCalls, toolCallId, toolName, images, model, meta } = m
  return { reasoning, toolCalls, toolCallId, toolName, images, model, meta }
}

function toSpace(r: Row): Space {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as string,
    shape: (r.shape as Space['shape']) ?? 'blob',
    kind: (r.kind as Space['kind']) ?? 'bot',
    isMain: r.is_main === 1,
    pinned: r.pinned === 1,
    hidden: r.hidden === 1,
    members: JSON.parse((r.members as string) ?? '[]') as string[],
    model: (r.model as string | null) ?? null,
    folder: (r.folder as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    notify: r.notify !== 0,
    createdAt: r.created_at as number
  }
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function toThread(r: Row): Thread {
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    title: r.title as string,
    pinned: r.pinned === 1,
    unread: r.unread === 1,
    permissionMode: r.permission_mode as PermissionMode,
    model: (r.model as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastPreview: plain(r.last_preview as string | null),
    parentId: (r.parent_id as string | null) ?? null
  }
}

function toMessage(r: Row): Message {
  const d = JSON.parse(r.data as string) as Partial<Message>
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    role: r.role as Message['role'],
    content: r.content as string,
    kind: r.kind as Message['kind'],
    status: r.status as Message['status'],
    createdAt: r.created_at as number,
    ...d
  }
}
