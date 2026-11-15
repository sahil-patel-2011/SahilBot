#!/usr/bin/env node
// A stand-in for OpenAI's `codex` CLI in unit tests: no network, no real Codex. It answers the documented
// commands SahilBot uses (`--version`, `login status`, `login`, `mcp list --json`) and speaks the
// documented app-server protocol (developers.openai.com/codex/app-server): JSON-RPC lines on stdio without
// the "jsonrpc" field. Turns follow a script picked by words in the user's input:
//   TOOL:<name>:<json>  call that tool on the run's MCP server (the SahilBot bridge), then report the result
//   LIMIT               fail the turn with codexErrorInfo "usageLimitExceeded"
//   SLOW                stream deltas until interrupted
//   SHELL               ask to run a shell command (the client should decline)
//   otherwise           reply "Hello from Codex"
// Environment: FAKE_CODEX_STATE (file: "chatgpt" | "apikey" | "none"; default chatgpt),
// FAKE_CODEX_LOG (append JSON lines describing what happened, for assertions).

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const LOG = process.env.FAKE_CODEX_LOG
const log = (o) => { if (LOG) appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...o }) + '\n') }
const STATE = process.env.FAKE_CODEX_STATE
const loginState = () => (STATE && existsSync(STATE) ? readFileSync(STATE, 'utf8').trim() : 'chatgpt') || 'none'

if (args[0] === '--version') { console.log('codex-cli 9.9.0'); process.exit(0) }
if (args[0] === 'login' && args[1] === 'status') {
  const s = loginState()
  if (s === 'chatgpt') { console.log('Logged in using ChatGPT'); process.exit(0) }
  if (s === 'apikey') { console.log('Logged in using an API key - sk-proj-***'); process.exit(0) }
  console.error('Not logged in'); process.exit(1)
}
if (args[0] === 'login') { if (STATE) writeFileSync(STATE, 'chatgpt'); console.log('Successfully logged in'); process.exit(0) }
if (args[0] === 'mcp' && args[1] === 'list') { console.log(JSON.stringify([{ name: 'github', transport: { type: 'stdio' } }])); process.exit(0) }
if (args[0] !== 'app-server') { console.error(`fake codex: unsupported ${args.join(' ')}`); process.exit(2) }

// ---------------------------------------------------------------- app-server
const config = {}
for (let i = 1; i < args.length; i++) if (args[i] === '-c') { const kv = args[++i]; const eq = kv.indexOf('='); config[kv.slice(0, eq)] = kv.slice(eq + 1) }
const unq = (v) => { try { return JSON.parse(v) } catch { return v } }
const tokenEnv = config['mcp_servers.sahilbot.bearer_token_env_var'] ? unq(config['mcp_servers.sahilbot.bearer_token_env_var']) : undefined
log({ event: 'start', config, tokenInArgs: args.some((a) => a.includes('sbr_')), tokenInEnv: !!(tokenEnv && process.env[tokenEnv]) })

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const notify = (method, params) => send({ method, params })
let nextServerId = 1000
const pendingServer = new Map()
const askClient = (method, params) => new Promise((ok) => { const id = nextServerId++; pendingServer.set(id, ok); send({ id, method, params }) })

let turnSeq = 0
const turns = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Math.floor(Date.now() / 1000)
let total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }

async function mcp(method, params) {
  const url = unq(config['mcp_servers.sahilbot.url'])
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${process.env[tokenEnv]}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params })
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

async function deltas(turn, itemId, text) {
  for (const w of text.match(/\S+\s*/g) ?? []) {
    if (turn.stopped) return
    notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: turn.id, itemId, delta: w })
    await sleep(2)
  }
}

function finish(turn, status, error) {
  if (turn.done) return
  turn.done = true
  total = { ...total, inputTokens: total.inputTokens + 1200, outputTokens: total.outputTokens + 80, cachedInputTokens: total.cachedInputTokens + 1000 }
  notify('thread/tokenUsage/updated', { threadId: 'thr_1', turnId: turn.id, tokenUsage: { total, last: total } })
  notify('turn/completed', { threadId: 'thr_1', turn: { id: turn.id, status, ...(error ? { error } : {}) } })
}

async function runTurn(turn, text) {
  notify('turn/started', { threadId: 'thr_1', turn: { id: turn.id, status: 'inProgress' } })
  notify('item/reasoning/summaryTextDelta', { threadId: 'thr_1', turnId: turn.id, itemId: `r_${turn.id}`, delta: 'Thinking about it.' })
  const tool = /TOOL:([a-z_]+):(\{.*?\})(?:\s|$)/.exec(text)
  if (tool) {
    const list = await mcp('tools/list', {})
    log({ event: 'tools', names: list.tools.map((t) => t.name) })
    notify('item/started', { threadId: 'thr_1', turnId: turn.id, item: { id: `m_${turn.id}`, type: 'mcpToolCall', server: 'sahilbot', tool: tool[1], status: 'inProgress', arguments: JSON.parse(tool[2]) } })
    const out = await mcp('tools/call', { name: tool[1], arguments: JSON.parse(tool[2]) }).catch((e) => ({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true }))
    const said = out.content?.map((c) => c.text).join('') ?? ''
    log({ event: 'tool_result', text: said, isError: !!out.isError })
    notify('item/completed', { threadId: 'thr_1', turnId: turn.id, item: { id: `m_${turn.id}`, type: 'mcpToolCall', server: 'sahilbot', tool: tool[1], status: 'completed' } })
    await deltas(turn, `a_${turn.id}`, `Tool said: ${said.slice(0, 200)}`)
    return finish(turn, 'completed')
  }
  if (/LIMIT/.test(text)) {
    notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: now() + 7200 } } })
    notify('error', { threadId: 'thr_1', turnId: turn.id, willRetry: false, error: { message: 'You\'ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } })
    return finish(turn, 'failed', { message: 'You\'ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' })
  }
  if (/SLOW/.test(text)) {
    for (let i = 0; i < 2000 && !turn.stopped; i++) { notify('item/agentMessage/delta', { threadId: 'thr_1', turnId: turn.id, itemId: `a_${turn.id}`, delta: `tick ${i} ` }); await sleep(20) }
    return
  }
  if (/SHELL/.test(text)) {
    const r = await askClient('item/commandExecution/requestApproval', { threadId: 'thr_1', turnId: turn.id, itemId: 'c1', command: 'rm -rf ~/Documents', reason: 'cleanup' })
    log({ event: 'shell_decision', decision: r?.decision })
    await deltas(turn, `a_${turn.id}`, `Shell decision: ${r?.decision}`)
    return finish(turn, 'completed')
  }
  await deltas(turn, `a_${turn.id}`, `Hello from Codex: ${text.replace(/\s+/g, ' ').slice(0, 60)}`)
  finish(turn, 'completed')
}

const handlers = {
  initialize: () => ({ userAgent: 'fake-codex/9.9.0' }),
  'account/read': () => (loginState() === 'chatgpt' ? { account: { type: 'chatgpt', email: 'sam@example.com', planType: 'plus' }, requiresOpenaiAuth: true } : loginState() === 'apikey' ? { account: { type: 'apiKey' }, requiresOpenaiAuth: true } : { account: null, requiresOpenaiAuth: true }),
  'account/rateLimits/read': () => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now() + 3600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now() + 3 * 86400 } } }),
  'model/list': () => ({ data: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }], inputModalities: ['text', 'image'] }], nextCursor: null }),
  'account/login/start': (p) => {
    log({ event: 'login_start', type: p?.type })
    setTimeout(() => { if (STATE) writeFileSync(STATE, 'chatgpt'); notify('account/login/completed', { loginId: 'L1', success: true, error: null }) }, 50)
    return { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?client=codex&fake=1' }
  },
  'thread/start': (p) => { log({ event: 'thread_start', params: p }); notify('thread/started', { thread: { id: 'thr_1' } }); return { thread: { id: 'thr_1', sessionId: 's1' } } },
  'turn/start': (p) => {
    const id = `turn_${++turnSeq}`
    const text = (p.input ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n')
    log({ event: 'turn_start', id, text, model: p.model, effort: p.effort, images: (p.input ?? []).filter((x) => x.type !== 'text').length })
    const turn = { id, stopped: false, done: false }
    turns.set(id, turn)
    setTimeout(() => { void runTurn(turn, text) }, 5)
    return { turn: { id, status: 'inProgress' } }
  },
  'turn/interrupt': (p) => {
    log({ event: 'interrupt', turnId: p.turnId })
    const t = turns.get(p.turnId)
    if (t) { t.stopped = true; setTimeout(() => finish(t, 'interrupted'), 5) }
    return {}
  },
  'turn/steer': (p) => { log({ event: 'steer', text: (p.input ?? []).map((x) => x.text).join('\n') }); return { turnId: p.expectedTurnId } }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const m = JSON.parse(line)
    if (m.id !== undefined && !m.method) { const ok = pendingServer.get(m.id); pendingServer.delete(m.id); ok?.(m.result ?? m.error); continue }
    if (!m.method || m.id === undefined) continue
    const h = handlers[m.method]
    if (!h) { send({ id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } }); continue }
    try { send({ id: m.id, result: h(m.params) }) } catch (e) { send({ id: m.id, error: { code: -32603, message: e.message } }) }
  }
})
process.stdin.on('end', () => { log({ event: 'exit' }); process.exit(0) })
