import { describe, expect, test } from 'vitest'
import type { ConnectorPreset } from '@shared/types'
import { Connectors, EFFECT_MAPS, Oauth, PRESETS, SETUP_PORT, explainAuthError, iconDomain, isOneClick, redirectFor, setupNeeded, setupRedirect, toolPolicy } from '../../src/main/connectors'
import { CUSTOM_REDIRECT, SECTION_ORDER, connectBadge, isOneClick as isOneClickUi, needsSetup, recommended } from '../../src/renderer/src/lib/connect-catalog'

const AUTHS = ['oauth', 'none', 'oauth-static', 'google', 'browser', 'app']
const remote = PRESETS.filter((p) => p.auth !== 'app' && p.id !== 'custom')
const preset = (id: string): ConnectorPreset => PRESETS.find((p) => p.id === id)!

function memSecrets() {
  const m = new Map<string, string>()
  return { m, get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null) m.delete(k); else m.set(k, v) } }
}

describe('catalog entries', () => {
  test('ids are unique slugs', () => {
    const ids = PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  test('every preset has a name, description, color, known category and auth', () => {
    for (const p of PRESETS) {
      expect(p.name.trim(), p.id).not.toBe('')
      expect(p.description.trim().length, p.id).toBeGreaterThan(5)
      expect(p.color, p.id).toMatch(/^#[0-9a-f]{6}$/i)
      expect(SECTION_ORDER as readonly string[], p.id).toContain(p.category)
      expect(AUTHS, p.id).toContain(p.auth)
    }
  })

  test('remote servers use https and have an icon domain', () => {
    for (const p of remote) {
      expect(p.url, p.id).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i)
      expect(() => new URL(p.url), p.id).not.toThrow()
      expect(iconDomain(p), p.id).toBeTruthy()
    }
  })

  test('no two presets point at the same server', () => {
    const urls = remote.map((p) => p.url.replace(/\/+$/, '').toLowerCase())
    expect(urls.filter((u, i) => urls.indexOf(u) !== i)).toEqual([])
  })

  test('apps without self-registration carry an exact setup guide', () => {
    const statics = PRESETS.filter((p) => p.auth === 'oauth-static')
    expect(statics.map((p) => p.id).sort()).toEqual(expect.arrayContaining(['asana', 'github', 'hubspot', 'slack']))
    for (const p of statics) {
      const g = p.setup!
      expect(g, p.id).toBeTruthy()
      expect(g.steps.length, p.id).toBeGreaterThanOrEqual(2)
      expect(g.minutes, p.id).toBeGreaterThan(0)
      expect([setupRedirect('127.0.0.1'), setupRedirect('localhost')], p.id).toContain(g.redirectUri)
      expect(redirectFor(p.id)).toBe(g.redirectUri)
      for (const s of g.steps) for (const [label, href] of s.links ?? []) {
        expect(label.trim(), p.id).not.toBe('')
        expect(href, p.id).toMatch(/^https:\/\//)
      }
      if (g.docs) expect(g.docs).toMatch(/^https:\/\//)
    }
    // Only oauth-static apps have setup guides.
    expect(PRESETS.filter((p) => p.setup && p.auth !== 'oauth-static')).toEqual([])
  })

  test('the redirect URL is a fixed loopback with a fixed path, shared with the renderer', () => {
    expect(setupRedirect()).toBe(`http://127.0.0.1:${SETUP_PORT}/callback`)
    expect(CUSTOM_REDIRECT).toBe(setupRedirect())
    expect(redirectFor('custom')).toBe(setupRedirect())
  })

  test('kept and updated presets', () => {
    expect(preset('atlassian').url).toBe('https://mcp.atlassian.com/v2/mcp')
    expect(preset('pipedrive').url).toBe('https://mcp.pipedrive.ai/mcp')
    expect(preset('square').url).toBe('https://mcp.squareup.com/mcp')
    for (const id of ['heygen', 'hyperframes', 'cloudflare', 'cloudflare-docs', 'make', 'todoist', 'calendly', 'mixpanel', 'vanta', 'zoom']) expect(preset(id), id).toBeTruthy()
    expect(preset('cloudflare-docs').auth).toBe('none')
    expect(preset('zoom').auth).toBe('oauth-static')
  })
})

describe('one click vs needs setup', () => {
  test('main and renderer agree on what is one click', () => {
    for (const p of PRESETS) expect(isOneClickUi(p), p.id).toBe(isOneClick(p))
  })
  test('badges', () => {
    expect(connectBadge(preset('notion'))).toBe('One click')
    expect(connectBadge(preset('exa'))).toBe('One click')
    expect(connectBadge(preset('slack'))).toBe('Needs setup')
    expect(connectBadge(preset('gmail'))).toBe('Needs setup')
    expect(connectBadge(preset('gmail-web'))).toBeNull()
    expect(connectBadge(preset('custom'))).toBeNull()
    expect(needsSetup(preset('github'))).toBe(true)
  })
  test('Recommended puts one-click apps first', () => {
    const r = recommended(PRESETS, new Set())
    expect(r).toHaveLength(6)
    expect(r.every(isOneClick)).toBe(true)
    // With most one-click picks connected, setup apps fill in after the remaining one-click ones.
    const many = new Set(PRESETS.filter(isOneClick).map((p) => p.id).filter((id) => id !== 'notion'))
    const r2 = recommended(PRESETS, many)
    expect(r2[0].id).toBe('notion')
    expect(r2.slice(1).every((p) => !isOneClick(p))).toBe(true)
  })
})

describe('effect maps', () => {
  test('every map entry is a known preset', () => {
    for (const id of Object.keys(EFFECT_MAPS)) expect(PRESETS.some((p) => p.id === id), id).toBe(true)
  })

  test('sending, posting, merging and paying are hard stops in the apps that do them', () => {
    expect(toolPolicy('slack', 'slack_send_message').hardStop).toMatch(/Slack/)
    expect(toolPolicy('slack', 'slack_search_public')).toEqual({ effect: 'read', consequential: false })
    expect(toolPolicy('github', 'merge_pull_request').hardStop).toBeTruthy()
    expect(toolPolicy('github', 'create_pull_request')).toMatchObject({ effect: 'write_external', consequential: true })
    expect(toolPolicy('stripe', 'create_refund').hardStop).toBeTruthy()
    expect(toolPolicy('stripe', 'list_customers').effect).toBe('read')
    expect(toolPolicy('paypal', 'create_refund').hardStop).toBeTruthy()
    expect(toolPolicy('vercel', 'buy_domain').hardStop).toBeTruthy()
    expect(toolPolicy('zapier', 'gmail_send_email').hardStop).toBeTruthy()
    expect(toolPolicy('docusign', 'send_envelope').hardStop).toBeTruthy()
    expect(toolPolicy('cloudflare', 'execute')).toMatchObject({ effect: 'write_external', consequential: true })
    expect(toolPolicy('cloudflare', 'search').effect).toBe('read')
    expect(toolPolicy('supabase', 'execute_sql').consequential).toBe(true)
    expect(toolPolicy('supabase', 'delete_branch').effect).toBe('destructive')
    expect(toolPolicy('square', 'make_api_request').consequential).toBe(true)
    expect(toolPolicy('hyperframes', 'render_video').consequential).toBe(true)
  })

  test('generic rules: risky verbs ask, deletes are destructive, money is a hard stop, unknown tools write', () => {
    for (const n of ['send_email', 'post_message', 'publish_site', 'share_file', 'invite_user', 'deploy_site', 'sendMessage']) {
      const p = toolPolicy('notion', n)
      expect(p.effect, n).toBe('write_external')
      expect(p.consequential, n).toBe(true)
    }
    for (const n of ['delete_page', 'remove_member', 'trash_file', 'deleteDeal']) expect(toolPolicy('linear', n).effect, n).toBe('destructive')
    for (const n of ['create_payout', 'refund_payment', 'pay_invoice', 'transfer_funds']) expect(toolPolicy(undefined, n).hardStop, n).toBeTruthy()
    for (const n of ['list_payments', 'search_issues', 'get_page', 'notion-search', 'getActivities']) expect(toolPolicy('notion', n).effect, n).toBe('read')
    expect(toolPolicy(undefined, 'frobnicate').effect).toBe('write_external')
    // Annotations still win for reads.
    expect(toolPolicy(undefined, 'frobnicate', { readOnlyHint: true }).effect).toBe('read')
    // Gmail keeps its own map.
    expect(toolPolicy('gmail', 'send_message').hardStop).toBeTruthy()
  })
})

describe('sign-in robustness', () => {
  test('resource indicators are sent verbatim, dropped after invalid_target, and never to another site', async () => {
    const s = memSecrets()
    const a = new Oauth('x', s as never, {})
    expect(await a.validateResourceURL('https://mcp.slack.com/mcp', 'https://mcp.slack.com')).toBe('https://mcp.slack.com')
    expect(await a.validateResourceURL('https://mcp.slack.com/mcp', undefined)).toBeUndefined()
    await expect(a.validateResourceURL('https://mcp.slack.com/mcp', 'https://evil.example/mcp')).rejects.toThrow(/another site/)
    a.dropResource()
    expect(await a.validateResourceURL('https://mcp.slack.com/mcp', 'https://mcp.slack.com')).toBeUndefined()
    // Remembered for the next sign-in; cleared with the rest of the credentials.
    expect(new Oauth('x', s as never, {}).noResource).toBe(true)
    new Oauth('x', s as never, {}).invalidateCredentials('all')
    expect(new Oauth('x', s as never, {}).noResource).toBe(false)
  })

  test('a pre-registered client uses the exact fixed redirect and is never overwritten', async () => {
    const s = memSecrets()
    const a = new Oauth('gh', s as never, { staticClient: { client_id: 'abc', client_secret: 'shh' }, fixedRedirect: setupRedirect(), interactive: false })
    await a.listen()
    expect(a.redirectUrl).toBe(setupRedirect())
    expect(a.clientMetadata.redirect_uris).toEqual([setupRedirect()])
    a.saveClientInformation({ client_id: 'abc', issuer: 'https://github.com/login/oauth' })
    expect(a.clientInformation()).toEqual({ client_id: 'abc', client_secret: 'shh' })
    expect(s.m.has('mcp:gh:client')).toBe(false)
    a.close()
  })

  test('the loopback listener only takes the /callback path and catches early callbacks', async () => {
    const a = new Oauth('cb', memSecrets() as never, {})
    await a.listen()
    const base = a.redirectUrl.replace(/\/callback$/, '')
    try {
      expect((await fetch(`${base}/favicon.ico?code=nope`)).status).toBe(404)
      expect((await fetch(`${base}/callback`)).status).toBe(404)
      const page = await fetch(`${base}/callback?code=good&state=${a.state()}`)
      expect(page.status).toBe(200)
      expect(await page.text()).toMatch(/Signed in/)
      await expect(a.waitForCode(2000)).resolves.toBe('good')
      await fetch(`${base}/callback?error=access_denied&error_description=${encodeURIComponent('User said no')}&state=${a.state()}`)
      await expect(a.waitForCode(2000)).rejects.toThrow(/access_denied \(User said no\)/)
    } finally {
      a.close()
    }
  })

  test('clear errors when a provider rejects self-registration', () => {
    const dcr = 'Incompatible auth server: does not support dynamic client registration'
    expect(explainAuthError(dcr, { name: 'Slack', url: 'https://mcp.slack.com/mcp', hasSetup: true })).toMatch(/^Slack needs a one-time setup: open Connect apps → Slack/)
    const custom = explainAuthError(dcr, { name: 'Acme', url: 'https://mcp.acme.dev/mcp' })
    expect(custom).toMatch(/^This app needs a one-time setup: mcp\.acme\.dev/)
    expect(custom).toContain(setupRedirect())
    expect(explainAuthError('Sign-in failed: invalid_request (redirect_uri mismatch)', { name: 'GitHub', staticClient: true, redirect: setupRedirect() })).toContain(setupRedirect())
    expect(explainAuthError('Incompatible auth server: does not support code challenge method S256', { name: 'Old' })).toMatch(/PKCE/)
    expect(explainAuthError('fetch failed', { name: 'X' })).toBe('fetch failed')
    expect(setupNeeded(preset('slack'))).toMatch(/one-time setup/)
  })

  test('setup apps refuse to save or connect without a client ID; changing the client signs in again', async () => {
    const store = new Map<string, unknown>()
    const db = { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
    const s = memSecrets()
    const { ToolRegistry } = await import('../../src/main/agent/registry')
    const c = new Connectors(db as never, s as never, new ToolRegistry(), () => undefined)
    expect(() => c.save({ name: 'Slack', kind: 'remote', url: preset('slack').url, preset: 'slack', enabled: true })).toThrow(/one-time setup/)
    await expect(c.connectPreset('slack')).rejects.toThrow(/one-time setup/)
    expect(() => c.save({ name: 'Slack', kind: 'remote', url: preset('slack').url, preset: 'slack', enabled: true, clientId: 'has space' })).toThrow(/client ID/)
    const saved = c.save({ name: 'Slack', kind: 'remote', url: preset('slack').url, preset: 'slack', enabled: true, clientId: ' 123.456 ' })
    expect(saved.clientId).toBe('123.456')
    s.set(`mcp:${saved.id}:tokens`, '{"access_token":"t"}')
    s.set(`mcp:${saved.id}:clientSecret`, 'old')
    c.save({ ...saved, clientId: '999.000' })
    expect(s.get(`mcp:${saved.id}:tokens`)).toBeUndefined()
    expect(s.get(`mcp:${saved.id}:clientSecret`)).toBeUndefined()
  })

  test('in-chat suggestions offer one-click apps before setup apps', () => {
    const c = new Connectors({ getSetting: () => undefined, setSetting: () => undefined } as never, memSecrets() as never, { register: () => undefined, unregister: () => undefined } as never, () => undefined)
    const r = c.suggest('slack linear')
    expect(r.map((p) => p.id).slice(0, 2)).toEqual(['linear', 'slack'])
  })
})
