// Payment-card helpers shared by Settings (validation while typing) and main (validation on save).
// Pure functions: no card number is ever stored or logged here.

export type CardBrand = 'visa' | 'mastercard' | 'amex' | 'discover' | 'jcb' | 'diners' | 'unionpay' | 'card'

export const BRAND_NAME: Record<CardBrand, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'Amex', discover: 'Discover', jcb: 'JCB', diners: 'Diners Club', unionpay: 'UnionPay', card: 'Card'
}

export const digitsOnly = (s: string): string => String(s ?? '').replace(/\D+/g, '')

/** Luhn checksum (every card number passes it). */
export function luhn(number: string): boolean {
  const d = digitsOnly(number)
  if (d.length < 12 || d.length > 19) return false
  let sum = 0
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i])
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9 }
    sum += n
  }
  return sum % 10 === 0
}

export function cardBrand(number: string): CardBrand {
  const d = digitsOnly(number)
  if (/^4/.test(d)) return 'visa'
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(d)) return 'mastercard'
  if (/^3[47]/.test(d)) return 'amex'
  if (/^(6011|65|64[4-9])/.test(d)) return 'discover'
  if (/^35(2[89]|[3-8]\d)/.test(d)) return 'jcb'
  if (/^(36|38|30[0-5])/.test(d)) return 'diners'
  if (/^62/.test(d)) return 'unionpay'
  return 'card'
}

/** "4242 4242 4242 4242", Amex as "3782 822463 10005". */
export function formatCardNumber(number: string): string {
  const d = digitsOnly(number).slice(0, 19)
  if (cardBrand(d) === 'amex') return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(' ')
  return d.replace(/(\d{4})(?=\d)/g, '$1 ')
}

/** Two-digit month and four-digit year, or null when it isn't a real future (or current) month. */
export function normalizeExpiry(month: string | number, year: string | number, now = new Date()): { month: number; year: number } | null {
  const m = Number(String(month).trim())
  let y = Number(String(year).trim())
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y)) return null
  if (y < 100) y += 2000
  if (y < 2000 || y > 2100) return null
  const cur = now.getFullYear() * 12 + now.getMonth()
  if (y * 12 + (m - 1) < cur) return null
  return { month: m, year: y }
}

/** Why a card can't be saved, or null. CVV is optional (some people never store it). */
export function cardProblem(c: { number: string; month: string | number; year: string | number; cvc?: string }, now = new Date()): string | null {
  const d = digitsOnly(c.number)
  if (d.length < 12 || d.length > 19) return 'The card number should be 12 to 19 digits.'
  if (!luhn(d)) return "That card number doesn't look right. Check the digits."
  if (!normalizeExpiry(c.month, c.year, now)) return 'The expiry date is not valid or has passed.'
  const cvc = digitsOnly(c.cvc ?? '')
  if (c.cvc && c.cvc.trim() && !(cardBrand(d) === 'amex' ? /^\d{4}$/ : /^\d{3}$/).test(cvc)) return cardBrand(d) === 'amex' ? 'Amex security codes are 4 digits.' : 'The security code (CVV) is 3 digits.'
  return null
}

/** "Personal (Visa ending 4242)": how cards are named to the model and on approval cards. */
export function cardLabel(c: { nickname: string; brand: CardBrand | string; last4: string }): string {
  const brand = BRAND_NAME[c.brand as CardBrand] ?? 'Card'
  const nick = c.nickname.trim()
  const base = `${brand} ending ${c.last4}`
  return nick && nick.toLowerCase() !== base.toLowerCase() ? `${nick} (${base})` : base
}
