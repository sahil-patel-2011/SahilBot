// Long chats: the thread view groups hundreds of messages quickly, mounts only its latest window of
// blocks, and its rows know when they don't need to render again (so a streamed token re-renders one row).
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Message } from '@shared/types'

type TV = typeof import('../../src/renderer/src/components/ThreadView')
let tv: TV

beforeAll(async () => {
  // The renderer expects a browser: a DOM for the sanitizer, and the preload's api object.
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(window, { foreman: {} })
  g.document = document
  g.navigator ??= { clipboard: { writeText: async () => undefined } }
  tv = await import('../../src/renderer/src/components/ThreadView')
})

const T0 = Date.UTC(2026, 10, 1, 9)
let n = 0
const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't1', role: 'assistant', content: '', kind: 'normal', status: 'done', createdAt: T0 + n * 1000, ...p })

/** A long working session: question, a tool call and its result, an answer; repeated. */
function longThread(turns: number): Message[] {
  const out: Message[] = []
  for (let i = 0; i < turns; i++) {
    out.push(msg({ role: 'user', content: `Question ${i}: how do the plans compare?` }))
    const call = { id: `c${i}`, name: 'web_search', arguments: JSON.stringify({ query: `plans ${i}` }) }
    out.push(msg({ content: '', toolCalls: [call] }))
    out.push(msg({ role: 'tool', toolCallId: call.id, toolName: 'web_search', content: '<tool_output>results</tool_output>', meta: { status: 'ok' } }))
    out.push(msg({ content: `## Answer ${i}\n\nThe **Team** plan is the best value.\n\n| Plan | Price |\n| --- | ---: |\n| Team | $15 |\n\n\`\`\`ts\nconst seats = 5\n\`\`\`` }))
  }
  return out
}

const actions = { onRetry: () => undefined, onEditLast: () => undefined, onRespond: () => undefined, onReact: () => undefined, onReply: () => undefined, onOpenFile: () => undefined }

describe('thread view on long chats', () => {
  it('groups 2,000 messages into blocks quickly', () => {
    const ms = longThread(500)
    const t0 = performance.now()
    const bs = tv.blocks(ms)
    const took = performance.now() - t0
    // user + activity + text per turn; tool results fold into their activity.
    expect(bs).toHaveLength(1500)
    expect(bs.filter((b) => b.kind === 'activity')).toHaveLength(500)
    expect(took).toBeLessThan(250)
  })

  it('mounts only the latest window of blocks, with a way to show earlier ones', () => {
    const ms = longThread(200)
    const t0 = performance.now()
    const html = renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions }))
    const took = performance.now() - t0
    expect(html).toContain('data-testid="show-earlier"')
    expect((html.match(/data-testid="user-bubble"/g) ?? []).length).toBe(tv.WINDOW / 3)
    expect((html.match(/data-testid="assistant-bubble"/g) ?? []).length).toBe(tv.WINDOW / 3)
    // The newest answer is there; the oldest isn't mounted.
    expect(html).toContain('Answer 199')
    expect(html).not.toContain('Answer 0<')
    expect(took).toBeLessThan(2000)
  })

  it('a short chat shows everything and no "show earlier" button', () => {
    const html = renderToString(createElement(tv.ThreadView, { messages: longThread(5), running: false, pending: [], actions }))
    expect(html).not.toContain('show-earlier')
    expect((html.match(/data-testid="assistant-bubble"/g) ?? []).length).toBe(5)
  })

  it('rows are equal across rebuilds until their own message changes', () => {
    const ms = longThread(3)
    const a = tv.blocks(ms)
    // A streamed token: only the last message is a new object.
    const streamed = [...ms.slice(0, -1), { ...ms[ms.length - 1], content: ms[ms.length - 1].content + ' more' }]
    const b = tv.blocks(streamed)
    expect(a).toHaveLength(b.length)
    const same = a.map((x, i) => tv.sameBlock(x, b[i]))
    expect(same.slice(0, -1).every(Boolean)).toBe(true)
    expect(same[same.length - 1]).toBe(false)
  })

  it('an activity row changes when a step gets its result', () => {
    const call = { id: 'cx', name: 'web_search', arguments: '{}' }
    const asking = msg({ content: '', toolCalls: [call] })
    const result = msg({ role: 'tool', toolCallId: 'cx', toolName: 'web_search', content: 'ok' })
    const before = tv.blocks([asking])
    const after = tv.blocks([asking, result])
    expect(before[0].kind).toBe('activity')
    expect(tv.sameBlock(before[0], after[0])).toBe(false)
    // Rebuilt from the same messages: equal, so the row keeps its render.
    expect(tv.sameBlock(after[0], tv.blocks([asking, result])[0])).toBe(true)
  })
})
