import { expect, test } from 'vitest'
import { isAside, quickMath } from '../../src/main/agent/aside'

// Report AL-01: a mid-task "18% of $1,740" took about 25 seconds. Plain arithmetic is now worked out at once.
test('plain arithmetic in a side question is answered instantly and exactly', () => {
  expect(quickMath("What's 18% of $1,740?")).toBe('18% of $1,740 = $313.20.')
  expect(quickMath('18% of 1740')).toBe('18% of 1740 = 313.2.')
  expect(quickMath('250 + 75 - 10')).toBe('250 + 75 - 10 = 315.')
  expect(quickMath('(3+4)*2')).toBe('(3+4)*2 = 14.')
  expect(quickMath('9 squared')).toBe('9 squared = 81.')
  expect(quickMath('17 × 23')).toBe('17 × 23 = 391.')
  expect(quickMath('12 x 12')).toBe('12 x 12 = 144.')
  expect(quickMath('100 / 8')).toBe('100 / 8 = 12.5.')
  expect(quickMath('2^10')).toBe('2^10 = 1,024.')
  expect(quickMath('-5 + 3')).toBe('-5 + 3 = -2.')
})

test('anything that is not plain arithmetic goes to the model', () => {
  for (const q of ['how is it going?', 'what is the capital of France?', '1740', 'what is 5 apples plus 3', '1/0', 'process.exit()', '2 +', '((1+2)']) expect(quickMath(q), q).toBeUndefined()
  expect(isAside("What's 18% of $1,740?")).toBe(true)
})
