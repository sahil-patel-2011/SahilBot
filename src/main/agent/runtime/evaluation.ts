import { randomUUID } from 'node:crypto'
import type { Db } from '../../db'
import type { ToolContext, ToolDef } from '../types'
import type { RuntimeStore } from './store'

export interface ReplayResult { model: string; answer: string; latencyMs: number; usd: number; tools: string[]; errors: string[] }
export function evaluationTool(db: Db, store: RuntimeStore, host: { replay(runId: string, models: string[], ctx: ToolContext): Promise<ReplayResult[]>; profiles(): unknown }): ToolDef<{ action: string; run_id?: string; models?: string[]; contains?: string[]; required_tools?: string[]; baseline_id?: string }> {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS agent_evaluations (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, result TEXT NOT NULL, at INTEGER NOT NULL);`)
  return {
    name: 'agent_evaluate', label: 'Evaluation workbench', group: 'Agent system', effect: 'read', available: (state) => !state.depth,
    description: 'Inspect routing outcome profiles, list previous task evaluations, or replay a task against up to 3 available models. Replays use captured tool observations and NEVER execute live tools or external writes. Supply contains and required_tools to grade the answer and behavior; without them the replay is exploratory, not a passing test. Each replay run has a $1 ceiling (and inherits tighter task/monthly limits). Optionally compare against baseline_id. No private data crosses an Auto (local) boundary.',
    parameters: { type: 'object', properties: { action: { enum: ['profiles', 'list', 'replay'] }, run_id: { type: 'string' }, models: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }, contains: { type: 'array', maxItems: 30, items: { type: 'string' } }, required_tools: { type: 'array', maxItems: 30, items: { type: 'string' } }, baseline_id: { type: 'string' } }, required: ['action'], additionalProperties: false },
    async run(a, ctx) {
      if (a.action === 'profiles') { const data = host.profiles(); return { text: JSON.stringify(data, null, 2), data } }
      if (a.action === 'list') {
        const rows = db.sql.prepare('SELECT id,run_id,result,at FROM agent_evaluations WHERE thread_id=? ORDER BY at DESC LIMIT 30').all(ctx.threadId)
        return { text: JSON.stringify(rows, null, 2), data: rows }
      }
      const run = a.run_id && store.get(a.run_id)
      if (!run || run.threadId !== ctx.threadId) throw new Error('Choose a recorded run from this chat.')
      if (!a.models?.length) throw new Error('Choose the available model ids to compare.')
      const replays = await host.replay(run.id, [...new Set(a.models)], ctx)
      const graded = replays.map((r) => {
        const missingText = (a.contains ?? []).filter((s) => !r.answer.includes(s))
        const missingTools = (a.required_tools ?? []).filter((s) => !r.tools.includes(s))
        return { ...r, missingText, missingTools, passed: (a.contains?.length || a.required_tools?.length) ? !r.errors.length && !missingText.length && !missingTools.length : null }
      })
      let baseline: unknown
      if (a.baseline_id) {
        const row = db.sql.prepare('SELECT result FROM agent_evaluations WHERE id=? AND thread_id=?').get(a.baseline_id, ctx.threadId) as { result: string } | undefined
        if (!row) throw new Error('Baseline not found in this chat.')
        baseline = JSON.parse(row.result)
      }
      const id = randomUUID(), data = { id, runId: run.id, kind: 'recorded-tool-replay', results: graded, baseline, note: 'Simulated observations; not proof about live external state.' }
      db.sql.prepare('INSERT INTO agent_evaluations VALUES(?,?,?,?,?)').run(id, ctx.threadId, run.id, JSON.stringify(data), Date.now())
      return { text: JSON.stringify(data, null, 2), data, display: `${graded.filter((r) => r.passed).length}/${graded.length} evaluations passed` }
    }
  }
}
