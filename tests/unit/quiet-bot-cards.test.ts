import { expect, test, vi } from 'vitest'
vi.mock('../../src/renderer/src/api', () => ({ api: {}, isServerRuntime: false }))
import { hasMadeArtifacts } from '../../src/renderer/src/lib/quiet'
import type { Step } from '../../src/renderer/src/lib/steps'

// FFC-03 (file card): a bot's one ongoing conversation hides a run's steps, but not the card of the file it made
// (ThreadView keeps an activity block in a bot chat when this is true, and shows only its cards).
const step = (name: string, meta: Record<string, unknown>): Step => ({
  call: { id: `c-${name}`, name, arguments: '{}' },
  result: { id: `r-${name}`, threadId: 't', role: 'tool', content: '', kind: 'normal', status: 'done', createdAt: 0, meta } as never,
  at: 0
})

test('a run that made a file has a card to show in a bot chat; one that only looked has none', () => {
  expect(hasMadeArtifacts([step('create_document', { status: 'ok', path: '/Users/me/Downloads/Invoice.pdf' })], true)).toBe(true)
  expect(hasMadeArtifacts([step('file_write', { status: 'ok', path: '/Users/me/rename_photos (2).py' })], true)).toBe(true)
  expect(hasMadeArtifacts([step('file_read', { status: 'ok', path: '/Users/me/notes.md' }), step('web_search', { status: 'ok' })], true)).toBe(false)
  expect(hasMadeArtifacts([step('create_document', { status: 'error', path: '/Users/me/Invoice.pdf' })], true)).toBe(false)
})
