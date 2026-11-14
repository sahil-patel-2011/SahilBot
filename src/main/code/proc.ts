import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve } from 'node:path'

// One way to run a program for the coding tools: its own process group (so Stop and timeouts reach
// everything it started, e.g. a test runner's workers), output streamed line by line to a callback,
// a byte cap on what is kept, and a hard deadline. run_command uses the same runner through zsh.

export interface ProcResult {
  code: number | null
  /** stdout and stderr interleaved as they arrived (capped). */
  output: string
  stdout: string
  stderr: string
  timedOut: boolean
  stopped: boolean
  ms: number
  /** It ran under the write sandbox. */
  sandboxed?: boolean
}

export interface ProcOptions {
  cwd: string
  /** Milliseconds before the whole process group is stopped. */
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Each complete output line (stdout and stderr), as it arrives. */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  /** Characters of output kept (default 400k). */
  maxChars?: number
  /** Text written to stdin, then closed. Omit to give the program no stdin. */
  input?: string
  /** Run under the macOS write sandbox (see sandboxProfile); silently unsandboxed where that isn't available. */
  sandbox?: SandboxSpec
}

// ---------- the write sandbox (defense in depth for run_command and background jobs) ----------

/** Folders a sandboxed command may write (plus temp folders, toolchain caches and /dev). */
export interface SandboxSpec { writable: string[] }

/** Caches and toolchain state builds write under the home folder. */
const HOME_CACHES = ['.npm', '.cache', 'Library/Caches', '.cargo/registry', '.cargo/git', 'go/pkg', '.gradle', '.m2', '.pnpm-store', 'Library/pnpm', '.yarn', '.bun/install',
  '.deno', '.node-gyp', '.electron-gyp', 'Library/Developer', '.swiftpm', 'Library/org.swift.swiftpm', '.rustup/tmp', '.pyenv/shims', '.local/state', '.local/share/virtualenvs']

/** The real path of p, also when its tail doesn't exist yet (sandbox rules match resolved paths). */
function realish(p: string): string {
  let probe = p
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return join(realpathSync(probe), relative(probe, p)) } catch { return p }
}

const sbString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Every folder a sandboxed command may write: yours, temp, caches, /dev. Real paths, deduplicated. */
export function sandboxWritable(spec: SandboxSpec, home = homedir()): string[] {
  const temp = [tmpdir(), '/tmp', '/private/tmp', '/private/var/folders', '/var/tmp', process.env.TMPDIR ?? '']
  const all = [...spec.writable, ...temp, ...HOME_CACHES.map((d) => join(home, d))].filter((p) => p && p.startsWith('/'))
  const out = new Set<string>()
  for (const p of all) {
    const r = realish(resolve(p))
    if (r !== '/') out.add(r)
  }
  return [...out]
}

/**
 * The sandbox-exec profile: everything is allowed (reads, the network, running programs) except writing
 * files outside `writable`, temp folders, toolchain caches and /dev. Later rules win in SBPL, so the
 * allow-list after the blanket deny re-opens exactly those folders.
 */
export function sandboxProfile(spec: SandboxSpec, home = homedir()): string {
  const paths = sandboxWritable(spec, home)
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    '  (subpath "/dev")',
    ...paths.map((p) => `  (subpath ${sbString(p)})`),
    ')',
    ''
  ].join('\n')
}

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
let sandboxOk: boolean | null = null

/** Whether sandbox-exec exists and works here (it can't nest in some environments). Checked once. */
export function sandboxAvailable(): boolean {
  if (sandboxOk !== null) return sandboxOk
  sandboxOk = false
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) return false
  try {
    const r = spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 4000, stdio: 'ignore' })
    sandboxOk = r.status === 0
  } catch { sandboxOk = false }
  return sandboxOk
}

/** For tests: forget the availability check (or force it). */
export const setSandboxAvailable = (v: boolean | null): void => { sandboxOk = v }

/** `file args` wrapped in sandbox-exec when a sandbox is asked for and available; otherwise unchanged. */
export function sandboxed(file: string, args: string[], spec?: SandboxSpec): { file: string; args: string[]; on: boolean } {
  if (!spec || !sandboxAvailable()) return { file, args, on: false }
  return { file: SANDBOX_EXEC, args: ['-p', sandboxProfile(spec), file, ...args], on: true }
}

/** The note added to a sandboxed command's output when a write was refused. */
export const SANDBOX_BLOCKED = '[blocked by SahilBot\'s sandbox: writing outside your folders needs your OK. Ask the user to approve the command, or write inside the workspace or an attached folder.]'
/** Output that shows the sandbox refused a write. */
export const sandboxBlocked = (output: string): boolean => /operation not permitted|EPERM/i.test(output)

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), join(homedir(), '.cargo/bin'), join(homedir(), 'go/bin')]

/** PATH with the usual Homebrew, user and toolchain folders added (GUI apps start with a bare PATH). */
export function toolPath(base = process.env.PATH ?? ''): string {
  const have = new Set(base.split(delimiter).filter(Boolean))
  return [...have, ...EXTRA_PATH.filter((p) => !have.has(p))].join(delimiter)
}

export const toolEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...process.env, PATH: toolPath(), CI: '1', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', ...extra })

const found = new Map<string, string | null>()

/** The full path of an executable on PATH (plus the usual extra folders), or null. Cached. */
export function which(name: string): string | null {
  if (found.has(name)) return found.get(name)!
  let hit: string | null = null
  for (const dir of toolPath().split(delimiter)) {
    const p = join(dir, name)
    try {
      if (existsSync(p)) { accessSync(p, constants.X_OK); hit = p; break }
    } catch { /* not executable */ }
  }
  found.set(name, hit)
  return hit
}

/** Forget cached lookups (tests, or after the user installs something). */
export const forgetWhich = (): void => found.clear()

// eslint-disable-next-line no-control-regex
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '')

/** Runs `file args` in its own process group; never rejects (spawn errors come back as code -1). */
export function runProcess(file: string, args: string[], o: ProcOptions): Promise<ProcResult> {
  const started = Date.now()
  const max = o.maxChars ?? 400_000
  return new Promise((done) => {
    const run = sandboxed(file, args, o.sandbox)
    const child = spawn(run.file, run.args, { cwd: o.cwd, detached: true, env: o.env ?? toolEnv(), stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    let output = ''
    let stdout = ''
    let stderr = ''
    const partial = { stdout: '', stderr: '' }
    const add = (stream: 'stdout' | 'stderr') => (b: Buffer): void => {
      const s = b.toString()
      if (output.length < max) output += s
      if (stream === 'stdout') { if (stdout.length < max) stdout += s } else if (stderr.length < max) stderr += s
      if (!o.onLine) return
      const lines = (partial[stream] + s).split(/\r?\n/)
      partial[stream] = lines.pop() ?? ''
      for (const l of lines) safe(() => o.onLine!(stripAnsi(l), stream))
    }
    child.stdout!.on('data', add('stdout'))
    child.stderr!.on('data', add('stderr'))
    if (o.input !== undefined) { child.stdin!.on('error', () => undefined); child.stdin!.end(o.input) }
    let timedOut = false
    let stopped = false
    let settled = false
    const timers: NodeJS.Timeout[] = []
    const kill = (sig: NodeJS.Signals): void => {
      try { process.kill(-child.pid!, sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
    }
    const finish = (code: number | null, extra = ''): void => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      o.signal?.removeEventListener('abort', stop)
      if (o.onLine) for (const k of ['stdout', 'stderr'] as const) if (partial[k]) safe(() => o.onLine!(stripAnsi(partial[k]), k))
      if (run.on && code !== 0 && sandboxBlocked(output + extra)) extra += `${output.endsWith('\n') || !output ? '' : '\n'}${SANDBOX_BLOCKED}`
      done({ code, output: output + extra, stdout, stderr: stderr + extra, timedOut, stopped, ms: Date.now() - started, sandboxed: run.on })
    }
    // Something may keep the output pipes open after the kill; don't wait on it forever.
    const halt = (): void => {
      kill('SIGTERM')
      timers.push(setTimeout(() => kill('SIGKILL'), 2000))
      timers.push(setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(null) }, 3000))
    }
    const stop = (): void => { stopped = true; halt() }
    timers.push(setTimeout(() => { timedOut = true; halt() }, o.timeoutMs))
    o.signal?.addEventListener('abort', stop, { once: true })
    if (o.signal?.aborted) stop()
    child.on('close', (code) => finish(code))
    child.on('error', (e) => finish(-1, e.message))
  })
}

/** Runs a program and returns stdout, throwing with stderr on a non-zero exit. For short helper calls (git, gh). */
export async function capture(file: string, args: string[], o: { cwd: string; timeoutMs?: number; signal?: AbortSignal; input?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  const r = await runProcess(file, args, { cwd: o.cwd, timeoutMs: o.timeoutMs ?? 30_000, signal: o.signal, input: o.input, env: o.env })
  if (r.code !== 0) {
    const why = r.timedOut ? `timed out after ${Math.round((o.timeoutMs ?? 30_000) / 1000)}s` : r.stopped ? 'stopped' : (stripAnsi(r.stderr || r.stdout).trim() || `exit code ${r.code}`)
    throw new Error(`${file.split('/').pop()} ${args[0] ?? ''}: ${why.slice(0, 1500)}`)
  }
  return r.stdout
}

/** Keeps the start and end of long text, so errors at either end survive. */
export function clip(s: string, max: number, what = 'characters'): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.35)
  const tail = max - head
  return `${s.slice(0, head)}\n… [${s.length - max} ${what} cut] …\n${s.slice(-tail)}`
}

function safe(fn: () => void): void {
  try { fn() } catch { /* a progress callback must never break the run */ }
}

/** Calls fn at most once per `ms` with the latest value (and once more at the end, via flush). */
export function throttle<T>(fn: (v: T) => void, ms: number): { push(v: T): void; flush(): void } {
  let last = 0
  let pending: { v: T } | null = null
  let timer: NodeJS.Timeout | null = null
  const fire = (): void => {
    timer = null
    if (!pending) return
    const v = pending.v
    pending = null
    last = Date.now()
    safe(() => fn(v))
  }
  return {
    push(v) {
      pending = { v }
      const wait = ms - (Date.now() - last)
      if (wait <= 0) fire()
      else if (!timer) timer = setTimeout(fire, wait)
    },
    flush() {
      if (timer) clearTimeout(timer)
      fire()
    }
  }
}
