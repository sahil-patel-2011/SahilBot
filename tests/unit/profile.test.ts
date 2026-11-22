import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { SettingsStore, cleanProfile } from '../../src/main/settings'
import { whoIs } from '../../src/main/agent/loop'

// Setup asks first name, last name and birthday; userName stays the first name everything else already uses.
const secrets = () => {
  const m = new Map<string, string>()
  return { get: (k: string) => m.get(k), set: (k: string, v: string | null) => { if (v) m.set(k, v); else m.delete(k) }, has: (k: string) => m.has(k) } as never
}
const now = new Date('2026-11-22T12:00:00Z')

test('names are trimmed; a birthday must be a real past date within 120 years', () => {
  expect(cleanProfile({ firstName: '  Sahil ', lastName: ' Patel  ', birthday: '2011-03-04' }, '', now)).toEqual({ firstName: 'Sahil', lastName: 'Patel', birthday: '2011-03-04' })
  for (const bad of ['2011-02-30', '2030-01-01', '1890-05-05', 'March 4', '', 12])
    expect(cleanProfile({ firstName: 'S', lastName: '', birthday: bad }, '', now).birthday, String(bad)).toBeUndefined()
  expect(cleanProfile({ firstName: 'x'.repeat(90), lastName: '' }, '', now).firstName).toHaveLength(60)
})

test('an older setup with a two-word name fills first and last name', () => {
  expect(cleanProfile(undefined, 'Sahil Patel')).toEqual({ firstName: 'Sahil', lastName: 'Patel' })
  const db = new Db(':memory:')
  db.setSetting('settings', { userName: 'Jordan Lee Smith' })
  expect(new SettingsStore(db, secrets()).get().profile).toEqual({ firstName: 'Jordan', lastName: 'Lee Smith' })
})

test('saving the profile sets userName to the first name; changing userName alone keeps the birthday', () => {
  const store = new SettingsStore(new Db(':memory:'), secrets())
  store.set({ profile: { firstName: 'Sahil', lastName: 'Patel', birthday: '2011-03-04' } })
  expect(store.get()).toMatchObject({ userName: 'Sahil', profile: { firstName: 'Sahil', lastName: 'Patel', birthday: '2011-03-04' } })
  store.set({ profile: { lastName: 'Shah' } as never })
  expect(store.get().profile).toEqual({ firstName: 'Sahil', lastName: 'Shah', birthday: '2011-03-04' })
  store.set({ userName: 'Sam Jones' })
  expect(store.get()).toMatchObject({ userName: 'Sam Jones', profile: { firstName: 'Sam', lastName: 'Jones', birthday: '2011-03-04' } })
  store.set({ profile: { firstName: 'Sam', lastName: 'Jones', birthday: '' } })
  expect(store.get().profile?.birthday).toBeUndefined()
})

test('the prompt names the user and their birthday as a month and day, never the year', () => {
  expect(whoIs({ userName: 'Sahil', profile: { firstName: 'Sahil', lastName: 'Patel', birthday: '2011-03-04' } })).toBe('Sahil Patel (call them Sahil); birthday March 4')
  expect(whoIs({ userName: 'Sam' })).toBe('Sam')
  expect(whoIs({ userName: '' })).toBe('')
  expect(whoIs({ userName: 'Sahil', profile: { firstName: 'Sahil', lastName: '', birthday: '2011-03-04' } })).not.toContain('2011')
})
