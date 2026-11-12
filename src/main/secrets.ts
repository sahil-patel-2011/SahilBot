import { safeStorage } from 'electron'
import type { Db } from './db'

// Secrets (API keys now, vault entries later) are encrypted with the macOS
// Keychain-backed safeStorage key and never sent to the renderer or the model.
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

  /** Saved but readable (an unreadable one counts as not saved). */
  has(name: string): boolean {
    return !!this.db.getSetting<string | null>(`secret:${name}`) && this.get(name) !== undefined
  }

  /** Secrets that exist but couldn't be decrypted this session. */
  readonly unreadable = new Set<string>()
}
