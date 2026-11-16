import type { Db } from '../db'
import type { ModelInfo } from '@shared/types'
import type { TaskCategory } from './task-classifier'

type Row = Record<string, unknown>
export interface OutcomeSample { model: string; category: TaskCategory; verified: boolean; success: boolean; latencyMs: number; usd: number; at?: number }
export interface ModelOutcome { model: string; n: number; successes: number; verified: number; latencyMs: number; usd: number; reliability: number }

/** Local, version-specific evidence. Tables remain the cold-start baseline. */
export class OutcomeRouter {
  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS routing_outcomes (
      id INTEGER PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      model TEXT NOT NULL, category TEXT NOT NULL, verified INTEGER NOT NULL, success INTEGER NOT NULL,
      latency_ms REAL NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routing_outcomes_model ON routing_outcomes(model,category,at);`)
  }
  record(s: OutcomeSample, threadId?: string): void {
    this.db.sql.prepare('INSERT INTO routing_outcomes(thread_id,model,category,verified,success,latency_ms,usd,at) VALUES(?,?,?,?,?,?,?,?)').run(threadId ?? null, s.model, s.category, s.verified ? 1 : 0, s.success ? 1 : 0, Math.max(0, s.latencyMs), Math.max(0, s.usd), s.at ?? this.now())
  }
  stats(category?: TaskCategory): ModelOutcome[] {
    const rows = (category
      ? this.db.sql.prepare('SELECT * FROM routing_outcomes WHERE category=? AND at>?').all(category, this.now() - 30 * 86400000)
      : this.db.sql.prepare('SELECT * FROM routing_outcomes WHERE at>?').all(this.now() - 30 * 86400000)) as Row[]
    const out = new Map<string, ModelOutcome>()
    for (const r of rows) {
      if (r.success && !r.verified) continue
      const model = String(r.model), x = out.get(model) ?? { model, n: 0, successes: 0, verified: 0, latencyMs: 0, usd: 0, reliability: 0 }
      x.n++; if (r.success) x.successes++; if (r.verified) x.verified++; x.latencyMs += Number(r.latency_ms); x.usd += Number(r.usd); out.set(model, x)
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
