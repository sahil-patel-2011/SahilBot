import type { ProjectInfo } from './project'

// Cursor orchestration helpers: turning a goal plus repo context into a complete agent prompt, reading
// cursor-agent's stream-json output as live progress, and the Cloud Agents run states.

export interface CursorBrief {
  goal: string
  /** What the agent learned already: search results, architecture notes, the user's words. */
  context?: string
  /** Files to read or change first. */
  files?: string[]
  /** Error output or failing tests to fix. */
  errors?: string
  constraints?: string[]
  /** Files, folders or behaviour that must not change. */
  dontChange?: string[]
  acceptance?: string[]
  /** Commands that must pass when done. */
  tests?: string[]
  /** 'local': changes stay uncommitted for review. 'cloud': works on a branch and opens a PR. */
  mode: 'local' | 'cloud' | 'followup'
}

export interface RepoFacts {
  name?: string
  branch?: string | null
  project?: Pick<ProjectInfo, 'kinds' | 'test' | 'typecheck' | 'lint'>
  /** For each listed file: whether it exists now. */
  existing?: Record<string, boolean>
}

const bullets = (xs: string[] | undefined): string[] => (xs ?? []).map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`)

/** A complete, self-contained prompt for a Cursor agent (it has none of this conversation). */
export function composeCursorPrompt(b: CursorBrief, facts: RepoFacts = {}): string {
  const p = facts.project
  const checks = [...(b.tests ?? []).map((t) => t.trim()).filter(Boolean)]
  if (!checks.length && p) {
    for (const t of p.typecheck ?? []) checks.push(t.command)
    if (p.test) checks.push(p.test.command)
  }
  const out: string[] = []
  out.push(b.mode === 'followup' ? '# Follow-up' : '# Goal', b.goal.trim())
  const ctx: string[] = []
  if (facts.name || facts.branch || p?.kinds.length) ctx.push(`Repository: ${facts.name ?? 'this repo'}${p?.kinds.length ? ` (${p.kinds.join(', ')})` : ''}${facts.branch ? `, on branch ${facts.branch}` : ''}.`)
  if (b.context?.trim()) ctx.push(b.context.trim())
  if (ctx.length) out.push('', '# Context', ...ctx)
  if (b.files?.length) {
    out.push('', '# Files to start with')
    for (const f of b.files) out.push(`- ${f}${facts.existing && f in facts.existing ? (facts.existing[f] ? '' : ' (new file)') : ''}`)
  }
  if (b.errors?.trim()) out.push('', '# Current errors (fix the cause, not the symptom)', '```', b.errors.trim().slice(0, 6000), '```')
  const rules = [
    'Read the relevant code before editing; follow the existing style, naming and patterns.',
    'Keep the diff minimal and focused on the goal: no drive-by refactors, renames or formatting changes.',
    'Do not add dependencies unless the goal requires it; say so if you do.',
    ...(b.constraints ?? []).map((c) => c.trim()).filter(Boolean),
    ...(b.dontChange ?? []).map((d) => d.trim()).filter(Boolean).map((d) => `Do not change ${d}.`),
    ...(b.mode === 'local' ? ['Do not commit, push, reset, or delete files; leave all changes uncommitted so they can be reviewed.'] : b.mode === 'cloud' ? ['Work on a new branch and open a pull request; never force-push or rewrite history.'] : []),
    'Never hard-code secrets, keys or passwords.'
  ]
  out.push('', '# Constraints', ...rules.map((r) => `- ${r}`))
  const acc = bullets(b.acceptance)
  if (acc.length) out.push('', '# Acceptance criteria', ...acc)
  if (checks.length) out.push('', '# Verify (all must pass before you finish)', ...checks.map((c) => `- \`${c}\``))
  out.push('', '# Definition of done',
    `- ${acc.length ? 'Every acceptance criterion is met' : 'The goal is fully done (no TODOs or placeholders)'}${checks.length ? ' and every command under Verify passes' : ' and the code builds'}.`,
    '- No unrelated changes.',
    '- Your final message lists: the files you changed and why, the exact commands you ran with their results, and anything left undone, risky or that needs a human decision.')
  return out.join('\n')
}

// ------------------------------------------------------------------ cursor-agent stream-json

export interface CursorRunState {
  sessionId?: string
  result?: string
  isError?: boolean
  model?: string
  durationMs?: number
  /** Last assistant text seen (used when there is no final result event). */
  lastText?: string
  filesTouched: Set<string>
  commands: string[]
  toolCalls: number
}

export const newRunState = (): CursorRunState => ({ filesTouched: new Set(), commands: [], toolCalls: 0 })

const VERBS: Record<string, string> = { read: 'Reading', write: 'Writing', edit: 'Editing', delete: 'Deleting', shell: 'Running', grep: 'Searching', glob: 'Finding files', ls: 'Listing', todo: 'Updating its plan', search: 'Searching', semsearch: 'Searching' }

/** Reads one line of `cursor-agent --output-format stream-json`; returns a progress line to show, if any. */
export function readCursorEvent(line: string, st: CursorRunState): string | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  let ev: any
  try { ev = JSON.parse(t) } catch { return null }
  if (ev.session_id) st.sessionId = ev.session_id
  switch (ev.type) {
    case 'system':
      if (ev.model) st.model = ev.model
      return ev.subtype === 'init' ? `Cursor agent started${ev.model ? ` (${ev.model})` : ''}` : null
    case 'assistant': {
      const text = (ev.message?.content ?? []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('').trim()
      if (!text) return null
      st.lastText = text
      return `Cursor: ${text.replace(/\s+/g, ' ').slice(0, 140)}`
    }
    case 'tool_call': {
      const call = ev.tool_call ?? {}
      const key = Object.keys(call)[0] ?? ''
      const body = call[key] ?? {}
      const kind = key.replace(/ToolCall$/, '').toLowerCase()
      const args = body.args ?? (typeof body.arguments === 'string' ? safeJson(body.arguments) : body.arguments) ?? {}
      const target = args.path ?? args.file_path ?? args.targetFile ?? args.command ?? args.pattern ?? args.query ?? body.name ?? ''
      if (ev.subtype === 'started') {
        st.toolCalls++
        if (['write', 'edit', 'delete'].includes(kind) && args.path) st.filesTouched.add(String(args.path))
        if (kind === 'shell' && args.command) st.commands.push(String(args.command))
        return `${VERBS[kind] ?? (key === 'function' ? `Using ${body.name ?? 'a tool'}` : `Using ${kind || 'a tool'}`)}${target && key !== 'function' ? ` ${String(target).slice(0, 120)}` : ''}`
      }
      if (ev.subtype === 'completed' && body.result && !body.result.success && body.result.error) return `${VERBS[kind] ?? 'Tool'} failed: ${String(body.result.error?.message ?? body.result.error).slice(0, 120)}`
      return null
    }
    case 'result':
      if (typeof ev.result === 'string') st.result = ev.result
      st.isError = !!ev.is_error || ev.subtype === 'error'
      if (typeof ev.duration_ms === 'number') st.durationMs = ev.duration_ms
      return `Cursor agent ${st.isError ? 'stopped with an error' : 'finished'}${st.durationMs ? ` in ${Math.round(st.durationMs / 1000)}s` : ''}`
    default:
      return null
  }
}

function safeJson(s: string): any {
  try { return JSON.parse(s) } catch { return {} }
}

/** Older cursor-agent builds print one JSON object (--output-format json): read it the same way. */
export function readCursorJson(out: string, st: CursorRunState): void {
  const t = out.trim()
  if (!t.startsWith('{') || t.includes('\n{')) return
  try {
    const j = JSON.parse(t) as { result?: string; session_id?: string; sessionId?: string; chatId?: string; is_error?: boolean }
    st.sessionId ??= j.session_id ?? j.sessionId ?? j.chatId
    if (typeof j.result === 'string') st.result ??= j.result
    if (j.is_error) st.isError = true
  } catch { /* not JSON */ }
}

// ------------------------------------------------------------------ cloud agents

const RUNNING = new Set(['CREATING', 'QUEUED', 'PENDING', 'RUNNING', 'WAITING_FOR_BACKGROUND_WORK'])
export const cloudRunning = (status: string | undefined): boolean => !!status && RUNNING.has(status.toUpperCase())

/** Seconds between status checks: 10, 15, 22, 33, 50, 60, 60… (no tight loops). */
export function backoff(attempt: number, first = 10, max = 60): number {
  return Math.min(max, Math.round(first * 1.5 ** attempt))
}

export interface CloudBranch { repoUrl?: string; branch?: string; prUrl?: string }

export function prUrlsOf(run: any): string[] {
  const branches = (run?.git?.branches ?? []) as CloudBranch[]
  return branches.map((b) => b.prUrl).filter((u): u is string => !!u)
}

export function describeCloud(agent: any, run: any): string {
  const branches = (run?.git?.branches ?? []) as CloudBranch[]
  const result = run?.result ? (typeof run.result === 'string' ? run.result : JSON.stringify(run.result)) : ''
  return [
    `Agent ${agent?.id ?? '?'}${agent?.name ? ` (${agent.name})` : ''}: ${agent?.status ?? 'unknown'}`,
    `Latest run: ${run?.status ?? 'none'}${run?.durationMs ? ` · ${Math.round(run.durationMs / 1000)}s` : ''}`,
    ...branches.map((b) => `Branch ${b.branch ?? '?'}${b.repoUrl ? ` on ${b.repoUrl}` : ''}${b.prUrl ? ` · PR ${b.prUrl}` : ''}`),
    ...(result ? ['Result:', result.slice(0, 6000)] : []),
    ...(agent?.url ? [`Open: ${agent.url}`] : [])
  ].join('\n')
}
