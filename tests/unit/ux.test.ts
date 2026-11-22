import { expect, test } from 'vitest'
import { personName } from '../../src/renderer/src/lib/ux'

test('the sidebar shows the full name and initials from the profile (or an older one-field name)', () => {
  expect(personName({ userName: 'Sahil', profile: { firstName: 'Sahil', lastName: 'Patel' } })).toEqual({ full: 'Sahil Patel', initials: 'SP' })
  expect(personName({ userName: 'Sam', profile: { firstName: 'Sam', lastName: '' } })).toEqual({ full: 'Sam', initials: 'S' })
  expect(personName({ userName: 'jordan lee' })).toEqual({ full: 'jordan lee', initials: 'JL' })
  expect(personName({ userName: '' })).toEqual({ full: '', initials: '' })
  expect(personName({ userName: 'Émile', profile: { firstName: 'Émile', lastName: 'Zola' } }).initials).toBe('ÉZ')
})
