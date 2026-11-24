import { expect, test } from 'vitest'
import { awaitingFinal, heldDrafts } from '../../src/renderer/src/lib/held-drafts'
import type { Message } from '../../src/shared/types'

// Grok Bot head-to-head: the trip plan "vanished for about a minute while links were rechecked", and answers were
// posted twice. An answer being double-checked stays on screen until the checked one is fully written.
const msg = (id: string, role: Message['role'], content: string, meta: Record<string, unknown> = {}, status: Message['status'] = 'done'): Message =>
  ({ id, threadId: 't', role, content, kind: 'normal', status, createdAt: Number(id.replace(/\D/g, '')) || 0, meta } as Message)

test('the answer being checked is held until its replacement is written; then only the replacement shows', () => {
  const ask = msg('1', 'user', 'Plan my trip')
  const draft = msg('2', 'assistant', 'Draft plan', { superseded: true, checking: true })
  const note = msg('3', 'user', '[From the app] double-check', { hidden: true })
  // Checking: no replacement yet → the draft stays.
  expect(heldDrafts([ask, draft, note]).held.has('2')).toBe(true)
  // The replacement is streaming → the draft stays, the replacement waits out of view.
  const streaming = msg('4', 'assistant', 'Checked pl', {}, 'streaming')
  let r = heldDrafts([ask, draft, note, streaming])
  expect(r.held.has('2')).toBe(true)
  expect(r.waiting.has('4')).toBe(true)
  // Written → the draft goes, the replacement shows.
  r = heldDrafts([ask, draft, note, msg('4', 'assistant', 'Checked plan')])
  expect(r.held.size).toBe(0)
  expect(r.waiting.size).toBe(0)
})

test('only double-checks are held (a "want me to?" reply sent back is not), and only the latest one', () => {
  const bounce = msg('2', 'assistant', 'Want me to go ahead?', { superseded: true })
  expect(heldDrafts([msg('1', 'user', 'Do it'), bounce]).held.size).toBe(0)
  const d1 = msg('2', 'assistant', 'First draft', { superseded: true, checking: true })
  const d2 = msg('3', 'assistant', 'Second draft', { superseded: true, checking: true })
  const r = heldDrafts([msg('1', 'user', 'Plan it'), d1, d2])
  expect([...r.held]).toEqual(['3'])
})

test('a step\'s opening words that come with a tool call are not the replacement: the checked answer stays', () => {
  const ask = msg('1', 'user', 'Plan my trip')
  const draft = msg('2', 'assistant', 'Draft plan', { superseded: true, checking: true })
  const note = msg('3', 'user', '[From the app] double-check', { hidden: true })
  const preamble = { ...msg('4', 'assistant', 'Let me re-check the hotel link.'), toolCalls: [{ id: 'c1', name: 'fetch_page', arguments: '{}' }] } as Message
  const r = heldDrafts([ask, draft, note, preamble, msg('5', 'tool', 'page')])
  expect(r.held.has('2')).toBe(true)
  expect(r.waiting.size).toBe(0)
})

test('the check\'s bare "✓" never shows before the kept answer is swapped in', () => {
  const ask = msg('1', 'user', 'Plan my trip')
  const draft = msg('2', 'assistant', 'Draft plan', { superseded: true, checking: true })
  let r = heldDrafts([ask, draft, msg('3', 'assistant', '✓')])
  expect(r.held.has('2')).toBe(true)
  expect(r.waiting.has('3')).toBe(true)
  r = heldDrafts([ask, draft, msg('3', 'assistant', 'Draft plan', { keptDraft: true })])
  expect(r.held.size).toBe(0)
})

test('an answer the app checks before accepting it waits out of view until it is final; errors and tool steps show', () => {
  expect(awaitingFinal(msg('2', 'assistant', 'Saved it', { provisional: true }))).toBe(true)
  expect(awaitingFinal(msg('2', 'assistant', 'Saved it', { provisional: true }, 'streaming'))).toBe(true)
  expect(awaitingFinal(msg('2', 'assistant', 'Saved it'))).toBe(false)
  expect(awaitingFinal(msg('2', 'assistant', 'It failed', { provisional: true }, 'error'))).toBe(false)
  expect(awaitingFinal(msg('2', 'assistant', 'Half', { provisional: true }, 'stopped'))).toBe(false)
  expect(awaitingFinal({ ...msg('2', 'assistant', 'Checking the file.', { provisional: true }), toolCalls: [{ id: 'c', name: 'file_read', arguments: '{}' }] } as Message)).toBe(false)
})
// Report ALD-04 / RLB-01: verify happened after the answer streamed, so it appeared, vanished and came back. A reply
// written out of sight (provisional) was never on screen: nothing to hold, and its checked replacement is the one shown.
test('a provisional draft being checked is never held on screen', () => {
  const draft = msg('2', 'assistant', 'Draft plan', { superseded: true, checking: true, provisional: true })
  expect(heldDrafts([msg('1', 'user', 'Plan my trip'), draft]).held.size).toBe(0)
  const r = heldDrafts([msg('1', 'user', 'Plan my trip'), draft, msg('3', 'assistant', 'Checked pl', { provisional: true }, 'streaming')])
  expect(r.held.size).toBe(0)
})
