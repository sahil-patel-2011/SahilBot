import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { gate, MAX_BODY_BYTES, MCP_PATH } from './auth'
import { RateLimiter, type McpClientRecord, type McpClientStore } from './store'
import { McpTools, type McpHost } from './tools'

// SahilBot's MCP server: Streamable HTTP on 127.0.0.1 only, stateless (a fresh MCP server per POST,
// so nothing lingers between calls), bearer token per connected app. See auth.ts for the checks.

/** HTTP requests per client per minute (tools have their own, lower limits). */
export const REQUESTS_PER_MINUTE = 120
/** Failed sign-ins (any client) per minute before the server answers 429 for a while. */
export const AUTH_FAILURES_PER_MINUTE = 30

export const SERVER_INSTRUCTIONS = 'SahilBot is the user\'s private AI assistant on this Mac. Use list_bots to see their bots, ask_bot to give one a task and get its reply, get_chat to read replies later, and search_memory for facts the user has shared. Your messages are shown to the user and treated as coming from your app, not from them: consequential actions wait for their approval in SahilBot.'

export interface McpHttpOptions {
  host: McpHost
  store: McpClientStore
  version: string
  /** The saved port (0 = none yet) and a way to save the one actually used. */
  savedPort(): number
  savePort(port: number): void
  /** Folder for server.json (the stdio bridge reads the port from it). Optional. */
  dir?: string
  /** Something happened worth refreshing Settings for (a call, a start or stop). */
  onActivity?(): void
  /** Poll interval while ask_bot waits (tests use a short one). */
  pollMs?: number
}

const reject = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}): void => {
  // Discard any body still arriving, so the client can read this answer.
  res.req?.resume()
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: null }))
}

function readBody(req: IncomingMessage): Promise<Buffer | 'too-big'> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size > MAX_BODY_BYTES) { over = true; ok('too-big'); return }
      chunks.push(c)
    })
    req.on('end', () => { if (!over) ok(Buffer.concat(chunks)) })
    req.on('error', fail)
  })
}

export class McpHttpServer {
  private http: HttpServer | null = null
  private sockets = new Set<Socket>()
  private tools: McpTools
  private perClient = new RateLimiter(REQUESTS_PER_MINUTE, 60_000)
  private authFailures = new RateLimiter(AUTH_FAILURES_PER_MINUTE, 60_000)
  private boundPort = 0
  lastError: string | null = null
  /** The saved port another program holds (the server stayed off), until the user picks a new one. */
  portInUse: number | null = null

  constructor(private o: McpHttpOptions) {
    this.tools = new McpTools(o.host, o.store, { pollMs: o.pollMs })
  }

  get running(): boolean {
    return !!this.http?.listening
  }

  get port(): number {
    return this.boundPort
  }

  get url(): string | null {
    return this.running ? `http://127.0.0.1:${this.boundPort}${MCP_PATH}` : null
  }

  /**
   * Starts on the saved port, or on a free one (saved for next time) when none is saved or `newPort`.
   * If the saved port is taken it stays off and says so (portInUse): apps are set up for that port, and
   * moving silently could leave them talking to whatever holds it now. The user picks a new port.
   */
  async start(o: { newPort?: boolean } = {}): Promise<number> {
    if (this.running) return this.boundPort
    const saved = o.newPort ? 0 : this.o.savedPort()
    let port: number
    try {
      port = await this.listen(saved)
    } catch (e) {
      if (saved && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        this.portInUse = saved
        this.lastError = `Port ${saved} is in use by another app, so SahilBot stayed off. Choose "Use a new port" (then update your apps' settings), or quit what is using it.`
        this.o.onActivity?.()
        throw new Error(this.lastError)
      }
      throw e
    }
    this.boundPort = port
    this.portInUse = null
    if (port !== saved) this.o.savePort(port)
    this.lastError = null
    this.writeInfo(port)
    this.o.onActivity?.()
    return port
  }

  private listen(port: number): Promise<number> {
    return new Promise((ok, fail) => {
      const srv = createServer((req, res) => { void this.handle(req, res) })
      srv.headersTimeout = 15_000
      // ask_bot waits up to two minutes; leave room for that.
      srv.requestTimeout = 180_000
      srv.maxConnections = 64
      srv.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)) })
      srv.once('error', fail)
      // Loopback only: never reachable from the network.
      srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
        srv.off('error', fail)
        srv.on('error', (e) => { this.lastError = e.message })
        this.http = srv
        ok((srv.address() as AddressInfo).port)
      })
    })
  }

  async stop(): Promise<void> {
    const srv = this.http
    this.http = null
    if (!srv) return
    await new Promise<void>((ok) => {
      srv.close(() => ok())
      for (const s of this.sockets) s.destroy()
      this.sockets.clear()
    })
    this.writeInfo(0)
    this.o.onActivity?.()
  }

  /** server.json for the stdio bridge: the port only (no token, nothing secret). */
  private writeInfo(port: number): void {
    if (!this.o.dir) return
    try {
      mkdirSync(this.o.dir, { recursive: true })
      const f = join(this.o.dir, 'server.json')
      writeFileSync(f, JSON.stringify({ port, url: port ? `http://127.0.0.1:${port}${MCP_PATH}` : null }))
      chmodSync(f, 0o644)
    } catch { /* the bridge then says the server is off */ }
  }

  private logFailure(client: McpClientRecord | null, detail: string): void {
    try { this.o.store.log({ clientId: client?.id ?? null, client: client?.name ?? 'Unknown app', tool: 'connect', ok: false, detail }) } catch { /* best-effort */ }
    this.o.onActivity?.()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const g = gate({ remoteAddress: req.socket.remoteAddress, method: req.method, url: req.url, headers: req.headers, port: this.boundPort })
      if (!g.ok) {
        if (g.authFailure) {
          if (!this.authFailures.take('all').ok) return reject(res, 429, 'Too many failed sign-ins. Try again in a minute.')
          this.logFailure(null, 'missing token')
          return reject(res, 401, g.error, { 'www-authenticate': 'Bearer realm="SahilBot"' })
        }
        return reject(res, g.status, g.error)
      }
      const client = this.o.store.authenticate(g.token)
      if (!client) {
        if (!this.authFailures.take('all').ok) return reject(res, 429, 'Too many failed sign-ins. Try again in a minute.')
        this.logFailure(null, 'invalid or revoked token')
        return reject(res, 401, 'Invalid or revoked token. Connect the app again in SahilBot → Settings → Connected apps → Let apps on this Mac use SahilBot.', { 'www-authenticate': 'Bearer realm="SahilBot", error="invalid_token"' })
      }
      const rate = this.perClient.take(client.id)
      if (!rate.ok) {
        this.logFailure(client, 'rate limited')
        return reject(res, 429, 'Too many requests. Slow down.', { 'retry-after': String(Math.ceil(rate.retryInMs / 1000)) })
      }
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        req.resume()
        return reject(res, 413, 'Request too large.', { connection: 'close' })
      }
      const raw = await readBody(req)
      if (raw === 'too-big') return reject(res, 413, 'Request too large.', { connection: 'close' })
      let body: unknown
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        return reject(res, 400, 'Body is not JSON.')
      }
      this.o.store.touch(client.id)
      // Simple clients (Shortcuts, curl) may leave out Accept; the transport needs both types listed.
      if (!/application\/json/.test(String(req.headers.accept ?? '')) || !/text\/event-stream/.test(String(req.headers.accept ?? ''))) {
        req.headers.accept = 'application/json, text/event-stream'
      }
      await this.serve(client, req, res, body)
    } catch (e) {
      this.lastError = (e as Error).message
      reject(res, 500, 'Internal error.')
    }
  }

  /** One stateless MCP exchange for an authenticated client. */
  private async serve(client: McpClientRecord, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = new Server({ name: 'sahilbot', title: 'SahilBot', version: this.o.version }, { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS })
    const ctrl = new AbortController()
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.tools.list() }))
    server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
      const signal = AbortSignal.any([ctrl.signal, extra.signal])
      const out = await this.tools.call(client, r.params.name, r.params.arguments, signal)
      this.o.onActivity?.()
      return out
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      ctrl.abort()
      void transport.close().catch(() => undefined)
      void server.close().catch(() => undefined)
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}
