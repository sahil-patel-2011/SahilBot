import { describe, expect, test, vi } from 'vitest'
import { REVEAL_CHANNELS, vaultHandlers, type VaultFiles } from '../../src/main/secure/ipc'
import { containsAny } from '../../src/main/secure/redact'
import { fillVault, makeVault, SECRET } from '../fixtures/vault-kit'

const KNOWN = [SECRET.password, SECRET.card, '4242 4242 4242 4242', SECRET.cvc, SECRET.id, SECRET.totp, SECRET.note, SECRET.master, 'csv-secret-pw-1', 'backup password 1', 'sam@example.test', '1 Main St']

function setup() {
  const k = makeVault()
  fillVault(k.vault)
  const disk = new Map<string, string>()
  const files: VaultFiles = {
    saveBackup: async () => '/backups/vault.sbvault',
    openBackup: async () => '/backups/vault.sbvault',
    openCsv: async () => '/downloads/passwords.csv',
    write: (p, t) => void disk.set(p, t),
    read: (p) => disk.get(p) ?? ''
  }
  disk.set('/downloads/passwords.csv', 'name,url,username,password\nForum,https://forum.test,sam,csv-secret-pw-1\n')
  const protect = vi.fn()
  const handlers = vaultHandlers({
    vault: k.vault, auth: k.vault.auth!, files, protect,
    purchases: { permanent: () => ['https://acme.test'], revokeOtp: () => [] },
    touchIdAvailable: () => false, keychainAvailable: () => true
  })
  return { ...k, handlers, disk, protect }
}

describe('vault IPC replies never carry a value', () => {
  test('every handler (but the two Reveal ones) is called with a known secret saved; no reply or error contains it', async () => {
    const { handlers, vault, ui, disk } = setup()
    const calls: Array<[string, unknown[]]> = [
      ['vault:status', []], ['vault:list', []], ['vault:cards', []], ['vault:addresses', []], ['vault:items', []], ['vault:otpGrants', []], ['vault:audit', [500]], ['vault:authPending', []],
      ['vault:set', [{ name: 'acme', origin: 'https://acme.test', username: 'sam@example.test', password: SECRET.password }]],
      ['vault:setCard', [{ id: vault.cards()[0].id, nickname: 'Personal', expMonth: 8, expYear: 2031, holder: 'Sam Rivera' }]],
      ['vault:setAddress', [{ nickname: 'Work', name: 'Sam Rivera', line1: '1 Main St', city: 'Albany', postal: '12207', country: 'US' }]],
      ['vault:saveItem', [{ type: 'identity', name: 'License', kind: 'driver_license', number: SECRET.id }]],
      ['vault:saveItem', [{ type: 'note', name: 'Recovery 2', body: SECRET.note }]],
      ['vault:setPrefs', [{ autoLockMinutes: 5 }]],
      ['vault:lock', []], ['vault:unlock', []],
      ['vault:exportBackup', ['backup password 1']],
      ['vault:importBackup', ['backup password 1']],
      ['vault:importCsv', []],
      ['vault:setMasterPassword', [SECRET.master]],
      ['vault:setTouchIdUnlock', [false]],
      ['vault:resign', []],
      ['vault:rollback', []],
      ['vault:purgeLegacy', []],
      ['vault:removeMasterPassword', [SECRET.master]],
      ['vault:revokeOtpGrant', ['https://acme.test']],
      ['vault:remove', ['nope']], ['vault:removeCard', ['nope']], ['vault:removeAddress', ['nope']], ['vault:removeItem', ['nope']],
      ['vault:authRespond', ['nope', { password: SECRET.master }]]
    ]
    const out: string[] = []
    for (const [ch, args] of calls) {
      // Settings changes that loosen protection or touch backups ask: the user confirms with the password.
      ui.answers.push({ password: SECRET.master })
      try { out.push(`${ch} => ${JSON.stringify(await handlers[ch]({}, ...args))}`) } catch (e) { out.push(`${ch} !! ${(e as Error).message}`) }
    }
    const called = new Set(calls.map((c) => c[0]))
    for (const ch of Object.keys(handlers)) if (!REVEAL_CHANNELS.has(ch)) expect(called.has(ch), `${ch} not exercised`).toBe(true)
    const all = out.join("\n")
    for (const v of KNOWN) expect(containsAny(all, [v]), `${v} leaked:\n${all}`).toBe(false)
    // Sanity: the calls did something (an export was written, encrypted).
    expect(all).toMatch(/vault:exportBackup => \{"ok":true/)
    expect(containsAny(disk.get('/backups/vault.sbvault')!, KNOWN)).toBe(false)
    expect(all).toMatch(/vault:importCsv => \{"ok":true,"added":1/)
    // The audit log has the events, without values.
    const audit = JSON.stringify(vault.auditEntries(500))
    expect(audit).toMatch(/"event":"export"/)
    expect(containsAny(audit, KNOWN)).toBe(false)
  })

  test('reveal needs the master password (when set), protects the window, and is the only way values reach Settings', async () => {
    const { handlers, vault, ui, protect } = setup()
    await vault.core.setMasterPassword(SECRET.master)
    vault.auth!.forget()
    const id = vault.items().find((i) => i.type === 'login')!.id
    ui.answers.push({ cancel: true })
    await expect(handlers['vault:reveal']({}, id)).rejects.toThrow(/didn't confirm/)
    expect(protect).not.toHaveBeenCalled()
    ui.answers.push({ password: 'not it at all!' }, { password: SECRET.master })
    const r = await handlers['vault:reveal']('sender', id) as { fields: Array<{ key: string; value: string }>; hideAfterMs: number }
    expect(r.fields.find((f) => f.key === 'password')?.value).toBe(SECRET.password)
    expect(r.hideAfterMs).toBe(20_000)
    expect(protect).toHaveBeenCalledWith('sender', 25_000)
    expect(vault.auditEntries()[0]).toMatchObject({ event: 'reveal', item: 'acme' })
  })

  test('an edit that keeps saved values, made while locked, asks to unlock and then saves', async () => {
    const { handlers, vault, ui } = setup()
    await vault.core.setMasterPassword(SECRET.master)
    vault.lock()
    const id = vault.items().find((i) => i.type === 'login')!.id
    ui.answers.push({ password: SECRET.master })
    const out = await handlers['vault:saveItem']({}, { id, type: 'login', name: 'acme', site: 'https://acme.test', username: 'new-user@example.test' })
    expect(ui.shown.at(-1)).toMatchObject({ kind: 'unlock', reason: 'save your changes' })
    expect(JSON.stringify(out)).not.toContain(SECRET.password)
    expect(vault.credential('acme')).toMatchObject({ username: 'new-user@example.test', password: SECRET.password })
  })

  test('loosening a protection asks first', async () => {
    const { handlers, vault, ui } = setup()
    await vault.core.setMasterPassword(SECRET.master)
    vault.auth!.forget()
    ui.answers.push({ cancel: true })
    await expect(handlers['vault:setPrefs']({}, { autoLockMinutes: 0 })).rejects.toThrow()
    expect(vault.prefs().autoLockMinutes).toBe(15)
    // Tightening doesn't.
    await handlers['vault:setPrefs']({}, { autoLockMinutes: 5 })
    expect(vault.prefs().autoLockMinutes).toBe(5)
  })
})
