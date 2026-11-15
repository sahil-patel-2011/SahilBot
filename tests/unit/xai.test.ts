import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// xAI (Grok): the model table, prices in the budget, the Responses request body, and streaming against a
// local fake xAI server (text, reasoning, tool calls, effort mapping, priority tier, errors). No real xAI call.

process.env.FOREMAN_FORCE_PAID = '1'

const { XAI, xaiInfo, xaiSpec, xaiEffort, xaiRates, olderXai, grokVersion, xaiRank, xaiMaxTokens } = await import('../../src/main/llm/xai-models')
const { buildXaiRequest, xaiCost, xaiError, resetXaiState } = await import('../../src/main/llm/xai-client')
const budget = await import('../../src/main/llm/budget')
const client = await import('../../src/main/llm/client')
const providers = await import('../../src/main/llm/providers')
const { retryPolicy } = await import('../../src/main/llm/retry')
type ChatRequest = import('../../src/main/llm/client').ChatRequest
type StreamPart = import('../../src/main/llm/client').StreamPart

let server: Server
let BASE = ''
const seen: Array<{ path: string; auth?: string; body: Record<string, any> }> = []
type Scripted = { status: number; error: unknown; headers?: Record<string, string> } | { events: Array<Record<string, unknown>> }
const script: Scripted[] = []

const msg = (text: string): Record<string, unknown> => ({ type: 'message', id: `m_${text.length}`, role: 'assistant', content: [{ type: 'output_text', text }] })
const call = (name: string, args: Record<string, unknown>, id = 'call_1'): Record<string, unknown> => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name, arguments: JSON.stringify(args) })
const usage = (o: Partial<{ input: number; cached: number; output: number; reasoning: number; total: number; ticks: number }> = {}) => ({
  input_tokens: o.input ?? 1000, output_tokens: o.output ?? 100, total_tokens: o.total ?? (o.input ?? 1000) + (o.output ?? 100),
  input_tokens_details: { cached_tokens: o.cached ?? 0 }, output_tokens_details: { reasoning_tokens: o.reasoning ?? 0 },
  ...(o.ticks ? { cost_in_usd_ticks: o.ticks } : {})
})
function reply(output: Array<Record<string, unknown>>, u = usage(), o: { tier?: string; reasoning?: string; status?: string; incomplete?: string } = {}): Scripted {
  const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { status: 'in_progress' } }]
  if (o.reasoning) events.push({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: o.reasoning })
  output.forEach((it, i) => {
    events.push({ type: 'response.output_item.added', output_index: i, item: it })
    if (it.type === 'message') events.push({ type: 'response.output_text.delta', item_id: it.id, output_index: i, delta: (it.content as Array<{ text: string }>)[0].text })
    events.push({ type: 'response.output_item.done', output_index: i, item: it })
  })
  events.push({ type: o.status === 'incomplete' ? 'response.incomplete' : 'response.completed', response: { status: o.status ?? 'completed', model: 'grok-4.7', output, usage: u, service_tier: o.tier ?? 'default', ...(o.incomplete ? { incomplete_details: { reason: o.incomplete } } : {}) } })
  return { events }
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: ['grok-4.7', 'grok-4.6', 'grok-4.3', 'grok-imagine-image', 'grok-imagine-video'].map((id) => ({ id })) }))
        return
      }
      seen.push({ path: req.url ?? '', auth: req.headers.authorization, body: JSON.parse(raw || '{}') })
      const next = script.shift() ?? reply([msg('ok')])
      if ('status' in next) {
        res.writeHead(next.status, { 'content-type': 'application/json', ...(next.headers ?? {}) })
        res.end(JSON.stringify(next.error))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const ev of next.events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  process.env.FOREMAN_XAI_URL = BASE
})
afterAll(() => { server.close(); delete process.env.FOREMAN_XAI_URL })
beforeEach(() => { script.length = 0; seen.length = 0; resetXaiState(); retryPolicy.baseMs = 1; retryPolicy.maxMs = 5 })

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({ baseUrl: BASE, apiKey: 'xai-test', model: 'grok-4.7', messages: [{ role: 'system', content: 'You are SahilBot.' }, { role: 'user', content: 'hi' }], sampling: { temperature: 0.7, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, maxTokens: 4096, fast: null, ...over })
async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> { const out: StreamPart[] = []; for await (const p of stream) out.push(p); return out }
const tool = (name: string) => ({ type: 'function' as const, function: { name, description: `${name} tool`, parameters: { type: 'object', properties: { q: { type: 'string' } } } } })

describe('model table', () => {
  test('grok-4.7 is the flagship: 500K window, $2 / $0.50 / $6, low..xhigh, vision and tools', () => {
    const g = xaiInfo('grok-4.7')!
    expect(g).toMatchObject({ current: true, contextTokens: 500_000, maxOutput: 128_000, price: { input: 2, cacheRead: 0.5, output: 6 }, longContext: { atLeast: 200_000, input: 4, cacheRead: 1, output: 12 }, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', vision: true, tools: true })
    expect(XAI.filter((s) => s.current).map((s) => s.id)).toEqual(['grok-4.7'])
  })
  test('documented models, prices and aliases', () => {
    expect(xaiInfo('grok-4.5')!.price.cacheRead).toBe(0.3)
    expect(xaiInfo('grok-4.5')!.efforts).not.toContain('xhigh')
    expect(xaiInfo('grok-4.3')).toMatchObject({ contextTokens: 1_000_000, price: { input: 1.25, cacheRead: 0.2, output: 2.5 }, defaultEffort: 'low' })
    expect(xaiSpec('grok-4.3-latest')?.id).toBe('grok-4.3')
    expect(xaiSpec('grok-code-fast-1')?.id).toBe('grok-build-0.1')
    expect(xaiInfo('grok-build-0.1')).toMatchObject({ contextTokens: 256_000, price: { input: 1, output: 2 } })
    expect(xaiInfo('grok-4.20-multi-agent-0309')?.special).toBe(true)
    expect(xaiInfo('grok-imagine-image')).toBeUndefined()
  })
  test('a newer grok id is inferred from the flagship at the highest known prices, flagged estimated', () => {
    const g = xaiInfo('grok-4.8')!
    expect(g).toMatchObject({ id: 'grok-4.8', gen: 4.8, estimated: true, contextTokens: 500_000, label: 'Grok 4.8' })
    expect(g.price).toEqual({ input: 2, cacheRead: 0.5, output: 6 })
    expect(xaiInfo('grok-5')?.estimated).toBe(true)
    expect(xaiInfo('grok-3')).toBeUndefined()
    expect(grokVersion('grok-4.20-0309-reasoning')).toBe(4.2)
    expect(xaiRank('grok-4.8')!).toBeGreaterThan(xaiRank('grok-4.7')!)
  })
  test('only the flagship (and newer ids) start on', () => {
    expect([...olderXai(['grok-4.7', 'grok-4.6', 'grok-4.3', 'grok-4.8'])].sort()).toEqual(['grok-4.3', 'grok-4.6'])
  })
  test('effort mapping: the level itself, the nearest below, never none', () => {
    expect(xaiEffort('grok-4.7', 'low')).toBe('low')
    expect(xaiEffort('grok-4.7', 'xhigh')).toBe('xhigh')
    expect(xaiEffort('grok-4.7', 'max')).toBe('xhigh')
    expect(xaiEffort('grok-4.5', 'xhigh')).toBe('high')
    expect(xaiEffort('grok-4.3', 'low')).toBe('low')
    expect(xaiEffort('grok-4.20-0309-reasoning', 'high')).toBeUndefined()
    expect(xaiMaxTokens(500_000, 'grok-4.7')).toBe(128_000)
  })
  test('the provider claims grok- models and knows its URLs', () => {
    expect(providers.def('xai')).toMatchObject({ local: false, needsKey: true })
    expect(providers.def('xai').claims!.test('grok-4.7')).toBe(true)
    expect(providers.baseUrlOf('xai', { ollama: { enabled: true, baseUrl: '' }, lmstudio: { enabled: true, baseUrl: '' }, custom: { enabled: false, baseUrl: '', name: '' }, openai: { baseUrl: '' } })).toBe('https://api.x.ai/v1')
    expect(providers.providerForUrl('https://api.x.ai/v1')).toBe('xai')
    expect(providers.isXai('https://us.api.x.ai/v1')).toBe(true)
  })
})

describe('prices', () => {
  test('budget prices Grok, with the >=200K tier for the whole request', () => {
    expect(budget.priceFor('grok-4.7', 1000)).toMatchObject({ input: 2, output: 6, cacheRead: 0.5, known: true })
    expect(budget.priceFor('grok-4.7', 200_000)).toMatchObject({ input: 4, output: 12, cacheRead: 1 })
    expect(budget.priceFor('grok-4.7', 199_999).input).toBe(2)
    expect(budget.priceFor('grok-4.8')).toMatchObject({ known: false, estimated: true })
    expect(budget.longContextAbove('grok-4.7')).toBe(199_999)
    expect(budget.cost('grok-4.7', 1_000_000, 1_000_000)).toBeCloseTo(4 + 12, 6)
    expect(xaiRates('grok-4.7', 250_000)?.long).toBe(true)
  })
  test('usage: cached input at the cached rate; reasoning counted as output when total says it is extra', () => {
    const c = xaiCost('grok-4.7', { input_tokens: 10_000, input_tokens_details: { cached_tokens: 8000 }, output_tokens: 500, output_tokens_details: { reasoning_tokens: 1500 }, total_tokens: 12_000 })
    expect(c).toMatchObject({ prompt: 10_000, cached: 8000, output: 2000, reasoning: 1500, long: false })
    expect(c.usd).toBeCloseTo((2000 * 2 + 8000 * 0.5 + 2000 * 6) / 1e6, 9)
    expect(c.billedInput).toBe(2000 + 2000)
    // Reasoning already inside output_tokens: not double counted.
    expect(xaiCost('grok-4.7', { input_tokens: 100, output_tokens: 300, output_tokens_details: { reasoning_tokens: 200 }, total_tokens: 400 }).output).toBe(300)
    expect(xaiCost('grok-4.7', { input_tokens: 1, output_tokens: 1, cost_in_usd_ticks: 50_000_000 }).reportedUsd).toBeCloseTo(0.005, 9)
  })
})

describe('request bodies', () => {
  test('Responses shape: system message, function tools, effort, no sampling, stateless', () => {
    const b = buildXaiRequest(req({ tools: [tool('read_file')], effort: 'max', cacheKey: 'sahilbot:t1' }))
    expect(b).toMatchObject({ model: 'grok-4.7', store: false, stream: true, max_output_tokens: 4096, tool_choice: 'auto', parallel_tool_calls: true, reasoning: { effort: 'xhigh' }, prompt_cache_key: 'sahilbot:t1' })
    expect((b.input as Array<Record<string, unknown>>)[0]).toEqual({ type: 'message', role: 'system', content: 'You are SahilBot.' })
    expect(b.tools).toEqual([{ type: 'function', name: 'read_file', description: 'read_file tool', parameters: { type: 'object', properties: { q: { type: 'string' } } } }])
    for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'stop', 'service_tier']) expect(b).not.toHaveProperty(k)
  })
  test('no effort for models without documented levels; priority tier for fast mode', () => {
    expect(buildXaiRequest(req({ model: 'grok-4.20-0309-reasoning', effort: 'high' }))).not.toHaveProperty('reasoning')
    expect(buildXaiRequest(req({ fast: 'fast' })).service_tier).toBe('priority')
  })
  test('tool history becomes function_call / function_call_output items', () => {
    const b = buildXaiRequest(req({ tools: [tool('search')], messages: [{ role: 'user', content: 'go' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }, { role: 'tool', tool_call_id: 'c1', content: 'found' }] }))
    expect(b.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'found' }
    ])
  })
})

describe('streaming against the fake xAI server', () => {
  test('text, reasoning and usage; billed at xAI rates through the budget hook', async () => {
    script.push(reply([msg('Hello there')], usage({ input: 4000, cached: 3000, output: 50, reasoning: 200, total: 4250 }), { reasoning: 'Thinking…' }))
    const recorded: Array<{ input: number; output: number; model: string; detail?: unknown }> = []
    client.spendHooks.after = (r, input, output, model) => recorded.push({ input, output, model, detail: client.usageDetails.get(r) })
    try {
      const parts = await collect(client.streamChat(req({ effort: 'high' })))
      expect(parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')).toBe('Hello there')
      expect(parts.some((p) => p.type === 'reasoning')).toBe(true)
      expect(parts.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
      expect(seen[0].path).toBe('/v1/responses')
      expect(seen[0].auth).toBe('Bearer xai-test')
      expect(seen[0].body.reasoning).toEqual({ effort: 'high' })
      expect(recorded).toHaveLength(1)
      const usd = budget.cost('grok-4.7', recorded[0].input, recorded[0].output)
      expect(usd).toBeCloseTo((1000 * 2 + 3000 * 0.5 + 250 * 6) / 1e6, 9)
      expect(recorded[0].detail).toMatchObject({ prompt: 4000, cached: 3000, reasoning: 200, output: 250, tier: 'standard' })
    } finally { client.spendHooks.after = undefined }
  })

  test('tool calls come back as SahilBot calls', async () => {
    script.push(reply([call('search', { q: 'grok' }, 'call_9')]))
    const parts = await collect(client.streamChat(req({ tools: [tool('search')] })))
    expect(parts.find((p) => p.type === 'tool_pending')).toEqual({ type: 'tool_pending', name: 'search' })
    expect(parts.find((p) => p.type === 'tool_calls')).toEqual({ type: 'tool_calls', calls: [{ id: 'call_9', name: 'search', arguments: '{"q":"grok"}' }] })
    expect(parts.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' })
  })

  test('cut off by max_output_tokens: no half-written call runs', async () => {
    script.push(reply([msg('partial'), call('search', { q: 'x' })], usage(), { status: 'incomplete', incomplete: 'max_output_tokens' }))
    const parts = await collect(client.streamChat(req({ tools: [tool('search')] })))
    expect(parts.some((p) => p.type === 'tool_calls')).toBe(false)
    expect(parts.at(-1)).toEqual({ type: 'finish', reason: 'length' })
  })

  test('fast mode: priority confirmed is billed at 2x; a default reply at standard', async () => {
    const recorded: Array<{ input: number; output: number; tier?: string }> = []
    client.spendHooks.after = (r, input, output) => recorded.push({ input, output, tier: client.usageDetails.get(r)?.tier })
    try {
      script.push(reply([msg('fast')], usage({ input: 1000, output: 100 }), { tier: 'priority' }))
      await collect(client.streamChat(req({ fast: 'fast' })))
      script.push(reply([msg('slow')], usage({ input: 1000, output: 100 }), { tier: 'default' }))
      await collect(client.streamChat(req({ fast: 'fast' })))
      expect(seen.map((s) => s.body.service_tier)).toEqual(['priority', 'priority'])
      const std = (1000 * 2 + 100 * 6) / 1e6
      expect(budget.cost('grok-4.7', recorded[0].input, recorded[0].output)).toBeCloseTo(std * 2, 9)
      expect(recorded[0].tier).toBe('fast')
      expect(budget.cost('grok-4.7', recorded[1].input, recorded[1].output)).toBeCloseTo(std, 9)
      expect(recorded[1].tier).toBe('standard')
    } finally { client.spendHooks.after = undefined }
  })

  test('errors: a bad key is readable and not billed; 429 is retried', async () => {
    let after = 0
    client.spendHooks.after = () => { after++ }
    try {
      script.push({ status: 401, error: { error: 'Incorrect API key provided' } })
      await expect(collect(client.streamChat(req()))).rejects.toThrow(/xAI rejected the API key/)
      expect(after).toBe(0)
      script.push({ status: 429, error: { error: 'Too many requests' }, headers: { 'retry-after': '0' } }, reply([msg('after retry')]))
      const parts = await collect(client.streamChat(req()))
      expect(parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')).toBe('after retry')
      expect(xaiError(422, 'bad field', undefined, 'grok-4.7').message).toMatch(/xAI rejected the request: bad field/)
      expect((xaiError(503, 'down', undefined, 'grok-4.7') as Error & { status?: number }).status).toBe(503)
    } finally { client.spendHooks.after = undefined }
  })

  test('a 400 naming service_tier drops it and sends again (nothing billed for the rejected one)', async () => {
    script.push({ status: 400, error: { error: 'service_tier priority is not supported for this model' } }, reply([msg('ok')]))
    const parts = await collect(client.streamChat(req({ fast: 'fast' })))
    expect(parts.some((p) => p.type === 'content')).toBe(true)
    expect(seen[0].body.service_tier).toBe('priority')
    expect(seen[1].body).not.toHaveProperty('service_tier')
  })

  test('the model listing: generic GET /models with the key', async () => {
    const ids = await client.listModels(BASE, 'xai-test')
    expect(ids).toContain('grok-4.7')
  })
})
