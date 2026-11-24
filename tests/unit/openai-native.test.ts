import { mkdtempSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { ChatEvent, ModelInfo, Settings, Thread } from '../../src/shared/types'
import type { ChatRequest, StreamPart, WireMessage } from '../../src/main/llm/client'
import type { ToolDef } from '../../src/main/agent/types'

// OpenAI over the Responses API (llm/openai-models, llm/openai-responses), against a local fake Responses
// server: no network, no real keys. Covers the model table, effort mapping, request bodies per model family,
// streaming events, usage and cost (cached input, cache writes, the >272K long-context tier), errors,
// retries, cancellation, router picks, the provider labelling fix, and tool calls round-tripping through the
// real agent loop with approvals and hard stops still in force.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'
// The fake server is on localhost: price it like the paid cloud endpoint it stands in for.
process.env.FOREMAN_FORCE_PAID = '1'
process.env.FOREMAN_RAM_GB = '64'

const models = await import('../../src/main/llm/openai-models')
const resp = await import('../../src/main/llm/openai-responses')
const budget = await import('../../src/main/llm/budget')
const client = await import('../../src/main/llm/client')
const { retryPolicy } = await import('../../src/main/llm/retry')
const { pick } = await import('../../src/main/llm/router')
const { providerForUrl, isOpenAI } = await import('../../src/main/llm/providers')
const { Endpoints } = await import('../../src/main/llm/endpoints')
const { Agent } = await import('../../src/main/agent/loop')
const { ResultStore, estimate } = await import('../../src/main/agent/context')
const { ToolRegistry } = await import('../../src/main/agent/registry')
const { coreTools } = await import('../../src/main/agent/tools/core')
const { Db } = await import('../../src/main/db')

// ---------------------------------------------------------------------------------------------------
// The fake Responses server: records every request; answers from a script (SSE events, or an HTTP error).
// ---------------------------------------------------------------------------------------------------

type Reply = { events: Array<Record<string, unknown>>; delayMs?: number } | { status: number; error: Record<string, unknown>; headers?: Record<string, string> }
const script: Reply[] = []
const seen: Array<{ path: string; auth?: string; body: Record<string, unknown> }> = []
let server: Server
let BASE = ''

const done = (output: Array<Record<string, unknown>>, usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } }, status = 'completed', extra: Record<string, unknown> = {}) =>
  ({ type: status === 'completed' ? 'response.completed' : 'response.incomplete', response: { id: 'resp_1', object: 'response', status, model: 'gpt-6.1-sol', output, usage, ...extra } })
const msg = (text: string, phase = 'final_answer', id = 'msg_1') => ({ id, type: 'message', role: 'assistant', status: 'completed', phase, content: [{ type: 'output_text', text, annotations: [] }] })
const reasoningItem = (id = 'rs_1') => ({ id, type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking it over' }], encrypted_content: `enc-${id}` })
const fnCall = (callId: string, name: string, args: Record<string, unknown>, id = 'fc_1') => ({ id, type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' })
/** A whole streamed reply: the output items' events, then response.completed. */
function reply(output: Array<Record<string, unknown>>, usage?: Record<string, unknown>): Reply {
  const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } }]
  output.forEach((it, i) => {
    events.push({ type: 'response.output_item.added', output_index: i, item: { ...it, ...(it.type === 'function_call' ? { arguments: '' } : {}) } })
    if (it.type === 'reasoning') for (const s of (it.summary as Array<{ text: string }>)) events.push({ type: 'response.reasoning_summary_text.delta', item_id: it.id, output_index: i, summary_index: 0, delta: s.text })
    if (it.type === 'message') for (const c of it.content as Array<{ text: string }>) events.push({ type: 'response.output_text.delta', item_id: it.id, output_index: i, content_index: 0, delta: c.text })
    if (it.type === 'function_call') events.push({ type: 'response.function_call_arguments.delta', item_id: it.id, output_index: i, delta: it.arguments }, { type: 'response.function_call_arguments.done', item_id: it.id, output_index: i, arguments: it.arguments })
    events.push({ type: 'response.output_item.done', output_index: i, item: it })
  })
  events.push(done(output, usage))
  return { events }
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-6.3-sol', 'gpt-image-2', 'sora-2'].map((id) => ({ id })) }))
        return
      }
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}') })
      const next = script.shift() ?? reply([msg('done')])
      if ('status' in next) {
        res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) })
        res.end(JSON.stringify({ error: next.error }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const ev of next.events) {
        if (res.destroyed) return
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
        if (next.delayMs) await new Promise((r) => setTimeout(r, next.delayMs))
      }
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.FOREMAN_OPENAI_URL = BASE
})
afterAll(() => { server.close(); delete process.env.FOREMAN_OPENAI_URL })
beforeEach(() => { script.length = 0; seen.length = 0; resp.resetResponsesState(); retryPolicy.baseMs = 1; retryPolicy.maxMs = 5 })

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ baseUrl: BASE, apiKey: 'sk-test', model: 'gpt-6.1-sol', messages: [{ role: 'system', content: 'You are SahilBot.' }, { role: 'user', content: 'hi' }], sampling: { temperature: 0.7, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, maxTokens: 4096, ...over })
async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> { const out: StreamPart[] = []; for await (const p of stream) out.push(p); return out }
const tool = (name: string) => ({ type: 'function' as const, function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } })

// ---------------------------------------------------------------------------------------------------

describe('model table', () => {
  test('the current lineup: windows, prices, efforts and which API tools need', () => {
    // GPT-6.2 Astra and Sol (models/gpt-6.2-astra, /gpt-6.2-sol and pricing, read 2026-11-18).
    const astra = models.openaiInfo('gpt-6.2-astra')!
    expect(astra).toMatchObject({ gen: 6.2, role: 'astra', label: 'GPT-6.2 Astra', tier: 3, current: true, contextTokens: 1_050_000, maxInput: 922_000, maxOutput: 128_000, price: { input: 8, cacheRead: 0.4, output: 40, write30m: 10, write12h: 20 }, longContext: { above: 272_000, input: 2, output: 1.5 }, tools: 'responses-only', api: 'responses', cacheOptions: true })
    expect(astra.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(astra.estimated).toBeUndefined()
    const sol = models.openaiInfo('gpt-6.2-sol')!
    expect(sol).toMatchObject({ gen: 6.2, role: 'sol', label: 'GPT-6.2 Sol', tier: 2, current: true, contextTokens: 1_050_000, maxInput: 922_000, maxOutput: 128_000, price: { input: 2, cacheRead: 0.1, output: 10, write30m: 2.5, write12h: 5 }, tools: 'responses-only', api: 'responses' })
    expect(sol.efforts).not.toContain('none')
    // Not documented for 6.2: reasoning.context all_turns isn't sent.
    expect(sol.allTurns).toBeUndefined()
    // Long context (>272K): Astra $16 / $0.80 / $60, Sol $4 / $0.20 / $15.
    expect(budget.priceFor('gpt-6.2-astra', 300_000)).toMatchObject({ input: 16, output: 60, cacheRead: 0.8, known: true })
    expect(budget.priceFor('gpt-6.2-sol', 300_000)).toMatchObject({ input: 4, output: 15, cacheRead: 0.2 })
    // Superseded by 6.2 (listed, off by default, priced as before).
    expect(models.openaiInfo('gpt-6-astra')).toMatchObject({ tier: 3, supersededBy: 'gpt-6.2-astra', price: { input: 10, cacheRead: 1, output: 50, write30m: 12.5, write12h: 25 }, tools: 'responses-only' })
    expect(models.openaiInfo('gpt-6-astra')!.current).toBeUndefined()
    expect(models.openaiInfo('gpt-6.1-sol')).toMatchObject({ tier: 2, supersededBy: 'gpt-6.2-sol', price: { input: 2, cacheRead: 0.1, output: 10 }, allTurns: true, defaultEffort: 'medium' })
    expect(models.openaiInfo('gpt-6.1-terra')).toMatchObject({ tier: 1, price: { input: 1, cacheRead: 0.05, output: 5 } })
    expect(models.openaiInfo('gpt-6-luna')).toMatchObject({ tier: 0, price: { input: 0.1, cacheRead: 0.01, output: 0.5 }, tools: 'chat-with-none' })
    expect(models.openaiInfo('gpt-6-luna')!.efforts).toContain('none')
    expect(models.openaiInfo('gpt-6-sol')).toMatchObject({ supersededBy: 'gpt-6.1-sol', price: { cacheRead: 0.2 } })
    expect(models.openaiInfo('gpt-5.5')).toMatchObject({ contextTokens: 1_050_000, maxOutput: 128_000, price: { input: 5, cacheRead: 0.5, output: 30 } })
    expect(models.openaiInfo('gpt-5.5')!.efforts).not.toContain('max')
    expect(models.openaiInfo('gpt-5.5')!.cacheOptions).toBeUndefined()
    expect(models.openaiInfo('gpt-5.4-mini')).toMatchObject({ contextTokens: 400_000, maxInput: 272_000, defaultEffort: 'none' })
    expect(models.openaiInfo('gpt-5.4-mini')!.longContext).toBeUndefined()
    expect(models.openaiInfo('gpt-5.4-nano')!.builtins).not.toContain('computer_use')
  })
  test('aliases, dated snapshots and labels', () => {
    expect(models.openaiSpec('gpt-5.6')!.id).toBe('gpt-5.6-sol')
    expect(models.openaiSpec('gpt-5.4-mini-2026-03-17')!.id).toBe('gpt-5.4-mini')
    expect(models.openaiSpec('gpt-4o-mini')!.id).toBe('gpt-4o-mini')
    expect(models.gptLabel('gpt-6.1-sol')).toBe('GPT-6.1 Sol')
    expect(models.gptLabel('gpt-6.2-astra')).toBe('GPT-6.2 Astra')
    expect(models.openaiSpec('gpt-6.2-sol-2026-11-17')!.id).toBe('gpt-6.2-sol')
    expect(models.gptLabel('gpt-5.4-mini-2026-03-17')).toBe('GPT-5.4 mini (2026-03-17)')
  })
  test('an unknown newer GPT is inferred from its role at the role\'s highest prices, marked estimated', () => {
    const next = models.openaiInfo('gpt-6.3-sol')!
    expect(next).toMatchObject({ estimated: true, tier: 2, role: 'sol', api: 'responses', contextTokens: 1_050_000, label: 'GPT-6.3 Sol' })
    expect(next.price).toMatchObject({ input: 4, output: 20, cacheRead: 0.4 })
    expect(models.openaiInfo('gpt-7')).toMatchObject({ estimated: true, tier: 3, price: { input: 10, output: 50 } })
    expect(budget.priceFor('gpt-7')).toMatchObject({ known: false, estimated: true, input: 10 })
    // Non-chat GPT names are never inferred.
    expect(models.openaiInfo('gpt-image-2')).toBeUndefined()
    expect(models.openaiInfo('gpt-oss:20b')).toBeUndefined()
    expect(models.openaiInfo('gpt-realtime-2')).toBeUndefined()
  })
  test('older models start switched off; the lineup and newer ids stay on', () => {
    const off = models.olderOpenAI(['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4-mini-2026-03-17', 'gpt-6.3-sol', 'gpt-4o', 'o3', 'dall-e-3'])
    // GPT-6 Astra and 6.1 Sol, superseded by 6.2, start off with the rest of the older models.
    expect([...off].sort()).toEqual(['dall-e-3', 'gpt-4o', 'gpt-5.4-mini-2026-03-17', 'gpt-5.5', 'gpt-5.6', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'o3'])
  })
  test('effort mapping: the level when supported, else the nearest below, never none', () => {
    expect(models.openaiEffort('gpt-6-astra', 'low')).toBe('low')
    expect(models.openaiEffort('gpt-6-astra', 'max')).toBe('max')
    expect(models.openaiEffort('gpt-6-luna', 'low')).toBe('low')
    expect(models.openaiEffort('gpt-5.5', 'max')).toBe('xhigh')
    expect(models.openaiEffort('gpt-5.4-mini', 'max')).toBe('xhigh')
    expect(models.openaiEffort('gpt-5.5-pro', 'high')).toBeUndefined()
    for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.4-nano', 'gpt-7']) for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const v = models.openaiEffort(id, e)!
      expect(models.openaiInfo(id)!.efforts).toContain(v)
      expect(v).not.toBe('none')
    }
    expect(models.openaiMaxTokens(4096, 'max', 'gpt-6-astra')).toBe(64_000)
    expect(models.openaiMaxTokens(4096, 'medium', 'gpt-6-astra')).toBe(25_000)
  })
  test('context strategy windows and the compaction point', () => {
    expect(models.openaiWindow('gpt-6-astra', 'max')).toBe(922_000)
    expect(models.openaiWindow('gpt-6-astra', 'balanced')).toBe(256_000)
    expect(models.openaiWindow('gpt-6-astra', 'balanced')).toBeLessThan(272_000)
    expect(models.openaiWindow('gpt-6-astra', 'economy')).toBe(128_000)
    expect(models.openaiWindow('gpt-5.4-mini', 'max')).toBe(272_000)
    expect(models.openaiWindow('gpt-5.5', 'max')).toBe(922_000)
    expect(models.openaiWindow('gpt-4o', 'max')).toBe(131_072)
    expect(models.openaiCompactAt(256_000)).toBe(204_800)
    expect(resp.cloudWindow('claude-opus-5-5', 'balanced')).toBe(400_000)
    expect(resp.cloudWindow('gpt-6.1-sol', 'max')).toBe(922_000)
    expect(resp.openaiChatWindow('openai', 'gpt-5.5', 'economy')).toBe(128_000)
    expect(resp.openaiChatWindow('ollama', 'gpt-5.5')).toBeUndefined()
  })
})

describe('prices and usage', () => {
  test('priceFor: long-context multiplier above 272K, cache reads', () => {
    expect(budget.priceFor('gpt-6-astra', 100_000)).toMatchObject({ input: 10, output: 50, cacheRead: 1, known: true })
    expect(budget.priceFor('gpt-6-astra', 300_000)).toMatchObject({ input: 20, output: 75, cacheRead: 2 })
    // gpt-5.4-mini can't go past 272K: no long-context tier.
    expect(budget.priceFor('gpt-5.4-mini', 300_000)).toMatchObject({ input: 0.75, output: 4.5 })
    expect(budget.stepCost('gpt-6.1-sol', 100_000).estimated).toBe(false)
  })
  test('usage: plain, cached and written input, reasoning, and the long tier for the whole request', () => {
    const u = { input_tokens: 12_000, output_tokens: 2000, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } }, output_tokens_details: { reasoning_tokens: 1500 } }
    const c = resp.responsesCost('gpt-6-astra', u)
    // 1000 plain + 4000 x 0.1 + 3000 x 1.25 + 4000 x 2.5
    expect(c.billedInput).toBe(1000 + 400 + 3750 + 10_000)
    expect(c.usd).toBeCloseTo((15_150 * 10 + 2000 * 50) / 1e6, 9)
    expect(c).toMatchObject({ prompt: 12_000, cached: 4000, written: 7000, reasoning: 1500, long: false })
    // GPT-5.5: no write charge before GPT-5.6.
    expect(resp.responsesCost('gpt-5.5', { input_tokens: 10_000, output_tokens: 0, input_tokens_details: { cached_tokens: 8000 } }).billedInput).toBe(2000 + 800)
    const long = resp.responsesCost('gpt-6.1-sol', { input_tokens: 300_000, output_tokens: 1000, input_tokens_details: { cached_tokens: 290_000 } })
    expect(long.long).toBe(true)
    expect(long.usd).toBeCloseTo(((10_000 + 290_000 * 0.05) * 2 * 2 + 1000 * 10 * 1.5) / 1e6, 9)
    expect(resp.responsesCost('gpt-6.1-sol', { input_tokens: 0, output_tokens: 0 }, 3).usd).toBeCloseTo(0.03, 9)
  })
  test('tierTokens: the real prompt size picks the tier, and what is recorded costs exactly that (Claude and OpenAI)', () => {
    // A 300K Haiku 5.5 prompt that is mostly cached is still long context ($0.50 / $2.50, not $0.10 / $0.50).
    const billed = 10_000 + 290_000 * 0.1
    const haiku = budget.tierTokens('claude-haiku-5-5', 300_000, billed, 1000)
    expect(budget.cost('claude-haiku-5-5', haiku.promptTokens, haiku.completionTokens)).toBeCloseTo((billed * 0.5 + 1000 * 2.5) / 1e6, 8)
    expect(budget.cost('claude-haiku-5-5', billed, 1000)).toBeLessThan((billed * 0.5) / 1e6)
    // The same for OpenAI's 272K rule.
    const c = resp.responsesCost('gpt-6.1-sol', { input_tokens: 300_000, output_tokens: 1000, input_tokens_details: { cached_tokens: 290_000 } })
    const t = budget.tierTokens('gpt-6.1-sol', c.prompt, c.billedInput, c.output)
    expect(budget.cost('gpt-6.1-sol', t.promptTokens, t.completionTokens)).toBeCloseTo(c.usd, 8)
    // A short prompt whose 12h writes weigh past the threshold stays at the standard tier.
    const w = resp.responsesCost('gpt-6-astra', { input_tokens: 200_000, output_tokens: 100, input_tokens_details: { cache_write_tokens: 200_000, cache_write_tokens_details: { ttl_12h_tokens: 200_000 } } })
    const tw = budget.tierTokens('gpt-6-astra', w.prompt, w.billedInput, w.output)
    expect(w.billedInput).toBe(500_000)
    expect(budget.cost('gpt-6-astra', tw.promptTokens, tw.completionTokens)).toBeCloseTo(w.usd, 8)
    // Fees ride along; a normal request is recorded as is.
    const f = budget.tierTokens('gpt-6.1-sol', 1000, 1000, 100, 0.02)
    expect(budget.cost('gpt-6.1-sol', f.promptTokens, f.completionTokens)).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6 + 0.02, 8)
    expect(budget.tierTokens('gpt-6.1-sol', 5000, 4000, 100)).toEqual({ promptTokens: 4000, completionTokens: 100 })
  })
})

describe('request bodies', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo='
  const history = (model: string): WireMessage[] => [
    { role: 'system', content: 'You are SahilBot.' },
    { role: 'user', content: [{ type: 'text', text: 'What is on screen?' }, { type: 'image_url', image_url: { url: png } }] },
    // Replayed exactly as this model returned it (the loop kept the call id).
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_A', type: 'function', function: { name: 'look', arguments: '{"q":"x"}' } }], raw: { provider: 'openai', model, content: [reasoningItem(), msg('Looking.', 'commentary', 'msg_0'), fnCall('call_A', 'look', { q: 'x' })] } },
    { role: 'tool', tool_call_id: 'call_A', name: 'look', content: 'a chart' },
    { role: 'user', imagesFor: 'call_A', content: [{ type: 'text', text: '[Image returned by look]' }, { type: 'image_url', image_url: { url: png } }] },
    // Another model's turn: rebuilt without reasoning; a call to a tool this request doesn't offer becomes text.
    { role: 'assistant', content: 'Checked.', tool_calls: [{ id: 'toolu_9', type: 'function', function: { name: 'gone_tool', arguments: '{}' } }], raw: { provider: 'anthropic', model: 'claude-opus-5-5', content: [] } },
    { role: 'tool', tool_call_id: 'toolu_9', name: 'gone_tool', content: 'ok' },
    { role: 'user', content: 'Thanks, now summarize.' }
  ]
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5.4-mini']) {
    test(`${model}`, () => {
      const { body } = resp.buildResponsesRequest(req({ model, messages: history(model), tools: [tool('look'), tool('web_search')], effort: 'max', cacheKey: 'sahilbot:t1', compactAt: 204_800, native: { enabled: false, web: true } }))
      expect(body).toMatchSnapshot()
      // Never sent: sampling (reasoning models reject it), previous_response_id, a stored response.
      expect(body).not.toHaveProperty('temperature')
      expect(body).not.toHaveProperty('previous_response_id')
      expect(body.store).toBe(false)
      expect(models.openaiInfo(model)!.efforts).toContain((body.reasoning as { effort: string }).effort)
    })
  }
  test('the shape that matters: replay order, ids, images in tool output, built-in web search', () => {
    const { body, web } = resp.buildResponsesRequest(req({ model: 'gpt-6.1-sol', messages: history('gpt-6.1-sol'), tools: [tool('look'), tool('web_search')], effort: 'high', cacheKey: 'sahilbot:t1', cacheTtl: '1h', native: { enabled: false, web: true } }))
    const input = body.input as Array<Record<string, unknown>>
    expect(web).toBe(true)
    expect(input.map((i) => `${i.type}:${i.role ?? i.call_id ?? i.id ?? ''}`)).toEqual([
      'message:developer', 'message:user', 'reasoning:rs_1', 'message:assistant', 'function_call:call_A', 'function_call_output:call_A',
      'message:assistant', 'message:user', 'message:user'
    ])
    expect((input[0].content as Array<Record<string, unknown>>)[0]).toEqual({ type: 'input_text', text: 'You are SahilBot.', prompt_cache_breakpoint: { mode: 'explicit', ttl: '12h' } })
    expect(input[2]).toMatchObject({ encrypted_content: 'enc-rs_1' })
    expect(input[3]).toMatchObject({ phase: 'commentary' })
    expect(input[5].output).toEqual([{ type: 'input_text', text: 'a chart' }, { type: 'input_image', image_url: png }])
    expect(input[6]).toMatchObject({ content: 'Checked.\n[Called gone_tool {}]', phase: 'final_answer' })
    expect(input[7]).toMatchObject({ content: [{ type: 'input_text', text: '[Result of gone_tool]\nok' }] })
    expect(body.tools).toEqual([{ type: 'function', name: 'look', description: 'look tool', parameters: tool('look').function.parameters, strict: false }, { type: 'web_search' }])
    expect(body.include).toEqual(['reasoning.encrypted_content', 'web_search_call.action.sources'])
    expect(body).toMatchObject({ prompt_cache_key: 'sahilbot:t1', prompt_cache_options: { ttl: '30m' }, reasoning: { effort: 'high', summary: 'auto', context: 'all_turns' }, max_output_tokens: 32_000, max_tool_calls: 8, tool_choice: 'auto' })
  })
  test('renamed call ids are mapped back onto the replayed calls; items before a compaction item are dropped', () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_X-1234', type: 'function', function: { name: 'look', arguments: '{}' } }], raw: { provider: 'openai', model: 'gpt-6-astra', content: [reasoningItem('rs_a'), { type: 'compaction', id: 'cmp_1', encrypted_content: 'zip' }, fnCall('call_X', 'look', {})] } },
      { role: 'tool', tool_call_id: 'call_X-1234', content: 'r' }
    ]
    const input = resp.toResponsesInput(wire, 'gpt-6-astra', { declared: new Set(['look']) })
    expect(input.map((i) => i.type)).toEqual(['message', 'compaction', 'function_call', 'function_call_output'])
    expect(input[2].call_id).toBe('call_X-1234')
    expect(input[3].call_id).toBe('call_X-1234')
  })
  test('no prompt_cache_options, breakpoints or writes before GPT-5.6; no web search when it is off', () => {
    const { body } = resp.buildResponsesRequest(req({ model: 'gpt-5.5', tools: [tool('web_search')], native: { enabled: false, web: false } }))
    expect(body).not.toHaveProperty('prompt_cache_options')
    expect(JSON.stringify(body.input)).not.toContain('prompt_cache_breakpoint')
    expect(body.tools).toEqual([expect.objectContaining({ type: 'function', name: 'web_search' })])
    expect(body.include).toEqual(['reasoning.encrypted_content'])
  })
})

describe('streaming against the fake Responses server', () => {
  test('text, reasoning summaries, tool calls, usage and the raw items to replay', async () => {
    script.push(reply([reasoningItem(), msg('Let me check.', 'commentary', 'msg_0'), fnCall('call_1', 'look', { q: 'x' })], { input_tokens: 5000, output_tokens: 300, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 500 }, output_tokens_details: { reasoning_tokens: 200 } }))
    const parts = await collect(resp.streamResponses(req({ tools: [tool('look')] })))
    expect(seen[0].path).toBe('/v1/responses')
    expect(seen[0].auth).toBe('Bearer sk-test')
    expect(parts.filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text).join('')).toBe('Thinking it over')
    expect(parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')).toBe('Let me check.')
    expect(parts.find((p) => p.type === 'tool_pending')).toEqual({ type: 'tool_pending', name: 'look' })
    expect(parts.find((p) => p.type === 'tool_calls')).toEqual({ type: 'tool_calls', calls: [{ id: 'call_1', name: 'look', arguments: '{"q":"x"}' }] })
    const usage = parts.find((p) => p.type === 'usage') as Extract<StreamPart, { type: 'usage' }>
    // 500 plain + 4000 cached x 0.05 (6.1 Sol reads) + 500 written x 1.25
    expect(usage).toMatchObject({ promptTokens: 500 + 200 + 625, completionTokens: 300, prompt: 5000, cachedTokens: 4000, cacheWriteTokens: 500, reasoningTokens: 200 })
    const raw = parts.find((p) => p.type === 'raw') as Extract<StreamPart, { type: 'raw' }>
    expect(raw).toMatchObject({ provider: 'openai', model: 'gpt-6.1-sol' })
    expect((raw.content as unknown[]).length).toBe(3)
    expect(parts[parts.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' })
  })
  test('cut off by max_output_tokens: the half-written call is dropped and never runs', async () => {
    script.push({ events: [done([reasoningItem(), fnCall('call_2', 'look', { q: 'y' })], { input_tokens: 10, output_tokens: 10 }, 'incomplete', { incomplete_details: { reason: 'max_output_tokens' } })] })
    const parts = await collect(resp.streamResponses(req({ tools: [tool('look')] })))
    expect(parts.find((p) => p.type === 'tool_calls')).toBeUndefined()
    expect((parts.find((p) => p.type === 'raw') as { content: Array<{ type: string }> }).content.map((i) => i.type)).toEqual(['reasoning'])
    expect(parts[parts.length - 1]).toEqual({ type: 'finish', reason: 'length' })
  })
  test('built-in web search: sources become findings, cited text is outside content, calls are counted', async () => {
    const answer = { ...msg('Paris is the capital.'), content: [{ type: 'output_text', text: 'Paris is the capital.', annotations: [{ type: 'url_citation', url: 'https://example.com/fr', title: 'France', start_index: 0, end_index: 5 }] }] }
    script.push(reply([{ id: 'ws_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'capital of France', sources: [{ type: 'url', url: 'https://example.com/fr' }, { type: 'url', url: 'https://example.org/b' }] } }, answer]))
    const parts = await collect(resp.streamResponses(req({ tools: [tool('web_search')], native: { enabled: false, web: true } })))
    expect(parts.find((p) => p.type === 'tool_pending')).toEqual({ type: 'tool_pending', name: 'web_search' })
    const st = parts.find((p) => p.type === 'server_tools') as Extract<StreamPart, { type: 'server_tools' }>
    expect(st.searches).toBe(1)
    expect(st.read).toEqual([{ title: 'France', url: 'https://example.com/fr' }])
    expect(st.found.map((f) => f.url)).toEqual(['https://example.com/fr', 'https://example.org/b'])
    expect(st.untrusted).toContain('Paris')
    expect((parts.find((p) => p.type === 'usage') as { extraUsd?: number }).extraUsd).toBeCloseTo(0.01, 9)
  })
  test('errors read clearly and carry what the retry logic needs', async () => {
    script.push({ status: 429, error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' }, headers: { 'retry-after': '7' } })
    const e1 = await collect(resp.streamResponses(req())).catch((e) => e)
    expect(e1.message).toMatch(/rate-limiting.*7s/)
    expect(e1).toMatchObject({ status: 429, retryAfterMs: 7000, billed: false })
    script.push({ status: 401, error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } })
    expect((await collect(resp.streamResponses(req())).catch((e) => e)).message).toMatch(/rejected the API key/)
    script.push({ status: 400, error: { message: 'Your input exceeds the context window of this model.', code: 'context_length_exceeded', param: 'input' } })
    expect((await collect(resp.streamResponses(req())).catch((e) => e)).message).toMatch(/too long for gpt-6.1-sol/)
    script.push({ status: 400, error: { message: 'Invalid prompt: flagged as potentially violating our usage policy.', code: 'invalid_prompt' } })
    expect((await collect(resp.streamResponses(req())).catch((e) => e)).message).toMatch(/usage policies/)
    // Out of credit comes back as 429 but must not be retried.
    script.push({ status: 429, error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } })
    const q = await collect(resp.streamResponses(req())).catch((e) => e)
    expect(q.status).toBe(402)
    expect(client.retryInfo(q).retry).toBe(false)
    // A failure inside the stream maps to a retryable status.
    script.push({ events: [{ type: 'response.created', response: {} }, { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'The model failed to generate a response.' } } }] })
    const f = await collect(resp.streamResponses(req())).catch((e) => e)
    expect(f.status).toBe(500)
    expect(client.retryInfo(f).retry).toBe(true)
    script.push({ events: [{ type: 'error', code: 'rate_limit_exceeded', message: 'slow down', param: null }] })
    expect((await collect(resp.streamResponses(req())).catch((e) => e)).status).toBe(429)
    // Seen live: the details nested under `error`. Out of credit is said plainly and never retried.
    script.push({ events: [{ type: 'error', error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You have no credits remaining. Add credits to continue using the API.', param: null } }] })
    const nc = await collect(resp.streamResponses(req())).catch((e) => e)
    expect(nc.message).toMatch(/no credits remaining/)
    expect(nc.message).not.toMatch(/OpenAI stream error/)
    expect(client.retryInfo(nc).retry).toBe(false)
  })
  test('a field the account or model rejects is dropped, remembered and the request sent again', async () => {
    script.push({ status: 400, error: { message: 'Your organization must be verified to generate reasoning summaries.', type: 'invalid_request_error', param: 'reasoning.summary', code: 'unsupported_value' } })
    const parts = await collect(resp.streamResponses(req({ effort: 'medium' })))
    expect(parts.some((p) => p.type === 'content')).toBe(true)
    expect((seen[0].body.reasoning as Record<string, unknown>).summary).toBe('auto')
    expect((seen[1].body.reasoning as Record<string, unknown>).summary).toBeUndefined()
    await collect(resp.streamResponses(req({ effort: 'medium' })))
    expect((seen[2].body.reasoning as Record<string, unknown>).summary).toBeUndefined()
  })
  test('cancellation stops the stream mid-reply', async () => {
    const events = (reply([msg('one two three four five six')]) as { events: Array<Record<string, unknown>> }).events
    script.push({ events: [...events.slice(0, 2), ...Array.from({ length: 30 }, (_, i) => ({ type: 'response.output_text.delta', item_id: 'msg_1', delta: ` w${i}` })), ...events.slice(2)], delayMs: 20 })
    const ctrl = new AbortController()
    const got: string[] = []
    const err = await (async () => {
      for await (const p of resp.streamResponses(req({ signal: ctrl.signal }))) {
        if (p.type === 'content') { got.push(p.text); if (got.length === 2) ctrl.abort() }
      }
    })().catch((e) => e)
    expect(err?.name).toBe('AbortError')
    expect(got.length).toBeLessThan(10)
  })
  test('through streamChat: transient failures are retried, usage is recorded at the real tier', async () => {
    const recorded: Array<{ input: number; output: number; model: string }> = []
    client.spendHooks.after = (_r, input, output, servedModel) => recorded.push({ input, output, model: servedModel })
    try {
      script.push({ status: 503, error: { message: 'overloaded', code: 'server_is_overloaded' } })
      script.push(reply([msg('hello')], { input_tokens: 300_000, output_tokens: 100, input_tokens_details: { cached_tokens: 290_000 } }))
      const parts = await collect(client.streamChat(req()))
      expect(seen.length).toBe(2)
      expect(parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')).toBe('hello')
      const c = resp.responsesCost('gpt-6.1-sol', { input_tokens: 300_000, output_tokens: 100, input_tokens_details: { cached_tokens: 290_000 } })
      expect(recorded).toHaveLength(1)
      expect(budget.cost('gpt-6.1-sol', recorded[0].input, recorded[0].output)).toBeCloseTo(c.usd, 8)
    } finally { client.spendHooks.after = undefined }
  })
  test('non-OpenAI servers keep Chat Completions; api.openai.com is OpenAI, not a custom server', () => {
    expect(models.usesResponses('https://api.openai.com/v1', 'gpt-6-astra')).toBe(true)
    expect(models.usesResponses('https://api.openai.com/v1', 'gpt-4o')).toBe(false)
    expect(models.usesResponses('https://openrouter.ai/api/v1', 'gpt-6-astra')).toBe(false)
    expect(models.usesResponses('http://localhost:1234/v1', 'gpt-6-astra')).toBe(false)
    expect(isOpenAI('https://api.openai.com/v1/')).toBe(true)
    expect(providerForUrl('https://api.openai.com/v1')).toBe('openai')
    expect(providerForUrl('https://api.anthropic.com/v1')).toBe('anthropic')
    expect(providerForUrl('http://localhost:8080/v1')).toBe('custom')
    // Chat Completions on a GPT the table knows sends only an effort it accepts.
    expect(client.buildBody(req({ baseUrl: 'https://openrouter.ai/api/v1', model: 'gpt-5.5', effort: 'max' })).reasoning_effort).toBe('xhigh')
  })
})

// ---------------------------------------------------------------------------------------------------
// Router and model listing.
// ---------------------------------------------------------------------------------------------------

const info = (id: string, provider: 'openai' | 'anthropic' = 'openai'): ModelInfo => ({ id, provider, providerName: provider, enabled: true, installed: true, vision: true, tools: true, tier: provider === 'openai' ? models.openaiInfo(id)!.tier : /opus/.test(id) ? 3 : /sonnet/.test(id) ? 2 : 1, rank: provider === 'openai' ? models.openaiRank(id) : /opus/.test(id) ? 5.055 : /sonnet/.test(id) ? 4.055 : 3.055, requiredGB: 0, maxFittingWindow: 131072, fits: true, note: 'remote' } as ModelInfo)

describe('Auto with an OpenAI key', () => {
  const gpt = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-5.5-pro'].map((id) => info(id))
  test('Luna for small talk, Terra for quick questions, Sol for tasks, Astra for the hardest; pro never', () => {
    expect([0, 1, 2, 3].map((t) => pick(gpt, t as 0 | 1 | 2 | 3, { preferCloud: true })?.id)).toEqual(['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'])
    expect(pick(gpt.filter((m) => m.id !== 'gpt-6.2-astra'), 3, { preferCloud: true })?.id).toBe('gpt-6.2-sol')
    // With the superseded models switched on too, the newer generation wins its tier.
    expect(pick([...gpt, info('gpt-6-astra'), info('gpt-6.1-sol')], 3, { preferCloud: true })?.id).toBe('gpt-6.2-astra')
    expect(pick([...gpt, info('gpt-6-astra'), info('gpt-6.1-sol')], 2, { preferCloud: true })?.id).toBe('gpt-6.2-sol')
  })
  test('with a Claude key too, Claude keeps its tiers', () => {
    const both = [...gpt, info('claude-haiku-5-5', 'anthropic'), info('claude-sonnet-5-5', 'anthropic'), info('claude-opus-5-5', 'anthropic')]
    expect([1, 2, 3].map((t) => pick(both, t as 1 | 2 | 3, { preferCloud: true })?.id)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
  })
  test('the listing: api.openai.com models are OpenAI\'s, with real windows, tiers, labels and prices; older ones start off', async () => {
    const prev = process.env.FOREMAN_BASE_URL
    process.env.FOREMAN_BASE_URL = BASE
    try {
      const s = { providers: { ollama: { enabled: false, baseUrl: '' }, lmstudio: { enabled: false, baseUrl: '' }, custom: { enabled: false, baseUrl: '' }, openai: { baseUrl: '' } }, keys: { openai: true }, cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customModels: [], hiddenModels: [], shownModels: [], contextWindow: 0, baseUrl: '' }
      const ep = new Endpoints({ get: () => s, keyFor: () => 'sk-test', apiKey: () => 'sk-test' } as never)
      expect(ep.for('gpt-6.2-astra')).toMatchObject({ provider: 'openai', baseUrl: BASE })
      const list = await ep.list()
      const by = new Map(list.models.map((m) => [m.id, m]))
      expect(list.providers?.[0]).toMatchObject({ id: 'openai', name: 'OpenAI', ok: true })
      expect(by.get('gpt-6.2-astra')).toMatchObject({ provider: 'openai', label: 'GPT-6.2 Astra', tier: 3, contextTokens: 1_050_000, maxOutputTokens: 128_000, vision: true, tools: true, enabled: true, price: { input: 8, output: 40, cacheRead: 0.4 } })
      expect(by.get('gpt-6.2-sol')).toMatchObject({ label: 'GPT-6.2 Sol', tier: 2, enabled: true, price: { input: 2, output: 10, cacheRead: 0.1 } })
      expect(by.get('gpt-6.2-sol')?.priceEstimated).toBeFalsy()
      expect(by.get('gpt-6-luna')).toMatchObject({ tier: 0, enabled: true })
      expect(by.get('gpt-6.3-sol')).toMatchObject({ priceEstimated: true, enabled: true })
      // Superseded by 6.2: listed (pick them by name or switch them on), off by default.
      for (const off of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4-mini-2026-03-17']) expect(by.get(off)?.enabled, off).toBe(false)
      expect(by.get('gpt-6-astra')).toMatchObject({ label: 'GPT-6 Astra', price: { input: 10, output: 50, cacheRead: 1 } })
      expect(by.has('gpt-image-2')).toBe(false)
      expect(by.has('sora-2')).toBe(false)
      // Auto (cloud) with only an OpenAI key routes over the lineup, cloud first.
      // (A newer Sol the table doesn't know yet ranks above 6.2 Sol, as a newer Claude would.)
      const usable = ep.usable()
      expect(pick(usable, 2)?.id).toBe('gpt-6.3-sol')
      expect(pick(usable.filter((m) => m.id !== 'gpt-6.3-sol'), 2)?.id).toBe('gpt-6.2-sol')
      expect(pick(usable, 3)?.id).toBe('gpt-6.2-astra')
    } finally {
      if (prev === undefined) delete process.env.FOREMAN_BASE_URL
      else process.env.FOREMAN_BASE_URL = prev
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// The real agent loop driving the real Responses client against the fake server.
// ---------------------------------------------------------------------------------------------------

const MODEL = 'gpt-6.1-sol'
const gptInfo = info(MODEL)

function harness(tools: ToolDef[], mode: 'ask' | 'auto' | 'autonomous' = 'autonomous') {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: MODEL, hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: [], keys: { openai: true }, search: { provider: 'none', searxngUrl: '', hasBraveKey: false }
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  const events: ChatEvent[] = []
  const last = { ok: true, models: [gptInfo], budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'openai', baseUrl: BASE, apiKey: 'sk-test' }), usable: () => [gptInfo], list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => 'sk-test', apiKey: () => 'sk-test' } as never,
    endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
    emit: (e) => events.push(e), secretValues: () => [], fitWindow: (_m, w) => w, counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  const thread = (): Thread => db.createThread(space.id, mode, MODEL)
  return { db, agent, events, thread, run: async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text })).done }
}

const inputOf = (i: number) => seen[i].body.input as Array<Record<string, unknown>>
async function waitPending(agent: InstanceType<typeof Agent>, threadId: string) {
  for (let i = 0; i < 400; i++) { const r = agent.pending(threadId)[0]; if (r) return r; await new Promise((res) => setTimeout(res, 10)) }
  return undefined
}

describe('the agent loop on the Responses API', () => {
  test('a function call runs SahilBot\'s tool; its result goes back as function_call_output with the reasoning replayed', async () => {
    const ran: string[] = []
    const lookup: ToolDef<{ q: string }> = {
      name: 'lookup_note', label: 'Lookup', effect: 'read', description: 'look up a note',
      parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
      async run({ q }) { ran.push(q); return { text: `note about ${q}: 42` } }
    }
    const h = harness([lookup])
    const t = h.thread()
    script.push(reply([reasoningItem('rs_7'), fnCall('call_77', 'lookup_note', { q: 'answer' }, 'fc_77')]))
    script.push(reply([reasoningItem('rs_8'), msg('The answer is 42.')]))
    expect(await h.run(t, 'look up the answer note and tell me')).toBe('finished')
    expect(ran).toEqual(['answer'])
    expect(seen.length).toBe(2)
    // First request: stateless, the chat as cache key, SahilBot's tools as function tools.
    expect(seen[0].body).toMatchObject({ model: MODEL, store: false, stream: true, prompt_cache_key: `sahilbot:${t.id}`, reasoning: { summary: 'auto', context: 'all_turns' } })
    expect((seen[0].body.tools as Array<{ type?: string }>).every((x) => x.type === 'function')).toBe(true)
    // Second request: the first request's input unchanged (append-only), then the reasoning item, the call and its output.
    const second = inputOf(1)
    const first = inputOf(0)
    expect(second.slice(0, first.length)).toEqual(first)
    const tail = second.slice(first.length)
    expect(tail.map((i) => i.type)).toEqual(['reasoning', 'function_call', 'function_call_output'])
    expect(tail[0]).toMatchObject({ id: 'rs_7', encrypted_content: 'enc-rs_7' })
    expect(tail[1]).toMatchObject({ call_id: 'call_77', id: 'fc_77', name: 'lookup_note' })
    expect(tail[2]).toMatchObject({ call_id: 'call_77' })
    expect(String(tail[2].output)).toContain('note about answer: 42')
    const reply2 = h.db.listMessages(t.id).filter((m) => m.role === 'assistant').pop()!
    expect(reply2.content).toBe('The answer is 42.')
    expect(reply2.meta?.raw).toMatchObject({ provider: 'openai', model: MODEL })
    expect(reply2.reasoning).toContain('Thinking it over')
  })
  test('Ask mode: a write still asks first; denied, nothing runs and the model is told', async () => {
    const ran: string[] = []
    const send: ToolDef<{ to: string }> = {
      name: 'send_note', label: 'Send', effect: 'write_external', description: 'send a note',
      parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
      async run({ to }) { ran.push(to); return { text: `sent to ${to}` } }
    }
    const h = harness([send], 'ask')
    const t = h.thread()
    script.push(reply([fnCall('call_88', 'send_note', { to: 'bob@example.com' })]))
    script.push(reply([msg('Okay, I did not send it.')]))
    const finished = h.run(t, 'send a note to bob@example.com')
    const r = await waitPending(h.agent, t.id)
    expect(r).toMatchObject({ kind: 'approval', tool: 'send_note' })
    h.agent.respond(t.id, r!.id, 'deny')
    expect(await finished).toBe('finished')
    expect(ran).toEqual([])
    const out = inputOf(1).find((i) => i.type === 'function_call_output')!
    expect(out.call_id).toBe('call_88')
    expect(String(out.output)).toMatch(/declined/)
  })
  test('paying still stops, even in autonomous mode', async () => {
    const ran: string[] = []
    const pay: ToolDef<{ amount: number }> = {
      name: 'pay_invoice', label: 'Pay', effect: 'write_external', description: 'pay an invoice',
      parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false },
      hardStop: () => 'payment',
      async run({ amount }) { ran.push(String(amount)); return { text: 'paid' } }
    }
    const h = harness([pay], 'autonomous')
    const t = h.thread()
    script.push(reply([fnCall('call_99', 'pay_invoice', { amount: 120 })]))
    script.push(reply([msg('Stopped before paying.')]))
    const finished = h.run(t, 'pay the invoice')
    const r = await waitPending(h.agent, t.id)
    expect(r).toMatchObject({ kind: 'approval', tool: 'pay_invoice' })
    expect(r!.reason).toMatch(/^Spends money: payment/)
    h.agent.respond(t.id, r!.id, 'deny')
    expect(await finished).toBe('finished')
    expect(ran).toEqual([])
  })
})
