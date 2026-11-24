import { describe, expect, test } from 'vitest'
import { isStopRequest } from '../../src/main/agent/stop-intent'

describe('typed stop while a bot works', () => {
  test('a message that is only a stop stops', () => {
    for (const t of ['stop', 'Stop!', 'cancel', 'Cancel that.', 'never mind', 'nevermind', 'nvm', 'forget it', 'scratch that', 'ok stop', 'please stop', 'stop now please', 'stop working', 'cancel the task', 'abort', 'don\'t do that', 'Stop what you’re doing', 'no stop', 'halt', 'Stop Test 5 now', 'cancel the task now', 'stop that now', 'please stop this run immediately'])
      expect(isStopRequest(t), t).toBe(true)
  })
  test('steering that mentions stopping is not a stop', () => {
    for (const t of ['stop using commas', 'cancel the 3pm meeting', 'make it 4 printers, not 3', 'stop at the first result and summarize', 'never mind the budget, find the best one', 'don\'t stop until all tests pass', 'can you stop the server on port 3000', 'bus stop near me', '', 'stop using commas now', 'cancel the 3pm meeting now', 'stop the music now', 'end the call now', 'stop at the first result now please'])
      expect(isStopRequest(t), t).toBe(false)
  })
})
