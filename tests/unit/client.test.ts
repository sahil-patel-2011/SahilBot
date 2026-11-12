import { describe, expect, test } from 'vitest'
import { ThinkSplitter, buildBody } from '../../src/main/llm/client'
import { estimateMemory, gpuBudgetGB, paramsFromName, samplingFor } from '../../src/main/llm/catalog'

describe('ThinkSplitter', () => {
  test('separates reasoning from content even when tags are split across chunks', () => {
    const s = new ThinkSplitter()
    const parts = ['<th', 'ink>plan', ' it</thi', 'nk>Hel', 'lo'].flatMap((c) => s.push(c)).concat(s.flush())
    const reasoning = parts.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('')
    const content = parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')
    expect(reasoning).toBe('plan it')
    expect(content).toBe('Hello')
  })
})

describe('memory gating', () => {
  const budget = gpuBudgetGB(64)
  test('Qwen 27B fits a 64 GB Mac at 32k', () => {
    const e = estimateMemory({ paramsB: 27, window: 32768, budgetGB: budget })
    expect(e.fits).toBe(true)
  })
  test('Llama 70B on 64 GB fits only at a smaller window', () => {
    const e = estimateMemory({ paramsB: 70.6, kvBytesPerToken: 80 * 8 * 256 * 2, window: 32768, budgetGB: budget })
    expect(e.fits).toBe(false)
    expect(e.maxFittingWindow).toBe(16384)
  })
  test('Llama 70B does not fit a 32 GB Mac at all', () => {
    expect(estimateMemory({ paramsB: 70.6, window: 16384, budgetGB: gpuBudgetGB(32) }).maxFittingWindow).toBe(0)
  })
  test('reads parameter count from names', () => {
    expect(paramsFromName('qwen3.8:27b')).toBe(27)
    expect(paramsFromName('llama3.3:70b-instruct-q4_K_M')).toBe(70)
    expect(paramsFromName('mystery-model')).toBeUndefined()
  })
})

describe('request body', () => {
  const base = { model: 'qwen3.8:27b', messages: [], maxTokens: 4096, sampling: samplingFor('qwen3.8:27b', {}) }
  test('local servers get model-card extras', () => {
    const b = buildBody({ ...base, baseUrl: 'http://localhost:11434/v1', contextWindow: 32768 })
    expect(b).toMatchObject({ temperature: 0.6, top_p: 0.95, top_k: 20, options: { num_ctx: 32768 } })
  })
  test('hosted APIs only get standard fields', () => {
    const b = buildBody({ ...base, baseUrl: 'https://api.example.com/v1' })
    expect(b.top_k).toBeUndefined()
    expect(b.options).toBeUndefined()
  })
  test('user overrides beat the model card', () => {
    expect(samplingFor('qwen3.8:27b', { 'qwen3.8:27b': { temperature: 0.2 } }).temperature).toBe(0.2)
  })
})

import { toOllamaMessages } from '../../src/main/llm/client'
describe('Ollama native format', () => {
  test('images become bare base64, tool arguments become objects, tool results carry the tool name', () => {
    const out = toOllamaMessages([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'browser', arguments: '{"action":"snapshot"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'browser', content: 'ok' }
    ])
    expect(out[0]).toEqual({ role: 'user', content: 'look', images: ['AAAA'] })
    expect(out[1].tool_calls).toEqual([{ function: { name: 'browser', arguments: { action: 'snapshot' } } }])
    expect(out[2]).toMatchObject({ role: 'tool', tool_name: 'browser', content: 'ok' })
  })
})
