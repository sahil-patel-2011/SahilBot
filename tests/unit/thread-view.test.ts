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

  it('a live call\'s words fold with the call (even after a typed message); the brief Grok wrote is a small line, not yours', () => {
    const s0 = T0 + 70_000_000
    const typed = msg({ role: 'user', content: 'Typed during the call', createdAt: s0 + 1000 })
    const typedReply = msg({ content: 'Got it.', createdAt: s0 + 2000 })
    const spokenUser = msg({ role: 'user', content: 'and what about friday', createdAt: s0 + 3000, meta: { voice: true, spoken: true, aside: true } })
    const spokenReply = msg({ content: 'Friday is clear.', createdAt: s0 + 4000, meta: { voice: true, spoken: true, aside: true } })
    expect(tv.foldVoice([typed, typedReply, spokenReply], new Set(), { since: s0, transcript: false }).map((m) => m.id)).toEqual([typed.id, typedReply.id])
    expect(tv.foldVoice([typed, spokenUser, spokenReply], new Set(), { since: s0, transcript: true })).toHaveLength(3)
    const brief = msg({ role: 'user', content: 'Email Priya the meeting notes', createdAt: s0 + 5000, meta: { voice: true, voiceBrief: true } })
    const html = renderToString(createElement(tv.ThreadView, { messages: [spokenUser, brief, msg({ content: 'Sent.', createdAt: s0 + 6000 })], running: false, pending: [], actions }))
    expect(html).toContain('data-testid="voice-brief"')
    expect(html.replace(/<!-- -->/g, '')).toContain('Asked the bot: Email Priya the meeting notes')
    // Your own words are the one bubble from you.
    expect(html.match(/data-testid="user-bubble"/g)).toHaveLength(1)
    expect(html).toContain('and what about friday')
  })
})

// Grok Bot head-to-head (RLB-01, ALD-04): check first, post once. An answer the app checks before accepting it is
// not on screen while the run works, then shows once it is final; nothing that was posted is pulled back.
describe('answers are posted once', () => {
  const ask = (): Message => msg({ role: 'user', content: 'Plan the Savannah trip' })
  for (const botName of [undefined, 'Trip Planner']) {
    it(`a held answer shows only once it stands${botName ? ' (bot chat)' : ''}`, () => {
      const q = ask()
      const draft = msg({ content: 'Day 1: River Street walk.', meta: { provisional: true } })
      const render = (ms: Message[], running: boolean): string => renderToString(createElement(tv.ThreadView, { messages: ms, running, pending: [], actions, botName }))
      // Written, not yet accepted: out of sight, the working line up.
      let html = render([q, draft], true)
      expect(html).not.toContain('River Street')
      expect(html).toContain('data-testid="status-line"')
      // Streaming out of sight: still the working line.
      html = render([q, { ...draft, status: 'streaming' }], true)
      expect(html).not.toContain('River Street')
      expect(html).toContain('data-testid="status-line"')
      // Final: shown, even while the run finishes up.
      html = render([q, { ...draft, meta: {} }], true)
      expect(html).toContain('River Street')
    })
  }

  it('a bot chat keeps an answer it already showed on screen while it is checked, until the checked one is written', () => {
    const q = ask()
    const draft = msg({ content: 'Day 1: River Street walk.', meta: { superseded: true, checking: true } })
    const html = renderToString(createElement(tv.ThreadView, { messages: [q, draft, msg({ role: 'user', content: '[From the app] check', meta: { hidden: true } })], running: true, pending: [], actions, botName: 'Trip Planner' }))
    expect(html).toContain('River Street')
    expect(html).not.toContain('Double-checking')
  })
})

describe('post once', () => {
  // Report ALD-04 / RLB-01: an answer still subject to the app's checks (provisional) is never shown, streaming or
  // done; the working line stays up instead. Once it stands (provisional cleared) it shows, once.
  it('a provisional reply is not shown while the run works; its tool calls are; once settled it shows', () => {
    const ask = msg({ role: 'user', content: 'Plan a 3-day trip to Savannah' })
    const writing = msg({ content: 'Day 1: River Street…', status: 'streaming', meta: { provisional: true } })
    const call = { id: 'p1', name: 'web_search', arguments: '{"query":"savannah hotels"}' }
    const working = msg({ content: 'Checking a few hotels first.', toolCalls: [call], meta: { provisional: true } })
    expect(tv.blocks([ask, working]).filter((b) => b.kind === 'activity')).toHaveLength(1)
    const done = { ...writing, status: 'done' as const, meta: {} }
    expect(tv.blocks([ask, done]).filter((b) => b.kind === 'text')).toHaveLength(1)
    // While it is written out of sight, the chat shows the working line, not the half-written answer.
    const render = (ms: Message[], running: boolean): string => renderToString(createElement(tv.ThreadView, { messages: ms, running, pending: [], actions }))
    expect(render([ask, writing], true)).not.toContain('River Street')
    // A stopped or failed one shows at once (it is not coming back).
    expect(render([ask, { ...writing, status: 'stopped' }], true)).toContain('River Street')
    expect(render([ask, { ...writing, status: 'error' }], true)).toContain('River Street')
  })

  // RLB-01: after the run (or a crash mid-run) nothing it wrote stays hidden for good.
  it('a provisional reply left after the run ends is shown', () => {
    const ask = msg({ role: 'user', content: 'Plan a 3-day trip to Savannah' })
    const left = msg({ content: 'Day 1: River Street walk.', meta: { provisional: true } })
    expect(renderToString(createElement(tv.ThreadView, { messages: [ask, left], running: false, pending: [], actions }))).toContain('River Street')
    expect(renderToString(createElement(tv.ThreadView, { messages: [ask, left], running: true, pending: [], actions }))).not.toContain('River Street')
  })
})

describe('routine runs in the chat', () => {
  it('a routine\'s instructions show as a small "Routine" line, never as your own editable bubble', () => {
    const ms = [
      msg({ role: 'user', content: 'Hi' }),
      msg({ content: 'Hello!' }),
      msg({ role: 'user', content: '⏰ Atlanta weather\n\nSend me the Atlanta weather', meta: { scheduled: 'r1' } }),
      msg({ content: 'Sunny, 61°F.' })
    ]
    const bs = tv.blocks(ms)
    expect(bs.map((b) => b.kind)).toEqual(['user', 'text', 'notice', 'text'])
    expect((bs[2] as { m: Message }).m.content).toBe('⏰ Routine · Atlanta weather')
    expect(bs.filter((b) => b.kind === 'user').map((b) => (b as { m: Message }).m.content)).toEqual(['Hi'])
  })
})

describe('a reply that froze halfway', () => {
  it('still gets the stall note with Retry and Skip under the half-written text', () => {
    const ask = msg({ role: 'user', content: 'Write a haiku' })
    const writing = msg({ content: 'Autumn moonlight', status: 'streaming' })
    const live = renderToString(createElement(tv.ThreadView, { messages: [ask, writing], running: true, pending: [], actions }))
    expect(live).not.toContain('stall-retry')
    const work = { text: 'Still on it: waiting for M to answer is taking longer than usual (1 min). Retry it, skip it, or keep waiting.', tool: 'watchdog', step: 'Waiting for M to answer', stuck: true }
    const html = renderToString(createElement(tv.ThreadView, { messages: [ask, writing], running: true, pending: [], actions, work }))
    expect(html).toContain('Autumn moonlight')
    expect(html).toContain('data-testid="stall-retry"')
    expect(html).toContain('data-testid="stall-skip"')
    // A step that may have changed something: Skip only.
    const once = renderToString(createElement(tv.ThreadView, { messages: [ask, writing], running: true, pending: [], actions, work: { ...work, retryable: false } }))
    expect(once).not.toContain('stall-retry')
    expect(once).toContain('stall-skip')
  })
  it('a step waiting on a macOS dialog says what to do', () => {
    expect(tv.stallText({ who: 'SahilBot', stall: { text: 'Still on it: macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK.', tool: 'watchdog', step: 'Reading a file', stuck: true, waitingOnYou: true } }))
      .toBe('macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK')
    expect(tv.workLabel({ progress: 'macOS may be asking to let SahilBot open your Downloads folder. Look for its dialog and click OK', progressTool: 'run_command', progressWaiting: true, doing: 'Running a command' }))
      .toMatch(/^macOS may be asking/)
  })
})
