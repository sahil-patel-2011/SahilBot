import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../db'
import { git, gitRoot } from '../../code/git'
import type { ToolContext, ToolDef, ToolOutput } from '../types'
import { digest } from './store'

export interface AgentTask { id: string; title: string; task: string; dependsOn?: string[]; model?: string; isolation?: 'read' | 'worktree' }
export interface AgentTaskResult { id: string; status: 'done' | 'failed' | 'blocked'; report: string; childId?: string; folder?: string; model?: string }
export interface GraphHost { worker(task: AgentTask, context: string, ctx: ToolContext, folder?: string): Promise<AgentTaskResult> }

export async function isolatedWorktree(folder: string, workspace: string, signal?: AbortSignal): Promise<{ path: string; baseline: string; dirty: boolean }> {
  const root = await gitRoot(folder, signal)
  const baseline = (await git(root, ['rev-parse', 'HEAD'], { signal })).trim()
  const dirty = !!(await git(root, ['status', '--porcelain'], { signal })).trim()
  const parent = join(workspace, '.agent-workers'); mkdirSync(parent, { recursive: true })
  const path = join(parent, randomUUID())
  await git(root, ['worktree', 'add', '--detach', path, baseline], { signal, timeoutMs: 30000 })
  return { path, baseline, dirty }
}

export function taskGraphTool(db: Db, host: GraphHost): ToolDef<{ id?: string; tasks?: AgentTask[] }> {
  db.sql.exec(`CREATE TABLE IF NOT EXISTS agent_task_graphs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, tasks TEXT NOT NULL, results TEXT NOT NULL DEFAULT '[]');`)
  return {
    name: 'task_graph', label: 'Agent swarm', group: 'Agent system', effect: 'write_local',
    description: 'Run dependent specialist agents, each with its own model if useful. tasks have id,title,task,dependsOn and optional model/isolation. read workers have read-only tools; worktree workers edit separate Git checkouts from committed HEAD, never the lead’s working tree. Dependency reports are passed to successors. Completed nodes survive interruption; resume with id. Inspect the reported checkout/diff before merging through the normal git/code tools. Dirty/untracked parent changes are not copied.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, tasks: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, title: { type: 'string' }, task: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } }, model: { type: 'string' }, isolation: { enum: ['read', 'worktree'] } }, required: ['id', 'title', 'task'], additionalProperties: false } } }, additionalProperties: false },
    async run(a, ctx): Promise<ToolOutput> {
      if (ctx.state.depth) throw new Error('Only the lead can start a task graph.')
      let tasks = a.tasks, prior: AgentTaskResult[] = [], id = a.id ?? randomUUID()
      if (a.id) {
        const r = db.sql.prepare('SELECT * FROM agent_task_graphs WHERE id=? AND thread_id=?').get(a.id, ctx.threadId) as { tasks: string; results: string } | undefined
        if (!r || a.tasks) throw new Error('Resume an existing graph with only its id in this chat.')
        tasks = JSON.parse(r.tasks); prior = JSON.parse(r.results)
      }
      if (!tasks?.length) throw new Error('Provide tasks or a graph id.')
      const { validateGraph } = await import('./workflow')
      validateGraph(tasks.map((t) => ({ ...t, op: 'call' as const })))
      db.sql.prepare('INSERT OR IGNORE INTO agent_task_graphs VALUES(?,?,?,?)').run(id, ctx.threadId, JSON.stringify(tasks), '[]')
      const results = new Map(prior.filter((r) => r.status === 'done').map((r) => [r.id, r]))
      const { taskScope } = await import('./policy')
      const parallel = taskScope.getStore()?.parallel(4) ?? 4
      while (results.size < tasks.length) {
        const ready = tasks.filter((t) => !results.has(t.id) && (t.dependsOn ?? []).every((x) => results.has(x)))
        if (!ready.length) throw new Error('Task graph cannot make progress.')
        for (let i = 0; i < ready.length; i += parallel) {
          await Promise.all(ready.slice(i, i + parallel).map(async (t) => {
            let r: AgentTaskResult
            const deps = (t.dependsOn ?? []).map((x) => results.get(x)!)
            if (deps.some((x) => x.status !== 'done')) r = { id: t.id, status: 'blocked', report: 'A dependency failed.' }
            else try {
              if (ctx.signal.aborted) throw new Error('Stopped.')
              let folder: string | undefined, note = ''
              if (t.isolation === 'worktree') {
                if (!ctx.state.folder) throw new Error('Attach a Git working folder before starting isolated coding workers.')
                const isolated = await isolatedWorktree(ctx.state.folder, ctx.workspaceDir, ctx.signal)
                folder = isolated.path; note = `\nYour isolated checkout: ${folder}; baseline ${isolated.baseline}.${isolated.dirty ? ' The parent has uncommitted changes that are not present here.' : ''} Keep changes in this checkout; report files, a diff and verification. Do not merge into the parent.`
              }
              ctx.progress?.(`Working: ${t.title}`)
              r = await host.worker(t, deps.map((x) => `${x.id}: ${x.report}`).join('\n\n') + note, ctx, folder)
            } catch (e) { r = { id: t.id, status: 'failed', report: (e as Error).message } }
            results.set(t.id, r)
            db.sql.prepare('UPDATE agent_task_graphs SET results=? WHERE id=?').run(JSON.stringify([...results.values()]), id)
          }))
        }
      }
      const data = { id, hash: digest(tasks), results: tasks.map((t) => results.get(t.id)!) }
      return { text: JSON.stringify(data, null, 2), data, display: `${[...results.values()].filter((r) => r.status === 'done').length}/${tasks.length} agents finished` }
    }
  }
}
