// Test helpers for the secrets vault: an in-memory database, a Map standing in for the Keychain, a
// controllable clock and tiny KDF parameters (same code path, fast).

import { Db } from '../../src/main/db'
import { Vault, type SecretStrings } from '../../src/main/vault'
import { MemoryAuditLog } from '../../src/main/secure/audit'
import { SecureVault, type KeyStore } from '../../src/main/secure/core'
import { MemoryVaultStorage } from '../../src/main/secure/storage'
import { VaultAuth, type AuthUi, type TouchId } from '../../src/main/secure/auth'
import type { VaultAuthRequest } from '../../src/shared/types'

/** Test values only (Stripe's public test card number). */
export const SECRET = { password: 'correct horse battery staple 42', card: '4242424242424242', cvc: '913', id: 'X12345678', totp: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', note: 'recovery words: amber lantern orbit', master: 'a long master passphrase' }

export const quickKdf = async () => ({ alg: 'scrypt' as const, N: 1024, r: 8, p: 1, salt: Buffer.alloc(16, 7).toString('base64'), ms: 1 })

export class FakeKeychain implements KeyStore, SecretStrings {
  m = new Map<string, string>()
  ok = true
  get(n: string): string | undefined { return this.m.get(n) }
  set(n: string, v: string | null): void { if (v === null || v === '') this.m.delete(n); else this.m.set(n, v) }
  available(): boolean { return this.ok }
}

export class Clock {
  t = Date.UTC(2026, 10, 15, 12, 0, 0)
  now = (): number => this.t
  advance(ms: number): void { this.t += ms }
}

export function makeCore(o: { clock?: Clock; keys?: FakeKeychain; storage?: MemoryVaultStorage; audit?: MemoryAuditLog } = {}) {
  const clock = o.clock ?? new Clock()
  const keys = o.keys ?? new FakeKeychain()
  const storage = o.storage ?? new MemoryVaultStorage()
  const audit = o.audit ?? new MemoryAuditLog(clock.now)
  const core = new SecureVault({ storage, keys, audit, now: clock.now, kdf: quickKdf })
  core.init()
  return { core, clock, keys, storage, audit }
}

/** A dialog that answers each request with whatever the test queued (default: cancel). */
export class FakeUi implements AuthUi {
  shown: VaultAuthRequest[] = []
  answers: Array<{ password?: string; cancel?: boolean; touchId?: boolean }> = []
  auth?: VaultAuth
  up = true
  available(): boolean { return this.up }
  show(req: VaultAuthRequest): void {
    this.shown.push(req)
    // Like a user at the dialog: a wrong password leaves it open, and the next queued answer is tried.
    const go = async (): Promise<void> => {
      const a = this.answers.shift() ?? { cancel: true }
      const r = await this.auth!.respond(req.id, a)
      if (!r.ok) await go()
    }
    setTimeout(() => void go(), 0)
  }
  done(): void { /* closed */ }
}

export function makeVault(o: { clock?: Clock; touch?: TouchId; db?: Db; secrets?: FakeKeychain; masterPassword?: string } = {}) {
  const clock = o.clock ?? new Clock()
  const db = o.db ?? new Db(':memory:')
  const secrets = o.secrets ?? new FakeKeychain()
  const audit = new MemoryAuditLog(clock.now)
  const vault = new Vault(db, secrets, { now: clock.now, kdf: quickKdf, audit })
  const ui = new FakeUi()
  const touch: TouchId = o.touch ?? { available: () => false, prompt: async () => false }
  vault.auth = new VaultAuth({ core: vault.core, touch, ui, now: clock.now, timeoutMs: 2000 })
  ui.auth = vault.auth
  vault.start()
  return { vault, db, secrets, ui, clock, audit }
}

/** Saves one of everything with the known SECRET values. */
export function fillVault(vault: Vault, site = 'https://acme.test'): void {
  vault.set({ name: 'acme', origin: site, username: 'sam@example.test', password: SECRET.password, totp: SECRET.totp })
  vault.setAddress({ nickname: 'Home', name: 'Sam Rivera', line1: '1 Main St', city: 'Albany', region: 'NY', postal: '12207', country: 'US' })
  vault.setCard({ nickname: 'Personal', number: SECRET.card, cvc: SECRET.cvc, expMonth: '08', expYear: '2031', holder: 'Sam Rivera' })
  vault.saveItem({ type: 'identity', name: 'Passport', kind: 'passport', number: SECRET.id, fullName: 'Sam Rivera', sites: 'https://visa.example.gov' })
  vault.saveItem({ type: 'note', name: 'Recovery', body: SECRET.note })
}
