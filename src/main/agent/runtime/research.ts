import { randomUUID } from 'node:crypto'
import type { Db } from '../../db'

export interface ClaimEvidence { actionId: string; url: string; quote: string; stance: 'supports' | 'contradicts'; publishedAt?: number; eventAt?: number; primary?: boolean }
export interface ResearchClaim { id: string; text: string; consequential: boolean; maxAgeMs?: number; evidence: ClaimEvidence[]; status: 'unsupported' | 'supported' | 'corroborated' | 'disputed' | 'stale' }
type Row = Record<string, unknown>
export class ResearchStore {
  constructor(private db: Db, private now: () => number = Date.now) {
    db.sql.exec(`CREATE TABLE IF NOT EXISTS research_claims (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, text TEXT NOT NULL, consequential INTEGER NOT NULL, max_age_ms REAL, evidence TEXT NOT NULL DEFAULT '[]');`)
  }
  add(runId: string, text: string, consequential = false, maxAgeMs?: number): string {
    if (!text.trim() || text.length > 1500) throw new Error('Claims need 1–1500 characters.')
    const id = randomUUID(); this.db.sql.prepare('INSERT INTO research_claims(id,run_id,text,consequential,max_age_ms) VALUES(?,?,?,?,?)').run(id, runId, text, consequential ? 1 : 0, maxAgeMs ?? null); return id
  }
  attach(runId: string, claimId: string, e: ClaimEvidence): void {
    const claim = this.list(runId).find((c) => c.id === claimId)
    if (!claim) throw new Error('Claim not found in this run.')
    const action = this.db.sql.prepare("SELECT output FROM agent_actions WHERE id=? AND run_id=? AND status='done'").get(e.actionId, runId) as Row | undefined
    const output = action ? JSON.parse(String(action.output)) : undefined
    // A model cannot manufacture evidence: exact quotation and URL must both occur in retrieved output.
    if (!output || !e.quote.trim() || e.quote.length < 12 || !(output.text.includes(e.quote) || JSON.stringify(output.data ?? null).includes(e.quote)) || !(output.sources?.some((s: { url: string }) => s.url === e.url) || output.text.includes(e.url))) throw new Error('Evidence must quote an actual retrieved action and its source URL.')
    if (!/^https?:\/\//.test(e.url)) throw new Error('Evidence needs an HTTP(S) source URL.')
    const ev = [...claim.evidence.filter((x) => !(x.actionId === e.actionId && x.url === e.url && x.stance === e.stance)), { ...e, quote: e.quote.slice(0, 2000) }]
    this.db.sql.prepare('UPDATE research_claims SET evidence=? WHERE id=? AND run_id=?').run(JSON.stringify(ev), claimId, runId)
  }
  list(runId: string): ResearchClaim[] {
    return (this.db.sql.prepare('SELECT * FROM research_claims WHERE run_id=? ORDER BY rowid').all(runId) as Row[]).map((r) => {
      const evidence = JSON.parse(String(r.evidence)) as ClaimEvidence[]
      const maxAgeMs = r.max_age_ms === null ? undefined : Number(r.max_age_ms)
      const fresh = evidence.filter((e) => !maxAgeMs || (e.publishedAt !== undefined && e.publishedAt <= this.now() && this.now() - e.publishedAt <= maxAgeMs))
      const support = fresh.filter((e) => e.stance === 'supports'), contra = fresh.some((e) => e.stance === 'contradicts')
      // Independent origins are a conservative proxy, not proof that reporting is independent.
      const origins = new Set(support.map((e) => new URL(e.url).hostname.replace(/^www\./, '')))
      const status: ResearchClaim['status'] = contra ? 'disputed' : !fresh.length && evidence.length ? 'stale' : origins.size >= 2 ? 'corroborated' : support.length ? 'supported' : 'unsupported'
      return { id: String(r.id), text: String(r.text), consequential: !!r.consequential, maxAgeMs, evidence, status }
    })
  }
}
export function freshnessFor(text: string): number | undefined { return /\b(latest|current|today|right now|breaking|news|price|weather|recent)\b/i.test(text) ? 24 * 60 * 60 * 1000 : undefined }
