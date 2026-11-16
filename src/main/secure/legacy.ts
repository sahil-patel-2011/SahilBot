// The format before the envelope vault: one Keychain (safeStorage) string per item, with plain indexes
// in settings. Read-only here: migration copies it into the new vault and keeps it as the rollback copy
// until the user removes it (Settings → Privacy & Security → Passwords → Old copies).

import type { AddressEntry } from '@shared/types'
import type { TotpConfig } from '../otp'

export interface LegacySource {
  getSetting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
  secret(name: string): string | undefined
  setSecret(name: string, value: string | null): void
}

export interface LegacyLogin { name: string; origin: string; subdomains?: boolean; username: string; password: string; totp?: TotpConfig }
export interface LegacyCard { id: string; nickname: string; brand: string; last4: string; billing?: string; number: string; cvc: string; expMonth: number; expYear: number; holder: string }
export interface LegacyData {
  logins: LegacyLogin[]
  cards: LegacyCard[]
  addresses: AddressEntry[]
  /** Items listed in an index whose secret couldn't be read (Keychain changed, damaged JSON). */
  unreadable: string[]
  /** Every settings key / secret name the old format uses (for "remove old copies"). */
  keys: { settings: string[]; secrets: string[] }
}

export function readLegacy(src: LegacySource): LegacyData {
  const out: LegacyData = { logins: [], cards: [], addresses: [], unreadable: [], keys: { settings: [], secrets: [] } }
  const parse = <T>(raw: string | undefined): T | undefined => { if (!raw) return undefined; try { return JSON.parse(raw) as T } catch { return undefined } }

  const index = src.getSetting<Array<{ name: string; origin: string; subdomains?: boolean }>>('vault:index') ?? []
  if (index.length) out.keys.settings.push('vault:index')
  for (const e of index) {
    out.keys.secrets.push(`vault:${e.name}`)
    const v = parse<{ username: string; password: string; totp?: TotpConfig }>(src.secret(`vault:${e.name}`))
    if (!v?.password) { out.unreadable.push(`login "${e.name}"`); continue }
    out.logins.push({ name: e.name, origin: e.origin, ...(e.subdomains ? { subdomains: true } : {}), username: v.username ?? '', password: v.password, ...(v.totp ? { totp: v.totp } : {}) })
  }

  const cards = src.getSetting<Array<{ id: string; nickname: string; brand: string; last4: string; billing?: string }>>('vault:cards') ?? []
  if (cards.length) out.keys.settings.push('vault:cards')
  for (const c of cards) {
    out.keys.secrets.push(`card:${c.id}`)
    const s = parse<{ number: string; cvc: string; expMonth: number; expYear: number; holder: string }>(src.secret(`card:${c.id}`))
    if (!s?.number) { out.unreadable.push(`card "${c.nickname}"`); continue }
    out.cards.push({ ...c, number: s.number, cvc: s.cvc ?? '', expMonth: s.expMonth, expYear: s.expYear, holder: s.holder ?? '' })
  }

  const addrs = src.getSetting<Array<{ id: string; nickname: string }>>('vault:addresses') ?? []
  if (addrs.length) out.keys.settings.push('vault:addresses')
  for (const a of addrs) {
    out.keys.secrets.push(`address:${a.id}`)
    const v = parse<AddressEntry>(src.secret(`address:${a.id}`))
    if (!v?.line1 && !v?.name) { out.unreadable.push(`address "${a.nickname}"`); continue }
    out.addresses.push({ ...v, id: a.id, nickname: v.nickname || a.nickname })
  }
  return out
}

export function hasLegacy(src: LegacySource): boolean {
  return ['vault:index', 'vault:cards', 'vault:addresses'].some((k) => (src.getSetting<unknown[]>(k) ?? []).length > 0)
}

/** Deletes the old copies (only after the user asks, and only once every one verified in the new vault). */
export function purgeLegacy(src: LegacySource, keys: LegacyData['keys']): void {
  for (const s of keys.secrets) src.setSecret(s, null)
  for (const k of keys.settings) src.setSetting(k, [])
}

/**
 * Rollback: writes items back in the old format (for going back to a SahilBot version from before the
 * envelope vault). Keychain-only protection, like before; the caller confirms with the user first.
 */
export function writeLegacy(src: LegacySource, data: Pick<LegacyData, 'logins' | 'cards' | 'addresses'>): void {
  for (const l of data.logins) src.setSecret(`vault:${l.name}`, JSON.stringify({ username: l.username, password: l.password, ...(l.totp ? { totp: l.totp } : {}) }))
  src.setSetting('vault:index', data.logins.map((l) => ({ name: l.name, origin: l.origin, ...(l.subdomains ? { subdomains: true } : {}) })))
  for (const c of data.cards) src.setSecret(`card:${c.id}`, JSON.stringify({ number: c.number, cvc: c.cvc, expMonth: c.expMonth, expYear: c.expYear, holder: c.holder }))
  src.setSetting('vault:cards', data.cards.map((c) => ({ id: c.id, nickname: c.nickname, brand: c.brand, last4: c.last4, ...(c.billing ? { billing: c.billing } : {}) })))
  for (const a of data.addresses) src.setSecret(`address:${a.id}`, JSON.stringify(a))
  src.setSetting('vault:addresses', data.addresses.map((a) => ({ id: a.id, nickname: a.nickname })))
}
