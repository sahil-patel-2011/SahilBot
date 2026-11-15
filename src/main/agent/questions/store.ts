import { createHash, randomUUID } from 'node:crypto'
import type { NeedsYouItem, QueueQuestion } from '@shared/types'
import type { Db } from '../../db'

// The question queue lives in the `bot_questions` table, so it survives restarts: what a bot asked, by
// when, what was answered (and by whom: the user or the deadline's default), and whether the bot has
// been told yet ("resumed"). Approvals carry a one-time grant for the exact call the user approved.

type Row = Record<string, unknown>

export interface StoredApproval {
  tool: string
  label: string
  summary?: string
  reason?: string
  /** Pretty-printed arguments for the inbox card. */
  args?: string
  /** Hash of the call's canonical arguments: the grant matches only this exact call. */
  argsKey: string
}

export interface StoredItem {
  id: string
  botId: string
  threadId: string
  kind: 'question' | 'approval'
  questions: QueueQuestion[]
  approval?: StoredApproval
  status: NeedsYouItem['status']
  answers: string[]
  answeredBy: 'user' | 'default' | null
  /** Why a deadline never answers it (a hard stop), or null. */
  hardStop: string | null
  deadline: number | null
  /** The deadline passed with no safe default (it keeps waiting). */
  expired: boolean
  review: boolean
  /** The bot has been given the answer (a resumed or steered run). */
  resumed: boolean
  /** Posted by a run that had read outside content: its answers are never learned as preferences. */
  tainted: boolean
  /** The run that posted it, so a second question from the same run joins the same card. */
  runKey: string | null
  grantUsed: boolean
  /** Why resuming is on hold (over the spending limit), if it is. */
  heldFor: string | null
  createdAt: number
  answeredAt: number | null
  updatedAt: number
}

const json = <T>(v: unknown, fallback: T): T => {
  try { return (typeof v === 'string' ? JSON.parse(v) : fallback) as T } catch { return fallback }
}

const toItem = (r: Row): StoredItem => {
  const payload = json<{ questions?: QueueQuestion[]; approval?: StoredApproval }>(r.payload, {})
  return {
    id: r.id as string,
    botId: r.space_id as string,
    threadId: r.thread_id as string,
    kind: r.kind === 'approval' ? 'approval' : 'question',
    questions: payload.questions ?? [],
    ...(payload.approval ? { approval: payload.approval } : {}),
    status: (r.status as StoredItem['status']) ?? 'open',
    answers: json<string[]>(r.answers, []),
    answeredBy: (r.answered_by as StoredItem['answeredBy']) ?? null,
    hardStop: (r.hard_stop as string | null) ?? null,
    deadline: (r.deadline as number | null) ?? null,
    expired: !!r.expired,
    review: !!r.review,
    resumed: !!r.resumed,
    tainted: !!r.tainted,
    runKey: (r.run_key as string | null) ?? null,
    grantUsed: !!r.grant_used,
    heldFor: (r.held_for as string | null) ?? null,
    createdAt: r.created_at as number,
    answeredAt: (r.answered_at as number | null) ?? null,
    updatedAt: r.updated_at as number
  }
}

/** Canonical JSON (sorted keys) of a call's arguments, hashed: the same call always gets the same key. */
export function argsKey(tool: string, args: string | unknown): string {
  let v: unknown = args
  if (typeof args === 'string') { try { v = JSON.parse(args) } catch { v = args } }
  const canon = (x: unknown): unknown => Array.isArray(x) ? x.map(canon) : x && typeof x === 'object'
    ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])])) : x
  return createHash('sha1').update(`${tool}\n${JSON.stringify(canon(v))}`).digest('hex').slice(0, 24)
}

/** How long an approved call stays approved, waiting for the bot to make it. */
export const GRANT_TTL_MS = 7 * 24 * 3_600_000

export class QuestionStore {
  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS bot_questions (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, thread_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'question',
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'open', answers TEXT NOT NULL DEFAULT '[]', answered_by TEXT,
      hard_stop TEXT, deadline INTEGER, expired INTEGER NOT NULL DEFAULT 0, review INTEGER NOT NULL DEFAULT 0,
      resumed INTEGER NOT NULL DEFAULT 0, tainted INTEGER NOT NULL DEFAULT 0, run_key TEXT, grant_used INTEGER NOT NULL DEFAULT 0,
      held_for TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, updated_at INTEGER NOT NULL)`)
    db.sql.exec('CREATE INDEX IF NOT EXISTS bot_questions_status ON bot_questions(status, deadline)')
    db.sql.exec('CREATE INDEX IF NOT EXISTS bot_questions_thread ON bot_questions(thread_id)')
    db.sql.exec(`CREATE TABLE IF NOT EXISTS learned_answers (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, key TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
      question_id TEXT, memory_id TEXT, created_at INTEGER NOT NULL)`)
    db.sql.exec('CREATE INDEX IF NOT EXISTS learned_answers_space ON learned_answers(space_id)')
  }

  get(id: string): StoredItem | undefined {
    const r = this.db.sql.prepare('SELECT * FROM bot_questions WHERE id = ?').get(id) as Row | undefined
    return r ? toItem(r) : undefined
  }

  /** Items, newest first: by status (default all), bot or chat. */
  list(o: { status?: StoredItem['status'][]; botId?: string; threadId?: string; limit?: number } = {}): StoredItem[] {
    const where: string[] = []
    const args: Array<string | number> = []
    if (o.status?.length) { where.push(`status IN (${o.status.map(() => '?').join(',')})`); args.push(...o.status) }
    if (o.botId) { where.push('space_id = ?'); args.push(o.botId) }
    if (o.threadId) { where.push('thread_id = ?'); args.push(o.threadId) }
    const sql = `SELECT * FROM bot_questions${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, o.limit ?? 500))}`
    return (this.db.sql.prepare(sql).all(...args) as Row[]).map(toItem)
  }

  insert(x: Omit<StoredItem, 'id' | 'createdAt' | 'updatedAt' | 'answeredAt' | 'status' | 'answers' | 'answeredBy' | 'expired' | 'review' | 'resumed' | 'grantUsed' | 'heldFor'>): StoredItem {
    const id = `q${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const at = this.now()
    this.db.sql.prepare(`INSERT INTO bot_questions(id, space_id, thread_id, kind, payload, hard_stop, deadline, tainted, run_key, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, x.botId, x.threadId, x.kind, JSON.stringify({ questions: x.questions, ...(x.approval ? { approval: x.approval } : {}) }),
      x.hardStop, x.deadline, x.tainted ? 1 : 0, x.runKey, at, at)
    return this.get(id)!
  }

  save(x: StoredItem): StoredItem {
    this.db.sql.prepare(`UPDATE bot_questions SET payload=?, status=?, answers=?, answered_by=?, hard_stop=?, deadline=?, expired=?, review=?,
      resumed=?, tainted=?, grant_used=?, held_for=?, answered_at=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify({ questions: x.questions, ...(x.approval ? { approval: x.approval } : {}) }), x.status, JSON.stringify(x.answers), x.answeredBy,
        x.hardStop, x.deadline, x.expired ? 1 : 0, x.review ? 1 : 0, x.resumed ? 1 : 0, x.tainted ? 1 : 0, x.grantUsed ? 1 : 0, x.heldFor, x.answeredAt, this.now(), x.id)
    return this.get(x.id)!
  }

  update(id: string, fn: (x: StoredItem) => void): StoredItem | undefined {
    const x = this.get(id)
    if (!x) return undefined
    fn(x)
    return this.save(x)
  }

  /** Open items whose deadline has passed and that haven't been handled at that deadline yet. */
  due(now: number): StoredItem[] {
    return (this.db.sql.prepare(`SELECT * FROM bot_questions WHERE status = 'open' AND expired = 0 AND deadline IS NOT NULL AND deadline <= ? ORDER BY deadline`).all(now) as Row[]).map(toItem)
  }

  /** Answered (or defaulted) items the bot hasn't been told about yet. */
  unresumed(): StoredItem[] {
    return (this.db.sql.prepare(`SELECT * FROM bot_questions WHERE status IN ('answered','defaulted') AND resumed = 0 ORDER BY answered_at`).all() as Row[]).map(toItem)
  }

  /** An approved, unused grant for exactly this call in this chat (approved within GRANT_TTL_MS). */
  grantFor(threadId: string, key: string): StoredItem | undefined {
    const rows = this.db.sql.prepare(`SELECT * FROM bot_questions WHERE thread_id = ? AND kind = 'approval' AND status = 'answered' AND grant_used = 0 AND answered_at >= ?`)
      .all(threadId, this.now() - GRANT_TTL_MS) as Row[]
    return rows.map(toItem).find((x) => x.approval?.argsKey === key && x.answers[0] === 'approve')
  }

  // ---- learned answers (preferences the user answered once)

  learned(botId: string): Array<{ id: string; key: string; question: string; answer: string; questionId: string | null; memoryId: string | null; createdAt: number }> {
    return (this.db.sql.prepare('SELECT * FROM learned_answers WHERE space_id = ? ORDER BY created_at DESC LIMIT 500').all(botId) as Row[]).map((r) => ({
      id: r.id as string, key: r.key as string, question: r.question as string, answer: r.answer as string,
      questionId: (r.question_id as string | null) ?? null, memoryId: (r.memory_id as string | null) ?? null, createdAt: r.created_at as number
    }))
  }

  learn(botId: string, key: string, question: string, answer: string, questionId: string | null, memoryId: string | null): void {
    // One answer per question: a newer answer replaces the old one.
    this.db.sql.prepare('DELETE FROM learned_answers WHERE space_id = ? AND key = ?').run(botId, key)
    this.db.sql.prepare('INSERT INTO learned_answers(id, space_id, key, question, answer, question_id, memory_id, created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(`l${randomUUID().replace(/-/g, '').slice(0, 10)}`, botId, key, question.slice(0, 500), answer.slice(0, 500), questionId, memoryId, this.now())
  }

  forgetLearned(id: string): void {
    this.db.sql.prepare('DELETE FROM learned_answers WHERE id = ?').run(id)
  }
}
