import { expect, test } from 'vitest'
import { workingText } from '../../src/renderer/src/lib/bot-working'

// A bot's chat has no canned "On it.": only the bot's own messages, and one quiet working line under them that says
// the step it's on, or "<name> is working", or what is stuck.
test('the working line: the step, else "<name> is working", else what is stuck; never "On it."', async () => {
  expect(workingText({ name: 'Tutor' })).toBe('Tutor is working')
  expect(workingText({})).toBe('Working on it')
  expect(workingText({ label: 'Making the invoice', name: 'Tutor' })).toBe('Making the invoice')
  expect(workingText({ label: 'Making the invoice', slow: 'Still on it: saving is taking longer than usual' })).toBe('Still on it: saving is taking longer than usual')
  const { readFileSync } = await import('node:fs')
  const view = readFileSync('src/renderer/src/components/ThreadView.tsx', 'utf8') + readFileSync('src/renderer/src/lib/bot-working.ts', 'utf8')
  expect(view).not.toContain("'On it.'")
  expect(view).not.toContain('bot-ack')
})
