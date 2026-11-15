import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectorPreset } from '@shared/types'
import { Connectors, PRESETS, sameOrigin, apiKeyNeeded, apiKeyRequest, explainKeyError, normalizeApiKey, redactSecret, validateApiKey } from '../../src/main/connectors'
import { ToolRegistry } from '../../src/main/agent/registry'
import { connectBadge, keyProblem, needsKey } from '../../src/renderer/src/lib/connect-catalog'

// API-key connectors: the key is kept only in the (Keychain-backed) secrets store, added to each
// request when it's built, and redacted from every error, status and URL anything else can see.

const KEY = 'sk_live_TESTKEY_0123456789abcdef'
const apikeyPresets = PRESETS.filter((p) => p.auth === 'apikey')

function memSecrets() {
  const m = new Map<string, string>()
  return { m, get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null || v === '') m.delete(k); else m.set(k, v) } }
}
function memDb() {
  const store = new Map<string, unknown>()
  return { store, getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
}

/** A tiny MCP server over Streamable HTTP that records what each request carried; 401 unless the key is right. */
function keyServer(check: (req: IncomingMessage, url: URL) => boolean) {
  const seen: Array<{ url: string; auth?: string; xkey?: string }> = []
  const http: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    seen.push({ url: req.url ?? '', auth: req.headers.authorization, xkey: req.headers['x-api-key'] as string | undefined })
    if (!check(req, url)) {
      // Like a careless server: the error echoes the request URL and header back.
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `invalid api key for ${req.url} (${req.headers.authorization ?? ''})` }))
      return
    }
    const mcp = new McpServer({ name: 'keyed', version: '1' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: 'list_things', description: 'Lists things', inputSchema: { type: 'object', properties: {} } },
      { name: 'send_thing', description: 'Sends a thing', inputSchema: { type: 'object', properties: {} } }
    ] }))
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => { void t.close(); void mcp.close() })
    await mcp.connect(t)
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    await t.handleRequest(req, res, body)
  })
  return { http, seen }
}

describe('API-key presets in the catalog', () => {
  test('there are API-key apps, each with a key page, a hint and how the key is sent', () => {
    expect(apikeyPresets.length).toBeGreaterThan(0)
    for (const p of apikeyPresets) {
      const k = p.apiKey!
      expect(k, p.id).toBeTruthy()
      expect(['header', 'query'], p.id).toContain(k.in)
      expect(k.name.trim(), p.id).not.toBe('')
      expect(k.getKeyUrl, p.id).toMatch(/^https:\/\//)
      expect(k.hint.trim().length, p.id).toBeGreaterThan(5)
      if (k.format) expect(k.format, p.id).toContain('{key}')
      if (k.pattern) expect(() => new RegExp(k.pattern!), p.id).not.toThrow()
      // The stored URL never carries a key.
      expect(p.url, p.id).not.toMatch(/[?&](api[_-]?key|key|token)=/i)
      expect(connectBadge(p), p.id).toBe('API key')
      expect(needsKey(p), p.id).toBe(true)
    }
    // Only API-key apps declare a key spec.
    expect(PRESETS.filter((p) => p.apiKey && p.auth !== 'apikey')).toEqual([])
  })
})

describe('request building', () => {
  test('header keys use the format; query keys go on a copy of the URL only', () => {
    const h = apiKeyRequest('https://mcp.example.com/mcp', { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://x', hint: 'x' }, KEY)
    expect(h.headers).toEqual({ Authorization: `Bearer ${KEY}` })
    expect(h.url.toString()).toBe('https://mcp.example.com/mcp')
    const x = apiKeyRequest('https://mcp.example.com/mcp', { in: 'header', name: 'x-api-key', getKeyUrl: 'https://x', hint: 'x' }, KEY)
    expect(x.headers).toEqual({ 'x-api-key': KEY })
    const stored = 'https://mcp.example.com/mcp?region=us'
    const q = apiKeyRequest(stored, { in: 'query', name: 'apikey', getKeyUrl: 'https://x', hint: 'x' }, 'a&b=c')
    expect(q.url.searchParams.get('apikey')).toBe('a&b=c')
    expect(q.url.searchParams.get('region')).toBe('us')
    expect(q.headers).toEqual({})
    expect(stored).toBe('https://mcp.example.com/mcp?region=us')
  })

  test('pasted keys are tidied and checked', () => {
    expect(normalizeApiKey(`  "Bearer ${KEY}" `, { format: 'Bearer {key}' })).toBe(KEY)
    expect(normalizeApiKey(`Bearer ${KEY}`, {})).toBe(`Bearer ${KEY}`)
    const p = { name: 'Acme', apiKey: { in: 'header' as const, name: 'x', getKeyUrl: 'https://x', hint: 'x', pattern: '^ak_', placeholder: 'ak_…' } }
    expect(validateApiKey('', p)).toMatch(/Paste your Acme API key/)
    expect(validateApiKey('ak_has space', p)).toMatch(/spaces/)
    expect(validateApiKey('ak_1', p)).toMatch(/doesn't look like/)
    expect(validateApiKey('zz_0123456789', p)).toMatch(/they look like ak_/)
    expect(validateApiKey('ak_0123456789', p)).toBeNull()
    expect(keyProblem('', p)).toMatch(/Paste/)
    expect(keyProblem('ok_0123456789', p)).toBeNull()
  })
})

test('sameOrigin compares scheme, host and port only', () => {
  expect(sameOrigin('https://mcp.render.com/mcp?x=1', 'https://mcp.render.com/mcp')).toBe(true)
  expect(sameOrigin('https://evil.example/mcp', 'https://mcp.render.com/mcp')).toBe(false)
  expect(sameOrigin('http://mcp.render.com/mcp', 'https://mcp.render.com/mcp')).toBe(false)
  expect(sameOrigin('https://mcp.render.com.evil.example/mcp', 'https://mcp.render.com/mcp')).toBe(false)
  expect(sameOrigin(undefined, 'https://mcp.render.com/mcp')).toBe(false)
  expect(sameOrigin('not a url', 'https://mcp.render.com/mcp')).toBe(false)
})

describe('redaction', () => {
  test('the exact key, its URL-encoded form and credential-shaped text are removed', () => {
    const weird = 'k/ey+with=chars&more'
    const t = redactSecret(`GET https://x.dev/mcp?apikey=${encodeURIComponent(weird)} failed: ${weird} Bearer abcdefghijklmnop token=zzz123 x-api-key: ${KEY}`, weird, KEY)
    expect(t).not.toContain(weird)
    expect(t).not.toContain(encodeURIComponent(weird))
    expect(t).not.toContain(KEY)
    expect(t).not.toContain('abcdefghijklmnop')
    expect(t).not.toContain('zzz123')
    expect(t).toContain('••••')
    // Ordinary text is left alone.
    expect(redactSecret('fetch failed (ECONNREFUSED)')).toBe('fetch failed (ECONNREFUSED)')
  })

  test('refused keys are explained with where to get a new one', () => {
    const p = apikeyPresets[0]
    expect(explainKeyError('Error POSTing to endpoint (HTTP 401): unauthorized', p)).toContain(p.apiKey!.getKeyUrl)
    expect(explainKeyError('fetch failed', p)).toBe('fetch failed')
    expect(apiKeyNeeded(p)).toMatch(/API key/)
  })
})

describe('storage and connecting', () => {
  let srv: ReturnType<typeof keyServer>
  let base = ''
  const fake: ConnectorPreset = { id: 'zz-query-key', name: 'Query Key', url: 'https://mcp.example.com/mcp', color: '#123456', category: 'Other', domain: 'example.com', auth: 'apikey', description: 'Test-only preset.', apiKey: { in: 'query', name: 'apikey', getKeyUrl: 'https://example.com/keys', hint: 'Settings → Keys' } }
  const header: ConnectorPreset = { ...fake, id: 'zz-header-key', name: 'Header Key', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://example.com/keys', hint: 'Settings → Keys' } }

  beforeAll(async () => {
    srv = keyServer((req, url) => url.searchParams.get('apikey') === KEY || req.headers.authorization === `Bearer ${KEY}`)
    await new Promise<void>((r) => srv.http.listen(0, '127.0.0.1', () => r()))
    base = `http://127.0.0.1:${(srv.http.address() as AddressInfo).port}/mcp`
    // The test apps' own server is the local one (keys are only sent to a preset's own origin).
    fake.url = base
    header.url = base
    PRESETS.push(fake, header)
  })
  afterAll(async () => {
    PRESETS.splice(PRESETS.indexOf(fake), 1)
    PRESETS.splice(PRESETS.indexOf(header), 1)
    await new Promise((r) => srv.http.close(r))
  })

  const make = () => {
    const db = memDb()
    const s = memSecrets()
    const reg = new ToolRegistry()
    return { db, s, reg, c: new Connectors(db as never, s as never, reg, () => undefined) }
  }

  test('a right key (query) is kept in secrets only, sent at request time, and lists tools', async () => {
    const { db, s, reg, c } = make()
    const cfg = c.save({ name: fake.name, kind: 'remote', url: base, preset: fake.id, enabled: true })
    await expect(c.connectPreset(fake.id)).rejects.toThrow(/API key/)
    expect(c.keyIds()).toEqual([])
    const st = await c.setApiKey(fake.id, ` ${KEY} `)
    expect(st.state).toBe('connected')
    expect(st.toolNames).toEqual(['list_things', 'send_thing'])
    expect(reg.all().map((t) => t.name)).toEqual(expect.arrayContaining(['query_key__list_things', 'query_key__send_thing']))
    expect(reg.get('query_key__send_thing')?.effect).toBe('write_external')
    expect(s.get(`mcp:${cfg.id}:apiKey`)).toBe(KEY)
    expect(c.keyIds()).toEqual([cfg.id])
    // The key reached the server on the URL, and nowhere in settings.
    expect(srv.seen.some((r) => r.url.includes(`apikey=${KEY}`))).toBe(true)
    expect(JSON.stringify([...db.store.values()])).not.toContain(KEY)
    expect(c.list()[0].url).toBe(base)
    // Removing the app forgets the key.
    await c.remove(cfg.id)
    expect(s.get(`mcp:${cfg.id}:apiKey`)).toBeUndefined()
  })

  test('a header key is sent as Bearer and never on the URL', async () => {
    const { c } = make()
    c.save({ name: header.name, kind: 'remote', url: base, preset: header.id, enabled: true })
    srv.seen.length = 0
    const st = await c.setApiKey(header.id, `Bearer ${KEY}`)
    expect(st.state).toBe('connected')
    expect(srv.seen.every((r) => r.auth === `Bearer ${KEY}` && !r.url.includes(KEY))).toBe(true)
    await c.disconnect(c.list()[0].id)
  })

  test('a saved address moved to another server never gets the key', async () => {
    const { s, c } = make()
    const cfg = c.save({ name: header.name, kind: 'remote', url: base.replace('127.0.0.1', 'localhost'), preset: header.id, enabled: true })
    s.set(`mcp:${cfg.id}:apiKey`, KEY)
    srv.seen.length = 0
    const st = await c.connect(cfg.id, false)
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/address was changed/)
    expect(st.error).not.toContain(KEY)
    expect(srv.seen).toEqual([])
    await c.disconnect(cfg.id)
  })

  test('a refused key is explained, redacted everywhere, and not kept', async () => {
    const { db, s, c } = make()
    const cfg = c.save({ name: fake.name, kind: 'remote', url: base, preset: fake.id, enabled: true })
    const bad = 'sk_wrong_SECRET_9876543210'
    const st = await c.setApiKey(fake.id, bad)
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/didn't accept the API key/)
    expect(st.error).toContain('https://example.com/keys')
    expect(JSON.stringify(c.statuses())).not.toContain(bad)
    expect(JSON.stringify([...db.store.values()])).not.toContain(bad)
    expect(s.get(`mcp:${cfg.id}:apiKey`)).toBeUndefined()
    await c.disconnect(cfg.id)
  })

  test('bad pastes and non-key apps are refused before anything is saved', async () => {
    const { s, c } = make()
    await expect(c.setApiKey(fake.id, 'has a space')).rejects.toThrow(/spaces/)
    await expect(c.setApiKey('notion', KEY)).rejects.toThrow(/doesn't sign in with an API key/)
    expect(s.m.size).toBe(0)
    expect(c.list()).toEqual([])
  })
})
