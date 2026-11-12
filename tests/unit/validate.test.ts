import { describe, expect, test } from 'vitest'
import { check, parseArgs, repairPrompt } from '../../src/main/agent/validate'
import type { ToolDef } from '../../src/main/agent/types'

const tool: ToolDef = {
  name: 'file_write', label: 'Write', effect: 'write_local', description: '',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string', enum: ['overwrite', 'append', 'create'] } },
    required: ['path', 'content'],
    additionalProperties: false
  },
  run: async () => ({ text: '' })
}

describe('schema validation and repair', () => {
  test('valid arguments pass', () => {
    expect(check(tool, '{"path":"a.md","content":"x"}')).toEqual({ ok: true, args: { path: 'a.md', content: 'x' } })
  })
  test('tolerates code fences and trailing commas from small models', () => {
    expect(parseArgs('```json\n{"a": 1,}\n```')).toEqual({ a: 1 })
  })
  test('missing required field is reported by name', () => {
    const r = check(tool, '{"path":"a.md"}')
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/content/)
  })
  test('bad enum lists the allowed values', () => {
    const r = check(tool, '{"path":"a","content":"b","mode":"replace"}')
    expect(!r.ok && r.error).toMatch(/overwrite, append, create/)
  })
  test('unknown fields and non-JSON are rejected', () => {
    expect(check(tool, '{"path":"a","content":"b","extra":1}').ok).toBe(false)
    expect(check(tool, 'path=a').ok).toBe(false)
    expect(check(tool, '[1,2]').ok).toBe(false)
  })
  test('first failure invites one retry with the schema; second says stop', () => {
    expect(repairPrompt(tool, 'x', true)).toMatch(/Call file_write again/)
    expect(repairPrompt(tool, 'x', true)).toContain('"required":["path","content"]')
    expect(repairPrompt(tool, 'x', false)).toMatch(/Do not retry/)
  })
})

describe('argument coercion (local-model friendly)', () => {
  const t2: ToolDef = {
    name: 'x', label: 'x', effect: 'read', description: '', run: async () => ({ text: '' }),
    parameters: { type: 'object', properties: { n: { type: 'integer' }, on: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } }, opts: { type: 'object' } }, additionalProperties: false }
  }
  test('numbers, booleans, scalars-to-arrays and JSON strings are fixed before validating', () => {
    expect(check(t2, '{"n":"42","on":"true","tags":"a","opts":"{\\"k\\":1}"}')).toEqual({ ok: true, args: { n: 42, on: true, tags: ['a'], opts: { k: 1 } } })
  })
  test('cut-off arguments are refused, not guessed at', () => {
    const r = check(tool, '{"path":"a.md","content":"long text that was cu')
    expect(!r.ok && r.error).toMatch(/cut off/)
  })
})

test('raw newlines inside JSON strings are repaired', () => {
  expect(parseArgs('{"path":"a.md","content":"line 1\nline 2"}')).toEqual({ path: 'a.md', content: 'line 1\nline 2' })
})
