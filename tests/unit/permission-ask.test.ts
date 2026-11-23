import { expect, test } from 'vitest'
import { permissionAsked } from '../../src/renderer/src/lib/permission-ask'

// Grok Bot head-to-head (Calculator, 245 × 18): the reply named the setting; now it comes with a button to it.
test('a reply that asks for a Mac permission gets the button for that switch', () => {
  expect(permissionAsked('Calculator is open, but macOS blocked me from clicking its buttons. To finish the test, turn on SahilBot in System Settings → Privacy & Security → Accessibility.')).toBe('accessibility')
  expect(permissionAsked('I need Screen Recording permission to see the window.')).toBe('screen')
  expect(permissionAsked('The accessibility of your website looks good.')).toBeUndefined()
  expect(permissionAsked('Here is your invoice.')).toBeUndefined()
})
