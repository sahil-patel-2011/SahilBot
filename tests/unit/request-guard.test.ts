import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import type { ChatRequest, StreamPart } from '../../src/main/llm/client'
import { retryInfo } from '../../src/main/llm/retry'
import { failureKind } from '../../src/main/llm/model-health'
import { RequestGuard, requestLimits } from '../../src/main/llm/request-guard'
import { SEARCH_MAX_USES } from '../../src/main/llm/claude-native/server'

// One model request that runs server-side tools is bounded: a search budget for the whole turn across Claude's
// pause_turn continuations, an idle limit (nothing streamed), a wall-clock limit for the request, and (OpenAI) a cap
// on built-in tool calls when max_tool_calls can't be sent. Against local stand-ins for both APIs.

type Scenario = 'pause' | 'stall' | 'slow' | 'searches'
let scenario: Scenario = 'pause'
let hits = 0
let server: Server
let BASE = ''
const sse = (res: ServerResponse, ev: Record<string, unknown>): void => { if (!res.destroyed) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`) }

/** Messages API: each request one search round that pauses (pause_turn), or a stream that stalls / never ends. */
function claude(res: ServerResponse, n: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  sse(res, { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } })
  if (scenario === 'stall') return
  if (scenario === 'slow') {
    sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    const t = setInterval(() => { if (res.destroyed) clearInterval(t); else sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'still working… ' } }) }, 60)
    res.on('close', () => clearInterval(t))
    return
  }
  // pause: a text block, a finished search, then a search the server paused before answering.
  let i = 0
  sse(res, { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
  sse(res, { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: `Round ${n}. ` } })
  sse(res, { type: 'content_block_stop', index: i++ })
  sse(res, { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: `srvtoolu_${n}a`, name: 'web_search', input: { query: `q${n}` } } })
  sse(res, { type: 'content_block_stop', index: i++ })
  sse(res, { type: 'content_block_start', index: i, content_block: { type: 'web_search_tool_result', tool_use_id: `srvtoolu_${n}a`, content: [{ type: 'web_search_result', url: `https://example.com/${n}`, title: `Result ${n}`, encrypted_content: 'enc', page_age: null }] } })
  sse(res, { type: 'content_block_stop', index: i++ })
  sse(res, { type: 'content_block_start', index: i, content_block: { type: 'server_tool_use', id: `srvtoolu_${n}b`, name: 'web_search', input: { query: `q${n} more` } } })
  sse(res, { type: 'content_block_stop', index: i++ })
  sse(res, { type: 'message_delta', delta: { stop_reason: 'pause_turn', stop_sequence: null }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: SEARCH_MAX_USES } } })
  sse(res, { type: 'message_stop' })
  res.end()
}

/** Responses API: a stream that stalls, or one that runs far more built-in searches than allowed. */
function openai(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  sse(res, { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } })
  if (scenario === 'stall') return
  let k = 0
  const t = setInterval(() => {
    if (res.destroyed || k >= 40) { clearInterval(t); return }
    sse(res, { type: 'response.output_item.added', output_index: k, item: { id: `ws_${k}`, type: 'web_search_call', status: 'in_progress' } })
    k++
  }, 5)
  res.on('close', () => clearInterval(t))
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      hits++
      if (req.url?.startsWith('/v1/messages')) return claude(res, hits)
      if (req.url?.endsWith('/responses')) return openai(res)
      res.writeHead(404); res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.ANTHROPIC_BASE_URL = BASE
})
afterAll(() => { server.closeAllConnections(); server.close(); delete process.env.ANTHROPIC_BASE_URL })
const saved = { ...requestLimits }
afterEach(() => { Object.assign(requestLimits, saved); hits = 0 })

const { streamAnthropic } = await import('../../src/main/llm/anthropic')
const { streamResponses, resetResponsesState } = await import('../../src/main/llm/openai-responses')
const claudeReq = (over: Partial<ChatRequest> = {}): ChatRequest => ({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant-api-guard-test', model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'Research heat pumps for a cold climate' }], sampling: { temperature: 1, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 } as never, maxTokens: 2000, ...over })
const gptReq = (): ChatRequest => ({ baseUrl: `${BASE}/v1`, apiKey: 'sk-test', model: 'gpt-6.2-sol', messages: [{ role: 'user', content: 'Research heat pumps' }], sampling: { temperature: 1, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 } as never, maxTokens: 2000 })
async function collect(s: AsyncIterable<StreamPart>): Promise<StreamPart[]> { const out: StreamPart[] = []; for await (const p of s) out.push(p); return out }
async function failure(s: AsyncIterable<StreamPart>): Promise<Error & { requestCap?: string }> { try { await collect(s) } catch (e) { return e as Error & { requestCap?: string } } throw new Error('expected the request to stop') }

describe('Claude: server tools across pause_turn', () => {
  test('a paused search turn goes on only within the turn\'s search budget, then ends with what it found', async () => {
    scenario = 'pause'
    const parts = await collect(streamAnthropic(claudeReq()))
    // 8 searches per request: 3 requests make 24, the turn's budget (before: 5 requests, 40 searches).
    expect(hits).toBe(requestLimits.turnSearches / SEARCH_MAX_USES)
    const text = parts.filter((p) => p.type === 'content').map((p) => (p as { text: string }).text).join('')
    expect(text).toContain('Round 1.')
    expect(text).toContain('Round 3.')
    expect(text).toMatch(/Stopped searching here: this reply used 24 web searches, its limit for one reply/)
    expect(parts.find((p) => p.type === 'finish')).toMatchObject({ reason: 'end_turn' })
    expect(parts.find((p) => p.type === 'usage')).toMatchObject({ webCalls: 24 })
    // The stored turn replays cleanly: no server search left waiting for its result.
    const raw = parts.find((p) => p.type === 'raw') as { content: Array<{ type: string; id?: string; tool_use_id?: string }> }
    const answered = new Set(raw.content.map((b) => b.tool_use_id).filter(Boolean))
    expect(raw.content.filter((b) => b.type === 'server_tool_use' && !answered.has(b.id))).toEqual([])
  })

  test('a stream that goes quiet is stopped at the idle limit, with a clear message, and not retried', async () => {
    scenario = 'stall'
    requestLimits.idleMs = 300
    const t0 = Date.now()
    const e = await failure(streamAnthropic(claudeReq()))
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(e.requestCap).toBe('idle')
    expect(e.message).toMatch(/^Stopped this request: claude-opus-5-5 sent nothing for \d+ seconds, so the connection looks stuck/)
    expect(retryInfo(e).retry).toBe(false)
    expect(hits).toBe(1)
  })

  test('one request that streams on and on is stopped at the wall-clock limit', async () => {
    scenario = 'slow'
    requestLimits.wallMs = 700
    const t0 = Date.now()
    const e = await failure(streamAnthropic(claudeReq()))
    expect(Date.now() - t0).toBeGreaterThanOrEqual(650)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(e.requestCap).toBe('wall')
    expect(e.message).toMatch(/^Stopped this request after \d+ seconds: claude-opus-5-5 was still working on a single reply/)
    // Not a model failure: no retry, no cooldown, no hand-off to another model.
    expect(retryInfo(e).retry).toBe(false)
    expect(failureKind(e)).toBe('other')
    expect(hits).toBe(1)
  })

  test('the user\'s Stop still stops it at once (not reported as a limit)', async () => {
    scenario = 'slow'
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 150)
    const e = await failure(streamAnthropic(claudeReq({ signal: ctrl.signal })))
    expect(e.requestCap).toBeUndefined()
  })
})

describe('OpenAI Responses: built-in tools and limits', () => {
  test('past the built-in tool call cap (max_tool_calls not sent), the request stops', async () => {
    resetResponsesState()
    scenario = 'searches'
    const e = await failure(streamResponses(gptReq()))
    expect(e.requestCap).toBe('searches')
    expect(e.message).toMatch(new RegExp(`ran ${requestLimits.openaiServerCalls + 1} web searches in one reply, over the limit of ${requestLimits.openaiServerCalls}`))
    expect(retryInfo(e).retry).toBe(false)
  })

  test('a quiet stream is stopped at the idle limit', async () => {
    resetResponsesState()
    scenario = 'stall'
    requestLimits.idleMs = 300
    const e = await failure(streamResponses(gptReq()))
    expect(e.requestCap).toBe('idle')
    expect(e.message).toMatch(/gpt-6\.2-sol \(with web search\) sent nothing for/)
  })
})

describe('the guard itself', () => {
  test('touch() keeps it alive, the wall clock does not move, done() clears the timers', async () => {
    const g = new RequestGuard(undefined, { idleMs: 80, wallMs: 400 })
    const keep = setInterval(() => g.touch(), 20)
    await new Promise((r) => setTimeout(r, 250))
    expect(g.signal.aborted).toBe(false)
    await new Promise((r) => setTimeout(r, 250))
    clearInterval(keep)
    expect(g.stopped).toBe('wall')
    g.done()
    const quiet = new RequestGuard(undefined, { idleMs: 50, wallMs: 10_000 })
    await new Promise((r) => setTimeout(r, 120))
    expect(quiet.stopped).toBe('idle')
    quiet.done()
  })
})
