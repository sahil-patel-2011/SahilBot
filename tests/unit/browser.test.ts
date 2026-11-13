import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { clickEffect, browserTool } = await import('../../src/main/agent/tools/browser')
const { decide } = await import('../../src/main/agent/permissions')
const { originMatches, normalizeOrigin } = await import('../../src/main/vault')

describe('click effect', () => {
  const r = (role: string, name: string) => ({ backendNodeId: 1, role, name })
  test('links and tabs are reads; local widgets are local', () => {
    expect(clickEffect({ ...r('link', 'Pricing'), tag: 'a', href: '/pricing', navLink: true })).toBe('read')
    expect(clickEffect(r('checkbox', 'Remember me'))).toBe('write_local')
  })
  test('benign buttons run in Auto; unknown buttons count as outside actions', () => {
    expect(clickEffect(r('button', 'Search'))).toBe('write_local')
    expect(clickEffect(r('button', 'Accept all cookies'))).toBe('write_local')
    expect(clickEffect(r('button', 'Send message'))).toBe('write_external')
    expect(clickEffect(r('button', 'Sign in'))).toBe('write_external')
    expect(clickEffect(undefined)).toBe('write_external')
  })
  test('delete-like labels are destructive, even on links', () => {
    expect(clickEffect(r('button', 'Delete project'))).toBe('destructive')
    expect(clickEffect(r('link', 'Remove member'))).toBe('destructive')
  })
})

describe('vault origins', () => {
  test('exact origin by default; subdomains only when opted in', () => {
    expect(originMatches('https://github.com', 'https://github.com/login')).toBe(true)
    expect(originMatches('https://example.com', 'https://login.example.com/x')).toBe(false)
    expect(originMatches('https://example.com', 'https://login.example.com/x', { subdomains: true })).toBe(true)
    expect(originMatches('https://github.com', 'https://github.com.evil.io/login')).toBe(false)
    expect(originMatches('https://github.com', 'http://github.com/login')).toBe(false)
    expect(originMatches('http://127.0.0.1:4000', 'http://127.0.0.1:4001/')).toBe(false)
  })
  test('bare domains are normalized to https origins', () => {
    expect(normalizeOrigin('github.com')).toBe('https://github.com')
    expect(normalizeOrigin('https://app.acme.io/login?x=1')).toBe('https://app.acme.io')
  })
})

describe('Teach recording started by the agent', () => {
  const fake = { refInfo: () => undefined, pageUrl: () => 'https://example.com/', pendingDialog: undefined, teach: { state: () => undefined } } as never
  const tool = browserTool(fake, {} as never)
  const effect = (a: Record<string, unknown>) => (typeof tool.effect === 'function' ? tool.effect(a as never, { roots: [] }) : tool.effect)
  test('starting is an outside action with a hard stop, so it always asks (stop and status only read)', () => {
    const start = { action: 'recording', op: 'start' }
    expect(effect(start)).toBe('write_external')
    expect(tool.consequential?.(start as never, { threadId: 't' })).toBe(true)
    expect(tool.hardStop?.(start as never)).toMatch(/recording what you click and type in the browser for up to 10 minutes/)
    expect(tool.describe?.(start as never)).toMatch(/^Record what you do in the browser for up to 10 minutes/)
    expect(effect({ action: 'recording', op: 'stop' })).toBe('read')
    expect(effect({ action: 'recording', op: 'status' })).toBe('read')
    expect(tool.hardStop?.({ action: 'recording', op: 'stop' } as never)).toBeNull()
    const p = { effect: 'write_external' as const, tool: 'browser', alwaysAllowed: false, hardStop: tool.hardStop!(start as never), hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true }
    expect(decide({ ...p, mode: 'auto' }).verdict).toBe('ask')
    expect(decide({ ...p, mode: 'bypass' }).verdict).toBe('ask')
    expect(decide({ ...p, mode: 'auto', alwaysAllowed: true }).verdict).toBe('ask')
  })
})
