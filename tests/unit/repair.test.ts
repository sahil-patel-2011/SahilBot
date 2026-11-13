import { describe, expect, test } from 'vitest'
import { check, parseArgs, repairJson } from '../../src/main/agent/validate'
import { recoverToolCalls } from '../../src/main/agent/recover'
import type { ToolDef } from '../../src/main/agent/types'

const tool: ToolDef = {
  name: 'file_write', label: 'Write', effect: 'write_local', description: '',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['overwrite', 'append', 'create'] }, n: { type: 'integer' }, on: { type: 'boolean' } },
    required: ['path', 'content'],
    additionalProperties: false
  },
  run: async () => ({ text: '' })
}

describe('tolerant repair of malformed tool arguments', () => {
  const samples: Array<[string, string, unknown]> = [
    ['single quotes', `{'path': 'a.md', 'content': 'hi'}`, { path: 'a.md', content: 'hi' }],
    ['unquoted keys', `{path: "a.md", content: "hi"}`, { path: 'a.md', content: 'hi' }],
    ['Python literals', `{'path': 'a', 'content': 'b', 'on': True, 'x': None}`, { path: 'a', content: 'b', on: true, x: null }],
    ['trailing commas everywhere', `{"path": "a", "content": "b", "tags": [1, 2, ], }`, { path: 'a', content: 'b', tags: [1, 2] }],
    ['missing final brace', `{"path": "a.md", "content": "hi"`, { path: 'a.md', content: 'hi' }],
    ['missing nested closers', `{"path": "a", "content": "b", "opts": {"deep": [1, 2`, { path: 'a', content: 'b', opts: { deep: [1, 2] } }],
    ['prose and a fence around it', 'Here you go:\n```json\n{"path": "a", "content": "b"}\n```\nDone.', { path: 'a', content: 'b' }],
    ['comments', `{\n  // where\n  "path": "a", /* what */ "content": "b"\n}`, { path: 'a', content: 'b' }],
    ['invalid escapes (Windows path, regex)', String.raw`{"path": "C:\Users\me", "content": "\d+"}`, { path: String.raw`C:\Users\me`, content: String.raw`\d+` }],
    ['single-quoted with inner double quotes and escaped apostrophe', String.raw`{'path': 'a', 'content': 'say "hi" and don\'t'}`, { path: 'a', content: `say "hi" and don't` }],
    ['raw newline inside single quotes', `{'path': 'a', 'content': 'line 1\nline 2'}`, { path: 'a', content: 'line 1\nline 2' }],
    ['junk after the object', `{"path": "a", "content": "b"}} trailing`, { path: 'a', content: 'b' }]
  ]
  for (const [name, raw, want] of samples) {
    test(name, () => expect(parseArgs(raw)).toEqual(want))
  }

  test('bare-word values become strings', () => {
    expect(parseArgs('{path: "a.md", content: "b", mode: append}')).toEqual({ path: 'a.md', content: 'b', mode: 'append' })
  })
  test('repaired arguments still go through schema validation and coercion', () => {
    expect(check(tool, `{'path': 'a.md', 'content': 'x', 'n': '3', 'on': 'true',}`)).toEqual({ ok: true, args: { path: 'a.md', content: 'x', n: 3, on: true } })
    expect(check(tool, `{path: "a.md", content: "x", mode: "replace"}`).ok).toBe(false)
  })
  test('a string cut in half is refused as cut off, never guessed at', () => {
    for (const raw of ['{"path":"a.md","content":"long text that was cu', `{'path': 'a', 'content': 'unfinished`, '{"path": "a", "content": "b", "mode": "app']) {
      const r = check(tool, raw)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.error).toMatch(/cut off/)
    }
  })
  test('cut right after a key or colon is refused too', () => {
    expect(repairJson('{"path": "a", "content":')).toBeNull()
    expect(check(tool, '{"path": "a", "content"').ok).toBe(false)
  })
  test('a reply cut off by the output limit never gets its brackets closed', () => {
    // Without the flag a missing final brace after a complete value is closed (small models drop it);
    // with it, the closing brackets mean missing content (an edit list short of items, no mode:'append').
    expect(repairJson('{"path": "a.md", "content": "hi"')).toBe('{"path": "a.md", "content": "hi"}')
    expect(repairJson('{"path": "a.md", "content": "hi"', { truncated: true })).toBeNull()
    expect(repairJson('{"edits": [{"old": "a", "new": "b"}', { truncated: true })).toBeNull()
    const r = check(tool, '{"path": "a.md", "content": "hi"', { truncated: true })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/cut off/)
    expect(check(tool, '{"path": "a.md", "content": "hi"').ok).toBe(true)
    // A complete object is fine either way.
    expect(check(tool, '{"path": "a.md", "content": "hi"}', { truncated: true }).ok).toBe(true)
  })
  test('nothing object-like is not invented', () => {
    expect(repairJson('path=a')).toBeNull()
    expect(check(tool, 'path=a').ok).toBe(false)
  })
  test('prototype names as bare words stay plain strings', () => {
    expect(parseArgs('{path: constructor, content: toString}')).toEqual({ path: 'constructor', content: 'toString' })
  })
  test('large valid content is parsed fast (strict path)', () => {
    const big = JSON.stringify({ path: 'a', content: 'x'.repeat(500_000) })
    const t = Date.now()
    expect((parseArgs(big) as { content: string }).content.length).toBe(500_000)
    expect(Date.now() - t).toBeLessThan(500)
  })
  test('large broken content is repaired in linear time', () => {
    const big = `{'path': 'a', 'content': '${'y '.repeat(200_000)}',}`
    const t = Date.now()
    expect((parseArgs(big) as { content: string }).content.length).toBe(400_000)
    expect(Date.now() - t).toBeLessThan(1500)
  })
})

describe('text tool calls use the same repair', () => {
  test('a <tool_call> with single quotes and Python literals is recovered', () => {
    const r = recoverToolCalls(`<tool_call>{'name': 'file_write', 'arguments': {'path': 'a', 'content': 'b', 'on': True}}</tool_call>`, new Set(['file_write']))
    expect(r.calls).toHaveLength(1)
    expect(JSON.parse(r.calls[0].arguments)).toEqual({ path: 'a', content: 'b', on: true })
  })
})
