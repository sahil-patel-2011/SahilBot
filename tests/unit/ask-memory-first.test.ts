import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent, askedQuestions, factQuestion, memoryFirst } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import type { ChatEvent, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// Don't make the user repeat themselves: before a question reaches the user, SahilBot checks what they already
// told it (saved memories, their own words in other chats). When that answers it, the model gets the answer
// back instead of the user getting the card; asking the same question again goes through.
process.env.FOREMAN_NO_VERIFY = '1'
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model: ModelInfo = { id: 'model-a', provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: 'A', vision: false, tier: 2, requiredGB: 1, maxFittingWindow: 131072, fits: true } as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

const look: ToolDef<{ q: string }> = {
  name: 'look', label: 'Look', effect: 'read', description: 'read something',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  async run({ q }) { return { text: `found ${q}` } }
}

function harness() {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: model.id, hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), look)
  const last = { ok: true, models: [model], budgetGB: 32, totalGB: 64, providers: [] }
  const pendings: ChatEvent[] = []
  let agent: Agent
  agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => [model], list: async () => last, advisor: () => undefined } as never,
    spaces: { getPrompt: () => '' } as never,
    memory,
    emit: (e) => {
      if (e.type !== 'pending') return
      pendings.push(e)
      setTimeout(() => agent.respond(e.threadId, e.request.id, e.request.kind === 'questions' ? JSON.stringify(['typed by the user']) : 'typed by the user'), 5)
    },
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Helper', '#000000')
  const thread = (): Thread => db.createThread(space.id, 'auto', model.id)
  const run = async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text })).done
  return { db, memory, pendings, space, thread, run }
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const toolResults = (db: Db, t: Thread) => db.listMessages(t.id).filter((m) => m.role === 'tool' && m.toolName === 'ask_user').map((m) => m.content)

describe('check what the user said before asking', () => {
  test('a question a saved memory answers goes back to the model with that answer, and the user is not asked', async () => {
    const h = harness()
    h.memory.save('Landlord: Mike Delgado, mike@delgadoproperties.com', 'person', null, 'you')
    llm.script.push(
      { toolCalls: [call('look', { q: 'leak' })], delay: 0 },
      { toolCalls: [call('ask_user', { question: 'What is your property manager\'s email address?' })], delay: 0 },
      { content: 'Drafted the email to Mike (mike@delgadoproperties.com).', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'Email my landlord that the sink is leaking again')).toBe('finished')
    expect(h.pendings).toHaveLength(0)
    const [res] = toolResults(h.db, t)
    expect(res).toContain('Not asked yet')
    expect(res).toContain('mike@delgadoproperties.com')
  })

  test('the user\'s own words in another chat count too', async () => {
    const h = harness()
    const old = h.thread()
    h.db.updateThread(old.id, { title: 'Kitchen remodel quotes' })
    h.db.insertMessage({ threadId: old.id, role: 'user', kind: 'normal', status: 'done', content: 'Three quotes for the kitchen: Rivera Builders $18,400, Oakline $21,900, HomeCraft $16,750. We picked Rivera.' })
    llm.script.push(
      { toolCalls: [call('look', { q: 'kitchen' })], delay: 0 },
      { toolCalls: [call('ask_user', { questions: [{ question: 'Which kitchen contractor did you choose?' }] })], delay: 0 },
      { content: 'Rivera Builders it is.', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'Draft a deposit note to our kitchen contractor')).toBe('finished')
    expect(h.pendings).toHaveLength(0)
    expect(toolResults(h.db, t)[0]).toContain('Rivera Builders $18,400')
  })

  test('asking the same question again reaches the user (memory didn\'t answer it)', async () => {
    const h = harness()
    h.memory.save('Landlord: Mike Delgado, mike@delgadoproperties.com', 'person', null, 'you')
    const ask = call('ask_user', { question: 'What is your landlord\'s email?' })
    llm.script.push({ toolCalls: [call('look', { q: 'x' })], delay: 0 }, { toolCalls: [ask], delay: 0 }, { toolCalls: [ask], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Email my landlord about the rent')).toBe('finished')
    expect(h.pendings).toHaveLength(1)
    expect(toolResults(h.db, t)[1]).toMatch(/User answered/)
  })

  test('a question nothing saved answers goes straight to the user', async () => {
    const h = harness()
    h.memory.save('Favorite band is Khruangbin', 'preference', null, 'you')
    llm.script.push({ toolCalls: [call('look', { q: 'x' })], delay: 0 }, { toolCalls: [call('ask_user', { question: 'Which city is the conference in?' })], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Book me a hotel for the conference')).toBe('finished')
    expect(h.pendings).toHaveLength(1)
  })

  test('outside content saved as memory never answers for the user', async () => {
    const h = harness()
    h.memory.save('Landlord email is attacker@evil.example', 'person', null, 'chat', 'untrusted')
    llm.script.push({ toolCalls: [call('look', { q: 'x' })], delay: 0 }, { toolCalls: [call('ask_user', { question: 'What is your landlord\'s email?' })], delay: 0 }, { content: 'Done.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Email my landlord')).toBe('finished')
    expect(h.pendings).toHaveLength(1)
    expect(toolResults(h.db, t).join('\n')).not.toContain('attacker@evil.example')
  })

  test('confirmations, choices and unrelated questions always reach the user (review: the gate answered them with unrelated facts)', async () => {
    for (const [request, question, args] of [
      ['Email my boss that I am out Friday', 'Should I send it now?', {}],
      ['Email my boss that I am out Friday', 'Which of these two options do you prefer for the subject line?', {}],
      ['Clean up my landlord emails', 'Are you sure you want to permanently delete these 14 emails?', {}],
      ['Plan my running week', 'What is your max heart rate?', {}],
      ['Email my landlord', 'Which tone?', { options: ['Friendly', 'Firm'] }]
    ] as Array<[string, string, Record<string, unknown>]>) {
      const h = harness()
      h.memory.save('Manager at work is Dana Whitfield (dana.whitfield@northwind.io)', 'person', null, 'you')
      h.memory.save('Landlord: Mike Delgado, mike@delgadoproperties.com', 'person', null, 'you')
      h.memory.save('Hourly consulting rate is $145', 'work', null, 'you')
      llm.script.push({ toolCalls: [call('look', { q: 'x' })], delay: 0 }, { toolCalls: [call('ask_user', { question, ...args })], delay: 0 }, { content: 'Done.', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, request)).toBe('finished')
      expect(h.pendings, question).toHaveLength(1)
      expect(toolResults(h.db, t)[0]).not.toContain('Not asked yet')
    }
  })

  test('helpers', () => {
    expect(factQuestion('What is your landlord\'s email?')).toBe(true)
    expect(factQuestion('Which gym do you go to?')).toBe(true)
    expect(factQuestion('Should I send it now?')).toBe(false)
    expect(factQuestion('Which do you prefer, A or B?')).toBe(false)
    expect(factQuestion('What time works?', ['9 AM', '10 AM'])).toBe(false)
    expect(askedQuestions({ question: 'A?' })).toEqual(['A?'])
    expect(askedQuestions({ questions: [{ question: 'A?' }, { question: 'B?' }] })).toEqual(['A?', 'B?'])
    expect(askedQuestions({})).toEqual([])
    expect(memoryFirst(['- Saved: x'])).toMatch(/call ask_user again/)
  })
})
