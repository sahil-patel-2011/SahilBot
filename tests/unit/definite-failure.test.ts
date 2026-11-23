import { expect, test } from 'vitest'
import { definiteFailure } from '../../src/main/agent/runtime/policy'

// A write the app's own guard refused touched nothing: it may be retried (a refused overwrite used to block the
// corrected write as "uncertain, may already have happened").
test('refusals from the file guards are definite failures; network trouble stays uncertain', () => {
  expect(definiteFailure("rename_photos.py already exists and this chat hasn't opened it, so nothing was written. Read it first…")).toBe(true)
  expect(definiteFailure('Nothing was written: this would replace big.txt (500 lines) with 2 lines and delete the rest.')).toBe(true)
  expect(definiteFailure('old_string appears 3 times; add surrounding text to make it unique in a.js.')).toBe(true)
  expect(definiteFailure('notes.md changed on disk since you last read it (…). Nothing was written.')).toBe(true)
  expect(definiteFailure('ECONNRESET while sending')).toBe(false)
})
