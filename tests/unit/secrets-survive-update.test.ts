import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { expect, test, vi } from 'vitest'

// Keys survive an update: Electron's safeStorage stops opening for a new ad-hoc-signed build, so secrets move to
// SahilBot's own Keychain key (src/main/secrets.ts). Fake Keychain and safeStorage here; the real ones are never
// touched by tests.
const broken = { on: false }
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`ss:${s}`),
    decryptString: (b: Buffer) => { if (broken.on) throw new Error('Keychain refused'); const t = b.toString(); if (!t.startsWith('ss:')) throw new Error('bad'); return t.slice(3) }
  }
}))
const { Secrets, openLegacy, seal, open } = await import('../../src/main/secrets')
const { Db } = await import('../../src/main/db')

const store = (pw?: string) => {
  let key: Buffer | undefined
  let asked = 0
  return { ks: { get: () => key ?? ('missing' as const), create: () => (key = Buffer.alloc(32, 7)), legacyPassword: () => { asked++; return pw } }, asked: () => asked }
}
/** What Chromium's safeStorage writes on macOS ("v10", AES-128-CBC). */
const chromium = (value: string, pw: string): string => {
  const c = createCipheriv('aes-128-cbc', pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1'), Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), c.update(value, 'utf8'), c.final()]).toString('base64')
}

test('new keys are sealed with the Keychain key, so a new build reads them even when safeStorage refuses', () => {
  const db = new Db(':memory:')
  const { ks } = store()
  new Secrets(db, ks).set('anthropic', 'sk-test-123')
  expect(String(db.getSetting('secret:anthropic'))).toMatch(/^v2:/)
  broken.on = true
  expect(new Secrets(db, ks).get('anthropic')).toBe('sk-test-123')
  broken.on = false
})

test('a key saved by an older build moves over: by safeStorage while it works, else with the old item\'s password (asked once)', () => {
  const db = new Db(':memory:')
  db.setSetting('secret:openai', Buffer.from('ss:sk-old-1').toString('base64'))
  const a = store()
  expect(new Secrets(db, a.ks).get('openai')).toBe('sk-old-1')
  expect(String(db.getSetting('secret:openai'))).toMatch(/^v2:/)
  expect(a.asked()).toBe(0)

  // After the update safeStorage refuses: the old item's password opens what it wrote.
  const db2 = new Db(':memory:')
  db2.setSetting('secret:openai', chromium('sk-old-2', 'old-safe-storage-pw'))
  db2.setSetting('secret:xai', chromium('xai-old-3', 'old-safe-storage-pw'))
  broken.on = true
  const b = store('old-safe-storage-pw')
  const s = new Secrets(db2, b.ks)
  expect(s.get('openai')).toBe('sk-old-2')
  expect(s.get('xai')).toBe('xai-old-3')
  expect(b.asked()).toBe(1)
  expect(String(db2.getSetting('secret:xai'))).toMatch(/^v2:/)
  // From now on no prompt: it's sealed with the new key.
  const c = store('old-safe-storage-pw')
  expect(new Secrets(db2, { ...c.ks, get: () => Buffer.alloc(32, 7) }).get('xai')).toBe('xai-old-3')
  expect(c.asked()).toBe(0)
  broken.on = false
})

test('said no to the prompt: the key reads as missing but is kept, so allowing later brings it back', () => {
  const db = new Db(':memory:')
  db.setSetting('secret:openai', chromium('sk-kept', 'pw'))
  broken.on = true
  const s = new Secrets(db, store(undefined).ks)
  expect(s.get('openai')).toBeUndefined()
  expect(s.unreadable.has('openai')).toBe(true)
  expect(db.getSetting('secret:openai')).toBeTruthy()
  expect(new Secrets(db, store('pw').ks).get('openai')).toBe('sk-kept')
  broken.on = false
})

test('sealing round-trips and rejects a wrong key; the Chromium format decodes', () => {
  const k = Buffer.alloc(32, 1)
  expect(open(k, seal(k, 'hello'))).toBe('hello')
  expect(() => open(Buffer.alloc(32, 2), seal(k, 'hello'))).toThrow()
  expect(openLegacy(Buffer.from(chromium('abc', 'p'), 'base64'), 'p')).toBe('abc')
})

test('without a Keychain (tests, the server) safeStorage is used as before', () => {
  const db = new Db(':memory:')
  const s = new Secrets(db, null)
  s.set('k', 'v')
  expect(Buffer.from(String(db.getSetting('secret:k')), 'base64').toString()).toBe('ss:v')
  expect(s.get('k')).toBe('v')
})

test('a locked Keychain never leads to a new key (which would make every saved key unreadable); it\'s asked again later', () => {
  const db = new Db(':memory:')
  const good = Buffer.alloc(32, 9)
  db.setSetting('secret:anthropic', seal(good, 'sk-safe'))
  let state: 'locked' | 'open' = 'locked'
  let created = 0
  const ks = { get: () => (state === 'locked' ? ('error' as const) : good), create: () => { created++; return Buffer.alloc(32, 1) }, legacyPassword: () => undefined }
  const s = new Secrets(db, ks)
  expect(s.get('anthropic')).toBeUndefined()
  expect(created).toBe(0)
  expect(db.getSetting('secret:anthropic')).toBeTruthy()
  state = 'open'
  const later = new Secrets(db, ks)
  expect(later.get('anthropic')).toBe('sk-safe')
  expect(created).toBe(0)
})
