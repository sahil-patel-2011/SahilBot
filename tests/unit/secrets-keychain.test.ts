import { expect, test, vi } from 'vitest'

// API keys must never vanish because the Keychain hiccupped. The bug: any failed Keychain read (still locked
// after login, a slow answer, a dismissed prompt) counted as "no key", so a NEW key was made and written over the
// old Keychain item: every saved key became unreadable for good. Fake Keychain here; the real one is never touched.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`ss:${s}`), decryptString: (b: Buffer) => b.toString().slice(3) }
}))
const { Secrets, KeychainUnavailable } = await import('../../src/main/secrets')
const { Db } = await import('../../src/main/db')

/** A fake Keychain with a primary and a backup item, and a switch that makes reads fail like a locked Keychain. */
function keychain(o: { primary?: Buffer; backup?: Buffer } = {}) {
  const st = { primary: o.primary, backup: o.backup, locked: false, created: 0, restored: 0, backedUp: 0 }
  const guard = (): void => { if (st.locked) throw new KeychainUnavailable('locked') }
  return {
    st,
    ks: {
      get: () => { guard(); return st.primary },
      create: () => { guard(); if (st.primary) throw new Error('would overwrite'); st.created++; st.primary = Buffer.alloc(32, st.created + 1); st.backup ??= st.primary; return st.primary },
      getBackup: () => { guard(); return st.backup },
      saveBackup: (k: Buffer) => { st.backedUp++; st.backup = k },
      restore: (k: Buffer) => { st.restored++; st.primary = k },
      legacyPassword: () => undefined
    }
  }
}

test('a locked Keychain never creates a new key: saved keys come back once it answers', () => {
  const db = new Db(':memory:')
  const kc = keychain()
  new Secrets(db, kc.ks).set('apiKey@https://api.anthropic.com', 'sk-ant-1')
  expect(kc.st.created).toBe(1)
  const key = kc.st.primary

  // Next launch: the Keychain is locked. The key reads as missing, but nothing is created or overwritten.
  kc.st.locked = true
  const s2 = new Secrets(db, kc.ks)
  expect(s2.get('apiKey@https://api.anthropic.com')).toBeUndefined()
  expect(s2.locked().count).toBe(1)
  expect(kc.st.created).toBe(1)
  expect(kc.st.primary).toBe(key)
  // Saving while locked refuses plainly (never falls back to safeStorage, which breaks on the next update).
  expect(() => s2.set('apiKey@https://api.openai.com', 'sk-2')).toThrow(/Keychain didn't answer/)
  expect(String(db.getSetting('secret:apiKey@https://api.openai.com') ?? '')).toBe('')

  // Unlocked: a fresh read (the next launch, or after the retry wait) gets everything back.
  kc.st.locked = false
  const s3 = new Secrets(db, kc.ks)
  expect(s3.get('apiKey@https://api.anthropic.com')).toBe('sk-ant-1')
  expect(s3.locked().count).toBe(0)
})

test('a deleted primary Keychain item is restored from the backup copy instead of replaced', () => {
  const db = new Db(':memory:')
  const kc = keychain()
  new Secrets(db, kc.ks).set('braveKey', 'brave-1')
  kc.st.primary = undefined
  const s2 = new Secrets(db, kc.ks)
  expect(s2.get('braveKey')).toBe('brave-1')
  expect(kc.st.restored).toBe(1)
  expect(kc.st.created).toBe(1)
})

test('an existing key gets its backup copy written once; a backup is never replaced', () => {
  const db = new Db(':memory:')
  const kc = keychain({ primary: Buffer.alloc(32, 9) })
  new Secrets(db, kc.ks).set('tbaKey', 'tba-1')
  expect(kc.st.backedUp).toBe(1)
  expect(kc.st.backup).toEqual(Buffer.alloc(32, 9))
  new Secrets(db, kc.ks).get('tbaKey')
  expect(kc.st.backedUp).toBe(1)
})

test('only a Keychain that truly has no key gets a new one', () => {
  const db = new Db(':memory:')
  const kc = keychain()
  const s = new Secrets(db, kc.ks)
  s.set('ncbiKey', 'n-1')
  expect(kc.st.created).toBe(1)
  expect(s.get('ncbiKey')).toBe('n-1')
})

test('after the Keychain unlocks, the same session reads the keys and stops reporting them locked', async () => {
  const db = new Db(':memory:')
  const kc = keychain()
  new Secrets(db, kc.ks).set('braveKey', 'b-1')
  kc.st.locked = true
  const s = new Secrets(db, kc.ks)
  expect(s.get('braveKey')).toBeUndefined()
  expect(s.locked().count).toBe(1)
  kc.st.locked = false
  vi.useFakeTimers({ now: Date.now() + 61_000 })
  try {
    expect(s.get('braveKey')).toBe('b-1')
    expect(s.locked().count).toBe(0)
  } finally { vi.useRealTimers() }
})

test('a primary key that differs from the backup still opens values sealed with the backup key, and re-seals them', () => {
  const db = new Db(':memory:')
  const kc = keychain()
  new Secrets(db, kc.ks).set('tbaKey', 't-1')
  // An older build replaced the primary item with a different key; the backup still has the original.
  kc.st.primary = Buffer.alloc(32, 42)
  const s = new Secrets(db, kc.ks)
  expect(s.get('tbaKey')).toBe('t-1')
  // Re-sealed with the primary: it opens even without the backup now.
  kc.st.backup = undefined
  expect(new Secrets(db, kc.ks).get('tbaKey')).toBe('t-1')
})
