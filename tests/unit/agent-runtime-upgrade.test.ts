import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { MemorySystem } from '../../src/main/memory-system'
import { RuntimeStore } from '../../src/main/agent/runtime/store'
import { ResearchStore } from '../../src/main/agent/runtime/research'
import { executeWorkflow, pointer, validateGraph } from '../../src/main/agent/runtime/workflow'
import { completionReport } from '../../src/main/agent/runtime/verification'
import { TaskMeter, recoveryPlan } from '../../src/main/agent/runtime/policy'
import { GraphStore } from '../../src/main/context-engine/store'
import { OutcomeRouter } from '../../src/main/llm/outcome-router'
import { requestStrategy } from '../../src/shared/request-strategy'
import type { ModelInfo } from '../../src/shared/types'

function setup() {
  const db = new Db(':memory:'), space = db.createSpace('Project', '#000', { kind: 'project' }), thread = db.createThread(space.id, 'auto', null)
  let at = 100000
  const memory = new MemoryStore(db), system = new MemorySystem(db, memory, () => at), runtime = new RuntimeStore(db, () => at)
  const run = runtime.start(thread.id, 'opener')
  return { db, space, thread, memory, system, runtime, run, tick: () => ++at, now: () => at }
}

describe('durable task execution', () => {
  test('a completed call replays, a crash leaves writes uncertain, reads may be retried', () => {
    const h = setup(), a = h.runtime.begin(h.run, 'one', 'send', { to: 'fixture' }, 'write_external')
    h.runtime.complete(a.record.id, { text: 'sent', data: { receipt: '123' } })
    expect(h.runtime.begin(h.run, 'one', 'send', { to: 'fixture' }, 'write_external').replay?.data).toEqual({ receipt: '123' })
    h.runtime.begin(h.run, 'two', 'send', { to: 'other' }, 'write_external')
    h.runtime.begin(h.run, 'three', 'lookup', {}, 'read')
    h.runtime.recover()
    const resumed = h.runtime.start(h.thread.id, 'opener')
    expect(resumed.id).toBe(h.run.id)
    expect(h.runtime.begin(resumed, 'new-call', 'send', { to: 'other' }, 'write_external').blocked).toContain('uncertain')
    expect(h.runtime.begin(resumed, 'three', 'lookup', {}, 'read').blocked).toBeUndefined()
  })
  test('repairs a missing tool result after a crash without repeating its action', () => {
    const h = setup()
    h.db.insertMessage({ threadId: h.thread.id, role: 'assistant', content: '', kind: 'normal', status: 'done', toolCalls: [{ id: 'call', name: 'send', arguments: '{}' }] })
    const a = h.runtime.begin(h.run, 'call', 'send', {}, 'write_external'); h.runtime.complete(a.record.id, { text: 'receipt 123' })
    h.runtime.recover(); h.runtime.recover()
    const restored = h.db.listMessages(h.thread.id).filter((m) => m.toolCallId === 'call')
    expect(restored).toHaveLength(1); expect(restored[0].content).toContain('receipt 123')
  })
  test('artifacts are scoped, and runtime data cascades when a chat is deleted', () => {
    const h = setup(), id = h.runtime.artifact(h.run.id, null, { rows: [1, 2] })
    expect(h.runtime.readArtifact(id, h.thread.id)).toEqual({ rows: [1, 2] })
    expect(() => h.runtime.readArtifact(id, 'other')).toThrow()
    h.db.sql.prepare('DELETE FROM threads WHERE id=?').run(h.thread.id)
    expect(h.db.sql.prepare('SELECT * FROM agent_artifacts').all()).toHaveLength(0)
  })
  test('a failed check cannot be replaced by a final success claim', () => {
    const h = setup(); h.runtime.evidence(h.run.id, null, 'tests', false, 'one failing test')
    expect(completionReport(h.runtime, h.run.id).status).toBe('blocked')
    h.tick(); h.runtime.evidence(h.run.id, null, 'tests', true, 'all tests passed')
    expect(completionReport(h.runtime, h.run.id).status).toBe('verified')
    h.tick(); const a = h.runtime.begin(h.run, 'edit', 'code', { action: 'edit' }, 'write_local'); h.runtime.complete(a.record.id, { text: 'edited' })
    expect(completionReport(h.runtime, h.run.id).status).toBe('blocked')
  })
  test('required verification is enforced and recovery has a bound', () => {
    const h = setup()
    expect(completionReport(h.runtime, h.run.id, { required: true }).status).toBe('blocked')
    expect(h.runtime.recoverAttempt(h.run.id, 'error')).toBe(true)
    expect(h.runtime.recoverAttempt(h.run.id, 'error')).toBe(true)
    expect(h.runtime.recoverAttempt(h.run.id, 'error')).toBe(false)
    expect(recoveryPlan('mail', 'OAuth expired', 'write_external').kind).toBe('connect')
    expect(recoveryPlan('mail', '503', 'write_external').retry).toBe(false)
  })
})

describe('structured workflows', () => {
  test('joins structured call outputs, passes only selected data to dependent tools', async () => {
    const calls: unknown[] = [], signal = new AbortController().signal
    const results = await executeWorkflow([
      { id: 'users', op: 'call', tool: 'users' },
      { id: 'active', op: 'filter', dependsOn: ['users'], input: { $ref: 'users/data' }, pointer: '/active', equals: true },
      { id: 'names', op: 'map', dependsOn: ['active'], input: { $ref: 'active' }, pointer: '/name' },
      { id: 'report', op: 'call', tool: 'report', dependsOn: ['names'], args: { names: { $ref: 'names' } } }
    ], { signal, invokeTool: async (name, args) => { calls.push([name, args]); return name === 'users' ? { text: 'users', data: [{ name: 'A', active: true }, { name: 'B', active: false }] } : { text: 'done', data: args } } })
    expect(calls[1]).toEqual(['report', { names: ['A'] }]); expect(results.every((r) => r.status === 'done')).toBe(true)
  })
  test('rejects cycles and prototype access; failed nodes block descendants', async () => {
    expect(() => validateGraph([{ id: 'a', op: 'call', dependsOn: ['b'] }, { id: 'b', op: 'call', dependsOn: ['a'] }])).toThrow('cycle')
    expect(() => pointer({}, '/__proto__/polluted')).toThrow('Unsafe')
    const results = await executeWorkflow([{ id: 'a', op: 'call', tool: 'broken' }, { id: 'b', op: 'call', dependsOn: ['a'], tool: 'send' }], { signal: new AbortController().signal, invokeTool: async () => { throw new Error('Denied by user') } })
    expect(results.map((r) => r.status)).toEqual(['failed', 'blocked'])
  })
  test('completed nodes survive resume and are not executed twice', async () => {
    let calls = 0
    const r = await executeWorkflow([{ id: 'a', op: 'call', tool: 'send' }], { signal: new AbortController().signal, invokeTool: async () => { calls++; return { text: 'sent' } } }, [{ id: 'a', status: 'done', output: { text: 'sent' } }])
    expect(calls).toBe(0); expect(r[0].status).toBe('done')
  })
})

describe('time-aware and conditional memory', () => {
  test('old graph facts never overwrite current values and history retains superseded values', () => {
    const h = setup(), graph = new GraphStore(h.db, h.now), p = graph.create('person', 'Pat', { trust: 'user', confidence: 1 })
    const fact = (value: string, at: number) => ({ key: 'role', value, at, trust: 'user' as const, confidence: 1, source: { kind: 'chat' as const } })
    graph.addAttribute(p.id, fact('designer', 100)); graph.addAttribute(p.id, fact('manager', 200))
    expect(graph.addAttribute(p.id, fact('intern', 50)).result).toBe('kept')
    expect(graph.attributes(p.id)[0].value).toBe('manager'); expect(graph.atTime(p.id, 150)[0].value).toBe('designer')
    expect(graph.history(p.id)).toHaveLength(2)
  })
  test('flat memory versions disappear when the original is forgotten', () => {
    const h = setup(), m = h.memory.save('Prefers short answers.').memory
    h.memory.update(m.id, 'Prefers detailed answers.')
    expect(h.memory.history(m.id)).toHaveLength(2)
    h.memory.remove(m.id); expect(h.memory.history(m.id)).toEqual([])
  })
  test('project updates invalidate dependent decisions and prevent cycles', () => {
    const h = setup()
    const put = (key: string, text: string, dependencies: string[] = []) => h.system.putProject(h.space.id, { key, text, kind: 'requirement', dependencies, quoted: false })
    put('budget', '100'); put('plan', 'Plan A', ['budget']); put('document', 'Memo A', ['plan']); put('budget', '200')
    expect(h.system.project(h.space.id).filter((p) => p.stale).map((p) => p.key)).toEqual(['plan', 'document'])
    expect(h.system.projectHistory(h.space.id, 'budget')).toHaveLength(2)
    expect(() => put('budget', '300', ['document'])).toThrow('cycle')
  })
  test('project and explicit preferences win, unrelated audiences never match', () => {
    const h = setup()
    h.system.savePreference({ key: 'format', value: 'Word', scope: 'global', scopeId: null, confidence: 1, conditions: {}, evidence: 'I prefer Word' })
    h.system.savePreference({ key: 'format', value: 'PDF', scope: 'project', scopeId: h.space.id, confidence: 1, conditions: { audience: 'board' }, evidence: 'PDF for the board' })
    expect(h.system.resolvePreferences(h.space.id, { audience: 'board' })[0].value).toBe('PDF')
    expect(h.system.resolvePreferences(h.space.id, { audience: 'engineers' })[0].value).toBe('Word')
    expect(h.system.resolvePreferences(h.space.id, { audience: 'board' }, { format: 'Markdown' })[0].value).toBe('Markdown')
    expect(h.system.resolvePreferences('another-bot', { audience: 'board' })[0].value).toBe('Word')
  })
  test('recall returns exact source passages and does not search other bots', async () => {
    const h = setup(), other = h.db.createThread(h.db.createSpace('Private', '#000').id, 'auto', null)
    for (const [threadId, content] of [[h.thread.id, 'We chose the cobalt architecture for the robot.'], [other.id, 'The cobalt private password policy.']]) h.db.insertMessage({ threadId, role: 'user', content, kind: 'normal', status: 'done' })
    const hits = await h.system.recall('cobalt architecture', h.space.id)
    expect(hits[0].text).toContain('robot'); expect(hits.some((x) => x.source.threadId === other.id)).toBe(false)
    h.memory.setEnabled(false); expect(await h.system.recall('cobalt', h.space.id)).toEqual([])
  })
  test('unverified experience cannot become a recommended procedure', () => {
    const h = setup(), e = { threadId: h.thread.id, spaceId: h.space.id, task: 'Export robot logs', procedure: 'read logs then export', model: 'fixture', environment: 'v1' }
    h.system.experience({ ...e, verified: false }); expect(h.system.experiences(h.space.id, 'robot logs')).toEqual([])
    h.system.experience({ ...e, verified: true }); expect(h.system.experiences(h.space.id, 'robot logs')[0].successes).toBe(1)
    expect(h.system.experiences(h.space.id, 'robot logs', 'v2')).toEqual([])
  })
})

describe('research and resource-aware Auto', () => {
  test('claims require actual quoted observations and retain contradictory sources', () => {
    const h = setup(), research = new ResearchStore(h.db, h.now), id = research.add(h.run.id, 'The release is available', true)
    const a = h.runtime.begin(h.run, 'read', 'fetch_page', {}, 'read')
    h.runtime.complete(a.record.id, { text: 'The release is available starting today.', sources: [{ title: 'Release', url: 'https://example.com/release' }] })
    expect(() => research.attach(h.run.id, id, { actionId: a.record.id, quote: 'invented evidence that was not fetched', url: 'https://example.com/release', stance: 'supports' })).toThrow('actual retrieved')
    research.attach(h.run.id, id, { actionId: a.record.id, quote: 'The release is available', url: 'https://example.com/release', stance: 'supports' })
    expect(research.list(h.run.id)[0].status).toBe('supported')
    research.attach(h.run.id, id, { actionId: a.record.id, quote: 'The release is available', url: 'https://example.com/release', stance: 'contradicts' })
    expect(research.list(h.run.id)[0].status).toBe('disputed')
  })
  test('concurrent reservations cannot exceed the budget and verification has reserved room', () => {
    const meter = new TaskMeter({ maxUsd: 1, maxCalls: 1, parallel: 2 })
    const release = meter.reserve(0.6); expect(() => meter.reserve(0.3)).toThrow('budget')
    release(); meter.spentUsd = 0.85; expect(() => meter.check(0.1)).toThrow('budget')
    meter.phase = 'verify'; expect(() => meter.check(0.1)).not.toThrow()
    meter.beforeCall(); expect(() => meter.beforeCall()).toThrow('tool-call')
    expect(meter.parallel(8)).toBe(2)
  })
  test('routing requires sufficient verified outcomes for the exact model version', () => {
    const h = setup(), r = new OutcomeRouter(h.db, h.now)
    const model = (id: string) => ({ id, tier: 2 }) as ModelInfo
    const a = model('v1'), b = model('v2')
    for (let i = 0; i < 12; i++) { r.record({ model: a.id, category: 'coding', success: i < 8, verified: true, latencyMs: 5000, usd: 0.1 }); r.record({ model: b.id, category: 'coding', success: true, verified: true, latencyMs: 1000, usd: 0.02 }) }
    expect(r.pick(a, [a, b], 'coding', 'balanced')?.model.id).toBe('v2')
    expect(r.pick(model('v3'), [a, b], 'coding', 'balanced')).toBeUndefined()
    r.reset('v2'); expect(r.pick(a, [a, b], 'coding', 'balanced')).toBeUndefined()
  })
  test.each([
    ['Use a swarm of agents to compare these products', 'swarm'], ['plan first before implementing this', 'plan'],
    ['Run deep research on battery materials', 'research'], ['What is council mode?', 'agent'],
    ['Do not use a swarm for this task', 'agent'], ['Explain this code: ```use swarm agents```', 'agent'],
    ['Summarize the article about swarm agents', 'agent'], ["Explain the phrase 'plan first' to a new user", 'agent'], ['Hello', 'agent']
  ])('strategy follows the request: %s', (text, kind) => expect(requestStrategy(text).kind).toBe(kind))
})
