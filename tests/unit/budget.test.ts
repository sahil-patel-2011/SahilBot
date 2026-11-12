import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { Budget, cost, priceFor } from '../../src/main/llm/budget'
import { buildBody } from '../../src/main/llm/client'

describe('cloud budget', () => {
  test('prices', () => {
    expect(cost('claude-opus-5-5', 1_000_000, 1_000_000)).toBe(24)
    expect(cost('claude-sonnet-5-5', 1_000_000, 0)).toBe(2)
    expect(priceFor('claude-haiku-5-5', 200_000)).toMatchObject({ input: 0.5, output: 2.5 })
    expect(priceFor('some-new-model').known).toBe(false)
  })
  test('the cap blocks a request that could exceed it, counting the worst-case reply', () => {
    let cap = 1
    const b = new Budget(new Db(':memory:'), () => cap)
    b.record('api.anthropic.com', 'claude-opus-5-5', 100_000, 20_000) // $0.80
    expect(b.spent()).toBeCloseTo(0.8)
    // 10k input ($0.04) + 4,096 max output ($0.08) = $0.12 more -> $0.92, allowed.
    expect(() => b.check('claude-opus-5-5', 10_000, 4096)).not.toThrow()
    // A bigger request could reach $1.08 -> refused, nothing sent.
    expect(() => b.check('claude-opus-5-5', 50_000, 4096)).toThrow(/Cloud budget reached/)
    cap = 0
    expect(() => b.check('claude-haiku-5-5', 10, 10)).toThrow()
  })
  test('Claude requests carry no custom sampling (current models reject it)', () => {
    const body = buildBody({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', messages: [], maxTokens: 100, sampling: { temperature: 0.6, top_p: 0.9, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 } })
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
  })
})
