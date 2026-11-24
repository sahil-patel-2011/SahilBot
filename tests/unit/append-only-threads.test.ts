import { describe, expect, test } from 'vitest'
import { COMPACT_AT, ContextManager, OUTPUT_RESERVE, estimate, type TokenCounter } from '../../src/main/agent/context'
import { emptyState } from '../../src/main/agent/types'
import { SubscriptionThread } from '../../src/main/llm/subscription-thread'
import type { Message } from '../../src/shared/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The ChatGPT plan (Codex) keeps one thread per chat only while SahilBot's record is exactly what that thread holds
// plus new messages. Rewriting earlier turns (shrinking old tool outputs to save room) broke that match, so every
// step started a new Codex thread and sent the whole chat again. Append-only keeps the prefix byte-identical.
const counter: TokenCounter = { count: async (t) => estimate(t) }
let n = 0
const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message =>
  ({ id: `m${++n}`, threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: n, ...extra }) as Message
const step = (i: number): Message[] => [
  msg('assistant', '', { toolCalls: [{ id: `c${i}`, name: 'file_read', arguments: JSON.stringify({ path: `f${i}.txt` }) }] }),
  msg('tool', `contents of file ${i}: ` + 'data '.repeat(150), { toolCallId: `c${i}`, toolName: 'file_read' })
]

describe('append-only history for providers that keep the thread', () => {
  const window = 32768
  const input = window - OUTPUT_RESERVE
  // One long run, past the point where old tool outputs used to be shrunk (COMPACT_AT of the window), still fitting.
  const history = async (cm: ContextManager): Promise<Message[]> => {
    n = 0
    const ms = [msg('user', 'Read all the files and summarize them.')]
    // Measured the way the context manager measures: past the old trimming point (COMPACT_AT), with room for one more step.
    for (let i = 0; (await cm.measure('You are SahilBot.', '[]', ms, emptyState(), input)) < COMPACT_AT * input; i++) ms.push(...step(i))
    expect(await cm.measure('You are SahilBot.', '[]', [...ms, ...step(999)], emptyState(), input)).toBeLessThan(input)
    return ms
  }

  test('each step\'s request extends the last one exactly, so the provider thread is resumed with only the new messages', async () => {
    const cm = new ContextManager(counter, async () => 'summary')
    const ms = await history(cm)
    const a = await cm.prepare({ system: 'You are SahilBot.', toolsJson: '[]', messages: ms, state: emptyState(), window, appendOnly: true, allowCompact: false })
    const more = [...ms, ...step(999)]
    const b = await cm.prepare({ system: 'You are SahilBot.', toolsJson: '[]', messages: more, state: emptyState(), window, appendOnly: true, allowCompact: false })
    expect(a.compacted).toBeUndefined()
    expect(JSON.stringify(b.wire.slice(0, a.wire.length))).toBe(JSON.stringify(a.wire))
    expect(a.wire.some((m) => String(m.content).includes('older output trimmed'))).toBe(false)
    // The provider thread's record: the second request continues the first.
    const t = new SubscriptionThread(mkdtempSync(join(tmpdir(), 'sb-thread-')), 'chat')
    t.bind('thread-1')
    t.advance(a.wire)
    expect(t.continues(b.wire)).toBe(true)
    expect(t.delta(b.wire)?.length).toBe(b.wire.length - a.wire.length)
  })

  test('without append-only the same history gets rewritten (the old behavior that restarted the thread)', async () => {
    const cm = new ContextManager(counter, async () => 'summary')
    const ms = await history(cm)
    const a = await cm.prepare({ system: 'You are SahilBot.', toolsJson: '[]', messages: ms, state: emptyState(), window, appendOnly: false, allowCompact: false })
    expect(a.wire.some((m) => String(m.content).includes('older output trimmed'))).toBe(true)
  })
})
