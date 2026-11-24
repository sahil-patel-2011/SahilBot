import { expect, test, vi } from 'vitest'
import { chatHistoryTool } from '../../src/main/agent/tools/chat-history'
import { requestedEffort, requestedModel } from '../../src/main/agent/choices'
import { Db } from '../../src/main/db'
import type { ToolContext } from '../../src/main/agent/types'
import type { Step } from '../../src/renderer/src/lib/steps'
vi.mock('../../src/renderer/src/api', () => ({ api: {}, isServerRuntime: false }))
import { elapsed, quietActions, turnStart } from '../../src/renderer/src/lib/quiet'
import type { Message } from '../../src/shared/types'

test('a group respects a user model and effort override, and explicit Auto beats a manual app default', () => {
  const space = { kind: 'group' as const, isMain: false }, speaker = { kind: 'bot' as const, isMain: false }, settings = { defaultModel: 'auto', thinking: 'max' as const }
  expect(requestedModel({ thread: { model: 'chosen-model' }, space, speaker, settings })).toBe('chosen-model')
  expect(requestedEffort({ thread: { effort: 'low' }, space, speaker, settings })).toBe('low')
  expect(requestedEffort({ thread: { effort: 'auto' }, space: null, settings })).toBe('auto')
  expect(requestedEffort({ thread: { effort: null }, space: null, settings })).toBe('max')
})

test('the exact archive can recover compacted details, is paginated and cannot read another chat', async () => {
  const db = new Db(':memory:'), space = db.createSpace('Test', '#000'), t = db.createThread(space.id, 'auto', null), other = db.createThread(space.id, 'auto', null)
  const m = db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: 'ORIGINAL-DECISION ' + 'x'.repeat(9000) })
  const hidden = db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: 'hidden instruction', meta: { hidden: true } })
  const foreign = db.insertMessage({ threadId: other.id, role: 'user', kind: 'normal', status: 'done', content: 'foreign private details' })
  const state = db.getState(t.id); state.compaction = { boundaryId: m.id, summary: 'lossy summary', at: Date.now(), before: 9000, after: 10 } as never; db.setState(t.id, state)
  const tool = chatHistoryTool(db), ctx = { threadId: t.id } as ToolContext
  const result = await tool.run({ action: 'search', query: 'ORIGINAL-DECISION' }, ctx)
  expect(result.data).toMatchObject([{ id: m.id }])
  expect((await tool.run({ action: 'read', id: m.id }, ctx)).data).toMatchObject({ nextOffset: 8000 })
  expect((await tool.run({ action: 'read', id: m.id, offset: 8000 }, ctx)).data).toMatchObject({ nextOffset: null })
  await expect(tool.run({ action: 'read', id: foreign.id }, ctx)).rejects.toThrow('not available')
  await expect(tool.run({ action: 'read', id: hidden.id }, ctx)).rejects.toThrow('not available')
})

const step = (name: string, action: string, display: string): Step => ({ at: 0, call: { id: name + action, name, arguments: JSON.stringify({ action }) }, result: { id: 'result', threadId: 'fixture', role: 'tool', content: 'result', createdAt: 0, kind: 'normal', status: 'done', meta: { status: 'ok', display } } })

test('quiet action receipts describe real changes and never label reads or declined goals as success', () => {
  expect(quietActions([step('schedule', 'list', '2 scheduled'), step('goal', 'get', 'Project'), step('goal', 'create', 'not started'), step('price_alert', 'list', '2 alerts')])).toEqual([])
  // A routine's change has its own line from the scheduler ("Created routine · …"): one, not two.
  expect(quietActions([step('schedule', 'delete', 'deleted fixture'), step('schedule', 'create', 'morning brief')])).toEqual([])
  const failed = step('schedule', 'create', 'x'); failed.result!.meta = { status: 'error' }
  expect(quietActions([failed])[0]).toMatchObject({ failed: true, text: expect.stringMatching(/^Didn't work/) })
  expect(quietActions([step('price_alert', 'cancel', 'cancelled fixture')])[0].text).toContain('Cancelled a price alert')
})

test('the turn timer counts from the sent prompt, ignores steers, and formats long tasks', () => {
  const ms = [{ role: 'user', createdAt: 1000, meta: {} }, { role: 'user', createdAt: 3000, meta: { steer: true } }] as Message[]
  expect(turnStart(ms, 1500)).toBe(1000)
  expect(elapsed(65_000)).toBe('1:05'); expect(elapsed(3_725_000)).toBe('1:02:05')
})
