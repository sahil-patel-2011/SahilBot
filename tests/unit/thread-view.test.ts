// Long chats: the thread view groups hundreds of messages quickly, mounts only its latest window of
// blocks, and its rows know when they don't need to render again (so a streamed token re-renders one row).
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, it } from 'vitest'
import { DevMode } from '../../src/renderer/src/lib/dev-mode'
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
    // The quiet chat leaves out the steps: question + answer per turn.
    expect((html.match(/data-testid="user-bubble"/g) ?? []).length).toBe(tv.WINDOW / 2)
    expect((html.match(/data-testid="assistant-bubble"/g) ?? []).length).toBe(tv.WINDOW / 2)
    // Developer mode mounts the steps too: question + steps + answer per turn.
    const dev = renderToString(createElement(DevMode.Provider, { value: true }, createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions })))
    expect((dev.match(/data-testid="user-bubble"/g) ?? []).length).toBe(tv.WINDOW / 3)
    expect((dev.match(/data-testid="activity"/g) ?? []).length).toBe(tv.WINDOW / 3)
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

describe('voice conversations in the chat', () => {
  it('a finished one folds into its named line (open it for the transcript); the live one shows only with the transcript on', () => {
    const s0 = T0 + 50_000_000
    const before = msg({ role: 'user', content: 'Typed before the call', createdAt: s0 - 5000 })
    const said = msg({ role: 'user', content: 'Find me a flight to Lisbon', createdAt: s0 + 1000, meta: { voice: true } })
    const reply = msg({ content: 'On it.', createdAt: s0 + 2000 })
    const result = msg({ kind: 'notice', content: 'Two options found', createdAt: s0 + 3000, meta: { voiceResult: { bot: 'Scout', title: 'flights', files: [] } } })
    const line = msg({ kind: 'notice', content: 'Voice chat: Find me a flight to Lisbon', createdAt: s0 + 5000, meta: { voiceSession: { startedAt: s0, endedAt: s0 + 4000, title: 'Find me a flight to Lisbon', seconds: 51 } } })
    const after = msg({ role: 'user', content: 'Typed after', createdAt: s0 + 9000 })
    const typedMid = msg({ role: 'user', content: 'Typed during the call', createdAt: s0 + 3500 })
    const err = msg({ kind: 'error', content: 'The model failed', createdAt: s0 + 3600 })
    const all = [before, said, reply, result, line, after]
    expect(tv.foldVoice(all, new Set()).map((m) => m.id)).toEqual([before.id, result.id, line.id, after.id])
    // A typed message or an error in the same minutes is never folded away.
    expect(tv.foldVoice([said, reply, typedMid, err, line], new Set()).map((m) => m.id)).toEqual([typedMid.id, err.id, line.id])
    // The live call in another chat doesn't hide anything here.
    expect(tv.foldVoice([before, said, reply], new Set(), { since: s0, transcript: false, threadId: 'elsewhere' })).toHaveLength(3)
    expect(tv.foldVoice(all, new Set([line.id])).map((m) => m.id)).toEqual(all.map((m) => m.id))
    // A call in progress (no line yet): hidden until the transcript is on; notices always show.
    const live = [before, said, reply, result]
    expect(tv.foldVoice(live, new Set(), { since: s0, transcript: false }).map((m) => m.id)).toEqual([before.id, result.id])
    expect(tv.foldVoice(live, new Set(), { since: s0, transcript: true })).toHaveLength(4)
    expect(tv.clock(51)).toBe('0:51')
    expect(tv.clock(3725)).toBe('1:02:05')
  })

  it('renders the line with its name, length and thumbs, and a result card from the bot with its files', () => {
    const s0 = T0 + 60_000_000
    const ms = [
      msg({ role: 'user', content: 'Make the budget sheet', createdAt: s0 + 1000, meta: { voice: true } }),
      msg({ role: 'tool', toolName: 'file_write', toolCallId: 'x', content: 'ok', createdAt: s0 + 2000, meta: { status: 'ok', path: '/Users/sam/Documents/Budget.xlsx' } }),
      msg({ kind: 'notice', content: 'Voice chat', createdAt: s0 + 6000, meta: { voiceSession: { startedAt: s0, endedAt: s0 + 5000, title: 'Make the budget sheet', seconds: 51 } } }),
      msg({ kind: 'notice', content: 'The deck is ready.', createdAt: s0 + 7000, meta: { voiceResult: { bot: 'Finance', title: 'the Q3 deck', files: ['/Users/sam/Documents/Q3.pptx'] } } })
    ]
    const html = renderToString(createElement(tv.ThreadView, { messages: ms, running: false, pending: [], actions }))
    expect(html).toContain('Make the budget sheet')
    expect(html).toContain('0:51')
    expect(html).toContain('data-testid="voice-session"')
    expect(html).toContain('Budget.xlsx')
    expect(html.replace(/<!-- -->/g, '')).toContain('From Finance · the Q3 deck')
    expect(html).toContain('Q3.pptx')
    // The transcript itself is folded away.
    expect(html).not.toContain('data-testid="user-bubble"')
  })
})
