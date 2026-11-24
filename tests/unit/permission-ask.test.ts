import { expect, test } from 'vitest'
import { openPermission, permissionAsked, type PermissionsApi } from '../../src/renderer/src/lib/permission-ask'

// Grok Bot head-to-head (Calculator, 245 × 18): the reply named the setting; now it comes with a button to it.
test('a reply that asks for a Mac permission gets the button for that switch', () => {
  expect(permissionAsked('Calculator is open, but macOS blocked me from clicking its buttons. To finish the test, turn on SahilBot in System Settings → Privacy & Security → Accessibility.')).toBe('accessibility')
  expect(permissionAsked('I need Screen Recording permission to see the window.')).toBe('screen')
  expect(permissionAsked('The accessibility of your website looks good.')).toBeUndefined()
  expect(permissionAsked('Here is your invoice.')).toBeUndefined()
})

test('one tap always lands on the switch: the pane opens when macOS shows no prompt of its own', async () => {
  const calls: string[] = []
  const fake = (r: Awaited<ReturnType<PermissionsApi['request']>> | Error): PermissionsApi => ({
    request: async (k) => { calls.push(`request ${k}`); if (r instanceof Error) throw r; return r },
    open: async (k) => { calls.push(`open ${k}`) }
  })
  await openPermission(fake('prompted'), 'accessibility')
  expect(calls).toEqual(['request accessibility', 'open accessibility'])
  calls.length = 0
  await openPermission(fake('granted'), 'accessibility')
  expect(calls).toEqual(['request accessibility'])
  calls.length = 0
  await openPermission(fake('opened'), 'screen')
  expect(calls).toEqual(['request screen'])
  calls.length = 0
  await openPermission(fake(new Error('no ipc')), 'automation')
  expect(calls).toEqual(['request automation', 'open automation'])
})
