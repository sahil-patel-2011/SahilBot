import { expect, test } from 'vitest'
import { repliedSince } from '../../src/renderer/src/lib/bot-working'

// A bot's chat shows "On it." while it starts on your message, until it says something itself.
test('"On it." shows until the bot replies after your latest message', () => {
  const m = (role: 'user' | 'assistant', content: string, meta: Record<string, unknown> = {}) => ({ id: Math.random().toString(), threadId: 't', role, content, kind: 'normal', status: 'done', createdAt: 0, meta }) as never
  expect(repliedSince([m('user', 'Make a homework plan')])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', '')])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Here it is', { superseded: true })])).toBe(false)
  // A reply still written out of sight (provisional) hasn't been said yet.
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Here it is', { provisional: true })])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Working on the first part now.')])).toBe(true)
  expect(repliedSince([m('user', 'a'), m('assistant', 'b'), m('user', 'c')])).toBe(false)
  expect(repliedSince([m('user', 'a'), m('user', '[reminder]', { hidden: true })])).toBe(false)
  // An answer written out of sight until it's checked isn't said yet; once final it is.
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Here it is', { provisional: true })])).toBe(false)
  expect(repliedSince([m('user', 'Make a homework plan'), m('assistant', 'Here it is', {})])).toBe(true)
})

// RLB-01: "On it." is the working line's words (gone with the line when the run ends), never a bot bubble that vanishes.
test('"On it." is said in the working line, then the step it is on replaces it', async () => {
  const { workingText } = await import('../../src/renderer/src/lib/bot-working')
  expect(workingText({ ack: true, late: false, name: 'Tutor' })).toBe('Tutor is working')
  expect(workingText({ ack: true, late: true, name: 'Tutor' })).toBe('On it.')
  expect(workingText({ ack: false, late: true, name: 'Tutor' })).toBe('Tutor is working')
  expect(workingText({ ack: true, late: true, label: 'Making the invoice' })).toBe('Making the invoice')
  expect(workingText({ ack: true, late: true, label: 'Making the invoice', slow: 'Still on it: saving is taking longer than usual' })).toBe('Still on it: saving is taking longer than usual')
  const { readFileSync } = await import('node:fs')
  expect(readFileSync('src/renderer/src/components/ThreadView.tsx', 'utf8')).not.toContain('bot-ack')
})
