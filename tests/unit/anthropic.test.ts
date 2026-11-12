import { describe, expect, test, vi } from 'vitest'
vi.mock('electron', () => ({}))
const { toAnthropic } = await import('../../src/main/llm/anthropic')

describe('Claude message conversion', () => {
  test('system is separated, tool results are grouped in one user message, screenshots ride inside the result', () => {
    const { system, messages } = toAnthropic([
      { role: 'system', content: 'You are Foreman.' },
      { role: 'user', content: 'check two pages' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'toolu_1', type: 'function', function: { name: 'fetch_page', arguments: '{"url":"https://a.com"}' } },
        { id: 'toolu_2', type: 'function', function: { name: 'browser', arguments: '{"action":"screenshot"}' } }
      ] },
      { role: 'tool', tool_call_id: 'toolu_1', name: 'fetch_page', content: 'page A' },
      { role: 'tool', tool_call_id: 'toolu_2', name: 'browser', content: 'shot' },
      { role: 'user', content: [{ type: 'text', text: '[Image returned by browser]' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    ], 'claude-opus-5-5')
    expect(system).toBe('You are Foreman.')
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const results = messages[2].content as Array<{ type: string; tool_use_id?: string; content?: unknown }>
    expect(results.map((b) => b.type)).toEqual(['tool_result', 'tool_result'])
    expect(JSON.stringify(results[1].content)).toContain('"type":"image"')
  })
  test("Claude's own blocks go back unchanged on the same model, and are rebuilt without thinking on another", () => {
    const raw = { provider: 'anthropic', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'hi' }] }
    const wire = [{ role: 'user' as const, content: 'hello' }, { role: 'assistant' as const, content: 'hi', raw }]
    expect(toAnthropic(wire, 'claude-opus-5-5').messages[1].content).toEqual(raw.content)
    expect(toAnthropic(wire, 'claude-sonnet-5-5').messages[1].content).toEqual([{ type: 'text', text: 'hi' }])
  })
})

describe('Claude tool schemas', () => {
  test('top-level conditionals move into the description', async () => {
    const { forClaude } = await import('../../src/main/llm/anthropic')
    const r = forClaude({ type: 'object', properties: { action: { type: 'string' }, ref: { type: 'string' } }, required: ['action'],
      allOf: [{ if: { properties: { action: { const: 'click' } } }, then: { required: ['ref'] } }] }, 'Browser.')
    expect(r.schema.allOf).toBeUndefined()
    expect(r.schema.required).toEqual(['action'])
    expect(r.description).toContain('When action is "click": also give ref.')
  })
})
