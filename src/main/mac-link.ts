import { randomUUID } from 'node:crypto'
import type { ToolDef, ToolOutput } from './agent/types'

// The Mac link: a SahilBot Server (a VPS, a Raspberry Pi) uses the linked Mac for what only the Mac can do:
// find and read its files, run commands there, Messages, Mail, Mac apps, the signed-in browser and the screen.
// The Mac connects out to the server (it long-polls /api/mac/poll over the same pinned HTTPS it already uses),
// so nothing on the Mac is exposed to the internet and no ports are opened.
//
//   phone ── HTTPS (Tailscale) ──► SahilBot Server (VPS, always on) ◄── long-poll ── Mac app (this Mac)
//                                     agent ── mac(tool, args) ──► job ──────────────► runs it, returns the result
//
// Trust: the server asks the user before anything that changes something (on whatever device they're on). The
// Mac doesn't rely on that alone: the link is off until the user turns it on, each tool is opt-in (finding and
// reading files are the only ones on by default), the Mac's own hard stops still apply (deleting, outside the
// home folder, protected places), every change is announced on the Mac and logged, and it's rate-limited. Only
// the one Mac the user linked may poll or answer.

type Effect = 'read' | 'write_local' | 'write_external' | 'destructive'

/** Mac tools the server may use, what each does, and its effect for the server's approval decision. */
export const MAC_TOOLS: Record<string, { effect: Effect; what: string; actions?: { read: string[] } }> = {
  find_files: { effect: 'read', what: 'find files on the Mac by name (Spotlight, your home folder)' },
  file_read: { effect: 'read', what: 'read a file on the Mac (text, PDF, Word, images)' },
  file_write: { effect: 'write_external', what: 'write a file on the Mac' },
  file_manage: { effect: 'write_external', what: 'move, copy or create folders on the Mac' },
  run_command: { effect: 'write_external', what: 'run a Terminal command on the Mac' },
  app: { effect: 'write_external', what: 'Mac apps by their own scripting: Messages (recent chats, search, send), Notes, Calendar, Reminders, Finder…', actions: { read: ['recent', 'chats', 'messages', 'search', 'read', 'list', 'history', 'status'] } },
  mac_apps: { effect: 'write_external', what: 'Notes, Reminders and Calendar on the Mac', actions: { read: ['list', 'search', 'read', 'today', 'upcoming'] } },
  mail: { effect: 'write_external', what: 'Apple Mail on the Mac (read, search, draft, send)', actions: { read: ['list', 'search', 'read', 'recent', 'unread'] } },
  browser: { effect: 'write_external', what: 'the Mac\'s browser, signed in to your sites', actions: { read: ['snapshot', 'read', 'read_page', 'screenshot', 'tabs'] } },
  computer: { effect: 'write_external', what: 'the Mac\'s screen, mouse and keyboard', actions: { read: ['screenshot'] } }
}

/** On by default when the link is turned on: finding and reading files. Everything else is the user's choice. */
export const DEFAULT_MAC_TOOLS = ['find_files', 'file_read']

/**
 * What one call does, for the server's approval. Only a tool with a real `action` enum can be a read by its
 * action (checked against that tool's known read actions); any other key is ignored, so a made-up
 * {"action":"read"} on run_command never skips the question. Deletes are destructive.
 */
export function macEffect(tool: string, args: Record<string, unknown>): Effect {
  const t = MAC_TOOLS[tool]
  if (!t) return 'destructive'
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : ''
  if (t.actions && action && t.actions.read.includes(action)) return 'read'
  if (tool === 'file_manage' && args.op === 'delete') return 'destructive'
  return t.effect
}

export interface MacJob { id: string; tool: string; args: Record<string, unknown> }
export interface MacResult { id: string; ok: boolean; text: string; display?: string; ack?: boolean }

interface Pending { job: MacJob; resolve: (r: MacResult) => void; timer: ReturnType<typeof setTimeout>; sentAt?: number; acked: boolean }

const MAX_QUEUE = 20
const MAX_TEXT = 200_000

/** Server side: jobs for the one linked Mac, handed out when it polls, answered when it posts the result. */
export class MacLinkHub {
  private queue: Pending[] = []
  /** The open poll (one at a time: a new poll ends the previous one, which may be a dead connection). */
  private waiter?: (jobs: MacJob[]) => void
  private lastSeen = Number.NEGATIVE_INFINITY
  private macName = ''
  private tools = new Set<string>()
  constructor(private o: {
    now?: () => number; pollMs?: number; onlineMs?: number; ackMs?: number
    /** The linked Mac's device id, kept by the server across restarts. */
    bound?: { get(): string | undefined; set(id: string): void }
  } = {}) { this.startedAt = this.now() }
  /** When this server started: a restart doesn't count as the linked Mac going quiet. */
  private startedAt: number
  private now(): number { return (this.o.now ?? Date.now)() }
  private boundId?: string

  /** The Mac checked in within the last 45 seconds. */
  online(): boolean { return this.now() - this.lastSeen < (this.o.onlineMs ?? 45_000) }
  status(): { online: boolean; name: string; tools: string[]; lastSeen: number } { return { online: this.online(), name: this.macName, tools: [...this.tools], lastSeen: Number.isFinite(this.lastSeen) ? this.lastSeen : 0 } }

  /**
   * Only the linked Mac: the first app device to poll is bound; another may take over only after the bound one
   * has been silent for 10 minutes (a reinstalled or re-paired Mac). Results must come from it too.
   */
  private allowed(deviceId: string | undefined): boolean {
    const bound = this.boundId ?? this.o.bound?.get()
    if (!deviceId) return !bound
    if (!bound || bound === deviceId) { if (bound !== deviceId) this.bind(deviceId); return true }
    if (this.now() - Math.max(this.lastSeen, this.startedAt) > 10 * 60_000) { this.bind(deviceId); return true }
    return false
  }
  private bind(id: string): void { this.boundId = id; this.o.bound?.set(id) }

  /** The Mac asks for work: answered at once if any is queued, else after up to 25 seconds (long poll). */
  poll(info: { name?: string; tools?: string[] }, deviceId?: string): Promise<MacJob[]> {
    if (!this.allowed(deviceId)) return Promise.reject(Object.assign(new Error('Another Mac is linked to this server.'), { status: 403 }))
    this.lastSeen = this.now()
    if (info.name) this.macName = String(info.name).slice(0, 80)
    if (Array.isArray(info.tools)) this.tools = new Set(info.tools.filter((t) => typeof t === 'string' && t in MAC_TOOLS))
    // Jobs handed to a connection that never acknowledged them (it dropped) go out again.
    for (const p of this.queue) if (p.sentAt !== undefined && !p.acked && this.now() - p.sentAt > (this.o.ackMs ?? 15_000)) p.sentAt = undefined
    this.waiter?.([])
    this.waiter = undefined
    const ready = this.take()
    if (ready.length) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const done = (jobs: MacJob[]): void => { clearTimeout(t); if (this.waiter === done) this.waiter = undefined; resolve(jobs) }
      const t = setTimeout(() => done([]), this.o.pollMs ?? 25_000)
      this.waiter = done
    })
  }

  /** The poll's connection closed before an answer: forget it (its jobs stay queued). */
  dropPoll(): void { this.waiter = undefined }

  private take(): MacJob[] {
    const out = this.queue.filter((p) => p.sentAt === undefined).slice(0, 4)
    for (const p of out) p.sentAt = this.now()
    return out.map((p) => p.job)
  }

  /** The Mac's answer to a job (or its "got it", so the job isn't sent again). */
  result(r: MacResult, deviceId?: string): boolean {
    if (!this.allowed(deviceId)) return false
    this.lastSeen = this.now()
    const p = this.queue.find((x) => x.job.id === r.id)
    if (!p) return false
    if (r.ack) { p.acked = true; return true }
    clearTimeout(p.timer)
    this.queue = this.queue.filter((x) => x !== p)
    p.resolve({ id: r.id, ok: !!r.ok, text: String(r.text ?? '').slice(0, MAX_TEXT), display: typeof r.display === 'string' ? r.display.slice(0, 200) : undefined })
    return true
  }

  /** Runs a tool on the Mac and waits for its result (5 minutes at most). */
  run(tool: string, args: Record<string, unknown>, timeoutMs = 300_000, signal?: AbortSignal): Promise<MacResult> {
    if (!(tool in MAC_TOOLS)) return Promise.resolve({ id: '', ok: false, text: `"${tool}" isn't a Mac tool the server can use. Use one of: ${Object.keys(MAC_TOOLS).join(', ')}.` })
    if (!this.online()) return Promise.resolve({ id: '', ok: false, text: 'Your Mac isn\'t connected right now (asleep, off, or SahilBot isn\'t open). Do what you can on the server, and tell the user to wake the Mac and open SahilBot (or turn on Settings → Phone & server → Keep this Mac awake) for the rest.' })
    if (!this.tools.has(tool)) return Promise.resolve({ id: '', ok: false, text: `The Mac doesn't allow "${tool}" for the server. The user can turn it on in SahilBot on the Mac: Settings → Phone & server → Let the server use this Mac.` })
    if (this.queue.length >= MAX_QUEUE) return Promise.resolve({ id: '', ok: false, text: 'Too many Mac jobs are waiting. Wait for them to finish.' })
    return new Promise((resolve) => {
      const job: MacJob = { id: randomUUID(), tool, args }
      const finish = (r: MacResult): void => { clearTimeout(p.timer); this.queue = this.queue.filter((x) => x !== p); resolve(r) }
      const p: Pending = { job, resolve, acked: false, timer: setTimeout(() => finish({ id: job.id, ok: false, text: 'The Mac didn\'t answer within 5 minutes (it may have gone to sleep). The action may or may not have happened: check before repeating it.' }), timeoutMs) }
      // Stopped in the chat: a job not yet handed out is dropped; one already on the Mac finishes there.
      signal?.addEventListener('abort', () => { if (p.sentAt === undefined) finish({ id: job.id, ok: false, text: 'Stopped before it reached the Mac.' }) }, { once: true })
      this.queue.push(p)
      if (this.waiter) { const w = this.waiter; this.waiter = undefined; w(this.take()) }
    })
  }
}

/** Server side: the agent's tool for the Mac (only while the linked Mac is online). */
export function macTool(hub: MacLinkHub): ToolDef<{ tool: string; args?: Record<string, unknown> }> {
  return {
    name: 'mac',
    label: 'Your Mac',
    core: true,
    effect: (a) => macEffect(String(a.tool ?? ''), (a.args ?? {}) as Record<string, unknown>),
    available: () => hub.online(),
    description: `Use the user's Mac from this server (only the tools the user turned on for it): ${Object.entries(MAC_TOOLS).map(([k, v]) => `${k} (${v.what})`).join('; ')}. Pass the Mac tool's name and its usual arguments, e.g. {"tool":"find_files","args":{"query":"Q3 budget"}}, then {"tool":"file_read","args":{"path":"/Users/…/Q3 budget.xlsx"}}, or {"tool":"app","args":{"app":"messages","action":"recent"}}. If the Mac is offline or a tool isn't allowed, do everything you can on the server and tell the user what's left.`,
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: Object.keys(MAC_TOOLS) },
        args: { type: 'object', description: 'The Mac tool\'s arguments, as you would pass them to it directly.' }
      },
      required: ['tool'],
      additionalProperties: false
    },
    async run(a, ctx): Promise<ToolOutput> {
      const r = await hub.run(String(a.tool), (a.args ?? {}) as Record<string, unknown>, 300_000, ctx?.signal)
      if (!r.ok) throw new Error(r.text)
      return { text: r.text, display: r.display ? `on your Mac: ${r.display}` : 'used your Mac', untrusted: true }
    }
  }
}

/** Mac side: polls the server for jobs and runs them with this Mac's own tools (4 at a time, rate-limited). */
export class MacLinkClient {
  private stopped = true
  private backoff = 1000
  private inFlight = 0
  private recent: Array<{ at: number; write: boolean }> = []
  constructor(private o: {
    /** POST to the server (the pinned, signed-in connection); the reply's status and JSON. */
    call: (path: string, body: unknown, timeoutMs: number) => Promise<{ status: number; json: Record<string, unknown> }>
    /** Runs one of this Mac's tools (hard stops apply), the text it returns. */
    exec: (job: MacJob) => Promise<{ text: string; display?: string }>
    allowed: () => string[]
    name: () => string
    onStatus?: (s: { connected: boolean; error?: string }) => void
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  }) {}

  running(): boolean { return !this.stopped }
  start(): void { if (!this.stopped) return; this.stopped = false; void this.loop() }
  stop(): void { this.stopped = true }

  private async loop(): Promise<void> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    while (!this.stopped) {
      try {
        // Busy with 4 jobs: check in without taking more (the server knows the Mac is still there).
        const r = await this.o.call('/api/mac/poll', { name: this.o.name(), tools: this.inFlight >= 4 ? [] : this.o.allowed() }, 40_000)
        if (r.status !== 200) throw new Error(String(r.json.error ?? `The server answered ${r.status}.`))
        this.backoff = 1000
        this.o.onStatus?.({ connected: true })
        const jobs = (Array.isArray(r.json.jobs) ? r.json.jobs : []) as MacJob[]
        for (const job of jobs) {
          // "Got it" first, so the server doesn't hand the job to another poll; then run it without blocking polls.
          await this.o.call('/api/mac/result', { id: job.id, ack: true }, 15_000).catch(() => undefined)
          this.inFlight++
          void this.handle(job).finally(() => { this.inFlight-- })
        }
      } catch (e) {
        this.o.onStatus?.({ connected: false, error: (e as Error).message })
        if (this.stopped) break
        await sleep(this.backoff)
        this.backoff = Math.min(60_000, this.backoff * 2)
      }
    }
  }

  /** At most 30 jobs a minute, and 5 that change something. */
  private limited(job: MacJob): boolean {
    const now = (this.o.now ?? Date.now)()
    this.recent = this.recent.filter((r) => now - r.at < 60_000)
    const write = macEffect(job.tool, job.args) !== 'read'
    if (this.recent.length >= 30 || (write && this.recent.filter((r) => r.write).length >= 5)) return true
    this.recent.push({ at: now, write })
    return false
  }

  private async handle(job: MacJob): Promise<void> {
    let result: MacResult
    if (!this.o.allowed().includes(job.tool)) result = { id: job.id, ok: false, text: `This Mac doesn't let the server use "${job.tool}".` }
    else if (this.limited(job)) result = { id: job.id, ok: false, text: 'This Mac is limiting the server to 30 actions a minute (5 that change something). Wait a minute and try again.' }
    else {
      try { const out = await this.o.exec(job); result = { id: job.id, ok: true, text: out.text.slice(0, MAX_TEXT), display: out.display } } catch (e) { result = { id: job.id, ok: false, text: (e as Error).message } }
    }
    // Delivered or retried once; a result the server can't take still comes back as a failure, never silence.
    for (let i = 0; i < 2; i++) {
      const r = await this.o.call('/api/mac/result', result, 30_000).catch(() => undefined)
      if (r?.status === 200) return
      if (r?.status === 413) result = { id: job.id, ok: false, text: 'The result was too large to send from the Mac. Ask for a smaller part (a page range, a search).' }
    }
  }
}
