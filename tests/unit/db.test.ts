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

  test('the startup sweep: a streaming reply is stopped, and one left out of sight (provisional) stands', () => {
    const db = new Db(':memory:')
    const t = db.createThread(db.createSpace('Work', '#000000').id, 'auto', 'm')
    const a = db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Saved invoice.pdf', kind: 'normal', status: 'done', meta: { provisional: true, sources: [] } })
    const b = db.insertMessage({ threadId: t.id, role: 'assistant', content: 'Half', kind: 'normal', status: 'streaming', meta: { provisional: true } })
    db.sweepStreaming()
    expect(db.getMessage(a.id)?.meta?.provisional).toBeUndefined()
    expect(db.getMessage(a.id)?.meta?.sources).toEqual([])
    expect(db.getMessage(b.id)?.status).toBe('stopped')
    expect(db.getMessage(b.id)?.meta?.provisional).toBeUndefined()
  })
})
