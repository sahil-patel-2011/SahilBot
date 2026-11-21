import { expect, test } from 'vitest'
import { LoopGuard, canonicalArgs } from '../../src/main/agent/recover'
import { taskBrief } from '../../src/main/agent/context'
import type { Message } from '../../src/shared/types'

const call = (name: string, args: Record<string, unknown>) => ({ id: Math.random().toString(36), name, arguments: JSON.stringify(args) })

test('a polling loop is nudged, then stopped, even when its results change (Grok Build strategy)', () => {
  const g = new LoopGuard()
  const isRead = (n: string): boolean => n === 'job_status'
  const results: Array<ReturnType<LoopGuard['step']>> = []
  for (let i = 0; i < 8; i++) results.push(g.step([call('job_status', { id: 'j1', verbose: true })], isRead))
  expect(results.slice(0, 3)).toEqual([{}, {}, {}])
  expect(results[3].nudge).toMatch(/polling loop/)
  expect(results[7].stop).toMatch(/ran 8 times/)
  // Key order and call order don't make it a different step.
  const h = new LoopGuard()
  h.step([call('a', { x: 1, y: 2 }), call('b', {})], () => true)
  expect(canonicalArgs('{"y":2,"x":1}')).toBe(canonicalArgs('{"x":1,"y":2}'))
  for (let i = 0; i < 2; i++) h.step([call('b', {}), call('a', { y: 2, x: 1 })], () => true)
  expect(h.step([call('a', { x: 1, y: 2 }), call('b', {})], () => true).nudge).toMatch(/4 times/)
  // A different step resets the count; writes get more room before a nudge.
  const w = new LoopGuard()
  for (let i = 0; i < 7; i++) expect(w.step([call('file_write', { path: 'a' })], () => false)).toEqual({})
  expect(w.step([call('file_write', { path: 'a' })], () => false).nudge).toBeDefined()
  expect(w.step([call('file_write', { path: 'b' })], () => false)).toEqual({})
})

test('the compaction brief lists the files the task changed, from the tool record', () => {
  const m = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: Math.random().toString(36), threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 0, ...extra } as Message)
  const ms = [
    m('user', 'Fix the parser and update the docs.'),
    m('tool', 'ok', { toolName: 'file_read', meta: { status: 'ok', path: '/repo/src/lexer.ts' } }),
    m('tool', 'ok', { toolName: 'file_write', meta: { status: 'ok', path: '/repo/src/parser.ts' } }),
    m('tool', 'ok', { toolName: 'code', meta: { status: 'ok', path: '/repo/docs/parser.md' } }),
    m('tool', 'failed', { toolName: 'file_write', meta: { status: 'error', path: '/repo/x.ts' } })
  ]
  const brief = taskBrief(ms, { todos: [], notes: undefined, taskNotes: undefined } as never, { window: 64_000 })!
  expect(brief).toContain('- /repo/src/parser.ts')
  expect(brief).toContain('- /repo/docs/parser.md')
  expect(brief).not.toContain('lexer.ts')
  expect(brief).not.toContain('/repo/x.ts')
})

test('benchmark-based rows: business writing and electrical engineering get their own evidence, creative writing keeps its row', async () => {
  const { classifyTask, writingVoice } = await import('../../src/main/llm/task-classifier')
  const { routeFor, PROFESSIONAL_WRITING, ELECTRICAL_ENGINEERING, ROUTING_TABLE, slotsFor } = await import('../../src/main/llm/routing-table')
  expect(writingVoice('draft an email to the client about the delay')).toBe('professional')
  expect(writingVoice('write a poem for my boss')).toBe('creative')
  const email = classifyTask('Write a follow-up email to the client about the delayed shipment')
  expect(email).toMatchObject({ category: 'writing', voice: 'professional' })
  expect(routeFor(email.category, email)).toBe(PROFESSIONAL_WRITING)
  expect(slotsFor(email.category, 2, 'balanced', false, email)[0]).toBe('sonnet')
  const circuit = classifyTask('Pick a pull-up resistor value for this I2C bus and check the voltage divider on the sensor')
  expect(circuit.domain).toBe('electrical')
  expect(routeFor(circuit.category, circuit)).toBe(ELECTRICAL_ENGINEERING)
  expect(slotsFor(circuit.category, 3, 'best', false, circuit).slice(0, 2)).toEqual(['opus', 'astra'])
  const poem = classifyTask('Write a short poem about autumn in Vermont')
  expect(routeFor(poem.category, poem)).toBe(ROUTING_TABLE.writing)
})

test('a pasted API key with a well-known prefix knows its site, so it saves to the vault without asking', async () => {
  const { keySite, savesWithoutAsking } = await import('../../src/main/secure/offers')
  expect(keySite('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('https://console.anthropic.com')
  expect(keySite('sk-proj-abcdefghijklmnopqrstuvwxyz012345')).toBe('https://platform.openai.com')
  expect(keySite('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('https://github.com')
  expect(keySite('xai-abcdefghijklmnopqrstuvwxyz')).toBe('https://console.x.ai')
  expect(keySite('totally-unknown-token')).toBe('')
  const base = { id: 'o', source: 'chat' as const, kind: 'api_key' as const, title: '', site: '', origin: '', name: 'k', label: 'API key', status: 'pending' as const }
  expect(savesWithoutAsking({ ...base })).toBe(true)
  expect(savesWithoutAsking({ ...base, needs: ['site'] })).toBe(false)
  expect(savesWithoutAsking({ ...base, kind: 'card', needs: ['holder'] })).toBe(true)
})
