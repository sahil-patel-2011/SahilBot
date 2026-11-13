import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { backoffMs, parseRetryAfter, retryInfo, retryPolicy, streamChat, withRetries, type StreamPart } from '../../src/main/llm/client'
import { samplingFor } from '../../src/main/llm/catalog'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

const saved = { ...retryPolicy }
afterEach(() => Object.assign(retryPolicy, saved))

const fail = (props: Record<string, unknown>, message = 'boom'): Error => Object.assign(new Error(message), props)

async function collect(gen: AsyncGenerator<StreamPart>): Promise<StreamPart[]> {
  const out: StreamPart[] = []
  for await (const p of gen) out.push(p)
  return out
}

describe('which failures are retried', () => {
  test('rate limits, timeouts, server errors and dropped connections are; client errors are not', () => {
    for (const status of [408, 429, 500, 502, 503, 529]) expect(retryInfo(fail({ status })).retry).toBe(true)
    for (const status of [400, 401, 403, 404, 422]) expect(retryInfo(fail({ status })).retry).toBe(false)
    expect(retryInfo(new TypeError('fetch failed')).retry).toBe(true)
    expect(retryInfo(fail({ cause: { code: 'ECONNRESET' } }, 'request failed')).retry).toBe(true)
    expect(retryInfo(fail({ code: 'ETIMEDOUT' })).retry).toBe(true)
    expect(retryInfo(fail({ network: true })).retry).toBe(true)
  })
  test('budget refusals, aborts and plain errors are never retried', () => {
    expect(retryInfo(new Error('Cloud budget reached: $5.00 of your $5.00 monthly cap is used')).retry).toBe(false)
    expect(retryInfo(new DOMException('stopped', 'AbortError')).retry).toBe(false)
    expect(retryInfo(new Error('Claude rejected the request: bad schema')).retry).toBe(false)
  })
  test('Retry-After as seconds or a date; the server wait wins over backoff', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter('soon')).toBeUndefined()
    expect(retryInfo(fail({ status: 429, retryAfterMs: 2500 })).afterMs).toBe(2500)
    expect(backoffMs(0, 2500)).toBeGreaterThanOrEqual(2500)
  })
  test('backoff grows exponentially with jitter, capped', () => {
    retryPolicy.baseMs = 1000
    const d0 = backoffMs(0)
    const d2 = backoffMs(2)
    expect(d0).toBeGreaterThanOrEqual(800)
    expect(d0).toBeLessThanOrEqual(1200)
    expect(d2).toBeGreaterThanOrEqual(3200)
    expect(d2).toBeLessThanOrEqual(4800)
    expect(backoffMs(20)).toBeLessThanOrEqual(retryPolicy.maxMs * 1.2)
  })
})

describe('withRetries', () => {
  test('retries a transient failure and passes the successful attempt through', async () => {
    retryPolicy.baseMs = 1
    let calls = 0
    const parts = await collect(withRetries(async function* () {
      calls++
      if (calls < 3) throw fail({ status: 503 })
      yield { type: 'content', text: 'ok' }
      yield { type: 'finish', reason: 'stop' }
    }))
    expect(calls).toBe(3)
    expect(parts).toEqual([{ type: 'content', text: 'ok' }, { type: 'finish', reason: 'stop' }])
  })
  test('emits a reset before retrying an attempt that already streamed', async () => {
    retryPolicy.baseMs = 1
    let calls = 0
    const parts = await collect(withRetries(async function* () {
      calls++
      yield { type: 'content', text: calls === 1 ? 'half' : 'whole' }
      if (calls === 1) throw new TypeError('fetch failed')
      yield { type: 'finish', reason: 'stop' }
    }))
    expect(parts.map((p) => p.type)).toEqual(['content', 'reset', 'content', 'finish'])
  })
  test('gives up after three retries, and never retries a 400', async () => {
    retryPolicy.baseMs = 1
    let calls = 0
    await expect(collect(withRetries(async function* () { calls++; throw fail({ status: 500 }) }))).rejects.toThrow('boom')
    expect(calls).toBe(4)
    calls = 0
    await expect(collect(withRetries(async function* () { calls++; throw fail({ status: 400 }) }))).rejects.toThrow('boom')
    expect(calls).toBe(1)
  })
  test('a Retry-After longer than a minute fails fast instead of hanging', async () => {
    let calls = 0
    await expect(collect(withRetries(async function* () { calls++; throw fail({ status: 429, retryAfterMs: 120_000 }) }))).rejects.toThrow()
    expect(calls).toBe(1)
  })
  test('a stop during the backoff ends at once', async () => {
    retryPolicy.baseMs = 10_000
    const ctrl = new AbortController()
    const started = Date.now()
    setTimeout(() => ctrl.abort(), 20)
    await expect(collect(withRetries(async function* () { throw fail({ status: 503 }) }, ctrl.signal))).rejects.toThrow(/stopped/)
    expect(Date.now() - started).toBeLessThan(2000)
  })
  test('a finished call is never repeated', async () => {
    retryPolicy.baseMs = 1
    let calls = 0
    await expect(collect(withRetries(async function* () {
      calls++
      yield { type: 'finish', reason: 'stop' }
      throw fail({ status: 503 })
    }))).rejects.toThrow()
    expect(calls).toBe(1)
  })
})

describe('streamChat against a model server', () => {
  let llm: MockLlm
  beforeAll(async () => { llm = await startMockLlm() })
  afterAll(async () => { await llm.close() })
  const req = (): Parameters<typeof streamChat>[0] => ({ baseUrl: llm.url, model: 'qwen3.8:27b', messages: [{ role: 'user', content: 'hi' }], sampling: samplingFor('qwen3.8:27b', {}), maxTokens: 64 })

  test('a 503 then a 500 are retried; the third attempt answers', async () => {
    retryPolicy.baseMs = 1
    llm.requests.length = 0
    llm.script.push({ status: 503 }, { status: 500 }, { content: 'hello there', delay: 0 })
    const parts = await collect(streamChat(req()))
    expect(llm.requests).toHaveLength(3)
    expect(parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')).toBe('hello there')
  })
  test('a 400 fails at once with its status', async () => {
    retryPolicy.baseMs = 1
    llm.requests.length = 0
    llm.script.push({ status: 400 })
    await expect(collect(streamChat(req()))).rejects.toMatchObject({ status: 400 })
    expect(llm.requests).toHaveLength(1)
  })
})
