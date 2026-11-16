import { expect, test } from 'vitest'
import { makeVault } from '../fixtures/vault-kit'
import { apiRequestTool } from '../../src/main/agent/tools/api-request'
import type { ToolContext } from '../../src/main/agent/types'

function setup() {
  const { vault, audit } = makeVault()
  vault.saveItem({ type: 'login', kind: 'api_key', name: 'project-service', site: 'https://api.example.test', password: 'fixture_service_key_123456789', apiHeader: 'X-API-Key', apiScheme: 'raw' })
  const ctx = { approved: true, threadId: 'fixture', signal: new AbortController().signal } as ToolContext
  return { vault, audit, ctx }
}

test('a service key is encrypted, kept on edits, listed only as metadata, and restricted to the exact origin', async () => {
  const { vault } = setup(), item = vault.items()[0]
  expect(item).toMatchObject({ kind: 'api_key', apiHeader: 'X-API-Key', apiScheme: 'raw' })
  expect(JSON.stringify(vault.apiKeys())).not.toContain('fixture_service_key')
  vault.saveItem({ id: item.id, type: 'login', kind: 'api_key', name: item.name, site: 'https://api.example.test', apiHeader: 'Authorization', apiScheme: 'bearer' })
  await expect(vault.withApiKey(item.name, 'https://other.example.test/tasks', async () => true)).rejects.toThrow('exact saved HTTPS origin')
  await expect(vault.withApiKey(item.name, 'https://api.example.test:9443/tasks', async () => true)).rejects.toThrow('exact saved HTTPS origin')
  await expect(vault.withApiKey(item.name, 'http://api.example.test/tasks', async () => true)).rejects.toThrow('exact saved HTTPS origin')
  expect(await vault.withApiKey(item.name, 'https://api.example.test/tasks', async (header, value) => ({ header, value }))).toEqual({ header: 'Authorization', value: 'Bearer fixture_service_key_123456789' })
})

test('the approved REST call injects the key only in main, blocks redirects, and masks echoed secrets', async () => {
  const { vault, audit, ctx } = setup()
  let options: RequestInit | undefined
  const tool = apiRequestTool(vault, (async (_url, o) => { options = o; return new Response(JSON.stringify({ items: [{ name: 'Fixture' }], echoed: 'fixture_service_key_123456789' }), { status: 200 }) }) as typeof fetch)
  const result = await tool.run({ action: 'request', key: 'project-service', url: 'https://api.example.test/tasks' }, ctx)
  expect(options).toMatchObject({ method: 'GET', headers: { 'X-API-Key': 'fixture_service_key_123456789' }, redirect: 'error', credentials: 'omit' })
  expect(result.data).toMatchObject({ ok: true, body: { echoed: '[redacted]' } })
  expect(JSON.stringify(result)).not.toContain('fixture_service_key_123456789')
  expect(JSON.stringify(audit.list())).not.toContain('fixture_service_key_123456789')
})

test('unapproved, invalid and oversized API requests cannot use a credential', async () => {
  const { vault, ctx } = setup(); let calls = 0
  const tool = apiRequestTool(vault, (async () => { calls++; return new Response('x'.repeat(128_001)) }) as typeof fetch)
  await expect(tool.run({ action: 'request', key: 'project-service', url: 'https://api.example.test' }, { ...ctx, approved: false })).rejects.toThrow('Approve')
  await expect(tool.run({ action: 'request', key: 'project-service', url: 'https://api.example.test', method: 'GET', body: {} }, ctx)).rejects.toThrow('cannot have a body')
  await expect(tool.run({ action: 'request', key: 'project-service', url: 'https://api.example.test' }, ctx)).rejects.toThrow('128 KB')
  expect(calls).toBe(1)
  expect(() => vault.saveItem({ type: 'login', kind: 'api_key', name: 'bad-header', site: 'https://example.test', password: 'key', apiHeader: 'Host' })).toThrow('authentication header')
})

test('JSON-escaped echoed keys stay masked even if the Vault is locked during the request', async () => {
  const { vault, ctx } = setup()
  const tool = apiRequestTool(vault, (async () => {
    vault.lock('fixture')
    return new Response('{"echoed":"\\u0066ixture_service_key_123456789","nested":[{"fixture_service_key_123456789":"\\u0066ixture_service_key_123456789"}]}')
  }) as typeof fetch)
  const out = await tool.run({ action: 'request', key: 'project-service', url: 'https://api.example.test/tasks' }, ctx)
  expect(out.data).toMatchObject({ body: { echoed: '[redacted]', nested: [{ '[redacted]': '[redacted]' }] } })
  expect(JSON.stringify(out)).not.toContain('fixture_service_key_123456789')
  expect(vault.redact('fixture_service_key_123456789')).not.toContain('fixture_service_key_123456789')
})


test('service keys cannot appear in browser-login lists or be typed as website passwords', () => {
  const { vault } = setup(), id = vault.items()[0].id
  expect(vault.list()).toEqual([]); expect(vault.names()).toEqual([])
  expect(vault.matches('project-service', 'https://api.example.test/login')).toBe(false)
  expect(vault.credential('project-service')).toBeUndefined()
  expect(vault.fillTarget('project-service', 'password')).toBeUndefined()
  expect(() => vault.fillValue(id, 'password')).toThrow('never typed into a website')
})
