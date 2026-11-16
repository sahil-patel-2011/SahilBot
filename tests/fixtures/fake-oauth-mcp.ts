import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// A local stand-in for a real connector: an OAuth 2.1 authorization server (RFC 8414 metadata,
// RFC 7591 dynamic client registration, PKCE S256, refresh tokens) and an MCP server (Streamable
// HTTP) protected by it (RFC 9728 metadata, WWW-Authenticate on 401). It can also be an open server
// or one that takes an API key. Everything is on 127.0.0.1; nothing leaves the machine.

export interface FakeTool { name: string; description?: string; readOnly?: boolean; reply?: (args: Record<string, unknown>) => string; /** The tool's input schema (default: no properties). */ inputSchema?: Record<string, unknown>; /** Answer with isError (the reply is the error text). */ error?: (args: Record<string, unknown>) => string | null }

export interface FakeOptions {
  /** oauth: sign-in (DCR unless dcr: false); open: no auth; apikey: `Authorization: Bearer <apiKey>`. */
  mode?: 'oauth' | 'open' | 'apikey'
  /** Offer dynamic client registration (default true). */
  dcr?: boolean
  /** Pre-registered clients (oauth-static apps, Google's Desktop client): id → secret (or '' for public). */
  staticClients?: Record<string, string>
  /** Exact redirect URIs the static clients registered (default: any loopback /callback). */
  staticRedirects?: string[]
  apiKey?: string
  /** Access token lifetime in seconds (default 3600). */
  expiresIn?: number
  /** Offer refresh tokens (default true). */
  refresh?: boolean
  tools?: FakeTool[]
  name?: string
  /** Extra plain HTTP routes on the same origin (no auth), e.g. a file download: pathname → handler. */
  routes?: Record<string, (req: IncomingMessage, res: ServerResponse) => void>
}

const loopbackCallback = (u: string): boolean => { try { const x = new URL(u); return x.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(x.hostname) && x.pathname === '/callback' } catch { return false } }
const b64url = (b: Buffer): string => b.toString('base64url')

export interface FakeServer {
  url: string
  origin: string
  close(): Promise<void>
  /** Every access token stops working now (as if it expired); refresh tokens still work. */
  expireAll(): void
  /** Everything is revoked: access and refresh tokens. */
  revokeAll(): void
  log: {
    registrations: Array<Record<string, any>>
    authorizes: URLSearchParams[]
    tokens: Array<{ grant: string; clientId?: string; secret?: string }>
    mcp: Array<{ method?: string; auth?: string; status: number }>
    calls: Array<{ name: string; args: Record<string, unknown> }>
  }
}

export async function startFakeServer(o: FakeOptions = {}): Promise<FakeServer> {
  const mode = o.mode ?? 'oauth'
  const dcr = o.dcr ?? true
  const tools: FakeTool[] = o.tools ?? [
    { name: 'list_items', description: 'Lists items', readOnly: true, reply: () => 'item-1, item-2' },
    { name: 'send_item', description: 'Sends an item to someone', reply: (a) => `sent ${JSON.stringify(a)}` }
  ]
  const clients = new Map<string, { secret?: string; redirects: string[] }>()
  for (const [id, secret] of Object.entries(o.staticClients ?? {})) clients.set(id, { secret: secret || undefined, redirects: o.staticRedirects ?? [] })
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; resource?: string }>()
  const access = new Map<string, { exp: number; revoked?: boolean }>()
  const refreshes = new Map<string, { clientId: string; revoked?: boolean }>()
  const log: FakeServer['log'] = { registrations: [], authorizes: [], tokens: [], mcp: [], calls: [] }
  let origin = ''

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }
  const issue = (clientId: string): Record<string, unknown> => {
    const token = `at_${randomUUID()}`
    access.set(token, { exp: Date.now() + (o.expiresIn ?? 3600) * 1000 })
    const out: Record<string, unknown> = { access_token: token, token_type: 'Bearer', expires_in: o.expiresIn ?? 3600 }
    if (o.refresh ?? true) { const r = `rt_${randomUUID()}`; refreshes.set(r, { clientId }); out.refresh_token = r }
    return out
  }
  const clientAuth = (req: IncomingMessage, form: URLSearchParams): { id?: string; secret?: string } => {
    const basic = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? '')
    if (basic) { const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent); return { id, secret } }
    return { id: form.get('client_id') ?? undefined, secret: form.get('client_secret') ?? undefined }
  }

  const mcpHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req)
    const body = raw ? JSON.parse(raw) : undefined
    const method = Array.isArray(body) ? body[0]?.method : body?.method
    const auth = req.headers.authorization
    const deny = (why: string): void => {
      log.mcp.push({ method, auth, status: 401 })
      const www = mode === 'oauth' ? `Bearer error="invalid_token", error_description="${why}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` : 'Bearer'
      json(res, 401, { error: 'invalid_token', error_description: why }, { 'www-authenticate': www })
    }
    if (mode === 'oauth') {
      const t = /^Bearer\s+(.+)$/i.exec(auth ?? '')?.[1]
      const a = t ? access.get(t) : undefined
      if (!a) return deny('missing or unknown token')
      if (a.revoked) return deny('token revoked')
      if (a.exp < Date.now()) return deny('token expired')
    } else if (mode === 'apikey') {
      if (auth !== `Bearer ${o.apiKey}`) return deny('bad key')
    }
    log.mcp.push({ method, auth, status: 200 })
    const mcp = new McpServer({ name: o.name ?? 'fake', version: '1.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? t.name, inputSchema: t.inputSchema ?? { type: 'object', properties: {} }, ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}) }))
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
      const t = tools.find((x) => x.name === r.params.name)
      const args = (r.params.arguments ?? {}) as Record<string, unknown>
      log.calls.push({ name: r.params.name, args })
      if (!t) return { isError: true, content: [{ type: 'text', text: `no tool ${r.params.name}` }] }
      const err = t.error?.(args)
      if (err) return { isError: true, content: [{ type: 'text', text: err }] }
      return { content: [{ type: 'text', text: t.reply ? t.reply(args) : 'ok' }] }
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => { void transport.close(); void mcp.close() })
    await mcp.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const http: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', origin)
      if (u.pathname === '/mcp') return mcpHandler(req, res)
      const route = o.routes?.[u.pathname]
      if (route) return route(req, res)
      if (mode !== 'oauth') return json(res, 404, { error: 'not_found' })
      if (u.pathname === '/.well-known/oauth-protected-resource/mcp' || u.pathname === '/.well-known/oauth-protected-resource') {
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'], scopes_supported: ['read', 'write'] })
      }
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          ...(dcr ? { registration_endpoint: `${origin}/register` } : {}),
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic']
        })
      }
      if (u.pathname === '/register' && req.method === 'POST' && dcr) {
        const meta = JSON.parse(await readBody(req)) as Record<string, any>
        log.registrations.push(meta)
        const redirects: string[] = meta.redirect_uris ?? []
        if (!redirects.length || !redirects.every(loopbackCallback)) return json(res, 400, { error: 'invalid_redirect_uri' })
        const id = `dcr_${randomUUID().slice(0, 8)}`
        clients.set(id, { redirects })
        return json(res, 201, { ...meta, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) })
      }
      if (u.pathname === '/authorize') {
        const q = u.searchParams
        log.authorizes.push(q)
        const c = clients.get(q.get('client_id') ?? '')
        const redirect = q.get('redirect_uri') ?? ''
        if (!c) return json(res, 400, { error: 'invalid_client' })
        if (!loopbackCallback(redirect) || (c.redirects.length && !c.redirects.includes(redirect))) return json(res, 400, { error: 'invalid_request', error_description: 'redirect_uri mismatch' })
        if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' })
        const code = `code_${randomUUID()}`
        codes.set(code, { clientId: q.get('client_id')!, challenge: q.get('code_challenge')!, redirect, resource: q.get('resource') ?? undefined })
        const back = new URL(redirect)
        back.searchParams.set('code', code)
        if (q.get('state')) back.searchParams.set('state', q.get('state')!)
        res.writeHead(302, { location: back.href })
        return res.end()
      }
      if (u.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const ca = clientAuth(req, form)
        const grant = form.get('grant_type') ?? ''
        log.tokens.push({ grant, clientId: ca.id, secret: ca.secret })
        const c = clients.get(ca.id ?? '')
        if (!c) return json(res, 401, { error: 'invalid_client' })
        if (c.secret && c.secret !== ca.secret) return json(res, 401, { error: 'invalid_client', error_description: 'bad secret' })
        if (grant === 'authorization_code') {
          const rec = codes.get(form.get('code') ?? '')
          codes.delete(form.get('code') ?? '')
          if (!rec || rec.clientId !== ca.id) return json(res, 400, { error: 'invalid_grant' })
          if (rec.redirect !== form.get('redirect_uri')) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' })
          const verifier = form.get('code_verifier') ?? ''
          if (b64url(createHash('sha256').update(verifier).digest()) !== rec.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' })
          return json(res, 200, issue(ca.id!))
        }
        if (grant === 'refresh_token') {
          const r = refreshes.get(form.get('refresh_token') ?? '')
          if (!r || r.revoked || r.clientId !== ca.id) return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' })
          return json(res, 200, issue(ca.id!))
        }
        return json(res, 400, { error: 'unsupported_grant_type' })
      }
      json(res, 404, { error: 'not_found' })
    })().catch((e) => { if (!res.headersSent) json(res, 500, { error: String(e) }) })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  return {
    url: `${origin}/mcp`,
    origin,
    log,
    expireAll: () => { for (const a of access.values()) a.exp = 0 },
    revokeAll: () => { for (const a of access.values()) a.revoked = true; for (const r of refreshes.values()) r.revoked = true },
    close: () => new Promise<void>((r) => { http.closeAllConnections?.(); http.close(() => r()) })
  }
}
