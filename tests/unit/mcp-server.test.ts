import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { bearerOf, fromBrowser, gate, hashToken, hostAllowed, isLoopback, newToken, TOKEN_PREFIX } from '../../src/main/mcp-server/auth'
import { McpHttpServer } from '../../src/main/mcp-server/server'
import { writeShim } from '../../src/main/mcp-server/shim'
import { snippets } from '../../src/main/mcp-server/snippets'
import { ACTIVITY_KEEP, cleanClientName, McpClientStore, RateLimiter } from '../../src/main/mcp-server/store'
import { appMeta, CALLS_PER_MINUTE, checkArgs, McpTools, TOOLS, type McpAgent, type McpHost, type ToolResult } from '../../src/main/mcp-server/tools'
import { cleanMcpServer } from '../../src/main/settings'
import type { ChatEvent, SendInput } from '../../src/shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A stand-in for the Agent: 'reply' answers at once, 'approval' waits on the user, 'slow' runs until finish(). */
class FakeAgent implements McpAgent {
  mode: 'reply' | 'approval' | 'slow' = 'reply'
  sent: SendInput[] = []
  steers: Array<{ threadId: string; text: string; meta?: Record<string, unknown> }> = []
  private runs = new Map<string, { finish: (reply?: string) => void; done: Promise<'finished'> }>()
  private pend = new Map<string, unknown[]>()
  constructor(private db: Db) {}
  isRunning(t: string): boolean { return this.runs.has(t) }
  pending(t: string): unknown[] { return this.pend.get(t) ?? [] }
  async send(input: SendInput): Promise<{ done: Promise<'finished' | 'stopped' | 'error'> }> {
    if (this.runs.has(input.threadId)) throw new Error('still working')
    this.sent.push(input)
    this.db.insertMessage({ threadId: input.threadId, role: 'user', content: input.text, kind: 'normal', status: 'done', meta: { ...(input.note ? { note: input.note } : {}), ...(input.meta ?? {}) } })
    let finish!: (reply?: string) => void
    const done = new Promise<'finished'>((r) => {
      finish = (reply) => {
        if (reply !== undefined) this.db.insertMessage({ threadId: input.threadId, role: 'assistant', content: reply, kind: 'normal', status: 'done' })
        this.runs.delete(input.threadId)
        this.pend.delete(input.threadId)
        r('finished')
      }
    })
    this.runs.set(input.threadId, { finish, done })
    if (this.mode === 'reply') setTimeout(() => finish(`Reply to: ${input.text}`), 5)
    if (this.mode === 'approval') this.pend.set(input.threadId, [{ id: 'req-1' }])
    return { done }
  }
  finish(threadId: string, reply?: string): void { this.runs.get(threadId)?.finish(reply) }
  async steer(threadId: string, text: string, meta?: Record<string, unknown>): Promise<'steered' | 'sent'> {
    if (!this.runs.has(threadId)) { await this.send({ threadId, text, meta }); return 'sent' }
    this.steers.push({ threadId, text, meta })
    return 'steered'
  }
  async whenIdle(threadId: string, signal: AbortSignal, ms: number): Promise<'idle' | 'timeout' | 'aborted'> {
    const run = this.runs.get(threadId)
    if (!run) return 'idle'
    const r = await Promise.race([run.done.then(() => 'idle' as const), sleep(ms).then(() => 'timeout' as const)])
    return signal.aborted ? 'aborted' : r
  }
}

function setup() {
  const db = new Db(':memory:')
  const main = db.createSpace('SahilBot', '#1F1F1F', { isMain: true, shape: 'mascot' })
  const writer = db.createSpace('Writer', '#111111')
  db.updateSpace(writer.id, { label: 'Drafts and edits' })
  const hidden = db.createSpace('Ghost', '#222222')
  db.updateSpace(hidden.id, { hidden: true })
  db.createSpace('Team', '#333333', { kind: 'group', members: [writer.id] })
  const memory = new MemoryStore(db)
  const agent = new FakeAgent(db)
  const events: ChatEvent[] = []
  const secrets: string[] = []
  const host: McpHost = { db, agent, memory, emit: (e) => events.push(e), secretValues: () => secrets }
  const store = new McpClientStore(db)
  const tools = new McpTools(host, store, { pollMs: 10 })
  return { db, main, writer, hidden, memory, agent, events, secrets, host, store, tools }
}

const ctl = (): AbortSignal => new AbortController().signal
const textOf = (r: ToolResult): string => r.content.map((c) => c.text).join('\n')

// ------------------------------------------------------------------ auth (pure)

describe('auth checks', () => {
  test('tokens are long, prefixed, random, and only their hash is kept', () => {
    const a = newToken()
    const b = newToken()
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(a.length).toBeGreaterThanOrEqual(45)
    expect(a).not.toBe(b)
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/)
  })
  test('bearer header parsing', () => {
    expect(bearerOf('Bearer sbm_abcdefgh123')).toBe('sbm_abcdefgh123')
    expect(bearerOf('bearer   sbm_abcdefgh123 ')).toBe('sbm_abcdefgh123')
    expect(bearerOf('Basic dXNlcjpwYXNz')).toBeNull()
    expect(bearerOf('Bearer')).toBeNull()
    expect(bearerOf(undefined)).toBeNull()
    expect(bearerOf('Bearer a b')).toBeNull()
  })
  test('loopback peers only', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10']) expect(isLoopback(a)).toBe(true)
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', 'fe80::1', '', undefined, '0.0.0.0']) expect(isLoopback(a)).toBe(false)
  })
  test('Host must be a loopback name with our port (DNS rebinding)', () => {
    expect(hostAllowed('127.0.0.1:4100', 4100)).toBe(true)
    expect(hostAllowed('localhost:4100', 4100)).toBe(true)
    expect(hostAllowed('[::1]:4100', 4100)).toBe(true)
    expect(hostAllowed('evil.example:4100', 4100)).toBe(false)
    expect(hostAllowed('127.0.0.1:4101', 4100)).toBe(false)
    expect(hostAllowed('127.0.0.1', 4100)).toBe(false)
    expect(hostAllowed(undefined, 4100)).toBe(false)
  })
  test('anything a browser sends is refused', () => {
    expect(fromBrowser({ origin: 'https://evil.example' })).toBe(true)
    expect(fromBrowser({ origin: 'null' })).toBe(true)
    expect(fromBrowser({ 'sec-fetch-site': 'cross-site' })).toBe(true)
    expect(fromBrowser({ 'sec-fetch-dest': 'document' })).toBe(true)
    // Node's fetch (desktop MCP clients) sends sec-fetch-mode only.
    expect(fromBrowser({ 'sec-fetch-mode': 'cors' })).toBe(false)
    expect(fromBrowser({})).toBe(false)
  })
  test('gate order: non-loopback, host, origin, path, method, content type, token', () => {
    const ok = { remoteAddress: '127.0.0.1', method: 'POST', url: '/mcp', port: 5000, headers: { host: '127.0.0.1:5000', 'content-type': 'application/json', authorization: 'Bearer sbm_testtoken1' } }
    expect(gate(ok)).toEqual({ ok: true, token: 'sbm_testtoken1' })
    expect(gate({ ...ok, remoteAddress: '192.168.1.20' })).toMatchObject({ ok: false, status: 403 })
    expect(gate({ ...ok, headers: { ...ok.headers, host: 'attacker.example:5000' } })).toMatchObject({ ok: false, status: 403 })
    expect(gate({ ...ok, headers: { ...ok.headers, origin: 'http://localhost:5000' } })).toMatchObject({ ok: false, status: 403 })
    expect(gate({ ...ok, url: '/other' })).toMatchObject({ ok: false, status: 404 })
    expect(gate({ ...ok, method: 'GET' })).toMatchObject({ ok: false, status: 405 })
    expect(gate({ ...ok, headers: { ...ok.headers, 'content-type': 'text/plain' } })).toMatchObject({ ok: false, status: 415 })
    expect(gate({ ...ok, headers: { ...ok.headers, authorization: undefined } })).toMatchObject({ ok: false, status: 401, authFailure: true })
  })
})

describe('client store', () => {
  test('create, authenticate, revoke; names are cleaned and unique', () => {
    const { store, db } = setup()
    const { client, token } = store.create('  Cursor\u0007 <script> ')
    expect(client.name).toBe('Cursor script')
    expect(JSON.stringify(db.getSetting('mcpServer:clients'))).not.toContain(token)
    expect(store.authenticate(token)?.id).toBe(client.id)
    expect(store.authenticate(`${token}x`)).toBeUndefined()
    expect(() => store.create('cursor script')).toThrow(/already connected/)
    expect(() => store.create('   ')).toThrow(/name/)
    expect(store.revoke(client.id)).toBe(true)
    expect(store.authenticate(token)).toBeUndefined()
    expect(cleanClientName('x'.repeat(100))).toHaveLength(40)
  })
  test('activity log keeps the newest entries', () => {
    const { store } = setup()
    for (let i = 0; i < ACTIVITY_KEEP + 5; i++) store.log({ clientId: null, client: 'A', tool: `t${i}`, ok: true })
    const a = store.activity(ACTIVITY_KEEP + 10)
    expect(a).toHaveLength(ACTIVITY_KEEP)
    expect(a[0].tool).toBe(`t${ACTIVITY_KEEP + 4}`)
  })
  test('rate limiter: a sliding window per key', () => {
    let now = 0
    const r = new RateLimiter(2, 1000, () => now)
    expect(r.take('a').ok).toBe(true)
    expect(r.take('a').ok).toBe(true)
    expect(r.take('a')).toMatchObject({ ok: false })
    expect(r.take('b').ok).toBe(true)
    now = 1001
    expect(r.take('a').ok).toBe(true)
  })
  test('settings: off by default, ports in range', () => {
    expect(cleanMcpServer(undefined)).toEqual({ enabled: false, port: 0 })
    expect(cleanMcpServer({ enabled: 'yes', port: 80 })).toEqual({ enabled: false, port: 0 })
    expect(cleanMcpServer({ enabled: true, port: 41234 })).toEqual({ enabled: true, port: 41234 })
  })
})

// ------------------------------------------------------------------ tools (fake agent)

describe('tools', () => {
  test('list_bots: visible bots only (no hidden bots, groups or projects)', async () => {
    const s = setup()
    const { client } = s.store.create('Cursor')
    const r = await s.tools.call(client, 'list_bots', {}, ctl())
    const bots = JSON.parse(textOf(r)).bots
    expect(bots).toEqual([{ name: 'SahilBot', main: true }, { name: 'Writer', label: 'Drafts and edits' }])
  })

  test('ask_bot: its own Ask-mode chat, marked as the app\'s (untrusted handoff), and returns the reply', async () => {
    const s = setup()
    const { client } = s.store.create('Cursor')
    const r = await s.tools.call(client, 'ask_bot', { bot: 'writer', message: 'Draft a haiku', wait_seconds: 5 }, ctl())
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ status: 'done', bot: 'Writer', reply: 'Reply to: Draft a haiku' })
    const threadId = r.structuredContent!.thread_id as string
    const t = s.db.getThread(threadId)!
    expect(t.spaceId).toBe(s.writer.id)
    expect(t.permissionMode).toBe('ask')
    expect(t.title).toBe('From Cursor')
    const sent = s.agent.sent[0]
    expect(sent.meta).toMatchObject({ handoff: true, tainted: true, mode: 'ask', fromApp: 'Cursor', mcpClientId: client.id })
    expect(sent.note).toMatch(/didn't type it/)
    // The same app reuses its chat; another app gets its own.
    const r2 = await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'Another' }, ctl())
    expect(r2.structuredContent!.thread_id).toBe(threadId)
    const other = s.store.create('Claude Code').client
    const r3 = await s.tools.call(other, 'ask_bot', { bot: 'Writer', message: 'Hi' }, ctl())
    expect(r3.structuredContent!.thread_id).not.toBe(threadId)
    // Logged without the message text.
    const log = s.store.activity()
    expect(log.some((a) => a.tool === 'ask_bot' && a.ok && a.client === 'Cursor')).toBe(true)
    expect(JSON.stringify(log)).not.toContain('haiku')
  })

  test('ask_bot: waiting for the user\'s approval comes back as needs_approval (the app can\'t approve)', async () => {
    const s = setup()
    s.agent.mode = 'approval'
    const { client } = s.store.create('Cursor')
    const started = Date.now()
    const r = await s.tools.call(client, 'ask_bot', { bot: 'SahilBot', message: 'Book it', wait_seconds: 60 }, ctl())
    expect(r.structuredContent).toMatchObject({ status: 'needs_approval', bot: 'SahilBot' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('ask_bot: still working → "working"; get_chat reads the reply later; a second ask steers in', async () => {
    const s = setup()
    s.agent.mode = 'slow'
    const { client } = s.store.create('Cursor')
    const r = await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'Long task', wait_seconds: 0 }, ctl())
    expect(r.structuredContent).toMatchObject({ status: 'working' })
    const threadId = r.structuredContent!.thread_id as string
    const busy = await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'Also this', wait_seconds: 0 }, ctl())
    expect(busy.structuredContent).toMatchObject({ status: 'working' })
    expect(s.agent.steers[0]).toMatchObject({ text: 'Also this', meta: { handoff: true, tainted: true, mcpClientId: client.id } })
    let chat = JSON.parse(textOf(await s.tools.call(client, 'get_chat', { thread_id: threadId }, ctl())))
    expect(chat.status).toBe('working')
    s.agent.finish(threadId, 'All done')
    chat = JSON.parse(textOf(await s.tools.call(client, 'get_chat', { bot: 'Writer' }, ctl())))
    expect(chat.status).toBe('idle')
    expect(chat.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([['app', 'Long task'], ['bot', 'All done']])
  })

  test('get_chat: only this app\'s chats, and only its own turns', async () => {
    const s = setup()
    const a = s.store.create('Cursor').client
    const b = s.store.create('Raycast').client
    const r = await s.tools.call(a, 'ask_bot', { bot: 'Writer', message: 'Q1' }, ctl())
    const threadId = r.structuredContent!.thread_id as string
    // The user types in that chat themselves: neither that nor the reply to it goes back to the app.
    s.db.insertMessage({ threadId, role: 'user', content: 'my private note', kind: 'normal', status: 'done' })
    s.db.insertMessage({ threadId, role: 'assistant', content: 'private answer', kind: 'normal', status: 'done' })
    const mine = JSON.parse(textOf(await s.tools.call(a, 'get_chat', { thread_id: threadId }, ctl())))
    expect(mine.messages.map((m: { text: string }) => m.text)).toEqual(['Q1', 'Reply to: Q1'])
    const theirs = await s.tools.call(b, 'get_chat', { thread_id: threadId }, ctl())
    expect(theirs.isError).toBe(true)
    // A chat the user made themselves isn't readable either.
    const userChat = s.db.createThread(s.writer.id, 'auto', null)
    expect((await s.tools.call(a, 'get_chat', { thread_id: userChat.id }, ctl())).isError).toBe(true)
  })

  test('ask_bot refuses unknown, hidden and group targets, bad arguments, and too much at once', async () => {
    const s = setup()
    const { client } = s.store.create('Cursor')
    const unknown = await s.tools.call(client, 'ask_bot', { bot: 'Nobody', message: 'hi' }, ctl())
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown)).toMatch(/No bot named "Nobody".*Writer/)
    expect((await s.tools.call(client, 'ask_bot', { bot: 'Ghost', message: 'hi' }, ctl())).isError).toBe(true)
    expect((await s.tools.call(client, 'ask_bot', { bot: 'Team', message: 'hi' }, ctl())).isError).toBe(true)
    expect(textOf(await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'x'.repeat(9000) }, ctl()))).toMatch(/longer than/)
    expect(textOf(await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'hi', mode: 'bypass' }, ctl()))).toMatch(/Unknown argument "mode"/)
    expect(textOf(await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'hi', wait_seconds: 999 }, ctl()))).toMatch(/between/)
    expect(textOf(await s.tools.call(client, 'set_settings', {}, ctl()))).toMatch(/Unknown tool/)
    expect(s.agent.sent).toHaveLength(0)
  })

  test('replies never carry vault values', async () => {
    const s = setup()
    s.secrets.push('hunter2-secret')
    s.agent.mode = 'slow'
    const { client } = s.store.create('Cursor')
    const r = await s.tools.call(client, 'ask_bot', { bot: 'Writer', message: 'pw?', wait_seconds: 0 }, ctl())
    s.agent.finish(r.structuredContent!.thread_id as string, 'It is hunter2-secret')
    const chat = textOf(await s.tools.call(client, 'get_chat', { bot: 'Writer' }, ctl()))
    expect(chat).not.toContain('hunter2-secret')
    expect(chat).toContain('[hidden]')
  })

  test('search_memory: shared memories only, never secrets; respects Memory off', async () => {
    const s = setup()
    const { client } = s.store.create('Cursor')
    s.memory.add('Sam lives in Austin, Texas', null, 'location')
    s.memory.add('Writer drafts in a dry tone for Austin clients', s.writer.id, 'rule')
    s.memory.add('Sam\'s Austin gym password is gym1234', null, 'fact')
    s.memory.add('Austin office door code 99887766', null, 'fact')
    s.secrets.push('99887766')
    const r = JSON.parse(textOf(await s.tools.call(client, 'search_memory', { query: 'Austin' }, ctl())))
    expect(r.memories.map((m: { content: string }) => m.content)).toEqual(['Sam lives in Austin, Texas'])
    s.memory.setEnabled(false)
    expect(textOf(await s.tools.call(client, 'search_memory', { query: 'Austin' }, ctl()))).toMatch(/turned off/)
  })

  test('per-client rate limit', async () => {
    const s = setup()
    const a = s.store.create('Cursor').client
    const b = s.store.create('Raycast').client
    for (let i = 0; i < CALLS_PER_MINUTE; i++) expect((await s.tools.call(a, 'list_bots', {}, ctl())).isError).toBeFalsy()
    const over = await s.tools.call(a, 'list_bots', {}, ctl())
    expect(over.isError).toBe(true)
    expect(textOf(over)).toMatch(/Too many calls/)
    expect((await s.tools.call(b, 'list_bots', {}, ctl())).isError).toBeFalsy()
  })

  test('argument checks follow the schema', () => {
    const ask = TOOLS.find((t) => t.name === 'ask_bot')!
    expect(() => checkArgs(ask, { bot: 'a' })).toThrow(/Missing "message"/)
    expect(() => checkArgs(ask, { bot: 'a', message: '   ' })).toThrow(/empty/)
    expect(() => checkArgs(ask, { bot: 'a', message: 'b', wait_seconds: 1.5 })).toThrow(/whole number/)
    expect(() => checkArgs(ask, [])).toThrow(/object/)
    expect(checkArgs(TOOLS[0], undefined)).toEqual({})
    expect(appMeta({ id: 'c1', name: 'X' })).toMatchObject({ handoff: true, mode: 'ask', tainted: true })
  })
})

// ------------------------------------------------------------------ the HTTP server

interface Raw { status: number; headers: Record<string, string | string[] | undefined>; body: string }

function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string }): Promise<Raw> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, path: o.path ?? '/mcp', method: o.method ?? 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(o.headers ?? {}) } }, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: b }))
    })
    req.on('error', fail)
    req.end(o.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  })
}

const servers: McpHttpServer[] = []
afterEach(async () => { for (const s of servers.splice(0)) await s.stop() })

async function startServer() {
  const s = setup()
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  let saved = 0
  const server = new McpHttpServer({ host: s.host, store: s.store, version: '0.0.0-test', savedPort: () => saved, savePort: (p) => { saved = p }, dir, pollMs: 10 })
  servers.push(server)
  const port = await server.start()
  return { ...s, server, port, dir, saved: () => saved }
}

describe('MCP server over HTTP', () => {
  test('binds to 127.0.0.1 on a free port, saves it, and writes server.json (no token in it)', async () => {
    const h = await startServer()
    expect(h.port).toBeGreaterThan(0)
    expect(h.saved()).toBe(h.port)
    expect(h.server.url).toBe(`http://127.0.0.1:${h.port}/mcp`)
    const info = JSON.parse(readFileSync(join(h.dir, 'server.json'), 'utf8'))
    expect(info.port).toBe(h.port)
  })

  test('missing, invalid and revoked tokens are refused (401) and logged', async () => {
    const h = await startServer()
    const missing = await raw(h.port, {})
    expect(missing.status).toBe(401)
    expect(String(missing.headers['www-authenticate'])).toMatch(/Bearer/)
    expect((await raw(h.port, { headers: { authorization: `Bearer ${newToken()}` } })).status).toBe(401)
    const { client, token } = h.store.create('Cursor')
    const okRes = await raw(h.port, { headers: { authorization: `Bearer ${token}` } })
    expect(okRes.status).toBe(200)
    expect(JSON.parse(okRes.body).result.tools.map((t: { name: string }) => t.name)).toEqual(['list_bots', 'ask_bot', 'get_chat', 'search_memory'])
    h.store.revoke(client.id)
    expect((await raw(h.port, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401)
    const fails = h.store.activity().filter((a) => a.tool === 'connect' && !a.ok)
    expect(fails.length).toBe(3)
  })

  test('browser requests are refused even with a valid token: Origin, rebinding Host, CORS preflight', async () => {
    const h = await startServer()
    const { token } = h.store.create('Cursor')
    const auth = { authorization: `Bearer ${token}` }
    const status = (o: Parameters<typeof raw>[1]): Promise<number | string> => raw(h.port, o).then((r) => r.status, (e: Error) => `error: ${e.message}`)
    const got = [
      await status({ headers: { ...auth, origin: 'https://evil.example' } }),
      await status({ headers: { ...auth, origin: 'null' } }),
      await status({ headers: { ...auth, host: `rebind.evil.example:${h.port}` } }),
      await status({ headers: { ...auth, 'content-type': 'text/plain' } }),
      await status({ method: 'GET', headers: auth, body: '' }),
      await status({ path: '/', headers: auth }),
      await status({ headers: auth, body: 'x'.repeat(1024 * 1024 + 10) })
    ]
    expect(got).toEqual([403, 403, 403, 415, 405, 404, 413])
    const pre = await raw(h.port, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' }, body: '' })
    expect(pre.status).toBe(403)
    expect(pre.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('a real MCP client (SDK) lists tools and calls them', async () => {
    const h = await startServer()
    const { token } = h.store.create('Claude Code')
    const client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(h.server.url!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    expect(client.getServerVersion()?.name).toBe('sahilbot')
    expect(client.getInstructions()).toMatch(/approval/)
    const tools = await client.listTools()
    expect(tools.tools.find((t) => t.name === 'ask_bot')?.annotations?.readOnlyHint).toBe(false)
    const bots = await client.callTool({ name: 'list_bots', arguments: {} })
    expect(JSON.stringify(bots.content)).toContain('Writer')
    const ask = await client.callTool({ name: 'ask_bot', arguments: { bot: 'Writer', message: 'Hello there', wait_seconds: 5 } })
    expect(ask.structuredContent).toMatchObject({ status: 'done', reply: 'Reply to: Hello there' })
    await client.close()
    expect(h.store.list()[0].lastUsedAt).not.toBeNull()
  })

  test('one plain POST works without a session or Accept header (Shortcuts, curl)', async () => {
    const h = await startServer()
    const { token } = h.store.create('Shortcuts')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_bot', arguments: { bot: 'SahilBot', message: 'Ping', wait_seconds: 5 } } })
    const r = await raw(h.port, { headers: { authorization: `Bearer ${token}` }, body })
    expect(r.status).toBe(200)
    const j = JSON.parse(r.body)
    expect(j.id).toBe(7)
    expect(j.result.content[0].text).toBe('Reply to: Ping')
  })

  test('stop closes the port and marks server.json off', async () => {
    const h = await startServer()
    await h.server.stop()
    expect(h.server.running).toBe(false)
    await expect(raw(h.port, {})).rejects.toThrow()
    expect(JSON.parse(readFileSync(join(h.dir, 'server.json'), 'utf8')).port).toBe(0)
  })

  test('config snippets carry the URL and token', () => {
    const s = snippets('http://127.0.0.1:4100/mcp', 'sbm_tok', '/x/sahilbot-mcp')
    expect(JSON.parse(s.cursor)).toEqual({ mcpServers: { sahilbot: { url: 'http://127.0.0.1:4100/mcp', headers: { Authorization: 'Bearer sbm_tok' } } } })
    expect(s.claudeCode).toBe('claude mcp add --transport http sahilbot http://127.0.0.1:4100/mcp --header "Authorization: Bearer sbm_tok"')
    expect(JSON.parse(s.claudeDesktop).mcpServers.sahilbot).toEqual({ command: '/x/sahilbot-mcp', env: { SAHILBOT_MCP_TOKEN: 'sbm_tok' } })
    expect(s.curl).toContain('tools/call')
  })
})

describe('stdio bridge (sahilbot-mcp)', () => {
  /** Runs the bridge with some JSON-RPC lines and collects what it writes. */
  function bridge(launcher: string, env: Record<string, string>, lines: unknown[]): Promise<Array<Record<string, any>>> {
    return new Promise((ok, fail) => {
      const p = spawn('/bin/sh', [launcher], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => (out += d))
      p.stderr.on('data', (d) => (err += d))
      p.on('error', fail)
      p.on('exit', () => {
        try { ok(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))) } catch (e) { fail(new Error(`${(e as Error).message}\n${out}\n${err}`)) }
      })
      for (const l of lines) p.stdin.write(`${JSON.stringify(l)}\n`)
      p.stdin.end()
    })
  }

  test('proxies stdio to the local server with the token from the environment', async () => {
    const h = await startServer()
    const { token } = h.store.create('Claude Desktop')
    // The launcher runs the bridge on "SahilBot as Node"; here that's Node itself.
    const launcher = writeShim(h.dir, process.execPath)
    expect(statSync(launcher).mode & 0o111).toBeTruthy()
    const out = await bridge(launcher, { SAHILBOT_MCP_TOKEN: token }, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_bots', arguments: {} } }
    ])
    const byId = Object.fromEntries(out.map((m) => [m.id, m]))
    expect(byId[1].result.serverInfo.name).toBe('sahilbot')
    expect(byId[2].result.content[0].text).toContain('Writer')
    expect(out).toHaveLength(2)
  })

  test('a wrong or missing token comes back as a JSON-RPC error, not a crash', async () => {
    const h = await startServer()
    const launcher = writeShim(h.dir, process.execPath)
    const bad = await bridge(launcher, { SAHILBOT_MCP_TOKEN: newToken() }, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
    expect(bad[0]).toMatchObject({ id: 1, error: { message: expect.stringMatching(/Invalid or revoked/) } })
    const none = await bridge(launcher, { SAHILBOT_MCP_TOKEN: '' }, [{ jsonrpc: '2.0', id: 3, method: 'tools/list' }])
    expect(none[0]).toMatchObject({ id: 3, error: { message: expect.stringMatching(/SAHILBOT_MCP_TOKEN/) } })
  })
})
