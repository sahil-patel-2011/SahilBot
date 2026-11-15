import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { Vault, VaultLockedError } from '../../src/main/vault'
import { MemoryAuditLog } from '../../src/main/secure/audit'
import { redactSecrets, containsAny, MASK } from '../../src/main/secure/redact'
import { loginsFromCsv, parseCsv } from '../../src/main/secure/csv'
import { MemoryVaultStorage } from '../../src/main/secure/storage'
import { FakeKeychain, fillVault, makeVault, quickKdf, SECRET } from '../fixtures/vault-kit'

/** Writes entries the way the pre-envelope vault did: plain indexes in settings, one Keychain string each. */
function writeOldFormat(db: Db, secrets: FakeKeychain): void {
  db.setSetting('vault:index', [{ name: 'acme', origin: 'https://acme.test' }, { name: 'gh', origin: 'https://github.com', subdomains: true }])
  secrets.set('vault:acme', JSON.stringify({ username: 'sam@example.test', password: SECRET.password, totp: { secret: SECRET.totp, digits: 6, period: 30, algorithm: 'SHA1' } }))
  secrets.set('vault:gh', JSON.stringify({ username: 'sam', password: 'gh-password-xyz' }))
  db.setSetting('vault:addresses', [{ id: 'addr-1', nickname: 'Home' }])
  secrets.set('address:addr-1', JSON.stringify({ id: 'addr-1', nickname: 'Home', name: 'Sam Rivera', line1: '1 Main St', city: 'Albany', postal: '12207', country: 'US' }))
  db.setSetting('vault:cards', [{ id: 'card-1', nickname: 'Personal', brand: 'visa', last4: '4242', billing: 'addr-1' }])
  secrets.set('card:card-1', JSON.stringify({ number: SECRET.card, cvc: SECRET.cvc, expMonth: 8, expYear: 2031, holder: 'Sam Rivera' }))
}

describe('migration from the Keychain-only format', () => {
  test('moves every entry, verifies it decrypts, keeps the old copies, and is idempotent', () => {
    const db = new Db(':memory:')
    const secrets = new FakeKeychain()
    writeOldFormat(db, secrets)
    const { vault } = makeVault({ db, secrets })
    expect(vault.legacyState()).toMatchObject({ present: true, migrated: 4 })
    vault.core.unlockKeychain('presence')
    expect(vault.credential('acme')).toMatchObject({ username: 'sam@example.test', password: SECRET.password })
    expect(vault.totpCode('acme')?.code).toMatch(/^\d{6}$/)
    expect(vault.names().find((n) => n.name === 'gh')).toMatchObject({ subdomains: true })
    expect(vault.findCard('Personal')).toMatchObject({ number: SECRET.card, billing: 'addr-1' })
    expect(vault.findAddress('Home')).toMatchObject({ line1: '1 Main St' })
    // The old copies are untouched (rollback path) and a second start doesn't duplicate anything.
    expect(secrets.get('vault:acme')).toContain(SECRET.password)
    expect(vault.start().migrated).toBe(0)
    expect(vault.items()).toHaveLength(4)
    // Removing the old copies only after they verify.
    vault.purgeLegacy()
    expect(secrets.get('vault:acme')).toBeUndefined()
    expect(secrets.get('card:card-1')).toBeUndefined()
    expect(vault.legacyState().present).toBe(false)
    expect(vault.credential('acme')?.password).toBe(SECRET.password)
  })

  test('a failure part-way rolls the whole migration back and leaves the old format as it was', () => {
    const db = new Db(':memory:')
    const secrets = new FakeKeychain()
    writeOldFormat(db, secrets)
    // Storage that fails on the third write (like a full disk).
    const storage = new MemoryVaultStorage()
    let puts = 0
    const put = storage.put.bind(storage)
    storage.put = (r) => { if (++puts === 3) throw new Error('disk full'); put(r) }
    const audit = new MemoryAuditLog()
    const vault = new Vault(db, secrets, { storage, audit, kdf: quickKdf })
    expect(vault.start().migrated).toBe(0)
    expect(storage.rows()).toHaveLength(0)
    expect(audit.entries.some((e) => e.event === 'migration' && e.outcome === 'failed')).toBe(true)
    expect(secrets.get('vault:acme')).toContain(SECRET.password)
    expect(db.getSetting('vault:index')).toHaveLength(2)
    // Next start with working storage: it goes through.
    storage.put = put
    expect(vault.start().migrated).toBe(4)
    vault.core.unlockKeychain('presence')
    expect(vault.credential('gh')?.password).toBe('gh-password-xyz')
  })

  test('rollback writes the current items back in the old format (readable by an older SahilBot)', () => {
    const db = new Db(':memory:')
    const secrets = new FakeKeychain()
    const { vault } = makeVault({ db, secrets })
    fillVault(vault)
    vault.rollback()
    expect(db.getSetting<Array<{ name: string }>>('vault:index')!.map((x) => x.name)).toEqual(['acme'])
    expect(JSON.parse(secrets.get('vault:acme')!)).toMatchObject({ password: SECRET.password })
    expect(JSON.parse(secrets.get(`card:${vault.cards()[0].id}`)!)).toMatchObject({ number: SECRET.card })
    expect(vault.legacyState()).toMatchObject({ rolledBack: true })
    // A rolled-back vault doesn't migrate the copy again.
    expect(vault.start().migrated).toBe(0)
  })

  test('an unreadable old entry (Keychain changed) is reported, not fatal', () => {
    const db = new Db(':memory:')
    const secrets = new FakeKeychain()
    db.setSetting('vault:index', [{ name: 'lost', origin: 'https://lost.test' }])
    const { vault } = makeVault({ db, secrets })
    expect(vault.legacyState().unreadable).toEqual(['login "lost"'])
  })
})

describe('the vault facade', () => {
  test('lists metadata only; values need the unlocked vault', async () => {
    const { vault } = makeVault()
    fillVault(vault)
    const meta = JSON.stringify([vault.list(), vault.cards(), vault.addresses(), vault.items(), vault.names(), vault.cardNames()])
    for (const v of [SECRET.password, SECRET.card, SECRET.cvc, SECRET.id, SECRET.totp, SECRET.note, 'sam@example.test', '1 Main St']) expect(meta).not.toContain(v)
    expect(vault.cards()[0]).toMatchObject({ last4: '4242', brand: 'visa', expMonth: 8, expYear: 2031, hasCvc: true })
    expect(vault.list()[0].username).toBe('sa•••@example.test')
    await vault.core.setMasterPassword(SECRET.master)
    vault.lock()
    expect(() => vault.credential('acme')).toThrow(VaultLockedError)
    expect(() => vault.findCard('Personal')).toThrow(VaultLockedError)
    expect(vault.findCardMeta('Visa ending 4242')).toMatchObject({ label: 'Personal (Visa ending 4242)' })
    // With a master password, edits that keep saved values need the vault open.
    expect(() => vault.set({ name: 'acme', origin: 'https://acme.test', username: 'x' })).toThrow(VaultLockedError)
  })

  test('redaction masks every saved value however it appears', () => {
    const { vault } = makeVault()
    fillVault(vault)
    const page = `Your password is ${SECRET.password}. Card 4242 4242 4242 4242 / 4242-4242-4242-4242. ID ${SECRET.id}. key ${SECRET.totp.toLowerCase()}`
    const out = vault.redact(page)
    expect(out).not.toContain(SECRET.password)
    expect(out).not.toMatch(/4242[\s-]4242[\s-]4242[\s-]4242/)
    expect(out).toContain('•••• 4242')
    expect(out).not.toContain(SECRET.id)
    expect(out.toLowerCase()).not.toContain(SECRET.totp.toLowerCase())
    expect(out).toContain(MASK)
    expect(redactSecrets('abc', ['ab'])).toBe('abc')
    expect(containsAny('4242 4242 4242 4242', [SECRET.card])).toBe(true)
    // Locked: values typed recently are still masked.
    vault.core.noteFilled([SECRET.password])
    vault.lock()
    expect(vault.redact(`echo ${SECRET.password}`)).toBe(`echo ${MASK}`)
  })

  test('cards: security code is optional and can be forgotten; addresses keep a summary only', () => {
    const { vault } = makeVault()
    const [c] = vault.setCard({ nickname: 'Work', number: '4000 0566 5566 5556', expMonth: 12, expYear: 2032, holder: 'Sam' })
    expect(c.hasCvc).toBe(false)
    vault.setCard({ id: c.id, nickname: 'Work', cvc: '123', expMonth: 12, expYear: 2032, holder: 'Sam' })
    expect(vault.findCard('Work')).toMatchObject({ cvc: '123', number: '4000056655665556' })
    vault.setCard({ id: c.id, nickname: 'Work', clearCvc: true, expMonth: 12, expYear: 2032, holder: 'Sam' })
    expect(vault.findCard('Work')!.cvc).toBe('')
    const [a] = vault.setAddress({ nickname: 'Home', name: 'Sam', line1: '1 Main', city: 'Albany', region: 'NY', postal: '1', country: 'US' })
    expect(a).toMatchObject({ nickname: 'Home', summary: 'Albany, NY, US', line1: '' })
  })

  test('encrypted backup through the facade: export, import into an empty vault, duplicates skipped', async () => {
    const { vault } = makeVault()
    fillVault(vault)
    const { text, count } = await vault.exportBackup('backup password 1')
    expect(count).toBe(5)
    const other = makeVault().vault
    other.core.unlockKeychain('presence')
    expect(await other.importBackup(text, 'backup password 1')).toEqual({ added: 5, skipped: 0 })
    expect(other.credential('acme')?.password).toBe(SECRET.password)
    expect(await other.importBackup(text, 'backup password 1')).toEqual({ added: 0, skipped: 5 })
  })

  test('renaming a login from Settings keeps its saved values', () => {
    const { vault } = makeVault()
    fillVault(vault)
    const id = vault.items().find((i) => i.type === 'login')!.id
    vault.saveItem({ id, type: 'login', name: 'Acme Portal', site: 'https://acme.test' })
    expect(vault.names().map((n) => n.name)).toEqual(['acme-portal'])
    expect(vault.credential('acme-portal')).toMatchObject({ username: 'sam@example.test', password: SECRET.password })
    expect(vault.totpCode('acme-portal')?.code).toMatch(/^\d{6}$/)
    vault.set({ name: 'other', origin: 'https://other.test', username: 'x', password: 'other-password-1' })
    const otherId = vault.items().find((i) => i.name === 'other')!.id
    expect(() => vault.saveItem({ id: otherId, type: 'login', name: 'acme-portal', site: 'https://other.test' })).toThrow(/already saved/)
  })

  test('CSV import from a password manager', () => {
    const csv = 'name,url,username,password,note\n"Acme, Inc",https://acme.test/login,sam,"p""w,1",hello\nno-url,,x,y,\nGitHub,github.com,sam,gh-pass,\n'
    expect(parseCsv(csv)[1]).toEqual(['Acme, Inc', 'https://acme.test/login', 'sam', 'p"w,1', 'hello'])
    expect(loginsFromCsv(csv).skipped).toBe(1)
    const { vault } = makeVault()
    expect(vault.importCsv(csv)).toEqual({ added: 2, skipped: 1 })
    expect(vault.credential('acme-inc')).toMatchObject({ origin: 'https://acme.test', password: 'p"w,1' })
    expect(vault.credential('github')?.origin).toBe('https://github.com')
    expect(() => loginsFromCsv('a,b\n1,2')).toThrow(/url/)
  })
})
