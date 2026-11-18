import Anthropic from '@anthropic-ai/sdk'
import type { ToolCall } from '@shared/types'
import { SERVER_COMPACTION_INSTRUCTIONS } from './summary-format'
import type { ChatRequest, StreamPart, WireMessage } from './client'
import { retryAfterFrom } from './retry'
import { priceFor } from './budget'
import { CACHE_WRITE_1H_FACTOR, CACHE_WRITE_FACTOR, cacheReadFactor, claudeInfo, claudeThinking } from './claude-models'
import { nativePlan, serverFindings, serverToolUsd, type NativePlan } from './claude-native'
import { FETCH_MAX_USES, SEARCH_MAX_USES } from './claude-native/server'
import { RequestGuard, capError, requestLimits } from './request-guard'
import { fastSupport } from './fast-mode'

export { forClaude } from './claude-native'

// Native Claude path (Anthropic SDK). Follows the Messages API rules for current models
// (claude-api reference: shared/models.md, shared/model-migration.md, shared/prompt-caching.md,
// shared/tool-use-concepts.md):
// - assistant turns are sent back exactly as Claude returned them (thinking, server tool and compaction
//   blocks included), so the history stays append-only; preserved-thinking models also carry
//   thinking.block_binding drop_block, so a history edit degrades (a dropped thinking block) instead of a 400;
// - all tool results for one assistant turn go in a single user message;
// - no custom sampling, no forced tool_choice (Opus 5.5 / Sonnet 5.5 / Fable 5.1 reject it), parallel tool use on;
// - prompt caching: an explicit breakpoint on the system prompt (caches tools + system), one on the previous
//   request's tail (always within the 20-block lookback), and automatic caching for the growing end;
//   1-hour TTL for long agent runs and team helpers, where gaps between requests pass five minutes;
// - Claude's native tool types (claude-native/) when the run allows them, translated back to SahilBot's;
// - server-side compaction (compact_20260112) when the chat nears its context strategy's window.

// A key from the Console is an API key (x-api-key). A sign-in token from `ant auth login` or
// similar is sent as a Bearer token with the OAuth beta header. Unknown prefixes are tried both ways
// once, using the free models list, and the working style is remembered.
const clients = new Map<string, Anthropic>()
const make = (key: string, bearer: boolean): Anthropic =>
  bearer
    ? new Anthropic({ apiKey: null, authToken: key, maxRetries: 2, defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' } })
    : new Anthropic({ apiKey: key, maxRetries: 2 })

async function client(key: string): Promise<Anthropic> {
  const hit = clients.get(key)
  if (hit) return hit
  if (key.startsWith('sk-ant-api')) { const c = make(key, false); clients.set(key, c); return c }
  if (key.startsWith('sk-ant-oat')) { const c = make(key, true); clients.set(key, c); return c }
  for (const bearer of [false, true]) {
    const c = make(key, bearer)
    try {
      await c.models.list({ limit: 1 })
      clients.set(key, c)
      return c
    } catch (e) {
      if (!(e instanceof Anthropic.AuthenticationError) && !(e instanceof Anthropic.PermissionDeniedError)) throw e
    }
  }
  throw new Error('Anthropic rejected this key. Check it in Settings (API keys start with sk-ant-api).')
}

type Block = Anthropic.Beta.Messages.BetaContentBlockParam
type Param = Anthropic.Beta.Messages.BetaMessageParam

/** Beta headers this module sends (each from the reference, each only with the feature that needs it). */
export const BETA = {
  fallback: 'server-side-fallback-2026-07-01',
  binding: 'thinking-binding-controls-2026-08-01',
  compaction: 'compact-2026-01-12',
  /** Fast mode on Opus 5 (research preview) and Opus 4.8 (deprecated); Fable / Mythos 5.2 and Opus 5.5 need none. */
  fast: 'fast-mode-2026-02-01'
} as const

/**
 * Output ceiling actually sent for Claude (the budget check prices this worst case). Higher effort
 * thinks longer, so it gets more room (Anthropic suggests 64k at xhigh/max for agent work), never past
 * what the model accepts (Haiku 4.5: 64K; current models: 128K).
 */
export const claudeMaxTokens = (requested: number, effort?: import('@shared/types').Effort, model?: string): number => {
  const want = Math.max(requested, effort === 'max' || effort === 'xhigh' ? 64000 : effort === 'high' ? 32000 : 16000)
  const cap = model ? claudeInfo(model)?.maxOutput : undefined
  return cap ? Math.min(want, cap) : want
}

/** Server-side refusal fallbacks (Claude API): Opus 5 / 5.5, Fable 5.1, Sonnet 5.5 (not Haiku 5.5: none exists). */
export const fallbacks = (model: string): boolean => !!claudeInfo(model)?.fallback

function imageBlock(url: string): Block | null {
  const m = url.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/)
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/png', data: m[2] } } : null
}

function text(content: WireMessage['content']): { text: string; images: Block[] } {
  if (content === null) return { text: '', images: [] }
  if (typeof content === 'string') return { text: content, images: [] }
  return {
    text: content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'),
    images: content.filter((p) => p.type === 'image_url').map((p) => imageBlock((p as { image_url: { url: string } }).image_url.url)).filter((b): b is Block => !!b)
  }
}

/** Results of native tools that failed: flagged is_error so Claude recovers (tool-use-concepts.md). */
const FAILED = /^(Error:|Blocked:|Not executed:|Skipped:|The user declined|Unknown tool|Invalid arguments)/

/**
 * OpenAI-shaped history -> Anthropic messages (system separated, tool results grouped). With a native plan,
 * turns rebuilt from SahilBot's own calls (another model's turns, or turns before a summary) use the names
 * the request declares; a call to a tool the request doesn't offer becomes plain text with its result, and
 * results of Claude's computer toolset calls carry toolset_name.
 */
export function toAnthropic(wire: WireMessage[], model: string, opts: { plan?: NativePlan } = {}): { system: string; messages: Param[] } {
  const plan = opts.plan
  const system = wire.filter((m) => m.role === 'system').map((m) => text(m.content).text).join('\n\n')
  const out: Param[] = []
  /** Tool calls written out as text (their tool isn't offered here): their results follow as text too. */
  const asText = new Map<string, string>()
  /** Claude's computer toolset calls: their results echo toolset_name (rejected without it). */
  const toolset = new Set<string>()
  /** Claude's other native calls (bash, text editor): failures come back with is_error. */
  const native = new Set<string>()
  const pushUser = (blocks: Block[]): void => {
    const last = out[out.length - 1]
    if (last?.role === 'user' && Array.isArray(last.content)) (last.content as Block[]).push(...blocks)
    else out.push({ role: 'user', content: blocks })
  }
  for (const m of wire) {
    if (m.role === 'system') continue
    if (m.role === 'assistant') {
      // Same model: Claude's own blocks, unchanged. Otherwise rebuild text + tool_use without thinking.
      const raw = m.raw as { provider?: string; model?: string; content?: Block[] } | undefined
      if (raw?.provider === 'anthropic' && raw.model === model && Array.isArray(raw.content)) {
        for (const b of raw.content as Array<{ type?: string; id?: string; name?: string; toolset_name?: string }>) {
          if (b?.type !== 'tool_use' || !b.id) continue
          if (b.toolset_name) toolset.add(b.id)
          else if (b.name === 'bash' || b.name === 'str_replace_based_edit_tool') native.add(b.id)
        }
        out.push({ role: 'assistant', content: raw.content })
        continue
      }
      const blocks: Block[] = []
      let t = text(m.content).text
      const uses: Block[] = []
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { input = {} }
        const name = plan ? plan.declaredName(c.function.name) : c.function.name
        if (!name) {
          asText.set(c.id, c.function.name)
          t += `${t ? '\n' : ''}[Called ${c.function.name} ${c.function.arguments || '{}'}]`
          continue
        }
        uses.push({ type: 'tool_use', id: c.id, name, input })
      }
      if (t) blocks.push({ type: 'text', text: t })
      blocks.push(...uses)
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      const body = text(m.content).text || '(empty)'
      const id = m.tool_call_id!
      if (asText.has(id)) { pushUser([{ type: 'text', text: `[Result of ${asText.get(id)}]\n${body}` }]); continue }
      const result: Record<string, unknown> = { type: 'tool_result', tool_use_id: id, content: body }
      if (toolset.has(id)) result.toolset_name = 'computer'
      if ((toolset.has(id) || native.has(id)) && FAILED.test(body)) result.is_error = true
      pushUser([result as unknown as Block])
      continue
    }
    // user: tool images ride inside the preceding tool_result when there is one
    const { text: t, images } = text(m.content)
    const last = out[out.length - 1]
    const results = last?.role === 'user' && Array.isArray(last.content) ? (last.content as Block[]).filter((b) => b.type === 'tool_result') : []
    const prevResult = results.find((b) => (b as { tool_use_id?: string }).tool_use_id === m.imagesFor) ?? results[results.length - 1]
    if (prevResult && images.length && /^\[Image returned by /.test(t)) {
      const r = prevResult as Anthropic.Beta.Messages.BetaToolResultBlockParam
      r.content = [{ type: 'text', text: typeof r.content === 'string' ? r.content : '' }, ...(images as Anthropic.Beta.Messages.BetaImageBlockParam[])]
      continue
    }
    pushUser([...images, ...(t ? [{ type: 'text' as const, text: t }] : [])])
  }
  // The API needs a user message first.
  if (out[0]?.role !== 'user') out.unshift({ role: 'user', content: '(continue)' })
  return { system, messages: out }
}

const CACHEABLE = new Set(['text', 'image', 'tool_result', 'document'])

/**
 * The rolling read point: the last block of the user message before the newest assistant turn, i.e. the
 * end of the previous request's prompt, where that request's automatic breakpoint wrote the cache. With
 * it the next request always finds the history within the 20-block lookback (shared/prompt-caching.md),
 * however many blocks the newest turn added. Blocks are copied, never edited in place (stored raw
 * content stays exactly as Claude returned it).
 */
export function markPreviousTail(messages: Param[], cc: Record<string, unknown>): boolean {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { lastAssistant = i; break }
  const prev = lastAssistant > 0 ? messages[lastAssistant - 1] : undefined
  if (!prev || prev.role !== 'user') return false
  const content: Block[] = typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : [...(prev.content as Block[])]
  const i = content.length - 1
  if (i < 0 || !CACHEABLE.has(content[i].type)) return false
  content[i] = { ...content[i], cache_control: cc } as unknown as Block
  messages[lastAssistant - 1] = { ...prev, content }
  return true
}

/**
 * The request body for one Claude call (without `stream`): pure, so the shape can be pinned down in tests.
 * Exported with the native plan, which turns Claude's tool_use blocks back into SahilBot's calls.
 */
export function buildClaudeRequest(req: ChatRequest): { params: Record<string, unknown>; plan: NativePlan } {
  const spec = claudeInfo(req.model)
  const plan = nativePlan(req.model, req.tools ?? [], req.native ?? { enabled: false })
  const { system, messages } = toAnthropic(req.messages, req.model, { plan })
  const cc: Record<string, unknown> = req.cacheTtl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' }
  const systemText = [system, plan.systemNote].filter(Boolean).join('\n\n')
  markPreviousTail(messages, cc)
  const betas = new Set<string>()
  const thinking = claudeThinking(req.model, req.effort) as { thinking?: Record<string, unknown>; output_config?: Record<string, unknown> }
  if (req.noThinking) delete thinking.thinking
  // Preserved thinking: a history edit drops the affected thinking blocks instead of failing the request.
  if (thinking.thinking && spec?.preservedThinking) {
    thinking.thinking = { ...thinking.thinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } }
    betas.add(BETA.binding)
  }
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: claudeMaxTokens(req.maxTokens, req.effort, req.model),
    // One explicit breakpoint on the static prefix: caches tools + system together, whatever happens later.
    ...(systemText ? { system: [{ type: 'text', text: systemText, cache_control: cc }] } : {}),
    messages,
    // Automatic caching for the growing conversation tail (same TTL as the explicit markers).
    cache_control: cc,
    ...(plan.tools.length ? { tools: plan.tools, tool_choice: { type: 'auto' } } : {}),
    // Adaptive thinking + the app's thinking level as effort, mapped to what this model accepts.
    ...thinking
  }
  // Server-side compaction near the end of the chat's context budget (never below the API's 50K minimum).
  if (req.compactAt && spec?.compaction) {
    // instructions: the same fixed checkpoint sections as the client summarizer (llm/summary-format.ts). They replace
    // the default prompt entirely (compaction-threshold docs), so they restate its job too. (On the 5.5 / 5.2 models a
    // custom prompt summarizes the visible conversation without earlier thinking; the app's brief and notes, re-sent
    // after the block, are what carry the task's facts.)
    params.context_management = { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: Math.max(50_000, Math.round(req.compactAt)) }, instructions: SERVER_COMPACTION_INSTRUCTIONS }] }
    betas.add(BETA.compaction)
  }
  if (fallbacks(req.model)) {
    params.fallbacks = 'default'
    betas.add(BETA.fallback)
  }
  // Fast mode (llm/fast-mode.ts): speed "fast" on the models that have it, up to 2.5x output speed at 2x price.
  const fastSup = req.fast ? fastSupport(req.model) : undefined
  if (fastSup?.provider === 'anthropic') {
    params.speed = 'fast'
    if (fastSup.beta) betas.add(BETA.fast)
  }
  if (betas.size) params.betas = [...betas]
  return { params, plan }
}

/** Input tokens in billing terms (what the budget prices at the input rate). */
export function billedInput(model: string, u: {
  input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
}): number {
  const c = u.cache_creation
  // 1-hour writes cost 2x, 5-minute writes 1.25x (usage.cache_creation splits them by TTL when present).
  const writes = c && (c.ephemeral_1h_input_tokens || c.ephemeral_5m_input_tokens)
    ? CACHE_WRITE_FACTOR * (c.ephemeral_5m_input_tokens ?? 0) + CACHE_WRITE_1H_FACTOR * (c.ephemeral_1h_input_tokens ?? 0)
    : CACHE_WRITE_FACTOR * (u.cache_creation_input_tokens ?? 0)
  return Math.round((u.input_tokens ?? 0) + writes + cacheReadFactor(model) * (u.cache_read_input_tokens ?? 0))
}

type Usage = Parameters<typeof billedInput>[1] & {
  output_tokens?: number | null
  iterations?: Array<{ type?: string; input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }> | null
  server_tool_use?: { web_search_requests?: number | null; web_fetch_requests?: number | null } | null
}

/**
 * One response's usage in billing terms: the message's own tokens, plus any compaction iteration (the
 * top-level counts leave it out: "sum across all entries in usage.iterations"), plus server tool fees
 * (web search, $10 per 1,000) expressed as input tokens at the rate the budget will charge.
 */
export function billedUsage(model: string, u: Usage, extraUsd = 0): { input: number; output: number } {
  let input = billedInput(model, u)
  let output = u.output_tokens ?? 0
  for (const it of u.iterations ?? []) {
    if (it?.type !== 'compaction') continue
    input += billedInput(model, it)
    output += it.output_tokens ?? 0
  }
  if (extraUsd > 0) input += Math.round((extraUsd * 1e6) / priceFor(model, input).input)
  return { input, output }
}

/** What the user sees when Claude's safety classifiers decline (stop_details is set only for refusals). */
export function refusalNote(d: { category?: string | null; explanation?: string | null } | null | undefined): string {
  const why = d?.category ? ` (${d.category.replace(/_/g, ' ')})` : ''
  return `_Claude declined this request${why}._${d?.explanation ? ` ${d.explanation}` : ''} You can rephrase it, or pick another model for this chat.`
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const ids: string[] = []
  for await (const m of (await client(apiKey)).models.list()) ids.push(m.id)
  return ids.sort()
}

/** A reply cut off by max_tokens: client tool calls and server tool calls without their result are dropped. */
export function droppedWhenCut(content: Array<{ type?: string; id?: string; tool_use_id?: string }>): typeof content {
  const answered = new Set(content.map((b) => b.tool_use_id).filter(Boolean))
  return content.filter((b) => b.type !== 'tool_use' && !(b.type === 'server_tool_use' && !answered.has(b.id)))
}

/** SahilBot's tool name for a block that has started streaming (for the "drafting…" status). */
function pendingName(plan: NativePlan, b: { type: string; name?: string; toolset_name?: string }): string | undefined {
  if (b.type === 'server_tool_use') return b.name === 'web_fetch' ? 'fetch_page' : b.name === 'web_search' ? 'web_search' : b.name
  if (b.type !== 'tool_use' || !b.name) return undefined
  return plan.fromNative({ id: '', name: b.name, input: {}, toolset_name: b.toolset_name }).name
}

const STREAM_ERROR_STATUS: Record<string, number> = { overloaded_error: 529, rate_limit_error: 429, api_error: 500, timeout_error: 408 }
/** A long server-tool turn may pause (stop_reason pause_turn): resumed this many times at most. */
export const MAX_CONTINUATIONS = 4

export async function* streamAnthropic(req: ChatRequest): AsyncGenerator<StreamPart> {
  if (!req.apiKey) throw new Error('Add your Anthropic API key in Settings to use Claude.')
  const { params, plan } = buildClaudeRequest(req)
  const baseMessages = params.messages as Param[]
  /** Fast mode was asked for (the reply's usage.speed says whether it ran; a 429 / 529 falls back to standard). */
  const askedFast = !!params.speed
  // Idle and wall-clock limits for the whole request, continuations included (request-guard.ts).
  const guard = new RequestGuard(req.signal)
  const hasServerTools = ((params.tools as Array<{ type?: string }> | undefined) ?? []).some((t) => /^web_(search|fetch)_/.test(String(t.type ?? '')))
  try {
    yield* claudeAttempts(req, params, plan, baseMessages, askedFast, guard, hasServerTools)
  } finally {
    guard.done()
  }
}

async function* claudeAttempts(req: ChatRequest, params: ReturnType<typeof buildClaudeRequest>['params'], plan: NativePlan, baseMessages: Param[], askedFast: boolean, guard: RequestGuard, hasServerTools: boolean): AsyncGenerator<StreamPart> {
  const who = req.model

  for (let attempt = 0; ; attempt++) {
    let streamed = false
    // Everything this turn produced, across pause_turn continuations (consecutive assistant messages
    // are one turn to the API, so they are stored and replayed as one).
    let content: Anthropic.Beta.Messages.BetaContentBlock[] = []
    let input = 0
    let output = 0
    let prompt = 0
    let searches = 0
    let fetches = 0
    /** The turn stopped before the server finished it (its search budget or the clock): said in the reply. */
    let capped: 'searches' | 'time' | undefined
    let cachedRead = 0
    let cacheWrite = 0
    let speed: string | undefined
    let final: Anthropic.Beta.Messages.BetaMessage | undefined
    try {
      for (let cont = 0; ; cont++) {
        const messages = content.length ? [...baseMessages, { role: 'assistant' as const, content: content as unknown as Block[] }] : baseMessages
        // The SDK's own retries are off here: streamChat retries transient failures (with a reset when
        // something already streamed), so a failure is never retried twice over.
        const stream = (await client(req.apiKey!)).beta.messages.stream({ ...params, messages } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming, { signal: guard.signal, maxRetries: 0 })
        stream.on('text', () => undefined)
        for await (const ev of stream) {
          guard.touch()
          if (ev.type === 'content_block_start') {
            const name = pendingName(plan, ev.content_block as { type: string; name?: string; toolset_name?: string })
            if (name) yield { type: 'tool_pending', name }
          }
          if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') { streamed = true; yield { type: 'content', text: ev.delta.text } }
            else if (ev.delta.type === 'thinking_delta') { streamed = true; yield { type: 'reasoning', text: ev.delta.thinking } }
          }
        }
        final = await stream.finalMessage()
        content = [...content, ...final.content]
        const f = serverFindings(final.content, final.usage as Usage)
        searches += f.searches
        fetches += f.fetches
        const b = billedUsage(final.model ?? req.model, final.usage as Usage)
        input += b.input
        output += b.output
        // The real prompt size (input + cache writes + cache reads) picks the price tier (budget.tierTokens).
        const u = final.usage as Usage
        prompt = Math.max(prompt, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0))
        cachedRead += u.cache_read_input_tokens ?? 0
        cacheWrite += u.cache_creation_input_tokens ?? 0
        // usage.speed: "fast" or "standard" (fast mode page "Checking which speed was used").
        speed = (u as { speed?: string }).speed ?? speed
        if (final.stop_reason !== 'pause_turn' || cont >= MAX_CONTINUATIONS || req.signal?.aborted) break
        // A paused server-tool turn goes on only within the turn's budget: another continuation may use up to its
        // max_uses again (the tools stay as they are: changing them would rewrite the cached prompt), and not when
        // most of the request's time is gone. Otherwise the turn ends here with what it found.
        if (searches + SEARCH_MAX_USES > requestLimits.turnSearches || fetches + FETCH_MAX_USES > requestLimits.turnFetches) { capped = 'searches'; break }
        if (guard.nearWall()) { capped = 'time'; break }
      }
    } catch (e) {
      // A limit stopped it (request-guard.ts): a clear message, never retried (the same request would run as long).
      if (guard.stopped) throw capError(guard.stopped, { who: `${who}${hasServerTools ? ' (with web search)' : ''}`, searches })
      // A tool input that couldn't be parsed at all: re-issue the turn (at most twice). API errors propagate, readably.
      if (e instanceof Anthropic.APIError) {
        const body = e.error as { error?: { message?: string; type?: string }; type?: string } | undefined
        const why = body?.error?.message ?? e.message
        const network = e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIUserAbortError)
        // Errors sent mid-stream (an SSE "error" event on a 200) carry a type but no status: map it so retries work.
        const type = body?.error?.type ?? body?.type ?? (e as { type?: string }).type
        const status = e.status ?? STREAM_ERROR_STATUS[type ?? '']
        // Fast mode over its own rate limit or capacity (429 / 529): the documented fallback is the same request at
        // standard speed (and standard price), sent once, before anything streamed.
        if (params.speed && (status === 429 || status === 529) && !streamed && !req.signal?.aborted) {
          delete params.speed
          if (Array.isArray(params.betas)) { params.betas = (params.betas as string[]).filter((b) => b !== BETA.fast); if (!(params.betas as string[]).length) delete params.betas }
          continue
        }
        // "Your credit balance is too low to access the Anthropic API" comes as a 400: account-wide and not
        // retryable, so it gets 402 (Auto skips Claude for a while and moves on: llm/model-health.ts).
        const credit = /credit balance|billing/i.test(why) && (status === 400 || status === 402 || status === 403)
        const err = new Error(credit ? `Anthropic won't run more requests on this account right now (${why}). Check your Anthropic billing.` : status === 401 ? 'Anthropic rejected the API key. Check it in Settings.' : status === 429 ? 'Claude is rate-limiting requests right now. Try again in a moment.' : status === 529 || status === 408 || (status ?? 0) >= 500 ? 'Claude is overloaded or unavailable right now. Try again shortly.' : network ? `Couldn't reach Claude: ${why}` : `Claude rejected the request: ${why}`)
        // What streamChat's retry needs: the status, the server's Retry-After, and whether the connection dropped.
        Object.assign(err, { billed: false, status: credit ? 402 : status, retryAfterMs: retryAfterFrom(e.headers), network })
        throw err
      }
      if (req.signal?.aborted || attempt >= 2) throw e
      if (streamed) yield { type: 'reset' }
      continue
    }
    if (!final) throw new Error('Claude returned no message.')
    // Ended at a pause by the turn's budget: the reply says so (a server tool call still waiting for its result is
    // dropped, so the stored turn replays cleanly).
    if (capped && final.stop_reason === 'pause_turn') {
      content = droppedWhenCut(content as Array<{ type?: string; id?: string; tool_use_id?: string }>) as typeof content
      yield { type: 'content', text: capped === 'searches' ? `\n\n_(Stopped searching here: this reply used ${searches} web searches${fetches ? ` and ${fetches} page reads` : ''}, its limit for one reply. Say "continue" to keep researching.)_` : '\n\n_(Stopped here: this reply ran close to its time limit. Say "continue" to pick up from here.)_' }
      final = { ...final, stop_reason: 'end_turn' }
    }
    const served = final.model ?? req.model

    // Billing-equivalent input: cache writes 1.25x (1h: 2x), reads 0.1x (0.05x Opus 5.5, 0.025x Fable 5.1),
    // compaction iterations, and web searches at $10 per 1,000.
    const fee = serverToolUsd({ searches })
    yield { type: 'usage', promptTokens: input, completionTokens: output, prompt, cachedTokens: cachedRead, cacheWriteTokens: cacheWrite, ...(searches ? { webCalls: searches } : {}), ...(askedFast ? { serviceTier: (speed ? speed === 'fast' : !!params.speed) ? 'fast' as const : 'standard' as const } : {}), ...(fee ? { extraUsd: fee } : {}) }

    // Server tools (web search / fetch) ran inside the request: their sources and their outside text.
    const found = serverFindings(content)
    found.searches = searches
    if (found.found.length || found.read.length || found.untrusted.length || found.searches || found.fetches) yield { type: 'server_tools', ...found }

    // Cut off mid tool call: keep the text, drop the half-written tool_use (it would have no tool_result).
    const cut = final.stop_reason === 'max_tokens'
    const kept = cut ? droppedWhenCut(content as Array<{ type?: string; id?: string; tool_use_id?: string }>) as typeof content : content
    const compacted = kept.some((b) => (b as { type: string; content?: unknown }).type === 'compaction' && !!(b as { content?: unknown }).content)
    if (kept.length) yield { type: 'raw', provider: 'anthropic', model: served, content: kept, ...(compacted ? { compacted: true } : {}) }

    if (final.stop_reason === 'refusal') {
      yield { type: 'content', text: `\n\n${refusalNote(final.stop_details)}` }
      yield { type: 'finish', reason: 'refusal' }
      return
    }
    // A reply cut off mid tool call must not run that tool. Native tool calls become SahilBot's own.
    const calls: ToolCall[] = cut ? [] : content
      .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => plan.fromNative({ id: b.id, name: b.name, input: b.input, toolset_name: (b as { toolset_name?: string }).toolset_name }))
    if (calls.length) yield { type: 'tool_calls', calls }
    yield { type: 'finish', reason: final.stop_reason ?? 'end_turn' }
    return
  }
}

