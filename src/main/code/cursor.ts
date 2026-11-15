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
  /** A follow-up or resumed run: the first brief's goal and criteria, restated so they aren't lost. */
  original?: { goal: string; acceptance?: string[] }
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
  const orig = b.original?.goal.trim() && b.original.goal.trim() !== b.goal.trim() ? b.original : undefined
  if (orig) out.push('', '# Original goal (still applies; don\'t undo it)', orig.goal.trim(), ...bullets(orig.acceptance))
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
    'Never hard-code secrets, keys or passwords.',
    'Never delete, skip or weaken tests or type checks to make them pass; fix the code.',
    'If the goal is ambiguous or you are blocked (missing access, a broken setup, a decision only a human can make), stop and say exactly what you need instead of guessing.',
    'For multi-step work, keep a short checklist of steps and tick it off; before finishing, re-read the goal and check every acceptance criterion against the code.'
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

// ------------------------------------------------------------------ brief quality and review

/**
 * What a brief is missing before it goes to Cursor (which sees none of this chat). Each line says what to add.
 * Empty when the brief is complete enough to hand off.
 */
export function briefGaps(b: Pick<CursorBrief, 'goal' | 'context' | 'files' | 'errors' | 'acceptance' | 'tests'>, o: { projectChecks?: boolean; notes?: string } = {}): string[] {
  const goal = (b.goal ?? '').trim()
  const out: string[] = []
  if (goal.length < 25 || !/\s/.test(goal)) out.push('The goal is vague: say what must be true when it is done (behavior, where, for whom).')
  if (goal.length > 700 || (goal.match(/(^|\n)\s*(\d+[.)]|[-*])\s/g) ?? []).length >= 4) out.push('This reads like several tasks: split it into Cursor-sized pieces (one outcome, one reviewable diff each) and send them one at a time.')
  if (!b.acceptance?.length) out.push('No acceptance criteria: add 2-5 checkable ones ("`export --json` prints one object per line").')
  if (!b.files?.length && !b.context?.trim()) out.push('No files or context: Cursor starts blind. Name the files to start with and what you already found (root cause, how the code fits together).')
  if (!b.tests?.length && !o.projectChecks) out.push('No commands to verify: add the test / type-check commands that must pass.')
  if (!b.errors?.trim() && /\b(fix|bug|fail|failing|broken|crash|error|regression)\b/i.test(goal)) out.push('Fixing something: paste the exact error output or failing test into errors.')
  if (o.notes?.trim() && !b.context?.trim()) out.push('You have working notes for this task: copy the decisions, constraints and paths Cursor needs into context (it can\'t see them).')
  return out
}

export interface CursorReview {
  /** Problems found in the diff, most serious first. */
  findings: string[]
  /** What to confirm before telling the user it's done (acceptance criteria with evidence). */
  checklist: string[]
  /** A precise follow-up brief when something needs fixing. */
  followup?: string
}

const TEST_DEF = /\b(it|test|describe)(\.\w+)?\s*\(|\bdef test_|@Test\b|\bfunc Test\w*\(|#\[test\]/
const SKIPPED = /\.(skip|only)\s*\(|\bx(it|describe|test)\s*\(|@Disabled\b|@Ignore\b|pytest\.mark\.skip|\bt\.Skip\(|#\[ignore\]/
const SUPPRESS = /@ts-(ignore|nocheck|expect-error)|eslint-disable|#\s*type:\s*ignore|#\s*noqa|\bas any\b|@SuppressWarnings|#\[allow\(|expect\(true\)\.toBe\(true\)|\bassert True\b/
const DEBUG = /\bconsole\.(log|debug)\(|\bdebugger\b|\bdbg!\(|\bbreakpoint\(\)|\bpdb\.set_trace\(/
const TODO = /\b(TODO|FIXME|XXX|HACK)\b/
const MANIFEST = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Cargo\.toml|go\.mod|build\.gradle(\.kts)?|pom\.xml|Package\.swift|Podfile|Gemfile)$/
const LOCK = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Podfile\.lock|Gemfile\.lock)$/
const TESTFILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/

/** Files a unified diff touches. */
export function diffFiles(diff: string): string[] {
  const out = new Set<string>()
  for (const m of diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) out.add(m[2])
  return [...out]
}

/**
 * The automatic review of what Cursor handed back: scope against the brief, protected paths, tests removed
 * or skipped, suppressed checks, debug leftovers, TODOs, dependency changes, size, check results; then the
 * acceptance criteria as a checklist to prove, and a ready follow-up when something must change.
 */
export function reviewCursorChange(o: { brief?: Partial<CursorBrief>; diff: string; newFiles?: string[]; checksOk?: boolean; checksRun?: boolean; summary?: string }): CursorReview {
  const b = o.brief ?? {}
  const files = [...new Set([...diffFiles(o.diff), ...(o.newFiles ?? [])])]
  const added = o.diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))
  const removed = o.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
  const findings: string[] = []
  if (!files.length) findings.push('No changes: Cursor may have only explained or given up. Read its summary; resend with a clearer goal or do it yourself.')
  if (o.checksOk === false) findings.push('Checks failed (see Verification above): not done until they pass.')
  const named = (b.files ?? []).map((f) => f.replace(/^\.\//, ''))
  const protectedPaths = (b.dontChange ?? []).map((d) => d.trim().replace(/^\.\//, '').replace(/\/$/, '')).filter((d) => /[/.]/.test(d) && !/\s/.test(d))
  const hitProtected = files.filter((f) => protectedPaths.some((p) => f === p || f.startsWith(`${p}/`) || f.endsWith(`/${p}`)))
  if (hitProtected.length) findings.push(`Changes files the brief said not to touch: ${hitProtected.join(', ')}. Revert those parts.`)
  const removedTests = removed.filter((l) => TEST_DEF.test(l)).length - added.filter((l) => TEST_DEF.test(l)).length
  if (removedTests > 0) findings.push(`Removes ${removedTests} test${removedTests > 1 ? 's' : ''}: confirm each was obsolete, not deleted to go green.`)
  const skipped = added.filter((l) => SKIPPED.test(l))
  if (skipped.length) findings.push(`Skips or focuses tests: ${skipped.slice(0, 3).map((l) => l.slice(1).trim().slice(0, 80)).join(' | ')}`)
  const suppress = added.filter((l) => SUPPRESS.test(l))
  if (suppress.length) findings.push(`Suppresses type/lint checks or adds a vacuous assertion (${suppress.length}×): ${suppress.slice(0, 2).map((l) => l.slice(1).trim().slice(0, 80)).join(' | ')}`)
  const manifests = files.filter((f) => MANIFEST.test(f))
  if (manifests.length) findings.push(`Changes dependency manifests (${manifests.join(', ')}): check every added package is needed and approved.`)
  else if (files.some((f) => LOCK.test(f))) findings.push('Changes a lockfile without a manifest change: probably accidental; revert unless intended.')
  if (named.length) {
    const outside = files.filter((f) => !named.some((n) => f === n || f.startsWith(`${n.replace(/\/$/, '')}/`)) && !TESTFILE.test(f) && !LOCK.test(f))
    if (outside.length) findings.push(`Outside the files named in the brief: ${outside.slice(0, 8).join(', ')}${outside.length > 8 ? '…' : ''}. Make sure each is needed (no drive-by edits).`)
  }
  const debug = added.filter((l) => DEBUG.test(l)).length
  if (debug) findings.push(`Leaves debug output (${debug} line${debug > 1 ? 's' : ''}: console.log/debugger/dbg!/breakpoint).`)
  const todos = added.filter((l) => TODO.test(l)).length
  if (todos) findings.push(`Adds ${todos} TODO/FIXME comment${todos > 1 ? 's' : ''}: unfinished work?`)
  const size = added.length + removed.length
  if (size > 800) findings.push(`Big diff (${size} changed lines): review it file by file; if it mixes several things, ask for it split.`)
  if (files.length && !files.some((f) => TESTFILE.test(f)) && /\b(add|implement|fix|support|new)\b/i.test(b.goal ?? '')) findings.push('No test files changed: new behavior or a fix usually needs a test that would have failed before.')
  const checklist = [
    ...(b.acceptance ?? []).map((c) => `[ ] ${c.trim()}: point to the evidence (a test, a command's output, or the lines in the diff).`),
    '[ ] The diff does the goal and nothing else (read every hunk, not just the summary).',
    o.checksRun ? '[ ] Checks pass (above), and you read the failures if any.' : '[ ] Run the type check and tests yourself (code typecheck / run_tests): none were run here.',
    '[ ] Tell the user what changed (files), how you verified it, and anything left undone.'
  ]
  const fix = findings.filter((f) => !f.startsWith('No changes'))
  const followup = fix.length ? [`Fix these problems in your last change, keeping the original goal${b.goal ? ` ("${b.goal.trim().slice(0, 160)}")` : ''}:`, ...fix.map((f) => `- ${f}`), 'Then re-run the checks and list the commands with their results.'].join('\n') : undefined
  return { findings, checklist, followup }
}

/** The review as text for a tool result. */
export function formatReview(r: CursorReview, next: string): string {
  const parts = ['', '## Automatic review']
  parts.push(...(r.findings.length ? r.findings.map((f) => `- ${f}`) : ['- Nothing flagged in the diff (scope, tests, suppressions, debug output, dependencies). Still read it.']))
  parts.push('', 'Before you report done:', ...r.checklist)
  if (r.followup) parts.push('', `Suggested follow-up (${next}):`, r.followup)
  return parts.join('\n')
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
