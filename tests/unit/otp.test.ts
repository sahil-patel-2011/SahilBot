import { describe, expect, test } from 'vitest'
import { base32Decode, brandOf, extractCode, parseTotp, pickCode, totp, totpRaw } from '../../src/main/otp'

describe('TOTP (RFC 6238 test vectors)', () => {
  const k1 = Buffer.from('12345678901234567890')
  const k256 = Buffer.from('12345678901234567890123456789012')
  const k512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234')
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826']
  ]
  test.each(vectors)('t=%i', (t, sha1, sha256, sha512) => {
    expect(totpRaw(k1, t, 8, 30, 'SHA1')).toBe(sha1)
    expect(totpRaw(k256, t, 8, 30, 'SHA256')).toBe(sha256)
    expect(totpRaw(k512, t, 8, 30, 'SHA512')).toBe(sha512)
  })
  test('base32 keys and otpauth links', () => {
    expect(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString()).toBe('12345678901234567890')
    const c = parseTotp('otpauth://totp/ACME%20Co:sam@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=ACME%20Co&algorithm=SHA1&digits=8&period=30')
    expect(c).toMatchObject({ digits: 8, period: 30, algorithm: 'SHA1', issuer: 'ACME Co', account: 'sam@example.com' })
    expect(totp(c, 59_000).code).toBe('94287082')
    expect(parseTotp('gezd gnbv gy3t qojq').digits).toBe(6)
    expect(() => parseTotp('not a key!')).toThrow(/base32/)
    expect(() => parseTotp('otpauth://hotp/x?secret=GEZDGNBV&counter=1')).toThrow(/TOTP/)
  })
})

describe('codes in emails and texts', () => {
  test('finds the code, not dates, prices or phone numbers', () => {
    expect(extractCode('Your Acme verification code is 482913. It expires in 10 minutes.')).toBe('482913')
    expect(extractCode('G-551234 is your Google verification code.')).toBe('551234')
    expect(extractCode('Use 7731 to sign in to Shop. Order total $1234.')).toBe('7731')
    expect(extractCode('Your code: 123 456')).toBe('123456')
    expect(extractCode('Meeting on 2026-11-13, call 555-123-4567')).toBeNull()
    expect(extractCode('Your order of $129.99 has shipped')).toBeNull()
  })
  test('picks the message for this site', () => {
    const now = Date.now()
    const msgs = [
      { from: '+15550001', text: 'Your Other verification code is 111111', at: now - 1000 },
      { from: 'no-reply@acme.test', text: 'Acme sign-in code: 222222', at: now - 2000 },
      { from: '+15550002', text: 'Your Acme code is 333333', at: now - 20 * 60_000 }
    ]
    expect(pickCode(msgs, 'login.acme.test', now - 10 * 60_000)).toMatchObject({ code: '222222', from: 'no-reply@acme.test', matched: 'domain' })
    // A lone code from an unknown sender is never used on its own (it goes to the user's card instead).
    expect(pickCode(msgs.slice(0, 1), 'shop.example.com', now - 600_000)).toBeNull()
    expect(pickCode([...msgs.slice(0, 1), { from: 'x', text: 'code 999999', at: now }], 'shop.example.com', now - 600_000)).toBeNull()
    // …unless the user confirmed that sender for the site.
    expect(pickCode(msgs.slice(0, 1), 'shop.example.com', now - 600_000, ['+1 555 0001'])).toMatchObject({ code: '111111', matched: 'mapping' })
    expect(brandOf('www.shop.example.co.uk')).toBe('example')
  })
})
