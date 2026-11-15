import type { Sampling, ToolCall } from '@shared/types'
import { lookup } from './catalog'
import { isAnthropic } from './providers'
import { claudeMaxTokens, fallbacks, listAnthropicModels, streamAnthropic } from './anthropic'
import { streamResponses } from './openai-responses'
import { openaiEffort, openaiInfo, openaiMaxTokens, usesResponses } from './openai-models'
import { tierTokens } from './budget'
import { httpError, retryInfo, withRetries } from './retry'
import { timer } from './timing'
import { toolTurnSampling, withToolPrimer } from './local-tools'

export { backoffMs, httpError, parseRetryAfter, retryAfterFrom, retryInfo, retryPolicy, withRetries } from './retry'

// Minimal OpenAI-compatible client over fetch. Works with Ollama, llama.cpp
// server, LM Studio, vLLM and hosted OpenAI-style APIs.

export type WireContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: WireContent | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
  name?: string
  /** Provider-native content for this turn (Claude's blocks), sent back unchanged when the model matches. */
  raw?: unknown
  /** A user turn carrying the images a tool returned (so Claude can put them back in that tool_result). */
  imagesFor?: string
}

export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatRequest {
  baseUrl: string
  apiKey?: string
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  sampling: Sampling
  maxTokens: number
  contextWindow?: number
  signal?: AbortSignal
  /** How hard to think (Claude effort; 'low' turns thinking off on local thinking models). */
  effort?: import('@shared/types').Effort
  /** Ollama: how long the model stays loaded after this request (default localDefaults.keepAlive). */
  keepAlive?: string
  /** Claude: offer SahilBot's tools as Claude's native tool types (llm/claude-native); web = server web tools. */
  native?: { enabled: boolean; web?: boolean }
  /** Claude: prompt-cache lifetime ('1h' for long agent runs and team helpers, where gaps pass 5 minutes). */
  cacheTtl?: '5m' | '1h'
  /** Claude / OpenAI: server-side compaction starts at this many input tokens (undefined: no server compaction). */
  compactAt?: number
  /** OpenAI: prompt_cache_key (the chat), so its requests share a cache and are accounted together. */
  cacheKey?: string
}

/** Defaults for local servers. keepAlive follows the localKeepAlive setting (the agent passes it per request). */
export const localDefaults = { keepAlive: '30m' }

// ---------------------------------------------------------------------------
// Context size per loaded local model. Ollama reloads a model whenever num_ctx changes (seconds for a
// big model, and the prompt cache is lost), and a request without num_ctx gets the server default
// (often 4k, silently cutting the prompt from the front). So the agent pins the window it runs a model
// at, and every request to that model (summaries, titles, voice) reuses it unless it needs more.
// ---------------------------------------------------------------------------

const ctxPins = new Map<string, number>()
const pinKey = (baseUrl: string, model: string): string => `${trim(baseUrl).replace(/\/v1$/, '')}|${model}`

/** The agent's window for this model on this server (the main chat window, set every step). */
export function pinContextWindow(baseUrl: string, model: string, window: number): void {
  if (window > 0) ctxPins.set(pinKey(baseUrl, model), window)
}

export function contextPin(baseUrl: string, model: string): number | undefined {
  return ctxPins.get(pinKey(baseUrl, model))
}

export function clearContextPins(): void {
  ctxPins.clear()
}

/**
 * num_ctx to send: the pinned window when it's at least what this request needs (no reload), else
 * what it needs. A request that doesn't say borrows the pin (or leaves it to the server).
 */
export function numCtxFor(baseUrl: string, model: string, want?: number): number | undefined {
  const pin = contextPin(baseUrl, model)
  if (!want) return pin
  return pin && pin >= want ? pin : want
}

/** Hooks for paid (non-local) endpoints: `before` may throw to block a request; `after` records usage. */
export const spendHooks: {
  /** maxOutput is the real ceiling sent; pricedAs is the model to price the worst case at. */
  before?: (req: ChatRequest, estimatedInput: number, maxOutput: number, pricedAs: string) => void
  /** servedModel is the model that actually answered (a refusal fallback can differ). */
  after?: (req: ChatRequest, input: number, output: number, servedModel: string) => void
} = {}

export type StreamPart =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  /**
   * Token usage in billing terms (cache reads and writes weighted at the model's standard input rate).
   * prompt: the real prompt size, which picks the price tier (long-context rates); extraUsd: tool fees.
   * paidAttempt turns these into the tokens the budget records (budget.tierTokens).
   */
  | { type: 'usage'; promptTokens: number; completionTokens: number; prompt?: number; extraUsd?: number; cachedTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
  | { type: 'finish'; reason: string }
  /** Provider-native output to replay unchanged (Claude's content blocks, OpenAI's Responses output items). */
  | { type: 'raw'; provider: 'anthropic' | 'openai'; model: string; content: unknown; compacted?: boolean }
  /** Claude's server tools ran inside the request: sources found and read, and the outside text they brought in. */
  | { type: 'server_tools'; found: Array<{ title: string; url: string }>; read: Array<{ title: string; url: string }>; untrusted: string[]; searches: number; fetches: number; errors: string[] }
  /** A tool call has started streaming: its name is known, its arguments aren't yet. */
  | { type: 'tool_pending'; name: string }
  /** The provider re-issued the turn: discard the text and reasoning streamed so far. */
  | { type: 'reset' }

export function isLocal(baseUrl: string): boolean {
  // Tests stand in a local mock for a paid cloud endpoint.
  if (process.env.FOREMAN_FORCE_PAID === '1') return false
  try {
    const h = new URL(baseUrl).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local')
  } catch {
    return false
  }
}

function headers(apiKey: string | undefined, baseUrl: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) h.authorization = `Bearer ${apiKey}`
  // Anthropic's OpenAI-compatible endpoint takes the Bearer key; its /models listing wants these.
  if (apiKey && isAnthropic(baseUrl)) {
    h['x-api-key'] = apiKey
    h['anthropic-version'] = '2023-06-01'
  }
  return h
}

const trim = (u: string): string => u.replace(/\/+$/, '')

export async function listModels(baseUrl: string, apiKey?: string, signal?: AbortSignal): Promise<string[]> {
  if (isAnthropic(baseUrl)) {
    if (!apiKey) throw new Error('Add your Anthropic API key in Settings to list Claude models.')
    return listAnthropicModels(apiKey)
  }
  const res = await fetch(`${trim(baseUrl)}/models`, { headers: headers(apiKey, baseUrl), signal })
  if (!res.ok) throw new Error(`GET /models -> ${res.status} ${await res.text().catch(() => '')}`.trim())
  const body = (await res.json()) as { data?: Array<{ id: string }> }
  return (body.data ?? []).map((m) => m.id).sort()
}

export function buildBody(req: ChatRequest): Record<string, unknown> {
  // Small local models with tools: a cooler temperature and a short tool-call primer (local-tools.ts).
  const local = isLocal(req.baseUrl)
  const tools = !!req.tools?.length
  const s = local ? toolTurnSampling(req.model, req.sampling, tools) : req.sampling
  const messages = local ? withToolPrimer(req.messages, req.model, tools) : req.messages
  const body: Record<string, unknown> = {
    model: req.model,
    // App-only fields stay home: strict servers reject unknown message keys.
    messages: messages.map(({ raw: _r, imagesFor: _i, ...m }) => m),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens
  }
  // Current Claude models reject custom sampling (temperature/top_p): leave them at the defaults.
  if (!isAnthropic(req.baseUrl)) {
    body.temperature = s.temperature
    body.top_p = s.top_p
  }
  if (s.presence_penalty) body.presence_penalty = s.presence_penalty
  // Non-standard knobs only go to local servers; hosted APIs reject unknown fields.
  if (isLocal(req.baseUrl)) {
    if (s.top_k) body.top_k = s.top_k
    if (s.min_p) body.min_p = s.min_p
    if (s.repeat_penalty && s.repeat_penalty !== 1) {
      body.repeat_penalty = s.repeat_penalty
      body.repetition_penalty = s.repeat_penalty
    }
    // Ollama honors options.num_ctx on its OpenAI route in recent versions; others ignore it.
    const numCtx = numCtxFor(req.baseUrl, req.model, req.contextWindow)
    if (numCtx) body.options = { num_ctx: numCtx }
    // llama.cpp: reuse the KV cache for the shared prefix (its default, but older builds need asking).
    body.cache_prompt = true
    // Quick replies skip thinking on local thinking models (Qwen3-style templates read enable_thinking).
    if (req.effort === 'low' && lookup(req.model)?.thinks) body.chat_template_kwargs = { enable_thinking: false, reasoning_effort: 'low' }
    // gpt-oss on LM Studio / llama.cpp: agent work at High or above asks for its high reasoning level.
    else if ((req.effort === 'high' || req.effort === 'xhigh' || req.effort === 'max') && /gpt-oss/i.test(req.model) && lookup(req.model)?.thinks) body.chat_template_kwargs = { reasoning_effort: 'high' }
  }
  if (req.tools?.length) {
    body.tools = req.tools
    body.tool_choice = 'auto'
  }
  // OpenAI reasoning models: the model's own effort values (openai-models.ts), never one it rejects; models
  // the table doesn't describe keep the coarse scale.
  if (req.effort && !isLocal(req.baseUrl) && openaiInfo(req.model)?.efforts) body.reasoning_effort = openaiEffort(req.model, req.effort)
  else if (req.effort && /^(gpt-5|o\d)/i.test(req.model) && !isLocal(req.baseUrl)) body.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort
  return body
}

/** Splits <think>…</think> out of streamed content, tolerating tags cut across chunks. */
export class ThinkSplitter {
  private inThink = false
  private buf = ''

  push(chunk: string): StreamPart[] {
    this.buf += chunk
    const out: StreamPart[] = []
    for (;;) {
      const tag = this.inThink ? '</think>' : '<think>'
      const i = this.buf.indexOf(tag)
      if (i >= 0) {
        this.emit(out, this.buf.slice(0, i))
        this.buf = this.buf.slice(i + tag.length)
        this.inThink = !this.inThink
        continue
      }
      // Hold back a possible partial tag at the end.
      let keep = 0
      for (let k = Math.min(tag.length - 1, this.buf.length); k > 0; k--) {
        if (tag.startsWith(this.buf.slice(-k))) {
          keep = k
          break
        }
      }
      this.emit(out, this.buf.slice(0, this.buf.length - keep))
      this.buf = this.buf.slice(this.buf.length - keep)
      return out
    }
  }

  flush(): StreamPart[] {
    const out: StreamPart[] = []
    this.emit(out, this.buf)
    this.buf = ''
    return out
  }

  private emit(out: StreamPart[], text: string): void {
    if (text) out.push({ type: this.inThink ? 'reasoning' : 'content', text })
  }
}

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
}

const ollamaCache = new Map<string, { yes: boolean; at: number }>()
/** A "no" is re-checked after this long: Ollama may simply not have been started yet. */
const OLLAMA_NO_TTL = 30_000

/** True when the endpoint is an Ollama server (it answers /api/version). Cached per base URL. */
export async function isOllama(baseUrl: string): Promise<boolean> {
  const key = trim(baseUrl)
  const hit = ollamaCache.get(key)
  if (hit && (hit.yes || Date.now() - hit.at < OLLAMA_NO_TTL)) return hit.yes
  let yes = false
  if (isLocal(baseUrl)) {
    try {
      const r = await fetch(`${key.replace(/\/v1$/, '')}/api/version`, { signal: AbortSignal.timeout(1500) })
      yes = r.ok && 'version' in ((await r.json()) as object)
    } catch {
      yes = false
    }
  }
  ollamaCache.set(key, { yes, at: Date.now() })
  return yes
}

/** OpenAI-style messages to Ollama's native format (images as bare base64, arguments as objects). */
export function toOllamaMessages(messages: WireMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role }
    if (typeof m.content === 'string' || m.content === null) out.content = m.content ?? ''
    else {
      out.content = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n')
      const imgs = m.content.filter((p) => p.type === 'image_url').map((p) => (p as { image_url: { url: string } }).image_url.url.replace(/^data:[^;]+;base64,/, ''))
      if (imgs.length) out.images = imgs
    }
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => {
        let args: unknown = {}
        try { args = JSON.parse(c.function.arguments || '{}') } catch { args = {} }
        return { function: { name: c.function.name, arguments: args } }
      })
    }
    if (m.role === 'tool' && m.name) out.tool_name = m.name
    return out
  })
}

/**
 * Ollama's /v1 route can't set the context size per request and silently truncates long prompts
 * from the front (where the system prompt lives). Its native /api/chat honors options.num_ctx.
 */
/** Ollama takes a duration string ("30m") or seconds as a number (negative: keep loaded). */
export function keepAliveValue(v: string): string | number {
  return /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim()
}

/** What the server reported about a request (Ollama's durations, llama.cpp's timings). */
export interface ServerStats {
  loadMs?: number
  promptEvalMs?: number
  promptEvalCount?: number
  /** llama.cpp: prompt tokens served from its cache. */
  cachedTokens?: number
  numCtx?: number
}

/**
 * Ollama's `think`: off for quick replies on thinking models (gpt-oss can't turn it off, only down);
 * agent work at High or above asks gpt-oss for its high level (other thinking models think by default).
 */
export function ollamaThink(model: string, effort?: ChatRequest['effort']): boolean | 'low' | 'high' | undefined {
  if (!lookup(model)?.thinks) return undefined
  if (effort === 'low') return /gpt-oss/i.test(model) ? 'low' : false
  if ((effort === 'high' || effort === 'xhigh' || effort === 'max') && /gpt-oss/i.test(model)) return 'high'
  return undefined
}

/** The request body for Ollama's native /api/chat. */
export function ollamaBody(req: ChatRequest): Record<string, unknown> {
  const tools = !!req.tools?.length
  const s = toolTurnSampling(req.model, req.sampling, tools)
  const options: Record<string, unknown> = { temperature: s.temperature, top_p: s.top_p, num_predict: req.maxTokens }
  const numCtx = numCtxFor(req.baseUrl, req.model, req.contextWindow)
  if (numCtx) options.num_ctx = numCtx
  if (s.top_k) options.top_k = s.top_k
  if (s.min_p) options.min_p = s.min_p
  if (s.repeat_penalty && s.repeat_penalty !== 1) options.repeat_penalty = s.repeat_penalty
  if (s.presence_penalty) options.presence_penalty = s.presence_penalty
  const think = ollamaThink(req.model, req.effort)
  return {
    model: req.model,
    messages: toOllamaMessages(withToolPrimer(req.messages, req.model, tools)),
    tools: req.tools?.length ? req.tools : undefined,
    stream: true,
    options,
    // Keep a chat model in memory between messages (Ollama's default is 5 minutes). Side models (titles)
    // that nothing pinned keep the server's default, so they don't sit in memory next to the chat model.
    ...(req.keepAlive || contextPin(req.baseUrl, req.model) ? { keep_alive: keepAliveValue(req.keepAlive || localDefaults.keepAlive) } : {}),
    // Quick chats skip thinking on models that think (only sent to those: others reject the flag).
    ...(think !== undefined ? { think } : {})
  }
}

async function* streamOllama(req: ChatRequest, stats: ServerStats = {}): AsyncGenerator<StreamPart> {
  const body = ollamaBody(req)
  stats.numCtx = (body.options as { num_ctx?: number }).num_ctx
  const res = await fetch(`${trim(req.baseUrl).replace(/\/v1$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok || !res.body) throw httpError(`Ollama returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`, res.status, res.headers)
  const splitter = new ThinkSplitter()
  const calls: ToolCall[] = []
  const decoder = new TextDecoder()
  let pending = ''
  let finish = 'stop'
  const handle = function* (line: string): Generator<StreamPart> {
    if (!line.trim()) return
    const j = JSON.parse(line) as {
      message?: { content?: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: unknown } }> }
      done?: boolean; done_reason?: string; prompt_eval_count?: number; eval_count?: number; error?: string
      load_duration?: number; prompt_eval_duration?: number
    }
    if (j.error) throw new Error(j.error)
    if (j.message?.thinking) yield { type: 'reasoning', text: j.message.thinking }
    if (j.message?.content) yield* splitter.push(j.message.content)
    for (const c of j.message?.tool_calls ?? []) {
      calls.push({ id: `call_${calls.length}`, name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) })
    }
    if (j.done) {
      finish = j.done_reason ?? 'stop'
      // Nanoseconds. A long load means the model was (re)loaded; few prompt tokens mean the cache was reused.
      if (j.load_duration !== undefined) stats.loadMs = Math.round(j.load_duration / 1e6)
      if (j.prompt_eval_duration !== undefined) stats.promptEvalMs = Math.round(j.prompt_eval_duration / 1e6)
      if (j.prompt_eval_count !== undefined) stats.promptEvalCount = j.prompt_eval_count
      if (j.prompt_eval_count !== undefined) yield { type: 'usage', promptTokens: j.prompt_eval_count, completionTokens: j.eval_count ?? 0 }
    }
  }
  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      yield* handle(pending.slice(0, nl))
      pending = pending.slice(nl + 1)
    }
  }
  yield* handle(pending)
  yield* splitter.flush()
  if (calls.length) yield { type: 'tool_calls', calls }
  yield { type: 'finish', reason: finish }
}

export async function* streamChat(req: ChatRequest): AsyncGenerator<StreamPart> {
  // Time to first token (anything the UI can show) and the server's own numbers, at debug level.
  const t = timer('llm')
  const stats: ServerStats = {}
  let usage: { promptTokens: number; completionTokens: number } | undefined
  let ok = false
  try {
    for await (const part of route(req, stats)) {
      if (part.type === 'content' || part.type === 'reasoning' || part.type === 'tool_pending' || part.type === 'tool_calls') t.mark('first_token')
      if (part.type === 'usage') usage = part
      yield part
    }
    ok = true
  } finally {
    t.end({ model: req.model, ok, messages: req.messages.length, tools: req.tools?.length ?? 0, prompt: usage?.promptTokens, completion: usage?.completionTokens, ...stats })
  }
}

async function* route(req: ChatRequest, stats: ServerStats): AsyncGenerator<StreamPart> {
  if (await isOllama(req.baseUrl)) {
    yield* withRetries(() => streamOllama(req, stats), req.signal)
    return
  }
  if (isLocal(req.baseUrl)) {
    yield* withRetries(() => streamOpenAI(req, stats), req.signal)
    return
  }
  // Paid endpoint: each attempt is priced and checked against the monthly cap before anything is sent.
  yield* withRetries(() => paidAttempt(req), req.signal)
}

async function* paidAttempt(req: ChatRequest): AsyncGenerator<StreamPart> {
  const chars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length
  const estimatedInput = Math.ceil((chars / 3) * 1.1)
  const claude = isAnthropic(req.baseUrl)
  // OpenAI models on api.openai.com go over the Responses API (openai-responses.ts); other servers keep Chat Completions.
  const responses = !claude && usesResponses(req.baseUrl, req.model)
  const maxOutput = claude ? claudeMaxTokens(req.maxTokens, req.effort, req.model) : responses ? openaiMaxTokens(req.maxTokens, req.effort, req.model) : req.maxTokens
  // If a refusal fallback could answer instead, price the worst case at the most expensive tier.
  spendHooks.before?.(req, estimatedInput, maxOutput, claude && fallbacks(req.model) ? 'claude-fable-5-1' : req.model)
  let input = 0
  let output = 0
  let produced = 0
  let served = req.model
  let rejected = false
  try {
    for await (let part of claude ? streamAnthropic(req) : responses ? streamResponses(req) : streamOpenAI(req)) {
      if (part.type === 'usage') {
        // Recorded at the price tier the real prompt size pays (a 300K mostly-cached prompt is long context).
        if (part.prompt !== undefined || part.extraUsd) part = { ...part, ...tierTokens(req.model, part.prompt ?? part.promptTokens, part.promptTokens, part.completionTokens, part.extraUsd) }
        if (part.type === 'usage') { input = part.promptTokens; output = part.completionTokens }
      }
      if (part.type === 'reset') produced = 0
      if (part.type === 'content' || part.type === 'reasoning') produced += part.text.length
      if (part.type === 'tool_calls') produced += JSON.stringify(part.calls).length
      if (part.type === 'raw') served = part.model
      yield part
    }
  } catch (e) {
    // A request the server rejected outright (400/401/429/5xx before any output) isn't billed.
    const status = (e as { status?: number }).status
    // Nor is one that never reached the server (offline, DNS, refused): nothing came back at all.
    rejected = (e as { billed?: boolean }).billed === false || (!input && !produced && (typeof status === 'number' || /\b(4\d\d|5\d\d)\b/.test((e as Error).message) || (status === undefined && retryInfo(e).retry)))
    throw e
  } finally {
    if (!rejected)
    // If the server didn't report usage (or the stream was stopped), record a conservative estimate.
      spendHooks.after?.(req, input || estimatedInput, output || Math.ceil(produced / 3), served)
  }
}

async function* streamOpenAI(req: ChatRequest, stats: ServerStats = {}): AsyncGenerator<StreamPart> {
  const res = await fetch(`${trim(req.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(req.apiKey, req.baseUrl),
    body: JSON.stringify(buildBody(req)),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw httpError(`Model server returned ${res.status}: ${text.slice(0, 500)}`, res.status, res.headers)
  }

  const splitter = new ThinkSplitter()
  const calls = new Map<number, ToolCall>()
  const decoder = new TextDecoder()
  let pending = ''
  let finish = 'stop'

  const handle = function* (data: string): Generator<StreamPart> {
    if (data === '[DONE]') return
    let json: {
      choices?: Array<{ delta?: Delta; finish_reason?: string | null }>
      usage?: { prompt_tokens: number; completion_tokens: number }
      error?: { message?: string; code?: unknown; type?: string }
      /** llama.cpp server: per-request timings, including how much of the prompt came from its cache. */
      timings?: { prompt_n?: number; prompt_ms?: number; cache_n?: number }
    }
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (json.error) {
      // An error event mid-stream: overloads and rate limits are worth another try.
      const code = Number(json.error.code)
      const why = `${json.error.type ?? ''} ${json.error.message ?? ''}`
      const status = code >= 400 && code < 600 ? code : /overload/i.test(why) ? 529 : /rate.?limit/i.test(why) ? 429 : undefined
      const err = new Error(json.error.message ?? 'Model server error')
      throw status ? Object.assign(err, { status }) : err
    }
    const choice = json.choices?.[0]
    const d = choice?.delta
    if (d) {
      const r = d.reasoning_content ?? d.reasoning
      if (r) yield { type: 'reasoning', text: r }
      if (d.content) yield* splitter.push(d.content)
      for (const tc of d.tool_calls ?? []) {
        let index = tc.index ?? 0
        // Ollama reuses index 0 for every call in a parallel batch: a new id at a seen index is a new call.
        const seen = calls.get(index)
        if (seen && tc.id && seen.id && tc.id !== seen.id) index = Math.max(...calls.keys()) + 1
        const cur = calls.get(index) ?? { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        // Some servers resend the full name on every chunk; assign rather than append in that case.
        const wasNamed = !!cur.name
        if (tc.function?.name) cur.name = cur.name && !tc.function.name.startsWith(cur.name) ? cur.name + tc.function.name : tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        calls.set(index, cur)
        if (!wasNamed && cur.name) yield { type: 'tool_pending', name: cur.name }
      }
    }
    if (choice?.finish_reason) finish = choice.finish_reason
    if (json.timings) {
      if (json.timings.prompt_ms !== undefined) stats.promptEvalMs = Math.round(json.timings.prompt_ms)
      if (json.timings.prompt_n !== undefined) stats.promptEvalCount = json.timings.prompt_n
      if (json.timings.cache_n !== undefined) stats.cachedTokens = json.timings.cache_n
    }
    if (json.usage) yield { type: 'usage', promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
  }

  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (line.startsWith('data:')) yield* handle(line.slice(5).trim())
    }
  }
  if (pending.trim().startsWith('data:')) yield* handle(pending.trim().slice(5).trim())
  yield* splitter.flush()

  if (calls.size) {
    const list = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({ ...c, id: c.id || `call_${i}_${Date.now().toString(36)}` }))
    yield { type: 'tool_calls', calls: list }
  }
  yield { type: 'finish', reason: finish }
}

/** All the text of a stream, starting over when a retry resets it. */
export async function collectText(stream: AsyncIterable<StreamPart>): Promise<string> {
  let out = ''
  for await (const part of stream) {
    if (part.type === 'reset') out = ''
    else if (part.type === 'content') out += part.text
  }
  return out
}
