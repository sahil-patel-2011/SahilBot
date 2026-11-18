import type { Db } from '../db'
import type { ModelInfo } from '@shared/types'
import type { TaskCategory } from './task-classifier'

type Row = Record<string, unknown>
export interface OutcomeSample { model: string; category: TaskCategory; verified: boolean; success: boolean; latencyMs: number; usd: number; at?: number }
export interface ModelOutcome {
  model: string; n: number; successes: number; verified: number; latencyMs: number; usd: number; reliability: number
  /** The user's own verdicts in the window: answers they kept going happily with, and ones they turned down. */
  userGood: number
  userBad: number
}

/**
 * What the user did about an Auto answer, the clearest signal of whether Auto picked well:
 *   switch    picked another model by name for the chat right after Auto's answer (or mid-run);
 *   retry     regenerated the answer;
 *   reaction  reacted to the answer (a thumbs-down or a thumbs-up, and the like);
 *   words     said so in the next message ("that's wrong", "doesn't work" / "thanks, perfect").
 */
export type VerdictSource = 'switch' | 'retry' | 'reaction' | 'words'
export interface Verdict { threadId: string; messageId: string; model: string; category: TaskCategory; good: boolean; source: VerdictSource; at?: number }

/** Outcomes older than this don't count (the models and the app change). */
export const OUTCOME_WINDOW_MS = 30 * 86400000
/** At most this many of the user's verdicts count per model and category (the latest): one bad day can't bury a model. */
export const USER_VERDICT_CAP = 10

/** Local, version-specific evidence. Tables remain the cold-start baseline. */
export class OutcomeRouter {
  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS routing_outcomes (
      id INTEGER PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      model TEXT NOT NULL, category TEXT NOT NULL, verified INTEGER NOT NULL, success INTEGER NOT NULL,
      latency_ms REAL NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_outcomes_model ON routing_outcomes(model,category,at);`)
    // The request an outcome belongs to, and who judged it ('run': the run's own checks; else a VerdictSource).
    const cols = new Set((db.sql.prepare('PRAGMA table_info(routing_outcomes)').all() as Row[]).map((r) => String(r.name)))
    if (!cols.has('message_id')) db.sql.exec('ALTER TABLE routing_outcomes ADD COLUMN message_id TEXT')
    if (!cols.has('source')) db.sql.exec("ALTER TABLE routing_outcomes ADD COLUMN source TEXT NOT NULL DEFAULT 'run'")
    if (!cols.has('prior')) db.sql.exec('ALTER TABLE routing_outcomes ADD COLUMN prior TEXT')
  }
  record(s: OutcomeSample, threadId?: string, messageId?: string): void {
    this.db.sql.prepare('INSERT INTO routing_outcomes(thread_id,model,category,verified,success,latency_ms,usd,at,message_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)').run(threadId ?? null, s.model, s.category, s.verified ? 1 : 0, s.success ? 1 : 0, Math.max(0, s.latencyMs), Math.max(0, s.usd), s.at ?? this.now(), messageId ?? null, 'run')
  }
  /**
   * The user's verdict on one Auto answer, keyed by the request it answered. It takes the place of that request's own
   * run outcome (one row per answer: a thumbs-down then a retry is still one bad answer; the latest verdict wins), or
   * is added when the run left none. A regenerated answer is a new run with its own outcome.
   */
  verdict(v: Verdict): void {
    if (!v.model || !v.messageId) return
    const row = this.db.sql.prepare('SELECT id, success, verified, source, prior FROM routing_outcomes WHERE thread_id=? AND message_id=? AND model=? ORDER BY at DESC, id DESC LIMIT 1').get(v.threadId, v.messageId, v.model) as Row | undefined
    if (row) {
      // The run's own outcome is kept aside, so a verdict taken back (a reaction removed) restores it.
      const prior = row.prior ?? (String(row.source) === 'run' ? JSON.stringify({ success: Number(row.success), verified: Number(row.verified) }) : null)
      this.db.sql.prepare('UPDATE routing_outcomes SET success=?, verified=1, source=?, category=?, prior=? WHERE id=?').run(v.good ? 1 : 0, v.source, v.category, prior as string | null, row.id as number)
      return
    }
    this.db.sql.prepare('INSERT INTO routing_outcomes(thread_id,model,category,verified,success,latency_ms,usd,at,message_id,source) VALUES(?,?,?,?,?,?,?,?,?,?)').run(v.threadId, v.model, v.category, 1, v.good ? 1 : 0, 0, 0, v.at ?? this.now(), v.messageId, v.source)
  }
  /** Takes back the user's verdict from one source (a reaction removed): the run's own outcome again, if it had one. */
  clearVerdict(threadId: string, messageId: string, model: string, source: VerdictSource): void {
    const row = this.db.sql.prepare('SELECT id, prior FROM routing_outcomes WHERE thread_id=? AND message_id=? AND model=? AND source=? ORDER BY at DESC, id DESC LIMIT 1').get(threadId, messageId, model, source) as Row | undefined
    if (!row) return
    let prior: { success?: number; verified?: number } | undefined
    try { prior = row.prior ? JSON.parse(String(row.prior)) as typeof prior : undefined } catch { prior = undefined }
    if (prior) this.db.sql.prepare("UPDATE routing_outcomes SET success=?, verified=?, source='run', prior=NULL WHERE id=?").run(prior.success ? 1 : 0, prior.verified ? 1 : 0, row.id as number)
    else this.db.sql.prepare('DELETE FROM routing_outcomes WHERE id=?').run(row.id as number)
  }
  stats(category?: TaskCategory): ModelOutcome[] {
    const since = this.now() - OUTCOME_WINDOW_MS
    const rows = (category
      ? this.db.sql.prepare('SELECT * FROM routing_outcomes WHERE category=? AND at>? ORDER BY at DESC, id DESC').all(category, since)
      : this.db.sql.prepare('SELECT * FROM routing_outcomes WHERE at>? ORDER BY at DESC, id DESC').all(since)) as Row[]
    const userSeen = new Map<string, number>()
    const out = new Map<string, ModelOutcome>()
    for (const r of rows) {
      const user = String(r.source ?? 'run') !== 'run'
      // The latest USER_VERDICT_CAP of the user's verdicts per model and category count.
      if (user) {
        const k = `${r.model}|${r.category}`
        const seen = userSeen.get(k) ?? 0
        if (seen >= USER_VERDICT_CAP) continue
        userSeen.set(k, seen + 1)
      }
      if (r.success && !r.verified) continue
      const model = String(r.model), x = out.get(model) ?? { model, n: 0, successes: 0, verified: 0, latencyMs: 0, usd: 0, reliability: 0, userGood: 0, userBad: 0 }
      x.n++; if (r.success) x.successes++; if (r.verified) x.verified++
      if (user) { if (r.success) x.userGood++; else x.userBad++ }
      x.latencyMs += Number(r.latency_ms); x.usd += Number(r.usd); out.set(model, x)
    }
    return [...out.values()].map((x) => ({ ...x, latencyMs: x.latencyMs / x.n, usd: x.usd / x.n, reliability: (x.successes + 2) / (x.n + 4) }))
  }
  pick(baseline: ModelInfo, pool: ModelInfo[], category: TaskCategory, preference: string): { model: ModelInfo; why: string } | undefined {
    const stats = this.stats(category), base = stats.find((s) => s.model === baseline.id)
    // Never infer quality from unverified successful answers. At least eight measured tasks per model.
    if (!base || base.n < 8 || base.verified < 5) return undefined
    const eligible = pool.map((model) => ({ model, s: stats.find((s) => s.model === model.id) })).filter((x): x is { model: ModelInfo; s: ModelOutcome } => !!x.s && x.s.n >= 8 && x.s.verified >= 5 && x.model.tier >= baseline.tier && x.s.reliability >= base.reliability - 0.02)
    const score = (s: ModelOutcome): number => s.reliability * 10 - (preference === 'best' ? 0 : Math.log1p(s.usd * 100) * (preference === 'cheapest' ? 0.5 : 0.15)) - Math.log1p(s.latencyMs / 1000) * 0.1
    eligible.sort((a, b) => score(b.s) - score(a.s))
    const best = eligible[0]
    return best && best.model.id !== baseline.id && score(best.s) > score(base) + 0.1 ? { model: best.model, why: `local outcome history: ${best.s.successes}/${best.s.n} successful tasks, ${best.s.verified} verified; same model version` } : undefined
  }
  reset(model?: string): void { if (model) this.db.sql.prepare('DELETE FROM routing_outcomes WHERE model=?').run(model); else this.db.sql.prepare('DELETE FROM routing_outcomes').run() }
}

/**
 * The brain prompt's "How models did on this Mac lately" lines for a category: the models with enough history
 * (3+ outcomes, or 2+ answers the user turned down), most measured first, at most `max` lines.
 */
export function outcomeLines(stats: ModelOutcome[], categoryLabel: string, max = 5): string[] {
  return stats.filter((o) => o.n >= 3 || o.userBad >= 2).sort((a, b) => b.n - a.n || b.userBad - a.userBad).slice(0, max).map((o) => {
    const user = [o.userBad ? `the user turned down ${o.userBad}` : '', o.userGood ? `kept ${o.userGood}` : ''].filter(Boolean).join(', ')
    return `- ${o.model}: ${o.successes}/${o.n} done well (${o.verified} checked${user ? `; ${user}` : ''}) on ${categoryLabel}`
  })
}

/** A short reply that says the last answer was wrong or didn't work. */
const NEGATIVE = /^(no[,.!]*\s+)?((that'?s|this is|it'?s|that is|this'?s) (wrong|incorrect|not (right|correct|it|what i (asked|wanted|meant))|completely wrong|totally wrong)|(wrong|incorrect|nope)\b|(it |that |this )?(still )?(doesn'?t|does not|didn'?t|did not) work\b|(it'?s |that'?s )?still (broken|wrong|failing|not working)\b|you (got it wrong|misunderstood|didn'?t (read|understand|answer))|not what i (asked|wanted|meant))/
/** A short reply that says the last answer worked ("thanks, perfect", "that worked"). */
const POSITIVE = /^((ok(ay)?|great|perfect|awesome|amazing|excellent|nice|cool)[,!. ]+)?((thanks|thank you|thx|ty)\b|perfect\b|exactly\b|that (worked|works|did it|fixed it)|it works( now)?\b|works( now| great| perfectly)?[!. ]*$|that'?s (perfect|exactly (it|right|what i (needed|wanted)))|great job|well done|nailed it|love it)/
const NEGATIVE_EMOJI = new Set(['👎', '😡', '😠', '🤬', '😞', '😕', '🙁', '☹️', '❌', '💩'])
const POSITIVE_EMOJI = new Set(['👍', '❤️', '❤', '🎉', '🙏', '😍', '💯', '🔥', '✅', '😄', '😊', '🥳', '👏', '⭐', '🤩'])

/** The verdict a reply's words carry about the answer right before it (undefined: none, or not clear). */
export function verdictFromWords(text: string): boolean | undefined {
  const t = (text ?? '').trim().toLowerCase().replace(/[’]/g, "'")
  if (!t || t.split(/\s+/).length > 25) return undefined
  if (NEGATIVE.test(t)) return false
  // "thanks, now also add X" asks for more: still a good answer, the request after it is new.
  if (POSITIVE.test(t)) return true
  return undefined
}

/** The verdict a reaction carries (undefined: neither clearly good nor bad). */
export function verdictFromEmoji(emoji: string | null | undefined): boolean | undefined {
  if (!emoji) return undefined
  if (NEGATIVE_EMOJI.has(emoji)) return false
  if (POSITIVE_EMOJI.has(emoji)) return true
  return undefined
}
