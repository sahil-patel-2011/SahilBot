import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { bearerOf, fromBrowser, hashToken, hostAllowed, isLoopback, MAX_BODY_BYTES, sameHash } from '../../mcp-server/auth'

// The tool bridge for ChatGPT-plan runs: a loopback MCP server (Streamable HTTP, stateless) that offers
// one Codex run the SahilBot tools of the chat it works for. Each run gets its own random token, handed
// to its codex process in an environment variable (never written to disk) and revoked when the run ends.
// A tool call does not run here: it is handed to SahilBot's agent loop as the model's tool call, so the
// chat's permission mode, approvals, hard stops, taint checks and budgets apply exactly as for any model.

export const BRIDGE_PATH = '/codex-mcp'
/** Run tokens start with this (easy to recognize in a log). */
export const RUN_TOKEN_PREFIX = 'sbr_'

export interface BridgeTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface BridgeResult {
  text: string
  isError?: boolean
}

/** What one run offers through the bridge. */
export interface BridgeSession {
  tools(): BridgeTool[]
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<BridgeResult>
}

const reject = (res: ServerResponse, status: number, message: string): void => {
  res.req?.resume()
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
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

export class ToolBridge {
  private http: HttpServer | null = null
  private sockets = new Set<Socket>()
  /** Token hash → session. Only hashes are kept. */
  private sessions = new Map<string, BridgeSession>()
  private boundPort = 0
  private starting: Promise<number> | null = null

  get port(): number {
    return this.boundPort
  }

  get url(): string {
    return `http://127.0.0.1:${this.boundPort}${BRIDGE_PATH}`
  }

  get size(): number {
    return this.sessions.size
  }

  /** Starts on a free loopback port (once). */
  start(): Promise<number> {
    if (this.http?.listening) return Promise.resolve(this.boundPort)
    this.starting ??= new Promise<number>((ok, fail) => {
      const srv = createServer((req, res) => { void this.handle(req, res) })
      srv.headersTimeout = 15_000
      // A call waits while the user decides on an approval: no request timeout.
      srv.requestTimeout = 0
      srv.on('connection', (s) => { this.sockets.add(s); s.on('close', () => this.sockets.delete(s)) })
      srv.once('error', (e) => { this.starting = null; fail(e) })
      srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        this.http = srv
        this.boundPort = (srv.address() as AddressInfo).port
        this.starting = null
        ok(this.boundPort)
      })
    })
    return this.starting
  }

  /** Registers a run; returns its token (give it to that run only). */
  add(session: BridgeSession): string {
    const token = RUN_TOKEN_PREFIX + randomBytes(32).toString('base64url')
    this.sessions.set(hashToken(token), session)
    return token
  }

  /** Revokes a run's token: later calls with it get 401. */
  remove(token: string): void {
    this.sessions.delete(hashToken(token))
  }

  async stop(): Promise<void> {
    const srv = this.http
    this.http = null
    this.sessions.clear()
    if (!srv) return
    await new Promise<void>((ok) => {
      srv.close(() => ok())
      for (const s of this.sockets) s.destroy()
      this.sockets.clear()
    })
  }

  private find(token: string): BridgeSession | undefined {
    const h = hashToken(token)
    for (const [k, s] of this.sessions) if (sameHash(k, h)) return s
    return undefined
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!isLoopback(req.socket.remoteAddress)) return reject(res, 403, 'Only programs on this Mac can connect.')
      if (!hostAllowed(req.headers.host, this.boundPort)) return reject(res, 403, 'Unexpected Host header.')
      if (fromBrowser(req.headers)) return reject(res, 403, 'Requests from web pages are not allowed.')
      if ((req.url ?? '').split('?')[0] !== BRIDGE_PATH) return reject(res, 404, 'Not found.')
      if (req.method !== 'POST') return reject(res, 405, 'Use POST.')
      const token = bearerOf(req.headers.authorization)
      const session = token ? this.find(token) : undefined
      if (!session) return reject(res, 401, 'Invalid or expired run token.')
      const raw = await readBody(req)
      if (raw === 'too-big') return reject(res, 413, 'Request too large.')
      let body: unknown
      try { body = JSON.parse(raw.toString('utf8')) } catch { return reject(res, 400, 'Body is not JSON.') }
      if (!/application\/json/.test(String(req.headers.accept ?? '')) || !/text\/event-stream/.test(String(req.headers.accept ?? ''))) {
        req.headers.accept = 'application/json, text/event-stream'
      }
      await this.serve(session, req, res, body)
    } catch {
      reject(res, 500, 'Internal error.')
    }
  }

  private async serve(session: BridgeSession, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const server = new Server({ name: 'sahilbot', title: 'SahilBot tools', version: '1' }, {
      capabilities: { tools: {} },
      instructions: 'SahilBot\'s tools for this chat. Every call goes through SahilBot\'s approvals; a denied call returns a message saying so.'
    })
    const ctrl = new AbortController()
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: session.tools() }))
    server.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
      const signal = AbortSignal.any([ctrl.signal, extra.signal])
      const args = (r.params.arguments && typeof r.params.arguments === 'object' ? r.params.arguments : {}) as Record<string, unknown>
      const out = await session.call(r.params.name, args, signal)
      return { content: [{ type: 'text' as const, text: out.text }], ...(out.isError ? { isError: true } : {}) }
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
