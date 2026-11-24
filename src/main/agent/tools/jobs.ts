import type { ToolEffect } from '@shared/types'
import { clip } from '../../code/proc'
import { isLive, jobLine, jobs as defaultJobs, type JobManager, type WaitFor } from '../../jobs/manager'
import type { ToolContext, ToolDef } from '../types'
import { ownedHere } from './freshness'
import { commandEffect, commandReadsOutside, systemReason } from './shell'

// The jobs tool: background jobs this chat started with run_command background: true.
// list / output / wait only look (read); stop changes things on this Mac (write_local); restart runs the
// command again, so it needs what running that command needs: run_command's full effect in the job's
// folder (writes outside your folders count as acting outside), and its hard stops.

type Args = {
  action: 'list' | 'output' | 'wait' | 'stop' | 'restart'
  id?: string
  tail?: number
  grep?: string
  text?: string
  regex?: string
  port?: number
  exit?: boolean
  timeout?: number
}

/** The chats whose jobs a call may see: its own, and (for a helper agent) the chat that started the team. */
const owners = (ctx: Pick<ToolContext, 'threadId' | 'state'>): Set<string> => new Set([ctx.threadId, ctx.state.rootId].filter((x): x is string => !!x))

export function jobsTool(o: { jobs?: JobManager } = {}): ToolDef<Args> {
  const jobs = o.jobs ?? defaultJobs
  const mine = (id: string | undefined, ctx: ToolContext) => {
    if (!id) throw new Error('Give the job id (from run_command or jobs list).')
    const j = jobs.get(id)
    if (!j || !owners(ctx).has(j.threadId)) throw new Error(`No job ${id} in this chat. Use jobs list.`)
    return j
  }
  /** What restarting a job's command does, judged like run_command in the job's folder. */
  const rerun = (id: string | undefined, roots: string[] = []) => {
    const j = id ? jobs.get(id) : undefined
    return j ? commandEffect(j.command, { cwd: j.cwd, allowed: [j.cwd, ...roots] }) : null
  }
  const effect = (a: Args, roots: string[] = []): ToolEffect => {
    if (a.action === 'stop') return 'write_local'
    if (a.action === 'restart') return rerun(a.id, roots)?.effect ?? 'write_local'
    return 'read'
  }
  return {
    name: 'jobs',
    label: 'Jobs',
    core: false,
    group: 'Coding',
    // Output is whatever the program printed: untrusted when the job's command reaches outside this Mac or reads a
    // download (commandReadsOutside, per call below); a dev server's own log is the user's data.
    effect: (a, c) => effect(a, c?.roots ?? []),
    consequential: () => true,
    hardStop: (a) => {
      if (a.action !== 'restart' || !a.id) return null
      const j = jobs.get(a.id)
      if (!j) return null
      const sys = systemReason(j.command)
      if (sys) return `"${j.command.slice(0, 80)}" is a ${sys}`
      const r = rerun(a.id)
      return r?.effect === 'destructive' ? `"${j.command.slice(0, 80)}" ${r.why}` : null
    },
    describe: (a) => {
      const j = a.id ? jobs.get(a.id) : undefined
      const what = j ? `${a.id} (${j.command.slice(0, 80)})` : a.id ?? ''
      switch (a.action) {
        case 'stop': return `Stop background job ${what}`
        case 'restart': return `Restart background job ${what}`
        case 'wait': return `Wait for job ${what}`
        case 'output': return `Read the output of job ${what}`
        default: return 'List background jobs'
      }
    },
    description: 'Background jobs this chat started with run_command background: true (dev servers, watchers, long builds). Actions: list (status, uptime, URL); output (id, tail lines (default 80), grep text or /regex/); wait (id, until a line has text or matches regex, a port accepts connections, or exit: true; timeout seconds, default 60); stop (SIGTERM to its whole process group, then SIGKILL); restart (stop, then run the same command again). Jobs stop when SahilBot quits.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'output', 'wait', 'stop', 'restart'] },
        id: { type: 'string', description: 'Job id, e.g. "j1"' },
        tail: { type: 'integer', minimum: 1, maximum: 400, description: 'output: last N lines (default 80)' },
        grep: { type: 'string', description: 'output: only lines containing this text (or /regex/)' },
        text: { type: 'string', description: 'wait: text a line contains' },
        regex: { type: 'string', description: 'wait: regular expression a line matches' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'wait: a local port that accepts connections' },
        exit: { type: 'boolean', description: 'wait: until the job ends' },
        timeout: { type: 'integer', minimum: 1, maximum: 900, description: 'wait: seconds (default 60)' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run(a, ctx) {
      const own = owners(ctx)
      if (a.action === 'list') {
        const list = jobs.list().filter((j) => own.has(j.threadId))
        if (!list.length) return { text: 'No background jobs in this chat. Start one with run_command background: true.', display: 'no jobs' }
        const n = list.filter((j) => isLive(j.status)).length
        return { text: list.map((j) => jobLine(j)).join('\n'), display: `${n} running, ${list.length - n} finished` }
      }
      const j = mine(a.id, ctx)
      if (a.action === 'output') {
        const out = jobs.output(j.id, { tail: a.tail, grep: a.grep })
        const body = clip(out.lines.join('\n'), 20_000, 'characters')
        return { untrusted: commandReadsOutside(j.command, { cwd: j.cwd, ours: (p) => ownedHere(ctx.state?.rootId ?? ctx.threadId, p) }), text: `${jobLine(jobs.get(j.id) ?? j)}\n${a.grep ? `${out.lines.length} matching line(s) of the last ${out.kept}` : `Last ${out.lines.length} of ${out.total} lines`}:\n${body || '(no output)'}`, display: `${j.id} · ${out.lines.length} lines` }
      }
      if (a.action === 'wait') {
        const w: WaitFor = { text: a.text, regex: a.regex, port: a.port, exit: a.exit ?? (!a.text && !a.regex && !a.port), timeout: a.timeout }
        const r = await jobs.wait(j.id, w, ctx.signal)
        const tail = jobs.output(j.id, { tail: 20 }).lines.join('\n')
        const said = r.reason === 'matched' ? `matched after ${(r.ms / 1000).toFixed(1)}s: ${r.line ?? ''}` : r.reason === 'port' ? `port ${a.port} is accepting connections` : r.reason === 'exited' ? `the job ended: ${r.job.status}${r.job.exitCode !== null ? ` (exit ${r.job.exitCode})` : ''}` : r.reason === 'timeout' ? `not yet after ${a.timeout ?? 60}s` : 'stopped waiting'
        return { untrusted: commandReadsOutside(j.command, { cwd: j.cwd, ours: (p) => ownedHere(ctx.state?.rootId ?? ctx.threadId, p) }), text: `${r.ok ? 'Done' : 'Not done'}: ${said}\n${jobLine(r.job)}\nLast output:\n${clip(tail, 6000) || '(none)'}`, display: `${j.id} · ${r.reason}` }
      }
      if (a.action === 'stop') {
        const s = await jobs.stop(j.id)
        return { text: `Stopped ${j.id}.\n${s ? jobLine(s) : ''}`, display: `stopped ${j.id}`, meta: { job: { id: j.id, status: s?.status ?? 'stopped' } } }
      }
      const r = await jobs.restart(j.id)
      if (!r) throw new Error(`No job ${j.id}.`)
      const w = await jobs.wait(j.id, { regex: 'https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::)', timeout: 6 }, ctx.signal)
      const tail = jobs.output(j.id, { tail: 20 }).lines.join('\n')
      return { untrusted: commandReadsOutside(j.command, { cwd: j.cwd, ours: (p) => ownedHere(ctx.state?.rootId ?? ctx.threadId, p) }), text: `Restarted ${j.id}.\n${jobLine(w.job)}\nOutput so far:\n${clip(tail, 6000) || '(none yet)'}`, display: `restarted ${j.id}`, meta: { job: { id: j.id, url: w.job.urls[0] ?? null, status: w.job.status } } }
    }
  }
}
