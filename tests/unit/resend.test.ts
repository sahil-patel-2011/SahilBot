import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { RESEND_ORIGIN, explainResendError, resendRequest, resendSendBody, verifyResendKey, type Fetch } from '../../src/main/mail/resend'
import { resendTool } from '../../src/main/agent/tools/resend'
import { Connectors, PRESETS, isNativeKeyApp, keyFromClipboard, validateApiKey } from '../../src/main/connectors'
import { ToolRegistry } from '../../src/main/agent/registry'
import { connectBadge, keyProblem, needsKey } from '../../src/renderer/src/lib/connect-catalog'
import type { ToolContext } from '../../src/main/agent/types'

// Resend with a mocked fetch: request shapes, the key pinned to api.resend.com, errors in plain words,
// and the Connect apps tile (paste key from the clipboard, verify with GET /domains). No real request.

const KEY = 're_test_0123456789abcdefABCDEF'

/** A fetch that records requests and answers from a table: path → [status, body]. */
function fakeFetch(answers: Record<string, [number, unknown]>) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: unknown }> = []
  const f: Fetch = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    const u = new URL(url)
    const hit = answers[`${init.method} ${u.pathname}`] ?? [404, { name: 'not_found', message: 'nope', statusCode: 404 }]
    return { status: hit[0], text: async () => JSON.stringify(hit[1]) }
  }
  return { f, seen }
}

const ctx = (ws: string): ToolContext => ({ threadId: 't', signal: new AbortController().signal, workspaceDir: ws, docsDir: ws, state: { loaded: [], alwaysAllow: [], todos: [] }, askUser: async () => '', loadTools: () => [], searchTools: () => [], readResult: () => undefined, idempotencyKey: 'idem-1' }) as ToolContext

describe('Resend API', () => {
  test('requests: Bearer key, User-Agent, JSON, idempotency key; only api.resend.com', async () => {
    const { f, seen } = fakeFetch({ 'POST /emails': [200, { id: 'em_1' }] })
    expect(await resendRequest(f, KEY, 'POST', '/emails', { a: 1 }, { idempotencyKey: 'k1' })).toEqual({ id: 'em_1' })
    expect(seen[0]).toMatchObject({ url: `${RESEND_ORIGIN}/emails`, method: 'POST', body: { a: 1 } })
    expect(seen[0].headers).toMatchObject({ Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'k1' })
    expect(seen[0].headers['User-Agent']).toMatch(/SahilBot/)
    await expect(resendRequest(f, KEY, 'GET', 'https://evil.example/emails')).rejects.toThrow(/api\.resend\.com/)
    await expect(resendRequest(f, KEY, 'GET', '//evil.example/x')).rejects.toThrow(/api\.resend\.com/)
    expect(seen).toHaveLength(1)
  })
  test('the send body uses Resend\'s field names and checks what it can', () => {
    const read = () => ({ filename: 'a.pdf', content: Buffer.from('PDF') })
    const b = resendSendBody({ action: 'send', from: 'Sahil <hi@acme.dev>', to: ['amy@example.com'], cc: 'bob@example.com', bcc: ['c@example.com'], reply_to: ['help@acme.dev'], subject: ' Hi ', text: 'hello', html: '<p>hello</p>', attachments: [{ path: 'a.pdf' }] }, read)
    expect(b).toEqual({ from: 'Sahil <hi@acme.dev>', to: ['amy@example.com'], cc: ['bob@example.com'], bcc: ['c@example.com'], reply_to: 'help@acme.dev', subject: 'Hi', text: 'hello', html: '<p>hello</p>', attachments: [{ filename: 'a.pdf', content: Buffer.from('PDF').toString('base64') }] })
    expect(() => resendSendBody({ action: 'send', to: ['a@x.com'], subject: 's', text: 't' }, read)).toThrow(/from/)
    expect(() => resendSendBody({ action: 'send', from: 'a@x.com', to: [], subject: 's', text: 't' }, read)).toThrow(/to/)
    expect(() => resendSendBody({ action: 'send', from: 'a@x.com', to: ['b@x.com'], subject: 's' }, read)).toThrow(/text/)
    expect(() => resendSendBody({ action: 'send', from: 'a@x.com', to: ['not an address'], subject: 's', text: 't' }, read)).toThrow(/isn't an email/)
    expect(() => resendSendBody({ action: 'send', from: 'a@x.com', to: Array.from({ length: 51 }, (_, i) => `p${i}@x.com`), subject: 's', text: 't' }, read)).toThrow(/50/)
    expect(() => resendSendBody({ action: 'send', from: 'a@x.com', to: ['b@x.com'], subject: 's', text: 't', attachments: [{ path: 'x' }] }, () => ({ filename: 'x', content: Buffer.alloc(16 * 1024 * 1024) }))).toThrow(/MB/)
  })
  test('errors in plain words', () => {
    expect(explainResendError(403, JSON.stringify({ statusCode: 403, name: 'validation_error', message: 'The acme.dev domain is not verified. Please, add and verify your domain on https://resend.com/domains' })).message).toMatch(/isn't verified/)
    expect(explainResendError(403, JSON.stringify({ name: 'validation_error', message: 'You can only send testing emails to your own email address (me@x.com).' })).message).toMatch(/test mode/)
    expect(explainResendError(401, JSON.stringify({ name: 'validation_error', message: 'API key is invalid' })).message).toMatch(/didn't accept the API key.*resend\.com\/api-keys/)
    expect(explainResendError(401, JSON.stringify({ name: 'missing_api_key', message: 'Missing API key' })).message).toMatch(/didn't accept/)
    expect(explainResendError(429, JSON.stringify({ name: 'rate_limit_exceeded', message: 'Too many requests' })).message).toMatch(/rate limit/)
    expect(explainResendError(429, JSON.stringify({ name: 'daily_quota_exceeded', message: 'x' })).message).toMatch(/daily/)
    expect(explainResendError(401, JSON.stringify({ name: 'restricted_api_key', message: 'This API key is restricted to only send emails' })).message).toMatch(/only send email/)
    expect(explainResendError(422, JSON.stringify({ name: 'missing_required_field', message: 'Missing `to` field.' })).message).toMatch(/Missing `to` field/)
    expect(explainResendError(503, 'Service Unavailable').message).toMatch(/trouble/)
  })
  test('key check: one GET /domains; a send-only key is fine; a bad key is refused', async () => {
    expect(await verifyResendKey(fakeFetch({ 'GET /domains': [200, { object: 'list', data: [{ id: 'd1', name: 'acme.dev', status: 'verified' }] }] }).f, KEY)).toMatchObject({ ok: true })
    expect(await verifyResendKey(fakeFetch({ 'GET /domains': [401, { name: 'restricted_api_key', message: 'restricted' }] }).f, KEY)).toEqual({ ok: true, domains: null })
    expect(await verifyResendKey(fakeFetch({ 'GET /domains': [403, { name: 'validation_error', message: 'API key is invalid' }] }).f, KEY)).toMatchObject({ ok: false, error: expect.stringMatching(/didn't accept/) })
  })
})

describe('the resend tool', () => {
  const ws = mkdtempSync(join(tmpdir(), 'resend-ws-'))
  writeFileSync(join(ws, 'report.txt'), 'the report')
  test('send: a send stop naming every recipient; attachments from the workspace as base64; returns the id', async () => {
    const { f, seen } = fakeFetch({ 'POST /emails': [200, { id: 'em_42' }] })
    const t = resendTool({ key: () => KEY, fetch: f, workspace: () => ws })
    const args = { action: 'send' as const, from: 'hi@acme.dev', to: ['amy@example.com'], bcc: ['boss@example.com'], subject: 'Report', text: 'attached', attachments: [{ path: 'report.txt' }] }
    expect(typeof t.effect === 'function' ? t.effect(args, { roots: [] }) : t.effect).toBe('write_external')
    expect(t.hardStop!(args)).toBe('sends email through Resend to amy@example.com, boss@example.com')
    const out = await t.run(args, ctx(ws))
    expect(out.text).toContain('em_42')
    expect((seen[0].body as { attachments: Array<{ content: string }> }).attachments[0].content).toBe(Buffer.from('the report').toString('base64'))
    expect(seen[0].headers['Idempotency-Key']).toBe('idem-1')
    // A file outside the workspace isn't attached.
    await expect(t.run({ ...args, attachments: [{ path: '/etc/hosts' }] }, ctx(ws))).rejects.toThrow(/outside the workspace/)
  })
  test('domains, get and list read; no key means a clear "connect Resend"', async () => {
    const { f } = fakeFetch({
      'GET /domains': [200, { object: 'list', data: [{ id: 'd1', name: 'acme.dev', status: 'verified', capabilities: { sending: 'enabled' } }, { id: 'd2', name: 'new.dev', status: 'pending' }] }],
      'GET /emails/em_42': [200, { object: 'email', id: 'em_42', to: ['amy@example.com'], from: 'hi@acme.dev', subject: 'Report', created_at: '2026-11-17 10:00:00.0+00', last_event: 'delivered' }],
      'GET /emails': [200, { object: 'list', has_more: false, data: [{ id: 'em_42', to: ['amy@example.com'], subject: 'Report', created_at: '2026-11-17 10:00:00.0+00', last_event: 'delivered' }] }]
    })
    const t = resendTool({ key: () => KEY, fetch: f, workspace: () => ws })
    expect((await t.run({ action: 'domains' }, ctx(ws))).text).toMatch(/Send from an address on acme\.dev\./)
    expect((await t.run({ action: 'get', id: 'em_42' }, ctx(ws))).text).toMatch(/em_42: delivered/)
    expect((await t.run({ action: 'list' }, ctx(ws))).text).toMatch(/delivered .* "Report"/)
    expect(t.hardStop!({ action: 'list' })).toBeNull()
    await expect(resendTool({ key: () => undefined, fetch: f, workspace: () => ws }).run({ action: 'domains' }, ctx(ws))).rejects.toThrow(/Connect apps → Resend/)
  })
})

describe('Connect apps: the Resend tile', () => {
  const preset = PRESETS.find((p) => p.id === 'resend')!
  const memSecrets = () => { const m = new Map<string, string>(); return { m, get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v === null || v === '') m.delete(k); else m.set(k, v) } } }
  const memDb = () => { const store = new Map<string, unknown>(); return { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) } }
  test('a one-click "paste your API key" tile under Communication', () => {
    expect(preset).toMatchObject({ category: 'Communication', auth: 'apikey', url: 'app:resend' })
    expect(isNativeKeyApp('resend')).toBe(true)
    expect(connectBadge(preset)).toBe('API key')
    expect(needsKey(preset)).toBe(true)
    expect(preset.apiKey!.getKeyUrl).toBe('https://resend.com/api-keys')
    // The shape check (re_…) is main's; the panel only checks length and spaces while typing.
    expect(validateApiKey('sk_live_123456789', preset)).toMatch(/re_/)
    expect(validateApiKey(KEY, preset)).toBeNull()
    expect(keyProblem(KEY, preset)).toBeNull()
  })
  test('the key from the clipboard: the whole clipboard, or the one re_ token in it', () => {
    expect(keyFromClipboard(`  "${KEY}" `, preset)).toBe(KEY)
    expect(keyFromClipboard(`Your API key: ${KEY}\nKeep it secret`, preset)).toBe(KEY)
    expect(keyFromClipboard('just some text I copied', preset)).toBeNull()
    expect(keyFromClipboard(`${KEY} re_other_0123456789`, preset)).toBeNull()
  })
  test('Paste key: verified with GET /domains, kept in secrets, connected; a refused key is never saved', async () => {
    const s = memSecrets()
    const { f, seen } = fakeFetch({ 'GET /domains': [200, { object: 'list', data: [] }] })
    const c = new Connectors(memDb() as never, s as never, new ToolRegistry(), () => undefined, { fetch: f })
    await expect(c.connectPreset('resend')).rejects.toThrow(/API key/)
    await expect(c.pasteApiKey('resend', () => 'nothing useful')).rejects.toThrow(/clipboard doesn't hold a Resend API key/)
    const st = await c.pasteApiKey('resend', async () => `${KEY}\n`)
    expect(st).toMatchObject({ id: 'resend', state: 'connected', toolNames: ['resend'] })
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${RESEND_ORIGIN}/domains`])
    expect(s.get('resendKey')).toBe(KEY)
    expect(c.keyIds()).toContain('resend')
    expect((await c.connectPreset('resend')).state).toBe('connected')
    // Connected: the in-chat connect card doesn't offer it again.
    expect(c.suggest('resend email').map((p) => p.id)).not.toContain('resend')
    c.clearApiKey('resend')
    expect(s.get('resendKey')).toBeUndefined()
    const bad = new Connectors(memDb() as never, s as never, new ToolRegistry(), () => undefined, { fetch: fakeFetch({ 'GET /domains': [401, { name: 'validation_error', message: 'API key is invalid' }] }).f })
    const st2 = await bad.setApiKey('resend', KEY)
    expect(st2.state).toBe('error')
    expect(st2.error).toMatch(/didn't accept/)
    expect(st2.error).not.toContain(KEY)
    expect(s.get('resendKey')).toBeUndefined()
  })
})
