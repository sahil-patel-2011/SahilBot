import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { EffortChoice, LibraryItem, Message, PermissionMode, Space, Thread } from '@shared/types'
import { emptyState, type ThreadState } from './agent/types'
import { KNOWLEDGE_SCHEMA } from './knowledge/schema'
import { UNREAD_CAP } from '@shared/read-state'
import { stripDirectives } from '@shared/directives'
import { CONCEPTS, NOT_OWN_WORDS, conceptAlternatives, hasStem, hasWord, normalizeForRecall, wordStem } from './recall-expand'

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
   CREATE TRIGGER spaces_forget_memories AFTER DELETE ON spaces BEGIN DELETE FROM memories WHERE scope = OLD.id; END;`,
  // Cloud usage remembers which bot made each request (Settings → Usage). The table is first made by
  // the budget guard, so a fresh database gets it here (same shape) before the column is added.
  `CREATE TABLE IF NOT EXISTS usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, host TEXT NOT NULL, model TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
   ALTER TABLE usage ADD COLUMN space_id TEXT;
   CREATE INDEX IF NOT EXISTS usage_at ON usage(at);`,
  // Long-running goals (goals/): milestones, journal, queued approvals and the wake log are JSON;
  // next_wake is a one-time wake-up the scheduler fires. A bot's goals go with it.
  `CREATE TABLE IF NOT EXISTS goals (
     id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, thread_id TEXT,
     title TEXT NOT NULL, done_when TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', status_reason TEXT,
     milestones TEXT NOT NULL DEFAULT '[]', journal TEXT NOT NULL DEFAULT '[]', asks TEXT NOT NULL DEFAULT '[]',
     wake_log TEXT NOT NULL DEFAULT '[]', next_wake INTEGER, wake_note TEXT, end_at INTEGER,
     max_usd REAL NOT NULL DEFAULT 2, max_runs_per_day INTEGER NOT NULL DEFAULT 6, spent_usd REAL NOT NULL DEFAULT 0,
     wakes INTEGER NOT NULL DEFAULT 0, last_wake INTEGER, stall INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS goals_space ON goals(space_id, created_at DESC);
   CREATE INDEX IF NOT EXISTS goals_wake ON goals(status, next_wake);`,
  // Knowledge base (knowledge/): indexed files, their passages (with optional embeddings) and a BM25 term
  // index. The FTS5 table is made at runtime by KnowledgeStore, since not every SQLite build has FTS5.
  KNOWLEDGE_SCHEMA,
  // Memory provenance: 'untrusted' = its wording followed outside content (a web page, email, another app
  // or bot). Those stay in the bot that saved them, are labelled, and never replace a trusted memory.
  `ALTER TABLE memories ADD COLUMN provenance TEXT NOT NULL DEFAULT 'trusted';`,
  // Hot paths: helper threads by their parent chat (team boards, childThreads) and the launch sweep of
  // replies a quit left 'streaming' were full scans (7 ms at 120k messages, on every launch). Partial
  // indexes: only helper threads and in-flight replies are in them, so they cost nothing to keep up.
  `CREATE INDEX IF NOT EXISTS threads_parent ON threads(parent_id) WHERE parent_id IS NOT NULL;
   CREATE INDEX IF NOT EXISTS messages_streaming ON messages(status) WHERE status = 'streaming';`,
  // Thinking chosen per bot and per chat ('auto' or a level; NULL = inherit), like the model.
  `ALTER TABLE spaces ADD COLUMN effort TEXT;
   ALTER TABLE threads ADD COLUMN effort TEXT;`,
  // The main bot isn't called SahilBot (that's the app) unless the user named it: it's a "New bot" that can
  // take any name, from the sidebar or by asking it in chat.
  `UPDATE spaces SET name = 'New bot' WHERE is_main = 1 AND name = 'SahilBot';`,
  // A bot's own icon (an emoji), like Grok Bot's per-bot icons; NULL = its shape's eyes.
  `ALTER TABLE spaces ADD COLUMN icon TEXT;`,
  // A deleted bot waits here a few minutes (Undo) before it and its chat are really removed; NULL = not deleted.
  `ALTER TABLE spaces ADD COLUMN trashed_at INTEGER;`
]

type Row = Record<string, unknown>

/** A chat whose bot was deleted (waiting out its Undo time) is in no list. */
const NOT_TRASHED = 't.space_id NOT IN (SELECT id FROM spaces WHERE trashed_at IS NOT NULL)'

/**
 * The usage table's newer columns (Settings → Usage): the providers' own token detail for each paid request.
 * Added by checking the table's columns rather than by migration number, so it is idempotent, safe on any
 * database (fresh, old or already migrated) and never collides with other features' numbered migrations.
 *   provider     which provider served it (anthropic, openai, xai, chatgpt…)
 *   prompt       the real prompt size in tokens (input + cache reads + cache writes)
 *   cached       input tokens read from the prompt cache
 *   cache_write  input tokens written to the prompt cache
 *   out_tokens   output tokens as billed (visible + reasoning); `output` stays billing-equivalent
 *   reasoning    the reasoning part of the output, when reported
 *   tier         'fast' / 'ultrafast' when fast mode ran (NULL: standard)
 *   web_calls    server-side web searches / fetches
 * `input` / `output` keep their meaning (billing-equivalent tokens that cost() prices), so old rows still add up.
 */
export const USAGE_COLUMNS: Array<[string, string]> = [
  ['provider', 'TEXT'], ['prompt', 'INTEGER'], ['cached', 'INTEGER NOT NULL DEFAULT 0'], ['cache_write', 'INTEGER NOT NULL DEFAULT 0'],
  ['out_tokens', 'INTEGER'], ['reasoning', 'INTEGER NOT NULL DEFAULT 0'], ['tier', 'TEXT'], ['web_calls', 'INTEGER NOT NULL DEFAULT 0']
]

export function ensureUsageColumns(sql: DatabaseSync): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS usage (
     id INTEGER PRIMARY KEY AUTOINCREMENT, month TEXT NOT NULL, host TEXT NOT NULL, model TEXT NOT NULL,
     input INTEGER NOT NULL, output INTEGER NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL)`)
  const have = new Set((sql.prepare('PRAGMA table_info(usage)').all() as Array<{ name: string }>).map((c) => c.name))
  // space_id belongs to the numbered migration that made the table's bot tag (it runs before this).
  const missing = USAGE_COLUMNS.filter(([c]) => !have.has(c))
  if (missing.length) {
    sql.exec('BEGIN')
    try {
      for (const [c, type] of missing) sql.exec(`ALTER TABLE usage ADD COLUMN ${c} ${type}`)
      sql.exec('COMMIT')
    } catch (e) { sql.exec('ROLLBACK'); throw e }
  }
  sql.exec('CREATE INDEX IF NOT EXISTS usage_at ON usage(at); CREATE INDEX IF NOT EXISTS usage_month ON usage(month)')
}

/**
 * Read state (shared/read-state.ts): threads.last_read_at is when you last saw the chat (main's clock, so every
 * device agrees), and an index finds the replies after it without walking the whole chat. Added by checking
 * the table's columns rather than by migration number, so it is idempotent and safe on any database. The first
 * time, chats you had read count as read up to their last change; chats still marked unread count as read up
 * to your last message in them (what the bot said after that is what you missed).
 */
export function ensureReadColumns(sql: DatabaseSync): void {
  const have = new Set((sql.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((c) => c.name))
  if (!have.has('last_read_at')) {
    sql.exec('BEGIN')
    try {
      sql.exec(`ALTER TABLE threads ADD COLUMN last_read_at INTEGER;
        UPDATE threads SET last_read_at = CASE WHEN unread = 0 THEN updated_at ELSE COALESCE((
          SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = threads.id AND m.role = 'user'
            AND json_extract(m.data, '$.meta.hidden') IS NULL), created_at) END;`)
      sql.exec('COMMIT')
    } catch (e) { sql.exec('ROLLBACK'); throw e }
  }
  sql.exec('CREATE INDEX IF NOT EXISTS messages_thread_at ON messages(thread_id, created_at)')
}

/** When a chat was last read (a chat never marked counts from its creation). */
const READ_AT = (t: string): string => `COALESCE(${t}.last_read_at, ${t}.created_at)`

/**
 * Unread replies in chat `t` (shared/read-state.ts countsAsUnread, in SQL), capped at UNREAD_CAP. Only chats
 * changed since they were read are counted at all, so a sidebar of read chats costs one comparison each.
 */
export const UNREAD_SQL = (t: string): string => `(CASE WHEN ${t}.updated_at > ${READ_AT(t)} THEN (
    SELECT COUNT(*) FROM (SELECT 1 FROM messages m WHERE m.thread_id = ${t}.id AND m.created_at > ${READ_AT(t)}
      AND m.role = 'assistant' AND m.kind = 'normal' AND m.content != ''
      AND IFNULL(json_extract(m.data, '$.meta.hidden'), 0) = 0 AND IFNULL(json_extract(m.data, '$.meta.superseded'), 0) = 0 AND IFNULL(json_extract(m.data, '$.meta.provisional'), 0) = 0
      AND json_extract(m.data, '$.meta.routineNotice') IS NULL
      LIMIT ${UNREAD_CAP})) ELSE 0 END)`

export class Db {
  readonly sql: DatabaseSync

  constructor(file: string) {
    this.sql = new DatabaseSync(file)
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    // Usage detail columns (idempotent; see ensureUsageColumns).
    ensureUsageColumns(this.sql)
    // Read state: last_read_at and its index (idempotent; see ensureReadColumns).
    ensureReadColumns(this.sql)
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

  /** Setting keys that start with a prefix (e.g. every saved secret's name). */
  settingKeys(prefix: string): string[] {
    return (this.sql.prepare("SELECT key FROM settings WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as Row[]).map((r) => String(r.key))
  }

  setSetting(key: string, value: unknown): void {
    this.sql.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  deleteSetting(key: string): void {
    this.sql.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  // ---------- spaces ----------
  listSpaces(): Space[] {
    const rows = this.sql.prepare(`
      SELECT s.*, (
        -- Each chat's own latest line (a short backward walk of its (thread_id, seq) index), then the newest
        -- of those. Sorting every message of the bot instead made this 8x slower on a big history, and the
        -- sidebar asks for it after every run.
        SELECT m2.content FROM threads t JOIN messages m2 ON m2.id = (
          SELECT m.id FROM messages m WHERE m.thread_id = t.id AND m.role IN ('user','assistant') AND m.content != ''
            AND json_extract(m.data, '$.meta.hidden') IS NULL AND json_extract(m.data, '$.meta.routineNotice') IS NULL
            -- (Not a reply the chat doesn't show: one replaced by the next, or one still held for its checks.)
            AND IFNULL(json_extract(m.data, '$.meta.superseded'), 0) = 0 AND json_extract(m.data, '$.meta.provisional') IS NULL
          ORDER BY m.seq DESC LIMIT 1)
        WHERE t.space_id = s.id
        ORDER BY m2.created_at DESC, m2.seq DESC LIMIT 1) AS last_preview,
        (SELECT MAX(t.updated_at) FROM threads t WHERE t.space_id = s.id) AS last_at,
        -- Your chats with the bot (not its helpers' hidden ones): marked unread, or with replies you haven't seen.
        (SELECT COUNT(*) FROM threads t WHERE t.space_id = s.id AND t.parent_id IS NULL AND (t.unread = 1 OR ${UNREAD_SQL('t')} > 0)) AS unread_count,
        (SELECT COALESCE(SUM(${UNREAD_SQL('t')}), 0) FROM threads t WHERE t.space_id = s.id AND t.parent_id IS NULL) AS unread_n
      FROM spaces s WHERE s.trashed_at IS NULL ORDER BY s.is_main DESC, s.pinned DESC, COALESCE(last_at, s.created_at) DESC`).all() as Row[]
    return rows.map((r) => ({
      ...toSpace(r),
      lastPreview: plain(r.last_preview as string | null),
      lastAt: (r.last_at as number | null) ?? undefined,
      unread: (r.unread_count as number) > 0,
      unreadCount: Math.min(UNREAD_CAP, (r.unread_n as number) ?? 0)
    }))
  }

  getSpace(id: string): Space | undefined {
    const r = this.sql.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as Row | undefined
    return r ? toSpace(r) : undefined
  }

  createSpace(name: string, color: string, extra: Partial<Pick<Space, 'shape' | 'kind' | 'isMain' | 'members' | 'folder' | 'icon'>> = {}, id = uid()): Space {
    this.sql.prepare('INSERT INTO spaces(id, name, color, created_at, shape, kind, is_main, members, folder, icon) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, color, Date.now(), extra.shape ?? 'blob', extra.kind ?? 'bot', extra.isMain ? 1 : 0, JSON.stringify(extra.members ?? []), extra.folder ?? null, cleanIcon(extra.icon))
    return this.getSpace(id)!
  }

  mainSpace(): Space | undefined {
    const r = this.sql.prepare('SELECT * FROM spaces WHERE is_main = 1 LIMIT 1').get() as Row | undefined
    return r ? toSpace(r) : undefined
  }

  updateSpace(id: string, patch: Partial<Pick<Space, 'name' | 'color' | 'shape' | 'pinned' | 'hidden' | 'members' | 'model' | 'folder' | 'label' | 'notify' | 'effort' | 'icon'>>): Space {
    const cur = this.getSpace(id)
    if (!cur) throw new Error(`No space ${id}`)
    const n = { ...cur, ...patch }
    const label = typeof n.label === 'string' ? n.label.replace(/\s+/g, ' ').trim().slice(0, 80) || null : null
    this.sql.prepare('UPDATE spaces SET name = ?, color = ?, shape = ?, pinned = ?, hidden = ?, members = ?, model = ?, folder = ?, label = ?, notify = ?, effort = ?, icon = ? WHERE id = ?')
      .run(n.name, n.color, n.shape, n.pinned ? 1 : 0, n.hidden ? 1 : 0, JSON.stringify(n.members), n.model, n.folder, label, n.notify === false ? 0 : 1, effortOrNull(n.effort), cleanIcon(n.icon), id)
    return this.getSpace(id)!
  }

  /** Files and links from one bot's chats, newest first: files it made, sources it cited, links you sent. */
  spaceLibrary(spaceId: string, limit = 200): LibraryItem[] {
    const files = this.sql.prepare(`
      SELECT json_extract(m.data, '$.meta.path') AS path, MAX(m.created_at) AS at, m.thread_id AS threadId
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.space_id = ? AND m.role = 'tool' AND json_extract(m.data, '$.meta.path') IS NOT NULL AND json_extract(m.data, '$.meta.status') = 'ok'
        AND json_extract(m.data, '$.toolName') IN ('file_write', 'file_edit', 'create_document', 'file_manage', 'create_page', 'update_page')
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

  /**
   * Deletes a bot so it can still be undone: it leaves every list (bots, Recents, search) but it, its chat and its
   * routines are kept until purgeSpace. restoreSpace brings it all back.
   */
  trashSpace(id: string, at = Date.now()): void {
    this.sql.prepare('UPDATE spaces SET trashed_at = ? WHERE id = ? AND is_main = 0').run(at, id)
  }

  restoreSpace(id: string): boolean {
    return Number(this.sql.prepare('UPDATE spaces SET trashed_at = NULL WHERE id = ? AND trashed_at IS NOT NULL').run(id).changes) > 0
  }

  /** When a bot was deleted (still undoable), else undefined. */
  trashedAt(id: string): number | undefined {
    const r = this.sql.prepare('SELECT trashed_at FROM spaces WHERE id = ?').get(id) as { trashed_at: number | null } | undefined
    return r?.trashed_at ?? undefined
  }

  /** Deleted bots still waiting out their Undo time. */
  trashedSpaces(): Array<{ id: string; name: string; trashedAt: number }> {
    return (this.sql.prepare('SELECT id, name, trashed_at FROM spaces WHERE trashed_at IS NOT NULL').all() as Row[])
      .map((r) => ({ id: r.id as string, name: r.name as string, trashedAt: r.trashed_at as number }))
  }

  // ---------- threads ----------
  // tool_mode: a substring check on the saved agent state (JSON.stringify writes it exactly so) instead of
  // json_extract, which would parse every chat's whole state on each sidebar refresh.
  private threadSelect = `
    SELECT t.*, (SELECT m.content FROM messages m WHERE m.thread_id = t.id
                 AND m.role IN ('user','assistant') AND m.content != '' AND json_extract(m.data, '$.meta.hidden') IS NULL
                 AND IFNULL(json_extract(m.data, '$.meta.superseded'), 0) = 0 AND json_extract(m.data, '$.meta.provisional') IS NULL
                 ORDER BY m.seq DESC LIMIT 1) AS last_preview,
      ${UNREAD_SQL('t')} AS unread_n,
      (SELECT CASE WHEN instr(ts.data, '"toolMode":"full"') > 0 THEN 'full'
                   WHEN instr(ts.data, '"toolMode":"chat"') > 0 OR instr(ts.data, '"toolMode":"quick"') > 0 THEN 'chat' END
         FROM thread_state ts WHERE ts.thread_id = t.id) AS tool_mode,
      -- You typed in it yourself (not a routine, a Memory draft, another bot's handoff or a connected app).
      EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.role = 'user'
              AND json_extract(m.data, '$.meta.hidden') IS NULL AND json_extract(m.data, '$.meta.scheduled') IS NULL
              AND json_extract(m.data, '$.meta.brainPrompt') IS NULL AND json_extract(m.data, '$.meta.handoff') IS NULL
              AND json_extract(m.data, '$.meta.fromApp') IS NULL AND json_extract(m.data, '$.meta.mcpClientId') IS NULL) AS by_user
    FROM threads t`

  /** Files SahilBot made or changed, newest first (from successful file and document tool calls). */
  recentFiles(limit = 60): Array<{ path: string; threadId: string; threadTitle: string; createdAt: number; tool: string }> {
    const rows = this.sql.prepare(`
      SELECT json_extract(m.data, '$.meta.path') AS path, m.thread_id AS threadId, t.title AS threadTitle, MAX(m.created_at) AS createdAt, json_extract(m.data, '$.toolName') AS tool
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.role = 'tool' AND json_extract(m.data, '$.meta.path') IS NOT NULL AND json_extract(m.data, '$.meta.status') = 'ok'
        AND json_extract(m.data, '$.toolName') IN ('file_write', 'file_edit', 'create_document', 'create_page', 'update_page')
      GROUP BY path ORDER BY createdAt DESC LIMIT ?`).all(limit) as Row[]
    return rows.map((r) => ({ path: r.path as string, threadId: r.threadId as string, threadTitle: r.threadTitle as string, createdAt: r.createdAt as number, tool: r.tool as string }))
  }

  /**
   * Artifacts: every file a tool made for the user (documents, decks, sheets, PDFs, images, audio), newest
   * first, one row per path. Tools that only read or look (file_read, screenshots, searches) are left out.
   */
  artifactFiles(limit = 300): Array<{ path: string; threadId: string; threadTitle: string; createdAt: number; tool: string }> {
    const rows = this.sql.prepare(`
      SELECT json_extract(m.data, '$.meta.path') AS path, m.thread_id AS threadId, t.title AS threadTitle, MAX(m.created_at) AS createdAt, json_extract(m.data, '$.toolName') AS tool
      FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.role = 'tool' AND json_extract(m.data, '$.meta.path') IS NOT NULL AND json_extract(m.data, '$.meta.status') = 'ok'
        AND json_extract(m.data, '$.toolName') NOT IN ('file_read', 'read_result', 'list_files', 'search_files', 'grep', 'glob', 'fetch_page', 'screenshot', 'computer', 'browser', 'file_info', 'open_file', 'code', 'run_command', 'git', 'transcribe')
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
      : this.sql.prepare(`${this.threadSelect} WHERE t.parent_id IS NULL AND ${NOT_TRASHED} ORDER BY t.pinned DESC, t.updated_at DESC LIMIT 200`).all()
    return (rows as Row[]).map(toThread)
  }

  /**
   * What the user said in their other chats with the same bot (or project) that bears on `query`: only
   * their own words (no hidden app notes, nothing relayed from links, other bots, connected apps, helpers,
   * routines or goal runs, no superseded edits), scored by how many of the query's key words they contain,
   * newest first on ties. It never reaches into another bot's chats. Only the newest 4,000 messages of that
   * bot are searched (an index on role and time keeps it quick on a large database).
   */
  recallUserSaid(query: string, excludeThreadId: string, limit = 6): Array<{ threadId: string; title: string; text: string; at: number }> {
    const STOP = new Set('about above after again also because been before being below between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your yours make made want need like please thanks thank help'.split(' '))
    const here = this.getThread(excludeThreadId)
    if (!here) return []
    // Search units, each counted once: the request's own words (4+ letters, whole words starting with them), and
    // each concept it names by the words a message about it would use ("my landlord" → landlord, rent, lease;
    // recall-expand.ts). A plain word that belongs to a named concept is counted with the concept.
    const concepts = conceptAlternatives(query).slice(0, 4)
    const conceptWords = new Set(concepts.flatMap((c) => [...c.words, ...CONCEPTS[c.concept].ask.flatMap((a) => normalizeForRecall(a).split(' '))]))
    const plain = [...new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9'-]{3,}/g) ?? []).filter((w) => !STOP.has(w)).map(wordStem).filter((w) => w.length >= 3 && !conceptWords.has(w)))].slice(0, 8)
    const units: Array<{ stems?: string[]; words?: string[] }> = [...plain.map((w) => ({ stems: [w] })), ...concepts.map((c) => ({ words: c.words }))]
    if (!units.length) return []
    this.sql.exec('CREATE INDEX IF NOT EXISTS messages_role_at ON messages(role, created_at)')
    const like = (w: string): string => `%${w.replace(/[%_\\]/g, (c) => '\\' + c)}%`
    const patterns = units.flatMap((u) => [...(u.stems ?? []), ...(u.words ?? [])]).map(like)
    const notMine = NOT_OWN_WORDS.map((k) => `json_extract(m.data, '$.meta.${k}') IS NULL OR json_extract(m.data, '$.meta.${k}') IN (0, '')`).map((c) => `(${c})`).join(' AND ')
    // A cheap prefilter in SQL (any unit's letters anywhere, newest first), then whole-word scoring here.
    const rows = (this.sql.prepare(`WITH r AS (
        SELECT m.thread_id AS threadId, t.title AS title, m.content AS content, lower(m.content) AS lc, m.created_at AS at
        FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE m.role = 'user' AND m.kind = 'normal' AND m.status = 'done' AND t.space_id = ? AND m.thread_id != ? AND t.parent_id IS NULL
          AND length(m.content) BETWEEN 12 AND 20000 AND ${notMine}
        ORDER BY m.created_at DESC LIMIT 4000)
      SELECT threadId, title, content AS text, at FROM r WHERE ${patterns.map(() => "lc LIKE ? ESCAPE '\\'").join(' OR ')} ORDER BY at DESC LIMIT 300`)
      .all(here.spaceId, excludeThreadId, ...patterns) as Array<{ threadId: string; title: string; text: string; at: number }>)
      .map((r) => {
        const body = normalizeForRecall(r.text), title = normalizeForRecall(r.title ?? '')
        const hit = (t: string, u: typeof units[number]): boolean => (u.stems ?? []).some((st) => hasStem(t, st)) || (u.words ?? []).some((w) => hasWord(t, w))
        // A two-word phrase for the concept ("weekly report" for "weekly update") is as strong as two words.
        const weight = (u: typeof units[number]): number => (u.words ?? []).some((w) => w.includes(' ') && hasWord(body, w)) ? 2 : 1
        const inBody = units.filter((u) => hit(body, u)).reduce((n, u) => n + weight(u), 0)
        // The chat's title adds what the message itself doesn't say ("our flight" in the "Lisbon trip" chat), but
        // only for a message that matches on its own too.
        const inTitle = inBody ? units.filter((u) => !hit(body, u) && hit(title, u)).length : 0
        return { ...r, hits: inBody + inTitle }
      })
      .sort((a, b) => b.hits - a.hits || b.at - a.at)
    const words = units
    const need = Math.min(2, words.length)
    const out: Array<{ threadId: string; title: string; text: string; at: number }> = []
    const perThread = new Map<string, number>()
    const forgotten = this.forgottenNames().map((n) => new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'iu'))
    for (const r of rows) {
      if (r.hits < need) continue
      // Someone the user told SahilBot to forget (People & Places) isn't brought back by quoting old messages.
      // Whole words, in the message and its chat's title ("Dinner with Priya"); "Ann" never matches "planning".
      if (forgotten.length && forgotten.some((re) => re.test(r.text) || re.test(r.title ?? ''))) continue
      if ((perThread.get(r.threadId) ?? 0) >= 2) continue
      perThread.set(r.threadId, (perThread.get(r.threadId) ?? 0) + 1)
      out.push({ threadId: r.threadId, title: r.title, text: r.text.replace(/\s+/g, ' ').slice(0, 400), at: r.at })
      if (out.length >= limit) break
    }
    return out
  }

  /**
   * Names (and aliases) of the people, places and things the user forgot in People & Places and hasn't
   * undone, lowercased: a person's first name too ("Priya" for "Priya Patel"), since that's how they're
   * usually mentioned. Empty when the context engine has never run.
   */
  private forgottenNames(): string[] {
    try {
      const rows = this.sql.prepare("SELECT payload FROM ce_trash WHERE restored_at IS NULL AND label LIKE 'Forgot %' ORDER BY at DESC LIMIT 500").all() as Array<{ payload: string }>
      const names = new Set<string>()
      for (const r of rows) {
        let snap: { entity?: { name?: unknown; type?: unknown }; aliases?: Array<{ value?: unknown }> }
        try { snap = JSON.parse(r.payload) } catch { continue }
        const name = typeof snap.entity?.name === 'string' ? snap.entity.name.trim().toLowerCase() : ''
        if (name) names.add(name)
        if (name && snap.entity?.type === 'person') { const first = name.split(/\s+/)[0]; if (first.length >= 3) names.add(first) }
        for (const a of snap.aliases ?? []) if (typeof a.value === 'string' && a.value.trim().length >= 3) names.add(a.value.trim().toLowerCase())
      }
      return [...names]
    } catch { return [] }
  }

  searchThreads(q: string): Thread[] {
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`
    const rows = this.sql.prepare(`${this.threadSelect}
      WHERE t.parent_id IS NULL AND ${NOT_TRASHED} AND (t.title LIKE ? ESCAPE '\\' OR EXISTS (
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
    this.sql.prepare(`INSERT INTO threads(id, space_id, title, permission_mode, model, created_at, updated_at, parent_id, last_read_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(id, spaceId, 'New thread', mode, model, now, now, parentId, now)
    return this.getThread(id)!
  }

  /**
   * `unread` sets or clears the chat's own "marked unread" flag (the derived Thread.unread also counts replies
   * after lastReadAt). Clearing it reads the chat to now, like markRead().
   */
  updateThread(id: string, patch: Partial<Pick<Thread, 'title' | 'pinned' | 'unread' | 'permissionMode' | 'model' | 'spaceId' | 'effort'>>, touch = false): Thread {
    const cur = this.getThread(id)
    if (!cur) throw new Error(`No thread ${id}`)
    const n = { ...cur, ...patch }
    const flag = patch.unread !== undefined ? patch.unread : ((this.sql.prepare('SELECT unread FROM threads WHERE id = ?').get(id) as Row).unread === 1)
    this.sql.prepare(`UPDATE threads SET title=?, pinned=?, unread=?, permission_mode=?, model=?, space_id=?, effort=?, updated_at=? WHERE id=?`)
      .run(n.title, n.pinned ? 1 : 0, flag ? 1 : 0, n.permissionMode, n.model, n.spaceId, effortOrNull(n.effort), touch ? Date.now() : cur.updatedAt, id)
    if (patch.unread === false) this.sql.prepare('UPDATE threads SET last_read_at = MAX(COALESCE(last_read_at, 0), ?) WHERE id = ?').run(Date.now(), id)
    return this.getThread(id)!
  }

  /**
   * You've seen the chat up to `upTo` (the newest message on your screen; default and at most: now). Clears the
   * "marked unread" flag. Only ever moves forward, so repeating it (or a slower device) changes nothing.
   */
  markRead(id: string, upTo?: number): Thread {
    const now = Date.now()
    const at = typeof upTo === 'number' && Number.isFinite(upTo) && upTo > 0 ? Math.min(now, upTo) : now
    const r = this.sql.prepare('UPDATE threads SET unread = 0, last_read_at = MAX(COALESCE(last_read_at, created_at), ?) WHERE id = ?').run(at, id)
    if (!r.changes) throw new Error(`No thread ${id}`)
    return this.getThread(id)!
  }

  /**
   * You opened this bot: every conversation of its own (an older one from Start fresh, one another app started) is
   * read now, so its sidebar dot clears. Not for SahilBot itself or a project, whose chats each show their own dot.
   */
  markSpaceRead(spaceId: string): void {
    const s = this.getSpace(spaceId)
    if (!s || s.isMain || s.kind === 'project') return
    this.sql.prepare('UPDATE threads SET unread = 0, last_read_at = MAX(COALESCE(last_read_at, created_at), ?) WHERE space_id = ? AND parent_id IS NULL').run(Date.now(), spaceId)
  }

  /**
   * "Mark as Unread": the flag, and the read mark moved back to just before the bot's latest reply, so the
   * chat opens on a NEW divider there (like other chat apps).
   */
  markUnread(id: string): Thread {
    const last = this.sql.prepare(`SELECT MAX(m.created_at) AS at FROM messages m WHERE m.thread_id = ? AND m.role = 'assistant' AND m.kind = 'normal' AND m.content != ''
      AND IFNULL(json_extract(m.data, '$.meta.hidden'), 0) = 0 AND IFNULL(json_extract(m.data, '$.meta.superseded'), 0) = 0 AND IFNULL(json_extract(m.data, '$.meta.provisional'), 0) = 0 AND json_extract(m.data, '$.meta.routineNotice') IS NULL`).get(id) as { at: number | null } | undefined
    const r = this.sql.prepare('UPDATE threads SET unread = 1, last_read_at = CASE WHEN ? IS NULL THEN last_read_at ELSE MIN(COALESCE(last_read_at, created_at), ? - 1) END WHERE id = ?')
      .run(last?.at ?? null, last?.at ?? null, id)
    if (!r.changes) throw new Error(`No thread ${id}`)
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
    // A reply held for its checks when the app quit (or crashed) mid-run: no run will settle it now, so it shows.
    this.sql.prepare(`UPDATE messages SET data = json_remove(data, '$.meta.provisional') WHERE json_extract(data, '$.meta.provisional') IS NOT NULL`).run()
  }
}

/** Sidebar previews are plain text: drop internal markup, Markdown punctuation and extra whitespace. */
export function plain(md: string | null | undefined): string | undefined {
  if (!md) return undefined
  return stripDirectives(md).replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`#>|~]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

function dataOf(m: Message): Record<string, unknown> {
  const { reasoning, toolCalls, toolCallId, toolName, images, model, meta } = m
  return { reasoning, toolCalls, toolCallId, toolName, images, model, meta }
}

/** A bot icon: one emoji (or a couple of characters), nothing longer; anything else is no icon. */
export function cleanIcon(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t || t.length > 16 || /[<>{}\\/]/.test(t)) return null
  const chars = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t)]
  return chars.length <= 2 ? t : null
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
    icon: (r.icon as string | null) ?? null,
    label: (r.label as string | null) ?? null,
    // Notifications are automatic for every bot (no per-bot switch any more): it tells you when it finishes or needs you.
    notify: true,
    effort: effortOrNull(r.effort),
    createdAt: r.created_at as number
  }
}

/** A stored thinking choice ('auto' or a level), else null (inherit). */
function effortOrNull(v: unknown): EffortChoice | null {
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max' ? v : null
}

function basenameOf(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function toThread(r: Row): Thread {
  const unreadN = Math.min(UNREAD_CAP, (r.unread_n as number | undefined) ?? 0)
  return {
    id: r.id as string,
    spaceId: r.space_id as string,
    title: r.title as string,
    pinned: r.pinned === 1,
    // Marked unread, or replies you haven't seen.
    unread: r.unread === 1 || unreadN > 0,
    permissionMode: r.permission_mode as PermissionMode,
    model: (r.model as string | null) ?? null,
    effort: effortOrNull(r.effort),
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastPreview: plain(r.last_preview as string | null),
    parentId: (r.parent_id as string | null) ?? null,
    lastReadAt: (r.last_read_at as number | null) ?? (r.created_at as number),
    unreadCount: unreadN,
    ...(r.tool_mode === 'full' || r.tool_mode === 'chat' ? { toolMode: r.tool_mode } : {}),
    ...(r.by_user !== undefined ? { byUser: !!r.by_user } : {})
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
