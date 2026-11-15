import { describe, expect, test } from 'vitest'
import { benignClickLabel } from '../../src/main/browser/checkout'

// Found live: browsing a state incentive site asked for approval on every click in Auto.
describe('benign click labels', () => {
  test('browsing verbs with an object are navigation', () => {
    for (const l of ['Select the Budget Category', 'View plans', 'Compare models', 'Show all results', 'Open the FAQ', 'Learn more about SGIP', 'Browse products', 'See pricing', 'Read the guide', 'Filter by state'])
      expect(benignClickLabel(l), l).toBe(true)
  })
  test('commit words still count, whatever comes first', () => {
    for (const l of ['Select and pay', 'View and confirm order', 'Submit application', 'Send message', 'Buy now', 'Delete account', 'Subscribe', 'Publish post', 'Share with team', 'Apply now', 'Choose plan $29/mo', 'Select and checkout', 'Confirm', 'Transfer funds', 'Approve request'])
      expect(benignClickLabel(l), l).toBe(false)
  })
  test('plain unknown labels stay consequential', () => {
    for (const l of ['Continue with this', 'Done', 'Proceed', 'Yes'])
      expect(benignClickLabel(l), l).toBe(false)
  })
})
