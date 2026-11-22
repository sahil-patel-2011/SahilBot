import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isAbsolute, join, relative } from 'node:path'

// Agent Arena's model: one simulated model behind two wire formats (OpenAI chat completions for SahilBot and
// the Grok CLI, Anthropic Messages for Claude Code), so every harness gets the same brain and only the harness
// differs. A task's policy decides the next abstract action (read, write, edit, run a command, or answer) from
// what the model can see: the conversation and its tool results. It never sees the grader, and it never keys
// on a harness's wording; a new user turn after its answer (a harness nudge or the user stepping in) is all
// it reacts to, the way a real model reacts to "keep going".

export type Action =
  | { kind: 'read'; path: string; start?: number; end?: number }
  | { kind: 'write'; path: string; content: string }
  | { kind: 'edit'; path: string; old: string; new: string; all?: boolean }
  | { kind: 'bash'; command: string }
  | { kind: 'say'; text: string }

export interface Turn { role: 'user' | 'assistant' | 'tool'; text: string; tool?: string; args?: Record<string, unknown> }

export type Dialect = 'claude-code' | 'sahilbot' | 'grok-cli' | 'generic'

/** What the model sees, plus helpers a policy reads it with. */
export interface View {
  turns: Turn[]
  dialect: Dialect
  /** Real user turns so far (the task counts as 1; harness nudges and step-ins add to it). */
  userTurns: number
  /** User turns since the model's last answer (a nudge or a step-in after it said it was done). */
  pushedBack: boolean
  lastOutput: string
  /** Abstract actions taken so far, in order. */
  actions: Action[]
  /** The file's text as the model last saw it in a tool result (undefined: never read). */
  seen: (path: string) => string | undefined
  ran: (pattern: RegExp) => number
  /** The last tool result was an error (a refused write, a failed edit, a missing file). */
  lastFailed: boolean
  wrote: (path: string) => number
  /** Outputs of commands matching the pattern, oldest first. */
  outputsOf: (pattern: RegExp) => string[]
  hasEdit: boolean
}

export type Policy = (v: View) => Action

export interface RunMetrics { requests: number; inputTokens: number; outputTokens: number; maxInputTokens: number; sideRequests: number }

export interface Sim {
  url: string
  /** Sets the task for the next run (one run at a time). */
  use: (o: { workspace: string; policy: Policy }) => void
  metrics: () => RunMetrics
  /** The model's actions in the run so far (as the last request saw them, plus the one it chose). */
  actions: () => Action[]
  close: () => Promise<void>
}

const tok = (s: string): number => Math.ceil(s.length / 4)
const readBody = (req: IncomingMessage): Promise<string> => new Promise((ok) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)) })
const stripReminders = (s: string): string => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
/** A harness's envelope around a tool result (SahilBot: <tool_output tool=… trust=…>): the model reads what's inside. */
const unwrap = (s: string): string => stripReminders(s).replace(/^\s*<tool_output[^>]*>\n?/, '').replace(/\n?<\/tool_output>\s*$/, '')
/** Line-number prefixes some read tools add ("   12\t", "12→", "12|"): removed when every line has one. */
function unnumber(text: string): string {
  const lines = text.split('\n')
  const re = /^\s*\d+(\t|→|\| |$)/
  if (lines.filter(Boolean).length && lines.filter(Boolean).every((l) => re.test(l))) return lines.map((l) => l.replace(re, '')).join('\n')
  return text
}

function dialectOf(tools: string[]): Dialect {
  if (tools.includes('Write') && tools.includes('Bash')) return 'claude-code'
  if (tools.includes('file_write')) return 'sahilbot'
  if (tools.includes('create_file') || tools.includes('str_replace_editor')) return 'grok-cli'
  return 'generic'
}

/** An abstract action as a tool call in this harness's own tools. */
function encode(a: Exclude<Action, { kind: 'say' }>, d: Dialect, ws: string): { name: string; input: Record<string, unknown> } {
  const abs = (p: string): string => (isAbsolute(p) ? p : join(ws, p))
  if (d === 'claude-code') {
    if (a.kind === 'read') return { name: 'Read', input: { file_path: abs(a.path), ...(a.start ? { offset: a.start, limit: (a.end ?? a.start + 50) - a.start + 1 } : {}) } }
    if (a.kind === 'write') return { name: 'Write', input: { file_path: abs(a.path), content: a.content } }
    if (a.kind === 'edit') return { name: 'Edit', input: { file_path: abs(a.path), old_string: a.old, new_string: a.new, ...(a.all ? { replace_all: true } : {}) } }
    return { name: 'Bash', input: { command: a.command } }
  }
  if (d === 'grok-cli') {
    if (a.kind === 'read') return { name: 'view_file', input: { path: abs(a.path), ...(a.start ? { start_line: a.start, end_line: a.end } : {}) } }
    if (a.kind === 'write') return { name: 'create_file', input: { path: abs(a.path), content: a.content } }
    if (a.kind === 'edit') return { name: 'str_replace_editor', input: { path: abs(a.path), old_str: a.old, new_str: a.new, ...(a.all ? { replace_all: true } : {}) } }
    return { name: 'bash', input: { command: a.command } }
  }
  if (a.kind === 'read') return { name: 'file_read', input: { path: a.path, ...(a.start ? { start: a.start, end: a.end } : {}) } }
  if (a.kind === 'write') return { name: 'file_write', input: { path: a.path, content: a.content } }
  if (a.kind === 'edit') return { name: 'file_edit', input: { path: a.path, old_string: a.old, new_string: a.new, ...(a.all ? { replace_all: true } : {}) } }
  return { name: 'run_command', input: { command: a.command } }
}

/** A harness tool call back to the abstract action (to read the model's own history). */
function decode(name: string, input: Record<string, unknown>, ws: string): Action | undefined {
  const rel = (p: unknown): string => { const s = String(p ?? ''); return isAbsolute(s) ? relative(ws, s) : s }
  switch (name) {
    case 'Read': case 'view_file': case 'file_read': { const start = Number(input.offset ?? input.start ?? input.start_line) || undefined; return { kind: 'read', path: rel(input.file_path ?? input.path), ...(start ? { start } : {}) } }
    case 'Write': case 'create_file': case 'file_write': return { kind: 'write', path: rel(input.file_path ?? input.path), content: String(input.content ?? '') }
    case 'Edit': case 'str_replace_editor': case 'file_edit': return { kind: 'edit', path: rel(input.file_path ?? input.path), old: String(input.old_string ?? input.old_str ?? ''), new: String(input.new_string ?? input.new_str ?? ''), ...(input.replace_all ? { all: true } : {}) }
    case 'Bash': case 'bash': case 'run_command': return { kind: 'bash', command: String(input.command ?? '') }
    default: return undefined
  }
}

const blockText = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? b.text : typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? blockText(b.content) : '')).join('\n') : ''

/** Both wire formats as one list of turns. */
function turnsOf(body: any, anthropic: boolean): Turn[] {
  const out: Turn[] = []
  for (const m of body.messages ?? []) {
    if (anthropic) {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (m.content ?? [])
      for (const b of blocks) {
        if (b.type === 'tool_result') out.push({ role: 'tool', text: unwrap(blockText(b.content)) })
        else if (b.type === 'tool_use') out.push({ role: 'assistant', text: '', tool: b.name, args: b.input })
        else if (b.type === 'text') {
          const t = m.role === 'user' ? stripReminders(b.text ?? '') : (b.text ?? '')
          if (t) out.push({ role: m.role === 'user' ? 'user' : 'assistant', text: t })
        }
      }
    } else {
      if (m.role === 'system') continue
      if (m.role === 'tool') { out.push({ role: 'tool', text: unwrap(blockText(m.content)) }); continue }
      if (m.role === 'assistant') {
        if (m.content) out.push({ role: 'assistant', text: blockText(m.content) })
        for (const c of m.tool_calls ?? []) { let args = {}; try { args = JSON.parse(c.function?.arguments || '{}') } catch { /* bad args */ } out.push({ role: 'assistant', text: '', tool: c.function?.name, args }) }
        continue
      }
      const t = blockText(m.content)
      if (t) out.push({ role: 'user', text: t })
    }
  }
  return out
}

function viewOf(turns: Turn[], dialect: Dialect, ws: string, tools: string[]): View {
  const actions: Action[] = []
  const outputs: Array<{ action: Action; output: string }> = []
  const failedOut = (o: string): boolean => /^(<tool_use_error>|Error\b|error:)|has not been read|Read it first|No such file|not found in file|String to replace not found|refus/i.test(o.trim())
  let pending: Action | undefined
  let userTurns = 0
  let answeredAt = -1
  let lastUserAt = -1
  turns.forEach((t, i) => {
    if (t.role === 'user') { userTurns++; lastUserAt = i }
    if (t.role === 'assistant' && t.tool) { const a = decode(t.tool, t.args ?? {}, ws); if (a) { actions.push(a); pending = a } }
    if (t.role === 'assistant' && !t.tool && t.text) answeredAt = i
    if (t.role === 'tool' && pending) { outputs.push({ action: pending, output: t.text }); pending = undefined }
  })
  const seen = (path: string): string | undefined => {
    // Forward through the history: a read shows the file, a write replaces it, an edit changes the part it names.
    let text: string | undefined
    for (const o of outputs) {
      if (o.action.kind === 'read' && o.action.path === path && !failedOut(o.output)) text = unnumber(o.output)
      else if (o.action.kind === 'bash' && new RegExp(`^cat ${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(o.action.command) && !failedOut(o.output)) text = o.output.replace(/^\$ .*\n(\(in [^)]*\)\n)?\n?/, '')
      else if (o.action.kind === 'write' && o.action.path === path && !failedOut(o.output)) text = o.action.content
      else if (o.action.kind === 'edit' && o.action.path === path && text !== undefined && !failedOut(o.output)) text = o.action.all ? text.split(o.action.old).join(o.action.new) : text.replace(o.action.old, o.action.new)
    }
    return text
  }
  return {
    turns, dialect, userTurns, actions,
    pushedBack: answeredAt >= 0 && lastUserAt > answeredAt,
    lastOutput: [...turns].reverse().find((t) => t.role === 'tool')?.text ?? '',
    lastFailed: failedOut([...turns].reverse().find((t) => t.role === 'tool')?.text ?? ''),
    seen,
    ran: (re) => actions.filter((a) => a.kind === 'bash' && re.test(a.command)).length,
    wrote: (p) => outputs.filter((o) => (o.action.kind === 'write' || o.action.kind === 'edit') && o.action.path === p && !failedOut(o.output)).length + (pending && (pending.kind === 'write' || pending.kind === 'edit') && pending.path === p ? 0 : 0),
    outputsOf: (re) => outputs.filter((o) => o.action.kind === 'bash' && re.test(o.action.command)).map((o) => o.output),
    hasEdit: tools.includes('Edit') || tools.includes('str_replace_editor') || tools.includes('file_edit')
  }
}

/** A compaction request: a summary that keeps what was done and found (what a capable model writes). */
function summary(turns: Turn[]): string {
  const goal = turns.find((t) => t.role === 'user')?.text.slice(0, 400) ?? ''
  const done = turns.filter((t) => t.tool).map((t) => `- ${t.tool} ${JSON.stringify(t.args ?? {}).slice(0, 160)}`).slice(-30)
  return `## Goal\n${goal}\n## Done so far\n${done.join('\n') || '- nothing yet'}\n## Open items\n- continue the task`
}

export async function startSim(): Promise<Sim> {
  let task: { workspace: string; policy: Policy } | undefined
  let m: RunMetrics = { requests: 0, inputTokens: 0, outputTokens: 0, maxInputTokens: 0, sideRequests: 0 }
  let ids = 0
  let lastActions: Action[] = []
  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? ''
    if (req.method === 'GET' && url.startsWith('/v1/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'arena-model', object: 'model' }] })) }
    if (url.includes('count_tokens')) { const b = await readBody(req); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ input_tokens: tok(b) })) }
    const anthropic = req.method === 'POST' && url.startsWith('/v1/messages')
    const openai = req.method === 'POST' && url.endsWith('/chat/completions')
    if (!anthropic && !openai) { res.statusCode = 404; return res.end('not found') }
    const raw = await readBody(req)
    const body = JSON.parse(raw || '{}')
    if (openai && body.response_format?.type === 'json_schema') { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'json_schema not supported' } })) }
    const tools: string[] = (body.tools ?? []).map((t: any) => t.name ?? t.function?.name).filter(Boolean)
    const dialect = dialectOf(tools)
    const turns = turnsOf(body, anthropic)
    const system = anthropic ? blockText(body.system) : blockText(body.messages?.find((x: any) => x.role === 'system')?.content)
    let reply: { text?: string; call?: { name: string; input: Record<string, unknown> } }
    if (/You are compressing|summar(y|ize) (of )?(this|the) conversation/i.test(system + (turns.at(-1)?.text ?? '')) && !tools.length) {
      m.sideRequests++
      reply = { text: summary(turns) }
    } else if (task && dialect === 'generic' && tools.includes('find_tools') && !turns.some((t) => t.tool === 'find_tools')) {
      // Only a tool finder on offer (a harness that loads tools on demand): the model asks it for file and terminal tools.
      m.requests++
      m.inputTokens += tok(raw)
      reply = { call: { name: 'find_tools', input: { query: 'read and write files in the working folder and run terminal commands' } } }
    } else if (!task || dialect === 'generic') {
      // Side requests (titles, classifiers): a short neutral answer.
      m.sideRequests++
      if (process.env.ARENA_DEBUG) appendFileSync(process.env.ARENA_DEBUG, `--- side request tools=[${tools.slice(0, 8).join(',')}] system=${system.slice(0, 160).replace(/\n/g, ' ')} last=${(turns.at(-1)?.text ?? '').slice(0, 160).replace(/\n/g, ' ')}\n`)
      reply = { text: 'OK' }
    } else {
      m.requests++
      const input = tok(raw)
      m.inputTokens += input
      m.maxInputTokens = Math.max(m.maxInputTokens, input)
      const v = viewOf(turns, dialect, task.workspace, tools)
      lastActions = v.actions
      const a = task.policy(v)
      // No edit tool: the model rewrites the whole file from what it last saw of it.
      const act: Action = a.kind === 'edit' && !v.hasEdit ? { kind: 'write', path: a.path, content: a.all ? (v.seen(a.path) ?? '').split(a.old).join(a.new) : (v.seen(a.path) ?? '').replace(a.old, a.new) } : a
      if (act.kind !== 'say') lastActions = [...v.actions, act]
      if (process.env.ARENA_DEBUG) appendFileSync(process.env.ARENA_DEBUG, `--- ${dialect} step ${m.requests} pushedBack=${v.pushedBack}\nLAST OUTPUT: ${v.lastOutput.slice(0, 300)} …[${v.lastOutput.length} chars]… ${v.lastOutput.slice(-300)}\nACTION: ${JSON.stringify(act).slice(0, 300)}\n`)
      reply = act.kind === 'say' ? { text: act.text } : { call: encode(act, dialect, task.workspace) }
      m.outputTokens += tok(reply.text ?? JSON.stringify(reply.call))
    }
    const id = `call_${++ids}`
    if (anthropic) {
      const content = reply.call ? [{ type: 'tool_use', id, name: reply.call.name, input: reply.call.input }] : [{ type: 'text', text: reply.text ?? '' }]
      const stop = reply.call ? 'tool_use' : 'end_turn'
      const usage = { input_tokens: tok(raw), output_tokens: tok(JSON.stringify(content)) }
      if (!body.stream) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ id: `msg_${ids}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, stop_sequence: null, usage })) }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const ev = (t: string, d: Record<string, unknown>): void => { res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`) }
      ev('message_start', { message: { id: `msg_${ids}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } })
      const c = content[0] as any
      if (c.type === 'text') { ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }); ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c.text } }) }
      else { ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } }); ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } }) }
      ev('content_block_stop', { index: 0 })
      ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } })
      ev('message_stop', {})
      return res.end()
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (delta: Record<string, unknown>, finish: string | null = null): void => { res.write(`data: ${JSON.stringify({ id: `cmpl_${ids}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`) }
    if (reply.call) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: reply.call.name, arguments: '' } }] })
      send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.call.input) } }] })
      send({}, 'tool_calls')
    } else {
      send({ role: 'assistant', content: reply.text ?? '' })
      send({}, 'stop')
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: tok(raw), completion_tokens: tok(reply.text ?? JSON.stringify(reply.call)) } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    actions: () => lastActions,
    use: (o) => { task = o; lastActions = []; m = { requests: 0, inputTokens: 0, outputTokens: 0, maxInputTokens: 0, sideRequests: 0 } },
    metrics: () => ({ ...m }),
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) })
  }
}
