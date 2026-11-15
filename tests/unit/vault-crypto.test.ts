import { describe, expect, test } from 'vitest'
import { argon2Available, benchmarkKdf, canonical, deriveFromPassword, open, randomKey, seal, VaultCryptoError, wipe } from '../../src/main/secure/crypto'
import { backoffMs, TamperError, ThrottledError, VaultLockedError, WrongPasswordError } from '../../src/main/secure/core'
import { Clock, FakeKeychain, makeCore, SECRET } from '../fixtures/vault-kit'
import { MemoryVaultStorage } from '../../src/main/secure/storage'

describe('AES-256-GCM envelope primitives', () => {
  test('round trip, a fresh 96-bit nonce every time, AAD required to match', () => {
    const k = randomKey()
    const a = seal(k, Buffer.from('hello'), 'aad-1')
    const b = seal(k, Buffer.from('hello'), 'aad-1')
    expect(a.equals(b)).toBe(false)
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false)
    expect(open(k, a, 'aad-1').toString()).toBe('hello')
    expect(() => open(k, a, 'aad-2')).toThrow(VaultCryptoError)
    expect(() => open(randomKey(), a, 'aad-1')).toThrow(VaultCryptoError)
  })

  test('every flipped bit is detected (nonce, ciphertext, tag)', () => {
    const k = randomKey()
    const c = seal(k, Buffer.from('a secret value'), 'x')
    for (let i = 1; i < c.length; i++) {
      const bad = Buffer.from(c)
      bad[i] ^= 0x01
      expect(() => open(k, bad, 'x')).toThrow(VaultCryptoError)
    }
  })

  test('canonical JSON is order-independent and wipe zeroes buffers', () => {
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonical({ a: [1, { c: 3, d: 2 }], b: 1 }))
    const buf = Buffer.from('secret')
    wipe(buf)
    expect([...buf].every((x) => x === 0)).toBe(true)
  })

  test('password stretching: scrypt is deterministic per salt; Argon2id when the runtime has it', async () => {
    const p = { alg: 'scrypt' as const, N: 1024, r: 8, p: 1, salt: Buffer.alloc(16, 1).toString('base64') }
    const a = await deriveFromPassword('pw', p)
    expect(a.equals(await deriveFromPassword('pw', p))).toBe(true)
    expect(a.equals(await deriveFromPassword('pw2', p))).toBe(false)
    expect(a.equals(await deriveFromPassword('pw', { ...p, salt: Buffer.alloc(16, 2).toString('base64') }))).toBe(false)
    if (argon2Available()) {
      const g = { alg: 'argon2id' as const, memory: 1024, passes: 1, parallelism: 1, salt: p.salt }
      expect((await deriveFromPassword('pw', g)).equals(await deriveFromPassword('pw', g))).toBe(true)
    }
    const quick = await benchmarkKdf({ quick: true })
    expect(quick.alg).toBe('scrypt')
  })
})

describe('the vault core: items, tamper detection, unlock', () => {
  test('items round-trip; each version gets a new data key; metadata stays readable while locked', () => {
    const { core, storage } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { username: 'sam', password: SECRET.password })
    const first = storage.row(id)!
    expect(core.get(id)!.payload.password).toBe(SECRET.password)
    core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { username: 'sam', password: SECRET.password }, { id })
    const second = storage.row(id)!
    expect(second.ver).toBe(2)
    expect(second.dk).not.toBe(first.dk)
    expect(second.body).not.toBe(first.body)
    // Nothing in storage holds the value in the clear.
    expect(JSON.stringify(storage.rows())).not.toContain(SECRET.password)
    expect(JSON.stringify([...storage.kv.values()])).not.toContain(SECRET.password)
    core.lock()
    expect(() => core.get(id)).toThrow(VaultLockedError)
    expect(core.list('login')[0].meta.name).toBe('acme')
  })

  test('a flipped bit in a stored item, or a changed site in its metadata, is refused', () => {
    const { core, storage } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: SECRET.password })
    const r = storage.row(id)!
    const body = Buffer.from(r.body, 'base64')
    body[20] ^= 1
    storage.put({ ...r, body: body.toString('base64') })
    expect(() => core.get(id)).toThrow(TamperError)
    storage.put({ ...r, meta: JSON.stringify({ name: 'acme', origins: ['https://evil.test'] }) })
    expect(() => core.get(id)).toThrow(TamperError)
    storage.put(r)
    expect(core.get(id)!.payload.password).toBe(SECRET.password)
  })

  test('ciphertexts swapped between items (or their data keys) fail', () => {
    const { core, storage } = makeCore()
    core.unlockKeychain('presence')
    const a = core.put('login', { name: 'bank', origins: ['https://bank.test'] }, { password: 'bank-password-1' })
    const b = core.put('login', { name: 'forum', origins: ['https://forum.test'] }, { password: 'forum-password-2' })
    const ra = storage.row(a)!, rb = storage.row(b)!
    // The bank's ciphertext under the forum's id and site: the AAD (id, site) no longer matches.
    storage.put({ ...rb, dk: ra.dk, body: ra.body })
    expect(() => core.get(b)).toThrow(TamperError)
    storage.put({ ...rb, body: ra.body })
    expect(() => core.get(b)).toThrow(TamperError)
    // Same id, but the bank's metadata copied onto the forum's ciphertext.
    storage.put({ ...rb, meta: ra.meta })
    expect(() => core.get(b)).toThrow(TamperError)
  })

  test('a row rolled back to an old version, or deleted and put back, is refused (signed manifest)', () => {
    const { core, storage } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: 'old-password' })
    const v1 = storage.row(id)!
    core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: 'new-password' }, { id })
    storage.put(v1)
    expect(() => core.get(id)).toThrow(TamperError)
    const v2id = core.put('note', { name: 'n' }, { body: 'x' })
    const row = storage.row(v2id)!
    core.remove(v2id)
    storage.put(row)
    expect(() => core.get(v2id)).toThrow(TamperError)
  })

  test('an edited manifest marks the whole vault as tampered until the user re-signs it', () => {
    const { core, storage } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: 'pw-123456' })
    core.lock()
    const h = storage.get<any>('vault2:header')
    storage.set('vault2:header', { ...h, manifest: { ...h.manifest, items: { ...h.manifest.items, injected: 1 } } })
    core.unlockKeychain('presence')
    expect(core.tampered).toBe(true)
    expect(() => core.get(id)).toThrow(TamperError)
    core.resign()
    expect(core.get(id)!.payload.password).toBe('pw-123456')
  })

  test('master password: both factors needed; wrong password fails with exponential backoff', async () => {
    const { core, clock, keys, audit } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: SECRET.password })
    await core.setMasterPassword(SECRET.master)
    core.lock()
    expect(() => core.unlockKeychain('presence')).toThrow(/master password/)
    await expect(core.unlockPassword('wrong 1')).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(core.unlockPassword('wrong 2')).rejects.toBeInstanceOf(WrongPasswordError)
    // Third failure: now it waits 1 s, then 2 s, 4 s ...
    const third = await core.unlockPassword('wrong 3').catch((e) => e)
    expect(third).toBeInstanceOf(WrongPasswordError)
    expect(third.retryInMs).toBe(1000)
    await expect(core.unlockPassword(SECRET.master)).rejects.toBeInstanceOf(ThrottledError)
    clock.advance(1000)
    const fourth = await core.unlockPassword('wrong 4').catch((e) => e)
    expect(fourth.retryInMs).toBe(2000)
    clock.advance(2000)
    await core.unlockPassword(SECRET.master)
    expect(core.get(id)!.payload.password).toBe(SECRET.password)
    expect(core.retryInMs()).toBe(0)
    expect(backoffMs(3)).toBe(1000)
    expect(backoffMs(30)).toBe(5 * 60_000)
    expect(audit.entries.filter((e) => e.event === 'unlock_failed').length).toBeGreaterThanOrEqual(4)
    // The password alone isn't enough: without the Keychain key nothing opens.
    core.lock()
    keys.m.delete('vault2:k1')
    await expect(core.unlockPassword(SECRET.master)).rejects.toThrow(/Keychain key is missing/)
  })

  test('changing and removing the master password; Touch ID copy with a master password', async () => {
    const { core } = makeCore()
    core.unlockKeychain('presence')
    const id = core.put('note', { name: 'n' }, { body: SECRET.note })
    await core.setMasterPassword(SECRET.master)
    await expect(core.setMasterPassword('another long password', 'not the current one')).rejects.toBeInstanceOf(WrongPasswordError)
    await core.setMasterPassword('another long password', SECRET.master)
    core.enableBio()
    core.lock()
    core.unlockKeychain('touchid')
    expect(core.get(id)!.payload.body).toBe(SECRET.note)
    await core.removeMasterPassword('another long password')
    core.lock()
    core.unlockKeychain('presence')
    expect(core.get(id)!.payload.body).toBe(SECRET.note)
  })

  test('auto-lock: after the idle limit, or when the Mac has been idle that long', () => {
    const { core, clock } = makeCore()
    core.unlockKeychain('presence')
    core.setPrefs({ autoLockMinutes: 15 })
    clock.advance(14 * 60_000)
    core.tick(0)
    expect(core.isUnlocked()).toBe(true)
    core.touch()
    clock.advance(10 * 60_000)
    core.tick(0)
    expect(core.isUnlocked()).toBe(true)
    clock.advance(5 * 60_000 + 1)
    core.tick(0)
    expect(core.isUnlocked()).toBe(false)
    core.unlockKeychain('presence')
    core.tick(15 * 60)
    expect(core.isUnlocked()).toBe(false)
    core.unlockKeychain('presence')
    core.setPrefs({ autoLockMinutes: 0 })
    clock.advance(10 * 3600_000)
    core.tick(99999)
    expect(core.isUnlocked()).toBe(true)
  })

  test('recently typed values stay masked after locking; nothing else does', () => {
    const { core, clock } = makeCore()
    core.unlockKeychain('presence')
    core.put('login', { name: 'a', origins: ['https://a.test'] }, { password: 'pw-aaaaaa' })
    core.put('login', { name: 'b', origins: ['https://b.test'] }, { password: 'pw-bbbbbb' })
    expect(core.guardValues().sort()).toEqual(['pw-aaaaaa', 'pw-bbbbbb'])
    core.noteFilled(['pw-aaaaaa'])
    core.lock()
    expect(core.guardValues()).toEqual(['pw-aaaaaa'])
    clock.advance(31 * 60_000)
    expect(core.guardValues()).toEqual([])
  })

  test('encrypted export and import: round trip, wrong password, tampered file', async () => {
    const { core } = makeCore()
    core.unlockKeychain('presence')
    core.put('login', { name: 'acme', origins: ['https://acme.test'] }, { password: SECRET.password })
    core.put('card', { name: 'Personal', last4: '4242' }, { number: SECRET.card, cvc: SECRET.cvc })
    const file = await core.exportBundle('backup password 1')
    expect(file).not.toContain(SECRET.password)
    expect(file).not.toContain(SECRET.card)
    const other = makeCore({ keys: new FakeKeychain(), storage: new MemoryVaultStorage(), clock: new Clock() }).core
    const items = await other.readBundle(file, 'backup password 1')
    expect(items.map((i) => i.payload.password ?? i.payload.number).sort()).toEqual([SECRET.card, SECRET.password].sort())
    await expect(other.readBundle(file, 'wrong password!!')).rejects.toThrow(/Wrong backup password/)
    const j = JSON.parse(file)
    const body = Buffer.from(j.items[0].body, 'base64'); body[15] ^= 1; j.items[0].body = body.toString('base64')
    await expect(other.readBundle(JSON.stringify(j), 'backup password 1')).rejects.toThrow(/changed or damaged/)
    const k = JSON.parse(file); k.items[0].meta = { ...k.items[0].meta, origins: ['https://evil.test'] }
    await expect(other.readBundle(JSON.stringify(k), 'backup password 1')).rejects.toThrow(/changed or damaged/)
  })

  test('the vault refuses to start without the Keychain', () => {
    const keys = new FakeKeychain()
    keys.ok = false
    expect(() => makeCore({ keys })).toThrow(/Keychain/)
  })
})
