// The vault itself: envelope encryption, lock state, master password, tamper checks, backups.
//
// Key hierarchy (docs/secrets-vault.md has the full write-up):
//
//   K1  = 32 random bytes, kept by the macOS Keychain through Electron safeStorage (this app's key)
//   K2  = scrypt / Argon2id(master password, salt)                       (only when a master password is set)
//   KEK = HKDF-SHA256(K1 || K2, header salt, "…/kek/v1/<mode>/<vault id>")
//   MK  = 32 random bytes (the vault master key), stored only wrapped: AES-256-GCM(KEK, MK)
//   DK  = 32 random bytes per item version, stored wrapped: AES-256-GCM(MK, DK, AAD = vault + item id)
//   item ciphertext = AES-256-GCM(DK, payload JSON, AAD = canonical {vault, id, type, ver, meta})
//
// MK exists in memory only while the vault is unlocked. The manifest (item id → version, HMAC'd with a
// key derived from MK) catches rows that were deleted, re-inserted or rolled back to an old version.

import { randomBytes, randomUUID } from 'node:crypto'
import type { AuditLog } from './audit'
import { b64, benchmarkKdf, canonical, deriveFromPassword, equalBytes, hkdf, hmac, open, randomKey, seal, unb64, VaultCryptoError, wipe, type KdfParams } from './crypto'
import type { VaultRow, VaultStorage } from './storage'

export type ItemType = 'login' | 'card' | 'identity' | 'note' | 'address'
export const ITEM_TYPES: ItemType[] = ['login', 'card', 'identity', 'note', 'address']

/**
 * What may be known about an item without unlocking: shown in Settings and (names only) to the model.
 * Stored unencrypted but bound into the item's AAD, so editing it breaks decryption.
 */
export interface ItemMeta {
  name: string
  /** Sites the item may be filled on (logins: one; IDs: optional allow-list). */
  origins?: string[]
  subdomains?: boolean
  /** Standing rule: sign in on this login's own site without an approval card. */
  autoFill?: boolean
  usernameHint?: string
  hasTotp?: boolean
  totpIssuer?: string
  brand?: string
  last4?: string
  expMonth?: number
  expYear?: number
  hasCvc?: boolean
  billing?: string
  kind?: string
  summary?: string
  source?: 'migrated' | 'imported' | 'csv'
}

export interface Item { id: string; type: ItemType; ver: number; meta: ItemMeta; payload: Record<string, unknown>; created: number; updated: number }
export interface ItemSummary { id: string; type: ItemType; ver: number; meta: ItemMeta; created: number; updated: number }

/** Keychain-backed key storage (Electron safeStorage in the app; a Map in tests). */
export interface KeyStore {
  get(name: string): string | undefined
  set(name: string, value: string | null): void
  available(): boolean
}

export interface VaultPrefs {
  /** Lock after this many minutes without use or with the Mac idle (0 = only on sleep, lock screen and quit). */
  autoLockMinutes: number
  lockOnSleep: boolean
  /** Ask for Touch ID or the master password before typing saved passwords too (cards and IDs always ask). */
  reauthPasswords: boolean
  /** Use Touch ID to unlock and confirm (when the Mac has it). */
  touchId: boolean
}
export const DEFAULT_PREFS: VaultPrefs = { autoLockMinutes: 15, lockOnSleep: true, reauthPasswords: false, touchId: true }

interface Header {
  format: 'sahilbot-vault'
  v: 1
  id: string
  salt: string
  created: number
  /** Present when a master password is set (both factors are then needed). */
  kdf?: KdfParams & { ms?: number }
  /** MK wrapped under KEK(K1 [+ K2]). */
  wrap: string
  /** MK wrapped under KEK(K1 + Kbio): Touch ID unlock while a master password is set. */
  bio?: string
  manifest: { items: Record<string, number>; mac: string }
}

export class VaultLockedError extends Error {
  constructor(message = 'The vault is locked.') { super(message); this.name = 'VaultLockedError' }
}
export class WrongPasswordError extends Error {
  constructor(public retryInMs: number) { super(retryInMs ? `Wrong master password. Try again in ${Math.ceil(retryInMs / 1000)}s.` : 'Wrong master password.'); this.name = 'WrongPasswordError' }
}
export class ThrottledError extends Error {
  constructor(public retryInMs: number) { super(`Too many wrong attempts. Try again in ${Math.ceil(retryInMs / 1000)}s.`); this.name = 'ThrottledError' }
}
export class TamperError extends Error {
  constructor(message = 'This vault item was changed outside SahilBot, so it was not used.') { super(message); this.name = 'TamperError' }
}

const K1 = 'vault2:k1'
const KBIO = 'vault2:kbio'
const HEADER = 'vault2:header'
const PREFS = 'vault2:prefs'
const THROTTLE = 'vault2:throttle'
type Mode = 'kc' | 'kc+pw' | 'kc+bio'

/** Exponential backoff after failed unlocks: two free tries, then 1 s, 2 s, 4 s … up to 5 minutes. */
export function backoffMs(fails: number): number {
  return fails < 3 ? 0 : Math.min(5 * 60_000, 1000 * 2 ** (fails - 3))
}

/** Values in a payload that must never reach the model: what leak checks and redaction look for. */
export function secretFields(type: ItemType, p: Record<string, unknown>): string[] {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (type === 'login') return [s(p.password), s((p.totp as { secret?: string } | undefined)?.secret)].filter(Boolean)
  if (type === 'card') return [s(p.number)].filter(Boolean)
  if (type === 'identity') return [s(p.number)].filter(Boolean)
  return []
}

export interface VaultCoreOptions {
  storage: VaultStorage
  keys: KeyStore
  audit: AuditLog
  now?: () => number
  /** KDF parameters for a new master password or export (default: benchmarked on this Mac). */
  kdf?: () => Promise<KdfParams & { ms?: number }>
}

export class SecureVault {
  private mk: Buffer | null = null
  private lastUsed = 0
  private unlockedAt = 0
  private guard: string[] | null = null
  private computingGuard = false
  /** Values typed into pages recently: still masked and leak-checked after the vault locks. */
  private recent: Array<{ value: string; until: number }> = []
  tampered = false
  onChange: (why: string) => void = () => undefined
  private readonly now: () => number

  constructor(private o: VaultCoreOptions) {
    this.now = o.now ?? Date.now
  }

  // ------------------------------------------------------------------ header and keys

  private header(): Header | undefined {
    return this.o.storage.get<Header>(HEADER)
  }

  exists(): boolean {
    return !!this.header()
  }

  /** Creates the vault the first time (Keychain-only protection until a master password is set). */
  init(): void {
    if (this.header()) return
    if (!this.o.keys.available()) throw new Error('Keychain encryption is unavailable, so the vault can\'t be created.')
    const k1 = randomKey()
    const mk = randomKey()
    try {
      const id = randomUUID()
      const salt = randomBytes(32)
      this.o.keys.set(K1, b64(k1))
      const h: Header = { format: 'sahilbot-vault', v: 1, id, salt: b64(salt), created: this.now(), wrap: '', manifest: { items: {}, mac: '' } }
      h.wrap = b64(seal(this.kek(h, 'kc', k1), mk, this.mkAad(h, 'kc')))
      h.manifest.mac = this.manifestMac(h, mk, {})
      this.o.storage.set(HEADER, h)
    } finally {
      wipe(k1, mk)
    }
  }

  private kek(h: Header, mode: Mode, k1: Buffer, k2?: Buffer): Buffer {
    const ikm = k2 ? Buffer.concat([k1, k2]) : Buffer.from(k1)
    try { return hkdf(ikm, unb64(h.salt), `sahilbot-vault/kek/v1/${mode}/${h.id}`) } finally { wipe(ikm) }
  }

  private mkAad(h: Header, mode: Mode): string {
    return `sahilbot-vault/mk/v1/${mode}/${h.id}`
  }

  private manifestMac(h: Header, mk: Buffer, items: Record<string, number>): string {
    const key = hkdf(mk, unb64(h.salt), `sahilbot-vault/manifest/v1/${h.id}`)
    try { return b64(hmac(key, canonical({ vault: h.id, items }))) } finally { wipe(key) }
  }

  private k1(): Buffer {
    const raw = this.o.keys.get(K1)
    if (!raw) throw new Error('The vault\'s Keychain key is missing (the app may have been moved, renamed or copied to another Mac). Restore an encrypted backup to get your items back.')
    return unb64(raw)
  }

  private unwrapKeychainOnly(h: Header): Buffer {
    const k1 = this.k1()
    const kek = this.kek(h, 'kc', k1)
    try { return open(kek, unb64(h.wrap), this.mkAad(h, 'kc')) } finally { wipe(k1, kek) }
  }

  // ------------------------------------------------------------------ state

  isUnlocked(): boolean {
    return !!this.mk
  }

  hasMasterPassword(): boolean {
    return !!this.header()?.kdf
  }

  hasBioWrap(): boolean {
    return !!this.header()?.bio
  }

  status(): { exists: boolean; locked: boolean; masterPassword: boolean; bio: boolean; kdf?: { alg: string; cost: string; ms?: number }; counts: Record<ItemType, number>; tampered: boolean; unlockedAt?: number; retryInMs: number } {
    const h = this.header()
    const counts = Object.fromEntries(ITEM_TYPES.map((t) => [t, 0])) as Record<ItemType, number>
    for (const r of this.o.storage.rows()) if (r.type in counts) counts[r.type as ItemType]++
    const k = h?.kdf
    return {
      exists: !!h,
      locked: !this.mk,
      masterPassword: !!k,
      bio: !!h?.bio,
      ...(k ? { kdf: { alg: k.alg, cost: k.alg === 'scrypt' ? `N=2^${Math.log2(k.N)}, r=${k.r}, p=${k.p}` : `${Math.round(k.memory / 1024)} MiB, ${k.passes} passes, ${k.parallelism} lanes`, ms: k.ms } } : {}),
      counts,
      tampered: this.tampered,
      ...(this.mk ? { unlockedAt: this.unlockedAt } : {}),
      retryInMs: this.retryInMs()
    }
  }

  prefs(): VaultPrefs {
    return { ...DEFAULT_PREFS, ...(this.o.storage.get<Partial<VaultPrefs>>(PREFS) ?? {}) }
  }

  setPrefs(p: Partial<VaultPrefs>): VaultPrefs {
    const cur = this.prefs()
    const next: VaultPrefs = {
      autoLockMinutes: p.autoLockMinutes !== undefined ? Math.max(0, Math.min(24 * 60, Math.round(Number(p.autoLockMinutes) || 0))) : cur.autoLockMinutes,
      lockOnSleep: p.lockOnSleep !== undefined ? !!p.lockOnSleep : cur.lockOnSleep,
      reauthPasswords: p.reauthPasswords !== undefined ? !!p.reauthPasswords : cur.reauthPasswords,
      touchId: p.touchId !== undefined ? !!p.touchId : cur.touchId
    }
    this.o.storage.set(PREFS, next)
    this.onChange('prefs')
    return next
  }

  retryInMs(): number {
    const t = this.o.storage.get<{ fails: number; until: number }>(THROTTLE)
    return t ? Math.max(0, t.until - this.now()) : 0
  }

  private failed(): number {
    const t = this.o.storage.get<{ fails: number; until: number }>(THROTTLE) ?? { fails: 0, until: 0 }
    const fails = t.fails + 1
    const wait = backoffMs(fails)
    this.o.storage.set(THROTTLE, { fails, until: this.now() + wait })
    return wait
  }

  private succeeded(): void {
    this.o.storage.set(THROTTLE, null)
  }

  private opened(mk: Buffer, via: string): void {
    const h = this.header()!
    if (this.mk && this.mk !== mk) wipe(this.mk)
    this.mk = mk
    this.unlockedAt = this.lastUsed = this.now()
    this.guard = null
    // The manifest must be signed by this vault's key; otherwise rows were edited outside SahilBot.
    const good = h.manifest.mac && equalBytes(unb64(h.manifest.mac), unb64(this.manifestMac(h, mk, h.manifest.items)))
    this.tampered = !good
    if (!good) this.o.audit.add({ event: 'tamper', outcome: 'blocked', detail: 'The vault index signature does not match; items are not used until you review them.' })
    this.succeeded()
    this.o.audit.add({ event: 'unlock', outcome: 'ok', detail: via })
    this.onChange('unlock')
  }

  /**
   * Unlocks without a password: Keychain-only vaults (after Touch ID or the user's click), or a vault with
   * a master password whose Touch ID copy is on (via must be 'touchid').
   */
  unlockKeychain(via: 'touchid' | 'presence'): void {
    const h = this.header()
    if (!h) throw new Error('No vault yet.')
    if (this.mk) { this.touch(); return }
    if (h.kdf) {
      if (via !== 'touchid' || !h.bio) throw new Error('This vault needs its master password.')
      const k1 = this.k1()
      const kbioRaw = this.o.keys.get(KBIO)
      if (!kbioRaw) throw new Error('Touch ID unlock isn\'t set up any more. Use the master password.')
      const kbio = unb64(kbioRaw)
      const kek = this.kek(h, 'kc+bio', k1, kbio)
      try {
        this.opened(open(kek, unb64(h.bio), this.mkAad(h, 'kc+bio')), 'Touch ID')
      } catch (e) {
        this.o.audit.add({ event: 'unlock_failed', outcome: 'failed', detail: 'Touch ID key did not open the vault' })
        throw e
      } finally {
        wipe(k1, kbio, kek)
      }
      return
    }
    this.opened(this.unwrapKeychainOnly(h), via === 'touchid' ? 'Touch ID' : 'Keychain')
  }

  /** Both factors: the Keychain key and the master password. Wrong passwords back off exponentially. */
  async unlockPassword(password: string): Promise<void> {
    const h = this.header()
    if (!h) throw new Error('No vault yet.')
    if (this.mk) { this.touch(); return }
    if (!h.kdf) { this.unlockKeychain('presence'); return }
    const mk = await this.tryPassword(h, password)
    this.opened(mk, 'master password')
  }

  private async tryPassword(h: Header, password: string): Promise<Buffer> {
    const wait = this.retryInMs()
    if (wait > 0) {
      this.o.audit.add({ event: 'unlock_failed', outcome: 'denied', detail: 'Too many attempts (waiting)' })
      throw new ThrottledError(wait)
    }
    const k1 = this.k1()
    const k2 = await deriveFromPassword(String(password ?? ''), h.kdf!)
    const kek = this.kek(h, 'kc+pw', k1, k2)
    try {
      return open(kek, unb64(h.wrap), this.mkAad(h, 'kc+pw'))
    } catch (e) {
      if (!(e instanceof VaultCryptoError)) throw e
      const next = this.failed()
      this.o.audit.add({ event: 'unlock_failed', outcome: 'failed', detail: 'Wrong master password' })
      throw new WrongPasswordError(next)
    } finally {
      wipe(k1, k2, kek)
    }
  }

  /** Re-authentication with the master password (doesn't change the lock state). */
  async verifyPassword(password: string): Promise<void> {
    const h = this.header()
    if (!h?.kdf) throw new Error('No master password is set.')
    const mk = await this.tryPassword(h, password)
    wipe(mk)
    this.succeeded()
  }

  lock(reason = 'locked'): void {
    if (!this.mk) return
    wipe(this.mk)
    this.mk = null
    this.guard = null
    this.o.audit.add({ event: 'lock', outcome: 'ok', detail: reason })
    this.onChange('lock')
  }

  /** Marks the vault as used now (auto-lock counts from the last use). */
  touch(): void {
    if (this.mk) this.lastUsed = this.now()
  }

  /** Auto-lock: called every few seconds with the Mac's idle time. */
  tick(systemIdleSeconds = 0): void {
    if (!this.mk) return
    const min = this.prefs().autoLockMinutes
    if (!min) return
    const limit = min * 60_000
    if (this.now() - this.lastUsed >= limit) this.lock(`not used for ${min} min`)
    else if (systemIdleSeconds * 1000 >= limit) this.lock(`Mac idle for ${min} min`)
  }

  // ------------------------------------------------------------------ master password

  async setMasterPassword(next: string, current?: string): Promise<void> {
    const h = this.header()
    if (!h) throw new Error('No vault yet.')
    if (!this.mk) throw new VaultLockedError('Unlock the vault first.')
    if (String(next ?? '').length < 10) throw new Error('Use at least 10 characters (a few random words work well).')
    if (h.kdf) await this.verifyPassword(current ?? '')
    const params = await (this.o.kdf ?? (() => benchmarkKdf()))()
    const k1 = this.k1()
    const k2 = await deriveFromPassword(next, params)
    const kek = this.kek(h, 'kc+pw', k1, k2)
    try {
      const had = !!h.kdf
      const nh: Header = { ...h, kdf: params, wrap: b64(seal(kek, this.mk, this.mkAad(h, 'kc+pw'))) }
      // A Touch ID copy made for the old password stays valid only if the user turns it on again.
      delete nh.bio
      this.o.storage.set(HEADER, nh)
      this.o.keys.set(KBIO, null)
      this.o.audit.add({ event: 'master_password', outcome: 'ok', detail: had ? 'changed' : 'set' })
      this.onChange('master')
    } finally {
      wipe(k1, k2, kek)
    }
  }

  async removeMasterPassword(current: string): Promise<void> {
    const h = this.header()
    if (!h?.kdf) return
    if (!this.mk) throw new VaultLockedError('Unlock the vault first.')
    await this.verifyPassword(current)
    const k1 = this.k1()
    const kek = this.kek(h, 'kc', k1)
    try {
      const nh: Header = { ...h, wrap: b64(seal(kek, this.mk, this.mkAad(h, 'kc'))) }
      delete nh.kdf
      delete nh.bio
      this.o.storage.set(HEADER, nh)
      this.o.keys.set(KBIO, null)
      this.o.audit.add({ event: 'master_password', outcome: 'ok', detail: 'removed' })
      this.onChange('master')
    } finally {
      wipe(k1, kek)
    }
  }

  /** Touch ID unlock while a master password is set: a second copy of MK under the Keychain plus a Touch ID key. */
  enableBio(): void {
    const h = this.header()
    if (!h?.kdf) return
    if (!this.mk) throw new VaultLockedError('Unlock the vault first.')
    const k1 = this.k1()
    const kbio = randomKey()
    const kek = this.kek(h, 'kc+bio', k1, kbio)
    try {
      this.o.keys.set(KBIO, b64(kbio))
      this.o.storage.set(HEADER, { ...h, bio: b64(seal(kek, this.mk, this.mkAad(h, 'kc+bio'))) })
      this.onChange('bio')
    } finally {
      wipe(k1, kbio, kek)
    }
  }

  disableBio(): void {
    const h = this.header()
    if (!h?.bio) return
    const nh = { ...h }
    delete nh.bio
    this.o.storage.set(HEADER, nh)
    this.o.keys.set(KBIO, null)
    this.onChange('bio')
  }

  // ------------------------------------------------------------------ items

  private itemAad(h: Header, r: { id: string; type: string; ver: number; meta: ItemMeta }): string {
    return canonical({ f: 'sahilbot-vault/item/v1', vault: h.id, id: r.id, type: r.type, ver: r.ver, meta: r.meta })
  }

  private dkAad(h: Header, id: string): string {
    return `sahilbot-vault/dk/v1/${h.id}/${id}`
  }

  /**
   * MK for one operation. Unlocked: the live key. Locked, Keychain-only vault, and `transient`: unwrapped
   * for this call and wiped right after (adding an item needs nothing that isn't already on this Mac).
   */
  private withKey<T>(fn: (mk: Buffer, h: Header) => T, o: { transient?: boolean } = {}): T {
    const h = this.header()
    if (!h) throw new Error('No vault yet.')
    if (this.mk) return fn(this.mk, h)
    if (!o.transient || h.kdf) throw new VaultLockedError()
    const mk = this.unwrapKeychainOnly(h)
    try { return fn(mk, h) } finally { wipe(mk) }
  }

  /** Encrypts and stores an item (a new version with a new data key every time). Returns its id. */
  put(type: ItemType, meta: ItemMeta, payload: Record<string, unknown>, o: { id?: string; transient?: boolean } = {}): string {
    if (!ITEM_TYPES.includes(type)) throw new Error('Unknown item type')
    return this.withKey((mk, h) => {
      const id = o.id ?? randomUUID()
      const prev = this.o.storage.row(id)
      if (prev && prev.type !== type) throw new Error('An item with that id has another type.')
      const ver = (prev?.ver ?? 0) + 1
      const cleanMeta = JSON.parse(JSON.stringify(meta)) as ItemMeta
      const dk = randomKey()
      const plain = Buffer.from(JSON.stringify(payload), 'utf8')
      try {
        const row: VaultRow = {
          id, type, ver, meta: JSON.stringify(cleanMeta),
          dk: b64(seal(mk, dk, this.dkAad(h, id))),
          body: b64(seal(dk, plain, this.itemAad(h, { id, type, ver, meta: cleanMeta }))),
          created: prev?.created ?? this.now(), updated: this.now()
        }
        this.o.storage.atomic(() => {
          this.o.storage.put(row)
          const items = { ...this.header()!.manifest.items, [id]: ver }
          this.o.storage.set(HEADER, { ...this.header()!, manifest: { items, mac: this.manifestMac(h, mk, items) } })
        })
      } finally {
        wipe(dk, plain)
      }
      this.guard = null
      this.touch()
      this.onChange('items')
      return id
    }, { transient: o.transient })
  }

  /** Decrypts one item. Throws VaultLockedError, TamperError (manifest/AAD mismatch) or VaultCryptoError. */
  get(id: string): Item | undefined {
    const r = this.o.storage.row(id)
    if (!r) return undefined
    return this.withKey((mk, h) => this.decryptRow(r, mk, h))
  }

  private decryptRow(r: VaultRow, mk: Buffer, h: Header): Item {
    if (this.tampered) throw new TamperError('The vault index was changed outside SahilBot. Review it in Settings → Privacy & Security → Passwords before items are used again.')
    if (h.manifest.items[r.id] !== r.ver) {
      this.o.audit.add({ event: 'tamper', item: safeName(r), outcome: 'blocked', detail: 'Item is missing from the signed index or is an older version' })
      throw new TamperError()
    }
    let meta: ItemMeta
    try { meta = JSON.parse(r.meta) as ItemMeta } catch { throw new TamperError() }
    let dk: Buffer | undefined
    let plain: Buffer | undefined
    try {
      dk = open(mk, unb64(r.dk), this.dkAad(h, r.id))
      plain = open(dk, unb64(r.body), this.itemAad(h, { id: r.id, type: r.type, ver: r.ver, meta }))
      const payload = JSON.parse(plain.toString('utf8')) as Record<string, unknown>
      this.touch()
      return { id: r.id, type: r.type as ItemType, ver: r.ver, meta, payload, created: r.created, updated: r.updated }
    } catch (e) {
      if (e instanceof VaultCryptoError) this.o.audit.add({ event: 'tamper', item: meta.name, outcome: 'blocked', detail: 'Ciphertext or its metadata was changed' })
      throw e instanceof VaultCryptoError ? new TamperError() : e
    } finally {
      wipe(dk, plain)
    }
  }

  remove(id: string): void {
    const r = this.o.storage.row(id)
    if (!r) return
    this.withKey((mk, h) => {
      this.o.storage.atomic(() => {
        this.o.storage.del(id)
        const items = { ...this.header()!.manifest.items }
        delete items[id]
        this.o.storage.set(HEADER, { ...this.header()!, manifest: { items, mac: this.manifestMac(h, mk, items) } })
      })
    }, { transient: true })
    this.guard = null
    this.onChange('items')
  }

  /** Metadata only: works while locked. */
  list(type?: ItemType): ItemSummary[] {
    const out: ItemSummary[] = []
    for (const r of this.o.storage.rows()) {
      if (type && r.type !== type) continue
      let meta: ItemMeta
      try { meta = JSON.parse(r.meta) as ItemMeta } catch { continue }
      out.push({ id: r.id, type: r.type as ItemType, ver: r.ver, meta, created: r.created, updated: r.updated })
    }
    return out
  }

  /** Accepts the current rows as genuine after a tamper warning (the user reviewed them). */
  resign(): void {
    if (!this.mk) throw new VaultLockedError('Unlock the vault first.')
    const h = this.header()!
    const items = Object.fromEntries(this.o.storage.rows().map((r) => [r.id, r.ver]))
    this.o.storage.set(HEADER, { ...h, manifest: { items, mac: this.manifestMac(h, this.mk, items) } })
    this.tampered = false
    this.o.audit.add({ event: 'tamper', outcome: 'ok', detail: 'Index re-signed after review' })
    this.onChange('items')
  }

  // ------------------------------------------------------------------ leak checks and redaction

  /** Values typed into a page stay masked for 30 minutes, even after the vault locks. */
  noteFilled(values: string[], ms = 30 * 60_000): void {
    const until = this.now() + ms
    for (const v of values) if (v && v.length >= 4) this.recent.push({ value: v, until })
  }

  /**
   * Every saved secret value (unlocked), or those typed recently (locked): for the leak check on tool
   * arguments and the redaction of tool output.
   */
  guardValues(): string[] {
    const now = this.now()
    this.recent = this.recent.filter((r) => r.until > now)
    const recent = this.recent.map((r) => r.value)
    if (!this.mk || this.computingGuard) return [...new Set(recent)]
    if (!this.guard) {
      const vals: string[] = []
      const h = this.header()!
      // Decrypting can write a tamper entry, whose scrubber asks for these values: no re-entry.
      this.computingGuard = true
      try {
        for (const r of this.o.storage.rows()) {
          try { const it = this.decryptRow(r, this.mk, h); vals.push(...secretFields(it.type, it.payload)) } catch { /* tampered rows are skipped */ }
        }
      } finally { this.computingGuard = false }
      this.guard = vals
    }
    return [...new Set([...this.guard, ...recent])]
  }

  // ------------------------------------------------------------------ encrypted backup

  /**
   * An encrypted export: the same envelope format, with a fresh export key wrapped under the backup
   * password alone (scrypt/Argon2id), so it can be restored on another Mac. Never contains plaintext.
   */
  async exportBundle(password: string): Promise<string> {
    if (!this.mk) throw new VaultLockedError('Unlock the vault first.')
    if (String(password ?? '').length < 10) throw new Error('Use a backup password of at least 10 characters.')
    const items = this.o.storage.rows().map((r) => this.decryptRow(r, this.mk!, this.header()!))
    const params = await (this.o.kdf ?? (() => benchmarkKdf()))()
    const id = randomUUID()
    const salt = randomBytes(32)
    const ek = randomKey()
    const pwKey = await deriveFromPassword(password, params)
    const kek = hkdf(pwKey, salt, `sahilbot-vault/export/v1/${id}`)
    try {
      const fake: Header = { format: 'sahilbot-vault', v: 1, id, salt: b64(salt), created: this.now(), wrap: '', manifest: { items: {}, mac: '' } }
      const rows = items.map((it) => {
        const dk = randomKey()
        const plain = Buffer.from(JSON.stringify(it.payload), 'utf8')
        try {
          return { id: it.id, type: it.type, ver: it.ver, meta: it.meta, created: it.created, updated: it.updated, dk: b64(seal(ek, dk, this.dkAad(fake, it.id))), body: b64(seal(dk, plain, this.itemAad(fake, it))) }
        } finally { wipe(dk, plain) }
      })
      const bundle = {
        format: 'sahilbot-vault-export', v: 1, id, created: this.now(), kdf: params, salt: b64(salt),
        key: b64(seal(kek, ek, `sahilbot-vault/export-key/v1/${id}`)),
        items: rows
      }
      return JSON.stringify(bundle, null, 1)
    } finally {
      wipe(ek, pwKey, kek)
    }
  }

  /** Reads an export (all items are decrypted and checked before anything is written). */
  async readBundle(text: string, password: string): Promise<Array<Omit<Item, 'ver'>>> {
    let b: { format?: string; v?: number; id: string; kdf: KdfParams; salt: string; key: string; items: Array<{ id: string; type: ItemType; ver: number; meta: ItemMeta; dk: string; body: string; created: number; updated: number }> }
    try { b = JSON.parse(text) } catch { throw new Error('That file isn\'t a SahilBot vault backup.') }
    if (b?.format !== 'sahilbot-vault-export' || b.v !== 1 || !Array.isArray(b.items)) throw new Error('That file isn\'t a SahilBot vault backup.')
    const pwKey = await deriveFromPassword(password, b.kdf)
    const kek = hkdf(pwKey, unb64(b.salt), `sahilbot-vault/export/v1/${b.id}`)
    let ek: Buffer | undefined
    try {
      try { ek = open(kek, unb64(b.key), `sahilbot-vault/export-key/v1/${b.id}`) } catch { throw new Error('Wrong backup password, or the file was changed.') }
      const fake: Header = { format: 'sahilbot-vault', v: 1, id: b.id, salt: b.salt, created: 0, wrap: '', manifest: { items: {}, mac: '' } }
      return b.items.map((r) => {
        if (!ITEM_TYPES.includes(r.type)) throw new Error('The backup contains an unknown item type.')
        let dk: Buffer | undefined
        let plain: Buffer | undefined
        try {
          dk = open(ek!, unb64(r.dk), this.dkAad(fake, r.id))
          plain = open(dk, unb64(r.body), this.itemAad(fake, r))
          return { id: r.id, type: r.type, meta: r.meta, payload: JSON.parse(plain.toString('utf8')) as Record<string, unknown>, created: r.created, updated: r.updated }
        } catch {
          throw new Error('The backup was changed or damaged, so nothing was imported.')
        } finally { wipe(dk, plain) }
      })
    } finally {
      wipe(pwKey, kek, ek)
    }
  }

  /** Writes several items in one transaction (import, migration): all or nothing. */
  putMany(items: Array<{ type: ItemType; meta: ItemMeta; payload: Record<string, unknown>; id?: string }>, o: { transient?: boolean } = {}): string[] {
    return this.o.storage.atomic(() => items.map((it) => this.put(it.type, it.meta, it.payload, { id: it.id, transient: o.transient })))
  }

  /** Runs fn with the vault usable for one call even while locked (Keychain-only vaults only). */
  transiently<T>(fn: () => T): T {
    if (this.mk) return fn()
    const h = this.header()
    if (!h || h.kdf) throw new VaultLockedError()
    const mk = this.unwrapKeychainOnly(h)
    this.mk = mk
    try { return fn() } finally { wipe(mk); this.mk = null; this.guard = null }
  }

  /** Runs fn as one transaction on the vault's storage (all of it is undone if fn throws). */
  atomic<T>(fn: () => T): T {
    return this.o.storage.atomic(fn)
  }

  /** For the audit log's scrubber. */
  get auditLog(): AuditLog { return this.o.audit }
}

function safeName(r: VaultRow): string {
  try { return String((JSON.parse(r.meta) as ItemMeta).name ?? '') } catch { return '' }
}
