import type { Message, RunUsage } from '@shared/types'

// The end-of-run summary line under the last reply: what the run did (from its tool messages) and the
// tokens and cloud cost it used, e.g. "Ran 6 commands, edited 4 files, started 1 job — 0 needed you ·
// 48.2k tokens (41k in / 7k out) · $0.06". Pure functions (unit-tested); JobsPanel.tsx renders them.

const CMD_CODE = new Set(['run_tests', 'typecheck', 'lint', 'build', 'run'])
const FILE_TOOLS = new Set(['file_write', 'file_edit', 'create_document', 'file_manage', 'create_page', 'update_page'])

export interface RunFacts {
  commands: number; files: number; jobs: number; actions: number; since: number; until: number
  /** The files it changed, newest last; `made` are the ones it created (not edits). */
  paths?: string[]; made?: string[]
  /** How long the task took, from your message to its last message. */
  ms?: number
  /** You stopped it (the Stop button, or typed "stop"). */
  stopped?: boolean
}

const MAKES = new Set(['file_write', 'create_document', 'create_page'])

/** What the last run did, from its tool messages: commands run, files changed, jobs started. */
export function runFacts(messages: Message[]): RunFacts | null {
  let start = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    // (A side question asked mid-task, or a typed "stop", is part of the task, not a new one.)
    if (m.role === 'user' && !m.meta?.hidden && !m.meta?.steer && !m.meta?.aside && !m.meta?.stopRequest) { start = i; break }
  }
  if (start < 0) return null
  const run = messages.slice(start + 1)
  if (!run.some((m) => m.role === 'assistant')) return null
  let commands = 0
  let jobs = 0
  let actions = 0
  const files = new Set<string>()
  const made = new Set<string>()
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
    if (FILE_TOOLS.has(m.toolName) && !(m.toolName === 'file_manage' && a.op === 'mkdir')) {
      const p = (m.meta?.path as string | undefined) ?? (a.path as string | undefined)
      if (p) { files.delete(p); files.add(p) }
      if (p && MAKES.has(m.toolName) && !/^(append|edit)$/.test(String(a.mode ?? ''))) made.add(p)
    }
    if (m.toolName === 'code' && a.action === 'edit' && typeof a.path === 'string') files.add(a.path)
    if (m.toolName === 'code' && a.action === 'apply_patch' && typeof a.patch === 'string') {
      for (const x of a.patch.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\+\+\+ b\/)(.+)$/gm)) files.add(x[1].trim())
    }
  }
  const last = run[run.length - 1]
  const stopped = run.some((m) => (m.role === 'user' && !!m.meta?.stopRequest) || (m.role === 'assistant' && (m.status === 'stopped' || !!m.meta?.stopped)))
  const paths = [...files]
  return { commands, files: files.size, jobs, actions, since: messages[start].createdAt, until: last.createdAt + 5000, paths, made: paths.filter((p) => made.has(p)), ms: Math.max(0, last.createdAt - messages[start].createdAt), stopped }
}

const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p
/** The folder a file is in, as a person says it: "Downloads", "your home folder" (never the whole path or a username). */
export function folderName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  parts.pop()
  const dir = parts[parts.length - 1]
  if (!dir || /^(tmp|var|private|\.|~)$/.test(dir)) return ''
  if (parts.length === 2 && /^(Users|home)$/.test(parts[0])) return 'your home folder'
  return dir
}

/** "1 min 12 s", "40 s", "2 h 5 min": how long a finished task took. */
export function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

/** What the task made or changed and where: "Made invoice.pdf in Downloads", "Changed notes.md +2 more". '' if nothing. */
export function madeText(f: RunFacts): string {
  const made = f.made ?? []
  const list = made.length ? made : f.paths ?? []
  if (!list.length) return ''
  const first = list[list.length - 1]
  const where = folderName(first)
  const more = Math.max(list.length, f.paths?.length ?? 0) - 1
  return `${made.length ? 'Made' : 'Changed'} ${base(first)}${where ? ` in ${where}` : ''}${more > 0 ? ` +${more} more` : ''}`
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

/**
 * The finish line under the last reply, in plain words: what was made, where, how long ("Done in 48 s · Made
 * invoice.pdf in Downloads · <$0.01"); with nothing made, the actions it took. Tokens go in the hover card (and Usage).
 * `asked` (how many times it needed you) shows only when it did; `simple` leaves the cost to the hover card too.
 * A stopped task never says "Done": it says "Stopped" (and nothing at all when the chat already said so and it made
 * nothing).
 */
export function statusLine(f: RunFacts, u: RunUsage | null, o: { asked?: number; simple?: boolean } = {}): string {
  const made = madeText(f)
  if (f.stopped) return made ? `Stopped after ${took(f.ms ?? 0)} · ${made}` : ''
  const parts = [f.ms !== undefined && f.actions ? `Done in ${took(f.ms)}` : 'Done']
  if (made) parts.push(made)
  else if (f.actions) parts.push(plural(f.actions, 'action'))
  if (f.jobs) parts.push(`${plural(f.jobs, 'background job')} started`)
  if (o.asked) parts.push(`asked you ${o.asked === 1 ? 'once' : `${o.asked} times`}`)
  const paid = !!u && u.cloud && u.input + u.output > 0
  // A plain chat reply (no actions) says nothing, unless it cost something.
  if (!f.actions && !paid) return ''
  if (u && u.input + u.output > 0 && !o.simple) parts.push(u.cloud ? fmtUsd(u.usd) : 'free (local)')
  return parts.length > 1 ? parts.join(' · ') : ''
}

export function usageText(u: RunUsage | null, detailed: boolean): string {
  if (!u || u.input + u.output === 0) return ''
  const total = `${fmtTokens(u.input + u.output)} tokens${detailed ? ` (${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out)` : ''}`
  return `${total} · ${u.cloud ? fmtUsd(u.usd) : 'free (local)'}`
}

