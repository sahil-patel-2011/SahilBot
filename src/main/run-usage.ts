import type { RunUsage, RunUsageModel } from '@shared/types'
import type { Db } from './db'
import { cost } from './llm/budget'

// Tokens and cost of one run, for the end-of-run summary under the last reply: every model reply in the
// chat (and in its helper agents' hidden chats) since the run started, with the token counts the model
// server reported (meta.promptTokens / completionTokens). Cloud replies are priced the same way the
// budget guard prices them (llm/budget.ts cost()), so the line matches Settings → Usage.

/** The chat and every helper chat under it (helpers can start helpers). */
function family(db: Db, threadId: string): string[] {
  const out = [threadId]
  for (let i = 0; i < out.length && out.length < 200; i++) {
    const kids = db.sql.prepare('SELECT id FROM threads WHERE parent_id = ?').all(out[i]) as unknown as Array<{ id: string }>
    for (const k of kids) if (!out.includes(k.id)) out.push(k.id)
  }
  return out
}

export function runUsage(db: Db, threadId: string, since: number, until: number | undefined, isCloud: (model: string) => boolean): RunUsage {
  const ids = family(db, String(threadId))
  const end = typeof until === 'number' && until > 0 ? until : Number.MAX_SAFE_INTEGER
  const rows = db.sql.prepare(`
    SELECT json_extract(data, '$.model') AS model,
      COALESCE(json_extract(data, '$.meta.promptTokens'), 0) AS input, COALESCE(json_extract(data, '$.meta.completionTokens'), 0) AS output
    FROM messages WHERE role = 'assistant' AND created_at >= ? AND created_at <= ? AND thread_id IN (${ids.map(() => '?').join(',')})`)
    .all(Number(since) || 0, end, ...ids) as unknown as Array<{ model: string | null; input: number; output: number }>
  const by = new Map<string, RunUsageModel>()
  const cloudOf = new Map<string, boolean>()
  for (const r of rows) {
    const input = Number(r.input) || 0
    const output = Number(r.output) || 0
    if (!input && !output) continue
    const model = typeof r.model === 'string' && r.model ? r.model : 'unknown'
    if (!cloudOf.has(model)) { let c = false; try { c = model !== 'unknown' && isCloud(model) } catch { c = false } cloudOf.set(model, c) }
    const cloud = cloudOf.get(model)!
    const m = by.get(model) ?? { model, cloud, calls: 0, input: 0, output: 0, usd: 0 }
    m.calls++
    m.input += input
    m.output += output
    if (cloud) { try { m.usd += cost(model, input, output) } catch { /* unknown price */ } }
    by.set(model, m)
  }
  const models = [...by.values()].sort((a, b) => b.input + b.output - (a.input + a.output))
  return {
    input: models.reduce((s, m) => s + m.input, 0),
    output: models.reduce((s, m) => s + m.output, 0),
    usd: models.reduce((s, m) => s + m.usd, 0),
    cloud: models.some((m) => m.cloud),
    calls: models.reduce((s, m) => s + m.calls, 0),
    models
  }
}
