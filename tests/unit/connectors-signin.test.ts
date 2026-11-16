import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'
import type { ConnectorPreset } from '@shared/types'

// Sign-in always happens in the user's default browser (never inside SahilBot's windows), for every
// OAuth path: dynamic registration, the user's own client, Google, SahilBot's built-in clients, and
// Reconnect. The "browser" here is a capture of what would have been opened, signed in headlessly
// against a local fake authorization server (tests/fixtures/fake-oauth-mcp.ts).

const shellOpen = vi.hoisted(() => vi.fn(async (_url: string) => undefined))
vi.mock('electron', () => ({ shell: { openExternal: shellOpen } }))

import { Connectors, Oauth, PRESETS, callbackPage, capturedSignIns, headlessSignIn, isOneClick, openSignIn, setupRedirect } from '../../src/main/connectors'
import { builtinFor, parseBuiltinClients, readBuiltinClients, validLoopbackRedirect, type BuiltinClients } from '../../src/main/oauth-clients'
import { ToolRegistry } from '../../src/main/agent/registry'
import { SETUP_GROUP, connectBadge, ease, isOneClick as isOneClickUi, needsOneTimeSetup, needsSetup, recommended, searchApps, splitSection } from '../../src/renderer/src/lib/connect-catalog'
import { startFakeServer, type FakeServer } from '../fixtures/fake-oauth-mcp'

function memSecrets() {
  const m = new Map<string, string>()
  return { m, get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null || v === '') m.delete(k); else m.set(k, v) } }
}
function memDb() {
  const store = new Map<string, unknown>()
  return { store, getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
}

/** Connectors whose "default browser" is a capture: every URL it was asked to open, and the page it landed on. */
function app(o: { oauthClients?: BuiltinClients } = {}) {
  const opened: string[] = []
  const pages: string[] = []
  const focused: string[] = []
  const db = memDb()
  const secrets = memSecrets()
  const registry = new ToolRegistry()
  const c = new Connectors(db as never, secrets as never, registry, () => undefined, {
    openExternal: async (url) => { opened.push(url); pages.push(await headlessSignIn(url)) },
    oauthClients: o.oauthClients,
    onSignedIn: (name) => focused.push(name)
  })
  return { c, db, secrets, registry, opened, pages, focused }
}

const servers: FakeServer[] = []
const fake = async (...a: Parameters<typeof startFakeServer>): Promise<FakeServer> => { const s = await startFakeServer(...a); servers.push(s); return s }
const extra: ConnectorPreset[] = []
const withPreset = (p: ConnectorPreset): ConnectorPreset => { PRESETS.push(p); extra.push(p); return p }
afterEach(() => { for (const p of extra.splice(0)) PRESETS.splice(PRESETS.indexOf(p), 1) })
afterAll(async () => { await Promise.all(servers.map((s) => s.close())) })

/** The URL the browser was sent to is the provider's own authorization endpoint, with PKCE and state. */
function expectAuthorizePage(url: string, s: FakeServer): URLSearchParams {
  const u = new URL(url)
  expect(u.origin).toBe(s.origin)
  expect(u.pathname).toBe('/authorize')
  expect(u.searchParams.get('response_type')).toBe('code')
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(u.searchParams.get('state')).toBeTruthy()
  return u.searchParams
}

const staticPreset = (id: string, url: string, redirect = setupRedirect('127.0.0.1')): ConnectorPreset => ({
  id, name: 'Chatter', url, color: '#000000', category: 'Communication', auth: 'oauth-static', description: 'Team chat.',
  setup: { minutes: 4, needsSecret: false, redirectUri: redirect, steps: [{ title: 'Create an app', text: 'x', links: [] }] }
})
const googlePreset = (id: string, url: string): ConnectorPreset => ({ id, name: 'Mail Test', url, color: '#000000', category: 'Communication', auth: 'google', description: 'Email.' })

describe('the sign-in page opens in the user\'s default browser', () => {
  test('openSignIn uses shell.openExternal (the default browser), never a SahilBot window', async () => {
    shellOpen.mockClear()
    await openSignIn('https://slack.com/oauth/v2_user/authorize?client_id=x', {})
    expect(shellOpen).toHaveBeenCalledWith('https://slack.com/oauth/v2_user/authorize?client_id=x')
  })

  test('a hidden test run captures the URL instead of opening the real browser', async () => {
    shellOpen.mockClear()
    const dir = mkdtempSync(join(tmpdir(), 'sb-signin-'))
    const log = join(dir, 'opened.jsonl')
    const before = capturedSignIns.length
    await openSignIn('https://accounts.google.com/o/oauth2/v2/auth?client_id=x', { SAHILBOT_HIDDEN: '1', SAHILBOT_TEST_EXTERNAL_LOG: log })
    // Even with the headless test hook on, a real provider's page is only captured (never fetched).
    await openSignIn('https://github.com/login/oauth/authorize?client_id=y', { SAHILBOT_HIDDEN: '1', SAHILBOT_TEST_OAUTH_FETCH: '1' })
    expect(shellOpen).not.toHaveBeenCalled()
    expect(capturedSignIns.slice(before).map((r) => r.url)).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client_id=x', 'https://github.com/login/oauth/authorize?client_id=y'])
    expect(capturedSignIns.at(-1)!.page).toBeUndefined()
    const { readFileSync } = await import('node:fs')
    expect(JSON.parse(readFileSync(log, 'utf8').trim()).url).toContain('accounts.google.com')
  })

  test('dynamic registration (one click): the authorize page of the server\'s own authorization server', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Notes Cloud', kind: 'remote', url: s.url, enabled: true })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    expect(a.opened).toHaveLength(1)
    const q = expectAuthorizePage(a.opened[0], s)
    expect(q.get('client_id')).toMatch(/^dcr_/)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    // The tab lands on SahilBot's page, and SahilBot comes to the front.
    expect(a.pages[0]).toContain('Connected to Notes Cloud')
    expect(a.pages[0]).toContain('You can close this tab and go back to SahilBot')
    expect(a.focused).toEqual(['Notes Cloud'])
    await a.c.disconnect(cfg.id)
  })

  test('the user\'s own client (one-time setup): the provider\'s authorize page on the fixed redirect', async () => {
    const redirect = setupRedirect('127.0.0.1')
    const s = await fake({ dcr: false, staticClients: { 'own-client': '' }, staticRedirects: [redirect] })
    withPreset(staticPreset('fake-chat-own', s.url, redirect))
    const a = app()
    const cfg = a.c.save({ name: 'Chatter', kind: 'remote', url: s.url, preset: 'fake-chat-own', enabled: true, clientId: 'own-client' })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    const q = expectAuthorizePage(a.opened[0], s)
    expect(q.get('client_id')).toBe('own-client')
    expect(q.get('redirect_uri')).toBe(redirect)
    await a.c.disconnect(cfg.id)
  })

  test('Google (the user\'s own client): the authorize page, any loopback port', async () => {
    const client = '1234567890-abcdefghijk.apps.googleusercontent.com'
    const s = await fake({ dcr: false, staticClients: { [client]: 'GOCSPX-abcdefghijklmnopqrstu' } })
    withPreset(googlePreset('fake-gmail-own', s.url))
    const a = app()
    a.c.setGoogleClient(client, 'GOCSPX-abcdefghijklmnopqrstu')
    const st = await a.c.connectPreset('fake-gmail-own')
    expect(st.state).toBe('connected')
    const q = expectAuthorizePage(a.opened[0], s)
    expect(q.get('client_id')).toBe(client)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    await a.c.disconnect(st.id)
  })

  test('Reconnect after a revoked sign-in opens the authorize page again (and only then)', async () => {
    const s = await fake()
    const a = app()
    const cfg = a.c.save({ name: 'Tasks', kind: 'remote', url: s.url, enabled: true })
    await a.c.connect(cfg.id, true)
    s.revokeAll()
    expect((await a.c.test(cfg.id)).state).toBe('needs_auth')
    // The health check never pops a browser up by itself.
    expect(a.opened).toHaveLength(1)
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    expect(a.opened).toHaveLength(2)
    expectAuthorizePage(a.opened[1], s)
    await a.c.disconnect(cfg.id)
  })

  test('a code without this sign-in\'s state is refused (CSRF); the page says what to do', async () => {
    const o = new Oauth('st', memSecrets() as never, { appName: 'Acme' })
    await o.listen()
    const base = o.redirectUrl.replace(/\/callback$/, '')
    try {
      const noState = await fetch(`${base}/callback?code=stolen`)
      expect(noState.status).toBe(400)
      expect(await noState.text()).toContain('out of date')
      await expect(o.waitForCode(2000)).rejects.toThrow(/state mismatch/)
      const wrong = await fetch(`${base}/callback?code=stolen&state=nope`)
      expect(wrong.status).toBe(400)
      await expect(o.waitForCode(2000)).rejects.toThrow(/state mismatch/)
    } finally {
      o.close()
    }
  })

  test('the callback pages: "Connected to <App>" and a clear error with what to do', () => {
    const ok = callbackPage(true, { app: 'Slack' })
    expect(ok).toContain('<h1>Connected to Slack</h1>')
    expect(ok).toContain('You can close this tab and go back to SahilBot.')
    expect(ok).toContain('prefers-color-scheme:dark')
    expect(ok).toContain("default-src 'none'")
    const bad = callbackPage(false, { app: 'Slack', detail: '<script>x</script> denied', hint: 'Go back to SahilBot and press Connect to try again.' })
    expect(bad).toContain('Couldn’t connect Slack')
    expect(bad).toContain('press Connect to try again')
    expect(bad).not.toContain('<script>x')
    expect(bad).toContain('&lt;script&gt;')
  })
})

describe('SahilBot\'s built-in OAuth clients (one click, no paste)', () => {
  test('the config: known apps only, loopback redirects with /callback, defaults, comments', () => {
    const presets = [staticPreset('chat', 'https://x.example/mcp', 'http://localhost:47613/callback'), googlePreset('gm', 'https://y.example/mcp'), { id: 'notion', auth: 'oauth' as const }]
    const { clients, problems } = parseBuiltinClients({
      $comment: 'ignored',
      chat: { clientId: 'abc.123', scopes: ['search:read', 'chat:write'] },
      google: { clientId: '1-x.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc' },
      notion: { clientId: 'n' },
      nope: { clientId: 'zzzz' },
      gm: { clientId: 'gm-own', redirect: 'https://evil.example/callback' }
    }, presets)
    expect(clients.chat).toEqual({ clientId: 'abc.123', redirect: 'http://localhost:47613/callback', scopes: 'search:read chat:write' })
    expect(clients.google).toEqual({ clientId: '1-x.apps.googleusercontent.com', clientSecret: 'GOCSPX-abc', redirect: 'loopback' })
    expect(clients.notion).toBeUndefined()
    expect(clients.nope).toBeUndefined()
    expect(clients.gm).toBeUndefined()
    expect(problems.join('\n')).toMatch(/notion: not a catalog app/)
    expect(problems.join('\n')).toMatch(/gm: redirect must be/)
    expect(builtinFor(clients, presets[1])?.clientId).toBe('1-x.apps.googleusercontent.com')
    expect(validLoopbackRedirect('http://127.0.0.1:47613/callback')).toBe(true)
    expect(validLoopbackRedirect('http://127.0.0.1/callback')).toBe(false)
    expect(validLoopbackRedirect('http://127.0.0.1:47613/oauth')).toBe(false)
    expect(validLoopbackRedirect('https://localhost:47613/callback')).toBe(false)
  })

  test('the env var only where allowed (development, hidden tests); else the shipped file; nothing = none', () => {
    const presets = [staticPreset('chat', 'https://x.example/mcp')]
    const env = { SAHILBOT_OAUTH_CLIENTS_JSON: JSON.stringify({ chat: { clientId: 'from-env' } }) }
    const dir = mkdtempSync(join(tmpdir(), 'sb-clients-'))
    const file = join(dir, 'oauth-clients.json')
    writeFileSync(file, JSON.stringify({ chat: { clientId: 'from-file' } }))
    expect(readBuiltinClients({ presets, env, allowEnv: true, files: [file] }).clients.chat.clientId).toBe('from-env')
    expect(readBuiltinClients({ presets, env, allowEnv: false, files: [file] }).clients.chat.clientId).toBe('from-file')
    expect(readBuiltinClients({ presets, env: {}, files: [join(dir, 'missing.json')] }).clients).toEqual({})
    writeFileSync(file, '{}\n')
    expect(readBuiltinClients({ presets, env: {}, files: [file] }).clients).toEqual({})
    writeFileSync(file, '{oops')
    expect(readBuiltinClients({ presets, env: {}, files: [file] }).problems[0]).toMatch(/not valid JSON/)
  })

  test('a static app with a built-in client: one click from the catalog, the provider\'s page, no registration', async () => {
    const redirect = setupRedirect('127.0.0.1')
    const s = await fake({ dcr: false, staticClients: { 'sahilbot-chat': '' }, staticRedirects: [redirect] })
    const p = withPreset(staticPreset('fake-chat', s.url, redirect))
    const a = app({ oauthClients: { 'fake-chat': { clientId: 'sahilbot-chat', redirect, scopes: 'read write' } } })
    // The catalog main hands out marks it one click (the client itself stays in main).
    const shown = a.c.presets().find((x) => x.id === 'fake-chat')!
    expect(shown.builtinClient).toBe(true)
    expect(JSON.stringify(shown)).not.toContain('sahilbot-chat')
    expect(isOneClick(shown)).toBe(true)
    expect(isOneClickUi(shown)).toBe(true)
    expect(connectBadge(shown)).toBe('One click')
    expect(needsSetup(shown)).toBe(false)
    expect(isOneClick(p)).toBe(false)
    // Connect opens the provider's page directly: nothing pasted, nothing registered.
    const st = await a.c.connectPreset('fake-chat')
    expect(st.state).toBe('connected')
    expect(s.log.registrations).toHaveLength(0)
    const q = expectAuthorizePage(a.opened[0], s)
    expect(q.get('client_id')).toBe('sahilbot-chat')
    expect(q.get('redirect_uri')).toBe(redirect)
    expect(q.get('scope')).toBe('read write')
    expect(a.pages[0]).toContain('Connected to Chatter')
    expect(a.registry.get('chatter__list_items')).toBeTruthy()
    await a.c.disconnect(st.id)
  })

  test('a built-in client secret (an "installed app" secret) goes to the token endpoint with PKCE', async () => {
    const redirect = setupRedirect('127.0.0.1')
    const s = await fake({ dcr: false, staticClients: { 'sb-gh': 'installed-app-secret' }, staticRedirects: [redirect] })
    withPreset(staticPreset('fake-code', s.url, redirect))
    const a = app({ oauthClients: { 'fake-code': { clientId: 'sb-gh', clientSecret: 'installed-app-secret', redirect } } })
    expect((await a.c.connectPreset('fake-code')).state).toBe('connected')
    expect(s.log.tokens[0]).toMatchObject({ grant: 'authorization_code', clientId: 'sb-gh', secret: 'installed-app-secret' })
    expect(new URL(a.opened[0]).searchParams.get('code_challenge_method')).toBe('S256')
  })

  test('Google apps with a built-in Google client skip "Set up Google once": one click, any loopback port', async () => {
    const client = '9876543210-sahilbotbuiltin.apps.googleusercontent.com'
    const s = await fake({ dcr: false, staticClients: { [client]: 'GOCSPX-builtinbuiltin1234' } })
    withPreset(googlePreset('fake-gmail', s.url))
    const a = app({ oauthClients: { google: { clientId: client, clientSecret: 'GOCSPX-builtinbuiltin1234', redirect: 'loopback' } } })
    expect(a.c.googleClient()).toBeNull()
    expect(a.c.presets().find((x) => x.id === 'fake-gmail')!.builtinClient).toBe(true)
    const st = await a.c.connectPreset('fake-gmail')
    expect(st.state).toBe('connected')
    const q = expectAuthorizePage(a.opened[0], s)
    expect(q.get('client_id')).toBe(client)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(s.log.tokens[0]).toMatchObject({ clientId: client, secret: 'GOCSPX-builtinbuiltin1234' })
    await a.c.disconnect(st.id)
  })

  test('the user\'s own app still wins over the built-in one; switching either way signs in again', async () => {
    const redirect = setupRedirect('127.0.0.1')
    const s = await fake({ dcr: false, staticClients: { 'sb-builtin': '', 'my-own-app': '' }, staticRedirects: [redirect] })
    withPreset(staticPreset('fake-team', s.url, redirect))
    const a = app({ oauthClients: { 'fake-team': { clientId: 'sb-builtin', redirect } } })
    const first = await a.c.connectPreset('fake-team')
    expect(new URL(a.opened[0]).searchParams.get('client_id')).toBe('sb-builtin')
    // "Use your own app": the user's client ID replaces the built-in one, and it signs in again with it.
    const cfg = a.c.list().find((x) => x.id === first.id)!
    a.c.save({ ...cfg, clientId: 'my-own-app' })
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    expect(a.opened).toHaveLength(2)
    expect(new URL(a.opened[1]).searchParams.get('client_id')).toBe('my-own-app')
    // A reconnect with the same client reuses its tokens: no browser.
    expect((await a.c.connect(cfg.id, false)).state).toBe('connected')
    expect(a.opened).toHaveLength(2)
    // "Use SahilBot's app": back to the built-in client, which signs in again (the old tokens were the user's app's).
    a.c.useBuiltinClient(cfg.id)
    expect(a.c.list().find((x) => x.id === cfg.id)!.clientId).toBeUndefined()
    expect((await a.c.connect(cfg.id, true)).state).toBe('connected')
    expect(a.opened).toHaveLength(3)
    expect(new URL(a.opened[2]).searchParams.get('client_id')).toBe('sb-builtin')
    await a.c.disconnect(cfg.id)
  })

  test('Google: the user\'s own Google client overrides the built-in one; clearing it goes back', async () => {
    const builtin = '1111111111-builtinclient.apps.googleusercontent.com'
    const own = '2222222222-userownclient.apps.googleusercontent.com'
    const s = await fake({ dcr: false, staticClients: { [builtin]: 'GOCSPX-builtinbuiltin1234', [own]: 'GOCSPX-ownownownown123456' } })
    withPreset(googlePreset('fake-cal', s.url))
    const a = app({ oauthClients: { google: { clientId: builtin, clientSecret: 'GOCSPX-builtinbuiltin1234', redirect: 'loopback' } } })
    a.c.setGoogleClient(own, 'GOCSPX-ownownownown123456')
    const st = await a.c.connectPreset('fake-cal')
    expect(new URL(a.opened[0]).searchParams.get('client_id')).toBe(own)
    a.c.clearGoogleClient()
    expect((await a.c.connect(st.id, true)).state).toBe('connected')
    expect(new URL(a.opened[1]).searchParams.get('client_id')).toBe(builtin)
    await a.c.disconnect(st.id)
  })

  test('a built-in client is never sent to a server address the user edited', async () => {
    const s = await fake({ dcr: false, staticClients: { 'sb-builtin': '' } })
    withPreset(staticPreset('fake-pinned', 'https://real.example.com/mcp'))
    const a = app({ oauthClients: { 'fake-pinned': { clientId: 'sb-builtin', redirect: setupRedirect('127.0.0.1') } } })
    const cfg = a.c.save({ name: 'Chatter', kind: 'remote', url: s.url, preset: 'fake-pinned', enabled: true })
    const st = await a.c.connect(cfg.id, true)
    expect(st.state).toBe('error')
    expect(st.error).toMatch(/one-time setup/)
    expect(a.opened).toHaveLength(0)
  })

  test('without a built-in client the app still needs its one-time setup', async () => {
    withPreset(staticPreset('fake-nosetup', 'https://real.example.com/mcp'))
    const a = app()
    expect(a.c.presets().find((x) => x.id === 'fake-nosetup')!.builtinClient).toBeUndefined()
    await expect(a.c.connectPreset('fake-nosetup')).rejects.toThrow(/one-time setup/)
  })

  test('in-chat suggestions carry the built-in flag, and apps that connect now come first', () => {
    withPreset({ ...staticPreset('fake-zz-ready', 'https://a.example.com/mcp'), name: 'Zorblat Ready' })
    withPreset({ ...staticPreset('fake-zz-setup', 'https://b.example.com/mcp'), name: 'Zorblat Setup' })
    const a = app({ oauthClients: { 'fake-zz-ready': { clientId: 'zz', redirect: setupRedirect('127.0.0.1') } } })
    const got = a.c.suggest('zorblat')
    expect(got.map((p) => p.id).slice(0, 2)).toEqual(['fake-zz-ready', 'fake-zz-setup'])
    expect(got[0].builtinClient).toBe(true)
    expect(got[1].builtinClient).toBeUndefined()
  })
})

describe('one click with "Use an API key instead" (a vendor that documents both)', () => {
  test('one click by default; a pasted key is used instead of OAuth; forgetting it signs in with OAuth again', async () => {
    const s = await fake()
    withPreset({ id: 'fake-both', name: 'Mailer', url: s.url, color: '#000000', category: 'Sales & marketing', auth: 'oauth', description: 'x', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://example.com/keys', hint: 'Settings → API keys' } })
    const a = app()
    const p = a.c.presets().find((x) => x.id === 'fake-both')!
    expect(isOneClick(p)).toBe(true)
    expect(connectBadge(p)).toBe('One click')
    expect(needsOneTimeSetup(p)).toBe(false)
    const st = await a.c.connectPreset('fake-both')
    expect(st.state).toBe('connected')
    expect(a.opened).toHaveLength(1)
    expectAuthorizePage(a.opened[0], s)
    await a.c.disconnect(st.id)
    // A key the server refuses isn't kept: the app stays on one-click OAuth.
    const refused = await a.c.setApiKey('fake-both', 'live_wrongkey_000000000')
    expect(refused.error ?? '').toMatch(/didn't accept the API key/)
    expect(a.c.keyIds()).not.toContain(st.id)
    a.c.clearApiKey(st.id)
    expect(a.c.keyIds()).not.toContain(st.id)
    expect((await a.c.connect(st.id, true)).state).toBe('connected')
  })

  test('the key path: a saved key replaces OAuth for that app (no browser)', async () => {
    const keyed = await fake({ mode: 'apikey', apiKey: 'live_goodkey_1234567890' })
    withPreset({ id: 'fake-both-key', name: 'Mailer Key', url: keyed.url, color: '#000000', category: 'Sales & marketing', auth: 'oauth', description: 'x', apiKey: { in: 'header', name: 'Authorization', format: 'Bearer {key}', getKeyUrl: 'https://example.com/keys', hint: 'Settings → API keys' } })
    const a = app()
    const st = await a.c.setApiKey('fake-both-key', 'live_goodkey_1234567890')
    expect(st.state).toBe('connected')
    expect(a.opened).toHaveLength(0)
    expect(keyed.log.mcp.filter((m) => m.status === 200).every((m) => m.auth === 'Bearer live_goodkey_1234567890')).toBe(true)
    await a.c.disconnect(st.id)
  })
})

describe('catalog grouping (Connect apps)', () => {
  const real = (id: string): ConnectorPreset => PRESETS.find((p) => p.id === id)!

  test('top of each section: only apps that truly connect in one click; setup apps in their own group at the end', () => {
    const items = [real('slack'), real('notion'), real('render'), { ...real('github'), builtinClient: true }, real('gmail-web'), real('exa')]
    const { ready, setup } = splitSection(items)
    expect(ready.map((p) => p.id)).toEqual(['notion', 'github', 'exa', 'gmail-web'])
    expect(setup.map((p) => p.id)).toEqual(['render', 'slack'])
    expect(setup.every(needsOneTimeSetup)).toBe(true)
    expect(SETUP_GROUP).toBe('Needs a one-time setup')
  })

  test('Recommended shows one-click apps only; a built-in client makes Slack one of them', () => {
    const base = recommended(PRESETS, new Set(), 50)
    expect(base.length).toBeGreaterThan(5)
    expect(base.every(isOneClickUi)).toBe(true)
    expect(base.some((p) => p.id === 'slack')).toBe(false)
    const withSlack = recommended(PRESETS.map((p) => (p.id === 'slack' ? { ...p, builtinClient: true } : p)), new Set(), 50)
    expect(withSlack.some((p) => p.id === 'slack')).toBe(true)
  })

  test('sign-in inside SahilBot\'s browser: labelled, next to the real app, sorted below its one-click connector', () => {
    const web = real('gmail-web')
    expect(web.name).toBe('Gmail (in SahilBot\'s browser)')
    expect(web.description).toMatch(/^Sign in inside SahilBot's browser/)
    expect(connectBadge(web)).toBe('SahilBot\'s browser')
    expect(web.category).toBe(real('gmail').category)
    const gmailOneClick = { ...real('gmail'), builtinClient: true }
    expect(ease(gmailOneClick)).toBeLessThan(ease(web))
    expect(searchApps('gmail', [web, gmailOneClick]).map((p) => p.id)).toEqual(['gmail', 'gmail-web'])
    for (const p of PRESETS.filter((x) => x.auth === 'browser')) expect(p.description, p.id).toMatch(/SahilBot's browser/)
  })
})
