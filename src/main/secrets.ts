import { safeStorage } from 'electron'
import type { Db } from './db'

// Secrets (API keys, connector tokens, and the vault's Keychain key K1: see src/main/secure/core.ts) are
// encrypted with the macOS Keychain-backed safeStorage key and never sent to the renderer or the model.
// Vault items themselves are no longer stored here one by one: they live in the envelope vault, and the
// old per-item entries are only read to migrate them (src/main/secure/legacy.ts).
export class Secrets {
  constructor(private db: Db) {}

  set(name: string, value: string | null): void {
    if (value === null || value === '') {
      this.db.setSetting(`secret:${name}`, null)
      return
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is unavailable; refusing to store a secret in plain text.')
    this.db.setSetting(`secret:${name}`, safeStorage.encryptString(value).toString('base64'))
  }

  /**
   * A secret the Keychain can no longer unlock (e.g. the app was renamed or moved to a new Mac) reads
   * as missing instead of crashing, so Settings simply asks for it again.
   */
  get(name: string): string | undefined {
    const enc = this.db.getSetting<string | null>(`secret:${name}`)
    if (!enc) return undefined
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      this.unreadable.add(name)
      return undefined
    }
  }

  /** Whether the Keychain-backed encryption key can be used (the vault refuses to start without it). */
  available(): boolean {
    try { return safeStorage.isEncryptionAvailable() } catch { return false }
  }

  /** Saved but readable (an unreadable one counts as not saved). */
  has(name: string): boolean {
    return !!this.db.getSetting<string | null>(`secret:${name}`) && this.get(name) !== undefined
  }

  /** Secrets that exist but couldn't be decrypted this session. */
  readonly unreadable = new Set<string>()
}
