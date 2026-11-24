import { expect, test } from 'vitest'
import { distinctTitle, micErrorText, personName, rowSubtitle } from '../../src/renderer/src/lib/ux'

test('the sidebar shows the full name and initials from the profile (or an older one-field name)', () => {
  expect(personName({ userName: 'Sahil', profile: { firstName: 'Sahil', lastName: 'Patel' } })).toEqual({ full: 'Sahil Patel', initials: 'SP' })
  expect(personName({ userName: 'Sam', profile: { firstName: 'Sam', lastName: '' } })).toEqual({ full: 'Sam', initials: 'S' })
  expect(personName({ userName: 'jordan lee' })).toEqual({ full: 'jordan lee', initials: 'JL' })
  expect(personName({ userName: '' })).toEqual({ full: '', initials: '' })
  expect(personName({ userName: 'Émile', profile: { firstName: 'Émile', lastName: 'Zola' } }).initials).toBe('ÉZ')
})

test('a chat title shows next to its bot\'s name only when it says something else ("New bot · New bot" never)', () => {
  expect(distinctTitle('New bot', 'New bot')).toBe(false)
  expect(distinctTitle('  new   BOT ', 'New bot')).toBe(false)
  expect(distinctTitle('New chat', 'Inbox')).toBe(false)
  expect(distinctTitle('Untitled', 'Inbox')).toBe(false)
  expect(distinctTitle('', 'Inbox')).toBe(false)
  expect(distinctTitle(undefined, 'Inbox')).toBe(false)
  expect(distinctTitle('Tell me what you can do', 'New bot')).toBe(true)
  expect(distinctTitle('Inbox zero plan', 'Inbox')).toBe(true)
  expect(distinctTitle('Trip ideas', null)).toBe(true)
})

test('the microphone failing to start says why in plain words', () => {
  expect(micErrorText({ name: 'NotFoundError', message: 'Requested device not found' })).toMatch(/^No microphone found/)
  expect(micErrorText({ name: 'NotAllowedError', message: 'Permission denied' })).toMatch(/Allow it in System Settings/)
  expect(micErrorText({ name: 'NotReadableError', message: 'Could not start audio source' })).toMatch(/busy in another app/)
  expect(micErrorText(new Error('Something else'))).toBe('Something else')
  expect(micErrorText(null)).toMatch(/didn't start/)
})

test('a group of one says "1 bot"', () => {
  expect(rowSubtitle({ kind: 'group', members: ['a'], lastPreview: '', label: null, lastAt: null } as never)).toBe('1 bot')
  expect(rowSubtitle({ kind: 'group', members: ['a', 'b'], lastPreview: '', label: null, lastAt: null } as never)).toBe('2 bots')
})
