import type { Message, RunUsage } from '@shared/types'

// The end-of-run summary line under the last reply: what the run did (from its tool messages) and the
// tokens and cloud cost it used, e.g. "Ran 6 commands, edited 4 files, started 1 job — 0 needed you ·
// 48.2k tokens (41k in / 7k out) · $0.06". Pure functions (unit-tested); JobsPanel.tsx renders them.

const CMD_CODE = new Set(['run_tests', 'typecheck', 'lint', 'build', 'run'])
const FILE_TOOLS = new Set(['file_write', 'create_document', 'file_manage', 'create_page', 'update_page'])

export interface RunFacts { commands: number; files: number; jobs: number; actions: number; since: number; until: number }

/** What the last run did, from its tool messages: commands run, files changed, jobs started. */
export function runFacts(messages: Message[]): RunFacts | null {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.meta?.hidden && !m.meta?.steer) { start = i; break }
  }
  if (start < 0) return null
  const run = messages.slice(start + 1)
  if (!run.some((m) => m.role === 'assistant')) return null
  let commands = 0
  let jobs = 0
  let actions = 0
  const files = new Set<string>()
  for (const m of run) {
    if (m.role !== 'tool' || !m.toolName) continue
    const status = m.meta?.status
    if (status === 'denied') continue
    actions++
    let a: Record<string, unknown> = {}
    try { a = JSON.parse(String(m.meta?.args ?? '{}')) } catch { a = {} }
    if (m.toolName === 'run_command') {
      if (a.background && status === 'ok') jobs++
      else commands++
    } else if ((m.toolName === 'code' && CMD_CODE.has(String(a.action))) || m.toolName === 'git') commands++
    if (status !== 'ok') continue
    if (FILE_TOOLS.has(m.toolName) && !(m.toolName === 'file_manage' && a.op === 'mkdir')) { const p = (m.meta?.path as string | undefined) ?? (a.path as string | undefined); if (p) files.add(p) }
    if (m.toolName === 'code' && a.action === 'edit' && typeof a.path === 'string') files.add(a.path)
    if (m.toolName === 'code' && a.action === 'apply_patch' && typeof a.patch === 'string') {
      for (const x of a.patch.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\+\+\+ b\/)(.+)$/gm)) files.add(x[1].trim())
    }
  }
  const last = run[run.length - 1]
  return { commands, files: files.size, jobs, actions, since: messages[start].createdAt, until: last.createdAt + 5000 }
}

export const fmtTokens = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)
export const fmtUsd = (u: number): string => (u <= 0 ? '$0' : u < 0.01 ? '<$0.01' : `$${u.toFixed(2)}`)
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The words of the summary line, e.g. "Ran 6 commands, edited 4 files, started 1 job — 0 needed you". */
export function summaryText(f: RunFacts, o: { autonomous: boolean; asked?: number }): string {
  const parts: string[] = []
  if (f.commands) parts.push(`ran ${plural(f.commands, 'command')}`)
  if (f.files) parts.push(`edited ${plural(f.files, 'file')}`)
  if (f.jobs) parts.push(`started ${plural(f.jobs, 'job')}`)
  const other = f.actions - f.commands - f.jobs
  if (!parts.length && other > 0) parts.push(`took ${plural(other, 'action')}`)
  let s = parts.join(', ')
  if (s) s = s[0].toUpperCase() + s.slice(1)
  if (o.autonomous && typeof o.asked === 'number' && s) s += ` — ${o.asked} needed you`
  return s
}

export function usageText(u: RunUsage | null, detailed: boolean): string {
  if (!u || u.input + u.output === 0) return ''
  const total = `${fmtTokens(u.input + u.output)} tokens${detailed ? ` (${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out)` : ''}`
  return `${total} · ${u.cloud ? fmtUsd(u.usd) : 'free (local)'}`
}

