import type { AddressEntry, CardEntry, CardInput, VaultEntry, VaultItemInput, VaultItemSummary, VaultItemType, VaultReveal } from '@shared/types'
import { BRAND_NAME, cardBrand, cardLabel, cardProblem, digitsOnly, formatCardNumber, normalizeExpiry, type CardBrand } from '@shared/cards'
import type { Db } from './db'
import { parseTotp, totp, type TotpConfig } from './otp'
import { isPublicSuffix } from './psl'
import { SqliteAuditLog, type AuditEntry, type AuditEvent, type AuditLog } from './secure/audit'
import type { ReauthPurpose, VaultAuth } from './secure/auth'
import { SecureVault, VaultLockedError, type ItemMeta, type ItemSummary, type ItemType, type KeyStore } from './secure/core'
import type { KdfParams } from './secure/crypto'
import { loginsFromCsv } from './secure/csv'
import { hasLegacy, purgeLegacy, readLegacy, writeLegacy, type LegacyData, type LegacySource } from './secure/legacy'
import { normalizeOrigin, originMatches } from './secure/origin'
import { redactSecrets } from './secure/redact'
import { SqliteVaultStorage, type VaultStorage } from './secure/storage'

export { normalizeOrigin, originMatches }
export { VaultLockedError }

/** The Keychain-backed string store (src/main/secrets.ts), or a stand-in in tests. */
export interface SecretStrings {
  get(name: string): string | undefined
  set(name: string, value: string | null): void
  available?(): boolean
}

export interface VaultOptions {
  storage?: VaultStorage
  keys?: KeyStore
  audit?: AuditLog & { scrub?: (s: string) => string }
  now?: () => number
  kdf?: () => Promise<KdfParams & { ms?: number }>
}

interface LoginPayload { username: string; password: string; totp?: TotpConfig; notes?: string }
interface CardPayload { number: string; cvc: string; holder: string }
interface IdentityPayload { number: string; fullName?: string; issuer?: string; country?: string; notes?: string }

const MIGRATION = 'vault2:migration'
interface MigrationState { at: number; ids: Record<string, string>; unreadable: string[]; rolledBack?: boolean; keys?: LegacyData['keys'] }

const slug = (name: string): string => String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
const clip = (v: unknown, n = 120): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)

/** "sa•••@example.test": enough to tell accounts apart in Settings, never the whole username. */
export function usernameHint(u: string): string {
  const s = String(u ?? '').trim()
  if (!s) return ''
  const at = s.indexOf('@')
  if (at > 0) return `${s.slice(0, Math.min(2, at))}•••${s.slice(at)}`
  return s.length <= 3 ? '•••' : `${s.slice(0, 2)}•••`
}

/**
 * Saved logins, cards, IDs, notes and addresses. The values are encrypted in src/main/secure (envelope
 * encryption under a master key held only while unlocked). Names, sites, brand and last 4 are the only
 * things the UI and the model can see; values leave this class only to be typed into a verified field
 * by the browser, or shown to the user on Reveal after Touch ID or the master password.
 */
export class Vault {
  readonly core: SecureVault
  /** Touch ID / master password prompts (set by main once the window exists). */
  auth: VaultAuth | null = null
  /** Values waiting on a "Save to Vault?" card (secure/offers.ts): masked and leak-checked like saved ones. */
  pendingSecrets: () => string[] = () => []
  private readonly legacySrc: LegacySource

  constructor(private db: Db, secrets: SecretStrings, o: VaultOptions = {}) {
    const keys: KeyStore = o.keys ?? { get: (n) => secrets.get(n), set: (n, v) => secrets.set(n, v), available: () => secrets.available?.() ?? true }
    const audit = o.audit ?? new SqliteAuditLog(db, o.now)
    this.core = new SecureVault({ storage: o.storage ?? new SqliteVaultStorage(db), keys, audit, now: o.now, kdf: o.kdf })
    // Nothing a secret could hide in reaches the audit log either.
    ;(audit as { scrub?: (s: string) => string }).scrub = (s) => redactSecrets(s, this.core.guardValues())
    this.legacySrc = {
      getSetting: (k) => db.getSetting(k),
      setSetting: (k, v) => db.setSetting(k, v),
      secret: (n) => secrets.get(n),
      setSecret: (n, v) => secrets.set(n, v)
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Creates the vault the first time and moves the old Keychain-only entries into it. Each copy is
   * decrypted and compared before it counts; nothing old is deleted (it stays as the rollback copy).
   */
  start(): { migrated: number; unreadable: string[] } {
    this.core.init()
    return this.migrate()
  }

  private migration(): MigrationState | undefined {
    return this.db.getSetting<MigrationState>(MIGRATION)
  }

  /** Copies old entries not migrated yet (needs the key: works locked only for a Keychain-only vault). */
  migrate(): { migrated: number; unreadable: string[] } {
    const st = this.migration()
    if (st?.rolledBack || !hasLegacy(this.legacySrc)) return { migrated: 0, unreadable: st?.unreadable ?? [] }
    const old = readLegacy(this.legacySrc)
    const ids = { ...(st?.ids ?? {}) }
    const todo: Array<{ key: string; type: ItemType; meta: ItemMeta; payload: Record<string, unknown>; id?: string }> = []
    for (const l of old.logins) {
      const key = `login:${l.name}`
      if (ids[key] && this.core.list('login').some((x) => x.id === ids[key])) continue
      if (this.loginByName(l.name)) continue
      todo.push({ key, type: 'login', meta: this.loginMeta(l.name, l.origin, l.subdomains, undefined, l.username, l.totp, 'migrated'), payload: { username: l.username, password: l.password, ...(l.totp ? { totp: l.totp } : {}) } })
    }
    for (const a of old.addresses) {
      const key = `address:${a.id}`
      if (ids[key] || this.core.list('address').some((x) => x.id === a.id)) continue
      const { id, ...rest } = a
      todo.push({ key, type: 'address', id, meta: { name: a.nickname, summary: addressSummary(a), source: 'migrated' }, payload: rest as unknown as Record<string, unknown> })
    }
    for (const c of old.cards) {
      const key = `card:${c.id}`
      if (ids[key] || this.core.list('card').some((x) => x.id === c.id)) continue
      todo.push({ key, type: 'card', id: c.id, meta: { name: c.nickname, brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, hasCvc: !!c.cvc, ...(c.billing ? { billing: c.billing } : {}), source: 'migrated' }, payload: { number: c.number, cvc: c.cvc, holder: c.holder } })
    }
    if (!todo.length) {
      if (!st) this.db.setSetting(MIGRATION, { at: Date.now(), ids, unreadable: old.unreadable, keys: old.keys } satisfies MigrationState)
      return { migrated: 0, unreadable: old.unreadable }
    }
    const run = (): number => {
      // One transaction: written, decrypted again and compared field by field, or rolled back entirely.
      this.core.atomic(() => {
        for (const t of todo) ids[t.key] = this.core.put(t.type, t.meta, t.payload, { id: t.id })
        for (const t of todo) {
          const back = this.core.get(ids[t.key])
          if (!back || JSON.stringify(sortKeys(back.payload)) !== JSON.stringify(sortKeys(t.payload))) throw new Error(`Migration check failed for ${t.type} "${t.meta.name}"`)
        }
        this.db.setSetting(MIGRATION, { at: Date.now(), ids, unreadable: old.unreadable, keys: old.keys } satisfies MigrationState)
      })
      return todo.length
    }
    try {
      const n = this.core.isUnlocked() ? run() : this.core.transiently(run)
      this.core.auditLog.add({ event: 'migration', outcome: 'ok', detail: `Moved ${n} item${n === 1 ? '' : 's'} from the old Keychain-only format (old copies kept until you remove them)${old.unreadable.length ? `; ${old.unreadable.length} unreadable` : ''}` })
      return { migrated: n, unreadable: old.unreadable }
    } catch (e) {
      if (e instanceof VaultLockedError) return { migrated: 0, unreadable: old.unreadable }
      this.core.auditLog.add({ event: 'migration', outcome: 'failed', detail: `${(e as Error).message}. Nothing was changed; the old copies are untouched.` })
      return { migrated: 0, unreadable: old.unreadable }
    }
  }

  legacyState(): { present: boolean; migrated: number; unreadable: string[]; rolledBack?: boolean } {
    const st = this.migration()
    return { present: hasLegacy(this.legacySrc), migrated: Object.keys(st?.ids ?? {}).length, unreadable: st?.unreadable ?? [], ...(st?.rolledBack ? { rolledBack: true } : {}) }
  }

  /** Removes the old Keychain-only copies once every migrated item still decrypts in the new vault. */
  purgeLegacy(): void {
    this.need()
    const st = this.migration()
    if (!st) throw new Error('Nothing has been migrated yet.')
    const old = readLegacy(this.legacySrc)
    for (const l of old.logins) {
      const it = this.loginByName(l.name)
      const p = it ? (this.core.get(it.id)?.payload as unknown as LoginPayload | undefined) : undefined
      if (!p?.password) throw new Error(`"${l.name}" isn't in the new vault yet, so the old copies were kept.`)
    }
    for (const c of old.cards) if (!this.core.get(st.ids[`card:${c.id}`] ?? c.id)) throw new Error(`Card "${c.nickname}" isn't in the new vault yet, so the old copies were kept.`)
    for (const a of old.addresses) if (!this.core.get(st.ids[`address:${a.id}`] ?? a.id)) throw new Error(`Address "${a.nickname}" isn't in the new vault yet, so the old copies were kept.`)
    purgeLegacy(this.legacySrc, old.keys)
    this.db.setSetting(MIGRATION, { ...st, keys: { settings: [], secrets: [] } })
    this.core.auditLog.add({ event: 'migration', outcome: 'ok', detail: 'Removed the old Keychain-only copies' })
  }

  /**
   * Rollback path: writes the current logins, cards and addresses back in the old format (verified by
   * reading them back), so an older SahilBot can use them. The new vault is left as it is.
   */
  rollback(): void {
    this.need()
    const data: Pick<LegacyData, 'logins' | 'cards' | 'addresses'> = { logins: [], cards: [], addresses: [] }
    for (const s of this.core.list('login')) {
      const p = this.core.get(s.id)!.payload as unknown as LoginPayload
      data.logins.push({ name: s.meta.name, origin: s.meta.origins?.[0] ?? '', ...(s.meta.subdomains ? { subdomains: true } : {}), username: p.username, password: p.password, ...(p.totp ? { totp: p.totp } : {}) })
    }
    for (const s of this.core.list('card')) {
      const p = this.core.get(s.id)!.payload as unknown as CardPayload
      data.cards.push({ id: s.id, nickname: s.meta.name, brand: s.meta.brand ?? 'card', last4: s.meta.last4 ?? '', ...(s.meta.billing ? { billing: s.meta.billing } : {}), number: p.number, cvc: p.cvc, expMonth: s.meta.expMonth ?? 0, expYear: s.meta.expYear ?? 0, holder: p.holder })
    }
    for (const s of this.core.list('address')) data.addresses.push({ ...(this.core.get(s.id)!.payload as unknown as AddressEntry), id: s.id, nickname: s.meta.name })
    writeLegacy(this.legacySrc, data)
    const back = readLegacy(this.legacySrc)
    if (back.logins.length !== data.logins.length || back.cards.length !== data.cards.length || back.addresses.length !== data.addresses.length) throw new Error('The old-format copy did not read back correctly.')
    this.db.setSetting(MIGRATION, { ...(this.migration() ?? { at: Date.now(), ids: {}, unreadable: [] }), rolledBack: true, keys: back.keys })
    this.core.auditLog.add({ event: 'migration', outcome: 'ok', detail: `Wrote ${data.logins.length + data.cards.length + data.addresses.length} items back in the old format (rollback copy)` })
  }

  // ------------------------------------------------------------------ lock state

  isUnlocked(): boolean {
    return this.core.isUnlocked()
  }

  lock(reason = 'locked'): void {
    this.core.lock(reason)
    this.auth?.forget()
  }

  /** No master password and no Touch ID: unlocking is the user's click. */
  presenceOnly(): boolean {
    return this.auth ? this.auth.presenceOnly() : !this.core.hasMasterPassword()
  }

  private need(): void {
    if (!this.core.isUnlocked()) throw new VaultLockedError()
  }

  /** Asks the user to unlock (Touch ID or the master password) if needed; throws if they don't. */
  async ensureUnlocked(reason: string, attended = true): Promise<void> {
    if (this.core.isUnlocked()) { this.core.touch(); return }
    const ok = this.auth ? await this.auth.unlock(reason, { attended }) : false
    if (!ok || !this.core.isUnlocked()) {
      throw new VaultLockedError(attended
        ? 'The vault is locked and wasn\'t unlocked, so nothing was typed. Ask the user to unlock it (Settings → Privacy & Security → Passwords, Touch ID or the master password) if they want you to continue.'
        : 'The vault is locked and nobody is here to unlock it, so nothing was typed. Tell the user.')
    }
  }

  /** Touch ID or the master password right before a sensitive fill or reveal. */
  async reauth(purpose: ReauthPurpose, reason: string, attended = true): Promise<void> {
    const ok = this.auth ? await this.auth.reauth(purpose, reason, { attended }) : !this.core.hasMasterPassword()
    if (!ok) throw new Error(attended ? 'The user didn\'t confirm with Touch ID or the master password, so nothing was filled.' : 'This needs Touch ID or the master password, and nobody is here to give it.')
  }

  /**
   * Writes from Settings. Unlocked: as is. A vault with nothing stronger than a click opens (the user is
   * the one saving). A Keychain-only vault adds new items while locked without opening. Otherwise: locked.
   */
  private write<T>(needsOld: boolean, fn: () => T): T {
    if (this.core.isUnlocked()) return fn()
    if (this.presenceOnly()) { this.core.unlockKeychain('presence'); return fn() }
    if (!needsOld && !this.core.hasMasterPassword()) return this.core.transiently(fn)
    throw new VaultLockedError('Unlock the vault to change saved items.')
  }

  private audit(event: AuditEvent, outcome: AuditEntry['outcome'], o: { item?: string; site?: string; detail?: string } = {}): void {
    this.core.auditLog.add({ event, outcome, ...o })
  }

  recordFill(outcome: AuditEntry['outcome'], o: { item?: string; site?: string; detail?: string }): void {
    this.audit(outcome === 'ok' ? 'fill' : 'fill_blocked', outcome, o)
  }

  auditEntries(limit = 300): AuditEntry[] {
    return this.core.auditLog.list(limit)
  }

  // ------------------------------------------------------------------ logins

  private loginByName(name: string): ItemSummary | undefined {
    const n = slug(name)
    const all = this.core.list('login')
    return all.find((x) => x.meta.name === n) ?? all.find((x) => x.meta.name.toLowerCase() === String(name ?? '').trim().toLowerCase())
  }

  private loginMeta(name: string, origin: string, subdomains: boolean | undefined, autoFill: boolean | undefined, username: string, key: TotpConfig | undefined, source?: ItemMeta['source']): ItemMeta {
    let host = ''
    try { host = new URL(origin).hostname } catch { host = '' }
    return {
      name, origins: [origin],
      ...(subdomains && host && !isPublicSuffix(host) ? { subdomains: true } : {}),
      ...(autoFill ? { autoFill: true } : {}),
      ...(usernameHint(username) ? { usernameHint: usernameHint(username) } : {}),
      ...(key ? { hasTotp: true, ...(key.issuer ? { totpIssuer: clip(key.issuer, 60) } : {}) } : {}),
      ...(source ? { source } : {})
    }
  }

  list(): VaultEntry[] {
    return this.core.list('login').map((s) => ({
      name: s.meta.name, origin: s.meta.origins?.[0] ?? '', username: s.meta.usernameHint ?? '',
      ...(s.meta.hasTotp ? { hasTotp: true } : {}), ...(s.meta.totpIssuer ? { totpIssuer: s.meta.totpIssuer } : {}), ...(s.meta.subdomains ? { subdomains: true } : {})
    }))
  }

  names(): Array<{ name: string; origin: string; subdomains?: boolean }> {
    return this.core.list('login').map((s) => ({ name: s.meta.name, origin: s.meta.origins?.[0] ?? '', ...(s.meta.subdomains ? { subdomains: true } : {}) }))
  }

  /** Whether a saved login may be typed on this page (exact origin, or its subdomains when opted in). */
  matches(name: string, pageUrl: string): boolean {
    const e = this.loginByName(name)
    return !!e && originMatches(e.meta.origins?.[0] ?? '', pageUrl, { subdomains: !!e.meta.subdomains })
  }

  /**
   * Saves a login. `totp` is an authenticator setup key or otpauth:// link (left out = keep the saved
   * one, clearTotp = remove it). Left-out password / username = keep the saved one.
   */
  set(e: Partial<VaultEntry> & { name: string; origin: string; password?: string; totp?: string; clearTotp?: boolean; autoFill?: boolean; notes?: string; renameFrom?: string }): void {
    const name = slug(e.name)
    if (!name) throw new Error('Name is required')
    const origin = normalizeOrigin(e.origin)
    const existing = this.loginByName(name)
    // A rename keeps the saved values of the login being renamed (and then removes it).
    const from = e.renameFrom ? this.core.list('login').find((x) => x.id === e.renameFrom) : undefined
    if (from && existing && existing.id !== from.id) throw new Error(`A login named "${name}" is already saved.`)
    const prev = from ?? existing
    const needsOld = !!prev && (!e.password || (!e.clearTotp && !(e.totp && e.totp.trim())) || e.username === undefined || e.notes === undefined)
    this.write(needsOld, () => {
      const old = prev ? (this.core.get(prev.id)?.payload as unknown as LoginPayload | undefined) : undefined
      const password = e.password || old?.password
      if (!password) throw new Error('Password is required')
      const key = e.clearTotp ? undefined : e.totp && e.totp.trim() ? parseTotp(e.totp) : old?.totp
      const username = clip(e.username ?? old?.username ?? '', 200)
      const notes = e.notes !== undefined ? String(e.notes).slice(0, 4000) : old?.notes
      const meta = this.loginMeta(name, origin, e.subdomains ?? prev?.meta.subdomains, e.autoFill ?? prev?.meta.autoFill, username, key, prev?.meta.source)
      this.core.atomic(() => {
        this.core.put('login', meta, { username, password, ...(key ? { totp: key } : {}), ...(notes ? { notes } : {}) }, { id: from ? existing?.id : prev?.id })
        if (from && from.meta.name !== name) this.core.remove(from.id)
      })
      this.audit(prev ? 'item_changed' : 'item_added', 'ok', { item: name, site: origin })
    })
  }

  remove(name: string): void {
    const it = this.loginByName(name)
    if (!it) return
    this.write(false, () => this.core.remove(it.id))
    this.audit('item_removed', 'ok', { item: it.meta.name })
  }

  /** Only for typing into a verified field. */
  credential(name: string): { origin: string; subdomains?: boolean; username: string; password: string } | undefined {
    const it = this.loginByName(name)
    if (!it) return undefined
    this.need()
    const p = this.core.get(it.id)?.payload as unknown as LoginPayload | undefined
    return p ? { origin: it.meta.origins?.[0] ?? '', ...(it.meta.subdomains ? { subdomains: true } : {}), username: p.username, password: p.password } : undefined
  }

  /** Leak check values (saved passwords etc.): what's in the vault while unlocked, recent fills while locked. */
  passwords(): string[] {
    return this.core.guardValues().filter((v) => !/^\d{12,19}$/.test(v))
  }

  /** The current authenticator code for a login (typed into a verified field, or shown on Reveal in Settings). */
  totpCode(name: string, now = Date.now()): { code: string; remaining: number; origin: string } | null {
    const it = this.loginByName(name)
    if (!it?.meta.hasTotp) return null
    this.need()
    const p = this.core.get(it.id)?.payload as unknown as LoginPayload | undefined
    if (!p?.totp) return null
    return { ...totp(p.totp, now), origin: it.meta.origins?.[0] ?? '' }
  }

  // ------------------------------------------------------------------ fills (browser)

  /** The item a fill names, by its name: metadata only, so guards run before anything is decrypted. */
  fillTarget(name: string, field: string): { id: string; type: VaultItemType; name: string; origins: string[]; subdomains?: boolean; autoFill?: boolean } | undefined {
    const s = field === 'id_number'
      ? this.core.list('identity').find((x) => x.meta.name.toLowerCase() === String(name ?? '').trim().toLowerCase())
      : this.loginByName(name)
    return s ? { id: s.id, type: s.type, name: s.meta.name, origins: s.meta.origins ?? [], ...(s.meta.subdomains ? { subdomains: true } : {}), ...(s.meta.autoFill ? { autoFill: true } : {}) } : undefined
  }

  /** The one value a verified fill types. Recorded as recently used (masked even after the vault locks). */
  fillValue(id: string, field: string): string {
    this.need()
    const it = this.core.get(id)
    if (!it) throw new Error('That item is no longer saved.')
    const p = it.payload
    const v = field === 'password' ? String(p.password ?? '') : field === 'username' ? String(p.username ?? '') : field === 'id_number' ? String(p.number ?? '') : ''
    if (!v) throw new Error(`"${it.meta.name}" has no ${field === 'id_number' ? 'document number' : field} saved.`)
    if (field !== 'username') this.core.noteFilled([v])
    return v
  }

  prefs(): ReturnType<SecureVault['prefs']> {
    return this.core.prefs()
  }

  // ------------------------------------------------------------------ cards

  cards(): CardEntry[] {
    return this.core.list('card').map((s) => ({
      id: s.id, nickname: s.meta.name, brand: s.meta.brand ?? 'card', last4: s.meta.last4 ?? '',
      expMonth: s.meta.expMonth ?? 0, expYear: s.meta.expYear ?? 0, holder: '', hasCvc: !!s.meta.hasCvc,
      ...(s.meta.billing && this.core.list('address').some((a) => a.id === s.meta.billing) ? { billing: s.meta.billing } : {})
    }))
  }

  setCard(c: CardInput): CardEntry[] {
    const nickname = clip(c.nickname, 60)
    const prev = c.id ? this.core.list('card').find((x) => x.id === c.id) : undefined
    if (c.id && !prev) throw new Error('That card is no longer saved.')
    const typed = digitsOnly(c.number ?? '')
    const needsOld = !!prev && (!typed || (!c.clearCvc && (c.cvc === undefined || c.cvc === '')))
    this.write(needsOld, () => {
      const old = prev ? (this.core.get(prev.id)?.payload as unknown as CardPayload | undefined) : undefined
      const number = typed || old?.number || ''
      const cvc = c.clearCvc ? '' : c.cvc !== undefined && c.cvc !== '' ? digitsOnly(c.cvc) : old?.cvc ?? ''
      const problem = cardProblem({ number, month: c.expMonth, year: c.expYear, cvc })
      if (problem) throw new Error(problem)
      const exp = normalizeExpiry(c.expMonth, c.expYear)!
      const holder = clip(c.holder, 80)
      if (!holder) throw new Error('Name on card is required.')
      const brand = cardBrand(number)
      const last4 = number.slice(-4)
      const name = nickname || cardLabel({ nickname: '', brand, last4 })
      if (this.core.list('card').some((x) => x.id !== prev?.id && x.meta.name.toLowerCase() === name.toLowerCase())) throw new Error(`A card named "${name}" is already saved.`)
      const billing = c.billing && this.core.list('address').some((a) => a.id === c.billing) ? c.billing : undefined
      this.core.put('card', { name, brand, last4, expMonth: exp.month, expYear: exp.year, hasCvc: !!cvc, ...(billing ? { billing } : {}), ...(prev?.meta.source ? { source: prev.meta.source } : {}) }, { number, cvc, holder }, { id: prev?.id })
      this.audit(prev ? 'item_changed' : 'item_added', 'ok', { item: name })
    })
    return this.cards()
  }

  removeCard(id: string): CardEntry[] {
    const it = this.core.list('card').find((x) => x.id === id)
    if (it) { this.write(false, () => this.core.remove(id)); this.audit('item_removed', 'ok', { item: it.meta.name }) }
    return this.cards()
  }

  /** What the model may know about saved cards: nickname, brand, last 4. */
  cardNames(): Array<{ id: string; label: string; nickname: string }> {
    return this.core.list('card').map((s) => ({ id: s.id, nickname: s.meta.name, label: cardLabel({ nickname: s.meta.name, brand: s.meta.brand ?? 'card', last4: s.meta.last4 ?? '' }) }))
  }

  /** A card by what the model calls it (nickname, id, "Visa ending 4242"): metadata only. */
  findCardMeta(ref: string): { id: string; label: string; brand: string; last4: string; billing?: string; hasCvc: boolean } | undefined {
    const q = String(ref ?? '').trim().toLowerCase()
    if (!q) return undefined
    const idx = this.core.list('card').map((s) => ({ s, label: cardLabel({ nickname: s.meta.name, brand: s.meta.brand ?? 'card', last4: s.meta.last4 ?? '' }) }))
    const last4 = /(?:ending|ends? in|•+|\*+|x+)\s*(\d{4})/i.exec(ref)?.[1] ?? (/^\d{4}$/.test(q) ? q : undefined)
    const one = <T>(xs: T[]): T | undefined => (xs.length === 1 ? xs[0] : undefined)
    const hit = idx.find((c) => c.s.id === ref || c.s.meta.name.toLowerCase() === q || c.label.toLowerCase() === q) ??
      (last4 ? one(idx.filter((c) => c.s.meta.last4 === last4)) : undefined) ??
      one(idx.filter((c) => c.s.meta.name.toLowerCase().includes(q)))
    return hit ? { id: hit.s.id, label: hit.label, brand: hit.s.meta.brand ?? 'card', last4: hit.s.meta.last4 ?? '', ...(hit.s.meta.billing ? { billing: hit.s.meta.billing } : {}), hasCvc: !!hit.s.meta.hasCvc } : undefined
  }

  /** Only for filling a verified payment form after the Purchase card (the vault must be unlocked). */
  findCard(ref: string): { number: string; cvc: string; expMonth: number; expYear: number; holder: string; id: string; label: string; brand: string; last4: string; billing?: string } | undefined {
    const m = this.findCardMeta(ref)
    if (!m) return undefined
    this.need()
    const it = this.core.get(m.id)
    if (!it) return undefined
    const p = it.payload as unknown as CardPayload
    this.core.noteFilled([p.number])
    return { ...m, number: p.number, cvc: p.cvc, holder: p.holder, expMonth: it.meta.expMonth ?? 0, expYear: it.meta.expYear ?? 0 }
  }

  /** Full numbers of saved cards (digits only): leak check, redaction and the browser's card guard. */
  cardNumbers(): string[] {
    return this.core.guardValues().filter((v) => /^\d{12,19}$/.test(v))
  }

  /**
   * Everything a tool call must never carry: saved passwords, authenticator keys, ID numbers, and card
   * numbers in the ways they are usually written (digits only, grouped with spaces or dashes).
   */
  secretValues(): string[] {
    const out: string[] = []
    for (const v of [...this.core.guardValues(), ...this.pending()]) {
      out.push(v)
      if (/^\d{12,19}$/.test(v)) { const spaced = formatCardNumber(v); out.push(spaced, spaced.replace(/ /g, '-')) }
    }
    return out
  }

  /** Masks any saved value in text bound for the model (tool results, page text, errors). */
  redact(text: string): string {
    return redactSecrets(text, [...this.core.guardValues(), ...this.pending()])
  }

  private pending(): string[] {
    try { return this.pendingSecrets().filter((v) => typeof v === 'string' && v.length >= 4) } catch { return [] }
  }

  // ------------------------------------------------------------------ addresses

  addresses(): AddressEntry[] {
    return this.core.list('address').map((s) => ({ id: s.id, nickname: s.meta.name, name: '', line1: '', city: '', postal: '', country: '', ...(s.meta.summary ? { summary: s.meta.summary } : {}) }))
  }

  setAddress(a: Omit<AddressEntry, 'id'> & { id?: string }): AddressEntry[] {
    const clean = (v: unknown, n = 120): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)
    const prev = a.id ? this.core.list('address').find((x) => x.id === a.id) : undefined
    const e: Omit<AddressEntry, 'id' | 'summary'> = {
      nickname: clean(a.nickname, 60), name: clean(a.name), line1: clean(a.line1), line2: clean(a.line2) || undefined,
      city: clean(a.city, 80), region: clean(a.region, 80) || undefined, postal: clean(a.postal, 20), country: clean(a.country, 60),
      phone: clean(a.phone, 40) || undefined, email: clean(a.email, 120) || undefined
    }
    if (!e.nickname) throw new Error('Give the address a nickname (e.g. Home).')
    if (!e.name || !e.line1 || !e.city || !e.country) throw new Error('Name, street, city and country are required.')
    if (this.core.list('address').some((x) => x.id !== prev?.id && x.meta.name.toLowerCase() === e.nickname.toLowerCase())) throw new Error(`An address named "${e.nickname}" is already saved.`)
    this.write(false, () => {
      const payload = JSON.parse(JSON.stringify(e)) as Record<string, unknown>
      this.core.put('address', { name: e.nickname, summary: addressSummary(e), ...(prev?.meta.source ? { source: prev.meta.source } : {}) }, payload, { id: prev?.id })
      this.audit(prev ? 'item_changed' : 'item_added', 'ok', { item: e.nickname })
    })
    return this.addresses()
  }

  removeAddress(id: string): AddressEntry[] {
    const it = this.core.list('address').find((x) => x.id === id)
    // A card billed to it keeps working; it just has no billing address any more (dangling ids are ignored).
    if (it) { this.write(false, () => this.core.remove(id)); this.audit('item_removed', 'ok', { item: it.meta.name }) }
    return this.addresses()
  }

  addressNames(): string[] {
    return this.core.list('address').map((s) => s.meta.name)
  }

  /** By nickname (case-insensitive) or id. Only for filling a form the user approved. */
  findAddress(ref: string): AddressEntry | undefined {
    const q = String(ref ?? '').trim().toLowerCase()
    const hit = this.core.list('address').find((s) => s.id === ref || s.meta.name.toLowerCase() === q)
    if (!hit) return undefined
    this.need()
    const it = this.core.get(hit.id)
    return it ? { ...(it.payload as unknown as AddressEntry), id: hit.id, nickname: hit.meta.name } : undefined
  }

  // ------------------------------------------------------------------ every type (Settings → Privacy & Security → Passwords)

  items(): VaultItemSummary[] {
    const addrIds = new Set(this.core.list('address').map((a) => a.id))
    return this.core.list().map((s) => summarize(s, addrIds)).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
  }

  saveItem(i: VaultItemInput): void {
    const type = i.type
    if (type === 'login') {
      const prev = i.id ? this.core.list('login').find((x) => x.id === i.id) : undefined
      // A rename keeps the saved values; the old entry goes in the same transaction.
      this.set({ ...(prev && prev.meta.name !== slug(i.name) ? { renameFrom: prev.id } : {}), name: i.name, origin: i.site ?? prev?.meta.origins?.[0] ?? '', ...(i.username !== undefined && i.username !== '' ? { username: i.username } : prev ? {} : { username: '' }), ...(i.password ? { password: i.password } : {}), ...(i.totp ? { totp: i.totp } : {}), ...(i.clearTotp ? { clearTotp: true } : {}), ...(i.subdomains !== undefined ? { subdomains: i.subdomains } : {}), ...(i.autoFill !== undefined ? { autoFill: i.autoFill } : {}), ...(i.notes !== undefined ? { notes: i.notes } : prev ? {} : { notes: '' }) })
      return
    }
    if (type === 'card') { this.setCard({ id: i.id, nickname: i.name, number: i.number, cvc: i.cvc, clearCvc: i.clearCvc, expMonth: i.expMonth ?? '', expYear: i.expYear ?? '', holder: i.holder ?? '', billing: i.billing }); return }
    if (type === 'address') { this.setAddress({ ...(i.address ?? { name: '', line1: '', city: '', postal: '', country: '' }), id: i.id, nickname: i.name }); return }
    const name = clip(i.name, 60)
    if (!name) throw new Error('Give it a name.')
    const prev = i.id ? this.core.list(type).find((x) => x.id === i.id) : undefined
    if (i.id && !prev) throw new Error('That item is no longer saved.')
    if (this.core.list(type).some((x) => x.id !== prev?.id && x.meta.name.toLowerCase() === name.toLowerCase())) throw new Error(`"${name}" is already saved.`)
    if (type === 'note') {
      const needsOld = !!prev && i.body === undefined
      this.write(needsOld, () => {
        const body = i.body !== undefined ? String(i.body).slice(0, 20_000) : String((this.core.get(prev!.id)?.payload.body as string | undefined) ?? '')
        this.core.put('note', { name }, { body }, { id: prev?.id })
        this.audit(prev ? 'item_changed' : 'item_added', 'ok', { item: name })
      })
      return
    }
    if (type === 'identity') {
      const typed = clip(i.number, 64)
      const needsOld = !!prev
      this.write(needsOld, () => {
        const old = prev ? (this.core.get(prev.id)?.payload as unknown as IdentityPayload | undefined) : undefined
        const number = typed || old?.number || ''
        if (!number) throw new Error('The document number is required.')
        const sites = i.sites !== undefined ? String(i.sites).split(/[\s,]+/).filter(Boolean).map((x) => normalizeOrigin(x)) : prev?.meta.origins ?? []
        const exp = i.expMonth && i.expYear ? normalizeExpiry(i.expMonth, i.expYear, new Date(0)) : null
        const payload: IdentityPayload = { number, fullName: clip(i.fullName ?? old?.fullName, 120) || undefined, issuer: clip(i.issuer ?? old?.issuer, 120) || undefined, country: clip(i.country ?? old?.country, 60) || undefined, notes: i.notes !== undefined ? String(i.notes).slice(0, 4000) || undefined : old?.notes }
        this.core.put('identity', { name, kind: clip(i.kind ?? prev?.meta.kind ?? 'other', 30), last4: number.length >= 6 ? number.slice(-4) : undefined, ...(exp ? { expMonth: exp.month, expYear: exp.year } : prev?.meta.expMonth ? { expMonth: prev.meta.expMonth, expYear: prev.meta.expYear } : {}), ...(sites.length ? { origins: [...new Set(sites)] } : {}) }, JSON.parse(JSON.stringify(payload)) as Record<string, unknown>, { id: prev?.id })
        this.audit(prev ? 'item_changed' : 'item_added', 'ok', { item: name })
      })
      return
    }
    throw new Error('Unknown item type.')
  }

  removeItem(id: string): void {
    const it = this.core.list().find((x) => x.id === id)
    if (!it) return
    this.write(false, () => this.core.remove(id))
    this.audit('item_removed', 'ok', { item: it.meta.name })
  }

  /**
   * The values of one item, for showing to the user after Touch ID or the master password (the IPC
   * handler asks first). Never returned to the model.
   */
  revealFields(id: string, now = Date.now()): VaultReveal {
    this.need()
    const it = this.core.get(id)
    if (!it) throw new Error('That item is no longer saved.')
    const p = it.payload as Record<string, unknown>
    const s = (v: unknown): string => (typeof v === 'string' ? v : '')
    const f: VaultReveal['fields'] = []
    const add = (key: string, label: string, value: string, secret = false): void => { if (value) f.push({ key, label, value, ...(secret ? { secret: true } : {}) }) }
    if (it.type === 'login') {
      add('username', 'Username', s(p.username)); add('password', 'Password', s(p.password), true)
      const t = p.totp as TotpConfig | undefined
      if (t) add('code', 'Authenticator code', totp(t, now).code, true)
      add('notes', 'Notes', s(p.notes))
    } else if (it.type === 'card') {
      add('number', 'Card number', formatCardNumber(s(p.number)), true); add('cvc', 'Security code', s(p.cvc), true); add('holder', 'Name on card', s(p.holder))
      add('expiry', 'Expires', it.meta.expMonth ? `${String(it.meta.expMonth).padStart(2, '0')}/${it.meta.expYear}` : '')
    } else if (it.type === 'identity') {
      add('number', 'Number', s(p.number), true); add('fullName', 'Name', s(p.fullName)); add('issuer', 'Issued by', s(p.issuer)); add('country', 'Country', s(p.country)); add('notes', 'Notes', s(p.notes))
    } else if (it.type === 'note') {
      add('body', 'Note', s(p.body), true)
    } else if (it.type === 'address') {
      for (const [k, label] of [['name', 'Name'], ['line1', 'Street'], ['line2', 'Apt / suite'], ['city', 'City'], ['region', 'State / region'], ['postal', 'ZIP / postal'], ['country', 'Country'], ['phone', 'Phone'], ['email', 'Email']] as const) add(k, label, s(p[k]))
    }
    this.audit('reveal', 'ok', { item: it.meta.name })
    return { id, type: it.type, fields: f, hideAfterMs: 20_000 }
  }

  // ------------------------------------------------------------------ backup

  async exportBackup(password: string): Promise<{ text: string; count: number }> {
    this.need()
    const text = await this.core.exportBundle(password)
    const count = this.core.list().length
    this.audit('export', 'ok', { detail: `${count} items, encrypted with the backup password` })
    return { text, count }
  }

  async importBackup(text: string, password: string): Promise<{ added: number; skipped: number }> {
    this.need()
    let items
    try {
      items = await this.core.readBundle(text, password)
    } catch (e) {
      this.audit('import', 'failed', { detail: (e as Error).message })
      throw e
    }
    const existing = this.core.list()
    const key = (t: string, n: string): string => `${t}|${n.toLowerCase()}`
    const have = new Set(existing.map((x) => key(x.type, x.meta.name)))
    const todo = items.filter((it) => !have.has(key(it.type, it.meta.name)) && !existing.some((x) => x.id === it.id))
    this.core.putMany(todo.map((it) => ({ type: it.type, meta: { ...it.meta, source: 'imported' as const }, payload: it.payload, id: it.id })))
    this.audit('import', 'ok', { detail: `${todo.length} added, ${items.length - todo.length} already saved` })
    return { added: todo.length, skipped: items.length - todo.length }
  }

  /** Logins from a password manager's CSV export (the caller warns the user to delete the CSV). */
  importCsv(text: string): { added: number; skipped: number } {
    const { logins, skipped } = loginsFromCsv(text)
    let added = 0, dup = 0
    this.write(false, () => {
      const todo: Array<{ type: ItemType; meta: ItemMeta; payload: Record<string, unknown> }> = []
      const names = new Set(this.core.list('login').map((x) => x.meta.name))
      for (const l of logins) {
        let origin: string
        try { origin = normalizeOrigin(l.url) } catch { dup++; continue }
        const base = slug(l.title) || slug(new URL(origin).hostname) || 'login'
        if (this.core.list('login').some((x) => x.meta.origins?.[0] === origin && x.meta.usernameHint === usernameHint(l.username) && x.meta.name.startsWith(base))) { dup++; continue }
        let name = base
        for (let n = 2; names.has(name); n++) name = `${base}-${n}`
        names.add(name)
        let key: TotpConfig | undefined
        try { key = l.totp ? parseTotp(l.totp) : undefined } catch { key = undefined }
        todo.push({ type: 'login', meta: this.loginMeta(name, origin, false, false, l.username, key, 'csv'), payload: { username: l.username, password: l.password, ...(key ? { totp: key } : {}), ...(l.note ? { notes: l.note.slice(0, 4000) } : {}) } })
      }
      this.core.putMany(todo)
      added = todo.length
    })
    this.audit('import', 'ok', { detail: `CSV: ${added} logins added, ${skipped + dup} skipped` })
    return { added, skipped: skipped + dup }
  }
}

function addressSummary(a: { city?: string; region?: string; country?: string }): string {
  return [a.city, a.region, a.country].filter(Boolean).join(', ').slice(0, 120)
}

function sortKeys(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, sortKeys(o[k])]))
}

function summarize(s: ItemSummary, addrIds: Set<string>): VaultItemSummary {
  const m = s.meta
  return {
    id: s.id, type: s.type, name: m.name, updated: s.updated,
    ...(m.origins?.length ? { sites: m.origins } : {}),
    ...(m.subdomains ? { subdomains: true } : {}), ...(m.autoFill ? { autoFill: true } : {}),
    ...(m.usernameHint ? { usernameHint: m.usernameHint } : {}), ...(m.hasTotp ? { hasTotp: true } : {}), ...(m.totpIssuer ? { totpIssuer: m.totpIssuer } : {}),
    ...(m.brand ? { brand: m.brand } : {}), ...(m.last4 ? { last4: m.last4 } : {}), ...(m.expMonth ? { expMonth: m.expMonth, expYear: m.expYear } : {}),
    ...(s.type === 'card' ? { hasCvc: !!m.hasCvc } : {}), ...(m.billing && addrIds.has(m.billing) ? { billing: m.billing } : {}),
    ...(m.kind ? { kind: m.kind } : {}), ...(m.summary ? { summary: m.summary } : {})
  }
}

/** Display label for a card brand (Settings and the Purchase card). */
export const brandName = (b: string): string => BRAND_NAME[b as CardBrand] ?? 'Card'
