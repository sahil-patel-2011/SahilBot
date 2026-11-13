import Anthropic from '@anthropic-ai/sdk'
import type { ToolCall } from '@shared/types'
import type { ChatRequest, StreamPart, WireMessage } from './client'
import { retryAfterFrom } from './retry'

// Native Claude path (Anthropic SDK). Follows the Messages API rules for current models:
// - assistant turns are sent back exactly as Claude returned them (thinking blocks included),
//   so the history stays append-only;
// - all tool results for one assistant turn go in a single user message;
// - no custom sampling (current models reject temperature/top_p);
// - automatic prompt caching on the stable prefix (system + tools + history).

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

/** Models that accept adaptive thinking (all current ones except Haiku 4.5). */
const adaptive = (model: string): boolean => !/haiku-4-5|^claude-3/.test(model)
/**
 * Output ceiling actually sent for Claude (the budget check prices this worst case). Higher effort
 * thinks longer, so it gets more room (Anthropic suggests 64k at xhigh/max for agent work).
 */
export const claudeMaxTokens = (requested: number, effort?: import('@shared/types').Effort): number =>
  Math.max(requested, effort === 'max' || effort === 'xhigh' ? 64000 : effort === 'high' ? 32000 : 16000)

/** Server-side refusal fallbacks (Claude API): Opus 5/5.5, Fable 5.1, Sonnet 5.5. */
export const fallbacks = (model: string): boolean => /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model)

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

/** OpenAI-shaped history -> Anthropic messages (system separated, tool results grouped). */
export function toAnthropic(wire: WireMessage[], model: string): { system: string; messages: Param[] } {
  const system = wire.filter((m) => m.role === 'system').map((m) => text(m.content).text).join('\n\n')
  const out: Param[] = []
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
        out.push({ role: 'assistant', content: raw.content })
        continue
      }
      const blocks: Block[] = []
      const t = text(m.content).text
      if (t) blocks.push({ type: 'text', text: t })
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(c.function.arguments || '{}') } catch { input = {} }
        blocks.push({ type: 'tool_use', id: c.id, name: c.function.name, input })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
      continue
    }
    if (m.role === 'tool') {
      pushUser([{ type: 'tool_result', tool_use_id: m.tool_call_id!, content: text(m.content).text || '(empty)' }])
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

/**
 * Claude rejects top-level allOf/anyOf/oneOf in tool schemas. Conditional rules ("ref is required
 * when action is click") move into the description; SahilBot still enforces the full schema locally.
 */
export function forClaude(schema: Record<string, unknown>, description: string): { schema: Record<string, unknown>; description: string } {
  const { allOf, anyOf, oneOf, ...rest } = schema as Record<string, unknown> & { allOf?: unknown[]; anyOf?: unknown[]; oneOf?: unknown[] }
  const rules: string[] = []
  for (const c of [...(allOf ?? []), ...(anyOf ?? []), ...(oneOf ?? [])] as Array<{ if?: { properties?: Record<string, { const?: unknown; enum?: unknown[]; pattern?: string }> }; then?: { required?: string[] } }>) {
    const [field, cond] = Object.entries(c.if?.properties ?? {})[0] ?? []
    const need = c.then?.required
    if (!field || !need?.length) continue
    const when = cond?.const !== undefined ? `${field} is "${cond.const}"` : cond?.enum ? `${field} is ${cond.enum.map((v) => `"${v}"`).join(' or ')}` : cond?.pattern ? `${field} matches ${cond.pattern}` : field
    rules.push(`When ${when}: also give ${need.join(', ')}.`)
  }
  return { schema: rest, description: rules.length ? `${description}\n${rules.join('\n')}` : description }
}

export async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const ids: string[] = []
  for await (const m of (await client(apiKey)).models.list()) ids.push(m.id)
  return ids.sort()
}

export async function* streamAnthropic(req: ChatRequest): AsyncGenerator<StreamPart> {
  if (!req.apiKey) throw new Error('Add your Anthropic API key in Settings to use Claude.')
  const { system, messages } = toAnthropic(req.messages, req.model)
  const tools = (req.tools ?? []).map((t) => {
    const c = forClaude(t.function.parameters, t.function.description)
    return {
    name: t.function.name,
    description: c.description,
    input_schema: c.schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    // Large inputs (file contents) stream as generated; SahilBot validates every input against its schema.
    eager_input_streaming: true
  }
  })
  const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
    model: req.model,
    max_tokens: claudeMaxTokens(req.maxTokens, req.effort),
    system,
    messages,
    stream: true,
    // Caches the whole prefix; resent history then costs about a tenth.
    cache_control: { type: 'ephemeral' },
    ...(tools.length ? { tools, tool_choice: { type: 'auto' } } : {}),
    ...(adaptive(req.model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    ...(adaptive(req.model) ? { output_config: { effort: req.effort ?? 'medium' } } : {}),
    ...(fallbacks(req.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {})
  } as Anthropic.Beta.Messages.MessageCreateParamsStreaming
  const { stream: _s, ...streamParams } = params

  for (let attempt = 0; ; attempt++) {
    // The SDK's own retries are off here: streamChat retries transient failures (with a reset when
    // something already streamed), so a failure is never retried twice over.
    const stream = (await client(req.apiKey)).beta.messages.stream(streamParams, { signal: req.signal, maxRetries: 0 })
    let streamed = false
    stream.on('text', () => undefined)
    let final: Anthropic.Beta.Messages.BetaMessage
    try {
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') yield { type: 'tool_pending', name: ev.content_block.name }
        if (ev.type === 'content_block_delta') {
          if (ev.delta.type === 'text_delta') { streamed = true; yield { type: 'content', text: ev.delta.text } }
          else if (ev.delta.type === 'thinking_delta') { streamed = true; yield { type: 'reasoning', text: ev.delta.thinking } }
        }
      }
      final = await stream.finalMessage()
    } catch (e) {
      // A tool input that couldn't be parsed at all: re-issue the turn (at most twice). API errors propagate, readably.
      if (e instanceof Anthropic.APIError) {
        const body = e.error as { error?: { message?: string } } | undefined
        const why = body?.error?.message ?? e.message
        const network = e instanceof Anthropic.APIConnectionError && !(e instanceof Anthropic.APIUserAbortError)
        const err = new Error(e.status === 401 ? 'Anthropic rejected the API key. Check it in Settings.' : e.status === 429 ? 'Claude is rate-limiting requests right now. Try again in a moment.' : e.status === 529 || (e.status ?? 0) >= 500 ? 'Claude is overloaded or unavailable right now. Try again shortly.' : network ? `Couldn't reach Claude: ${why}` : `Claude rejected the request: ${why}`)
        // What streamChat's retry needs: the status, the server's Retry-After, and whether the connection dropped.
        Object.assign(err, { billed: false, status: e.status, retryAfterMs: retryAfterFrom(e.headers), network })
        throw err
      }
      if (req.signal?.aborted || attempt >= 2) throw e
      if (streamed) yield { type: 'reset' }
      continue
    }

    const u = final.usage
    yield {
      type: 'usage',
      // Billing-equivalent input: cache writes cost 1.25x, cache reads 0.1x.
      promptTokens: Math.round((u.input_tokens ?? 0) + 1.25 * (u.cache_creation_input_tokens ?? 0) + 0.1 * (u.cache_read_input_tokens ?? 0)),
      completionTokens: u.output_tokens ?? 0
    }
    // Cut off mid tool call: keep the text, drop the half-written tool_use (it would have no tool_result).
    const cut = final.stop_reason === 'max_tokens'
    const content = cut ? final.content.filter((b) => b.type !== 'tool_use' && b.type !== 'server_tool_use') : final.content
    if (content.some((b) => b.type === 'text' || b.type === 'tool_use')) yield { type: 'raw', provider: 'anthropic', model: final.model ?? req.model, content }

    if (final.stop_reason === 'refusal') {
      yield { type: 'content', text: '\n\n_Claude declined this request._' }
      yield { type: 'finish', reason: 'refusal' }
      return
    }
    // A reply cut off mid tool call must not run that tool.
    const calls: ToolCall[] = cut ? [] : final.content
      .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }))
    if (calls.length) yield { type: 'tool_calls', calls }
    yield { type: 'finish', reason: final.stop_reason ?? 'end_turn' }
    return
  }
}
