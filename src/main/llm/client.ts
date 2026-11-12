import type { Sampling, ToolCall } from '@shared/types'
import { lookup } from './catalog'
import { isAnthropic } from './providers'
import { claudeMaxTokens, fallbacks, listAnthropicModels, streamAnthropic } from './anthropic'

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
  | { type: 'usage'; promptTokens: number; completionTokens: number }
  | { type: 'finish'; reason: string }
  | { type: 'raw'; provider: 'anthropic'; model: string; content: unknown }
  /** A tool call has started streaming: its name is known, its arguments aren't yet. */
  | { type: 'tool_pending'; name: string }

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
  const s = req.sampling
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
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
    if (req.contextWindow) body.options = { num_ctx: req.contextWindow }
  }
  if (req.tools?.length) {
    body.tools = req.tools
    body.tool_choice = 'auto'
  }
  // OpenAI reasoning models take a coarser effort scale.
  if (req.effort && /^(gpt-5|o\d)/i.test(req.model) && !isLocal(req.baseUrl)) body.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort
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

const ollamaCache = new Map<string, boolean>()

/** True when the endpoint is an Ollama server (it answers /api/version). Cached per base URL. */
export async function isOllama(baseUrl: string): Promise<boolean> {
  const key = trim(baseUrl)
  if (ollamaCache.has(key)) return ollamaCache.get(key)!
  let yes = false
  if (isLocal(baseUrl)) {
    try {
      const r = await fetch(`${key.replace(/\/v1$/, '')}/api/version`, { signal: AbortSignal.timeout(1500) })
      yes = r.ok && 'version' in ((await r.json()) as object)
    } catch {
      yes = false
    }
  }
  ollamaCache.set(key, yes)
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
async function* streamOllama(req: ChatRequest): AsyncGenerator<StreamPart> {
  const s = req.sampling
  const options: Record<string, unknown> = { temperature: s.temperature, top_p: s.top_p, num_predict: req.maxTokens }
  if (req.contextWindow) options.num_ctx = req.contextWindow
  if (s.top_k) options.top_k = s.top_k
  if (s.min_p) options.min_p = s.min_p
  if (s.repeat_penalty && s.repeat_penalty !== 1) options.repeat_penalty = s.repeat_penalty
  if (s.presence_penalty) options.presence_penalty = s.presence_penalty
  const res = await fetch(`${trim(req.baseUrl).replace(/\/v1$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Quick chats skip thinking on models that think (only sent to those: others reject the flag).
    body: JSON.stringify({ model: req.model, messages: toOllamaMessages(req.messages), tools: req.tools?.length ? req.tools : undefined, stream: true, options, ...(req.effort === 'low' && lookup(req.model)?.thinks ? { think: false } : {}) }),
    signal: req.signal
  })
  if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${(await res.text().catch(() => '')).slice(0, 500)}`)
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
    }
    if (j.error) throw new Error(j.error)
    if (j.message?.thinking) yield { type: 'reasoning', text: j.message.thinking }
    if (j.message?.content) yield* splitter.push(j.message.content)
    for (const c of j.message?.tool_calls ?? []) {
      calls.push({ id: `call_${calls.length}`, name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments ?? {}) })
    }
    if (j.done) {
      finish = j.done_reason ?? 'stop'
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
  if (await isOllama(req.baseUrl)) {
    yield* streamOllama(req)
    return
  }
  if (isLocal(req.baseUrl)) {
    yield* streamOpenAI(req)
    return
  }
  // Paid endpoint: priced and checked against the monthly cap before anything is sent.
  const chars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length
  const estimatedInput = Math.ceil((chars / 3) * 1.1)
  const claude = isAnthropic(req.baseUrl)
  const maxOutput = claude ? claudeMaxTokens(req.maxTokens, req.effort) : req.maxTokens
  // If a refusal fallback could answer instead, price the worst case at the most expensive tier.
  spendHooks.before?.(req, estimatedInput, maxOutput, claude && fallbacks(req.model) ? 'claude-fable-5-1' : req.model)
  let input = 0
  let output = 0
  let produced = 0
  let served = req.model
  let rejected = false
  try {
    for await (const part of isAnthropic(req.baseUrl) ? streamAnthropic(req) : streamOpenAI(req)) {
      if (part.type === 'usage') { input = part.promptTokens; output = part.completionTokens }
      if (part.type === 'content' || part.type === 'reasoning') produced += part.text.length
      if (part.type === 'tool_calls') produced += JSON.stringify(part.calls).length
      if (part.type === 'raw') served = part.model
      yield part
    }
  } catch (e) {
    // A request the server rejected outright (400/401/429/5xx before any output) isn't billed.
    rejected = (e as { billed?: boolean }).billed === false || (!input && !produced && /\b(4\d\d|5\d\d)\b/.test((e as Error).message))
    throw e
  } finally {
    if (!rejected)
    // If the server didn't report usage (or the stream was stopped), record a conservative estimate.
      spendHooks.after?.(req, input || estimatedInput, output || Math.ceil(produced / 3), served)
  }
}

async function* streamOpenAI(req: ChatRequest): AsyncGenerator<StreamPart> {
  const res = await fetch(`${trim(req.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: headers(req.apiKey, req.baseUrl),
    body: JSON.stringify(buildBody(req)),
    signal: req.signal
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Model server returned ${res.status}: ${text.slice(0, 500)}`)
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
      error?: { message?: string }
    }
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (json.error) throw new Error(json.error.message ?? 'Model server error')
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
