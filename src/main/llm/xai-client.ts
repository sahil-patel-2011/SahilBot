import type { ToolCall } from '@shared/types'
import type { ChatRequest, StreamPart } from './client'
import { retryAfterFrom } from './retry'
import { toResponsesInput } from './openai-responses'
import { xaiEffort, xaiInfo, xaiMaxTokens, xaiRates } from './xai-models'

// xAI (Grok) over its Responses API (POST https://api.x.ai/v1/responses). xAI calls Responses "the primary
// interface for text generation, reasoning, and tool use" and Chat Completions "the stateless, OpenAI-
// compatible predecessor of the Responses API. New integrations should use Responses" (REST reference, read
// 2026-11-15; docs/grok.md). Both are OpenAI-shaped, so the request reuses SahilBot's Responses input builder
// (openai-responses.ts toResponsesInput) and the event names OpenAI's SDK streams:
//   response.output_text.delta, response.reasoning_summary_text.delta / response.reasoning_text.delta,
//   response.output_item.added / .done, response.completed / .incomplete / .failed, error; data: [DONE].
// Design:
// - Stateless (store: false), the whole history every request; no raw replay (the agent loop rebuilds each turn),
//   so Grok's encrypted reasoning isn't carried across turns (xAI returns it; reusing it needs append-only runs).
// - Function tools only (no xAI server tools: every action runs through SahilBot's tools and approvals).
// - reasoning.effort from the thinking level (xai-models.ts xaiEffort); no temperature / penalties / stop
//   (reasoning models reject presencePenalty, frequencyPenalty and stop).
// - Fast mode: service_tier "priority" (2x, billed only when the response confirms it).
// - Usage: input_tokens (+ input_tokens_details.cached_tokens), output_tokens, output_tokens_details.
//   reasoning_tokens, total_tokens; billed output is total - input when total says reasoning is extra.
//   cost_in_usd_ticks (10^10 per dollar), when sent, is xAI's own figure: a higher one is added as a fee.

type Item = Record<string, unknown> & { type?: string }

/** Request fields some models or accounts may reject: dropped (and remembered per model) on a 400 naming them. */
const OPTIONAL = ['reasoning', 'service_tier', 'prompt_cache_key', 'parallel_tool_calls'] as const
type Optional = typeof OPTIONAL[number]
const dropped = new Map<string, Set<Optional>>()
export const resetXaiState = (): void => dropped.clear()

/** Responses input for xAI: the system prompt as a plain system message (no OpenAI cache breakpoints). */
function xaiInput(req: ChatRequest, declared: Set<string>): Item[] {
  return toResponsesInput(req.messages, req.model, { declared }).map((it) => {
    if (it.type === 'message' && it.role === 'developer') {
      const parts = (it.content as Array<{ text?: string }> | undefined) ?? []
      return { type: 'message', role: 'system', content: parts.map((p) => p.text ?? '').join('\n') }
    }
    return it
  })
}

/** The request body for one call (pure, for tests). */
export function buildXaiRequest(req: ChatRequest, drop: Set<string> = dropped.get(req.model) ?? new Set()): Record<string, unknown> {
  const fns = req.tools ?? []
  const tools = fns.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters }))
  const effort = req.effort ? xaiEffort(req.model, req.effort) : undefined
  return {
    model: req.model,
    input: xaiInput(req, new Set(fns.map((t) => t.function.name))),
    store: false,
    stream: true,
    max_output_tokens: xaiMaxTokens(req.maxTokens, req.model),
    ...(tools.length ? { tools, tool_choice: 'auto', ...(!drop.has('parallel_tool_calls') ? { parallel_tool_calls: true } : {}) } : {}),
    ...(effort && !drop.has('reasoning') ? { reasoning: { effort } } : {}),
    ...(req.cacheKey && !drop.has('prompt_cache_key') ? { prompt_cache_key: req.cacheKey } : {}),
    ...(req.fast && !drop.has('service_tier') ? { service_tier: 'priority' } : {})
  }
}

export interface XaiUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  total_tokens?: number | null
  input_tokens_details?: { cached_tokens?: number | null } | null
  output_tokens_details?: { reasoning_tokens?: number | null } | null
  cost_in_usd_ticks?: number | null
  cost_in_nano_usd?: number | null
  num_sources_used?: number | null
  num_server_side_tools_used?: number | null
}

export interface XaiCost {
  /** Real prompt tokens (what the >=200K rule looks at). */
  prompt: number
  cached: number
  /** Output billed (visible + reasoning). */
  output: number
  reasoning: number
  /** Input at the standard-tier input rate (cached reads weighted), as the budget records it. */
  billedInput: number
  /** At standard speed, before any priority premium. */
  usd: number
  /** xAI's own cost for the request, when it sent one (includes any priority premium). */
  reportedUsd?: number
  long: boolean
}

export function xaiCost(model: string, u: XaiUsage | null | undefined): XaiCost {
  const prompt = u?.input_tokens ?? 0
  const cached = Math.min(prompt, u?.input_tokens_details?.cached_tokens ?? 0)
  const reasoning = u?.output_tokens_details?.reasoning_tokens ?? 0
  const visible = u?.output_tokens ?? 0
  // total = input + output (+ reasoning when it isn't inside output_tokens): what was billed as output either way.
  const output = u?.total_tokens ? Math.max(visible, u.total_tokens - prompt) : visible
  const r = xaiRates(model, prompt) ?? { input: 10, cacheRead: 10, output: 50, long: false }
  const tierUsd = ((prompt - cached) * r.input + cached * r.cacheRead + output * r.output) / 1e6
  // Billing-equivalent input at the standard-tier input rate: budget.tierTokens re-prices it at the prompt's tier.
  const billedInput = Math.round((prompt - cached) + cached * (r.cacheRead / r.input))
  const ticks = u?.cost_in_usd_ticks ?? undefined
  const nano = u?.cost_in_nano_usd ?? undefined
  const reportedUsd = typeof ticks === 'number' && ticks > 0 ? ticks / 1e10 : typeof nano === 'number' && nano > 0 ? nano / 1e9 : undefined
  return { prompt, cached, output, reasoning, billedInput, usd: tierUsd, ...(reportedUsd !== undefined ? { reportedUsd } : {}), long: r.long }
}

// ---------------------------------------------------------------------------------------------------
// Errors. xAI's debugging page: 400 (check the body), 401 (no or invalid key), 403 (ask your team admin),
// 404, 405, 415, 422 (a field has an invalid format), 429 (rate limit; back off or raise it in the Console).
// ---------------------------------------------------------------------------------------------------

const QUOTA = /credit|billing|spending limit|insufficient|balance|exhausted|quota/i

export function xaiError(status: number | undefined, message: string | undefined, headers: { get(n: string): string | null } | undefined, model: string): Error {
  const why = message?.trim() || (status ? `HTTP ${status}` : 'unknown error')
  const retryAfterMs = retryAfterFrom(headers)
  let msg: string
  let st = status
  if (status === 401) msg = 'xAI rejected the API key. Check it in Settings → Models → xAI.'
  else if (QUOTA.test(why) && (status === 402 || status === 403 || status === 429)) { msg = `xAI won't run more requests on this account right now (${why}). Check your xAI Console credits and limits.`; st = 402 }
  else if (status === 429) msg = `xAI is rate-limiting requests right now${retryAfterMs !== undefined ? ` (it asked to wait ${Math.ceil(retryAfterMs / 1000)}s)` : ''}. Try again in a moment.`
  else if (status === 403) msg = `xAI refused access: ${why}`
  else if (status === 404) msg = `xAI doesn't offer ${model} to this key: ${why}`
  else if (/context|too long|maximum.*tokens/i.test(why) && (status === 400 || status === 422)) { msg = `This conversation is too long for ${model}'s context window: ${why}`; st = 400 }
  else if (status === 400 || status === 422 || status === 415) msg = `xAI rejected the request: ${why}`
  else if ((status ?? 0) >= 500) { msg = `xAI is overloaded or unavailable right now (${why}). Try again shortly.`; st = status }
  else msg = `xAI rejected the request: ${why}`
  return Object.assign(new Error(msg), { status: st, retryAfterMs, billed: false })
}

/** The optional field a 400/422 is about, when dropping it would fix the request. */
export function xaiOptionalParam(status: number, message: string, sent: Record<string, unknown>): Optional | undefined {
  if (status !== 400 && status !== 422) return undefined
  if (sent.service_tier && /service_tier|priority/i.test(message)) return 'service_tier'
  if (sent.reasoning && /reasoning|effort/i.test(message)) return 'reasoning'
  if (sent.prompt_cache_key && /prompt_cache_key/i.test(message)) return 'prompt_cache_key'
  if (sent.parallel_tool_calls !== undefined && /parallel_tool_calls/i.test(message)) return 'parallel_tool_calls'
  return undefined
}

/** Server-sent events: each event's data payload, parsed (`[DONE]` and keep-alives skipped). */
async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data: string[] = []
  const flush = function* (): Generator<Record<string, unknown>> {
    if (!data.length) return
    const text = data.join('\n')
    data = []
    if (text === '[DONE]') return
    try { yield JSON.parse(text) as Record<string, unknown> } catch { /* partial or keep-alive */ }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') yield* flush()
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''))
    }
  }
  if (buf.startsWith('data:')) data.push(buf.slice(5).replace(/^ /, ''))
  yield* flush()
}

const EVENT_STATUS: Record<string, number> = { rate_limit_exceeded: 429, server_error: 500, internal_error: 500, service_unavailable: 503, overloaded: 503, timeout: 408 }

export async function* streamXai(req: ChatRequest): AsyncGenerator<StreamPart> {
  if (!req.apiKey) throw new Error('Add your xAI API key in Settings → Models to use Grok.')
  if (!xaiInfo(req.model)) throw Object.assign(new Error(`SahilBot doesn't know the xAI model ${req.model}. Pick a Grok model from the list.`), { status: 404, billed: false })
  const drop = dropped.get(req.model) ?? new Set<Optional>()
  let res: Response
  let body: Record<string, unknown>
  for (let fix = 0; ; fix++) {
    body = buildXaiRequest(req, drop)
    res = await fetch(`${req.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(body),
      signal: req.signal
    })
    if (res.ok && res.body) break
    const text = await res.text().catch(() => '')
    let message = text.slice(0, 400)
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string }; message?: string; code?: string }
      message = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message ?? message
    } catch { /* not JSON */ }
    const p = xaiOptionalParam(res.status, message, body)
    if (p && fix < OPTIONAL.length && !drop.has(p)) { drop.add(p); dropped.set(req.model, drop); continue }
    throw xaiError(res.status, message, res.headers, req.model)
  }

  let final: { status?: string; model?: string; output?: Item[]; usage?: XaiUsage | null; incomplete_details?: { reason?: string } | null; service_tier?: string } | undefined
  const done: Item[] = []
  let streamedText = false
  let lastTextItem: unknown
  let lastSummary: string | undefined
  let reasoned = false
  for await (const ev of sse(res.body!)) {
    const type = ev.type as string | undefined
    if (type === 'response.output_item.added') {
      const it = ev.item as Item | undefined
      if (it?.type === 'function_call' && typeof it.name === 'string') yield { type: 'tool_pending', name: it.name }
    } else if (type === 'response.output_item.done') {
      if (ev.item && typeof ev.item === 'object') done.push(ev.item as Item)
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = String(ev.delta ?? '')
      if (!delta) continue
      const sep = streamedText && ev.item_id !== lastTextItem ? '\n\n' : ''
      lastTextItem = ev.item_id
      streamedText = true
      yield { type: 'content', text: sep + delta }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      const delta = String(ev.delta ?? '')
      if (!delta) continue
      const key = `${ev.item_id}:${ev.summary_index ?? ev.content_index ?? 0}`
      const sep = reasoned && key !== lastSummary ? '\n\n' : ''
      lastSummary = key
      reasoned = true
      yield { type: 'reasoning', text: sep + delta }
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      final = ev.response as typeof final
    } else if (type === 'response.failed' || type === 'error') {
      const e = (type === 'error' ? (ev.error && typeof ev.error === 'object' ? ev.error : ev) : (ev.response as { error?: unknown } | undefined)?.error ?? {}) as { code?: unknown; message?: unknown; type?: unknown }
      const code = String(e.code ?? e.type ?? 'server_error')
      // Out of credits mid-stream: 402, so it isn't retried and Auto moves on (xaiError's billing rule).
      const status = EVENT_STATUS[code] ?? (/quota|credit|billing|spend/i.test(code) ? 402 : /rate/.test(code) ? 429 : /overload|server|internal/.test(code) ? 500 : undefined)
      throw xaiError(status, String(e.message ?? `xAI stream error (${code})`), undefined, req.model)
    }
  }
  // No final event: use the finished items if the stream delivered them, else the connection dropped.
  if (!final) {
    if (!done.length) throw Object.assign(new Error('The connection to xAI closed before the reply finished.'), { network: true })
    final = { status: 'completed', output: done }
  }

  const output = (final.output?.length ? final.output : done).filter((it): it is Item => !!it && typeof it === 'object')
  const reason = final.incomplete_details?.reason
  const cut = final.status === 'incomplete' && /max_output_tokens|length/.test(reason ?? '')

  if (!streamedText) {
    const text = output.filter((it) => it.type === 'message').flatMap((it) => (it.content as Array<{ type?: string; text?: string; refusal?: string }> | undefined) ?? []).map((p) => (p.type === 'refusal' ? p.refusal : p.text) ?? '').filter(Boolean).join('\n\n')
    if (text) yield { type: 'content', text }
  }

  if (final.usage) {
    const c = xaiCost(req.model, final.usage)
    const tier = final.service_tier === 'priority' || final.service_tier === 'fast' ? 'fast' : 'standard'
    // xAI's own figure (with any priority premium) above SahilBot's: the difference is charged as a fee.
    const expected = c.usd * (tier === 'fast' ? 2 : 1)
    const extra = c.reportedUsd !== undefined && c.reportedUsd > expected * 1.001 ? c.reportedUsd - expected : 0
    yield { type: 'usage', promptTokens: c.billedInput, completionTokens: c.output, prompt: c.prompt, cachedTokens: c.cached, reasoningTokens: c.reasoning, serviceTier: tier, ...(extra ? { extraUsd: extra } : {}) }
  }

  if (final.status === 'incomplete' && /content_filter|guideline|safety/.test(reason ?? '')) {
    yield { type: 'content', text: '\n\n_xAI stopped this reply under its usage guidelines._ You can rephrase the request, or pick another model for this chat.' }
    yield { type: 'finish', reason: 'content_filter' }
    return
  }
  const calls: ToolCall[] = cut ? [] : output
    .filter((it) => it.type === 'function_call')
    .map((it, i) => ({ id: String(it.call_id ?? it.id ?? `call_${i}`), name: String(it.name ?? ''), arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) }))
  if (calls.length) yield { type: 'tool_calls', calls }
  yield { type: 'finish', reason: cut ? 'length' : calls.length ? 'tool_calls' : 'stop' }
}
