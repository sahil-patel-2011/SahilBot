import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { ModelInfo, Settings } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import type { ToolDef } from '../../src/main/agent/types'

// "It shouldn't forget anything. If I have a project and it compacts 50 times, it shouldn't forget."
// The real agent loop on a small window (16K) against the mock LLM (127.0.0.1, no paid calls): a long project
// task in one chat, compacting every couple of turns, 50+ times. The mock's summarizer writes the same useless
// checkpoint every time (it keeps none of the task's facts), so whatever survives does so because the app saved
// it before each compaction and reads it back. Facts are planted in the first turns: a constraint, a file path and
// an API version (in a later message than the first, so the brief's verbatim first message doesn't carry them),
// a decision, a failed attempt, and a working-notes fact that the capped notes evict long before the end.

process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const { Agent } = await import('../../src/main/agent/loop')
const { ResultStore, upperEstimate } = await import('../../src/main/agent/context')
const { ToolRegistry } = await import('../../src/main/agent/registry')
const { coreTools } = await import('../../src/main/agent/tools/core')
const { renderNotes } = await import('../../src/main/agent/notes')
const { Db } = await import('../../src/main/db')
const { VaultService } = await import('../../src/main/vault/service')
const { workingMemoryPage } = await import('../../src/main/vault/working-memory')

const WINDOW = 16_384
const TARGET_COMPACTIONS = 50

const CONSTRAINT = 'Never use tabs for indentation in any file.'
const PATH = '/srv/ledger/config/sync.yaml'
const API = 'v2.3.1'
const DECISION = 'We chose Postgres over SQLite because we need concurrent writers.'
const FAILED_TARGET = 'staging-eu'
const NOTE_FACT = 'Retry queue for failed syncs is q-ledger-retry-7 (max 5 attempts)'

/** Deterministic filler, ~`tokens` tokens: a big tool result that fills the small window. */
const filler = (label: string, tokens: number): string => {
  const out: string[] = []
  for (let i = 1, n = 0; n < tokens * 3.2; i++) { const l = `${label} row ${i}: account ${(i * 7919) % 10000} balance ${(i * 31) % 997}.${i % 100} EUR ok`; out.push(l); n += l.length + 1 }
  return out.join('\n')
}

const readLedger: ToolDef<{ shard: string }> = {
  name: 'read_ledger', label: 'Read ledger', core: true, effect: 'read', description: 'Read one ledger shard.',
  parameters: { type: 'object', properties: { shard: { type: 'string' } }, required: ['shard'], additionalProperties: false },
  async run({ shard }) { return { text: filler(shard, 1700) } }
}
const deploy: ToolDef<{ target: string }> = {
  name: 'deploy', label: 'Deploy', core: true, effect: 'read', description: 'Deploy the sync service.',
  parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
  async run({ target }) { if (target === FAILED_TARGET) throw new Error('connection refused on port 5433'); return { text: `Deployed to ${target}` } }
}
const lookup: ToolDef<{ queue: string }> = {
  name: 'lookup', label: 'Look up', core: true, effect: 'read', description: 'Look up a queue.',
  parameters: { type: 'object', properties: { queue: { type: 'string' } }, required: ['queue'], additionalProperties: false },
  async run({ queue }) { return { text: `${queue}: 0 messages waiting` } }
}

const model: ModelInfo = { id: 'local-9b', provider: 'custom', providerName: 'Custom', enabled: true, installed: true, label: 'Local 9B', vision: false, tools: true, tier: 2, requiredGB: 8, maxFittingWindow: WINDOW, fits: true } as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm?.close() })

type Call = { name: string; arguments: string }
const call = (name: string, args: Record<string, unknown>): Call => ({ name, arguments: JSON.stringify(args) })

/** What the scripted model does in turn k: its tool calls, one per step, then a short reply. */
function plan(k: number): Call[] {
  if (k === 1) return [call('notes', { action: 'add', section: 'State', text: NOTE_FACT }), call('read_ledger', { shard: 'shard-1a' }), call('read_ledger', { shard: 'shard-1b' })]
  if (k === 3) return [call('deploy', { target: FAILED_TARGET }), call('read_ledger', { shard: 'shard-3a' })]
  // A new progress note every turn: the notes' State section (25 entries) evicts the early fact long before the end.
  return [call('notes', { action: 'add', section: 'State', text: `Batch ${k} synced: ${k * 40} ledger rows, checksum ok` }), call('read_ledger', { shard: `shard-${k}a` }), call('read_ledger', { shard: `shard-${k}b` })]
}

const userTurn = (k: number): string => {
  if (k === 1) return `Turn 1. Build the Ledger Sync service that mirrors the payments ledger into our warehouse. ${CONSTRAINT}`
  if (k === 2) return `Turn 2. The config lives at ${PATH} and we target the Payments API ${API}.`
  if (k === 3) return `Turn 3. ${DECISION}`
  return `Turn ${k}. Continue with the next shards.`
}

describe('50 compactions in one project: nothing planted early is forgotten', () => {
  test('every planted fact is saved, the core is in the prompt, a relevant fact comes back when a step names it, a new chat starts with the core, and the prompt stays in the window', async () => {
    const db = new Db(':memory:')
    const ws = mkdtempSync(join(tmpdir(), 'ws50-'))
    const vault = new VaultService({ db, workspace: () => ws })
    const page = workingMemoryPage(vault, db)
    const settings = {
      contextWindow: WINDOW, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'off', advanced: { hardStopsEnabled: true },
      workspaceDir: ws, userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [], customRules: [],
      cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0, contextStrategy: 'balanced', nativeTools: true }, keys: {}, search: { provider: 'none' }
    } as unknown as Settings
    const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res50-')))
    const registry = new ToolRegistry()
    registry.register(...coreTools(results), readLedger, deploy, lookup)
    const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
    const ep = { provider: 'custom', baseUrl: llm.url }
    const endpoints = { last, for: () => ep, usable: () => [model], list: async () => last, advisor: () => undefined }
    // eslint-disable-next-line prefer-const
    let agent: InstanceType<typeof Agent>
    agent = new Agent({
      db, results, registry, docsDir: tmpdir(),
      settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
      endpoints: endpoints as never, spaces: { getPrompt: () => '' } as never, memory: { block: () => '' } as never,
      emit: (e) => { if (e.type === 'pending') setTimeout(() => agent.respond(e.threadId, e.request.id, 'allow'), 0) },
      secretValues: () => [], fitWindow: (_m, w) => w,
      workingMemoryPage: () => page
    })
    const project = db.createSpace('Ledger Sync', '#336699', { kind: 'project', folder: ws })
    const chat = db.createThread(project.id, 'autonomous', model.id)

    // The scripted model: each chat request is the next step of the current turn (summaries are answered by the mock).
    let turnCalls: Call[] = []
    let stepInTurn = 0
    const reply = () => {
      const i = stepInTurn++
      return i < turnCalls.length ? { toolCalls: [turnCalls[i]], delay: 0 } : { content: 'Done with this part.', delay: 0 }
    }
    llm.script = Array.from({ length: 5000 }, () => reply)
    const compactions = (): number => db.listMessages(chat.id).filter((m) => m.kind === 'compacted').length
    const send = async (threadId: string, k: number, text: string, calls: Call[]): Promise<string> => {
      turnCalls = calls
      stepInTurn = 0
      return (await agent.send({ threadId, text })).done
    }

    let k = 0
    const started = Date.now()
    while (compactions() < TARGET_COMPACTIONS && k < 200) {
      k++
      expect(await send(chat.id, k, userTurn(k), plan(k))).toBe('finished')
    }
    const n = compactions()
    expect(n).toBeGreaterThanOrEqual(TARGET_COMPACTIONS)

    // 1. Every planted fact is in the durable store.
    const scope = agent.taskMemory.scopeOf(chat.id).key
    const stored = agent.taskMemory.list(scope)
    const find = (section: string, text: string) => stored.find((e) => e.section === section && e.text.includes(text))
    expect(find('Constraints', 'Never use tabs'), 'constraint').toMatchObject({ by: 'user', core: true })
    expect(find('Identifiers', PATH), 'path').toMatchObject({ by: 'user', core: true })
    expect(find('Identifiers', API), 'api version').toMatchObject({ by: 'user', core: true })
    expect(find('Decisions', 'Postgres over SQLite'), 'decision').toMatchObject({ by: 'user', core: true })
    expect(find('Failed attempts', FAILED_TARGET), 'failed attempt').toBeTruthy()
    expect(find('State', 'q-ledger-retry-7'), 'notes fact').toMatchObject({ core: false })
    // …although the capped notes dropped the early fact long ago, and the summaries never had any of it.
    expect(renderNotes(db.getState(chat.id), Number.MAX_SAFE_INTEGER)).not.toContain('q-ledger-retry-7')
    expect(db.getState(chat.id).compaction?.summary).not.toContain('Postgres')

    // 2. The core is in the prompt the model sees after the 50th compaction (the system text's task brief).
    const main = llm.requests.filter((r) => !String(r.messages?.[0]?.content ?? '').includes('You are compressing'))
    const lastReq = main[main.length - 1]
    const sys = String(lastReq.messages[0].content)
    const saved = sys.slice(sys.indexOf('Saved memory for this task'))
    expect(sys).toContain('Saved memory for this task')
    for (const fact of ['Never use tabs', PATH, API, 'Postgres over SQLite']) expect(saved, fact).toContain(fact)
    // The decision's own message (turn 3) is long gone from the brief's quoted messages: only the saved core has it.
    expect(sys.slice(0, sys.indexOf('Saved memory for this task'))).not.toContain('Postgres')

    // 3. A non-core fact comes back when the step names it: the model looks up the retry queue.
    k++
    const before = llm.requests.length
    expect(await send(chat.id, k, `Turn ${k}. Check the failed-sync queue.`, [call('lookup', { queue: 'q-ledger-retry-7' })])).toBe('finished')
    const after = llm.requests.slice(before).filter((r) => !String(r.messages?.[0]?.content ?? '').includes('You are compressing'))
    const recalled = after.find((r) => JSON.stringify(r.messages).includes('Saved project memory this step is about') && JSON.stringify(r.messages).includes('max 5 attempts'))
    if (!recalled) {
      const st = db.getState(chat.id)
      console.log('DEBUG memoryRecall', JSON.stringify(st.memoryRecall), 'entry', JSON.stringify(agent.taskMemory.list(scope).find((e) => e.text.includes('q-ledger'))), 'msgs', after.length, JSON.stringify(after.map((r) => r.messages.slice(-3))).slice(0, 3000))
      console.log('DEBUG sys has', String(after[0].messages[0].content).includes('q-ledger'))
    }
    expect(recalled, 'the retry-queue fact recalled into the step after the lookup').toBeTruthy()
    // The failed attempt is still known too (searchable, and in the summary's repaired Failed attempts).
    expect(agent.taskMemory.recallText(chat.id, 'deploy staging-eu').text).toContain('connection refused')

    // 4. A new chat in the same project starts with the core.
    const chat2 = db.createThread(project.id, 'autonomous', model.id)
    const b2 = llm.requests.length
    expect(await send(chat2.id, 1, 'What should I work on next for this service?', [])).toBe('finished')
    const first = llm.requests.slice(b2).find((r) => !String(r.messages?.[0]?.content ?? '').includes('You are compressing'))!
    const firstText = JSON.stringify(first.messages)
    for (const fact of ['Never use tabs', PATH, API, 'Postgres over SQLite']) expect(firstText, `new chat: ${fact}`).toContain(fact.replace(/"/g, '\\"'))

    // 5. The prompt stays within the window and doesn't grow without bound.
    const size = (r: Record<string, any>): number => upperEstimate(JSON.stringify(r.messages)) + upperEstimate(JSON.stringify(r.tools ?? []))
    const sizes = main.map(size)
    // upperEstimate counts high (3 chars a token, JSON escapes included); the app's own count must fit the window.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(WINDOW)
    const third = Math.floor(sizes.length / 3)
    const early = Math.max(...sizes.slice(third, 2 * third))
    const late = Math.max(...sizes.slice(2 * third))
    expect(late).toBeLessThanOrEqual(early * 1.15)
    const sysSizes = main.map((r) => String(r.messages[0].content).length)
    expect(Math.max(...sysSizes.slice(2 * third))).toBeLessThanOrEqual(Math.max(...sysSizes.slice(third, 2 * third)) * 1.15)

    // The project's working memory page in the vault has all of it, for the user to see and edit.
    const pageText = readFileSync(join(vault.root(), vault.sectionFor(project.id)!, 'Working memory.md'), 'utf8')
    for (const fact of ['Never use tabs', PATH, API, 'Postgres over SQLite', 'q-ledger-retry-7', FAILED_TARGET]) expect(pageText, `page: ${fact}`).toContain(fact)

    console.log('[fifty-compactions]', JSON.stringify({ turns: k, compactions: n, requests: main.length, summaries: llm.requests.length - main.length, maxPromptTokensUpper: Math.max(...sizes), window: WINDOW, saved: stored.length, archived: agent.taskMemory.list(scope, 'archived').length, superseded: agent.taskMemory.list(scope, 'superseded').length, ms: Date.now() - started }))
  }, 300_000)
})
