import { randomUUID } from 'node:crypto'
import type { AddressEntry, CardEntry, CardInput, VaultEntry } from '@shared/types'
import { cardBrand, cardLabel, cardProblem, digitsOnly, formatCardNumber, normalizeExpiry } from '@shared/cards'
import type { Db } from './db'
import { parseTotp, totp, type TotpConfig } from './otp'
import { isPublicSuffix, registrableDomain } from './psl'
import type { Secrets } from './secrets'

/**
 * Saved logins. Names and sites are listed in plain settings so the UI and the model
 * can refer to them; usernames and passwords are Keychain-encrypted and only ever
 * leave this class to be typed into a matching field by the browser.
 */
export class Vault {
  constructor(private db: Db, private secrets: Secrets) {}

  private index(): Array<{ name: string; origin: string; subdomains?: boolean }> {
    return this.db.getSetting<Array<{ name: string; origin: string; subdomains?: boolean }>>('vault:index') ?? []
  }

  list(): VaultEntry[] {
    return this.index().map((e) => {
      const v = this.read(e.name)
      return { ...e, username: v?.username ?? '', hasTotp: !!v?.totp, ...(v?.totp?.issuer ? { totpIssuer: v.totp.issuer } : {}) }
    })
  }

  names(): Array<{ name: string; origin: string; subdomains?: boolean }> {
    return this.index()
  }

  /** Whether a saved login may be typed on this page (exact origin, or its subdomains when opted in). */
  matches(name: string, pageUrl: string): boolean {
    const e = this.index().find((x) => x.name === name)
    return !!e && originMatches(e.origin, pageUrl, { subdomains: !!e.subdomains })
  }

  private read(name: string): { username: string; password: string; totp?: TotpConfig } | undefined {
    const raw = this.secrets.get(`vault:${name}`)
    return raw ? (JSON.parse(raw) as { username: string; password: string; totp?: TotpConfig }) : undefined
  }

  /**
   * Saves a login. `totp` is an authenticator setup key or otpauth:// link (left out = keep the saved
   * one, clearTotp = remove it); it is stored in the same Keychain secret as the password.
   */
  set(e: VaultEntry & { password?: string; totp?: string; clearTotp?: boolean }): void {
    const name = e.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    if (!name) throw new Error('Name is required')
    const origin = normalizeOrigin(e.origin)
    const prev = this.read(name)
    const password = e.password || prev?.password
    if (!password) throw new Error('Password is required')
    const key = e.clearTotp ? undefined : e.totp && e.totp.trim() ? parseTotp(e.totp) : prev?.totp
    this.secrets.set(`vault:${name}`, JSON.stringify({ username: e.username, password, ...(key ? { totp: key } : {}) }))
    // Subdomain matching is opt-in per login (and never across a public suffix such as github.io).
    const prevEntry = this.index().find((x) => x.name === name)
    const subdomains = e.subdomains ?? prevEntry?.subdomains
    this.db.setSetting('vault:index', [...this.index().filter((x) => x.name !== name), { name, origin, ...(subdomains && !isPublicSuffix(new URL(origin).hostname) ? { subdomains: true } : {}) }])
  }

  remove(name: string): void {
    this.secrets.set(`vault:${name}`, null)
    this.db.setSetting('vault:index', this.index().filter((x) => x.name !== name))
  }

  /** Only for typing into a verified field. */
  credential(name: string): { origin: string; subdomains?: boolean; username: string; password: string } | undefined {
    const idx = this.index().find((x) => x.name === name)
    const v = this.read(name)
    return idx && v ? { origin: idx.origin, ...(idx.subdomains ? { subdomains: true } : {}), username: v.username, password: v.password } : undefined
  }

  /** Used by the leak check that blocks any tool call containing a saved password. */
  passwords(): string[] {
    return this.index().map((e) => this.read(e.name)?.password).filter((p): p is string => !!p)
  }

  /** The current authenticator code for a login (typed into a verified field, or shown on Reveal in Settings). */
  totpCode(name: string, now = Date.now()): { code: string; remaining: number; origin: string } | null {
    const idx = this.index().find((x) => x.name === name)
    const v = this.read(name)
    if (!idx || !v?.totp) return null
    return { ...totp(v.totp, now), origin: idx.origin }
  }

  /** Authenticator keys (never sent anywhere): part of the leak check. */
  private totpSecrets(): string[] {
    return this.index().map((e) => this.read(e.name)?.totp?.secret).filter((x): x is string => !!x && x.length >= 8)
  }

  // ------------------------------------------------------------- payment cards
  // The plain index holds only what is safe to list (nickname, brand, last 4, billing address id).
  // Number, CVV, expiry and cardholder name are one Keychain-encrypted secret per card.

  private cardIndex(): CardMeta[] {
    return this.db.getSetting<CardMeta[]>('vault:cards') ?? []
  }

  private cardSecret(id: string): CardSecret | undefined {
    const cached = this.cache.get(id)
    if (cached) return cached
    const raw = this.secrets.get(`card:${id}`)
    if (!raw) return undefined
    try {
      const v = JSON.parse(raw) as CardSecret
      this.cache.set(id, v)
      return v
    } catch {
      return undefined
    }
  }

  /** Decrypted cards kept in memory only, so the browser's card guard doesn't hit the Keychain per request. */
  private cache = new Map<string, CardSecret>()

  cards(): CardEntry[] {
    return this.cardIndex().map((c) => {
      const s = this.cardSecret(c.id)
      return { id: c.id, nickname: c.nickname, brand: c.brand, last4: c.last4, billing: c.billing, expMonth: s?.expMonth ?? 0, expYear: s?.expYear ?? 0, holder: s?.holder ?? '', hasCvc: !!s?.cvc }
    })
  }

  setCard(c: CardInput): CardEntry[] {
    const nickname = String(c.nickname ?? '').trim().slice(0, 60)
    const prevMeta = c.id ? this.cardIndex().find((x) => x.id === c.id) : undefined
    if (c.id && !prevMeta) throw new Error('That card is no longer saved.')
    const prev = prevMeta ? this.cardSecret(prevMeta.id) : undefined
    const number = digitsOnly(c.number ?? '') || prev?.number || ''
    const cvc = c.cvc !== undefined && c.cvc !== '' ? digitsOnly(c.cvc) : prev?.cvc ?? ''
    const problem = cardProblem({ number, month: c.expMonth, year: c.expYear, cvc })
    if (problem) throw new Error(problem)
    const exp = normalizeExpiry(c.expMonth, c.expYear)!
    const holder = String(c.holder ?? '').trim().slice(0, 80)
    if (!holder) throw new Error('Name on card is required.')
    const brand = cardBrand(number)
    const last4 = number.slice(-4)
    const id = prevMeta?.id ?? randomUUID()
    const billing = c.billing && this.addressIndex().some((a) => a.id === c.billing) ? c.billing : undefined
    const meta: CardMeta = { id, nickname: nickname || cardLabel({ nickname: '', brand, last4 }), brand, last4, billing }
    const others = this.cardIndex().filter((x) => x.id !== id)
    if (others.some((x) => x.nickname.toLowerCase() === meta.nickname.toLowerCase())) throw new Error(`A card named "${meta.nickname}" is already saved.`)
    const secret: CardSecret = { number, cvc, expMonth: exp.month, expYear: exp.year, holder }
    this.secrets.set(`card:${id}`, JSON.stringify(secret))
    this.cache.set(id, secret)
    this.db.setSetting('vault:cards', [...others, meta])
    return this.cards()
  }

  removeCard(id: string): CardEntry[] {
    this.secrets.set(`card:${id}`, null)
    this.cache.delete(id)
    this.db.setSetting('vault:cards', this.cardIndex().filter((x) => x.id !== id))
    return this.cards()
  }

  /** What the model may know about saved cards: nickname, brand, last 4. */
  cardNames(): Array<{ id: string; label: string; nickname: string }> {
    return this.cardIndex().map((c) => ({ id: c.id, nickname: c.nickname, label: cardLabel(c) }))
  }

  /**
   * Finds a card by what the model calls it: its nickname, its id, or "Visa ending 4242" (last 4 digits).
   * Only for filling a verified payment form (and the approval card's label).
   */
  findCard(ref: string): (CardSecret & { id: string; label: string; brand: string; last4: string; billing?: string }) | undefined {
    const q = String(ref ?? '').trim().toLowerCase()
    if (!q) return undefined
    const idx = this.cardIndex()
    const last4 = /(?:ending|ends? in|•+|\*+|x+)\s*(\d{4})/i.exec(ref)?.[1] ?? (/^\d{4}$/.test(q) ? q : undefined)
    const hit = idx.find((c) => c.id === ref || c.nickname.toLowerCase() === q || cardLabel(c).toLowerCase() === q) ??
      (last4 ? (idx.filter((c) => c.last4 === last4).length === 1 ? idx.find((c) => c.last4 === last4) : undefined) : undefined) ??
      (idx.filter((c) => c.nickname.toLowerCase().includes(q)).length === 1 ? idx.find((c) => c.nickname.toLowerCase().includes(q)) : undefined)
    const s = hit ? this.cardSecret(hit.id) : undefined
    return hit && s ? { ...s, id: hit.id, label: cardLabel(hit), brand: hit.brand, last4: hit.last4, billing: hit.billing } : undefined
  }

  /** Full numbers of every saved card (digits only): for the leak check, redaction and the browser's card guard. */
  cardNumbers(): string[] {
    return this.cardIndex().map((c) => this.cardSecret(c.id)?.number).filter((n): n is string => !!n && n.length >= 12)
  }

  /**
   * Everything a tool call must never carry: saved passwords, and saved card numbers in the ways they
   * are usually written (digits only, grouped with spaces, grouped with dashes).
   */
  secretValues(): string[] {
    const out = [...this.passwords(), ...this.totpSecrets()]
    for (const n of this.cardNumbers()) {
      const spaced = formatCardNumber(n)
      out.push(n, spaced, spaced.replace(/ /g, '-'))
    }
    return out
  }

  // ------------------------------------------------------------- addresses

  private addressIndex(): Array<{ id: string; nickname: string }> {
    return this.db.getSetting<Array<{ id: string; nickname: string }>>('vault:addresses') ?? []
  }

  private readAddress(id: string): AddressEntry | undefined {
    const raw = this.secrets.get(`address:${id}`)
    if (!raw) return undefined
    try { return { ...(JSON.parse(raw) as AddressEntry), id } } catch { return undefined }
  }

  addresses(): AddressEntry[] {
    return this.addressIndex().map((a) => this.readAddress(a.id) ?? { id: a.id, nickname: a.nickname, name: '', line1: '', city: '', postal: '', country: '' })
  }

  setAddress(a: Omit<AddressEntry, 'id'> & { id?: string }): AddressEntry[] {
    const clean = (v: unknown, n = 120): string => String(v ?? '').replace(/[ -]/g, ' ').trim().slice(0, n)
    const e: AddressEntry = {
      id: a.id && this.addressIndex().some((x) => x.id === a.id) ? a.id : randomUUID(),
      nickname: clean(a.nickname, 60), name: clean(a.name), line1: clean(a.line1), line2: clean(a.line2) || undefined,
      city: clean(a.city, 80), region: clean(a.region, 80) || undefined, postal: clean(a.postal, 20), country: clean(a.country, 60),
      phone: clean(a.phone, 40) || undefined, email: clean(a.email, 120) || undefined
    }
    if (!e.nickname) throw new Error('Give the address a nickname (e.g. Home).')
    if (!e.name || !e.line1 || !e.city || !e.country) throw new Error('Name, street, city and country are required.')
    const others = this.addressIndex().filter((x) => x.id !== e.id)
    if (others.some((x) => x.nickname.toLowerCase() === e.nickname.toLowerCase())) throw new Error(`An address named "${e.nickname}" is already saved.`)
    this.secrets.set(`address:${e.id}`, JSON.stringify(e))
    this.db.setSetting('vault:addresses', [...others, { id: e.id, nickname: e.nickname }])
    return this.addresses()
  }

  removeAddress(id: string): AddressEntry[] {
    this.secrets.set(`address:${id}`, null)
    this.db.setSetting('vault:addresses', this.addressIndex().filter((x) => x.id !== id))
    // A card billed to it keeps working; it just has no billing address any more.
    const cards = this.cardIndex()
    if (cards.some((c) => c.billing === id)) this.db.setSetting('vault:cards', cards.map((c) => (c.billing === id ? { ...c, billing: undefined } : c)))
    return this.addresses()
  }

  addressNames(): string[] {
    return this.addressIndex().map((a) => a.nickname)
  }

  /** By nickname (case-insensitive) or id. Only for filling a form the user approved. */
  findAddress(ref: string): AddressEntry | undefined {
    const q = String(ref ?? '').trim().toLowerCase()
    const hit = this.addressIndex().find((a) => a.id === ref || a.nickname.toLowerCase() === q)
    return hit ? this.readAddress(hit.id) : undefined
  }
}

interface CardMeta { id: string; nickname: string; brand: string; last4: string; billing?: string }
interface CardSecret { number: string; cvc: string; expMonth: number; expYear: number; holder: string }

export function normalizeOrigin(s: string): string {
  const t = s.trim()
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).origin
  } catch {
    throw new Error(`"${s}" is not a valid site`)
  }
}

/**
 * Whether a saved login's site matches a page. Exact origin (scheme, host and port) by default. With
 * `subdomains` (opted into per login), a page on a subdomain of the saved host also matches
 * (login.example.com for example.com), but never across a public suffix: a login saved for github.io
 * or vercel.app never matches someone's alice.github.io, and the page must share the saved host's
 * registrable domain (Public Suffix List).
 */
export function originMatches(saved: string, pageUrl: string, o: { subdomains?: boolean } = {}): boolean {
  try {
    const a = new URL(saved), b = new URL(pageUrl)
    if (!/^https?:$/.test(a.protocol) || a.protocol !== b.protocol) return false
    if (a.port !== b.port) return false
    if (b.hostname === a.hostname) return true
    if (!o.subdomains) return false
    if (!b.hostname.endsWith(`.${a.hostname}`)) return false
    if (isPublicSuffix(a.hostname)) return false
    const reg = registrableDomain(a.hostname)
    return !!reg && reg.includes('.') && registrableDomain(b.hostname) === reg
  } catch {
    return false
  }
}
