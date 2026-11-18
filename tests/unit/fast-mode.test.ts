import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Settings } from '@shared/types'
import { DEFAULT_FAST, GPT62_ULTRAFAST, currentFastTier, fastChoice, fastFactor, fastHooks, fastSettings, fastSupport, fastTierFor, fastTradeoff, speedOptions } from '../../src/main/llm/fast-mode'
import { priceFor, stepCost } from '../../src/main/llm/budget'
import { BETA, buildClaudeRequest } from '../../src/main/llm/anthropic'
import { buildResponsesRequest, openaiServiceTier, resetResponsesState, servedTier } from '../../src/main/llm/openai-responses'
import { buildBody, type ChatRequest } from '../../src/main/llm/client'

// Fast mode: each provider's official faster tier (Anthropic speed "fast", OpenAI service_tier fast / ultrafast,
// xAI priority), per provider and per model, never used unless allowed, and priced at its real multiplier.

const fast = (f: Partial<NonNullable<Settings['fastMode']>> = {}): Pick<Settings, 'fastMode'> => ({ fastMode: { ...DEFAULT_FAST, ...f, providers: { ...DEFAULT_FAST.providers, ...f.providers }, models: { ...f.models } } })
const req = (over: Partial<ChatRequest>): ChatRequest => ({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }], sampling: { temperature: 0.7, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }, maxTokens: 1000, ...over })

afterEach(() => { fastHooks.resolve = undefined })

describe('which models have a fast tier, and at what price', () => {
  test('Anthropic: Fable / Mythos 5.2 and Opus 5.5 at 2x; Opus 5 and 4.8 need the beta header', () => {
    expect(fastSupport('claude-opus-5-5')).toMatchObject({ provider: 'anthropic', factor: 2 })
    expect(fastSupport('claude-fable-5-2')?.factor).toBe(2)
    expect(fastSupport('claude-mythos-5-2')?.factor).toBe(2)
    expect(fastSupport('claude-opus-5')).toMatchObject({ beta: true })
    expect(fastSupport('claude-opus-4-8')).toMatchObject({ beta: true })
    expect(fastSupport('claude-sonnet-5-5')).toBeUndefined()
    expect(fastSupport('claude-haiku-5-5')).toBeUndefined()
    // Fast price = 2x standard (Opus 5.5 $8 / $40 against $4 / $20).
    expect(priceFor('claude-opus-5-5').input * fastFactor('claude-opus-5-5', 'fast')).toBe(8)
  })
  test('OpenAI: Fast 2x on most (gpt-5.5 2.5x, older 1.67-1.8x); Ultrafast 6x on GPT-6 Astra and 6.1 Sol', () => {
    expect(fastSupport('gpt-6-astra')).toMatchObject({ provider: 'openai', factor: 2, ultrafast: 6 })
    expect(fastSupport('gpt-6.1-sol')).toMatchObject({ factor: 2, ultrafast: 6 })
    expect(fastSupport('gpt-6.1-terra')?.ultrafast).toBeUndefined()
    expect(fastSupport('gpt-5.5')?.factor).toBe(2.5)
    expect(fastSupport('gpt-4o')?.factor).toBe(1.7)
    expect(fastSupport('gpt-5.4-nano')).toBeUndefined()
    expect(fastFactor('gpt-6-astra', 'ultrafast')).toBe(6)
    expect(fastFactor('gpt-6.1-terra', 'ultrafast')).toBe(2)
    expect(priceFor('gpt-6-astra').output * fastFactor('gpt-6-astra', 'ultrafast')).toBe(300)
    expect(fastSupport('gpt-6.1-sol-2026-09-29')?.id).toBe('gpt-6.1-sol')
  })
  test('xAI: priority at 2x on the chat models; never on local or plan models', () => {
    expect(fastSupport('grok-4.7')).toMatchObject({ provider: 'xai', factor: 2 })
    expect(fastSupport('grok-4.20-multi-agent-0309')).toBeUndefined()
    expect(fastSupport('qwen3.8:27b')).toBeUndefined()
    expect(fastSupport('chatgpt-plan/gpt-6.1-sol')).toBeUndefined()
    expect(fastFactor('grok-4.7', 'standard')).toBe(1)
    expect(fastTradeoff('claude-opus-5-5')).toMatch(/Fast · up to 2\.5x faster output · 2x price \(\$8 \/ \$40 per M\)/)
    expect(fastTradeoff('gpt-6-astra')).toMatch(/Ultrafast · OpenAI’s fastest tier · 6x price \(\$60 \/ \$300 per M\)/)
  })
})

// The day before, the last minute of, and the first minute after GPT-6.2 Ultrafast's introductory price (Pacific time).
const NOV_18 = Date.UTC(2026, 10, 18, 12)
const FEB_28_LAST = Date.UTC(2027, 2, 1, 7, 59) // 23:59 PST on Feb 28, 2027
const MAR_1 = Date.UTC(2027, 2, 1, 8) // 00:00 PST on Mar 1, 2027

describe('GPT-6.2 Astra and Sol: Fast 2x; Ultrafast 3x through Feb 28, 2027 (Pacific), then 6x', () => {
  test('support and multipliers, with the date switch', () => {
    for (const id of ['gpt-6.2-astra', 'gpt-6.2-sol']) {
      expect(fastSupport(id, NOV_18)).toMatchObject({ provider: 'openai', id, factor: 2, ultrafast: 3, ultrafastSchedule: GPT62_ULTRAFAST })
      expect(fastFactor(id, 'fast', NOV_18)).toBe(2)
      expect(fastFactor(id, 'ultrafast', NOV_18)).toBe(3)
      expect(fastFactor(id, 'ultrafast', FEB_28_LAST)).toBe(3)
      expect(fastFactor(id, 'ultrafast', MAR_1)).toBe(6)
      expect(fastFactor(id, 'standard', MAR_1)).toBe(1)
    }
    expect(fastSupport('gpt-6.2-sol-2026-11-17', NOV_18)?.id).toBe('gpt-6.2-sol')
    // The older Ultrafast models stay at 6x whatever the date.
    expect(fastFactor('gpt-6-astra', 'ultrafast', NOV_18)).toBe(6)
    expect(fastFactor('gpt-6.1-sol', 'ultrafast', MAR_1)).toBe(6)
    // In dollars (pricing page Ultrafast table): Astra $24 / $120 promo, $48 / $240 list; Sol $6 / $30, $12 / $60.
    expect(priceFor('gpt-6.2-astra').input * fastFactor('gpt-6.2-astra', 'ultrafast', NOV_18)).toBe(24)
    expect(priceFor('gpt-6.2-astra').output * fastFactor('gpt-6.2-astra', 'ultrafast', MAR_1)).toBe(240)
    expect(priceFor('gpt-6.2-sol').output * fastFactor('gpt-6.2-sol', 'ultrafast', NOV_18)).toBe(30)
    expect(priceFor('gpt-6.2-sol').input * fastFactor('gpt-6.2-sol', 'fast', NOV_18)).toBe(4)
  })
  test('the per-model speed choices spell out each penalty', () => {
    const astra = speedOptions('gpt-6.2-astra', NOV_18)!
    expect(astra.map((o) => o.tier)).toEqual(['standard', 'fast', 'ultrafast'])
    expect(astra.map((o) => o.line)).toEqual([
      'Standard · normal speed · 1x price ($8 / $40 per M)',
      'Fast · up to 2.5x faster · 2x price ($16 / $80 per M)',
      'Ultrafast · up to 4.5x faster · 3x price ($24 / $120 per M) until Feb 28, 2027, then 6x ($48 / $240)'
    ])
    expect(astra[1].tradeoffs).toEqual(['Counts against the same rate limits as Standard', 'OpenAI may downgrade it to standard speed, billed at the standard price'])
    expect(astra[2]).toMatchObject({ factor: 3, until: '2027-02-28', then: 6, tradeoffs: ['Separate rate limits from Standard and Fast', 'Responses API only', 'US data residency only'] })
    expect(speedOptions('gpt-6.2-sol', NOV_18)![2].line).toBe('Ultrafast · up to 4.5x faster · 3x price ($6 / $30 per M) until Feb 28, 2027, then 6x ($12 / $60)')
    // From March 1, 2027 the line is the list price alone.
    const later = speedOptions('gpt-6.2-astra', MAR_1)![2]
    expect(later.line).toBe('Ultrafast · up to 4.5x faster · 6x price ($48 / $240 per M)')
    expect(later.until).toBeUndefined()
    // GPT-6 Astra / 6.1 Sol: 6x, no OpenAI speed figure; GPT-6.1 Sol's Ultrafast also runs in the EU.
    expect(speedOptions('gpt-6-astra', NOV_18)![2].line).toBe('Ultrafast · OpenAI’s fastest tier · 6x price ($60 / $300 per M)')
    expect(speedOptions('gpt-6.1-sol', NOV_18)![2].tradeoffs).not.toContain('US data residency only')
    // No Ultrafast where OpenAI doesn't offer it.
    expect(speedOptions('gpt-6.1-terra', NOV_18)!.map((o) => o.tier)).toEqual(['standard', 'fast'])
    expect(speedOptions('gpt-6.1-terra', NOV_18)![1].line).toBe('Fast · up to 2.5x faster · 2x price ($2 / $10 per M)')
    // Claude: Fast only, with its own rate limit and no Batch API; Mythos 5.2 at the pricing page's $8 / $40.
    const opus = speedOptions('claude-opus-5-5', NOV_18)!
    expect(opus.map((o) => o.line)).toEqual(['Standard · normal speed · 1x price ($4 / $20 per M)', 'Fast · up to 2.5x faster output · 2x price ($8 / $40 per M)'])
    expect(opus[1].tradeoffs.join(' · ')).toMatch(/own rate limit.*standard speed and price.*Not with the Batch API/)
    expect(speedOptions('claude-mythos-5-2', NOV_18)![1].line).toBe('Fast · up to 2.5x faster output · 2x price ($16 / $80 per M)')
    expect(speedOptions('claude-opus-4-8', NOV_18)![1].tradeoffs.join(' ')).toMatch(/Nov 30, 2026/)
    // xAI: Priority; none for models without a faster tier.
    expect(speedOptions('grok-4.7', NOV_18)![1]).toMatchObject({ title: 'Priority', factor: 2 })
    expect(speedOptions('claude-sonnet-5-5', NOV_18)).toBeUndefined()
    expect(speedOptions('qwen3.8:27b', NOV_18)).toBeUndefined()
    // The Models page's one line carries the same penalty text.
    expect(fastTradeoff('gpt-6.2-astra', NOV_18)).toContain('Ultrafast · up to 4.5x faster · 3x price ($24 / $120 per M) until Feb 28, 2027, then 6x ($48 / $240)')
  })
  test('Ultrafast only where chosen for that model: the OpenAI switch alone gives Fast, and Auto never turns either on', () => {
    expect(fastTierFor('gpt-6.2-astra', {})).toBeUndefined()
    expect(fastTierFor('gpt-6.2-astra', fast({ providers: { anthropic: false, openai: true, xai: false } }))).toBe('fast')
    const chosen = fast({ models: { 'gpt-6.2-sol': 'ultrafast' } })
    expect(fastTierFor('gpt-6.2-sol', chosen)).toBe('ultrafast')
    expect(fastTierFor('gpt-6.2-astra', chosen)).toBeUndefined()
    // Auto, default rule: only for speed-sensitive requests, and only on what the user allowed.
    expect(fastTierFor('gpt-6.2-sol', chosen, { auto: true })).toBeUndefined()
    expect(fastTierFor('gpt-6.2-sol', chosen, { auto: true, speedSensitive: true })).toBe('ultrafast')
    expect(fastTierFor('gpt-6.2-astra', fast({ auto: 'allowed' }), { auto: true, speedSensitive: true })).toBeUndefined()
    expect(fastTierFor('gpt-6.2-sol', fast({ ...chosen.fastMode, auto: 'never' }), { auto: true, speedSensitive: true })).toBeUndefined()
    // Standard chosen for the model wins over the provider switch.
    expect(fastTierFor('gpt-6.2-sol', fast({ providers: { anthropic: false, openai: true, xai: false }, models: { 'gpt-6.2-sol': 'off' } }))).toBeUndefined()
  })
  test('service_tier "ultrafast" only on the Responses API; Chat Completions gets "fast" at most; Claude never gets a service_tier', () => {
    expect(buildResponsesRequest(req({ model: 'gpt-6.2-astra', fast: 'ultrafast' })).body.service_tier).toBe('ultrafast')
    expect(buildResponsesRequest(req({ model: 'gpt-6.2-sol', fast: 'ultrafast' })).body.service_tier).toBe('ultrafast')
    expect(buildResponsesRequest(req({ model: 'gpt-6.2-sol', fast: 'fast' })).body.service_tier).toBe('fast')
    expect(buildResponsesRequest(req({ model: 'gpt-6.2-sol' })).body).not.toHaveProperty('service_tier')
    expect(buildResponsesRequest(req({ model: 'gpt-6.2-sol', fast: null })).body).not.toHaveProperty('service_tier')
    // Chat Completions (a GPT id on another OpenAI-compatible path): never "ultrafast".
    for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', 'gpt-4o']) {
      expect(buildBody(req({ model, fast: 'ultrafast' })).service_tier).toBe('fast')
      expect(buildBody(req({ model }))).not.toHaveProperty('service_tier')
    }
    const claude = buildClaudeRequest({ ...req({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' }), fast: 'ultrafast' }).params
    expect(claude).not.toHaveProperty('service_tier')
    expect(claude.speed).toBe('fast')
  })
})

describe('the toggles', () => {
  test('off by default, everywhere', () => {
    expect(fastSettings(undefined)).toEqual(DEFAULT_FAST)
    for (const m of ['claude-opus-5-5', 'gpt-6.1-sol', 'grok-4.7']) expect(fastTierFor(m, {})).toBeUndefined()
  })
  test('a provider switch turns on its models; a model override wins either way', () => {
    const s = fast({ providers: { anthropic: true, openai: false, xai: false }, models: { 'gpt-6.1-sol': 'on', 'claude-fable-5-2': 'off' } })
    expect(fastTierFor('claude-opus-5-5', s)).toBe('fast')
    expect(fastTierFor('claude-fable-5-2', s)).toBeUndefined()
    expect(fastTierFor('gpt-6.1-sol', s)).toBe('fast')
    expect(fastTierFor('gpt-6-astra', s)).toBeUndefined()
    expect(fastChoice('claude-fable-5-2', s)).toBe('off')
    expect(fastChoice('claude-opus-5-5', s)).toBe('inherit')
  })
  test('Ultrafast only where chosen and offered', () => {
    const s = fast({ providers: { anthropic: false, openai: true, xai: false }, models: { 'gpt-6-astra': 'ultrafast', 'gpt-6.1-terra': 'ultrafast' } })
    expect(fastTierFor('gpt-6-astra', s)).toBe('ultrafast')
    expect(fastTierFor('gpt-6.1-terra', s)).toBe('fast')
    expect(fastTierFor('gpt-6.1-sol', s)).toBe('fast')
  })
  test('Auto respects the toggles and its own rule (default: only where speed matters)', () => {
    const on = fast({ providers: { anthropic: true, openai: true, xai: true } })
    expect(fastTierFor('claude-opus-5-5', on, { auto: true })).toBeUndefined()
    expect(fastTierFor('claude-opus-5-5', on, { auto: true, speedSensitive: true })).toBe('fast')
    expect(fastTierFor('claude-opus-5-5', fast({ ...on.fastMode, auto: 'allowed' }), { auto: true })).toBe('fast')
    expect(fastTierFor('claude-opus-5-5', fast({ ...on.fastMode, auto: 'never' }), { auto: true, speedSensitive: true })).toBeUndefined()
    // Not allowed at all: Auto never turns it on, whatever the request.
    expect(fastTierFor('claude-opus-5-5', fast({ auto: 'allowed' }), { auto: true, speedSensitive: true })).toBeUndefined()
  })
})

describe('requests and pricing', () => {
  test('Claude: speed "fast"; the beta header only on Opus 5 / 4.8; nothing on models without it', () => {
    const a = buildClaudeRequest({ ...req({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' }), fast: 'fast' }).params
    expect(a.speed).toBe('fast')
    expect((a.betas as string[] | undefined) ?? []).not.toContain(BETA.fast)
    const b = buildClaudeRequest({ ...req({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5' }), fast: 'fast' }).params
    expect(b.betas).toContain(BETA.fast)
    expect(buildClaudeRequest({ ...req({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5' }), fast: 'fast' }).params).not.toHaveProperty('speed')
    expect(buildClaudeRequest(req({ baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5' })).params).not.toHaveProperty('speed')
  })
  test('OpenAI: service_tier fast / ultrafast on Responses; fast on Chat Completions; the served tier is read back', () => {
    expect(buildResponsesRequest(req({ fast: 'fast' })).body.service_tier).toBe('fast')
    expect(buildResponsesRequest(req({ model: 'gpt-6-astra', fast: 'ultrafast' })).body.service_tier).toBe('ultrafast')
    expect(buildResponsesRequest(req({}))).not.toHaveProperty('body.service_tier')
    expect(openaiServiceTier({ model: 'gpt-6.1-terra', fast: 'ultrafast' })).toBe('fast')
    expect(buildBody(req({ model: 'gpt-4o', fast: 'fast' })).service_tier).toBe('fast')
    expect(buildBody(req({ model: 'gpt-4o' }))).not.toHaveProperty('service_tier')
    expect(servedTier('priority')).toBe('fast')
    expect(servedTier('default')).toBe('standard')
    expect(servedTier('ultrafast')).toBe('ultrafast')
  })
  test('the per-step cost chip prices the tier the chat runs at', () => {
    const std = stepCost('claude-opus-5-5', 50_000, { fast: null })
    expect(stepCost('claude-opus-5-5', 50_000, { fast: 'fast' }).usd).toBeCloseTo(std.usd * 2, 9)
    fastHooks.resolve = (m) => (m === 'gpt-6-astra' ? 'ultrafast' : undefined)
    expect(currentFastTier('gpt-6-astra')).toBe('ultrafast')
    const s = stepCost('gpt-6-astra', 50_000)
    expect(s.fast).toBe('ultrafast')
    expect(s.usd).toBeCloseTo(stepCost('gpt-6-astra', 50_000, { fast: null }).usd * 6, 9)
    expect(stepCost('claude-opus-5-5', 50_000)).not.toHaveProperty('fast')
  })
})

describe('Claude fast mode against a fake Messages API', () => {
  test('usage.speed "fast" is billed at 2x; over the fast limit it falls back to standard speed and price', async () => {
    const { createServer } = await import('node:http')
    const client = await import('../../src/main/llm/client')
    const { cost } = await import('../../src/main/llm/budget')
    const bodies: Array<Record<string, unknown>> = []
    const plan: Array<'fast' | 'limit' | 'standard'> = []
    const server = createServer((rq, rs) => {
      let raw = ''
      rq.on('data', (c) => (raw += c))
      rq.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        bodies.push(body)
        const step = plan.shift() ?? 'standard'
        if (step === 'limit') { rs.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' }); rs.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'fast mode rate limit' } })); return }
        const speed = step === 'fast' ? 'fast' : 'standard'
        const ev = (type: string, data: Record<string, unknown>): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
        rs.writeHead(200, { 'content-type': 'text/event-stream' })
        rs.write(ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed } } }))
        rs.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
        rs.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }))
        rs.write(ev('content_block_stop', { index: 0 }))
        rs.write(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100, input_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed } }))
        rs.write(ev('message_stop', {}))
        rs.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const prev = { url: process.env.ANTHROPIC_BASE_URL, paid: process.env.FOREMAN_FORCE_PAID }
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    process.env.FOREMAN_FORCE_PAID = '1'
    const recorded: Array<{ usd: number; tier?: string }> = []
    client.spendHooks.after = (r, input, output, model) => recorded.push({ usd: cost(model, input, output), tier: client.usageDetails.get(r)?.tier })
    try {
      const r = (): ChatRequest => req({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-api-test', model: 'claude-opus-5-5', fast: 'fast' })
      const run = async (): Promise<void> => { for await (const _ of client.streamChat(r())) { /* drain */ } }
      plan.push('fast')
      await run()
      plan.push('limit', 'standard')
      await run()
      expect(bodies.map((b) => b.speed)).toEqual(['fast', 'fast', undefined])
      const std = (1000 * 4 + 100 * 20) / 1e6
      expect(recorded[0].usd).toBeCloseTo(std * 2, 9)
      expect(recorded[0].tier).toBe('fast')
      expect(recorded[1].usd).toBeCloseTo(std, 9)
      expect(recorded[1].tier).toBe('standard')
    } finally {
      client.spendHooks.after = undefined
      if (prev.url === undefined) delete process.env.ANTHROPIC_BASE_URL; else process.env.ANTHROPIC_BASE_URL = prev.url
      if (prev.paid === undefined) delete process.env.FOREMAN_FORCE_PAID; else process.env.FOREMAN_FORCE_PAID = prev.paid
      server.close()
    }
  })
})

describe('OpenAI Ultrafast against a fake Responses API: the tier that ran is recorded and priced', () => {
  test('"ultrafast" is billed at 3x (6x from Mar 1, 2027); a downgrade ("default") at the standard price', async () => {
    const { createServer } = await import('node:http')
    const client = await import('../../src/main/llm/client')
    const { cost } = await import('../../src/main/llm/budget')
    const bodies: Array<Record<string, unknown>> = []
    const served: string[] = []
    const server = createServer((rq, rs) => {
      let raw = ''
      rq.on('data', (c) => (raw += c))
      rq.on('end', () => {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        bodies.push(body)
        const tier = served.shift() ?? 'default'
        if (tier === 'reject') { rs.writeHead(400, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ error: { message: 'Ultrafast is not available for this organization.', type: 'invalid_request_error', param: 'service_tier', code: null } })); return }
        const response = { id: 'resp_1', object: 'response', status: 'completed', model: body.model, service_tier: tier, output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }], usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } }
        rs.writeHead(200, { 'content-type': 'text/event-stream' })
        rs.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`)
        rs.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/v1`
    const prev = { url: process.env.FOREMAN_OPENAI_URL, paid: process.env.FOREMAN_FORCE_PAID }
    process.env.FOREMAN_OPENAI_URL = base
    process.env.FOREMAN_FORCE_PAID = '1'
    const recorded: Array<{ usd: number; tier?: string }> = []
    client.spendHooks.after = (r, input, output, model) => recorded.push({ usd: cost(model, input, output), tier: client.usageDetails.get(r)?.tier })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const run = async (): Promise<void> => { for await (const _ of client.streamChat(req({ baseUrl: base, apiKey: 'sk-test', model: 'gpt-6.2-sol', fast: 'ultrafast' }))) { /* drain */ } }
      const std = (1000 * 2 + 100 * 10) / 1e6
      vi.setSystemTime(NOV_18)
      served.push('ultrafast'); await run()
      served.push('default'); await run()
      vi.setSystemTime(MAR_1)
      served.push('ultrafast'); await run()
      expect(bodies.map((b) => b.service_tier)).toEqual(['ultrafast', 'ultrafast', 'ultrafast'])
      expect(recorded.map((r) => r.tier)).toEqual(['ultrafast', 'standard', 'ultrafast'])
      expect(recorded[0].usd).toBeCloseTo(std * 3, 9)
      expect(recorded[1].usd).toBeCloseTo(std, 9)
      expect(recorded[2].usd).toBeCloseTo(std * 6, 9)
      // Ultrafast refused for this account: resent without service_tier, recorded and billed at standard.
      served.push('reject', 'default'); await run()
      expect(bodies.slice(3).map((b) => b.service_tier)).toEqual(['ultrafast', undefined])
      expect(recorded[3]).toMatchObject({ tier: 'standard' })
      expect(recorded[3].usd).toBeCloseTo(std, 9)
    } finally {
      resetResponsesState()
      vi.useRealTimers()
      client.spendHooks.after = undefined
      if (prev.url === undefined) delete process.env.FOREMAN_OPENAI_URL; else process.env.FOREMAN_OPENAI_URL = prev.url
      if (prev.paid === undefined) delete process.env.FOREMAN_FORCE_PAID; else process.env.FOREMAN_FORCE_PAID = prev.paid
      server.close()
    }
  })
})
