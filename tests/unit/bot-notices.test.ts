// Bots made and deleted by asking leave a line in the chat: "📚 Study Buddy · Homework help · Open", and
// "Deleted Study Buddy · Undo" (then "· Undone" once it is back).
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { beforeAll, expect, test } from 'vitest'
import type { Message } from '@shared/types'

type TV = typeof import('../../src/renderer/src/components/ThreadView')
let tv: TV

beforeAll(async () => {
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(window, { foreman: {} })
  g.document = document
  g.navigator ??= { clipboard: { writeText: async () => undefined } }
  tv = await import('../../src/renderer/src/components/ThreadView')
})

let n = 0
const msg = (p: Partial<Message>): Message => ({ id: `b${++n}`, threadId: 't1', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: Date.UTC(2026, 10, 1, 9) + n * 1000, ...p })
const actions = { onRetry: () => undefined, onEditLast: () => undefined, onRespond: () => undefined, onReact: () => undefined, onReply: () => undefined, onOpenFile: () => undefined }
const render = (ms: Message[]): string => renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions }))

test('a bot made by asking shows a card with its icon, name, job and Open', () => {
  const html = render([
    msg({ role: 'user', content: 'Make me a bot called Study Buddy' }),
    msg({ kind: 'notice', content: 'Made Study Buddy 📚', meta: { botCard: { spaceId: 's1', threadId: 't2', name: 'Study Buddy', icon: '📚', job: 'Homework help' } } }),
    msg({ content: 'Made Study Buddy. It is in the sidebar.' })
  ])
  expect(html).toContain('data-testid="bot-card"')
  expect(html).toContain('📚')
  expect(html).toContain('Homework help')
  expect(html).toContain('data-testid="bot-card-open"')
})

test('a bot deleted by asking shows "Deleted X · Undo", and "Undone" once it is back', () => {
  const del = msg({ kind: 'notice', content: 'Deleted Study Buddy', meta: { botUndo: { spaceId: 's1', name: 'Study Buddy' } } })
  const html = render([msg({ role: 'user', content: 'Delete Study Buddy' }), del, msg({ content: 'Deleted Study Buddy. Say undo to bring it back.' })])
  expect(html).toContain('Deleted Study Buddy')
  expect(html).toContain('data-testid="bot-undo"')
  const back = render([msg({ role: 'user', content: 'Delete Study Buddy' }), { ...del, meta: { ...del.meta, undone: true } }])
  expect(back).not.toContain('data-testid="bot-undo"')
  expect(back).toContain('Undone')
})
