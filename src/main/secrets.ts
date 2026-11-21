import { safeStorage } from 'electron'
import { execFileSync, spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import type { Db } from './db'

// Secrets (API keys, connector tokens, and the vault's Keychain key K1: see src/main/secure/core.ts) are
// encrypted and never sent to the renderer or the model.
//
// On the Mac they're sealed (AES-256-GCM) with SahilBot's own key, kept in a Keychain item ("SahilBot Secrets
// Key") that the system's security tool owns. That item doesn't depend on the app's code signature, so an update
// (a new build, signed differently) still opens it: keys survive updates.
//
// Older builds used Electron's safeStorage, whose Keychain item ("SahilBot Safe Storage") only opens for the
// exact build that made it when the app is ad-hoc signed. Those entries are moved over the first time they're
// read: by safeStorage when it still works, else with that item's password, which macOS asks the user to allow
// once. Without a Keychain (tests, the server) safeStorage is used as before.

const V2 = 'v2:'

/**
 * Where the secrets key lives (the Mac's Keychain, through /usr/bin/security).
 *
 * The one rule that keeps keys from vanishing: a new key is made ONLY when the Keychain says the item doesn't
 * exist. Any other failure (Keychain still locked after login, a slow answer, a dismissed prompt) throws, and
 * nothing is created or overwritten; the next read tries again. A second Keychain item holds a backup copy of
 * the key, so even a deleted primary item is restored instead of replaced.
 */
export interface KeyStore {
  /** The key; undefined only when the Keychain says there is none. Throws when the Keychain didn't answer properly. */
  get(): Buffer | undefined
  /** Makes and saves a new key (never overwriting an existing item). */
  create(): Buffer
  /** The backup copy (undefined: none). Throws when the Keychain didn't answer properly. */
  getBackup?(): Buffer | undefined
  /** Writes the backup copy (when missing or different). */
  saveBackup?(k: Buffer): void
  /** Puts the key back in the primary item (it was missing). */
  restore?(k: Buffer): void
  /** The password of the old safeStorage item (macOS asks the user to allow it once), to move old entries over. */
  legacyPassword(): string | undefined
}

const SECURITY = '/usr/bin/security'
const SERVICE = 'SahilBot Secrets Key'
const BACKUP_SERVICE = 'SahilBot Secrets Key (backup copy)'
const ACCOUNT = 'SahilBot'
/** security's exit code for errSecItemNotFound, and for errSecDuplicateItem. */
const NOT_FOUND = 44
const DUPLICATE = 45

/** Thrown when the Keychain didn't give a clear answer: nothing is created, the next read tries again. */
export class KeychainUnavailable extends Error {}

/** Reads one item: the key, undefined when the item doesn't exist, or throws on any other failure. */
function readItem(service: string): Buffer | undefined {
  const r = spawnSync(SECURITY, ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] })
  if (r.status === NOT_FOUND) return undefined
  if (r.status !== 0 || r.error) throw new KeychainUnavailable(`The Keychain didn't answer (${r.error ? r.error.message : `status ${r.status}`}).`)
  const hex = String(r.stdout ?? '').trim()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new KeychainUnavailable('The Keychain item holds something unexpected; leaving it alone.')
  return Buffer.from(hex, 'hex')
}

/** Adds an item (never -U: an existing item is never overwritten). Returns false when one already exists. */
function addItem(service: string, k: Buffer, comment: string): boolean {
  const r = spawnSync(SECURITY, ['add-generic-password', '-s', service, '-a', ACCOUNT, '-l', service, '-j', comment, '-w', k.toString('hex'), '-T', SECURITY], { timeout: 20_000, stdio: 'ignore' })
  if (r.status === DUPLICATE) return false
  if (r.status !== 0 || r.error) throw new KeychainUnavailable(`The Keychain refused to save (${r.error ? r.error.message : `status ${r.status}`}).`)
  return true
}

export function macKeyStore(appName = 'SahilBot'): KeyStore {
  const note = 'SahilBot encrypts your API keys with this. Deleting it makes saved keys unreadable.'
  return {
    get: () => readItem(SERVICE),
    create() {
      const k = randomBytes(32)
      if (!addItem(SERVICE, k, note)) {
        // Someone made it between our read and now: use theirs.
        const existing = readItem(SERVICE)
        if (existing) return existing
        throw new KeychainUnavailable('The Keychain says the key exists but won\'t return it.')
      }
      try { addItem(BACKUP_SERVICE, k, 'A backup copy of the SahilBot Secrets Key.') } catch { /* the primary is saved; the backup is written on a later read */ }
      return k
    },
    getBackup: () => readItem(BACKUP_SERVICE),
    saveBackup(k) {
      // Only written when missing: an existing backup is never replaced (it may be the only copy of an older key).
      addItem(BACKUP_SERVICE, k, 'A backup copy of the SahilBot Secrets Key.')
    },
    restore(k) { addItem(SERVICE, k, note) },
    legacyPassword() {
      try {
        return execFileSync(SECURITY, ['find-generic-password', '-s', `${appName} Safe Storage`, '-w'], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined
      } catch { return undefined }
    }
  }
}

/** AES-256-GCM: "v2:" + base64(iv · tag · ciphertext). */
export function seal(key: Buffer, value: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()])
  return V2 + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}

export function open(key: Buffer, sealed: string): string {
  const b = Buffer.from(sealed.slice(V2.length), 'base64')
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
  d.setAuthTag(b.subarray(12, 28))
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
}

/** What Electron's safeStorage wrote on macOS (Chromium's "v10": AES-128-CBC, key from the Keychain password). */
export function openLegacy(enc: Buffer, password: string): string {
  if (enc.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('Not a safeStorage value.')
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([d.update(enc.subarray(3)), d.final()]).toString('utf8')
}

export class Secrets {
  /** The secrets key: undefined until found, null when there's no Keychain at all (tests, the server). */
  private master?: Buffer | null
  /** The old item's password, asked for at most once a session. */
  private legacy?: string | null
  /** After the Keychain didn't answer: when to ask again (never sooner, so a locked Keychain isn't hammered). */
  private retryAt = 0
  /** Why the key couldn't be read last time ('' when it's fine). */
  lastKeyError = ''

  constructor(private db: Db, private keys: KeyStore | null = null) {}

  /** Secrets sealed with SahilBot's own key are saved (so a brand-new key would orphan them). */
  private hasSealed(): boolean {
    try { return this.db.settingKeys('secret:').some((k) => String(this.db.getSetting<string | null>(k) ?? '').startsWith(V2)) } catch { return false }
  }

  private key(): Buffer | undefined {
    if (this.master !== undefined) return this.master ?? undefined
    if (!this.keys) { this.master = null; return undefined }
    if (Date.now() < this.retryAt) return undefined
    try {
      let k = this.keys.get()
      if (!k && this.keys.getBackup) {
        // The primary item is gone: the backup copy brings it back (instead of a new key that can't open anything).
        const b = this.keys.getBackup()
        if (b) { try { this.keys.restore?.(b) } catch { /* use it this session anyway */ } k = b }
      }
      if (!k) {
        if (this.hasSealed()) console.warn('[secrets] the Keychain has no SahilBot key but sealed keys exist; making a new key (the old ones stay saved and come back if the key does)')
        k = this.keys.create()
      } else if (this.keys.saveBackup) {
        try { const b = this.keys.getBackup?.(); if (!b) this.keys.saveBackup(k) } catch { /* try again next launch */ }
      }
      this.master = k
      this.lastKeyError = ''
      return k
    } catch (e) {
      // Not "no key": the Keychain didn't answer. Nothing is created or overwritten; ask again in a bit.
      this.lastKeyError = (e as Error).message
      this.retryAt = Date.now() + 15_000
      return undefined
    }
  }

  set(name: string, value: string | null): void {
    if (value === null || value === '') {
      this.db.setSetting(`secret:${name}`, null)
      this.unreadable.delete(name)
      return
    }
    const k = this.key()
    if (k) this.db.setSetting(`secret:${name}`, seal(k, value))
    else if (this.keys) {
      // On the Mac, never fall back to safeStorage (it breaks on the next update): say so and keep nothing half-saved.
      throw new Error(`macOS Keychain didn't answer, so the key wasn't saved. Unlock your Mac's Keychain and try again.${this.lastKeyError ? ` (${this.lastKeyError})` : ''}`)
    } else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable; refusing to store a secret in plain text.')
      this.db.setSetting(`secret:${name}`, safeStorage.encryptString(value).toString('base64'))
    }
    this.unreadable.delete(name)
  }

  /**
   * A secret nothing can unlock any more (its Keychain item was deleted, or the user said no to the one-time
   * prompt) reads as missing instead of crashing, so Settings asks for it again. It's kept, not deleted: allowing
   * access later brings it back.
   */
  get(name: string): string | undefined {
    const enc = this.db.getSetting<string | null>(`secret:${name}`)
    if (!enc) return undefined
    if (enc.startsWith(V2)) {
      const k = this.key()
      try { if (k) return open(k, enc) } catch { /* another key: unreadable below */ }
      this.unreadable.add(name)
      return undefined
    }
    let value: string | undefined
    try { value = safeStorage.decryptString(Buffer.from(enc, 'base64')) } catch { value = undefined }
    if (value === undefined && this.keys) {
      // Written by an earlier build: the old item's password opens it (macOS asks once, then remembers).
      if (this.legacy === undefined) this.legacy = this.keys.legacyPassword() ?? null
      if (this.legacy) { try { value = openLegacy(Buffer.from(enc, 'base64'), this.legacy) } catch { value = undefined } }
    }
    if (value === undefined) {
      this.unreadable.add(name)
      return undefined
    }
    // Moved to the key that survives updates.
    const k = this.key()
    if (k) { try { this.db.setSetting(`secret:${name}`, seal(k, value)) } catch { /* stays as it was; read again next time */ } }
    this.unreadable.delete(name)
    return value
  }

  /** Whether secrets can be stored (the vault refuses to start without it). */
  available(): boolean {
    if (this.key()) return true
    try { return safeStorage.isEncryptionAvailable() } catch { return false }
  }

  /** Saved and readable (an unreadable one counts as not saved). */
  has(name: string): boolean {
    return !!this.db.getSetting<string | null>(`secret:${name}`) && this.get(name) !== undefined
  }

  /** Secrets that exist but couldn't be decrypted this session. */
  readonly unreadable = new Set<string>()

  /** Saved keys that can't be read right now (the Keychain is locked or didn't answer): they're kept, not lost. */
  locked(): { count: number; reason: string } {
    return { count: this.unreadable.size, reason: this.lastKeyError }
  }
}
