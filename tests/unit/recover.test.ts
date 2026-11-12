import { describe, expect, test } from 'vitest'
import { LoopGuard, fixName, recoverToolCalls } from '../../src/main/agent/recover'
import { mentioned, perspective } from '../../src/main/agent/loop'
import type { Message, Space } from '../../src/shared/types'

const known = new Set(['file_write', 'web_search', 'browser'])

describe('tool calls written as text', () => {
  test('Hermes/Qwen <tool_call> tags', () => {
    const r = recoverToolCalls('Sure.\n<tool_call>\n{"name": "web_search", "arguments": {"query": "qwen"}}\n</tool_call>', known)
    expect(r.calls).toEqual([{ id: 'text_0', name: 'web_search', arguments: '{"query":"qwen"}' }])
    expect(r.rest).toBe('Sure.')
  })
  test('fenced JSON and bare objects', () => {
    expect(recoverToolCalls('```json\n{"name":"file_write","arguments":{"path":"a","content":"b"}}\n```', known).calls[0].name).toBe('file_write')
    expect(recoverToolCalls('{"name":"browser","parameters":{"action":"snapshot"}}', known).calls[0].arguments).toBe('{"action":"snapshot"}')
  })
  test('ordinary JSON in an answer is left alone', () => {
    expect(recoverToolCalls('Here is the config: {"port": 8080}', known).calls).toEqual([])
    expect(recoverToolCalls('{"name":"Sam","age":4}', known).calls).toEqual([])
  })
  test('near-miss names', () => {
    expect(fixName('File-Write', known)).toBe('file_write')
    expect(fixName('web_serach', known)).toBe('web_search')
    expect(fixName('functions.browser', known)).toBe('browser')
    expect(fixName('send_email', known)).toBeNull()
  })
})

describe('loop guard', () => {
  test('a third identical call with identical results is refused; whitespace in args does not matter', () => {
    const g = new LoopGuard()
    const c = { id: '1', name: 'web_search', arguments: '{"query":"a","count":2}' }
    expect(g.check(c)).toBeNull(); g.record(c, 'same')
    expect(g.check(c)).toBeNull(); g.record(c, 'same')
    expect(g.check({ ...c, arguments: '{"query":"a", "count":2}' })).toMatch(/3 times/)
  })
  test('repeating a call whose result changes is progress, not a loop', () => {
    const g = new LoopGuard()
    const snap = { id: '1', name: 'browser', arguments: '{"action":"snapshot"}' }
    for (const page of ['login', 'dashboard', 'form', 'result']) {
      expect(g.check(snap)).toBeNull()
      g.record(snap, page)
    }
  })
  test('third identical error gets a stop-retrying nudge', () => {
    const g = new LoopGuard()
    g.error('fetch_page', 'HTTP 403')
    expect(g.error('fetch_page', 'HTTP 403')).toBeNull()
    expect(g.error('fetch_page', 'HTTP 403')).toMatch(/change approach/)
  })
})

describe('group chats', () => {
  const bot = (id: string, name: string): Space => ({ id, name, color: '#000', shape: 'blob', kind: 'bot', isMain: false, pinned: false, hidden: false, members: [], model: null, folder: null, createdAt: 0 })
  const ana = bot('a', 'Ana'), ben = bot('b', 'Ben Lee')
  const m = (role: Message['role'], content: string, botId?: string, extra: Partial<Message> = {}): Message =>
    ({ id: Math.random().toString(), threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 0, meta: botId ? { botId, botName: botId === 'a' ? 'Ana' : 'Ben Lee' } : undefined, ...extra })
  test('each bot sees its own turns as assistant and others as quoted user text, without their tool traffic', () => {
    const ms = [m('user', 'hi'), m('assistant', 'Hello from Ana', 'a'), m('assistant', '', 'b', { toolCalls: [{ id: 'x', name: 'web_search', arguments: '{}' }] }), m('tool', 'results', 'b', { toolCallId: 'x' }), m('assistant', 'Ben here', 'b')]
    const v = perspective(ms, 'b')
    expect(v.map((x) => `${x.role}:${x.content}`)).toEqual(['user:hi', 'user:[Ana]: Hello from Ana', 'assistant:', 'tool:results', 'assistant:Ben here'])
    expect(perspective(ms, 'a').filter((x) => x.role === 'tool')).toHaveLength(0)
  })
  test('@mentions pick bots in order, including multi-word names', () => {
    expect(mentioned('@ben lee can you check, then @Ana', [ana, ben]).map((b) => b.name)).toEqual(['Ben Lee', 'Ana'])
    expect(mentioned('no mentions', [ana, ben])).toEqual([])
  })
})

describe('more text grammars', () => {
  test('Qwen3-Coder <function=…> calls', () => {
    const r = recoverToolCalls('<function=file_write><parameter=path>a.md</parameter><parameter=content>hi</parameter></function>', known)
    expect(r.calls[0]).toMatchObject({ name: 'file_write', arguments: '{"path":"a.md","content":"hi"}' })
  })
  test('a code sample inside a longer answer is not executed', () => {
    const text = 'To call it, send this:\n```json\n{"name":"web_search","arguments":{"query":"x"}}\n```\nThat is the format the API expects, with name and arguments.'
    expect(recoverToolCalls(text, known).calls).toEqual([])
  })
})

describe('stopword and control chars', () => {
  test('an unclosed <function=…> is still recovered', () => {
    expect(recoverToolCalls('<function=web_search><parameter=query>qwen</parameter></', known).calls[0]).toMatchObject({ name: 'web_search' })
  })
})

import { effectFor } from '../../src/main/connectors'
describe('connector tool effects', () => {
  test('MCP annotations and verbs', () => {
    expect(effectFor('search_threads')).toBe('read')
    expect(effectFor('anything', { readOnlyHint: true })).toBe('read')
    expect(effectFor('send_message')).toBe('write_external')
    expect(effectFor('trash_thread')).toBe('destructive')
  })
})

