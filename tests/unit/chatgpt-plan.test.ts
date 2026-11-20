import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { Agent } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { priceFor } from '../../src/main/llm/budget'
import { streamChat, type StreamPart, type WireMessage } from '../../src/main/llm/client'
import { Endpoints, missingReason } from '../../src/main/llm/endpoints'
import { CODEX_URL, PLAN_PREFIX, billingOf, chatgptPlan, closeAll, codexAvailable, openSessions, PlanLimitError } from '../../src/main/llm/codex'
import { findCodex, parseLoginStatus, parseMcpList, parseMcpServers } from '../../src/main/llm/codex/detect'
import { bridgeTools, codexEffort, fingerprint, renderTranscript, runOverrides } from '../../src/main/llm/codex/session'
import { limitWindows, windowLabel } from '../../src/main/llm/codex/plan'
import type { ChatEvent, ModelInfo, Settings, Thread } from '../../src/shared/types'

// ChatGPT plan (via Codex): a fake `codex` (tests/fixtures/fake-codex.mjs) speaks the documented CLI and
// app-server protocol. No real Codex, no network to OpenAI.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const FAKE = resolve(__dirname, '../fixtures/fake-codex.mjs')
const MODEL = `${PLAN_PREFIX}gpt-6.1-sol`
let dir: string
let state: string
let logFile: string
const savedEnv = { path: process.env.SAHILBOT_CODEX_PATH, state: process.env.FAKE_CODEX_STATE, log: process.env.FAKE_CODEX_LOG }

const logs = (): Array<Record<string, unknown>> => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const waitFor = async <T>(f: () => T | undefined | false, ms = 3000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeAll(() => { chmodSync(FAKE, 0o755) })
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'plan-'))
  state = join(dir, 'login-state')
  logFile = join(dir, 'codex.log')
  writeFileSync(state, 'chatgpt')
  process.env.SAHILBOT_CODEX_PATH = FAKE
  process.env.FAKE_CODEX_STATE = state
  process.env.FAKE_CODEX_LOG = logFile
  chatgptPlan.reset()
  chatgptPlan.configure({ dir, version: '0.1.0-test', hooks: { openExternal: () => undefined } })
})
afterEach(async () => { await closeAll(); chatgptPlan.reset() })
afterAll(() => {
  for (const [k, v] of [['SAHILBOT_CODEX_PATH', savedEnv.path], ['FAKE_CODEX_STATE', savedEnv.state], ['FAKE_CODEX_LOG', savedEnv.log]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const connect = async (): Promise<void> => { await chatgptPlan.connect(); expect(chatgptPlan.connected()).toBe(true) }

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const out: StreamPart[] = []
  for await (const p of stream) out.push(p)
  return out
}
const text = (ps: StreamPart[], type: 'content' | 'reasoning' = 'content'): string => ps.filter((p) => p.type === type).map((p) => (p as { text: string }).text).join('')
const req = (messages: WireMessage[], extra: Record<string, unknown> = {}) => ({ baseUrl: CODEX_URL, model: MODEL, messages, sampling: {}, maxTokens: 1000, ...extra }) as never

describe('detection and sign-in status (documented commands only)', () => {
  test('finds Codex, reads `codex login status`, the plan, its limits and models', async () => {
    expect(await findCodex()).toBe(FAKE)
    const st = await chatgptPlan.refresh()
    expect(st).toMatchObject({ installed: true, version: '9.9.0', login: 'chatgpt', email: 'sam@example.com', planType: 'plus', connected: false, enabled: false })
    expect(st.models).toEqual([{ id: MODEL, codexId: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', isDefault: true }])
    expect(st.limits.map((w) => [w.label, w.usedPercent])).toEqual([['5-hour limit', 12], ['Weekly limit', 40]])
    // Off until the user connects; then its models are listed with no price.
    expect(chatgptPlan.models()).toEqual([])
    await connect()
    const [m] = chatgptPlan.models()
    expect(m).toMatchObject({ id: MODEL, provider: 'chatgpt', note: 'remote', installed: true, tools: true, vision: true, price: { input: 0, output: 0 } })
    expect(codexAvailable()).toBe(true)
  })

  test('not installed: says so and offers the install guide', async () => {
    process.env.SAHILBOT_CODEX_PATH = join(dir, 'missing/codex')
    const st = await chatgptPlan.connect()
    expect(st).toMatchObject({ installed: false, connected: false })
    expect(st.problem).toMatch(/isn't installed/)
    expect(st.installUrl).toMatch(/^https:\/\/developers\.openai\.com\/codex/)
  })

  test('Connect signs in through Codex\'s own ChatGPT login (SahilBot opens the page, never sees a token)', async () => {
    writeFileSync(state, 'none')
    const opened: string[] = []
    chatgptPlan.configure({ dir, version: '0.1.0-test', hooks: { openExternal: (u) => { opened.push(u) } } })
    const st = await chatgptPlan.connect()
    expect(st.login).toBe('none')
    expect(opened).toEqual(['https://auth.openai.com/oauth/authorize?client=codex&fake=1'])
    expect(logs().some((l) => l.event === 'login_start' && l.type === 'chatgpt')).toBe(true)
    // Codex reports the sign-in finished; SahilBot checks `codex login status` again.
    await waitFor(() => chatgptPlan.connected() && chatgptPlan.status().email)
    expect(chatgptPlan.status()).toMatchObject({ email: 'sam@example.com', planType: 'plus', signingIn: false })
  })

  test('an API-key login is not the ChatGPT plan', async () => {
    writeFileSync(state, 'apikey')
    const st = await chatgptPlan.connect()
    expect(st.connected).toBe(false)
    expect(st.problem).toMatch(/API key/)
  })

  test('parsers', () => {
    expect(parseLoginStatus(0, 'Logged in using ChatGPT').mode).toBe('chatgpt')
    expect(parseLoginStatus(0, 'Logged in using an API key - sk-***').mode).toBe('apikey')
    expect(parseLoginStatus(1, 'Not logged in').mode).toBe('none')
    expect(parseMcpList('[{"name":"github"},{"name":"bad name"},"notes"]')).toEqual(['github', 'notes'])
    expect(parseMcpList('{"figma":{}}')).toEqual(['figma'])
    expect(parseMcpList('nope')).toEqual([])
    // Servers already off are skipped; the rest keep their transport (Codex rejects an entry without one).
    expect(parseMcpServers('[{"name":"code-review","enabled":false,"transport":{"type":"stdio","command":"/bin/sh"}},{"name":"cua_repl","enabled":true,"transport":{"type":"stdio","command":"/x/node"}},{"name":"web","transport":{"type":"streamable_http","url":"https://x.test/mcp"}}]'))
      .toEqual([{ name: 'cua_repl', command: '/x/node' }, { name: 'web', url: 'https://x.test/mcp' }])
    expect(windowLabel(300)).toBe('5-hour limit')
    expect(windowLabel(10080)).toBe('Weekly limit')
    expect(limitWindows({ primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: 1_900_000_000 } })[0]).toMatchObject({ usedPercent: 100, resetsAt: 1_900_000_000_000 })
    expect(codexEffort('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh')
    expect(codexEffort('low', ['medium', 'high'])).toBe('medium')
  })
})

describe('runs are configured to keep actions in SahilBot', () => {
  test('overrides: shell and web search off, read-only, SahilBot\'s prompt, the bridge with a token from the environment, user servers off', () => {
    const a = runOverrides({ instructionsFile: '/tmp/x/instructions.md', bridgeUrl: 'http://127.0.0.1:5555/codex-mcp', tokenEnv: 'SAHILBOT_RUN_TOKEN', disable: ['github', 'sahilbot'] })
    const kv = a.filter((_, i) => i % 2 === 1)
    expect(a.filter((_, i) => i % 2 === 0).every((x) => x === '-c')).toBe(true)
    expect(kv).toEqual(expect.arrayContaining([
      'features.shell_tool=false', 'tools.web_search=false', 'sandbox_mode="read-only"', 'approval_policy="on-request"', 'model_provider="openai"',
      'model_instructions_file="/tmp/x/instructions.md"', 'mcp_servers.sahilbot.url="http://127.0.0.1:5555/codex-mcp"',
      'mcp_servers.sahilbot.bearer_token_env_var="SAHILBOT_RUN_TOKEN"', 'mcp_servers.sahilbot.tool_timeout_sec=3600', 'mcp_servers.github.enabled=false'
    ]))
    expect(kv.join(' ')).not.toMatch(/sbr_/)
    expect(kv).not.toContain('mcp_servers.sahilbot.enabled=false')
    // Every server switched off also names a transport, or Codex won't start ("invalid transport").
    expect(kv).toContain('mcp_servers.github.command="/usr/bin/false"')
    const b = runOverrides({ instructionsFile: '/tmp/i.md', disable: [{ name: 'cua_repl', command: '/x/node' }, { name: 'web', url: 'https://x.test/mcp' }] }).filter((_, i) => i % 2 === 1)
    expect(b).toEqual(expect.arrayContaining(['mcp_servers.cua_repl.enabled=false', 'mcp_servers.cua_repl.command="/x/node"', 'mcp_servers.web.enabled=false', 'mcp_servers.web.url="https://x.test/mcp"']))
  })

  test('transcript and fingerprints', () => {
    const ms: WireMessage[] = [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello', tool_calls: [{ id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }] }, { role: 'tool', content: 'results', tool_call_id: 'a', name: 'web_search' }, { role: 'user', content: 'and now?' }]
    const t = renderTranscript(ms)
    expect(t).toMatch(/User: hi/)
    expect(t).toMatch(/You called the tool web_search/)
    expect(t).toMatch(/Tool result \(web_search\): results/)
    expect(t).toMatch(/latest message:\nand now\?$/)
    expect(t).not.toMatch(/SYS/)
    expect(renderTranscript([{ role: 'system', content: 'S' }, { role: 'user', content: 'only' }])).toBe('only')
    expect(fingerprint(ms.slice(0, 2))).toBe(fingerprint([{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]))
    expect(bridgeTools([{ type: 'function', function: { name: 'x', description: 'd', parameters: { properties: {} } } }]).map((b) => b.name)).toEqual(['x', 'sahilbot_call'])
  })

  test('budget: plan models cost $0 and are labelled as plan billing', () => {
    expect(priceFor(MODEL)).toMatchObject({ input: 0, output: 0, known: true })
    expect(billingOf(MODEL)).toBe('plan')
    expect(billingOf(CODEX_URL)).toBe('plan')
    expect(billingOf('gpt-6.1-sol')).toBeUndefined()
  })
})

describe('streaming through Codex', () => {
  test('a reply streams as content, reasoning summary and usage; the next message resumes the same Codex thread', async () => {
    await connect()
    const first: WireMessage[] = [{ role: 'system', content: 'You are Alpha.' }, { role: 'user', content: 'Say hello' }]
    const ps = await collect(streamChat(req(first, { effort: 'high' })))
    expect(text(ps)).toBe('Hello from Codex: Say hello')
    expect(text(ps, 'reasoning')).toContain('Thinking about it.')
    expect(ps.find((p) => p.type === 'usage')).toMatchObject({ promptTokens: 1200, completionTokens: 80 })
    expect(ps[ps.length - 1]).toEqual({ type: 'finish', reason: 'stop' })
    const second: WireMessage[] = [...first, { role: 'assistant', content: 'Hello from Codex: Say hello' }, { role: 'user', content: 'Again please' }]
    const ps2 = await collect(streamChat(req(second)))
    expect(text(ps2)).toBe('Hello from Codex: Again please')
    const l = logs()
    // One Codex process for both messages (the status check's short-lived app-server has no run config).
    expect(l.filter((x) => x.event === 'start' && (x.config as Record<string, string>).model_instructions_file)).toHaveLength(1)
    expect(l.filter((x) => x.event === 'turn_start').map((x) => x.text)).toEqual(['Say hello', 'Again please'])
    expect(l.find((x) => x.event === 'turn_start')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    // SahilBot's prompt replaced Codex's, and the user's own MCP servers were switched off.
    const start = l.find((x) => x.event === 'start' && (x.config as Record<string, string>).model_instructions_file) as { config: Record<string, string> }
    expect(readFileSync(JSON.parse(start.config.model_instructions_file), 'utf8')).toBe('You are Alpha.')
    expect(start.config['mcp_servers.github.enabled']).toBe('false')
    expect(start.config['features.shell_tool']).toBe('false')
  })

  test('a restart resumes the saved provider thread with updated instructions and isolates identical chats', async () => {
    await connect()
    const messages: WireMessage[] = [{ role: 'system', content: 'Original constraints' }, { role: 'user', content: 'Internal reference alpha' }]
    await collect(streamChat(req(messages, { conversationKey: 'A' })))
    await closeAll()
    const next: WireMessage[] = [{ role: 'system', content: 'Updated constraints' }, messages[1], { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Continue' }]
    await collect(streamChat(req(next, { conversationKey: 'A' })))
    await collect(streamChat(req(next, { conversationKey: 'B' })))
    expect(logs().filter((x) => x.event === 'thread_start')).toHaveLength(2)
    expect(logs().filter((x) => x.event === 'thread_resume')).toHaveLength(1)
    const resumed = logs().filter((x) => x.event === 'turn_start')[1].text
    expect(resumed).toContain('Updated constraints')
    expect(resumed).not.toContain('Internal reference alpha')
  })

  test('a Codex shell command is declined', async () => {
    await connect()
    const ps = await collect(streamChat(req([{ role: 'user', content: 'SHELL please' }])))
    expect(text(ps)).toBe('Shell decision: decline')
    expect(logs().find((x) => x.event === 'shell_decision')?.decision).toBe('decline')
  })

  test('limit reached: a clear error, plan models sit out of Auto, and the next request fails fast', async () => {
    await connect()
    await expect(collect(streamChat(req([{ role: 'user', content: 'LIMIT' }])))).rejects.toBeInstanceOf(PlanLimitError)
    const st = chatgptPlan.status()
    expect(st.limitedUntil).toBeGreaterThan(Date.now())
    expect(st.limitMessage).toMatch(/usage limit is reached/)
    expect(chatgptPlan.allows({ id: MODEL, provider: 'chatgpt' })).toBe(false)
    expect(codexAvailable()).toBe(false)
    await expect(collect(streamChat(req([{ role: 'user', content: 'hi' }])))).rejects.toThrow(/usage limit/)
  })
})

describe('routing', () => {
  const settingsStub = (s: Partial<Settings>) => ({ get: () => s, keyFor: () => undefined, apiKey: () => undefined }) as never
  const base = {
    providers: { ollama: { enabled: false, baseUrl: 'http://localhost:1' }, lmstudio: { enabled: false, baseUrl: 'http://localhost:2' }, custom: { enabled: false, baseUrl: 'http://localhost:3', name: 'x' }, openai: { baseUrl: '' } },
    keys: { ollama: false, lmstudio: false, custom: false, anthropic: false, openai: false, openrouter: false }, cloud: { enabled: true }, customModels: [], hiddenModels: [], shownModels: [], contextWindow: 32768
  } as unknown as Settings

  test('connected: plan models are listed, pickable and routed to Codex; "plan first" keeps the OpenAI API out of Auto', async () => {
    await connect()
    const ep = new Endpoints(settingsStub(base))
    const list = await ep.list()
    expect(list.models.map((m) => m.id)).toContain(MODEL)
    expect(list.providers?.find((p) => p.id === 'chatgpt')).toMatchObject({ ok: true, count: 1 })
    expect(ep.usable().map((m) => m.id)).toEqual([MODEL])
    expect(ep.for(MODEL)).toEqual({ provider: 'chatgpt', baseUrl: CODEX_URL })
    expect(missingReason(MODEL, list, base)).toBeUndefined()
    const api = { id: 'gpt-6.1-sol', provider: 'openai' } as ModelInfo
    expect(chatgptPlan.allows(api)).toBe(true)
    chatgptPlan.setPrefs({ preferPlan: true })
    expect(chatgptPlan.allows(api)).toBe(false)
    // Cloud models off: nothing goes to the plan either.
    const off = new Endpoints(settingsStub({ ...base, cloud: { enabled: false } as Settings['cloud'] }))
    await off.list()
    expect(off.usable()).toEqual([])
  })

  test('turned off: a chat that chose a plan model is told it isn\'t connected', async () => {
    const ep = new Endpoints(settingsStub(base))
    const list = await ep.list()
    expect(missingReason(MODEL, list, base)).toMatch(/isn't connected/)
  })
})

// ------------------------------------------------------------------ the real agent loop on the plan

function harness(tools: ToolDef[]) {
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: MODEL, hiddenModels: [], shownModels: [],
    cloud: { enabled: true, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  const events: ChatEvent[] = []
  const models = chatgptPlan.models()
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'chatgpt', baseUrl: CODEX_URL }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => events.push(e),
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  const thread = (mode: 'ask' | 'auto' = 'ask'): Thread => db.createThread(space.id, mode, MODEL)
  return { db, agent, events, thread }
}

async function answerNext(agent: Agent, threadId: string, answer: 'allow' | 'deny') {
  for (let i = 0; i < 400; i++) {
    const [r] = agent.pending(threadId)
    if (r) { agent.respond(threadId, r.id, answer); return r }
    await new Promise((x) => setTimeout(x, 10))
  }
  throw new Error('no approval request came')
}

function postTool() {
  const ran: string[] = []
  const tool: ToolDef<{ to: string }> = {
    name: 'post_thing', label: 'Post', effect: 'write_external', core: true, description: 'Posts the notes somewhere.',
    parameters: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'], additionalProperties: false },
    async run({ to }) { ran.push(to); return { text: `sent to ${to}` } }
  }
  return { tool, ran }
}

describe('bots on the ChatGPT plan keep SahilBot\'s tools and approvals', () => {
  test('Codex calls a SahilBot function; it waits for the user\'s approval, runs in SahilBot, and returns the result', async () => {
    await connect()
    const p = postTool()
    const h = harness([p.tool])
    const t = h.thread('ask')
    const done = (await h.agent.send({ threadId: t.id, text: 'TOOL:post_thing:{"to":"team"}' })).done
    const r = await answerNext(h.agent, t.id, 'allow')
    expect(r.tool).toBe('post_thing')
    expect(await done).toBe('finished')
    expect(p.ran).toEqual(['team'])
    const ms = h.db.listMessages(t.id)
    expect(ms.find((m) => m.role === 'tool' && m.toolName === 'post_thing')?.content).toContain('sent to team')
    const final = ms.filter((m) => m.role === 'assistant').pop()
    expect(final?.content).toContain('Tool said:')
    expect(final?.content).toContain('sent to team')
    expect(final?.model).toBe(MODEL)
    // The reply streamed into the chat, and Codex saw SahilBot's functions without a loopback server.
    expect(h.events.some((e) => e.type === 'delta')).toBe(true)
    const l = logs()
    expect((l.find((x) => x.event === 'tools')?.names as string[])).toContain('sb_sahilbot_call')
    expect(l.find((x) => x.event === 'start' && (x.config as Record<string, string>)['mcp_servers.sahilbot.url'])).toBeUndefined()
    expect(l.find((x) => x.event === 'tool_result')).toMatchObject({ isError: false })
  })

  test('older app servers can still call SahilBot through the loopback bridge', async () => {
    await connect()
    process.env.FAKE_CODEX_LEGACY = '1'
    try {
      const p = postTool()
      const h = harness([p.tool])
      const t = h.thread('ask')
      const { done } = await h.agent.send({ threadId: t.id, text: 'TOOL:post_thing:{"to":"team"}' })
      await answerNext(h.agent, t.id, 'allow')
      expect(await done).toBe('finished')
      expect(p.ran).toEqual(['team'])
      expect(logs().find((x) => x.event === 'start' && (x.config as Record<string, string>)['mcp_servers.sahilbot.url'])).toMatchObject({ tokenInArgs: false, tokenInEnv: true })
    } finally { delete process.env.FAKE_CODEX_LEGACY }
  })

  test('a denied call never runs, and Codex is told', async () => {
    await connect()
    const p = postTool()
    const h = harness([p.tool])
    const t = h.thread('ask')
    const done = (await h.agent.send({ threadId: t.id, text: 'TOOL:post_thing:{"to":"everyone"}' })).done
    await answerNext(h.agent, t.id, 'deny')
    expect(await done).toBe('finished')
    expect(p.ran).toEqual([])
    const result = await waitFor(() => logs().find((x) => x.event === 'tool_result'))
    expect(String(result.text)).not.toContain('sent to')
  })

  test('Stop interrupts Codex\'s turn and ends its process', async () => {
    await connect()
    const h = harness([])
    const t = h.thread('auto')
    const done = (await h.agent.send({ threadId: t.id, text: 'SLOW story' })).done
    await waitFor(() => h.events.some((e) => e.type === 'delta' && /tick/.test(String((e as { content?: string }).content ?? ''))))
    h.agent.stop(t.id)
    expect(await done).toBe('stopped')
    await waitFor(() => logs().some((x) => x.event === 'interrupt'))
    await waitFor(() => openSessions() === 0)
  })
})

describe('the tool bridge', () => {
  test('loopback only, per-run token, revoked when the run ends, no web pages', async () => {
    const { ToolBridge } = await import('../../src/main/llm/codex/bridge')
    const b = new ToolBridge()
    await b.start()
    const calls: string[] = []
    const token = b.add({ tools: () => [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }], call: async (name, args) => { calls.push(name); return { text: `echo ${JSON.stringify(args)}` } } })
    const post = (headers: Record<string, string>, body: unknown) => fetch(b.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
    const callBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }
    const ok = await (await post({ authorization: `Bearer ${token}` }, callBody)).json()
    expect(ok.result.content[0].text).toBe('echo {"a":1}')
    expect((await post({ authorization: 'Bearer sbr_wrongwrongwrong' }, callBody)).status).toBe(401)
    expect((await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' }, callBody)).status).toBe(403)
    b.remove(token)
    expect((await post({ authorization: `Bearer ${token}` }, callBody)).status).toBe(401)
    expect(calls).toEqual(['echo'])
    await b.stop()
  })
})
