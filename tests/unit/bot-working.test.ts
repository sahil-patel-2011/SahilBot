import { expect, test } from 'vitest'
import { repliedSince } from '../../src/renderer/src/lib/bot-working'

// A bot's chat shows "On it." while it starts on your message, until it says something itself.
test('"On it." shows until the bot replies after your latest message', () => {
  const m = (role: 'user' | 'assistant', content: string, meta: Record<string, unknown> = {}) => ({ id: Math.random().toString(), threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 0, meta }) as never
  expect(repliedSince([m('user', 'Make a homework plan')])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', '')])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Here it is', { superseded: true })])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Working on the first part now.')])).toBe(true)
  expect(repliedSince([m('user', 'a'), m('assistant', 'b'), m('user', 'c')])).toBe(false)
  expect(repliedSince([m('user', 'a'), m('user', '[reminder]', { hidden: true })])).toBe(false)
})
