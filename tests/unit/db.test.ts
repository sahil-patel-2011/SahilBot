import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'

describe('Db', () => {
  test('spaces, threads and messages round-trip', () => {
    const db = new Db(':memory:')
    const s = db.createSpace('Work', '#000000')
    const t = db.createThread(s.id, 'auto', 'qwen3.8:27b')
    db.insertMessage({ threadId: t.id, role: 'user', content: 'hello world', kind: 'normal', status: 'done' })
    db.insertMessage({ threadId: t.id, role: 'assistant', content: 'hi', reasoning: 'r', kind: 'normal', status: 'done' })
    const ms = db.listMessages(t.id)
    expect(ms.map((m) => m.content)).toEqual(['hello world', 'hi'])
    expect(ms[1].reasoning).toBe('r')
    expect(db.searchThreads('world')[0].id).toBe(t.id)
    expect(db.listSpaces()[0].lastPreview).toBe('hi')
    db.deleteSpace(s.id)
    expect(db.listMessages(t.id)).toEqual([])
  })

  // RLC-01 / RLB-01: the sidebar never previews a reply the chat doesn't show (replaced, or still held for its checks).
  test('previews skip superseded and provisional replies', () => {
    const db = new Db(':memory:')
    const s = db.createSpace('Work', '#000000')
    const t = db.createThread(s.id, 'auto', 'm')
    db.insertMessage({ threadId: t.id, role: 'user', content: 'Make the budget', kind: 'normal', status: 'done' })
    db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Saved budget.xlsx.', kind: 'normal', status: 'done' })
    db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Let me re-check the totals.', kind: 'normal', status: 'done', meta: { superseded: true } })
    db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Still checking', kind: 'normal', status: 'streaming', meta: { provisional: true } })
    expect(db.listSpaces()[0].lastPreview).toBe('Saved budget.xlsx.')
    expect(db.getThread(t.id)?.lastPreview).toBe('Saved budget.xlsx.')
  })

  // RLB-01: a reply held for its checks when the app quit mid-run shows after the restart.
  test('sweepStreaming shows a reply left held by a quit or crash', () => {
    const db = new Db(':memory:')
    const s = db.createSpace('Work', '#000000')
    const t = db.createThread(s.id, 'auto', 'm')
    const m = db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Day 1: River Street.', kind: 'normal', status: 'done', meta: { provisional: true, sources: [] } })
    db.sweepStreaming()
    const after = db.listMessages(t.id).find((x) => x.id === m.id)!
    expect(after.meta?.provisional).toBeUndefined()
    expect(after.meta?.sources).toEqual([])
  })
})
