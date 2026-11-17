import type { ToolCall } from '@shared/types'
import type { ChatRequest, StreamPart, WireMessage } from './client'
import { retryAfterFrom } from './retry'
import { openaiCompactAt, openaiEffort, openaiInfo, quickestEffort, openaiMaxTokens, openaiWindow, usesResponses, writeFactors, type ContextStrategy } from './openai-models'
import { claudeWindow } from './claude-models'
import { fastSupport } from './fast-mode'

// OpenAI over the Responses API (POST /v1/responses), for every OpenAI-hosted model that uses it
// (openai-models.ts). Request and event shapes follow OpenAI's reference and guides, read 2026-11-15:
//   api/reference/resources/responses/methods/create.md (input items, tools, reasoning, include, store,
//     prompt_cache_key / prompt_cache_options, context_management, max_output_tokens, usage),
//   api/reference/resources/responses/streaming-events.md (response.output_text.delta,
//     response.reasoning_summary_text.delta, response.output_item.added, response.completed /
//     incomplete / failed, error),
//   api/docs/guides/{function-calling,reasoning,conversation-state,preserved-reasoning,prompt-caching,
//     compaction,tools-web-search,error-codes}.md.
//
// Design, for long agent runs with tools:
// - Stateless (store: false), the whole history replayed every request. The guides name this the path for
//   apps that keep their own history ("Stateless or ZDR: use store: false and replay the full history
//   yourself, including encrypted reasoning"); previous_response_id is simpler but stores every response
//   at OpenAI for 30+ days, can't follow SahilBot's own edits, summaries and model switches, and breaks if
//   a stored response expires. Reasoning items come back with encrypted_content (also asked for with
//   include: reasoning.encrypted_content, which older models need) and are replayed exactly as returned,
//   with the assistant messages' `phase`, so the model keeps its reasoning across tool calls.
// - Append-only: "the API will drop reasoning items that follow a prefix change" (preserved-reasoning).
//   Every output item of the same model is stored in message meta.raw and sent back unchanged in order;
//   the agent loop runs OpenAI chats append-only like Claude's (no mid-run rewrites, all screenshots kept).
// - Prompt caching: the system prompt is a developer message (instructions can't hold a cache breakpoint)
//   first, tools stable in their order; implicit caching covers the growing tail. GPT-5.6+ get
//   prompt_cache_options.ttl 30m and an explicit breakpoint after the system prompt (12h on long runs:
//   team leads, helpers, Extra/Max turns), so the stable prefix survives long gaps cheaply.
//   prompt_cache_key is the chat (routing on older models, per-chat accounting on 5.6+).
// - Server-side compaction (context_management compaction) near the context strategy's window; items before
//   the newest compaction item are dropped ("you can drop items that came before the most recent compaction
//   item"). Effort changes go request-level: configuration_update items can't be combined with automatic
//   compaction (guides/reasoning "Change reasoning mid-conversation").
// - Function tools are SahilBot's own (strict: false, same names and arguments the loop expects). The only
//   built-in tool ever enabled is web_search (when web search is on): its sources become pills, and what it
//   read is outside content for the taint check. computer_use, shell, code interpreter, apply_patch and MCP
//   stay off: every action runs through SahilBot's tools, approvals and hard stops.

type Item = Record<string, unknown> & { type?: string }

/** One built-in web search call: $10 per 1,000 calls (pricing.md "Web search"); search content tokens are in usage. */
export const OPENAI_WEB_SEARCH_USD = 0.01
/** Built-in tool calls per response (bounds one turn's search fees). */
export const OPENAI_MAX_TOOL_CALLS = 8

/** Request fields that some models or accounts reject, dropped (and remembered per model) on a 400 naming them. */
const OPTIONAL = ['reasoning.summary', 'reasoning.context', 'prompt_cache_options', 'prompt_cache_breakpoint', 'prompt_cache_key', 'context_management', 'include', 'max_tool_calls', 'service_tier'] as const
type Optional = typeof OPTIONAL[number]
const dropped = new Map<string, Set<Optional>>()
/** Forget what earlier requests learned (tests). */
export const resetResponsesState = (): void => dropped.clear()

function contentOf(c: WireMessage['content']): { text: string; images: string[] } {
  if (c === null) return { text: '', images: [] }
  if (typeof c === 'string') return { text: c, images: [] }
  return {
    text: c.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
    images: c.filter((p) => p.type === 'image_url').map((p) => (p as { image_url: { url: string } }).image_url.url)
  }
}

const userMessage = (text: string, images: string[] = []): Item => ({
  type: 'message', role: 'user',
  content: [...(text ? [{ type: 'input_text', text }] : []), ...images.map((url) => ({ type: 'input_image', image_url: url }))]
})

interface InputOptions {
  /** Function names this request declares (a call to another tool is replayed as text). */
  declared: Set<string>
  /** prompt_cache_breakpoint on the system prompt (GPT-5.6+). */
  breakpoint?: Record<string, unknown>
  /** Round-trip `phase` on rebuilt assistant messages. */
  phase?: boolean
}

/**
 * SahilBot's history (OpenAI-chat-shaped wire messages) → Responses input items. Turns this model produced
 * are replayed from meta.raw exactly as returned (reasoning with encrypted_content, messages with phase,
 * function_call, web_search_call, compaction); other turns (another model's, or before a summary) are
 * rebuilt as an assistant message plus function_call items. Tool results become function_call_output;
 * images a tool returned ride inside its output. Items before the newest compaction item are dropped.
 */
export function toResponsesInput(wire: WireMessage[], model: string, o: InputOptions): Item[] {
  const out: Item[] = []
  /** Calls replayed as text (their tool isn't offered): their results follow as text too. */
  const asText = new Map<string, string>()
  const outputs = new Map<string, Item>()
  let systemDone = false
  for (const m of wire) {
    if (m.role === 'system') {
      const text = contentOf(m.content).text
      if (!text) continue
      // The stable prefix: a developer message (top-level instructions can't carry a cache breakpoint).
      const part: Item = { type: 'input_text', text, ...(!systemDone && o.breakpoint ? { prompt_cache_breakpoint: o.breakpoint } : {}) }
      out.push({ type: 'message', role: 'developer', content: [part] })
      systemDone = true
      continue
    }
    if (m.role === 'assistant') {
      const raw = m.raw as { provider?: string; model?: string; content?: Item[] } | undefined
      if (raw?.provider === 'openai' && raw.model === model && Array.isArray(raw.content)) {
        // The loop may have renamed the call ids: results are matched to the replayed calls by position.
        const ids = (m.tool_calls ?? []).map((c) => c.id)
        const calls = raw.content.filter((it) => it?.type === 'function_call')
        const remap = calls.length === ids.length
        let k = 0
        for (const it of raw.content) {
          if (it?.type === 'function_call' && remap) {
            const id = ids[k++]
            out.push(it.call_id === id ? it : { ...it, call_id: id })
          } else out.push(it)
        }
        continue
      }
      const text = contentOf(m.content).text
      let t = text
      const fc: Item[] = []
      for (const c of m.tool_calls ?? []) {
        if (!o.declared.has(c.function.name)) {
          asText.set(c.id, c.function.name)
          t += `${t ? '\n' : ''}[Called ${c.function.name} ${c.function.arguments || '{}'}]`
          continue
        }
        fc.push({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' })
      }
      if (t) out.push({ type: 'message', role: 'assistant', content: t, ...(o.phase ? { phase: fc.length ? 'commentary' : 'final_answer' } : {}) })
      out.push(...fc)
      continue
    }
    if (m.role === 'tool') {
      const body = contentOf(m.content).text || '(empty)'
      const id = m.tool_call_id!
      if (asText.has(id)) { out.push(userMessage(`[Result of ${asText.get(id)}]\n${body}`)); continue }
      const item: Item = { type: 'function_call_output', call_id: id, output: body }
      outputs.set(id, item)
      out.push(item)
      continue
    }
    // user: images a tool returned go inside that tool's output (function_call_output takes input_image).
    const { text, images } = contentOf(m.content)
    const target = m.imagesFor ? outputs.get(m.imagesFor) : undefined
    if (target && images.length && /^\[Image returned by /.test(text)) {
      const prev = typeof target.output === 'string' ? target.output : ''
      target.output = [{ type: 'input_text', text: prev }, ...images.map((url) => ({ type: 'input_image', image_url: url }))]
      continue
    }
    out.push(userMessage(text || (images.length ? '' : '(empty)'), images))
  }
  // Server compaction: the newest compaction item carries everything before it (the system prompt stays).
  let last = -1
  for (let i = out.length - 1; i >= 0; i--) if (out[i]?.type === 'compaction') { last = i; break }
  if (last > 0) {
    const head = out[0]?.role === 'developer' ? [out[0]] : []
    return [...head, ...out.slice(last)]
  }
  return out
}

/**
 * Fast mode's service_tier (guides/fast-mode, /ultrafast-mode): "fast" ("priority" behaves the same), or
 * "ultrafast" on gpt-6-astra / gpt-6.1-sol only. undefined: standard.
 */
export function openaiServiceTier(req: Pick<ChatRequest, 'model' | 'fast'>): 'fast' | 'ultrafast' | undefined {
  const s = req.fast ? fastSupport(req.model) : undefined
  if (s?.provider !== 'openai') return undefined
  return req.fast === 'ultrafast' && s.ultrafast ? 'ultrafast' : 'fast'
}

/** The tier a response reports: "priority" / "fast" → fast, "ultrafast", "default" (or a downgrade) → standard. */
export function servedTier(t: unknown): 'fast' | 'ultrafast' | 'standard' | undefined {
  if (t === 'priority' || t === 'fast') return 'fast'
  if (t === 'ultrafast') return 'ultrafast'
  if (t === 'default' || t === 'auto' || t === 'flex' || t === 'standard') return 'standard'
  return undefined
}

/** The Responses request body for one call (pure, so it can be pinned down in tests). */
export function buildResponsesRequest(req: ChatRequest, drop: Set<string> = dropped.get(req.model) ?? new Set()): { body: Record<string, unknown>; web: boolean } {
  const spec = openaiInfo(req.model)
  const wire = req.tools ?? []
  const web = !!req.native?.web && !!spec?.builtins?.includes('web_search') && wire.some((t) => t.function.name === 'web_search')
  const fns = wire.filter((t) => !(web && t.function.name === 'web_search'))
  const tools: Item[] = [
    // strict: false: SahilBot validates every call against its schema; strict mode would rewrite optional
    // fields as required-nullable (guides/function-calling: omitted strict is normalized when possible).
    ...fns.map((t) => ({ type: 'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters, strict: false })),
    ...(web ? [{ type: 'web_search' }] : [])
  ]
  const long = req.cacheTtl === '1h'
  const cache = !!spec?.cacheOptions
  const input = toResponsesInput(req.messages, req.model, {
    declared: new Set(fns.map((t) => t.function.name)),
    breakpoint: cache && !drop.has('prompt_cache_breakpoint') ? { mode: 'explicit', ...(long ? { ttl: '12h' } : {}) } : undefined,
    phase: !!spec?.phase
  })
  const effort = req.noThinking ? quickestEffort(req.model) ?? openaiEffort(req.model, 'low') : req.effort ? openaiEffort(req.model, req.effort) : undefined
  const reasoning: Record<string, unknown> = {}
  if (effort) reasoning.effort = effort
  // Readable reasoning summaries stream into the step's thinking ("auto": the most detailed available).
  if (effort !== 'none' && !drop.has('reasoning.summary')) reasoning.summary = 'auto'
  if (spec?.allTurns && !drop.has('reasoning.context')) reasoning.context = 'all_turns'
  const include = ['reasoning.encrypted_content', ...(web ? ['web_search_call.action.sources'] : [])]
  const body: Record<string, unknown> = {
    model: req.model,
    input,
    store: false,
    stream: true,
    max_output_tokens: openaiMaxTokens(req.maxTokens, req.effort, req.model),
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
    ...(!drop.has('include') ? { include } : {}),
    ...(req.cacheKey && !drop.has('prompt_cache_key') ? { prompt_cache_key: req.cacheKey } : {}),
    ...(cache && !drop.has('prompt_cache_options') ? { prompt_cache_options: { ttl: '30m' } } : {}),
    // Compaction takes only type and compact_threshold (guides/compaction: no custom prompt), and its item is opaque
    // (encrypted_content), so the checkpoint's format can't be asked for or checked here: the task brief stored right
    // after the compaction (agent/loop.ts storeBrief) carries the notes, the user's messages, the identifiers and the
    // failed attempts in full instead.
    ...(req.compactAt && spec?.compaction && !drop.has('context_management') ? { context_management: [{ type: 'compaction', compact_threshold: Math.max(1000, Math.round(req.compactAt)) }] } : {}),
    ...(web && !drop.has('max_tool_calls') ? { max_tool_calls: OPENAI_MAX_TOOL_CALLS } : {}),
    ...(openaiServiceTier(req) && !drop.has('service_tier') ? { service_tier: openaiServiceTier(req) } : {})
  }
  return { body, web }
}

// ---------------------------------------------------------------------------------------------------
// Usage and cost. usage.input_tokens counts every prompt token; input_tokens_details splits out cache
// reads (cached_tokens) and, on GPT-5.6+, cache writes (cache_write_tokens, by lifetime). Ordinary input is
// input_tokens - cached_tokens - cache_write_tokens (guides/prompt-caching "Usage reporting").
// ---------------------------------------------------------------------------------------------------

export interface ResponsesUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  input_tokens_details?: { cached_tokens?: number | null; cache_write_tokens?: number | null; cache_write_tokens_details?: { ttl_30m_tokens?: number | null; ttl_12h_tokens?: number | null } | null } | null
  output_tokens_details?: { reasoning_tokens?: number | null } | null
}

export interface UsageCost {
  /** Real prompt tokens (what the >272K long-context rule looks at). */
  prompt: number
  cached: number
  written: number
  output: number
  reasoning: number
  /** Input in billing terms at the model's standard input rate (reads and writes weighted). */
  billedInput: number
  /** Built-in tool fees in dollars (web search). */
  extraUsd: number
  /** What the request cost. */
  usd: number
  long: boolean
}

/** One response's usage in dollars and billing-equivalent tokens (budget.tierTokens turns these into what's recorded). */
export function responsesCost(model: string, u: ResponsesUsage | null | undefined, webCalls = 0): UsageCost {
  const spec = openaiInfo(model)
  const prompt = u?.input_tokens ?? 0
  const d = u?.input_tokens_details ?? {}
  const cached = d.cached_tokens ?? 0
  const written = d.cache_write_tokens ?? 0
  const w12 = d.cache_write_tokens_details?.ttl_12h_tokens ?? 0
  const w30 = Math.max(0, written - w12)
  const plain = Math.max(0, prompt - cached - written)
  const output = u?.output_tokens ?? 0
  const p = spec?.price ?? { input: 10, output: 50, cacheRead: 10 }
  const wf = writeFactors(model)
  const billedInput = Math.round(plain + cached * (p.cacheRead / p.input) + w30 * wf.m30 + w12 * wf.h12)
  const long = !!spec?.longContext && prompt > spec.longContext.above
  const fi = long ? spec!.longContext!.input : 1
  const fo = long ? spec!.longContext!.output : 1
  const extraUsd = webCalls * OPENAI_WEB_SEARCH_USD
  const usd = (billedInput * p.input * fi + output * p.output * fo) / 1e6 + extraUsd
  return { prompt, cached, written, output, reasoning: u?.output_tokens_details?.reasoning_tokens ?? 0, billedInput, extraUsd, usd, long }
}

// ---------------------------------------------------------------------------------------------------
// Errors (guides/error-codes): readable, with what the retry logic needs (status, Retry-After). Billing
// limits come back as 429 too, but retrying can't help: they get a non-retried status.
// ---------------------------------------------------------------------------------------------------

const QUOTA = /insufficient_quota|credit_balance_exhausted|spend_limit|usage_limit|billing/i

export function openaiError(status: number | undefined, body: { message?: string; type?: string; code?: string | null; param?: string | null } | undefined, headers: { get(n: string): string | null } | undefined, model: string): Error {
  const why = body?.message?.trim() || (status ? `HTTP ${status}` : 'unknown error')
  const code = `${body?.code ?? ''} ${body?.type ?? ''}`
  const retryAfterMs = retryAfterFrom(headers)
  let msg: string
  let st = status
  if (status === 401) msg = 'OpenAI rejected the API key. Check it in Settings → Models.'
  else if (QUOTA.test(code)) { msg = `OpenAI won't run more requests on this account right now (${why}). Check your OpenAI billing and limits.`; st = 402 }
  else if (status === 429 || /rate_limit|slow_down/.test(code)) {
    msg = `OpenAI is rate-limiting requests right now${retryAfterMs !== undefined ? ` (it asked to wait ${Math.ceil(retryAfterMs / 1000)}s)` : ''}. Try again in a moment.`
    st = 429
  } else if (/context_length|too long|maximum context/i.test(`${code} ${why}`)) { msg = `This conversation is too long for ${model}'s context window: ${why}`; st = 400 }
  else if (/content_policy|safety|invalid_prompt|flagged/i.test(code)) msg = `OpenAI declined this request under its usage policies: ${why} You can rephrase it, or pick another model for this chat.`
  else if (status === 403) msg = `OpenAI refused access: ${why}`
  else if (status === 404 || /model_not_found/.test(code)) msg = `OpenAI doesn't offer ${model} to this key: ${why}`
  else if (status === 503 || status === 529 || /overload|server_is_overloaded|server_error|service_unavailable/.test(code) || (status ?? 0) >= 500) {
    msg = `OpenAI is overloaded or unavailable right now (${why}). Try again shortly.`
    st = status && status >= 500 ? status : 503
  } else msg = `OpenAI rejected the request: ${why}`
  return Object.assign(new Error(msg), { status: st, retryAfterMs, billed: false, code: body?.code ?? undefined, param: body?.param ?? undefined })
}

/** The optional request field a 400 is about, when dropping it would fix the request. */
export function optionalParam(status: number, body: { message?: string; param?: string | null } | undefined, sent: Record<string, unknown>): Optional | undefined {
  if (status !== 400) return undefined
  const param = (body?.param ?? '').trim()
  const msg = body?.message ?? ''
  const reasoning = sent.reasoning as Record<string, unknown> | undefined
  const exact = OPTIONAL.find((p) => param === p || param.startsWith(`${p}.`) || param.startsWith(`${p}[`))
  if (exact && fieldSent(exact, sent)) return exact
  if (reasoning?.summary && /summar|verif/i.test(`${param} ${msg}`)) return 'reasoning.summary'
  if (reasoning?.context && /reasoning\.context|all_turns/i.test(`${param} ${msg}`)) return 'reasoning.context'
  if (sent.context_management && /context_management|compaction/i.test(`${param} ${msg}`)) return 'context_management'
  if (/prompt_cache_breakpoint/i.test(`${param} ${msg}`)) return 'prompt_cache_breakpoint'
  if (sent.prompt_cache_options && /prompt_cache_options/i.test(`${param} ${msg}`)) return 'prompt_cache_options'
  if (sent.prompt_cache_key && /prompt_cache_key/i.test(`${param} ${msg}`)) return 'prompt_cache_key'
  if (sent.include && /\binclude\b|encrypted_content/i.test(`${param} ${msg}`)) return 'include'
  if (sent.service_tier && /service_tier|ultrafast|fast mode|priority/i.test(`${param} ${msg}`)) return 'service_tier'
  return undefined
}

function fieldSent(p: Optional, sent: Record<string, unknown>): boolean {
  if (p === 'reasoning.summary' || p === 'reasoning.context') return !!(sent.reasoning as Record<string, unknown> | undefined)?.[p.split('.')[1]]
  if (p === 'prompt_cache_breakpoint') return JSON.stringify(sent.input ?? []).includes('prompt_cache_breakpoint')
  return sent[p] !== undefined
}

// ---------------------------------------------------------------------------------------------------
// Streaming.
// ---------------------------------------------------------------------------------------------------

interface Annotation { type?: string; url?: string; title?: string; start_index?: number; end_index?: number }

/** What the built-in web search did in one response: sources (pills), cited pages, outside text, calls. */
export function webFindings(output: Item[]): { found: Array<{ title: string; url: string }>; read: Array<{ title: string; url: string }>; untrusted: string[]; searches: number; fetches: number; errors: string[] } {
  const found: Array<{ title: string; url: string }> = []
  const read: Array<{ title: string; url: string }> = []
  const untrusted: string[] = []
  const errors: string[] = []
  let searches = 0
  let fetches = 0
  const seen = new Set<string>()
  const add = (list: typeof found, title: unknown, url: unknown): void => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return
    const key = `${list === read ? 'r' : 'f'}|${url}`
    if (seen.has(key)) return
    seen.add(key)
    list.push({ title: typeof title === 'string' && title ? title : url, url })
  }
  for (const it of output) {
    if (it?.type === 'web_search_call') {
      const a = (it.action ?? {}) as { type?: string; query?: string; queries?: string[]; sources?: Array<{ url?: string }>; url?: string; pattern?: string }
      if (a.type === 'open_page' || a.type === 'find_in_page') fetches++
      else searches++
      if (it.status === 'failed') errors.push('web_search: failed')
      for (const s of a.sources ?? []) { add(found, undefined, s.url); if (s.url) untrusted.push(s.url) }
      if (a.url) { add(read, undefined, a.url); untrusted.push(a.url) }
    } else if (it?.type === 'message' && Array.isArray(it.content)) {
      for (const part of it.content as Array<{ type?: string; text?: string; annotations?: Annotation[] }>) {
        for (const an of part.annotations ?? []) {
          if (an.type !== 'url_citation') continue
          add(read, an.title, an.url)
          untrusted.push(`${an.title ?? ''} ${an.url ?? ''}`.trim())
          // The cited span is text the search brought in.
          if (typeof part.text === 'string' && typeof an.start_index === 'number' && typeof an.end_index === 'number') untrusted.push(part.text.slice(an.start_index, an.end_index))
        }
      }
    }
  }
  return { found, read, untrusted: untrusted.filter(Boolean), searches, fetches, errors }
}

/** Server-sent events: the `data:` payload of each event (blank-line separated), parsed as JSON. */
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
    try { yield JSON.parse(text) as Record<string, unknown> } catch { /* a keep-alive or partial line */ }
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

/** Stream errors (an `error` event, or response.failed) carry a code but no HTTP status: map it so retries work. */
const EVENT_STATUS: Record<string, number> = { rate_limit_exceeded: 429, server_error: 500, server_is_overloaded: 503, service_unavailable_error: 503, timeout: 408, internal_error: 500 }

export async function* streamResponses(req: ChatRequest): AsyncGenerator<StreamPart> {
  if (!req.apiKey) throw new Error('Add your OpenAI API key in Settings → Models to use GPT models.')
  const drop = dropped.get(req.model) ?? new Set<Optional>()
  let res: Response
  let built: ReturnType<typeof buildResponsesRequest>
  for (let fix = 0; ; fix++) {
    built = buildResponsesRequest(req, drop)
    res = await fetch(`${req.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(built.body),
      signal: req.signal
    })
    if (res.ok && res.body) break
    const text = await res.text().catch(() => '')
    let err: { message?: string; type?: string; code?: string | null; param?: string | null } | undefined
    try { err = (JSON.parse(text) as { error?: typeof err }).error } catch { err = { message: text.slice(0, 300) } }
    // A field this model or account doesn't take: drop it, remember that, and send again (nothing was billed).
    const p = optionalParam(res.status, err, built.body)
    if (p && fix < OPTIONAL.length && !drop.has(p)) { drop.add(p); dropped.set(req.model, drop); continue }
    throw openaiError(res.status, err, res.headers, req.model)
  }

  let final: { status?: string; model?: string; output?: Item[]; usage?: ResponsesUsage | null; incomplete_details?: { reason?: string } | null; service_tier?: string } | undefined
  let streamedText = false
  let lastTextItem: unknown
  let lastSummary: string | undefined
  let reasoned = false
  for await (const ev of sse(res.body!)) {
    const type = ev.type as string | undefined
    if (type === 'response.output_item.added') {
      const it = ev.item as Item | undefined
      if (it?.type === 'function_call' && typeof it.name === 'string') yield { type: 'tool_pending', name: it.name }
      else if (it?.type === 'web_search_call') yield { type: 'tool_pending', name: 'web_search' }
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = String(ev.delta ?? '')
      if (!delta) continue
      // Separate messages (a preamble before tool calls, then the answer) read as paragraphs.
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
    } else if (type === 'response.failed') {
      const r = ev.response as { error?: { code?: string; message?: string } } | undefined
      const code = r?.error?.code ?? 'server_error'
      // openaiError keeps its own status where it sets one (402 for billing: never retried, Auto moves on).
      throw openaiError(EVENT_STATUS[code] ?? (/server|overload/.test(code) ? 500 : undefined), { message: r?.error?.message, code }, undefined, req.model)
    } else if (type === 'error') {
      // The details may sit on the event itself or in a nested `error` object.
      const e = (ev.error && typeof ev.error === 'object' ? ev.error : ev) as { code?: unknown; message?: unknown; param?: unknown; type?: unknown }
      const code = String(e.code ?? e.type ?? '')
      const status = EVENT_STATUS[code] ?? (/rate/.test(code) ? 429 : /overload|server/.test(code) ? 500 : undefined)
      // As seen live: {type:'error', error:{code:'insufficient_quota'}} on an account with no credit. openaiError
      // gives it status 402 (not retried; Auto marks the model and moves on), so its status isn't overwritten.
      throw openaiError(status, { message: String(e.message ?? 'OpenAI stream error'), code, param: (e.param as string | null) ?? null }, undefined, req.model)
    }
  }
  // The stream ended without a final event: the connection dropped. Worth another try.
  if (!final) throw Object.assign(new Error('The connection to OpenAI closed before the reply finished.'), { network: true })

  const output = (final.output ?? []).filter((it): it is Item => !!it && typeof it === 'object')
  const served = final.model ?? req.model
  const reason = final.incomplete_details?.reason
  const cut = final.status === 'incomplete' && reason === 'max_output_tokens'

  // Text the stream didn't deliver as deltas (some proxies send only the final response).
  if (!streamedText) {
    const text = output.filter((it) => it.type === 'message').flatMap((it) => (it.content as Array<{ type?: string; text?: string; refusal?: string }> | undefined) ?? []).map((p) => (p.type === 'refusal' ? p.refusal : p.text) ?? '').filter(Boolean).join('\n\n')
    if (text) yield { type: 'content', text }
  }

  const web = webFindings(output)
  if (final.usage) {
    const c = responsesCost(served, final.usage, web.searches + web.fetches)
    // Billing-equivalent tokens at the standard rate; the real prompt size picks the price tier (budget.tierTokens).
    // The tier that ran, when fast mode was asked for (a downgraded request says "default": standard price).
    const ran = built.body.service_tier ? servedTier(final.service_tier) ?? (built.body.service_tier as 'fast' | 'ultrafast') : undefined
    yield { type: 'usage', promptTokens: c.billedInput, completionTokens: c.output, prompt: c.prompt, extraUsd: c.extraUsd, cachedTokens: c.cached, cacheWriteTokens: c.written, reasoningTokens: c.reasoning, webCalls: web.searches + web.fetches, ...(ran ? { serviceTier: ran } : {}) }
  }
  if (web.searches || web.fetches || web.found.length || web.read.length) yield { type: 'server_tools', ...web }

  // Cut off by max_output_tokens: a half-written call must not run (and has no output to pair with).
  const kept = cut ? output.filter((it) => it.type !== 'function_call') : output
  const compacted = kept.some((it) => it.type === 'compaction')
  if (kept.length) yield { type: 'raw', provider: 'openai', model: req.model, content: kept, ...(compacted ? { compacted: true } : {}) }

  if (final.status === 'incomplete' && reason === 'content_filter') {
    yield { type: 'content', text: '\n\n_OpenAI stopped this reply under its content filter._ You can rephrase the request, or pick another model for this chat.' }
    yield { type: 'finish', reason: 'content_filter' }
    return
  }
  const calls: ToolCall[] = cut ? [] : output
    .filter((it) => it.type === 'function_call')
    .map((it) => ({ id: String(it.call_id ?? it.id), name: String(it.name ?? ''), arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}) }))
  if (calls.length) yield { type: 'tool_calls', calls }
  yield { type: 'finish', reason: cut ? 'length' : calls.length ? 'tool_calls' : 'stop' }
}

// ---------------------------------------------------------------------------------------------------
// What the agent loop asks for: the window, server compaction and per-chat request options.
// ---------------------------------------------------------------------------------------------------

/** The append-only cloud window for a model: OpenAI's (context strategy over its table) or Claude's. */
export function cloudWindow(model: string, strategy: ContextStrategy = 'balanced'): number {
  return openaiInfo(model) && !/^claude-/i.test(model) ? openaiWindow(model, strategy) : claudeWindow(model, strategy)
}

/**
 * The window for an OpenAI model that isn't on the Responses path (an older GPT over Chat Completions): its
 * table window under the context strategy instead of the local context-window setting. undefined: not
 * OpenAI, or no window known (the caller's local rule applies).
 */
export function openaiChatWindow(provider: string, model: string, strategy: ContextStrategy = 'balanced'): number | undefined {
  if (provider !== 'openai' || !openaiInfo(model)?.contextTokens) return undefined
  return openaiWindow(model, strategy)
}

/** Whether this model compacts on the server (an OpenAI Responses model with compaction). */
export const openaiServerCompaction = (baseUrl: string, model: string): boolean => usesResponses(baseUrl, model) && !!openaiInfo(model)?.compaction

/**
 * Request options for one agent step on an OpenAI Responses model ({} for anything else): built-in web
 * search when web search is on, the chat as prompt_cache_key, the long cache lifetime for runs whose
 * requests can be far apart, and server-side compaction near the window (not for voice).
 */
export function openaiRequest(o: { baseUrl: string; model: string; threadId: string; window: number; voice?: boolean; web?: boolean; long?: boolean }): Partial<Pick<ChatRequest, 'native' | 'cacheTtl' | 'compactAt' | 'cacheKey'>> {
  if (!usesResponses(o.baseUrl, o.model)) return {}
  return {
    native: { enabled: false, web: !!o.web },
    cacheKey: `sahilbot:${o.threadId}`,
    cacheTtl: o.long ? '1h' : '5m',
    ...(openaiInfo(o.model)?.compaction && !o.voice ? { compactAt: openaiCompactAt(o.window) } : {})
  }
}
