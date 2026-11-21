import { safeStorage } from 'electron'
import { execFileSync } from 'node:child_process'
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

/** Where the secrets key lives (the Mac's Keychain, through /usr/bin/security). */
export interface KeyStore {
  /** The key, if one was made before. */
  get(): Buffer | undefined
  /** Makes and saves a new key. */
  create(): Buffer
  /** The password of the old safeStorage item (macOS asks the user to allow it once), to move old entries over. */
  legacyPassword(): string | undefined
}

const SECURITY = '/usr/bin/security'
const SERVICE = 'SahilBot Secrets Key'
const ACCOUNT = 'SahilBot'

export function macKeyStore(appName = 'SahilBot'): KeyStore {
  return {
    get() {
      try {
        const hex = execFileSync(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : undefined
      } catch { return undefined }
    },
    create() {
      const k = randomBytes(32)
      execFileSync(SECURITY, ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-l', SERVICE, '-j', 'SahilBot encrypts your API keys with this. Deleting it makes saved keys unreadable.', '-w', k.toString('hex'), '-T', SECURITY], { timeout: 15_000, stdio: 'ignore' })
      return k
    },
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
  /** The secrets key: undefined until first needed, null when there's none (no Keychain, or it refused). */
  private master?: Buffer | null
  /** The old item's password, asked for at most once a session. */
  private legacy?: string | null

  constructor(private db: Db, private keys: KeyStore | null = null) {}

  private key(): Buffer | undefined {
    if (this.master === undefined) {
      if (!this.keys) this.master = null
      else { try { this.master = this.keys.get() ?? this.keys.create() } catch { this.master = null } }
    }
    return this.master ?? undefined
  }

  set(name: string, value: string | null): void {
    if (value === null || value === '') {
      this.db.setSetting(`secret:${name}`, null)
      this.unreadable.delete(name)
      return
    }
    const k = this.key()
    if (k) this.db.setSetting(`secret:${name}`, seal(k, value))
    else {
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
}
