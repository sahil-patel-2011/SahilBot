import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { EncryptedFile, ServerSafeStorage, parseKey, resolveMasterKey } from '../../src/server/secrets'

// The server's Keychain stand-in: the master key and AES-256-GCM sealing (src/server/secrets.ts).

const dir = (): string => mkdtempSync(join(tmpdir(), 'sb-srv-secrets-'))
const N = 2 ** 10

describe('master key', () => {
  test('first start makes a random key file only the owner can read; later starts reuse it', async () => {
    const d = dir()
    const a = await resolveMasterKey({ dir: d, env: {} })
    expect(a.kind).toBe('keyfile')
    expect(statSync(join(d, 'master.key')).mode & 0o777).toBe(0o600)
    const b = await resolveMasterKey({ dir: d, env: {} })
    expect(b.key.equals(a.key)).toBe(true)
    expect(a.id).toMatch(/^[0-9a-f]{12}$/)
  })

  test('a passphrase is stretched with scrypt; a wrong one is refused, and so is starting without it', async () => {
    const d = dir()
    const a = await resolveMasterKey({ dir: d, env: {}, passphrase: 'correct horse battery staple', scryptN: N })
    expect(a.kind).toBe('passphrase')
    const ring = JSON.parse(readFileSync(join(d, 'keyring.json'), 'utf8'))
    expect(ring.kdf).toMatchObject({ alg: 'scrypt', N })
    expect(JSON.stringify(ring)).not.toContain('correct horse')
    const again = await resolveMasterKey({ dir: d, env: {}, passphrase: 'correct horse battery staple' })
    expect(again.key.equals(a.key)).toBe(true)
    await expect(resolveMasterKey({ dir: d, env: {}, passphrase: 'wrong' })).rejects.toThrow('Wrong passphrase')
    await expect(resolveMasterKey({ dir: d, env: {} })).rejects.toThrow('set up with a passphrase')
  })

  test('SAHILBOT_MASTER_KEY (hex or base64) and systemd credentials', async () => {
    const hex = 'ab'.repeat(32)
    const d = dir()
    const a = await resolveMasterKey({ dir: d, env: { SAHILBOT_MASTER_KEY: hex } })
    expect(a.kind).toBe('env')
    expect(a.key.toString('hex')).toBe(hex)
    // The same key from a credential file is accepted; a different one is not.
    const creds = dir()
    writeFileSync(join(creds, 'sahilbot-master-key'), Buffer.from(hex, 'hex').toString('base64'))
    expect((await resolveMasterKey({ dir: d, env: { CREDENTIALS_DIRECTORY: creds } })).kind).toBe('credential')
    writeFileSync(join(creds, 'sahilbot-master-key'), 'cd'.repeat(32))
    await expect(resolveMasterKey({ dir: d, env: { CREDENTIALS_DIRECTORY: creds } })).rejects.toThrow('does not match')
    expect(() => parseKey('short')).toThrow('32 bytes')
  })
})

describe('sealing', () => {
  test('safeStorage stand-in round-trips and rejects tampering or another key', async () => {
    const k1 = (await resolveMasterKey({ dir: dir(), env: {} })).key
    const k2 = (await resolveMasterKey({ dir: dir(), env: {} })).key
    const s = new ServerSafeStorage(k1)
    expect(s.isEncryptionAvailable()).toBe(true)
    const enc = s.encryptString('sk-ant-secret-value')
    expect(enc.toString('utf8')).not.toContain('sk-ant')
    expect(s.decryptString(enc)).toBe('sk-ant-secret-value')
    const bad = Buffer.from(enc)
    bad[bad.length - 1] ^= 1
    expect(() => s.decryptString(bad)).toThrow()
    expect(() => new ServerSafeStorage(k2).decryptString(enc)).toThrow()
    expect(new ServerSafeStorage(null).isEncryptionAvailable()).toBe(false)
  })

  test('an encrypted file holds JSON sealed at rest', async () => {
    const d = dir()
    mkdirSync(d, { recursive: true })
    const key = (await resolveMasterKey({ dir: d, env: {} })).key
    const f = new EncryptedFile<{ token: string }>(join(d, 'x.enc'), key, 'test')
    expect(f.read()).toBeUndefined()
    f.write({ token: 'tok_123' })
    expect(readFileSync(join(d, 'x.enc')).toString('latin1')).not.toContain('tok_123')
    expect(f.read()).toEqual({ token: 'tok_123' })
    expect(() => new EncryptedFile(join(d, 'x.enc'), key, 'other-aad').read()).toThrow()
  })
})
