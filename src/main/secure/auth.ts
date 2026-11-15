// Unlocking and re-authentication: Touch ID (systemPreferences.promptTouchID) and/or the master
// password, asked in the app's own dialog. A request comes from main (a fill, a reveal, an export);
// the renderer only shows the dialog and sends back what the user typed.

import { randomUUID } from 'node:crypto'
import type { VaultAuthRequest } from '@shared/types'
import type { SecureVault } from './core'

export interface TouchId {
  available(): boolean
  prompt(reason: string): Promise<boolean>
}

/** The app's dialog (main window). */
export interface AuthUi {
  available(): boolean
  show(req: VaultAuthRequest): void
  done(id: string): void
}

export type ReauthPurpose = 'card' | 'identity' | 'password' | 'reveal' | 'export' | 'settings'

/** An unlock or re-authentication counts as fresh for this long (one approval, then the fill). */
const FRESH_MS = 60_000

const cleanReason = (s: string): string => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)

export class VaultAuth {
  private pending = new Map<string, { req: VaultAuthRequest; settle: (ok: boolean) => void }>()
  private freshUntil = 0
  private readonly now: () => number

  constructor(private o: { core: SecureVault; touch: TouchId; ui: AuthUi; now?: () => number; timeoutMs?: number }) {
    this.now = o.now ?? Date.now
  }

  touchIdUsable(): boolean {
    try { return this.o.core.prefs().touchId && this.o.touch.available() } catch { return false }
  }

  /** No master password and no Touch ID: the user's own click is the only check there is. */
  presenceOnly(): boolean {
    return !this.o.core.hasMasterPassword() && !this.touchIdUsable()
  }

  private markFresh(): void {
    this.freshUntil = this.now() + FRESH_MS
  }

  isFresh(): boolean {
    return this.now() < this.freshUntil
  }

  /** Unlocks if needed. False when the user cancelled, or nobody can be asked. */
  async unlock(reason: string, o: { attended?: boolean } = {}): Promise<boolean> {
    const core = this.o.core
    if (core.isUnlocked()) { core.touch(); return true }
    if (o.attended === false) return false
    const r = cleanReason(reason)
    if (this.touchIdUsable() && (!core.hasMasterPassword() || core.hasBioWrap())) {
      let ok = false
      try { ok = await this.o.touch.prompt(r || 'unlock your SahilBot vault') } catch { ok = false }
      if (ok) {
        core.unlockKeychain('touchid')
        this.markFresh()
        return true
      }
      if (!core.hasMasterPassword()) {
        core.auditLog.add({ event: 'unlock_failed', outcome: 'denied', detail: 'Touch ID cancelled' })
        return false
      }
    }
    return this.dialog('unlock', r)
  }

  /**
   * Proves the user is here right before a sensitive step. Touch ID when available, else the master
   * password. A Keychain-only vault on a Mac without Touch ID has nothing stronger than the user's own
   * click on the approval or Reveal button, so that counts (and the security summary says so).
   */
  async reauth(purpose: ReauthPurpose, reason: string, o: { attended?: boolean } = {}): Promise<boolean> {
    const core = this.o.core
    if (this.isFresh()) return true
    if (o.attended === false) return false
    const r = cleanReason(reason)
    if (this.touchIdUsable()) {
      let ok = false
      try { ok = await this.o.touch.prompt(r || 'confirm it\'s you') } catch { ok = false }
      if (ok) { this.markFresh(); core.auditLog.add({ event: 'reauth', outcome: 'ok', detail: `${purpose}: Touch ID` }); return true }
      if (!core.hasMasterPassword()) { core.auditLog.add({ event: 'reauth_failed', outcome: 'denied', detail: `${purpose}: Touch ID cancelled` }); return false }
    }
    if (core.hasMasterPassword()) return this.dialog('reauth', r, purpose)
    return true
  }

  private dialog(kind: 'unlock' | 'reauth', reason: string, purpose?: ReauthPurpose): Promise<boolean> {
    if (!this.o.ui.available()) return Promise.resolve(false)
    const core = this.o.core
    const needs: VaultAuthRequest['needs'] = core.hasMasterPassword() ? 'password' : 'confirm'
    const id = randomUUID()
    const req: VaultAuthRequest = {
      id, kind, needs, reason,
      title: kind === 'unlock' ? 'Unlock your vault' : 'Confirm it\'s you',
      touchId: this.touchIdUsable() && (kind === 'reauth' || !core.hasMasterPassword() || core.hasBioWrap()),
      ...(purpose ? { purpose } : {})
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.finish(id, false, 'timed out'), this.o.timeoutMs ?? 3 * 60_000)
      this.pending.set(id, { req, settle: (ok) => { clearTimeout(timer); resolve(ok) } })
      this.o.ui.show(req)
    })
  }

  private finish(id: string, ok: boolean, why?: string): void {
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (!ok) this.o.core.auditLog.add({ event: p.req.kind === 'unlock' ? 'unlock_failed' : 'reauth_failed', outcome: 'denied', detail: why ?? 'cancelled' })
    try { this.o.ui.done(id) } catch { /* window gone */ }
    p.settle(ok)
  }

  /** The dialog's answer. A wrong password keeps the dialog open (with the backoff shown). */
  async respond(id: string, answer: { password?: string; cancel?: boolean; touchId?: boolean }): Promise<{ ok: boolean; error?: string; retryInMs?: number }> {
    const p = this.pending.get(id)
    if (!p) return { ok: false, error: 'This request is no longer open.' }
    if (answer?.cancel) { this.finish(id, false, 'cancelled'); return { ok: true } }
    const core = this.o.core
    try {
      if (answer?.touchId) {
        if (!this.touchIdUsable()) return { ok: false, error: 'Touch ID isn\'t available.' }
        if (!(await this.o.touch.prompt(p.req.reason || 'unlock your SahilBot vault'))) return { ok: false, error: 'Touch ID was cancelled.' }
        if (p.req.kind === 'unlock') core.unlockKeychain('touchid')
      } else if (p.req.needs === 'password') {
        const pw = String(answer?.password ?? '')
        if (!pw) return { ok: false, error: 'Type your master password.' }
        if (p.req.kind === 'unlock') await core.unlockPassword(pw)
        else await core.verifyPassword(pw)
      } else if (p.req.kind === 'unlock') {
        core.unlockKeychain('presence')
      }
      if (p.req.kind === 'reauth') core.auditLog.add({ event: 'reauth', outcome: 'ok', detail: `${p.req.purpose ?? 'confirm'}: ${answer?.touchId ? 'Touch ID' : p.req.needs === 'password' ? 'master password' : 'click'}` })
      this.markFresh()
      this.finish(id, true)
      return { ok: true }
    } catch (e) {
      const err = e as Error & { retryInMs?: number }
      return { ok: false, error: err.message, ...(err.retryInMs ? { retryInMs: err.retryInMs } : {}) }
    }
  }

  /** Open requests (the window asks on load, so a dialog survives a reload). */
  open(): VaultAuthRequest[] {
    return [...this.pending.values()].map((p) => p.req)
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, false, 'cancelled')
  }

  /** Locking ends the fresh window too. */
  forget(): void {
    this.freshUntil = 0
  }
}
