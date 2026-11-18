import { describe, expect, test } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sourceKindOf } from '../../src/main/brain-access/reader'
import { fakeBrain } from '../fixtures/fake-brain'
import { composeAnswer, NOT_FOUND } from '../../src/main/brain-access/answer'
import { McpClientStore } from '../../src/main/mcp-server/store'
import { McpTools, type McpHost, type ToolResult } from '../../src/main/mcp-server/tools'
import { McpHttpServer } from '../../src/main/mcp-server/server'
import { cleanBrainScope, DEFAULT_BRAIN_SCOPE, scopeSummary } from '../../src/shared/brain-access'

// The brain, read from outside SahilBot (MCP brain tools, Team access): a fake brain (a real graph in an
// in-memory database, seeded by hand) and the scope checks on everything it hands out.

describe('brain reader: scope checks', () => {
  test('a question gets answer-ready facts with their sources', () => {
    const b = fakeBrain()
    const r = b.reader.search('Where did we leave it with Priya?', DEFAULT_BRAIN_SCOPE)
    expect(r.entities.map((e) => e.name)).toContain('Priya Shah')
    const proposal = r.facts.find((f) => /revised proposal/.test(f.text))
    expect(proposal?.source).toMatchObject({ kind: 'meetings', label: 'Meeting notes · Mon' })
    expect(r.facts.find((f) => /Head of Ops/.test(f.text))?.source).toMatchObject({ kind: 'email', link: expect.stringContaining('mail.google.com') })
    expect(r.commitments.map((c) => c.what)).toEqual(['send the revised proposal'])
  })

  test('by default: no texts, nothing sensitive, never activity, never secrets', () => {
    const b = fakeBrain()
    const all = JSON.stringify([b.reader.search('Priya', DEFAULT_BRAIN_SCOPE), b.reader.search('Partner B', DEFAULT_BRAIN_SCOPE), b.reader.entity('person', 'Priya Shah', DEFAULT_BRAIN_SCOPE), b.reader.openCommitments(DEFAULT_BRAIN_SCOPE)])
    expect(all).not.toMatch(/running late/)
    expect(all).not.toMatch(/diabetes/)
    expect(all).not.toMatch(/Figma/)
    expect(all).not.toMatch(/sk-live/)
    expect(all).not.toMatch(/invoice 1042/) // from a text
    expect(all).not.toMatch(/old thing/) // done
  })

  test('the owner can widen a scope: texts and a sensitive category', () => {
    const b = fakeBrain()
    const wide = cleanBrainScope({ ...DEFAULT_BRAIN_SCOPE, sources: [...DEFAULT_BRAIN_SCOPE.sources, 'texts'], sensitive: ['health'] })
    const all = JSON.stringify(b.reader.search('Priya', wide))
    expect(all).toMatch(/running late/)
    expect(all).toMatch(/diabetes/)
    expect(all).not.toMatch(/Figma/)
  })

  test('only the sources the scope allows', () => {
    const b = fakeBrain()
    const meetingsOnly = cleanBrainScope({ ...DEFAULT_BRAIN_SCOPE, sources: ['meetings'] })
    const r = b.reader.search('Priya', meetingsOnly)
    expect(r.facts.length).toBeGreaterThan(0)
    expect(r.facts.every((f) => f.source.kind === 'meetings' || f.source.kind === 'you')).toBe(true)
  })

  test('a list of entities: nothing about anyone else, not even through a search', () => {
    const b = fakeBrain()
    const onlyB = cleanBrainScope({ ...DEFAULT_BRAIN_SCOPE, entities: [b.partnerB.id] })
    expect(b.reader.search('Where did we leave it with Priya?', onlyB).facts.some((f) => /Priya/.test(f.text))).toBe(false)
    expect(b.reader.entity('person', 'Priya Shah', onlyB)).toBeNull()
    expect(b.reader.search('What did we promise Partner B?', onlyB).facts.map((f) => f.text).join()).toMatch(/Net 30/)
    expect(b.reader.openCommitments(onlyB).some((c) => /proposal/.test(c.what))).toBe(false)
    expect(b.reader.search('Acme renews', onlyB).facts.some((f) => /renews/.test(f.text))).toBe(false)
  })

  test('topics narrow what is shared', () => {
    const b = fakeBrain()
    const pricing = cleanBrainScope({ ...DEFAULT_BRAIN_SCOPE, topics: ['payment', 'net 30'] })
    const t = JSON.stringify(b.reader.search('Partner B', pricing))
    expect(t).toMatch(/Net 30/)
    expect(JSON.stringify(b.reader.search('Priya', pricing))).not.toMatch(/Head of Ops/)
  })

  test('a bot\'s private facts only for a scope that names the bot', () => {
    const b = fakeBrain()
    expect(b.reader.entity('project', 'Project Falcon', DEFAULT_BRAIN_SCOPE)).toBeNull()
    const withSales = cleanBrainScope({ ...DEFAULT_BRAIN_SCOPE, bots: [b.sales.id] })
    expect(b.reader.entity('project', 'Project Falcon', withSales)?.facts.map((f) => f.text).join()).toMatch(/pitch deck/)
  })

  test('a client card carries the brief from its vault note, facts and related people', () => {
    const b = fakeBrain()
    const c = b.reader.entity('client', 'Acme Corp', DEFAULT_BRAIN_SCOPE)!
    expect(c.role).toBe('client')
    expect(c.brief).toMatch(/Retainer client, renews Q1/)
    expect(c.related.map((r) => r.name)).toContain('Priya Shah')
  })

  test('source kinds', () => {
    expect(sourceKindOf({ kind: 'connector', ref: 'brain:hubspot:d1', label: 'HubSpot deal' })).toBe('crm')
    expect(sourceKindOf({ kind: 'connector', ref: 'brain:quickbooks:i1' })).toBe('accounting')
    expect(sourceKindOf({ kind: 'connector', label: 'Slack' })).toBe('chat')
    expect(sourceKindOf({ kind: 'activity' })).toBe('activity')
    expect(sourceKindOf({ kind: 'chat', ref: 't1' })).toBe('chats')
  })

  test('scopes are cleaned, and summarized for Settings', () => {
    const s = cleanBrainScope({ sources: ['email', 'bogus'], entities: 'shared', sensitive: ['health', 'nope'], topics: ['  Pricing '], bots: [1] })
    expect(s).toEqual({ sources: ['email'], entities: 'shared', topics: ['pricing'], sensitive: ['health'], bots: [] })
    expect(scopeSummary(DEFAULT_BRAIN_SCOPE)).toMatch(/every source but texts · shared people, clients and projects · nothing sensitive/)
  })
})

describe('answers written only from the facts', () => {
  test('a model answer keeps only the chips it cited; NOT_FOUND routes to the owner', async () => {
    const b = fakeBrain()
    const r = b.reader.search('What did we promise Partner B?', DEFAULT_BRAIN_SCOPE)
    let seen = ''
    const a = await composeAnswer({ question: 'What did we promise Partner B?', facts: r.facts, commitments: r.commitments, scrub: (s) => s, ask: async (_s, user) => { seen = user; return 'Net 30, per the Oct 14 email. [F1]' } })
    expect(seen).toContain('Net 30')
    expect(a).toMatchObject({ answered: true, how: 'model', answer: 'Net 30, per the Oct 14 email.' })
    expect(a.chips[0].kind).toBe('email')
    const none = await composeAnswer({ question: 'What did we promise Partner B?', facts: r.facts, commitments: [], scrub: (s) => s, ask: async () => NOT_FOUND })
    expect(none.answered).toBe(false)
  })

  test('nothing relevant: not answered (no model call); no model: the facts themselves', async () => {
    const b = fakeBrain()
    let calls = 0
    const empty = await composeAnswer({ question: 'What is our office wifi password?', facts: [], commitments: [], scrub: (s) => s, ask: async () => { calls++; return 'x' } })
    expect(empty.answered).toBe(false)
    expect(calls).toBe(0)
    const r = b.reader.search('Priya proposal', DEFAULT_BRAIN_SCOPE)
    const plain = await composeAnswer({ question: 'Priya proposal', facts: r.facts, commitments: r.commitments, scrub: (s) => s })
    expect(plain).toMatchObject({ answered: true, how: 'facts' })
    expect(plain.answer).toMatch(/revised proposal/)
  })
})

describe('MCP brain tools (per-app scopes)', () => {
  const textOf = (r: ToolResult): string => r.content.map((c) => c.text).join('\n')
  function tools() {
    const b = fakeBrain()
    const host: McpHost = {
      db: b.db, memory: b.memory, emit: () => undefined, secretValues: () => b.secrets, brain: b.reader,
      agent: { isRunning: () => false, pending: () => [], send: async () => ({ done: Promise.resolve('finished' as const) }), steer: async () => 'sent' as const, whenIdle: async () => 'idle' as const }
    }
    const store = new McpClientStore(b.db)
    const t = new McpTools(host, store, { pollMs: 5 })
    const { client } = store.create('Claude Desktop')
    return { ...b, store, t, client }
  }
  const sig = (): AbortSignal => new AbortController().signal

  test('search_brain: facts with sources; the question is never logged', async () => {
    const x = tools()
    const r = await x.t.call(x.client, 'search_brain', { question: 'Where did we leave it with Priya?' }, sig())
    expect(r.isError).toBeFalsy()
    expect(textOf(r)).toMatch(/revised proposal[^\n]*Meeting notes · Mon/)
    expect((r.structuredContent as { facts: unknown[] }).facts.length).toBeGreaterThan(0)
    const log = x.store.activity(5)[0]
    expect(log).toMatchObject({ tool: 'search_brain', ok: true })
    expect(JSON.stringify(log)).not.toMatch(/Priya/)
  })

  test('get_person / get_client / get_project and open_commitments', async () => {
    const x = tools()
    const c = await x.t.call(x.client, 'get_client', { name: 'Acme Corp' }, sig())
    expect(JSON.parse(textOf(c)).brief).toMatch(/renews Q1/)
    const p = await x.t.call(x.client, 'get_person', { name: 'priya shah' }, sig())
    expect(JSON.parse(textOf(p)).facts.map((f: { text: string }) => f.text).join()).toMatch(/Head of Ops/)
    expect(textOf(await x.t.call(x.client, 'get_project', { name: 'Project Falcon' }, sig()))).toMatch(/No project named/)
    const oc = await x.t.call(x.client, 'open_commitments', { owed_by: 'you' }, sig())
    expect(JSON.parse(textOf(oc)).commitments).toEqual([expect.objectContaining({ what: 'send the revised proposal', owedBy: 'you', due: '2026-11-20' })])
    expect((await x.t.call(x.client, 'open_commitments', { owed_by: 'everyone' }, sig())).isError).toBe(true)
  })

  test('each app sees only its own scope, changed live; an empty scope shares nothing', async () => {
    const x = tools()
    x.store.setScope(x.client.id, { entities: [x.partnerB.id] })
    expect(textOf(await x.t.call(x.client, 'search_brain', { question: 'Priya proposal' }, sig()))).not.toMatch(/proposal/)
    expect(textOf(await x.t.call(x.client, 'search_brain', { question: 'What did we promise Partner B?' }, sig()))).toMatch(/Net 30/)
    x.store.setScope(x.client.id, { sources: [] })
    expect(textOf(await x.t.call(x.client, 'search_brain', { question: 'Partner B' }, sig()))).toMatch(/hasn't shared their brain/)
    const other = x.store.create('Cursor').client
    expect(textOf(await x.t.call(other, 'search_brain', { question: 'Where did we leave it with Priya?' }, sig()))).toMatch(/revised proposal/)
  })

  test('over HTTP with a real MCP client: the tools are listed and answer', async () => {
    const x = tools()
    const { token } = x.store.create('Claude Code')
    const host: McpHost = { db: x.db, memory: x.memory, emit: () => undefined, secretValues: () => x.secrets, brain: x.reader, agent: { isRunning: () => false, pending: () => [], send: async () => ({ done: Promise.resolve('finished' as const) }), steer: async () => 'sent' as const, whenIdle: async () => 'idle' as const } }
    let port = 0
    const server = new McpHttpServer({ host, store: x.store, version: 'test', savedPort: () => port, savePort: (p) => { port = p }, dir: mkdtempSync(join(tmpdir(), 'mcp-brain-')) })
    await server.start()
    try {
      const client = new Client({ name: 'test', version: '1' })
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(expect.arrayContaining(['search_brain', 'get_person', 'get_client', 'get_project', 'open_commitments']))
      const r = await client.callTool({ name: 'search_brain', arguments: { question: 'What did we promise Partner B?' } }) as ToolResult
      expect(textOf(r)).toMatch(/Net 30/)
      expect(textOf(r)).not.toMatch(/sk-live/)
      await client.close()
    } finally { await server.stop() }
  })
})
