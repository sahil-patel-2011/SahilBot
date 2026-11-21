import { clip, runProcess, throttle, LOGIN_SHELL } from './proc'
import { type Check, type CommandSpec, type Diagnostic, detectProject, formatDiag, parseDiagnostics, parseTestOutput, suggestNext, testCommand } from './project'

// Runs a project's tests, type checker or linter with streaming progress and a deadline, and turns the
// output into a short report: pass/fail, the failures as file:line + message, one suggested next step,
// and the tail of the raw output.

export interface CheckResult {
  ok: boolean
  command: string
  exitCode: number | null
  timedOut: boolean
  stopped: boolean
  ms: number
  problems: Diagnostic[]
  summary?: string
  /** Text for the model. */
  text: string
}

export interface CheckOptions {
  cwd: string
  kind: Check
  spec: CommandSpec
  filter?: string
  /** For lint/typecheck: limit to a path (when the tool takes one). */
  path?: string
  timeoutMs: number
  signal?: AbortSignal
  progress?: (line: string) => void
  /** Lines of raw output kept at the end of the report. */
  tailLines?: number
}

const secs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export function buildCommand(o: Pick<CheckOptions, 'kind' | 'spec' | 'filter' | 'path'>, pm?: 'npm' | 'pnpm' | 'yarn' | 'bun'): string {
  if (o.kind === 'test') return testCommand(o.spec, o.filter, pm)
  if (o.path && /^(npx --no-install eslint|ruff check)/.test(o.spec.command)) return o.spec.command.replace(/ \.( |$)/, ` ${o.path.replace(/'/g, '')}$1`)
  return o.spec.command
}

export async function runCheck(o: CheckOptions): Promise<CheckResult> {
  const command = buildCommand(o, detectProject(o.cwd).packageManager)
  const tick = throttle<string>((l) => o.progress?.(l), 700)
  o.progress?.(`$ ${command}`)
  const r = await runProcess(LOGIN_SHELL, ['-lc', command], {
    cwd: o.cwd,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    maxChars: 2_000_000,
    onLine: (l) => { if (l.trim()) tick.push(l.trim().slice(0, 160)) }
  })
  tick.flush()
  const out = r.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') // eslint-disable-line no-control-regex
  const ok = r.code === 0 && !r.timedOut && !r.stopped
  let problems: Diagnostic[]
  let summary: string | undefined
  if (o.kind === 'test') {
    const rep = parseTestOutput(o.spec.tool, out, o.cwd)
    problems = rep.failures
    summary = rep.summary
  } else problems = parseDiagnostics(o.spec.tool, out, o.cwd)
  const errors = problems.filter((p) => p.severity === 'error')
  const warnings = problems.filter((p) => p.severity === 'warning')
  const status = r.timedOut ? `stopped after ${secs(o.timeoutMs)} (timeout)` : r.stopped ? 'stopped' : `exit ${r.code}`
  const head = `$ ${command}\n(in ${o.cwd}; ${status}; ${secs(r.ms)})`
  const verdict = ok
    ? `PASSED${summary ? `: ${summary}` : ''}${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}`
    : r.timedOut ? 'DID NOT FINISH (timed out). Narrow it with a filter or raise timeout.'
      : r.code === 127 || /command not found|not found: |could not determine executable|ERR_MODULE_NOT_FOUND|No module named/i.test(out.slice(-2000)) && !problems.length ? 'COULD NOT RUN: the tool is missing (install dependencies first, e.g. npm install / pip install -r requirements.txt, which asks the user).'
        : `FAILED${summary ? `: ${summary}` : ''}${errors.length ? ` · ${errors.length} problem${errors.length > 1 ? 's' : ''} parsed` : ''}`
  const list = (ok ? warnings : problems).slice(0, 25).map((d, i) => `${i + 1}. ${formatDiag(d)}`)
  const more = (ok ? warnings : problems).length > 25 ? [`… and ${(ok ? warnings : problems).length - 25} more`] : []
  const next = ok ? '' : suggestNext(o.kind, problems, o.filter)
  const tailN = o.tailLines ?? (ok ? 15 : 60)
  const tail = out.trimEnd().split('\n').slice(-tailN).join('\n')
  const text = [head, verdict, ...(list.length ? [ok ? 'Warnings:' : o.kind === 'test' ? 'Failures:' : 'Problems:', ...list, ...more] : []), ...(next ? [next] : []), `--- last ${Math.min(tailN, tail.split('\n').length)} lines of output ---`, clip(tail, 8000)].join('\n')
  return { ok, command, exitCode: r.code, timedOut: r.timedOut, stopped: r.stopped, ms: r.ms, problems, summary, text }
}
