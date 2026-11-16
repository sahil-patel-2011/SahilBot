// Settings → Privacy & Security → Passwords talks to main only through these handlers. Every reply is metadata (names, sites,
// brand, last 4, expiry, counts, audit rows) except reveal and totpCode, which show a value to the user
// after Touch ID or the master password, with the window's content protected from screen capture.
// tests/unit/vault-ipc.test.ts calls every handler with a known secret saved and scans the replies.

import type { VaultStatus } from '@shared/types'
import type { Vault } from '../vault'
import { VaultLockedError } from './core'
import type { VaultAuth } from './auth'
import type { SaveOffers } from './offers'

export interface VaultFiles {
  /** Save / open dialogs (null = cancelled). */
  saveBackup(defaultName: string): Promise<string | null>
  openBackup(): Promise<string | null>
  openCsv(): Promise<string | null>
  write(path: string, text: string): void
  read(path: string): string
}

export interface VaultIpcDeps {
  vault: Vault
  auth: VaultAuth
  purchases: { permanent(): string[]; revokeOtp(site: string): string[] }
  touchIdAvailable(): boolean
  keychainAvailable(): boolean
  files: VaultFiles
  /** Hides the asking window from screenshots and screen recording while a value is shown. */
  protect(sender: unknown, ms: number): void
  /** "Save to Vault?" offers (browser panel and chat). */
  offers?: SaveOffers
  /** An offer was saved, dismissed or turned into "never" (main updates the chat message and the panel). */
  onOffer?(e: { id: string; status: 'saved' | 'dismissed'; name?: string; messageId?: string; offer?: VaultSaveOfferLike }): void
}

type VaultSaveOfferLike = import('@shared/types').VaultSaveOffer

export type VaultHandler = (sender: unknown, ...args: any[]) => unknown

/** Channels whose replies may carry a value (shown to the user after authentication). */
export const REVEAL_CHANNELS = new Set(['vault:reveal', 'vault:totpCode'])

export function vaultHandlers(d: VaultIpcDeps): Record<string, VaultHandler> {
  const { vault, auth } = d
  const status = (): VaultStatus => {
    const s = vault.core.status()
    return {
      exists: s.exists, locked: s.locked, masterPassword: s.masterPassword, bio: s.bio,
      touchIdAvailable: d.touchIdAvailable(), presenceOnly: vault.presenceOnly(),
      ...(s.kdf ? { kdf: s.kdf } : {}), counts: s.counts, tampered: s.tampered, retryInMs: s.retryInMs,
      prefs: vault.prefs(), keychain: d.keychainAvailable(), legacy: vault.legacyState()
    }
  }
  const unlocked = (why: string): Promise<void> => vault.ensureUnlocked(why, true)

  const h: Record<string, VaultHandler> = {
    // ---- compatible channels (older Settings, tests)
    'vault:list': () => vault.list(),
    'vault:set': (_s, e: Parameters<Vault['set']>[0]) => { vault.set(e); return vault.list() },
    'vault:remove': (_s, name: string) => { vault.remove(name); return vault.list() },
    'vault:totpCode': async (sender, name: string) => {
      await unlocked('show an authenticator code')
      await vault.reauth('reveal', `show the authenticator code for "${String(name).slice(0, 60)}"`)
      const c = vault.totpCode(name)
      if (!c) return null
      d.protect(sender, 31_000)
      return { code: c.code, remaining: c.remaining }
    },
    'vault:otpGrants': () => d.purchases.permanent(),
    'vault:revokeOtpGrant': (_s, site: string) => d.purchases.revokeOtp(site),
    'vault:cards': () => vault.cards(),
    'vault:setCard': (_s, c: Parameters<Vault['setCard']>[0]) => vault.setCard(c),
    'vault:removeCard': (_s, id: string) => vault.removeCard(id),
    'vault:addresses': () => vault.addresses(),
    'vault:setAddress': (_s, a: Parameters<Vault['setAddress']>[0]) => vault.setAddress(a),
    'vault:removeAddress': (_s, id: string) => vault.removeAddress(id),

    // ---- the envelope vault
    'vault:status': () => status(),
    'vault:items': () => vault.items(),
    'vault:saveItem': (_s, input: Parameters<Vault['saveItem']>[0]) => { vault.saveItem(input); return vault.items() },
    'vault:removeItem': (_s, id: string) => { vault.removeItem(id); return vault.items() },
    'vault:unlock': async () => {
      // Nothing stronger than a click exists: the click on Unlock in Settings is it (no second dialog).
      if (vault.presenceOnly() && !vault.isUnlocked()) vault.core.unlockKeychain('presence')
      else await unlocked('open your vault in Settings')
      return status()
    },
    'vault:lock': () => { vault.lock('locked from Settings'); return status() },
    'vault:reveal': async (sender, id: string) => {
      const it = vault.items().find((x) => x.id === id)
      if (!it) return null
      await unlocked(`show "${it.name}"`)
      await vault.reauth('reveal', `show "${it.name}"`)
      const r = vault.revealFields(id)
      d.protect(sender, r.hideAfterMs + 5000)
      return r
    },
    'vault:setPrefs': async (_s, p: Partial<VaultStatus['prefs']>) => {
      // Loosening a protection needs the user: Touch ID or the master password.
      const cur = vault.prefs()
      const looser = (p.autoLockMinutes !== undefined && (p.autoLockMinutes === 0 || (cur.autoLockMinutes !== 0 && p.autoLockMinutes > cur.autoLockMinutes))) || (p.lockOnSleep === false && cur.lockOnSleep) || (p.reauthPasswords === false && cur.reauthPasswords) || (p.touchId === false && cur.touchId)
      if (looser) await vault.reauth('settings', 'change how your vault locks')
      vault.core.setPrefs(p)
      return status()
    },
    'vault:setMasterPassword': async (_s, next: string, current?: string) => {
      await unlocked('set a master password')
      await vault.core.setMasterPassword(String(next ?? ''), current)
      auth.forget()
      return status()
    },
    'vault:removeMasterPassword': async (_s, current: string) => {
      await unlocked('remove the master password')
      await vault.core.removeMasterPassword(String(current ?? ''))
      return status()
    },
    'vault:setTouchIdUnlock': async (_s, on: boolean) => {
      if (on) {
        if (!d.touchIdAvailable()) throw new Error('This Mac has no Touch ID.')
        await unlocked('turn on Touch ID unlock')
        await vault.reauth('settings', 'turn on Touch ID for your vault')
        vault.core.setPrefs({ touchId: true })
        vault.core.enableBio()
      } else {
        // Without a master password, Touch ID is the only check: turning it off makes unlocking a click.
        if (!vault.core.hasMasterPassword()) await vault.reauth('settings', 'turn off Touch ID for your vault')
        vault.core.disableBio()
        vault.core.setPrefs({ touchId: false })
      }
      return status()
    },
    'vault:audit': (_s, limit?: number) => vault.auditEntries(Math.max(1, Math.min(2000, Number(limit) || 300))),
    'vault:exportBackup': async (_s, password: string) => {
      await unlocked('export an encrypted backup')
      await vault.reauth('export', 'export an encrypted backup of your vault')
      const path = await d.files.saveBackup(`SahilBot Vault ${new Date().toISOString().slice(0, 10)}.sbvault`)
      if (!path) return { ok: false }
      const { text, count } = await vault.exportBackup(String(password ?? ''))
      d.files.write(path, text)
      return { ok: true, path, count }
    },
    'vault:importBackup': async (_s, password: string) => {
      await unlocked('import a backup')
      const path = await d.files.openBackup()
      if (!path) return { ok: false }
      const r = await vault.importBackup(d.files.read(path), String(password ?? ''))
      return { ok: true, ...r }
    },
    'vault:importCsv': async () => {
      const path = await d.files.openCsv()
      if (!path) return { ok: false }
      const r = vault.importCsv(d.files.read(path))
      return { ok: true, ...r, path }
    },
    'vault:purgeLegacy': async () => {
      await unlocked('remove the old copies')
      await vault.reauth('settings', 'remove the old unprotected copies')
      vault.purgeLegacy()
      return status()
    },
    'vault:rollback': async () => {
      await unlocked('write a rollback copy')
      await vault.reauth('settings', 'write your items back in the old format')
      vault.rollback()
      return status()
    },
    'vault:resign': async () => {
      await unlocked('review the vault')
      await vault.reauth('settings', 'accept the vault as it is now')
      vault.core.resign()
      return status()
    },
    // ---- "Save to Vault?" (values never cross: only ids, the user's edits and the saved item's name)
    'vault:offerSave': async (_s, id: string, edits?: import('@shared/types').VaultSaveEdits, messageId?: string) => {
      if (!d.offers) throw new Error('Saving from here is not available.')
      const e = (edits && typeof edits === 'object' ? edits : {}) as import('@shared/types').VaultSaveEdits
      const clean: import('@shared/types').VaultSaveEdits = {}
      for (const k of ['name', 'site', 'username', 'holder'] as const) if (typeof e[k] === 'string') clean[k] = String(e[k]).slice(0, 300)
      for (const k of ['expMonth', 'expYear'] as const) if (typeof e[k] === 'string' || typeof e[k] === 'number') clean[k] = String(e[k]).slice(0, 4)
      if (e.rememberCvc === true) clean.rememberCvc = true
      const r = await d.offers.save(String(id ?? ''), clean)
      d.onOffer?.({ id: String(id), status: 'saved', name: r.name, ...(typeof messageId === 'string' ? { messageId } : {}), offer: r.offer })
      return { ok: true, name: r.name }
    },
    'vault:offerDismiss': (_s, id: string, messageId?: string) => {
      d.offers?.dismiss(String(id ?? ''))
      d.onOffer?.({ id: String(id), status: 'dismissed', ...(typeof messageId === 'string' ? { messageId } : {}) })
      return { ok: true }
    },
    'vault:offerNever': (_s, id: string) => {
      const list = d.offers?.never(String(id ?? '')) ?? []
      d.onOffer?.({ id: String(id), status: 'dismissed' })
      return list
    },
    'vault:offerAlive': (_s, ids: string[]) => (Array.isArray(ids) ? ids.slice(0, 50).map(String).filter((x) => !!d.offers?.alive(x)) : []),
    'vault:neverSave': () => d.offers?.neverList() ?? [],
    'vault:removeNeverSave': (_s, origin: string) => d.offers?.removeNever(String(origin ?? '')) ?? [],
    'vault:authPending': () => auth.open(),
    'vault:authRespond': (_s, id: string, answer: { password?: string; cancel?: boolean; touchId?: boolean }) => auth.respond(String(id ?? ''), answer ?? {})
  }

  // Saving an edit that keeps saved values needs the vault open: ask once (Touch ID / password), then save.
  const WRITES = new Set(['vault:set', 'vault:setCard', 'vault:setAddress', 'vault:saveItem', 'vault:remove', 'vault:removeCard', 'vault:removeAddress', 'vault:removeItem', 'vault:importCsv'])
  // Errors keep their message (it never holds a value; masked anyway in case one slipped in).
  const out: Record<string, VaultHandler> = {}
  for (const [ch, fn] of Object.entries(h)) {
    out[ch] = async (sender, ...args) => {
      try {
        try {
          return await fn(sender, ...args)
        } catch (e) {
          if (!(e instanceof VaultLockedError) || !WRITES.has(ch) || vault.isUnlocked()) throw e
          await unlocked('save your changes')
          return await fn(sender, ...args)
        }
      } catch (e) {
        throw new Error(vault.redact((e as Error)?.message ?? String(e)))
      }
    }
  }
  return out
}
