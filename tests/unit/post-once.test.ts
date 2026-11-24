import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { Agent, QUICK_IN_FULL, SIMPLE_LOOKUPS, removeLinks, reviewedClean, testedOwnCode } from '../../src/main/agent/loop'
import { ResultStore, estimate } from '../../src/main/agent/context'
import { ToolRegistry } from '../../src/main/agent/registry'
import { coreTools } from '../../src/main/agent/tools/core'
import type { ToolDef } from '../../src/main/agent/types'
import { Db } from '../../src/main/db'
import type { ChatEvent, Message, ModelInfo, Settings, Thread } from '../../src/shared/types'
import { startMockLlm, type MockLlm } from '../fixtures/mock-llm'

// The head-to-head report (ALD-03, ALD-04, RLB-01, ALC-07, PCA-02/03): "Check first, post once". An answer the user
// has seen is never pulled back (the Savannah plan vanished mid-read while links were rechecked); a finished answer's
// "Want me to email it?" is an offer, not a stall; a simple task stops looking after ~15 lookups; a bot's one
// ongoing conversation still answers a quick question as a chat.
process.env.FOREMAN_NO_AUTOTITLE = '1'

const model = (id: string, tier: 0 | 1 | 2 | 3): ModelInfo =>
  ({ id, provider: 'ollama', providerName: 'Ollama', enabled: true, installed: true, label: id.toUpperCase(), vision: false, tier, requiredGB: 1, maxFittingWindow: 131072, fits: true }) as ModelInfo

let llm: MockLlm
beforeAll(async () => { llm = await startMockLlm() })
afterAll(async () => { await llm.close() })
afterEach(() => { llm.script.length = 0; llm.requests.length = 0 })

function harness(tools: ToolDef[] = []) {
  const models = [model('model-a', 2)]
  const db = new Db(':memory:')
  const settings = {
    contextWindow: 32768, taskModels: { voice: '', background: '' }, sampling: {}, thinking: 'medium', advanced: { hardStopsEnabled: true },
    workspaceDir: mkdtempSync(join(tmpdir(), 'ws-')), userName: 'Sam', defaultModel: models[0].id, hiddenModels: [], shownModels: [],
    cloud: { enabled: false, hybrid: false, advisorModel: '', maxConsultsPerRequest: 0 }, customRules: []
  } as unknown as Settings
  const results = new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))
  const registry = new ToolRegistry()
  registry.register(...coreTools(results), ...tools)
  // Every event as it was when it was sent (the agent keeps changing the same message object afterwards).
  const events: ChatEvent[] = []
  const last = { ok: true, models, budgetGB: 32, totalGB: 64, providers: [] }
  const endpoints = { last, for: () => ({ provider: 'custom', baseUrl: llm.url }), usable: () => models, list: async () => last, advisor: () => undefined }
  const agent: Agent = new Agent({
    db, results, registry, docsDir: tmpdir(),
    settings: { get: () => settings, keyFor: () => undefined, apiKey: () => undefined } as never,
    endpoints: endpoints as never,
    spaces: { getPrompt: () => '' } as never,
    memory: { block: () => '' } as never,
    emit: (e) => { events.push(JSON.parse(JSON.stringify(e)) as ChatEvent) },
    secretValues: () => [],
    fitWindow: (_m, w) => w,
    counter: () => ({ count: async (t: string) => estimate(t) })
  })
  const space = db.createSpace('Alpha', '#000000')
  const thread = (): Thread => db.createThread(space.id, 'auto', models[0].id)
  const run = async (t: Thread, text: string) => (await agent.send({ threadId: t.id, text })).done
  /** Assistant messages the user saw (emitted with words, not provisional, not replaced), by id. */
  const shown = (threadId: string): Set<string> => {
    const ids = new Set<string>()
    for (const e of events) {
      if (e.type !== 'message' || e.threadId !== threadId) continue
      const m = e.message as Message
      if (m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.provisional && !m.meta?.superseded) ids.add(m.id)
    }
    return ids
  }
  const visible = (threadId: string): Message[] => db.listMessages(threadId).filter((m) => m.role === 'assistant' && m.kind === 'normal' && m.content && !m.meta?.superseded && !m.meta?.hidden)
  return { db, agent, events, thread, run, shown, visible }
}

const call = (name: string, args: Record<string, unknown>) => ({ name, arguments: JSON.stringify(args) })
const save: ToolDef<{ v: string }> = {
  name: 'save_note', label: 'Save', effect: 'write_local', description: 'save something',
  parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'], additionalProperties: false },
  async run({ v }) { return { text: `saved ${v}` } }
}
const look: ToolDef<{ q: string }> = {
  name: 'look', label: 'Look', effect: 'read', description: 'read something',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
  async run({ q }) { return { text: `found ${q}` } }
}

describe('check first, post once', () => {
  test('a file task\'s answer is written out of sight while it is double-checked, then shown once', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const h = harness([save])
      // The check finds nothing ("✓"): the answer it wrote is the one shown, once.
      llm.script.push({ toolCalls: [call('save_note', { v: 'y' })], delay: 0 }, { content: 'Saved y to your notes.', delay: 0 }, { content: '✓', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, 'Save a note that says y in my notes file')).toBe('finished')
      expect(h.db.listMessages(t.id).filter((m) => m.meta?.hidden && /double-check/.test(m.content))).toHaveLength(1)
      const seen = [...h.shown(t.id)].map((id) => h.db.getMessage(id)!)
      // Everything the user saw is still there (nothing appeared and then vanished), and the answer was shown once.
      for (const m of seen) expect(m.meta?.superseded, m.content).toBeFalsy()
      expect(seen.filter((m) => m.content === 'Saved y to your notes.')).toHaveLength(1)
      expect(h.visible(t.id).map((m) => m.content)).toEqual(['Saved y to your notes.'])
      // Never shown while it was checked: the draft's emits were all provisional.
      const draft = h.db.listMessages(t.id).find((m) => m.role === 'assistant' && m.content === 'Saved y to your notes.' && m.meta?.superseded)
      if (draft) expect(h.shown(t.id).has(draft.id)).toBe(false)

      // The check rewrites it: only the checked answer is ever shown.
      llm.script.push({ toolCalls: [call('save_note', { v: 'z' })], delay: 0 }, { content: 'Saved it.', delay: 0 }, { content: 'Saved "z" to notes.txt.', delay: 0 })
      const t2 = h.thread()
      expect(await h.run(t2, 'Save a note that says z in my notes file')).toBe('finished')
      const seen2 = [...h.shown(t2.id)].map((id) => h.db.getMessage(id)!)
      expect(seen2.map((m) => m.content)).toEqual(['Saved "z" to notes.txt.'])
      expect(h.db.listMessages(t2.id).some((m) => m.meta?.provisional)).toBe(false)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  // RLB-03 (round 3): the check's own step ("Let me re-read the notes.") is marked so the chat keeps it in Show work.
  test('a double-check step is marked as the check\'s own step; the run\'s earlier steps are not', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const h = harness([save, look])
      llm.script.push(
        { content: 'Saving it now.', toolCalls: [call('save_note', { v: 'y' })], delay: 0 },
        { content: 'Saved y to your notes.', delay: 0 },
        { content: 'Let me re-read the notes to confirm.', toolCalls: [call('look', { q: 'notes' })], delay: 0 },
        { content: '✓', delay: 0 }
      )
      const t = h.thread()
      expect(await h.run(t, 'Save a note that says y in my notes file')).toBe('finished')
      const steps = h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.toolCalls?.length)
      expect(steps.map((m) => [m.content, !!m.meta?.checkStep])).toEqual([['Saving it now.', false], ['Let me re-read the notes to confirm.', true]])
      // Every emit of the check step carried the mark (it was never shown as plain words first).
      const emits = h.events.flatMap((e) => (e.type === 'message' && e.message.id === steps[1].id && !e.message.meta?.provisional ? [e.message] : []))
      for (const m of emits) expect(m.meta?.checkStep).toBe(true)
      expect(h.visible(t.id).filter((m) => !m.toolCalls?.length).map((m) => m.content)).toEqual(['Saved y to your notes.'])
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  // RLA-01 / acceptance "Trip plan" (round 3): a researched answer that changed nothing is posted after its one
  // generation, with no second model turn to double-check it (the link check still guards its citations).
  test('a research-only answer is not sent through a second double-check turn', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const search: ToolDef<{ query: string }> = {
        name: 'web_search', label: 'Search', effect: 'read', description: 'search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
        async run({ query }) { return { text: `results for ${query}` } }
      }
      const h = harness([search])
      llm.script.push(
        { toolCalls: [call('web_search', { query: 'savannah hotels' })], delay: 0 },
        { toolCalls: [call('web_search', { query: 'savannah food' })], delay: 0 },
        { toolCalls: [call('web_search', { query: 'savannah tours' })], delay: 0 },
        { content: 'Day 1: River Street walk. Day 2: Forsyth Park.', delay: 0 }
      )
      const t = h.thread()
      expect(await h.run(t, 'Plan a 2-day Savannah trip for 4 people under $1,500, research hotels, food and tours')).toBe('finished')
      expect(llm.requests).toHaveLength(4)
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/i.test(m.content))).toBe(false)
      expect(h.visible(t.id).filter((m) => !m.toolCalls?.length).map((m) => m.content)).toEqual(['Day 1: River Street walk. Day 2: Forsyth Park.'])
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  test('a link nobody retrieved comes out of the answer in place: it is never sent back or replaced', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    llm.script.push({ content: 'Qwen 3.8 came out in October. Source: https://unseen.example/qwen-news\n\nSources:\n[1] Qwen news https://unseen.example/qwen-news', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'When did Qwen 3.8 come out?')).toBe('finished')
    expect(llm.requests).toHaveLength(1)
    const ms = h.db.listMessages(t.id).filter((m) => m.role === 'assistant' && m.content)
    expect(ms).toHaveLength(1)
    expect(ms[0].meta?.superseded).toBeFalsy()
    expect(ms[0].content).toBe('Qwen 3.8 came out in October.')
    expect(ms[0].meta?.linksRemoved).toEqual(['https://unseen.example/qwen-news'])
  })

  test('a finished answer that offers one more step stays as written; nothing unasked is done for it', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness([save, look])
    llm.script.push({ toolCalls: [call('save_note', { v: 'invoice' })], delay: 0 }, { content: 'Saved invoice.pdf to Downloads. Want me to email it to Jane?', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Make an invoice for Jane for 3 hours of tutoring and save it to my notes')).toBe('finished')
    expect(llm.requests).toHaveLength(2)
    expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /Don't stop to ask permission/.test(m.content))).toBe(false)
    expect(h.visible(t.id).at(-1)?.content).toBe('Saved invoice.pdf to Downloads. Want me to email it to Jane?')

    // Mid-task ("I found X. Want me to add them?" after only looking): still the step the task asked for.
    llm.requests.length = 0
    llm.script.push({ toolCalls: [call('look', { q: 'invoices' })], delay: 0 }, { content: 'I found INV-104 and INV-109. Want me to add them?', delay: 0 }, { toolCalls: [call('save_note', { v: 'INV-104, INV-109' })], delay: 0 }, { content: 'Added INV-104 and INV-109 to the list.', delay: 0 })
    const t2 = h.thread()
    expect(await h.run(t2, 'Find the overdue invoices and put them on the collections list')).toBe('finished')
    expect(h.db.listMessages(t2.id).filter((m) => m.meta?.hidden && /Don't stop to ask permission/.test(m.content))).toHaveLength(1)
    // The offer was written out of sight (agent work) and replaced: it never appeared.
    const offer = h.db.listMessages(t2.id).find((m) => m.content.startsWith('I found INV-104'))!
    expect(offer.meta?.superseded).toBe(true)
    expect(h.shown(t2.id).has(offer.id)).toBe(false)
    expect(h.visible(t2.id).map((m) => m.content)).toEqual(['Added INV-104 and INV-109 to the list.'])
  })

  test(`a simple task is told it has enough after ${SIMPLE_LOOKUPS} lookups, once`, async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const search: ToolDef<{ query: string }> = {
      name: 'web_search', label: 'Search', effect: 'read', description: 'search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      async run({ query }) { return { text: `results for ${query}` } }
    }
    const h = harness([search])
    let n = 0
    llm.script.push(...Array.from({ length: 40 }, () => (req: Record<string, any>) => JSON.stringify(req.messages).includes('You have enough to answer')
      ? { content: 'Here is the plan for Savannah: three days, four people, about $1,450.', delay: 0 }
      : { toolCalls: [call('web_search', { query: `savannah ${++n}` })], delay: 0 }))
    const t = h.thread()
    expect(await h.run(t, 'Plan a 3-day trip to Savannah for 4 people with a $1,500 budget')).toBe('finished')
    const notes = h.db.listMessages(t.id).filter((m) => m.meta?.wrapUp)
    expect(notes).toHaveLength(1)
    expect(n).toBe(SIMPLE_LOOKUPS)
    expect(h.visible(t.id).at(-1)?.content).toMatch(/^Here is the plan for Savannah/)
  })

  test('create_document\'s own clean review counts as checking the file (no second pass)', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const doc: ToolDef<{ path: string }> = {
        name: 'create_document', label: 'Document', effect: 'write_local', description: 'make a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        async run({ path }) { return { text: `Created pdf ${path} (1 page, 20 KB).\n\nReview of ${path} (1 page): PASS — 0 to fix, 0 warnings\nReady to present.`, path } }
      }
      const h = harness([doc])
      llm.script.push({ toolCalls: [call('create_document', { path: 'invoice.pdf' })], delay: 0 }, { content: 'Made invoice.pdf in your workspace.', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, 'Make me an invoice PDF for 3 hours of tutoring at $40/hour')).toBe('finished')
      expect(llm.requests).toHaveLength(2)
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
      expect(h.visible(t.id).map((m) => m.content)).toEqual(['Made invoice.pdf in your workspace.'])
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })
})

describe('running what the run wrote is the check', () => {
  const write: ToolDef<{ path: string; content: string }> = {
    name: 'file_write', label: 'Write', effect: 'write_local', description: 'write a file',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
    async run({ path }) { return { text: `Wrote ${path}`, path: `/Users/sam/Downloads/${path}` } }
  }
  const shell: ToolDef<{ command: string }> = {
    name: 'run_command', label: 'Terminal', effect: 'write_local', description: 'run a command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
    async run({ command }) { return { text: `$ ${command}\n(exit code 0)\nwould rename 3 files`, data: { exitCode: 0 } } }
  }
  test('write the script, run it on a sample, answer: no hidden double-check round', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const h = harness([write, shell])
      llm.script.push(
        { toolCalls: [call('file_write', { path: 'rename_photos.py', content: 'print(1)' })], delay: 0 },
        { toolCalls: [call('run_command', { command: 'python3 rename_photos.py --dry-run sample' })], delay: 0 },
        { content: 'Saved rename_photos.py in Downloads and tried it on a sample: it would rename 3 files.', delay: 0 }
      )
      const t = h.thread()
      expect(await h.run(t, 'Write a Python script that renames my photos by date taken')).toBe('finished')
      expect(llm.requests).toHaveLength(3)
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  test('opening the file it just made and checked (macOS open) does not mark it unchecked again', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const doc: ToolDef<{ path: string }> = {
        name: 'create_document', label: 'Document', effect: 'write_local', description: 'make a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
        async run({ path }) { return { text: `Created pdf ${path}.\n\nReview of ${path} (1 page): PASS — 0 to fix, 0 warnings`, path } }
      }
      const h = harness([doc, shell])
      llm.script.push({ toolCalls: [call('create_document', { path: 'invoice.pdf' })], delay: 0 }, { toolCalls: [call('run_command', { command: 'open invoice.pdf' })], delay: 0 }, { content: 'Made invoice.pdf and opened it.', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, 'Make me an invoice PDF for 3 hours of tutoring at $40/hour and open it')).toBe('finished')
      expect(llm.requests).toHaveLength(3)
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  test('a command that runs something else still leaves the work to check', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const h = harness([write, shell])
      llm.script.push(
        { toolCalls: [call('file_write', { path: 'notes.txt', content: 'x' })], delay: 0 },
        { toolCalls: [call('run_command', { command: 'mkdir -p out' })], delay: 0 },
        { content: 'Done: notes.txt is in Downloads.', delay: 0 }, { content: '✓', delay: 0 }
      )
      const t = h.thread()
      expect(await h.run(t, 'Write my notes to notes.txt and make an out folder')).toBe('finished')
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(true)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })

  // Review round 3 (PCA-04, CDA-01): how models really test a script ("2>&1", "cd … &&", "~/" paths, setup first).
  for (const command of [
    'python3 rename_photos.py --dry-run sample 2>&1',
    'cd ~/Downloads && python3 rename_photos.py --dry-run test',
    'python3 ~/Downloads/rename_photos.py --dry-run ~/Downloads/test',
    'mkdir -p sample && touch sample/a.jpg && python3 rename_photos.py sample && python3 rename_photos.py sample --apply'
  ]) {
    test(`running the script it wrote as "${command}" is the check: 3 requests, no hidden double-check`, async () => {
      delete process.env.FOREMAN_NO_VERIFY
      try {
        const h = harness([write, shell])
        llm.script.push(
          { toolCalls: [call('file_write', { path: 'rename_photos.py', content: 'print(1)' })], delay: 0 },
          { toolCalls: [call('run_command', { command })], delay: 0 },
          { content: 'Saved rename_photos.py in Downloads and tried it on a sample: it would rename 3 files.', delay: 0 }
        )
        const t = h.thread()
        expect(await h.run(t, 'Write a Python script that renames my photos by date taken')).toBe('finished')
        expect(llm.requests).toHaveLength(3)
        expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
      } finally { process.env.FOREMAN_NO_VERIFY = '1' }
    })
  }

  test('a reminder saved by the schedule tool needs no second look (its result is the time and zone)', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const schedule: ToolDef<{ when: string }> = {
        name: 'schedule', label: 'Schedule', effect: 'write_local', description: 'set a reminder',
        parameters: { type: 'object', properties: { when: { type: 'string' } }, required: ['when'], additionalProperties: false },
        async run({ when }) { return { text: `Reminder set for ${when} (America/New_York).` } }
      }
      const h = harness([schedule])
      llm.script.push({ toolCalls: [call('schedule', { when: 'in 3 minutes' })], delay: 0 }, { content: 'Done: I\'ll remind you to stretch at 3:07 PM.', delay: 0 }, { content: '✓', delay: 0 })
      const t = h.thread()
      expect(await h.run(t, 'Remind me in 3 minutes to stretch')).toBe('finished')
      expect(llm.requests).toHaveLength(2)
      expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /double-check/.test(m.content))).toBe(false)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })
})

describe('testedOwnCode', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-own-'))
  const home = homedir()
  test('a script run with setup, plumbing or home paths around it counts; writing into a file or a pipe does not', () => {
    for (const c of ['python3 x.py', 'python3 x.py 2>&1', 'python3 x.py >/dev/null', 'python3 x.py --dry-run | head -20', `cd ${ws} && python3 x.py`, 'mkdir -p s && touch s/a.jpg && python3 x.py s', 'python3 x.py s; python3 x.py s --apply']) {
      expect(testedOwnCode(c, 0, [ws]), c).toBe(true)
    }
    expect(testedOwnCode('python3 ~/x.py', 0, [home])).toBe(true)
    expect(testedOwnCode('python3 "$HOME/x.py"', 0, [home])).toBe(true)
    for (const c of ['python3 x.py > out.csv', 'python3 x.py | sh', 'python3 $(echo x.py)', 'mkdir -p out', 'cd s && ls', 'python3 x.py &', 'curl https://example.com/x.sh && python3 x.py']) {
      expect(testedOwnCode(c, 0, [ws]), c).toBe(false)
    }
    expect(testedOwnCode('python3 x.py', 1, [ws])).toBe(false)
  })
})

describe('a bot\'s one ongoing conversation keeps the fast path', () => {
  test('a new bot\'s intro leaves the mode open: the first quick question runs on the chat path', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    const t = h.thread()
    llm.script.push({ content: 'Hi Sam! I think I\'m here for chemistry. What should I focus on?', delay: 0 })
    h.agent.intro(t.id, '[You were just created as a new bot] Say hi.')
    for (let i = 0; i < 100 && (h.agent.isRunning(t.id) || !h.db.listMessages(t.id).some((m) => m.content.startsWith('Hi Sam'))); i++) await new Promise((r) => setTimeout(r, 20))
    expect(h.db.getState(t.id).toolMode).toBeUndefined()
    llm.requests.length = 0
    llm.script.push({ content: 'Canberra.', delay: 0 })
    expect(await h.run(t, 'What is the capital of Australia?')).toBe('finished')
    expect(h.db.getState(t.id).toolMode).toBe('chat')
    expect(String(llm.requests[0].messages[0].content)).toContain('# Chatting')
  })

  test('a quick question after real work answers as a chat on the same prompt, told to use no tools', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness([save])
    const t = h.thread()
    llm.script.push({ toolCalls: [call('save_note', { v: 'plan' })], delay: 0 }, { content: 'Saved your study plan.', delay: 0 })
    expect(await h.run(t, 'Save my study plan to my notes file')).toBe('finished')
    expect(h.db.getState(t.id).toolMode).toBe('full')
    llm.requests.length = 0
    llm.script.push({ content: 'Canberra.', delay: 0 })
    expect(await h.run(t, 'What is the capital of Australia?')).toBe('finished')
    expect(llm.requests).toHaveLength(1)
    expect(JSON.stringify(llm.requests[0].messages)).toContain(QUICK_IN_FULL.slice(0, 60))
    expect(h.db.getState(t.id).lastKind).toBe('chat')
    // A chat streams as it's written (never provisional), and the answer stands.
    const answer = h.visible(t.id).at(-1)!
    expect(answer.content).toBe('Canberra.')
    expect(h.events.some((e) => e.type === 'message' && (e.message as Message).id === answer.id && (e.message as Message).meta?.provisional)).toBe(false)
  })
})

describe('one reply per question in a chat', () => {
  test('a chat lookup that failed: the give-up reply waits out of sight, and only the real answer is shown', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    let n = 0
    const search: ToolDef<{ query: string }> = {
      name: 'web_search', label: 'Search', effect: 'read', description: 'search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      async run({ query }) { if (n++ === 0) throw new Error('HTTP 403 blocked'); return { text: `results for ${query}: 72F and sunny` } }
    }
    const h = harness([search])
    llm.script.push(
      { toolCalls: [call('web_search', { query: 'atlanta weather' })], delay: 0 },
      { content: 'I couldn\'t get the weather: the site blocked me.', delay: 0 },
      { toolCalls: [call('web_search', { query: 'atlanta weather today' })], delay: 0 },
      { content: 'It\'s 72°F and sunny in Atlanta.', delay: 0 }
    )
    const t = h.thread()
    expect(await h.run(t, 'What is the weather in Atlanta right now?')).toBe('finished')
    expect(h.db.getState(t.id).lastKind).toBe('chat')
    const words = [...h.shown(t.id)].map((id) => h.db.getMessage(id)!).filter((m) => !m.toolCalls?.length)
    expect(words.map((m) => m.content)).toEqual(['It\'s 72°F and sunny in Atlanta.'])
    expect(h.visible(t.id).filter((m) => !m.toolCalls?.length).map((m) => m.content)).toEqual(['It\'s 72°F and sunny in Atlanta.'])
  })

  test('a chat reply that opens with "I can\'t" is held, so the nudge replaces it: one answer on screen', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    llm.script.push({ content: 'I can\'t access your calendar from here.', delay: 0 }, { content: 'You have nothing on Friday.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Hey, what do you think about my week?')).toBe('finished')
    expect(llm.requests).toHaveLength(2)
    expect(h.visible(t.id).map((m) => m.content)).toEqual(['You have nothing on Friday.'])
    expect([...h.shown(t.id)].map((id) => h.db.getMessage(id)!.content)).toEqual(['You have nothing on Friday.'])
  })
})

// IWD-01, HTA-03 (round 3): text the user asked the bot to write is not a claim about this run, and a reply already on
// screen is never rewritten or turned into an error afterwards.
describe('false-claim check on chat replies', () => {
  const NOTE = /couldn't confirm this worked/
  const nudged = (h: ReturnType<typeof harness>, id: string): boolean => h.db.listMessages(id).some((m) => m.role === 'user' && m.meta?.hidden && /\[From the app\] Your reply says/.test(m.content))
  for (const [ask, reply] of [
    ['Draft an email to Mr. Lopez telling him I turned in the homework', 'Here\'s a draft you can send:\n\nHi Mr. Lopez,\n\nI submitted the homework yesterday afternoon. Thank you for the extension.\n\nBest,\nSam'],
    ['Write a very short story about a spy', 'The rain had not stopped all night. "I have sent it," she whispered, and the line went dead.'],
    ['Write exactly 30 words about autumn', 'Autumn arrives quietly. The summer heat has been removed from the air, leaves turn gold and red, and evenings grow cool, calm, and short as the year winds down again.']
  ] as const) {
    test(`a requested draft is not a false claim: "${ask}"`, async () => {
      process.env.FOREMAN_NO_VERIFY = '1'
      const h = harness()
      llm.script.push({ content: reply, delay: 0 })
      const t = h.thread()
      expect(await h.run(t, ask)).toBe('finished')
      expect(llm.requests).toHaveLength(1)
      expect(nudged(h, t.id)).toBe(false)
      expect(h.visible(t.id).map((m) => m.content)).toEqual([reply])
    })
  }

  test('"I\'ve double-checked the math" in a plain answer is left alone', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    llm.script.push({ content: 'I\'ve double-checked the math: 18% of 1,740 is 313.2.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Calculate 18% of 1740')).toBe('finished')
    expect(llm.requests).toHaveLength(1)
    expect(nudged(h, t.id)).toBe(false)
    expect(h.visible(t.id).map((m) => m.content)).toEqual(['I\'ve double-checked the math: 18% of 1,740 is 313.2.'])
  })

  test('a chat reply already on screen keeps its words; the unbacked claim is only marked', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    const reply = 'Here\'s the plan for Saturday: lunch at noon, then the park. I\'ve sent it to Jane.'
    llm.script.push({ content: reply, delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Make a plan for Saturday with Jane')).toBe('finished')
    const [m] = h.visible(t.id)
    expect(m.content).toBe(reply)
    expect(m.content).not.toMatch(NOTE)
    expect(m.meta?.unbackedClaim).toBe(true)
    expect(llm.requests).toHaveLength(1)
  })

  test('a chat that opens with "I\'ve saved it" and ran nothing is still held, nudged and then noted', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    llm.script.push({ content: 'I\'ve saved it to your Downloads.', delay: 0 }, { content: 'I\'ve saved it to your Downloads.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Hey, keep that list for later')).toBe('finished')
    expect(nudged(h, t.id)).toBe(true)
    const shown = h.visible(t.id)
    expect(shown).toHaveLength(1)
    // Its words stay its own; the "Needs a check" badge flags it (nothing is tacked onto the reply).
    expect(shown[0].content).not.toMatch(NOTE)
    expect(shown[0].meta?.unbackedClaim).toBe(true)
  })
})

describe('an exact count is checked before the reply is shown', () => {
  test('"exactly 10 words": a 9-word reply is rewritten out of sight; only the 10-word one shows', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness()
    llm.script.push({ content: 'Coffee wakes me up and makes mornings feel brighter.', delay: 0 }, { content: 'Coffee wakes me up and makes mornings feel much brighter.', delay: 0 })
    const t = h.thread()
    expect(await h.run(t, 'Write exactly 10 words about coffee.')).toBe('finished')
    expect(llm.requests).toHaveLength(2)
    expect(h.visible(t.id).map((m) => m.content)).toEqual(['Coffee wakes me up and makes mornings feel much brighter.'])
    expect([...h.shown(t.id)].map((id) => h.db.getMessage(id)!.content)).toEqual(['Coffee wakes me up and makes mornings feel much brighter.'])
  })
})

describe('a side sum during the double-check', () => {
  test('"18% of $1,740?" is answered at once and the check goes on', async () => {
    delete process.env.FOREMAN_NO_VERIFY
    try {
      const h = harness([save])
      llm.script.push({ toolCalls: [call('save_note', { v: 'invoice' })], delay: 0 }, { content: 'Saved the invoice to your notes.', delay: 0 }, { content: 'Looks right to me. '.repeat(30), delay: 20 })
      const t = h.thread()
      const done = (await h.agent.send({ threadId: t.id, text: 'Save an invoice note for Jane in my notes file' })).done
      for (let i = 0; i < 300 && llm.requests.length < 3; i++) await new Promise((r) => setTimeout(r, 10))
      expect(await h.agent.steer(t.id, '18% of $1,740?')).toBe('steered')
      for (let i = 0; i < 50 && !h.db.listMessages(t.id).some((m) => m.meta?.aside && m.role === 'assistant'); i++) await new Promise((r) => setTimeout(r, 10))
      expect(h.db.listMessages(t.id).filter((m) => m.meta?.aside && m.role === 'assistant').map((m) => m.content)).toEqual(['18% of $1,740 = $313.20.'])
      expect(h.agent.isRunning(t.id)).toBe(true)
      expect(await done).toBe('finished')
      // No fresh run for the sum: the check's answer is the last thing the model wrote.
      expect(llm.requests).toHaveLength(3)
    } finally { process.env.FOREMAN_NO_VERIFY = '1' }
  })
})

describe('a stopped or finished task closes its plan', () => {
  test('a quick question after a stopped task with open plan items is a chat: no tools, no "plan still has open items"', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness([save])
    const t = h.thread()
    const items = [{ text: 'Draft the outline', status: 'done' }, { text: 'Write section 2', status: 'in_progress' }, { text: 'Proofread', status: 'pending' }]
    llm.script.push({ toolCalls: [call('todo', { items })], delay: 0 }, { content: 'Writing section 2 now, this is a long section about the topic. '.repeat(40), delay: 30 })
    const done = (await h.agent.send({ threadId: t.id, text: 'Write my report on rivers: outline, section 2, then proofread it' })).done
    for (let i = 0; i < 200 && llm.requests.length < 2; i++) await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 60))
    h.agent.stop(t.id, { byUser: true })
    expect(await done).toBe('stopped')
    // Kept for a "continue"; any other request leaves it waiting (it never drives that request).
    expect(h.db.getState(t.id).planPaused).toBe(true)
    expect(h.db.getState(t.id).todos).toHaveLength(3)
    llm.requests.length = 0
    llm.script.push({ content: 'Canberra.', delay: 0 })
    expect(await h.run(t, 'What is the capital of Australia?')).toBe('finished')
    expect(h.db.getState(t.id).planPaused).toBe(true)
    expect(llm.requests).toHaveLength(1)
    expect(h.db.getState(t.id).lastKind).toBe('chat')
    expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /plan still has open items/.test(m.content))).toBe(false)
    expect(h.visible(t.id).at(-1)?.content).toBe('Canberra.')
    // Review round 3 (ALA-01/04, PCA-02): "Okay, …" or "Sure, …" opening a new request does not pick the task up again.
    for (const [q, a] of [['Okay, what is the capital of Australia?', 'Canberra.'], ['Sure, write me a haiku about rain', 'Rain taps the window']]) {
      llm.requests.length = 0
      llm.script.push({ content: a, delay: 0 })
      expect(await h.run(t, q)).toBe('finished')
      expect(llm.requests, q).toHaveLength(1)
      expect(h.db.getState(t.id).lastKind, q).toBe('chat')
      expect(h.db.getState(t.id).planPaused, q).toBe(true)
    }
    expect(h.db.listMessages(t.id).some((m) => m.meta?.hidden && /plan still has open items/.test(m.content))).toBe(false)
    // "Continue." picks it up.
    llm.requests.length = 0
    const finished = items.map((i) => ({ ...i, status: 'done' }))
    llm.script.push({ toolCalls: [call('todo', { items: finished })], delay: 0 }, { content: 'Done: section 2 is written and the report is proofread.', delay: 0 })
    expect(await h.run(t, 'Continue.')).toBe('finished')
    expect(h.db.getState(t.id).planPaused).toBeUndefined()
    expect(h.db.getState(t.id).lastKind).toBe('agent')
  })

  test('a run that ends on a question to the user keeps its plan for the answer', async () => {
    process.env.FOREMAN_NO_VERIFY = '1'
    const h = harness([save])
    const t = h.thread()
    const items = [{ text: 'Pick a date', status: 'in_progress' }, { text: 'Book it', status: 'pending' }]
    llm.script.push({ toolCalls: [call('todo', { items })], delay: 0 }, { content: 'Which date works for you, Friday or Saturday?', delay: 0 })
    expect(await h.run(t, 'Plan the team dinner and book it for us')).toBe('finished')
    expect(h.db.getState(t.id).todos).toHaveLength(2)
  })
})

describe('helpers', () => {
  test('removeLinks: titles stay, source lines and bare links go, sentences keep their periods', () => {
    const u = 'https://unseen.example/a'
    expect(removeLinks(`See [the guide](${u}) for more.`, [u])).toBe('See the guide for more.')
    expect(removeLinks(`It opened in 2024 (source: ${u}).`, [u])).toBe('It opened in 2024.')
    expect(removeLinks(`Read it at ${u}.`, [u])).toBe('Read it at.')
    expect(removeLinks(`Plan.\n\nSources:\n[1] Seen https://seen.example/b\n[2] Guide ${u}`, [u])).toBe('Plan.\n\nSources:\n[1] Seen https://seen.example/b')
    expect(removeLinks(`Plan.\n\nSources:\n- Guide — ${u}`, [u])).toBe('Plan.')
    // A line of the answer itself keeps its words (only the link goes).
    expect(removeLinks(`- Day 1: River Street and the Olde Pink House (${u})\n- Day 2: Forsyth Park`, [u])).toBe('- Day 1: River Street and the Olde Pink House\n- Day 2: Forsyth Park')
  })

  test('reviewedClean: only a passing review with nothing to fix', () => {
    expect(reviewedClean('Created pdf a.pdf.\n\nReview of a.pdf (1 page): PASS — 0 to fix, 2 warnings')).toBe(true)
    expect(reviewedClean('Created pdf a.pdf.\n\nReview of a.pdf (1 page): FAIL — 1 to fix, 0 warnings')).toBe(false)
    expect(reviewedClean('Created pdf a.pdf.\n\n(Automatic review skipped: no renderer. Run review_document.)')).toBe(false)
  })
})
