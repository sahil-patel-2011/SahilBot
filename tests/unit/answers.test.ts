import { describe, expect, test } from 'vitest'
import { plain, recommended } from '../../src/renderer/src/lib/answers'

describe('Needs you answers', () => {
  test('only the bot\'s own recommendation is pre-picked, never just the first option', () => {
    expect(recommended({ question: 'Which?', options: ['Monday', 'Tuesday'] } as never)).toBeUndefined()
    expect(recommended({ question: 'Which?', options: ['Monday', 'Tuesday (recommended)'] } as never)).toBe('Tuesday (recommended)')
    expect(recommended({ question: 'Which?', options: ['Monday', 'Tuesday'], default: ' Monday ' } as never)).toBe('Monday')
    expect(recommended({ question: 'Anything else?' } as never)).toBeUndefined()
  })
  test('answers show without the bot\'s tags', () => {
    expect(plain('Tuesday (recommended)')).toBe('Tuesday')
    expect(plain('Use the  (Default)  plan')).toBe('Use the plan')
  })
})
