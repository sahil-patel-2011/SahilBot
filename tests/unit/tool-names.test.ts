import { describe, expect, test } from 'vitest'
import { toolName, toolNames } from '../../src/main/connectors'
import { fixName, recoverToolCalls } from '../../src/main/agent/recover'

describe('connector tool names', () => {
  test('look-alike server tools get distinct agent names, by server order', () => {
    const m = toolNames('Gmail', ['send-email', 'send_email', 'Send Email', 'search'])
    expect([...m]).toEqual([['send-email', 'gmail__send_email'], ['send_email', 'gmail__send_email_2'], ['Send Email', 'gmail__send_email_3'], ['search', 'gmail__search']])
    expect(toolNames('Gmail', ['send_email', 'send-email']).get('send_email')).toBe('gmail__send_email')
  })
  test('a tool naturally named x_2 keeps its name', () => {
    const m = toolNames('S', ['a-b', 'a_b', 'a_b_2'])
    expect(m.get('a-b')).toBe('s__a_b')
    expect(m.get('a_b_2')).toBe('s__a_b_2')
    expect(m.get('a_b')).toBe('s__a_b_3')
    expect(new Set(m.values()).size).toBe(3)
  })
  test('suffixed names stay within 64 characters', () => {
    const long = 'x'.repeat(80)
    const m = toolNames('Server', [long, long.toUpperCase()])
    expect(m.get(long)).toBe(toolName('Server', long))
    expect(m.get(long.toUpperCase())!.length).toBeLessThanOrEqual(64)
    expect(m.get(long.toUpperCase())).not.toBe(m.get(long))
  })
})

describe('tool-name recovery and disabled tools', () => {
  const known = new Set(['file_write', 'web_search', 'gmail__send_email_2', 'gmail__search'])
  const disabled = new Set(['gmail__send_email'])
  test('a call to a disabled tool is never redirected to a look-alike', () => {
    expect(fixName('gmail__send_email', known, disabled)).toBeNull()
    expect(fixName('Gmail__Send-Email', known, disabled)).toBeNull()
    expect(recoverToolCalls('<tool_call>{"name":"gmail__send_email","arguments":{}}</tool_call>', known, disabled).calls).toEqual([])
  })
  test('unknown connector tools are not fuzzy-matched; built-ins still are', () => {
    expect(fixName('gmail__send_email', known)).toBeNull()
    expect(fixName('gmail__serch', known)).toBeNull()
    expect(fixName('Gmail__Search', known)).toBe('gmail__search')
    expect(fixName('file_wirte', known, disabled)).toBe('file_write')
    expect(fixName('gmail__send_email_2', known, disabled)).toBe('gmail__send_email_2')
  })
})
