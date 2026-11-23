import { expect, test } from 'vitest'
import { runningStep, type Step } from '../../src/renderer/src/lib/steps'

// Grok Bot's working line read "Calculating the square" through a 3-minute research job and "Chipping away"
// after everything finished. SahilBot's names only the step that is running now.
const step = (name: string, done: boolean): Step => ({ call: { id: name, name, arguments: '{}' }, at: 0, ...(done ? { result: { id: `r-${name}`, meta: { status: 'ok' } } as never } : {}) })

test('the working line names the running step, then nothing (Thinking) once it has its result, and nothing after the run', () => {
  expect(runningStep([step('calculator', true), step('web_search', false)], true)?.call.name).toBe('web_search')
  expect(runningStep([step('calculator', true), step('web_search', true)], true)).toBeUndefined()
  expect(runningStep([step('web_search', false)], false)).toBeUndefined()
  expect(runningStep(undefined, true)).toBeUndefined()
})

test('status text names files the way a person would, never by their whole path', async () => {
  const { fname, describe } = await import('../../src/renderer/src/lib/steps')
  expect(fname('/Users/sahil/Downloads/Patel-Consulting-Invoice.pdf')).toBe('Patel-Consulting-Invoice.pdf in Downloads')
  expect(fname('report.md')).toBe('report.md')
  expect(describe({ call: { name: 'create_document', arguments: JSON.stringify({ path: '/Users/sahil/Downloads/inv.pdf' }) } } as never)[2]).toBe('Creating inv.pdf in Downloads')
})
