import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import type { JobEvent, JobInfo } from '@shared/types'
import { sandboxed, stripAnsi, toolEnv, type SandboxSpec, LOGIN_SHELL } from '../code/proc'

// Background jobs: long-running processes a chat started (dev servers, watchers, long builds) with
// run_command background: true. Each runs in its own process group (so Stop reaches everything it
// started), keeps the last ~2000 lines of output, notices the local URLs and ports it prints, and can be
// waited on (a line of text, a regex, a port that accepts connections, or its exit). A job belongs to
// one chat: it is stopped when that chat or its bot is deleted, and when SahilBot quits.

export const MAX_JOBS = 8
export const MAX_LINES = 2000
export const MAX_LINE_CHARS = 2000
/** Finished jobs kept per chat for the Jobs tab (oldest forgotten first). */
const KEEP_FINISHED = 12
/** Output faster than this (characters per 10 s) is flagged as noisy. */
const NOISY_CHARS = 2_000_000
const CPU_SAMPLE_MS = 10_000
/** A process group above this CPU share (percent of one core) for 3 samples in a row gets a warning. */
const CPU_RUNAWAY = 150

export interface WaitFor {
  /** Plain text to find in a line (case-insensitive). */
  text?: string
  /** A regular expression (case-insensitive), e.g. "ready in \\d+ ms". */
  regex?: string
  /** A TCP port on this Mac that starts accepting connections. */
  port?: number
  /** Resolve when the job ends (success or failure). */
  exit?: boolean
  /** Seconds (default 60, at most 900). */
  timeout?: number
}

export interface WaitResult {
  ok: boolean
  /** What happened: matched text/regex, port open, the job exited, timed out, or the wait was cancelled. */
  reason: 'matched' | 'port' | 'exited' | 'timeout' | 'aborted'
  line?: string
  ms: number
  job: JobInfo
}

interface Job {
  info: JobInfo
  env?: NodeJS.ProcessEnv
  /** The write sandbox it runs under (kept for restarts). */
  sandbox?: SandboxSpec
  child: ChildProcess | null
  buf: string[]
  partial: { stdout: string; stderr: string }
  closed: Promise<void>
  /** Characters in the current 10 s window (noise check). */
  window: { at: number; chars: number }
  hot: number
  listeners: Set<(line: string) => void>
  pendingLines: string[]
  flushTimer: NodeJS.Timeout | null
  stopping: boolean
}

// Addresses dev servers print: Vite "Local: http://localhost:5173/", Next "- Local: http://localhost:3000",
// Rails "Listening on http://127.0.0.1:3000", "http://0.0.0.0:8000/", "http://[::1]:4000".
const URL_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.local|[\w-]+\.localhost|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d{2,5})?(?:\/[^\s'"`<>)\]]*)?/gi
const PORT_RE = /\b(?:listening|running|started|serving|server|available|bound)\b[^\n]{0,60}?\bport\b\s*[:=]?\s*(\d{2,5})\b|\bport\s+(\d{2,5})\b/gi

/** Local URLs and ports a line mentions (0.0.0.0 and [::] shown as localhost). */
export function detectAddresses(line: string): { urls: string[]; ports: number[] } {
  const clean = stripAnsi(line)
  const urls: string[] = []
  const ports: number[] = []
  for (const m of clean.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:]+$/, '').replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost')
    urls.push(u)
    try {
      const x = new URL(u)
      const port = x.port ? Number(x.port) : x.protocol === 'https:' ? 443 : 80
      if (port > 0 && port < 65536) ports.push(port)
    } catch { /* not a URL after all */ }
  }
  for (const m of clean.matchAll(PORT_RE)) {
    const n = Number(m[1] ?? m[2])
    if (n >= 80 && n < 65536) ports.push(n)
  }
  return { urls, ports }
}

/** Longest pattern accepted as a regular expression (longer ones are matched as plain text). */
export const MAX_PATTERN = 200

/**
 * Whether a regex source can backtrack catastrophically: a quantified group that itself contains a
 * quantifier or an alternation ("(a+)+", "(a|aa)*", "(\\w+\\s?)*"), or a backreference. Such patterns
 * are matched as plain text instead (a line is at most 2000 characters,
 * but one bad pattern against 2000 lines would still stall the main process).
 */
export function catastrophic(src: string): boolean {
  if (/\\[1-9]|\\k</.test(src)) return true
  // Walk the groups: a group whose body has a quantifier or a | and that is followed by a quantifier.
  const stack: Array<{ quant: boolean; alt: boolean }> = []
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') { i++; continue }
    if (ch === '[') { // a character class: skip it
      for (i++; i < src.length && src[i] !== ']'; i++) if (src[i] === '\\') i++
      continue
    }
    if (ch === '(') { stack.push({ quant: false, alt: false }); continue }
    if (ch === '|' && stack.length) { stack[stack.length - 1].alt = true; continue }
    if (ch === ')') {
      const g = stack.pop()
      const next = src[i + 1]
      const quantified = next === '*' || next === '+' || next === '{'
      if (g && quantified && (g.quant || g.alt)) return true
      if (g && stack.length && (g.quant || quantified)) stack[stack.length - 1].quant = true
      continue
    }
    if ((ch === '*' || ch === '+' || ch === '{' || (ch === '?' && src[i - 1] !== '(')) && stack.length) stack[stack.length - 1].quant = true
  }
  return false
}

/**
 * A user/model-supplied pattern as a case-insensitive RegExp, or null. Text is literal. A regex longer than
 * MAX_PATTERN, one that doesn't compile, or one that can backtrack catastrophically is matched as plain text.
 */
export function patternOf(w: Pick<WaitFor, 'text' | 'regex'>): RegExp | null {
  if (w.regex) {
    const src = String(w.regex)
    if (src.length <= MAX_PATTERN && !catastrophic(src)) {
      try { return new RegExp(src, 'i') } catch { /* not a regex: plain text below */ }
    }
    return new RegExp(escapeRe(src.slice(0, 300)), 'i')
  }
  if (w.text) return new RegExp(escapeRe(String(w.text).slice(0, 300)), 'i')
  return null
}
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------- process groups on disk: reaped after a crash ----------

interface PidEntry { pgid: number; startedAt: number; command: string }

/** Process groups of jobs that may still be running, from a previous launch's pid file. */
export function readPidFile(file: string): PidEntry[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter((e): e is PidEntry => !!e && Number.isInteger((e as PidEntry).pgid) && (e as PidEntry).pgid > 1 && typeof (e as PidEntry).startedAt === 'number') : []
  } catch { return [] }
}

/** `ps` rows: pid, pgid and start time (ms) of every process. */
function processTable(): Array<{ pid: number; pgid: number; start: number }> {
  try {
    const out = execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,lstart='], { timeout: 4000, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: process.env.TZ ?? '' } })
    return String(out).split('\n').map((row) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(row)
      return m ? { pid: Number(m[1]), pgid: Number(m[2]), start: Date.parse(m[3]) } : null
    }).filter((r): r is { pid: number; pgid: number; start: number } => !!r)
  } catch { return [] }
}

/**
 * Process groups from `entries` that are still ours: the leader is gone but members remain (a pid isn't
 * reused while its group exists), or the leader started within 10 s of when the job did (not a reused pid).
 */
export function staleGroups(entries: PidEntry[], table = processTable()): number[] {
  const out: number[] = []
  for (const e of entries) {
    const members = table.filter((r) => r.pgid === e.pgid)
    if (!members.length) continue
    const leader = members.find((r) => r.pid === e.pgid)
    if (!leader || (Number.isFinite(leader.start) && Math.abs(leader.start - e.startedAt) < 10_000)) out.push(e.pgid)
  }
  return out
}

/** Whether something on this Mac accepts connections on `port` (IPv4 or IPv6 loopback). */
export function portOpen(port: number, ms = 400): Promise<boolean> {
  const one = (host: string): Promise<boolean> => new Promise((done) => {
    const s = connect({ host, port })
    const end = (ok: boolean): void => { s.destroy(); done(ok) }
    s.setTimeout(ms, () => end(false))
    s.once('connect', () => end(true))
    s.once('error', () => end(false))
  })
  return one('127.0.0.1').then((ok) => ok || one('::1'))
}

const live = (s: JobInfo['status']): boolean => s === 'starting' || s === 'running' || s === 'ready'

export class JobManager {
  private jobs = new Map<string, Job>()
  private seq = 0
  private subs = new Set<(e: JobEvent) => void>()
  private cpuTimer: NodeJS.Timeout | null = null

  constructor(private o: { maxJobs?: number; maxLines?: number; cpuSampleMs?: number; pidFile?: string } = {}) {}

  /**
   * Keeps the process groups of running jobs in `file`, and first kills any groups a previous launch left
   * behind there (SahilBot crashed or was force-quit). Returns how many groups were reaped.
   */
  trackPids(file: string, o: { table?: Array<{ pid: number; pgid: number; start: number }>; kill?: (pgid: number, sig: NodeJS.Signals) => void } = {}): number {
    this.o.pidFile = file
    const left = staleGroups(readPidFile(file), o.table)
    const kill = o.kill ?? ((pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig) } catch { /* gone */ } })
    for (const g of left) kill(g, 'SIGTERM')
    if (left.length) setTimeout(() => { for (const g of left) kill(g, 'SIGKILL') }, 1500).unref?.()
    this.savePids()
    return left.length
  }

  private savePids(): void {
    const file = this.o.pidFile
    if (!file) return
    const rows: PidEntry[] = [...this.jobs.values()].filter((j) => j.child?.pid).map((j) => ({ pgid: j.child!.pid!, startedAt: j.info.startedAt, command: j.info.command.slice(0, 200) }))
    try {
      if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
      writeFileSync(`${file}.tmp`, JSON.stringify(rows))
      renameSync(`${file}.tmp`, file)
    } catch { /* best effort */ }
  }

  private get maxJobs(): number { return this.o.maxJobs ?? MAX_JOBS }
  private get maxLines(): number { return this.o.maxLines ?? MAX_LINES }

  onEvent(fn: (e: JobEvent) => void): () => void {
    this.subs.add(fn)
    return () => { this.subs.delete(fn) }
  }

  private emit(e: JobEvent): void {
    for (const fn of this.subs) { try { fn(e) } catch { /* a listener must not break the job */ } }
  }

  private changed(j: Job): void { this.emit({ kind: 'job', job: { ...j.info } }) }

  /** Running (or starting) jobs, every chat. */
  running(): JobInfo[] {
    return [...this.jobs.values()].filter((j) => live(j.info.status)).map((j) => ({ ...j.info }))
  }

  /** Jobs of one chat (or every chat), newest first. */
  list(threadId?: string): JobInfo[] {
    return [...this.jobs.values()].filter((j) => !threadId || j.info.threadId === threadId).map((j) => ({ ...j.info })).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): JobInfo | undefined {
    const j = this.jobs.get(id)
    return j ? { ...j.info } : undefined
  }

  /** Starts a job. Throws when MAX_JOBS are already running. */
  start(o: { threadId: string; command: string; cwd: string; env?: NodeJS.ProcessEnv; sandbox?: SandboxSpec }): JobInfo {
    if (this.running().length >= this.maxJobs) {
      const names = this.running().map((j) => `${j.id} (${j.command.slice(0, 40)})`).join(', ')
      throw new Error(`${this.maxJobs} background jobs are already running (${names}). Stop one with the jobs tool first.`)
    }
    const id = `j${++this.seq}`
    const info: JobInfo = { id, threadId: o.threadId, command: o.command, cwd: o.cwd, startedAt: Date.now(), status: 'starting', exitCode: null, urls: [], ports: [], lines: 0, restarts: 0 }
    const j: Job = { info, env: o.env, sandbox: o.sandbox, child: null, buf: [], partial: { stdout: '', stderr: '' }, closed: Promise.resolve(), window: { at: Date.now(), chars: 0 }, hot: 0, listeners: new Set(), pendingLines: [], flushTimer: null, stopping: false }
    this.jobs.set(id, j)
    this.spawn(j)
    this.forgetOld(o.threadId)
    return { ...j.info }
  }

  private spawn(j: Job): void {
    const env = { ...toolEnv({ BROWSER: 'none', ...(j.env ?? {}) }) }
    let child: ChildProcess
    try {
      const run = sandboxed(LOGIN_SHELL, ['-lc', j.info.command], j.sandbox)
      child = spawn(run.file, run.args, { cwd: j.info.cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.push(j, `[could not start: ${(e as Error).message}]`)
      Object.assign(j.info, { status: 'failed', exitCode: -1, endedAt: Date.now() })
      this.changed(j)
      return
    }
    j.child = child
    j.stopping = false
    Object.assign(j.info, { pid: child.pid, status: 'running', exitCode: null, signal: null, endedAt: undefined })
    const onData = (stream: 'stdout' | 'stderr') => (b: Buffer): void => {
      const s = b.toString()
      this.noise(j, s.length)
      const lines = (j.partial[stream] + s).split(/\r?\n|\r(?!\n)/)
      j.partial[stream] = lines.pop() ?? ''
      // A line that never ends (a progress bar) is kept in pieces.
      if (j.partial[stream].length > MAX_LINE_CHARS) { lines.push(j.partial[stream]); j.partial[stream] = '' }
      for (const l of lines) this.push(j, l)
    }
    child.stdout!.on('data', onData('stdout'))
    child.stderr!.on('data', onData('stderr'))
    j.closed = new Promise<void>((done) => {
      const finish = (code: number | null, signal: NodeJS.Signals | null, err?: string): void => {
        if (j.child !== child) return done()
        for (const k of ['stdout', 'stderr'] as const) if (j.partial[k]) { this.push(j, j.partial[k]); j.partial[k] = '' }
        if (err) this.push(j, `[${err}]`)
        j.child = null
        const status = j.stopping ? 'stopped' : code === 0 ? 'exited' : 'failed'
        Object.assign(j.info, { status, exitCode: err ? -1 : code, signal, endedAt: Date.now() })
        this.flush(j)
        this.changed(j)
        for (const fn of j.listeners) fn('')
        this.cpuLoop()
        this.savePids()
        done()
      }
      child.once('close', (code, signal) => finish(code, signal))
      child.once('error', (e) => finish(-1, null, e.message))
    })
    this.changed(j)
    this.cpuLoop()
    this.savePids()
  }

  private noise(j: Job, n: number): void {
    const now = Date.now()
    if (now - j.window.at > 10_000) j.window = { at: now, chars: 0 }
    j.window.chars += n
    if (j.window.chars > NOISY_CHARS && !j.info.warning) {
      j.info.warning = 'Very noisy output (over 2 MB in 10 s): only the last 2000 lines are kept'
      this.changed(j)
    }
  }

  private push(j: Job, raw: string): void {
    const line = stripAnsi(raw).slice(0, MAX_LINE_CHARS)
    j.buf.push(line)
    if (j.buf.length > this.maxLines + 200) j.buf.splice(0, j.buf.length - this.maxLines)
    j.info.lines++
    const { urls, ports } = detectAddresses(line)
    let grew = false
    for (const u of urls) if (!j.info.urls.includes(u) && j.info.urls.length < 8) { j.info.urls.push(u); grew = true }
    for (const p of ports) if (!j.info.ports.includes(p) && j.info.ports.length < 8) { j.info.ports.push(p); grew = true }
    if (grew) this.changed(j)
    for (const fn of j.listeners) fn(line)
    j.pendingLines.push(line)
    if (!j.flushTimer) j.flushTimer = setTimeout(() => this.flush(j), 250)
  }

  private flush(j: Job): void {
    if (j.flushTimer) clearTimeout(j.flushTimer)
    j.flushTimer = null
    if (!j.pendingLines.length) return
    const lines = j.pendingLines.splice(0).slice(-400)
    this.emit({ kind: 'lines', id: j.info.id, threadId: j.info.threadId, lines, total: j.info.lines })
  }

  /** The last `tail` lines (default 80), optionally only lines matching `grep` (text or /regex/). */
  output(id: string, o: { tail?: number; grep?: string } = {}): { lines: string[]; total: number; kept: number } {
    const j = this.jobs.get(id)
    if (!j) throw new Error(`No job ${id}.`)
    const kept = j.buf.slice(-this.maxLines)
    const tail = Math.max(1, Math.min(o.tail ?? 80, this.maxLines))
    let lines = kept
    if (o.grep) {
      const m = /^\/(.+)\/[a-z]*$/.exec(o.grep)
      const re = patternOf(m ? { regex: m[1] } : { text: o.grep })!
      lines = kept.filter((l) => re.test(l))
    }
    return { lines: lines.slice(-tail), total: j.info.lines, kept: kept.length }
  }

  /** Waits for a line (text/regex), a port, or the job's exit, whichever is asked; at most `timeout` s. */
  async wait(id: string, w: WaitFor, signal?: AbortSignal): Promise<WaitResult> {
    const j = this.jobs.get(id)
    if (!j) throw new Error(`No job ${id}.`)
    const t0 = Date.now()
    const limit = Math.max(1, Math.min(w.timeout ?? 60, 900)) * 1000
    const re = patternOf(w)
    const result = (ok: boolean, reason: WaitResult['reason'], line?: string): WaitResult => ({ ok, reason, line, ms: Date.now() - t0, job: { ...j.info } })
    // Already there? (The line may have been printed before the wait started.)
    if (re) { const hit = j.buf.slice(-this.maxLines).find((l) => re.test(l)); if (hit !== undefined) return result(true, 'matched', hit) }
    if (w.port && live(j.info.status) && await portOpen(w.port)) return result(true, 'port')
    if (!live(j.info.status)) return result(!!w.exit && j.info.status === 'exited', 'exited')
    if (!re && !w.port && !w.exit) return result(true, 'matched')
    return new Promise<WaitResult>((done) => {
      let settled = false
      const timers: NodeJS.Timeout[] = []
      const end = (r: WaitResult): void => {
        if (settled) return
        settled = true
        timers.forEach((t) => clearInterval(t))
        j.listeners.delete(onLine)
        signal?.removeEventListener('abort', onAbort)
        done(r)
      }
      const onLine = (line: string): void => {
        if (re && line && re.test(line)) end(result(true, 'matched', line))
        else if (!live(j.info.status)) end(result(!!w.exit && j.info.status === 'exited', 'exited'))
      }
      const onAbort = (): void => end(result(false, 'aborted'))
      j.listeners.add(onLine)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      timers.push(setTimeout(() => end(result(false, 'timeout')), limit))
      if (w.port) {
        let busy = false
        timers.push(setInterval(() => {
          if (busy || settled) return
          busy = true
          void portOpen(w.port!).then((ok) => { busy = false; if (ok) { if (j.info.status === 'running') { j.info.status = 'ready'; this.changed(j) } end(result(true, 'port')) } })
        }, 500))
      }
    }).then((r) => {
      if (r.ok && (r.reason === 'matched' || r.reason === 'port') && j.info.status === 'running') { j.info.status = 'ready'; this.changed(j); r.job = { ...j.info } }
      return r
    })
  }

  private kill(j: Job, sig: NodeJS.Signals): void {
    const pid = j.child?.pid
    if (!pid) return
    try { process.kill(-pid, sig) } catch { try { j.child?.kill(sig) } catch { /* gone */ } }
  }

  /** SIGTERM to the whole process group, SIGKILL after `graceMs` if it's still there. */
  async stop(id: string, graceMs = 3000): Promise<JobInfo | undefined> {
    const j = this.jobs.get(id)
    if (!j) return undefined
    if (!j.child) return { ...j.info }
    j.stopping = true
    this.kill(j, 'SIGTERM')
    const killer = setTimeout(() => this.kill(j, 'SIGKILL'), graceMs)
    // Something may hold the pipes open after the kill: don't wait forever.
    await Promise.race([j.closed, new Promise((r) => setTimeout(r, graceMs + 2000))])
    clearTimeout(killer)
    if (j.child) {
      // Never closed: count it as stopped anyway.
      j.child.stdout?.destroy(); j.child.stderr?.destroy()
      j.child = null
      Object.assign(j.info, { status: 'stopped', endedAt: Date.now() })
      this.changed(j)
    }
    return { ...j.info }
  }

  /** Stops it (if running) and starts the same command again in the same folder, under the same id. */
  async restart(id: string): Promise<JobInfo | undefined> {
    const j = this.jobs.get(id)
    if (!j) return undefined
    await this.stop(id)
    if (this.running().length >= this.maxJobs) throw new Error(`${this.maxJobs} background jobs are already running. Stop one first.`)
    j.info.restarts++
    j.info.startedAt = Date.now()
    j.info.warning = undefined
    j.info.urls = []
    j.info.ports = []
    j.hot = 0
    this.push(j, `── restarted (${j.info.restarts}) ──`)
    this.spawn(j)
    return { ...j.info }
  }

  /** Forgets a job (stopping it first if it still runs). */
  async remove(id: string): Promise<void> {
    const j = this.jobs.get(id)
    if (!j) return
    if (j.child) await this.stop(id)
    this.jobs.delete(id)
    this.emit({ kind: 'removed', id, threadId: j.info.threadId })
  }

  /** Stops every job of these chats (a chat or bot was deleted) and forgets them. */
  async stopThreads(threadIds: string[]): Promise<void> {
    const set = new Set(threadIds)
    await Promise.all([...this.jobs.values()].filter((j) => set.has(j.info.threadId)).map((j) => this.remove(j.info.id)))
  }

  /** Stops every running job (quit). */
  async stopAll(graceMs = 1500): Promise<void> {
    await Promise.all(this.running().map((j) => this.stop(j.id, graceMs)))
  }

  /** Last resort at process exit: SIGKILL every job's process group, synchronously. */
  killAllSync(): void {
    for (const j of this.jobs.values()) if (j.child) this.kill(j, 'SIGKILL')
  }

  private forgetOld(threadId: string): void {
    const done = [...this.jobs.values()].filter((j) => j.info.threadId === threadId && !live(j.info.status)).sort((a, b) => b.info.startedAt - a.info.startedAt)
    for (const j of done.slice(KEEP_FINISHED)) { this.jobs.delete(j.info.id); this.emit({ kind: 'removed', id: j.info.id, threadId }) }
  }

  // ---- CPU runaway check: one `ps` every 10 s while anything runs ----

  private cpuLoop(): void {
    const any = this.running().length > 0
    if (any && !this.cpuTimer) {
      this.cpuTimer = setInterval(() => this.sampleCpu(), this.o.cpuSampleMs ?? CPU_SAMPLE_MS)
      this.cpuTimer.unref?.()
    } else if (!any && this.cpuTimer) {
      clearInterval(this.cpuTimer)
      this.cpuTimer = null
    }
  }

  private sampleCpu(): void {
    execFile('/bin/ps', ['-A', '-o', 'pgid=,pcpu='], { timeout: 4000 }, (err, out) => {
      if (err) return
      const byGroup = new Map<number, number>()
      for (const row of String(out).split('\n')) {
        const m = /^\s*(\d+)\s+([\d.]+)/.exec(row)
        if (m) byGroup.set(Number(m[1]), (byGroup.get(Number(m[1])) ?? 0) + Number(m[2]))
      }
      for (const j of this.jobs.values()) {
        if (!j.child?.pid) continue
        const cpu = Math.round(byGroup.get(j.child.pid) ?? 0)
        const was = j.info.cpu
        j.info.cpu = cpu
        j.hot = cpu >= CPU_RUNAWAY ? j.hot + 1 : 0
        if (j.hot >= 3 && !j.info.warning) {
          j.info.warning = `Using about ${cpu}% CPU for over 30 seconds: it may be stuck in a loop`
          this.changed(j)
        } else if (was !== cpu) this.changed(j)
      }
    })
  }
}

/** The app's job manager (one per process). */
export const jobs = new JobManager()

/** A short line for the model: id, status, uptime, URL. */
export function jobLine(j: JobInfo, now = Date.now()): string {
  const up = Math.round(((j.endedAt ?? now) - j.startedAt) / 1000)
  const t = up < 90 ? `${up}s` : up < 5400 ? `${Math.round(up / 60)}m` : `${(up / 3600).toFixed(1)}h`
  const state = live(j.status) ? `${j.status === 'ready' ? 'ready' : 'running'} · up ${t}` : `${j.status}${j.exitCode !== null && j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ''} after ${t}`
  return `${j.id} · ${state}${j.urls[0] ? ` · ${j.urls[0]}` : j.ports[0] ? ` · port ${j.ports[0]}` : ''}${j.warning ? ` · ⚠ ${j.warning}` : ''}\n  $ ${j.command}\n  in ${j.cwd}`
}

export const isLive = live
