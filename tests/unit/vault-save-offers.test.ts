import { describe, expect, test } from 'vitest'
import { findSecrets, maskUsername, redactFound, replacePlaceholder, savedPlaceholder, REDACTED } from '../../src/shared/secret-detect'
import { SaveOffers } from '../../src/main/secure/offers'
import { parseSaveReport, saveListenerScript, SAVE_BINDING } from '../../src/main/browser/save-watch'
import { makeVault, SECRET } from '../fixtures/vault-kit'

// "Save to Vault?": detection (browser forms and chat text), the held values, and the rule that
// nothing is written to the vault without the user's click. Test card numbers only.

const SITE = 'https://acme.test'
const offersFor = (k = makeVault()) => {
  const never: string[] = []
  const offers = new SaveOffers({ vault: k.vault, never: { get: () => never, set: (l) => { never.splice(0, never.length, ...l) } }, now: k.clock.now })
  k.vault.pendingSecrets = () => offers.values()
  return { ...k, offers, never }
}

describe('chat detection', () => {
  test('card numbers need Luhn and a card-like length; grouping is fine', () => {
    const f = findSecrets('my card is 4242 4242 4242 4242 exp 08/31 thanks')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ kind: 'card', value: '4242424242424242', last4: '4242', brand: 'visa', expMonth: 8, expYear: 2031, label: 'Visa ending 4242' })
    expect(findSecrets('5555-5555-5555-4444')[0]).toMatchObject({ kind: 'card', brand: 'mastercard' })
    expect(findSecrets('amex 378282246310005')[0]).toMatchObject({ kind: 'card', brand: 'amex' })
    // Fails Luhn, too short, a phone number, all one digit, a mix of separators.
    expect(findSecrets('4242 4242 4242 4241')).toEqual([])
    expect(findSecrets('order 123456789012')).toEqual([])
    expect(findSecrets('call me at 415-555-0123 or +1 (415) 555 0199')).toEqual([])
    expect(findSecrets('0000000000000000')).toEqual([])
    expect(findSecrets('ids 4242-4242 4242-4242')).toEqual([])
  })

  test('passwords need a cue; "the password is wrong" is not one', () => {
    const f = findSecrets('my github password is Hunter2!x and my username is sam@example.test')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ kind: 'password', value: 'Hunter2!x', site: 'https://github.com', name: 'Github', username: 'sam@example.test' })
    expect(findSecrets('password: "correct horse battery"')[0]).toMatchObject({ kind: 'password', value: 'correct horse battery' })
    expect(findSecrets('pw=s3cret!')[0]?.value).toBe('s3cret!')
    expect(findSecrets('The password for netflix.com is tr0ub4dor')[0]).toMatchObject({ value: 'tr0ub4dor', site: 'https://netflix.com' })
    for (const t of ['the password is wrong', 'my password is too short', 'password: required', 'I forgot my password', 'reset your password is easy', 'pass the salt please']) expect(findSecrets(t), t).toEqual([])
  })

  test('API keys by vendor prefix or by a cue', () => {
    const ant = 'sk-ant-api03-' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(3)
    expect(findSecrets(`use ${ant} please`)[0]).toMatchObject({ kind: 'api_key', value: ant, label: 'Anthropic API key', site: 'https://console.anthropic.com' })
    const gh = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
    expect(findSecrets(gh)[0]).toMatchObject({ kind: 'api_key', label: 'GitHub token' })
    expect(findSecrets('AKIAIOSFODNN7EXAMPLE')[0]).toMatchObject({ label: 'AWS access key' })
    expect(findSecrets('the api key for acme.io is 9f8e7d6c5b4a39281706f5e4d3c2b1a0')[0]).toMatchObject({ kind: 'api_key', value: '9f8e7d6c5b4a39281706f5e4d3c2b1a0', site: 'https://acme.io' })
    // A long word after "token" without digits isn't a key.
    expect(findSecrets('the token is abcdefghijklmnopqrstuvwxyz')).toEqual([])
  })

  test('ID numbers: SSN shape and cues', () => {
    expect(findSecrets('ssn 123-45-6789')[0]).toMatchObject({ kind: 'id_number', idKind: 'ssn', value: '123-45-6789' })
    expect(findSecrets('my passport number is X12345678')[0]).toMatchObject({ kind: 'id_number', idKind: 'passport', value: 'X12345678' })
    // Invalid SSN areas are not SSNs.
    expect(findSecrets('000-12-3456 and 666-12-3456')).toEqual([])
  })

  test('redaction replaces only the values; placeholders can be swapped one at a time', () => {
    const t = 'card 4242424242424242 and password: Hunter2!x ok'
    const f = findSecrets(t)
    const r = redactFound(t, f)
    expect(r).toBe(`card ${REDACTED} and password: ${REDACTED} ok`)
    expect(r).not.toContain('4242424242424242')
    expect(r).not.toContain('Hunter2!x')
    const one = replacePlaceholder(r, 1, savedPlaceholder('github'))
    expect(one).toBe(`card ${REDACTED} and password: [saved to vault: github] ok`)
    expect(replacePlaceholder(one, 0, savedPlaceholder('Visa ending 4242'))).toBe('card [saved to vault: Visa ending 4242] and password: [saved to vault: github] ok')
    expect(maskUsername('sam@example.test')).toBe('sa•••@example.test')
  })
})

describe('chat offers', () => {
  test('a pasted card is redacted, held (masked everywhere), and saved only on the click', async () => {
    const { vault, offers } = offersFor()
    const r = offers.scanChat('pay with 4242 4242 4242 4242 exp 08/31', 't1')
    expect(r.text).toBe(`pay with ${REDACTED} exp 08/31`)
    expect(JSON.stringify(r.offers)).not.toContain('4242424242424242')
    expect(r.offers[0]).toMatchObject({ source: 'chat', kind: 'card', last4: '4242', needs: ['holder'], ordinal: 0 })
    // Held, not saved: masked in anything bound for a model meanwhile.
    expect(vault.cards()).toEqual([])
    expect(vault.redact('page says 4242424242424242')).not.toContain('4242424242424242')
    expect(vault.secretValues()).toContain('4242424242424242')
    // The click.
    await expect(offers.save(r.offers[0].id, {})).rejects.toThrow(/name on card/i)
    const saved = await offers.save(r.offers[0].id, { holder: 'Sam Rivera' })
    expect(saved.name).toBe('Visa ending 4242')
    expect(vault.cards()).toMatchObject([{ last4: '4242', brand: 'visa', hasCvc: false }])
    expect(offers.values()).toEqual([])
    await expect(offers.save(r.offers[0].id, {})).rejects.toThrow(/not kept/)
  })

  test('a password needs a site; dismissing forgets it; nothing saves without save()', async () => {
    const { vault, offers } = offersFor()
    const r = offers.scanChat('password: Hunter2!x', 't1')
    expect(r.offers[0]).toMatchObject({ kind: 'login', needs: ['site'] })
    await expect(offers.save(r.offers[0].id, {})).rejects.toThrow(/site/)
    expect(vault.list()).toEqual([])
    const r2 = offers.scanChat('password: Other9!pass')
    offers.dismiss(r2.offers[0].id)
    expect(offers.alive(r2.offers[0].id)).toBe(false)
    expect(offers.values()).not.toContain('Other9!pass')
    const s = await offers.save(r.offers[0].id, { site: 'forum.example.com', name: 'Forum', username: 'samuel' })
    expect(s.name).toBe('forum')
    expect(vault.list()).toMatchObject([{ name: 'forum', origin: 'https://forum.example.com', username: 'sa•••' }])
    expect(vault.credential('forum')?.password).toBe('Hunter2!x')
  })

  test('held values expire', () => {
    const { offers, clock } = offersFor()
    const r = offers.scanChat('ssn 123-45-6789')
    expect(offers.alive(r.offers[0].id)).toBe(true)
    clock.advance(2 * 60 * 60_000)
    expect(offers.alive(r.offers[0].id)).toBe(false)
    expect(offers.values()).toEqual([])
  })
})

describe('browser offers', () => {
  test('a sign-in: offer with a masked username; Save stores it; the same sign-in again offers nothing', async () => {
    const { vault, offers } = offersFor()
    const o = offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'sam@example.test', password: SECRET.password })!
    expect(o).toMatchObject({ source: 'browser', kind: 'login', site: 'acme.test', origin: SITE, username: 'sa•••@example.test', title: 'Save login for acme.test to Vault?' })
    expect(JSON.stringify(o)).not.toContain(SECRET.password)
    expect(JSON.stringify(o)).not.toContain('sam@example.test')
    expect(offers.browserOffer()?.id).toBe(o.id)
    expect(vault.list()).toEqual([])
    const s = await offers.save(o.id)
    expect(s.name).toBe('acme.test')
    expect(vault.credential('acme.test')).toMatchObject({ origin: SITE, username: 'sam@example.test', password: SECRET.password })
    expect(offers.browserOffer()).toBeNull()
    expect(offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'sam@example.test', password: SECRET.password })).toBeNull()
  })

  test('a different password for a saved account: "Update saved password?"', async () => {
    const { vault, offers } = offersFor()
    vault.set({ name: 'acme', origin: SITE, username: 'sam@example.test', password: SECRET.password })
    const o = offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'sam@example.test', password: 'a new password 2' })!
    expect(o).toMatchObject({ update: true, updates: 'acme', title: 'Update saved password for acme.test?' })
    await offers.save(o.id)
    expect(vault.list()).toHaveLength(1)
    expect(vault.credential('acme')?.password).toBe('a new password 2')
    // A change-password form (current + new): the new one is offered as the update.
    const c = offers.fromBrowser({ kind: 'login', url: `${SITE}/account`, username: '', password: 'a new password 2', newPassword: 'newer password 3' })!
    expect(c.update).toBe(true)
    await offers.save(c.id)
    expect(vault.credential('acme')?.password).toBe('newer password 3')
    // Another account on the same site: a new entry.
    const other = offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'kim@example.test', password: 'kims password 1' })!
    expect(other.update).toBeUndefined()
    expect((await offers.save(other.id)).name).toBe('acme.test')
  })

  test('Never for this site; Not now; insecure pages are never offered', () => {
    const { offers, never } = offersFor()
    expect(offers.fromBrowser({ kind: 'login', url: 'http://shop.example.com/login', username: 'a', password: 'pw123456' })).toBeNull()
    expect(offers.fromBrowser({ kind: 'login', url: 'http://127.0.0.1:8080/login', username: 'a', password: 'pw123456' })).not.toBeNull()
    const o = offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'a', password: 'pw123456' })!
    offers.never(o.id)
    expect(never).toEqual([SITE])
    expect(offers.browserOffer()).toBeNull()
    expect(offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'a', password: 'pw123456' })).toBeNull()
    const p = offers.fromBrowser({ kind: 'login', url: 'https://other.test/login', username: 'a', password: 'pw123456' })!
    offers.dismiss(p.id)
    expect(offers.browserOffer()).toBeNull()
    expect(offers.values()).toEqual([])
    offers.removeNever(SITE)
    expect(offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'a', password: 'pw123456' })).not.toBeNull()
  })

  test('a checkout card: "Save card ending 4242?"; the security code is kept only when ticked', async () => {
    const { vault, offers } = offersFor()
    const o = offers.fromBrowser({ kind: 'card', url: `${SITE}/checkout`, number: '4242424242424242', expMonth: 8, expYear: 31, holder: 'Sam Rivera', cvc: '864' })!
    expect(o).toMatchObject({ kind: 'card', title: 'Save card ending 4242 to Vault?', last4: '4242', brand: 'visa', expMonth: 8, expYear: 2031, hasCvc: true })
    expect(JSON.stringify(o)).not.toContain('4242424242424242')
    expect(JSON.stringify(o)).not.toContain('864')
    await offers.save(o.id)
    expect(vault.cards()).toMatchObject([{ last4: '4242', hasCvc: false, expMonth: 8, expYear: 2031 }])
    // Already saved: not offered again. Another card, with the box ticked: the code is kept.
    expect(offers.fromBrowser({ kind: 'card', url: `${SITE}/checkout`, number: '4242424242424242', expMonth: 8, expYear: 31, holder: 'Sam Rivera' })).toBeNull()
    const m = offers.fromBrowser({ kind: 'card', url: `${SITE}/checkout`, number: '5555555555554444', expMonth: 1, expYear: 2032, holder: 'Sam Rivera', cvc: '123' })!
    await offers.save(m.id, { rememberCvc: true })
    expect(vault.cards().find((c) => c.last4 === '4444')?.hasCvc).toBe(true)
    // An invalid number is never offered.
    expect(offers.fromBrowser({ kind: 'card', url: `${SITE}/checkout`, number: '4242424242424241' })).toBeNull()
  })

  test('a locked vault (master password) asks first; cancelling saves nothing', async () => {
    const k = makeVault()
    k.vault.core.unlockKeychain('presence')
    await k.vault.core.setMasterPassword(SECRET.master)
    k.vault.lock('test')
    const { vault, offers, ui } = offersFor(k)
    const o = offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'sam@example.test', password: SECRET.password })!
    ui.answers.push({ cancel: true })
    await expect(offers.save(o.id)).rejects.toThrow(/locked/i)
    expect(ui.shown).toHaveLength(1)
    expect(vault.list()).toEqual([])
    ui.answers.push({ password: SECRET.master })
    await offers.save(o.id)
    expect(vault.isUnlocked()).toBe(true)
    expect(vault.list()).toMatchObject([{ name: 'acme.test', origin: SITE }])
  })

  test('locked: a sign-in for an account already saved there is not asked about (it cannot be compared)', async () => {
    const k = makeVault()
    k.vault.set({ name: 'acme', origin: SITE, username: 'sam@example.test', password: SECRET.password })
    k.vault.core.unlockKeychain('presence')
    await k.vault.core.setMasterPassword(SECRET.master)
    k.vault.lock('test')
    const { offers } = offersFor(k)
    expect(offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'sam@example.test', password: SECRET.password })).toBeNull()
    expect(offers.fromBrowser({ kind: 'login', url: `${SITE}/login`, username: 'kim@example.test', password: 'kims pw 22' })).not.toBeNull()
  })
})

describe('the page listener and its reports', () => {
  const token = 'tok-1'
  test('reports are checked: token, secure page, same site as the tab', () => {
    const ok = JSON.stringify({ t: token, kind: 'login', url: `${SITE}/login`, username: 'sam', password: 'pw123456' })
    expect(parseSaveReport(ok, token, `${SITE}/home`)).toMatchObject({ kind: 'login', username: 'sam', password: 'pw123456' })
    expect(parseSaveReport(ok, 'other', `${SITE}/home`)).toBeNull()
    expect(parseSaveReport(ok, token, 'https://elsewhere.test/')).toBeNull()
    expect(parseSaveReport(JSON.stringify({ t: token, kind: 'login', url: 'http://acme.test/login', password: 'pw123456' }), token, 'http://acme.test/')).toBeNull()
    expect(parseSaveReport(JSON.stringify({ t: token, kind: 'card', url: `${SITE}/c`, number: '4242 4242 4242 4242', expMonth: 8, expYear: 31, cvc: '864' }), token, SITE)).toMatchObject({ number: '4242424242424242', expMonth: 8, expYear: 31, cvc: '864' })
    expect(parseSaveReport('not json', token, SITE)).toBeNull()
  })

  test('the listener only reads fields after a real (trusted) input and only calls its own binding', () => {
    const src = saveListenerScript(token)
    expect(src).toContain(SAVE_BINDING)
    expect(src).toContain('isTrusted')
    expect(() => new Function(src)).not.toThrow()
  })
})
