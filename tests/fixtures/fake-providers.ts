import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Deterministic stand-ins for paid model APIs, for endurance tests (tests/unit/endurance.test.ts). Nothing
// here talks to a real provider: both servers listen on 127.0.0.1 and answer from a scripted "model".
//
// FakeAnthropic speaks the Messages API's streaming SSE (enough of it for @anthropic-ai/sdk's
// BetaMessageStream) and simulates what matters for long runs:
// - token counts at a dense ~3.2 characters per token (denser than the app's chars/3.5 estimate, so the
//   app's safety margins are tested, not assumed);
// - server-side compaction (compact_20260112): over the trigger, the reply opens with a compaction block,
//   and every later request is read from that block on ("all content blocks before it are ignored");
// - prompt caching: exact-prefix hits at cache_control breakpoints (explicit, plus the top-level automatic
//   one on the last block) with the 20-block lookback, and the usage split into reads / writes / input;
// - preserved thinking: each thinking block is bound to the prompt prefix it was produced after; a later
//   request whose prefix before that turn differs counts as a dropped thinking block (block_binding drop_block).
// FakeOpenAI speaks chat completions (SSE) with a context limit, and reports prefix stability (what a
// llama.cpp / vLLM KV cache or OpenAI's automatic prompt cache could reuse).

export const fakeTokens = (chars: number): number => Math.ceil(chars / 3.2)

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')))
  })

const chain = (prev: string, piece: string): string => createHash('sha1').update(prev).update('\u0000').update(piece).digest('hex')

// ---------------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------------

type Block = Record<string, any>
export interface ClaudeReply {
  thinking?: string
  text?: string
  tools?: Array<{ name: string; input: Record<string, unknown> }>
}

/** What the fake saw and billed for one request. */
export interface ClaudeRecord {
  n: number
  /** Effective prompt tokens (after any compaction block), as the server counts them. */
  tokens: number
  /** Request messages before the compaction block (sent although the API ignores them), in tokens. */
  ignored: number
  cacheRead: number
  cacheWrite: number
  input: number
  output: number
  /** A compaction block was written in this reply. */
  compacted: boolean
  /** The compaction trigger the request asked for (undefined: none). */
  trigger?: number
  /** The compaction edit's custom summarization prompt (compact_20260112 `instructions`), if any. */
  instructions?: string
  /** The previous request's prompt is a prefix of this one's (append-only). */
  appendOnly: boolean
  /** Where the previous prompt diverged: 'tools' | 'system' | 'messages' (undefined when append-only). */
  diverged?: 'tools' | 'system' | 'messages'
  toolsHash: string
  systemHash: string
  /** Thinking blocks whose bound prefix changed (the API would drop them). */
  droppedThinking: number
  /** Thinking blocks sent back. */
  thinkingSent: number
  /** tool_use ids without a tool_result right after them, and tool_results without their tool_use. */
  orphans: string[]
  /** Cache breakpoints in the request (explicit cache_control markers, the automatic one not counted). */
  breakpoints: number
  ttl?: string
  maxTokens: number
  isSummary: boolean
}

export interface FakeAnthropic {
  url: string
  records: ClaudeRecord[]
  /** The last request body (bodies are big: only the latest is kept, unless keepBodies). */
  last?: Record<string, any>
  bodies: Array<Record<string, any>>
  keepBodies: boolean
  /** Builds the model's reply. ctx.n counts non-summary requests. */
  respond: (body: Record<string, any>, ctx: { n: number; record: ClaudeRecord }) => ClaudeReply
  /** The compaction summary the server writes (default: a lossy one that keeps only a step count). */
  summarize: (effectiveText: string, n: number, instructions?: string) => string
  /** Called with every request before it is answered (e.g. to stop the run mid-task). */
  onRequest?: (body: Record<string, any>, n: number) => void
  /** Forget the step count, the previous prompt and the records (the cache stays, like the real one). */
  reset(): void
  close(): Promise<void>
}

function blockChars(b: Block): number {
  switch (b.type) {
    case 'text': return String(b.text ?? '').length
    case 'thinking': return String(b.thinking ?? '').length
    case 'redacted_thinking': return String(b.data ?? '').length
    case 'tool_use': return String(b.name ?? '').length + JSON.stringify(b.input ?? {}).length
    case 'tool_result': return typeof b.content === 'string' ? b.content.length : (b.content ?? []).reduce((n: number, c: Block) => n + (c.type === 'image' ? 5000 : blockChars(c)), 0)
    case 'compaction': return String(b.content ?? '').length
    case 'image': return 5000
    default: return JSON.stringify(b).length
  }
}
const blockTokens = (b: Block): number => fakeTokens(blockChars(b)) + 4
/** A block as the cache sees it: its content without the cache_control marker. */
const canon = (b: Block): string => {
  const { cache_control: _c, ...rest } = b
  return JSON.stringify(rest)
}
const contentOf = (m: Block): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content as Block[]))

export async function startFakeAnthropic(): Promise<FakeAnthropic> {
  const cache = new Set<string>()
  /** Thinking signature -> hash of the prompt it was produced after. */
  const bindings = new Map<string, string>()
  let prevHashes: string[] = []
  let prevKinds: Array<'tools' | 'system' | 'messages'> = []
  let prevTools = ''
  let prevSystem = ''
  let n = 0
  let requests = 0
  let compactions = 0
  const state: Omit<FakeAnthropic, 'url' | 'close' | 'reset'> = {
    records: [],
    bodies: [],
    keepBodies: false,
    respond: () => ({ text: 'done' }),
    summarize: (_t, k) => `Compaction summary #${k}: the assistant has been working through a long task.`
  }

  function handle(json: Record<string, any>): { events: Array<Record<string, any>> } {
    requests++
    const isSummary = String(Array.isArray(json.system) ? json.system.map((s: Block) => s.text).join('') : json.system ?? '').startsWith('You are compressing')
    if (!isSummary) n++
    state.onRequest?.(json, n)
    const messages = json.messages as Block[]
    // Effective prompt: from the latest compaction block with content on.
    let from = { msg: 0, block: 0 }
    messages.forEach((m, i) => {
      if (m.role !== 'assistant') return
      contentOf(m).forEach((b, j) => { if (b.type === 'compaction' && b.content) from = { msg: i, block: j } })
    })
    let ignored = 0
    const segs: Array<{ hash: string; tokens: number; bp: boolean; kind: 'tools' | 'system' | 'messages'; msg?: number; block?: Block }> = []
    let h = ''
    const push = (piece: string, tokens: number, bp: boolean, kind: 'tools' | 'system' | 'messages', msg?: number, block?: Block): void => {
      h = chain(h, piece)
      segs.push({ hash: h, tokens, bp, kind, msg, block })
    }
    const tools = (json.tools ?? []) as Block[]
    for (const t of tools) push(canon(t), fakeTokens(JSON.stringify(t).length), !!t.cache_control, 'tools')
    const toolsHash = h
    const system = (Array.isArray(json.system) ? json.system : json.system ? [{ type: 'text', text: json.system }] : []) as Block[]
    for (const s of system) push(canon(s), fakeTokens(String(s.text).length), !!s.cache_control, 'system')
    const systemHash = h
    const firstMsgSeg: number[] = []
    messages.forEach((m, i) => {
      const blocks = contentOf(m)
      if (i < from.msg) { ignored += blocks.reduce((x, b) => x + blockTokens(b), 0); return }
      firstMsgSeg[i] = segs.length
      blocks.forEach((b, j) => {
        if (i === from.msg && j < from.block) { ignored += blockTokens(b); return }
        push(`${m.role}:${canon(b)}`, blockTokens(b), !!b.cache_control, 'messages', i, b)
      })
    })
    const tokens = segs.reduce((x, s) => x + s.tokens, 0)
    const cum: number[] = []
    segs.reduce((x, s, i) => (cum[i] = x + s.tokens), 0)

    // Prefix stability against the previous (non-summary) request.
    let appendOnly = true
    let diverged: ClaudeRecord['diverged']
    if (!isSummary && prevHashes.length) {
      const k = prevHashes.length - 1
      if (segs.length <= k || segs[k].hash !== prevHashes[k]) {
        appendOnly = false
        const at = prevHashes.findIndex((x, i) => segs[i]?.hash !== x)
        // A tool appended at the end of the list still changes everything after the tools.
        diverged = toolsHash !== prevTools ? 'tools' : systemHash !== prevSystem ? 'system' : prevKinds[at] ?? 'messages'
      }
    }

    // Preserved thinking: blocks whose prefix differs from the one they were produced after.
    let droppedThinking = 0
    let thinkingSent = 0
    messages.forEach((m, i) => {
      if (m.role !== 'assistant' || i < from.msg) return
      const blocks = contentOf(m)
      if (blocks.some((b) => b.type === 'compaction')) return
      for (const b of blocks) {
        if (b.type !== 'thinking') continue
        thinkingSent++
        const bound = bindings.get(String(b.signature))
        const start = firstMsgSeg[i]
        const prefix = start > 0 ? segs[start - 1].hash : ''
        if (bound !== undefined && bound !== prefix) droppedThinking++
      }
    })

    // tool_use / tool_result pairing (each assistant tool_use answered in the very next user message).
    const orphans: string[] = []
    messages.forEach((m, i) => {
      if (m.role !== 'assistant') return
      const uses = contentOf(m).filter((b) => b.type === 'tool_use').map((b) => String(b.id))
      if (!uses.length) return
      const next = messages[i + 1]
      const answered = new Set(next && next.role === 'user' ? contentOf(next).filter((b) => b.type === 'tool_result').map((b) => String(b.tool_use_id)) : [])
      for (const id of uses) if (!answered.has(id)) orphans.push(id)
    })
    messages.forEach((m, i) => {
      if (m.role !== 'user') return
      const prev = messages[i - 1]
      const uses = new Set(prev && prev.role === 'assistant' ? contentOf(prev).filter((b) => b.type === 'tool_use').map((b) => String(b.id)) : [])
      for (const b of contentOf(m)) if (b.type === 'tool_result' && !uses.has(String(b.tool_use_id))) orphans.push(`result:${b.tool_use_id}`)
    })

    // Prompt cache: explicit breakpoints plus the automatic one on the last block.
    const bps = segs.map((s, i) => (s.bp ? i : -1)).filter((i) => i >= 0)
    const breakpoints = bps.length
    if (json.cache_control && segs.length) bps.push(segs.length - 1)
    const uniq = [...new Set(bps)].sort((a, b) => a - b)
    let hit = -1
    for (const bp of uniq) {
      for (let j = bp; j >= Math.max(0, bp - 20); j--) if (cache.has(segs[j].hash)) { hit = Math.max(hit, j); break }
    }
    const lastBp = uniq.length ? uniq[uniq.length - 1] : -1
    const cacheRead = hit >= 0 ? cum[hit] : 0
    const cacheWrite = lastBp >= 0 ? cum[lastBp] - cacheRead : 0
    const input = tokens - cacheRead - cacheWrite
    for (const bp of uniq) cache.add(segs[bp].hash)

    const edit = (json.context_management?.edits ?? []).find((e: Block) => e.type === 'compact_20260112')
    const trigger = edit?.trigger?.value as number | undefined
    const instructions = typeof edit?.instructions === 'string' ? edit.instructions : undefined
    const compacted = !isSummary && trigger !== undefined && tokens > trigger
    const ttl = (json.cache_control?.ttl as string | undefined) ?? (system[0]?.cache_control?.ttl as string | undefined)
    const record: ClaudeRecord = {
      n: requests, tokens, ignored, cacheRead, cacheWrite, input, output: 0, compacted, trigger, instructions, appendOnly, diverged,
      toolsHash, systemHash, droppedThinking, thinkingSent, orphans, breakpoints, ttl, maxTokens: json.max_tokens, isSummary
    }
    if (!isSummary) {
      prevHashes = segs.map((s) => s.hash)
      prevKinds = segs.map((s) => s.kind)
      prevTools = toolsHash
      prevSystem = systemHash
    }

    // The reply.
    const content: Block[] = []
    let summaryTokens = 0
    if (compacted) {
      compactions++
      const text = segs.filter((s) => s.block).map((s) => (s.block!.type === 'text' ? s.block!.text : s.block!.type === 'tool_result' ? (typeof s.block!.content === 'string' ? s.block!.content : '') : '')).join('\n')
      const summary = state.summarize(text, compactions, instructions)
      summaryTokens = fakeTokens(summary.length)
      content.push({ type: 'compaction', content: summary })
    }
    const reply = isSummary ? { text: 'Checkpoint: work in progress.' } : state.respond(json, { n, record })
    if (reply.thinking) {
      const signature = `sig-${requests}`
      content.push({ type: 'thinking', thinking: reply.thinking, signature })
      bindings.set(signature, segs.length ? segs[segs.length - 1].hash : '')
    }
    if (reply.text) content.push({ type: 'text', text: reply.text })
    reply.tools?.forEach((t, i) => content.push({ type: 'tool_use', id: `toolu_${requests}_${i}`, name: t.name, input: t.input }))
    const output = content.reduce((x, b) => x + (b.type === 'compaction' ? 0 : blockTokens(b)), 0)
    record.output = output
    state.records.push(record)
    state.last = json
    if (state.keepBodies) state.bodies.push(json)

    // Usage: after a compaction the message iteration reads the system + tools from cache and the summary as input.
    const sysTools = segs.filter((s) => s.kind !== 'messages').reduce((x, s) => x + s.tokens, 0)
    const usage = compacted
      ? {
          input_tokens: summaryTokens, cache_read_input_tokens: Math.min(cacheRead, sysTools), cache_creation_input_tokens: 0, output_tokens: output,
          iterations: [
            { type: 'compaction', input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: summaryTokens },
            { type: 'message', input_tokens: summaryTokens, cache_read_input_tokens: Math.min(cacheRead, sysTools), cache_creation_input_tokens: 0, output_tokens: output }
          ]
        }
      : { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: output }
    const stop = reply.tools?.length ? 'tool_use' : 'end_turn'
    const events: Array<Record<string, any>> = [
      { type: 'message_start', message: { id: `msg_${requests}`, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, output_tokens: 1 } } }
    ]
    content.forEach((b, index) => {
      if (b.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } })
      } else if (b.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } })
      } else if (b.type === 'tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } })
      } else if (b.type === 'compaction') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'compaction', content: null } })
        events.push({ type: 'content_block_delta', index, delta: { type: 'compaction_delta', content: b.content } })
      }
      events.push({ type: 'content_block_stop', index })
    })
    events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage })
    events.push({ type: 'message_stop' })
    return { events }
  }

  const reset = (): void => { n = 0; prevHashes = []; prevKinds = []; prevTools = ''; prevSystem = ''; state.records.length = 0; state.bodies.length = 0; state.last = undefined }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.startsWith('/v1/messages')) {
      const json = JSON.parse(await body(req))
      let out: ReturnType<typeof handle>
      try {
        out = handle(json)
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: (e as Error).message } }))
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const ev of out.events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
      return res.end()
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${url}` } }))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    reset,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) })
  })
}

// ---------------------------------------------------------------------------------------------------
// OpenAI-compatible (GPT and local servers)
// ---------------------------------------------------------------------------------------------------

export interface ChatReply {
  content?: string
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>
}

export interface ChatRecord {
  n: number
  tokens: number
  maxTokens: number
  /** Prompt + max_tokens went past the server's context limit (a real server rejects or truncates). */
  overflow: boolean
  appendOnly: boolean
  /** Index of the first message that differs from the previous request (-1 when append-only). */
  divergedAt: number
  messages: number
  isSummary: boolean
}

export interface FakeOpenAI {
  url: string
  /** The server's context limit (n_ctx / the model's window). */
  limit: number
  records: ChatRecord[]
  last?: Record<string, any>
  /** The last summarizer request (its transcript is what the summary can know). */
  lastSummaryRequest?: Record<string, any>
  summaries: string[]
  respond: (body: Record<string, any>, ctx: { n: number; record: ChatRecord }) => ChatReply
  summarize: (transcript: string, n: number) => string
  onRequest?: (body: Record<string, any>, n: number) => void
  close(): Promise<void>
}

const msgChars = (m: Block): number => (typeof m.content === 'string' ? m.content.length : Array.isArray(m.content) ? m.content.reduce((n: number, p: Block) => n + (p.type === 'text' ? String(p.text).length : 5000), 0) : 0)
  + (m.tool_calls ?? []).reduce((n: number, c: Block) => n + String(c.function?.name ?? '').length + String(c.function?.arguments ?? '').length, 0)

export async function startFakeOpenAI(limit: number): Promise<FakeOpenAI> {
  let prev: string[] = []
  let n = 0
  let requests = 0
  const state: Omit<FakeOpenAI, 'url' | 'close'> = {
    limit,
    records: [],
    summaries: [],
    respond: () => ({ content: 'done' }),
    summarize: (_t, k) => `## Goal\nA long task (checkpoint ${k}).\n## Progress\nWork continues.`
  }
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const json = JSON.parse(await body(req))
      requests++
      const msgs = json.messages as Block[]
      const isSummary = String(msgs[0]?.content ?? '').startsWith('You are compressing')
      if (!isSummary) n++
      state.onRequest?.(json, n)
      const tokens = msgs.reduce((x, m) => x + fakeTokens(msgChars(m)) + 4, 0) + fakeTokens(JSON.stringify(json.tools ?? []).length)
      const hashes: string[] = []
      let h = chain('', JSON.stringify(json.tools ?? []))
      for (const m of msgs) { h = chain(h, JSON.stringify(m)); hashes.push(h) }
      let divergedAt = -1
      if (!isSummary && prev.length) {
        const k = prev.length - 1
        if (hashes[k] !== prev[k]) divergedAt = prev.findIndex((x, i) => hashes[i] !== x)
      }
      const record: ChatRecord = { n: requests, tokens, maxTokens: json.max_tokens ?? 0, overflow: tokens + (json.max_tokens ?? 0) > state.limit, appendOnly: divergedAt < 0, divergedAt, messages: msgs.length, isSummary }
      state.records.push(record)
      if (!isSummary) { prev = hashes; state.last = json } else state.lastSummaryRequest = json
      let reply: ChatReply
      if (isSummary) {
        const s = state.summarize(String(msgs[1]?.content ?? ''), state.summaries.length + 1)
        state.summaries.push(s)
        reply = { content: s }
      } else reply = state.respond(json, { n, record })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const send = (delta: Record<string, unknown>, finish: string | null = null): void => {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
      }
      if (reply.content) send({ content: reply.content })
      reply.toolCalls?.forEach((tc, i) => {
        send({ tool_calls: [{ index: i, id: `call_${requests}_${i}`, type: 'function', function: { name: tc.name, arguments: '' } }] })
        send({ tool_calls: [{ index: i, function: { arguments: JSON.stringify(tc.arguments) } }] })
      })
      send({}, reply.toolCalls?.length ? 'tool_calls' : 'stop')
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: tokens, completion_tokens: 50 } })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    // Not Ollama, no tokenizer: the app falls back to its own estimates.
    res.statusCode = 404
    res.end('not found')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) })
  })
}

/** The text of a Claude request the model actually reads: system, then messages from the latest compaction block on. */
export function effectiveClaudeText(json: Record<string, any>): string {
  const messages = json.messages as Block[]
  let from = { msg: 0, block: 0 }
  messages.forEach((m, i) => {
    if (m.role !== 'assistant') return
    contentOf(m).forEach((b, j) => { if (b.type === 'compaction' && b.content) from = { msg: i, block: j } })
  })
  const sys = Array.isArray(json.system) ? json.system.map((s: Block) => s.text).join('\n') : String(json.system ?? '')
  const parts: string[] = [sys]
  messages.forEach((m, i) => {
    if (i < from.msg) return
    contentOf(m).forEach((b, j) => {
      if (i === from.msg && j < from.block) return
      if (b.type === 'text') parts.push(b.text)
      else if (b.type === 'compaction') parts.push(String(b.content))
      else if (b.type === 'tool_result') parts.push(typeof b.content === 'string' ? b.content : (b.content ?? []).map((c: Block) => c.text ?? '').join('\n'))
      else if (b.type === 'tool_use') parts.push(JSON.stringify(b.input))
    })
  })
  return parts.join('\n')
}
