import { beforeEach, expect, test } from 'vitest'
import { clearDraft, loadDraft, pruneDrafts, saveDraft } from '../../src/renderer/src/lib/drafts'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null, get length() { return store.size }
  }
})

test('unsent text is kept per chat, forgotten when sent or cleared, and dropped after 30 days', () => {
  saveDraft('t1', 'half-written question')
  saveDraft(undefined, 'new chat idea')
  expect(loadDraft('t1')).toBe('half-written question')
  expect(loadDraft(null)).toBe('new chat idea')
  expect(loadDraft('t2')).toBe('')
  saveDraft('t1', '   ')
  expect(loadDraft('t1')).toBe('')
  saveDraft('t1', 'again')
  clearDraft('t1')
  expect(store.has('sahilbot:draft:t1')).toBe(false)
  saveDraft('old', 'stale', Date.now() - 31 * 24 * 3600_000)
  pruneDrafts()
  expect(store.has('sahilbot:draft:old')).toBe(false)
  expect(loadDraft(null)).toBe('new chat idea')
})
