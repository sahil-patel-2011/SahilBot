import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { ConnectorPreset, ModelInfo, Settings } from '@shared/types'
import { Connectors, PRESETS, headlessSignIn, isLoopbackUrl, setupRedirect } from '../../src/main/connectors'
import { ToolRegistry } from '../../src/main/agent/registry'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { coreTools } from '../../src/main/agent/tools/core'
import { Db } from '../../src/main/db'
import { APP_STATE_TEXT, appState, checkSummary } from '../../src/renderer/src/lib/connect-catalog'
import { startFakeServer, type FakeServer } from '../fixtures/fake-oauth-mcp'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// End to end, without real accounts: every way an app signs in, against a local fake authorization
// server and MCP server (tests/fixtures/fake-oauth-mcp.ts). The "browser" is a headless fetch that
// follows the consent redirect back to SahilBot's loopback callback, the way a real browser would.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

function memSecrets() {
  const m = new Map<string, string>()
  return { m, get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null || v === '') m.delete(k); else m.set(k, v) } }
}
function memDb() {
  const store = new Map<string, unknown>()
  return { store, getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
}

/** A Connectors instance whose "browser" signs in headlessly and records every page it was sent to. */
function app(db = memDb(), secrets = memSecrets(), registry = new ToolRegistry()) {
  const opened: string[] = []
  const c = new Connectors(db as never, secrets as never, registry, () => undefined, {
    openExternal: async (url) => { opened.push(url); await headlessSignIn(url) }
  })
  return { c, db, secrets, registry, opened }
}

const servers: FakeServer[] = []
const fake = async (...a: Parameters<typeof startFakeServer>): Promise<FakeServer> => { const s = await startFakeServer(...a); servers.push(s); return s }
const extra: ConnectorPreset[] = []
const withPreset = (p: ConnectorPreset): ConnectorPreset => { PRESETS.push(p); extra.push(p); return p }
afterEach(async () => {
  for (const p of extra.splice(0)) PRESETS.splice(PRESETS.indexOf(p), 1)
})
afterAll(async () => { await Promise.all(servers.map((s) => s.close())) })

describe('headless sign-in helper', () => {
  test('only follows loopback addresses', async () => {
    expect(isLoopbackUrl('http://127.0.0.1:5/x')).toBe(true)
    expect(isLoopbackUrl('http://localhost:5/x')).toBe(true)
    expect(isLoopbackUrl('https://accounts.google.com/o/oauth2')).toBe(false)
    await expect(headlessSignIn('https://example.com/authorize')).rejects.toThrow(/loopback/)
  })
})

describe('OAuth with dynamic client registration (one click)', () => {
  test('discovery → registration → PKCE sign-in in the browser → loopback callback → token → tools', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    const st = await a.c.connect(cfg.id, true)
    expect(st.state).toBe('connected')
    expect(st.toolNames).toEqual(['list_items', 'send_item'])
    // It registered itself, once, as a public client with loopback redirects.
    expect(s.log.registrations).toHaveLength(1)
    const reg = s.log.registrations[0]
    expect(reg.client_name).toBe('SahilBot')
    expect(reg.token_endpoint_auth_method).toBe('none')
    expect(reg.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(reg.redirect_uris.every((u: string) => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/callback$/.test(u))).toBe(true)
    // The browser was sent to the authorize page with PKCE S256, state and the resource indicator.
    expect(a.opened).toHaveLength(1)
    const q = new URL(a.opened[0]).searchParams
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(q.get('state')).toBeTruthy()
    expect(q.get('resource')).toBe(s.url)
    expect(q.get('redirect_uri')).toBe(reg.redirect_uris[0])
    expect(s.log.tokens.map((t) => t.grant)).toEqual(['authorization_code'])
    // Tokens are kept (in the Keychain-backed store), and the tools are agent tools now.
    expect(JSON.parse(a.secrets.get(`mcp:${cfg.id}:tokens`)!).access_token).toMatch(/^at_/)
    expect(a.registry.get('notes_cloud__list_items')?.effect).toBe('read')
    expect(a.registry.get('notes_cloud__send_item')?.effect).toBe('write_external')
    const out = await a.registry.get('notes_cloud__list_items')!.run({}, { signal: new AbortController().signal } as never)
    expect(out.text).toBe('item-1, item-2')
    await a.c.disconnect(cfg.id)
  })

  test('an expired access token is refreshed on its own: no browser, still connected', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    const before = JSON.parse(a.secrets.get(`mcp:${cfg.id}:tokens`)!).access_token
    s.expireAll()
    const st = await a.c.test(cfg.id)
    expect(st.state).toBe('connected')
    expect(s.log.tokens.map((t) => t.grant)).toEqual(['authorization_code', 'refresh_token'])
    expect(JSON.parse(a.secrets.get(`mcp:${cfg.id}:tokens`)!).access_token).not.toBe(before)
    // A tool call after another expiry refreshes too.
    s.expireAll()
    const out = await a.registry.get('notes_cloud__list_items')!.run({}, { signal: new AbortController().signal } as never)
    expect(out.text).toBe('item-1, item-2')
    expect(a.opened).toHaveLength(1)
    await a.c.disconnect(cfg.id)
  })

  test('a revoked sign-in shows "needs sign-in again" (no browser pops up); Reconnect signs in with one click', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    await a.c.connect(cfg.id, true)
    s.revokeAll()
    const st = await a.c.test(cfg.id)
    expect(st).toMatchObject({ state: 'needs_auth', reason: 'expired' })
    expect(st.error).toMatch(/expired or was revoked.*Reconnect/)
    expect(a.opened).toHaveLength(1)
    expect(a.registry.get('notes_cloud__list_items')).toBeUndefined()
    expect(appState(undefined, st)).toBe('reauth')
    expect(APP_STATE_TEXT[appState(undefined, st)]).toBe('Needs sign-in again')
    // Reconnect (interactive) opens the sign-in page once and comes back connected.
    const again = await a.c.connect(cfg.id, true)
    expect(again.state).toBe('connected')
    expect(a.opened).toHaveLength(2)
    await a.c.disconnect(cfg.id)
  })

  test('revoked mid-chat: the tool call says to press Reconnect, and the app shows needs sign-in again', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    await a.c.connect(cfg.id, true)
    const tool = a.registry.get('notes_cloud__list_items')!
    s.revokeAll()
    await expect(tool.run({}, { signal: new AbortController().signal } as never)).rejects.toThrow(/sign-in expired or was revoked.*Reconnect/)
    await expect.poll(() => a.c.statuses()[0]).toMatchObject({ state: 'needs_auth', reason: 'expired' })
    expect(a.opened).toHaveLength(1)
  })

  test('after an app restart it reconnects from saved tokens without a browser; revoked while closed: needs sign-in again', async () => {
    const s = await fake()
    const first = app()
    const cfg = first.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    await first.c.connect(cfg.id, true)
    await first.c.disconnect(cfg.id)
    // "Restart": a new instance over the same settings and Keychain.
    const second = app(first.db, first.secrets)
    await second.c.connectAll()
    expect(second.c.statuses()[0].state).toBe('connected')
    expect(second.opened).toHaveLength(0)
    expect(s.log.registrations).toHaveLength(1)
    expect(second.registry.get('notes_cloud__send_item')).toBeTruthy()
    await second.c.disconnect(cfg.id)
    s.revokeAll()
    const third = app(first.db, first.secrets)
    await third.c.connectAll()
    expect(third.c.statuses()[0]).toMatchObject({ state: 'needs_auth', reason: 'expired' })
    expect(third.opened).toHaveLength(0)
  })

  test('Check all re-tests live apps and retries failing ones without opening the browser', async () => {
    const s = await fake()
    const down = await fake()
    const a = app()
    const ok = a.c.save({ name: 'Good', kind: 'remote', url: s.url, enabled: true })
    const bad = a.c.save({ name: 'Bad', kind: 'remote', url: down.url, enabled: true })
    await a.c.connect(ok.id, true)
    await a.c.connect(bad.id, true)
    down.revokeAll()
    await a.c.test(bad.id)
    const sts = await a.c.checkEvery()
    const states = sts.map((x) => appState(undefined, x))
    expect(states).toEqual(['connected', 'reauth'])
    expect(checkSummary(states)).toBe('1 working · 1 needs sign-in again')
    expect(a.opened).toHaveLength(2)
    // A server that stopped answering reads as unavailable right now.
    await down.close()
    servers.splice(servers.indexOf(down), 1)
    const off = await a.c.connect(bad.id, false)
    expect(appState(undefined, off)).toBe('unavailable')
    await a.c.disconnect(bad.id)
    await a.c.disconnect(ok.id)
  })
})

describe('one-time setup apps (oauth-static)', () => {
  test('with the pasted client ID it signs in on the fixed redirect URL; no registration', async () => {
    // The real Slack preset's fixed redirect (http://localhost:47613/callback); the server is the fake.
    const redirect = PRESETS.find((p) => p.id === 'slack')!.setup!.redirectUri
    const s = await fake({ dcr: false, staticClients: { 'slack-client-123': '' }, staticRedirects: [redirect] })
    const a = app()
    expect(() => a.c.save({ name: 'Slack', kind: 'remote', url: s.url, preset: 'slack', enabled: true })).toThrow(/one-time setup/)
    const cfg = a.c.save({ name: 'Slack', kind: 'remote', url: s.url, preset: 'slack', enabled: true, clientId: 'slack-client-123' })
    const st = await a.c.connect(cfg.id, true)
    expect(st.state).toBe('connected')
    expect(s.log.registrations).toHaveLength(0)
    const q = new URL(a.opened[0]).searchParams
    expect(q.get('client_id')).toBe('slack-client-123')
    expect(q.get('redirect_uri')).toBe(redirect)
    expect(q.get('code_challenge_method')).toBe('S256')
    // Its tools are agent tools under the app's name.
    expect(a.registry.get('slack__send_item')).toBeTruthy()
    await a.c.disconnect(cfg.id)
  })

  test('a client secret, when the provider issued one, is sent to the token endpoint', async () => {
    const redirect = setupRedirect('127.0.0.1')
    const s = await fake({ dcr: false, staticClients: { 'gh-client': 'gh-secret-xyz' }, staticRedirects: [redirect] })
    const a = app()
    const cfg = a.c.save({ name: 'GitHub', kind: 'remote', url: s.url, preset: 'github', enabled: true, clientId: 'gh-client' })
    a.secrets.set(`mcp:${cfg.id}:clientSecret`, 'gh-secret-xyz')
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    expect(s.log.tokens[0]).toMatchObject({ grant: 'authorization_code', clientId: 'gh-client', secret: 'gh-secret-xyz' })
    await a.c.disconnect(cfg.id)
  })

  test('without a client ID the app says it needs setup', async () => {
    const a = app()
    await expect(a.c.connectPreset('slack')).rejects.toThrow(/one-time setup/)
    expect(appState(PRESETS.find((p) => p.id === 'slack'), undefined, { setupMissing: true })).toBe('setup')
  })
})

describe('Google apps (shared "Set up Google once" client)', () => {
  test('one Google client signs in Gmail on any loopback port, with its secret', async () => {
    const client = '1234567890-abcdefghijk.apps.googleusercontent.com'
    const s = await fake({ dcr: false, staticClients: { [client]: 'GOCSPX-abcdefghijklmnopqrstu' } })
    const a = app()
    expect(() => a.c.save({ name: 'Gmail', kind: 'remote', url: s.url, preset: 'gmail', enabled: true })).toThrow(/one-time setup/)
    a.c.setGoogleClient(client, 'GOCSPX-abcdefghijklmnopqrstu')
    const cfg = a.c.save({ name: 'Gmail', kind: 'remote', url: s.url, preset: 'gmail', enabled: true })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    const q = new URL(a.opened[0]).searchParams
    expect(q.get('client_id')).toBe(client)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(s.log.tokens[0]).toMatchObject({ clientId: client, secret: 'GOCSPX-abcdefghijklmnopqrstu' })
    expect(s.log.registrations).toHaveLength(0)
    await a.c.disconnect(cfg.id)
  })
})

describe('API-key apps and open servers', () => {
  test('API key: pasted once, sent as the header, tools listed; a bad key needs setup', async () => {
    const s = await fake({ mode: 'apikey', apiKey: 'rnd_goodkey_1234567890' })
    withPreset({ id: 'fake-keyed', name: 'Keyed', url: s.url, color: '#000000', category: 'Code', auth: 'apikey', description: 'x', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://example.com/keys', hint: 'Settings → API keys' } })
    const a = app()
    const badSt = await a.c.setApiKey('fake-keyed', 'rnd_wrongkey_000000')
    expect(badSt.state).toBe('error')
    expect(badSt.reason).toBe('setup')
    expect(appState(undefined, badSt)).toBe('setup')
    const st = await a.c.setApiKey('fake-keyed', 'rnd_goodkey_1234567890')
    expect(st.state).toBe('connected')
    expect(s.log.mcp.filter((m) => m.status === 200).every((m) => m.auth === 'Bearer rnd_goodkey_1234567890')).toBe(true)
    expect(a.opened).toHaveLength(0)
    await a.c.disconnect(st.id)
  })

  test('open server: one click, no sign-in', async () => {
    const s = await fake({ mode: 'open' })
    withPreset({ id: 'fake-open', name: 'Open Docs', url: s.url, color: '#000000', category: 'Code', auth: 'none', description: 'x' })
    const a = app()
    const st = await a.c.connectPreset('fake-open')
    expect(st.state).toBe('connected')
    expect(a.opened).toHaveLength(0)
    expect(s.log.mcp.every((m) => !m.auth)).toBe(true)
    await a.c.disconnect(st.id)
  })

  test('an app marked unavailable stays in the catalog but says why instead of connecting', async () => {
    withPreset({ id: 'fake-gone', name: 'Gone', url: 'https://gone.example.com/mcp', color: '#000000', category: 'Code', auth: 'oauth', description: 'x', unavailable: 'Its server stopped answering in November 2026.' })
    const a = app()
    await expect(a.c.connectPreset('fake-gone')).rejects.toThrow(/stopped answering/)
    const cfg = a.c.save({ name: 'Gone', kind: 'remote', url: 'https://gone.example.com/mcp', preset: 'fake-gone', enabled: true })
    const st = await a.c.connect(cfg.id, true)
    expect(st).toMatchObject({ state: 'error', reason: 'unavailable' })
    expect(appState(PRESETS.find((p) => p.id === 'fake-gone'), st)).toBe('unavailable')
    expect(APP_STATE_TEXT.unavailable).toBe('Unavailable right now')
    expect(a.opened).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- a connected app's tools, used from a chat

const model = (id: string): ModelInfo => ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id, vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true }) as ModelInfo
let llm: MockLlm
describe('connected app in a chat', () => {
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })

  test('find_tools loads a signed-in app\'s tools; reads run, a refund stops for approval (Stripe effect map)', async () => {
    const s = await fake({
      name: 'stripe',
      tools: [
        { name: 'list_customers', description: 'List Stripe customers', reply: () => 'cus_1 Ada' },
        { name: 'create_refund', description: 'Refund a Stripe payment', reply: (x) => `refunded ${JSON.stringify(x)}` }
      ]
    })
    const db = new Db(':memory:')
    const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
    const registry = new ToolRegistry()
    registry.register(...coreTools(results))
    const a = app(memDb(), memSecrets(), registry)
    const cfg = a.c.save({ name: 'Stripe', kind: 'remote', url: s.url, preset: 'stripe', enabled: true })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')

    const models = [model('model-a')]
    const settings = {
      contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
      workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: 'model-a', hiddenModels: [], shownModels: [],
      cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
    } as unknown as Settings
    const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
    const agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined } as never,
      spaces: { getPrompt: () => '' } as never,
      memory: { block: () => '' } as never,
      emit: () => undefined,
      secretValues: () => [],
      fitWindow: (_m: string, w: number) => w,
      counter: () => ({ count: async (t: string) => estimate(t) })
    } as never)
    const space = db.createSpace('Alpha', '#000000')
    const thread = db.createThread(space.id, 'auto', 'model-a')
    const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
    llm.script.push(
      { toolCalls: [call('find_tools', { query: 'stripe' })] },
      { toolCalls: [call('stripe__list_customers', {})] },
      { toolCalls: [call('stripe__create_refund', { payment: 'pi_1', amount: 500 })] },
      { content: 'Refunded Ada.' }
    )
    const done = (await agent.send({ threadId: thread.id, text: 'Refund Ada\'s last payment' })).done
    // The refund waits for the user; the customer list didn't ask.
    let req: { tool?: string; reason?: string; id: string } | undefined
    for (let i = 0; i < 500 && !req; i++) { req = agent.pending(thread.id)[0] as never; if (!req) await new Promise((r) => setTimeout(r, 10)) }
    expect(req, 'an approval request').toBeTruthy()
    expect(JSON.stringify(req)).toMatch(/refund/i)
    expect(JSON.stringify(req)).toMatch(/Spends money/i)
    expect(s.log.calls.map((c) => c.name)).toEqual(['list_customers'])
    agent.respond(thread.id, req!.id, 'allow')
    await done
    expect(s.log.calls.map((c) => c.name)).toEqual(['list_customers', 'create_refund'])
    const toolMsgs = llm.requests.at(-1)!.messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content))
    expect(toolMsgs.some((t: string) => t.includes('cus_1 Ada') && t.includes('trust="untrusted"'))).toBe(true)
    expect(toolMsgs.at(-1)).toContain('refunded')
    await a.c.disconnect(cfg.id)
  }, 30_000)
})
