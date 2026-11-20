import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

// A client for `codex app-server`, OpenAI's documented protocol for embedding Codex in an app
// (developers.openai.com/codex/app-server): JSON-RPC 2.0 messages, one per line on stdio, with the
// "jsonrpc" field left out. Requests carry an id; notifications don't; the server also sends requests
// of its own (approvals), which `onRequest` answers.

export interface RpcMessage {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface AppServerOptions {
  /** The codex executable. */
  bin: string
  /** Arguments after the binary: ['app-server', '-c', 'key=value', …]. */
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  jsonrpc?: boolean
  /** Server → client requests (approvals, elicitations). The returned value is the result sent back. */
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>
  onNotification?: (method: string, params: unknown) => void
  /** The process ended (crash, kill, or close()). */
  onExit?: (code: number | null, stderr: string) => void
}

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message)
  }
}

/** One running `codex app-server` process. */
export class AppServer {
  private proc: ChildProcessWithoutNullStreams
  private next = 1
  private waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; method: string }>()
  private buf = ''
  private stderr = ''
  exited = false

  constructor(private o: AppServerOptions) {
    this.proc = spawn(o.bin, o.args, { env: o.env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    // Keep the tail only: it's for the error message if the process dies.
    this.proc.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.proc.on('error', (e) => this.finish(null, e.message))
    this.proc.on('exit', (code) => this.finish(code, this.stderr))
    this.proc.stdin.on('error', () => undefined)
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  private finish(code: number | null, why: string): void {
    if (this.exited) return
    this.exited = true
    const msg = why.trim().split('\n').slice(-3).join(' ').slice(0, 400)
    for (const [, w] of this.waiting) w.fail(new RpcError(`Codex stopped${code !== null ? ` (exit ${code})` : ''}${msg ? `: ${msg}` : ''}`))
    this.waiting.clear()
    this.o.onExit?.(code, this.stderr)
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: RpcMessage
      try { msg = JSON.parse(line) as RpcMessage } catch { continue }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: RpcMessage): void {
    // A response to one of ours.
    if (msg.id !== undefined && msg.method === undefined) {
      const w = this.waiting.get(Number(msg.id))
      if (!w) return
      this.waiting.delete(Number(msg.id))
      if (msg.error) w.fail(new RpcError(msg.error.message ?? `${w.method} failed`, msg.error.code, msg.error.data))
      else w.ok(msg.result)
      return
    }
    // A request from the server (it waits for our answer).
    if (msg.id !== undefined && msg.method) {
      const id = msg.id
      Promise.resolve()
        .then(() => this.o.onRequest ? this.o.onRequest(msg.method!, msg.params) : Promise.reject(new RpcError('Not supported', -32601)))
        .then((result) => this.write({ id, result: result ?? {} }))
        .catch((e: Error) => this.write({ id, error: { code: (e as RpcError).code ?? -32603, message: e.message } }))
      return
    }
    if (msg.method) this.o.onNotification?.(msg.method, msg.params)
  }

  private write(msg: RpcMessage): void {
    if (this.exited || !this.proc.stdin.writable) return
    this.proc.stdin.write(`${JSON.stringify(this.o.jsonrpc ? { jsonrpc: '2.0', ...msg } : msg)}\n`)
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.exited) return Promise.reject(new RpcError('Codex is not running'))
    const id = this.next++
    return new Promise<T>((ok, fail) => {
      const t = timeoutMs > 0 ? setTimeout(() => { this.waiting.delete(id); fail(new RpcError(`Codex didn't answer ${method} in ${Math.round(timeoutMs / 1000)}s`)) }, timeoutMs) : undefined
      this.waiting.set(id, {
        method,
        ok: (v) => { if (t) clearTimeout(t); ok(v as T) },
        fail: (e) => { if (t) clearTimeout(t); fail(e) }
      })
      this.write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) })
  }

  /** initialize + initialized, as the protocol requires once per connection. */
  async initialize(version: string, experimentalApi = false): Promise<unknown> {
    const r = await this.request('initialize', { clientInfo: { name: 'sahilbot', title: 'SahilBot', version }, ...(experimentalApi ? { capabilities: { experimentalApi } } : {}) }, 30_000)
    this.notify('initialized')
    return r
  }

  close(): void {
    if (this.exited) return
    try { this.proc.stdin.end() } catch { /* already closed */ }
    const p = this.proc
    setTimeout(() => { if (!this.exited) try { p.kill('SIGTERM') } catch { /* gone */ } }, 1500).unref?.()
    setTimeout(() => { if (!this.exited) try { p.kill('SIGKILL') } catch { /* gone */ } }, 5000).unref?.()
  }

  kill(): void {
    if (this.exited) return
    try { this.proc.kill('SIGTERM') } catch { /* gone */ }
  }
}
