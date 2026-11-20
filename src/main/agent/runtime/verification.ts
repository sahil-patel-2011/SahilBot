import { lstatSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import type { ResearchClaim } from './research'
import type { RuntimeStore } from './store'

export interface VerificationReport { status: 'verified' | 'unverified' | 'blocked'; issues: string[]; checks: number; passed: number }
export function completionReport(store: RuntimeStore, runId: string, o: { required?: boolean; criteria?: string[]; files?: string[]; claims?: ResearchClaim[] } = {}): VerificationReport {
  const checks = store.checks(runId), latest = new Map(checks.map((c) => [c.criterion, c]))
  const actions = store.actions(runId)
  const lastMutation = Math.max(0, ...actions.filter((a) => a.status === 'done' && a.effect !== 'read' && !['memory', 'preference', 'project_memory', 'agent_control'].includes(a.tool)).map((a) => a.at))
  const issues: string[] = []
  for (const [name, check] of latest) if (!check.passed) issues.push(`${name}: failed`)
  for (const criterion of o.criteria ?? []) if (!latest.get(criterion)?.passed) issues.push(`${criterion}: no passing evidence`)
  for (const name of o.files ?? []) {
    const saved = actions.some((action) => {
      const path = action.output?.path
      if (action.status !== 'done' || action.effect === 'read' || !path || !isAbsolute(path) || basename(path) !== name) return false
      try { return lstatSync(path).isFile() } catch { return false }
    })
    if (!saved) issues.push(`No saved workspace file named ${name} was verified. Use the workspace file or export tool to save it and check the result.`)
  }
  if (checks.length && Math.max(...checks.map((c) => c.at)) < lastMutation) issues.push('The work changed after its last verification; check it again.')
  for (const a of store.uncertain(store.get(runId)?.threadId ?? '')) issues.push(`${a.tool}: uncertain outcome (${a.id})`)
  for (const c of o.claims ?? []) if (c.consequential && ['unsupported', 'disputed', 'stale'].includes(c.status)) issues.push(`Research claim is ${c.status}: ${c.text}`)
  if (o.required && !checks.length) issues.push('This task requires evidence-backed verification before completion.')
  const passed = [...latest.values()].filter((c) => c.passed).length
  return { status: issues.length ? 'blocked' : passed > 0 ? 'verified' : 'unverified', issues: [...new Set(issues)], checks: latest.size, passed }
}
