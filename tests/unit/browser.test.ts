import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { clickEffect } = await import('../../src/main/agent/tools/browser')
const { originMatches, normalizeOrigin } = await import('../../src/main/vault')

describe('click effect', () => {
  const r = (role: string, name: string) => ({ backendNodeId: 1, role, name })
  test('links and tabs are reads; local widgets are local', () => {
    expect(clickEffect(r('link', 'Pricing'))).toBe('read')
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
  test('exact site and its subdomains only', () => {
    expect(originMatches('https://github.com', 'https://github.com/login')).toBe(true)
    expect(originMatches('https://example.com', 'https://login.example.com/x')).toBe(true)
    expect(originMatches('https://github.com', 'https://github.com.evil.io/login')).toBe(false)
    expect(originMatches('https://github.com', 'http://github.com/login')).toBe(false)
    expect(originMatches('http://127.0.0.1:4000', 'http://127.0.0.1:4001/')).toBe(false)
  })
  test('bare domains are normalized to https origins', () => {
    expect(normalizeOrigin('github.com')).toBe('https://github.com')
    expect(normalizeOrigin('https://app.acme.io/login?x=1')).toBe('https://app.acme.io')
  })
})
