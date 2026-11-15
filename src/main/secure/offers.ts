// "Save to Vault?" offers. Two sources:
//   - the browser panel: the user signed in (or paid) by hand on an HTTPS or loopback page; an
//     isolated-world listener (browser/save-watch.ts) hands the form's values to main;
//   - the chat composer: the user typed or pasted a password, API key, card or ID number; main takes it
//     out of the message (detect.ts) before it is stored, logged or sent to a model.
// The values are held here, in main's memory only, until the user clicks Save (or they expire). The
// window only ever gets a VaultSaveOffer: the site, a masked username, brand and last 4. Nothing is
// written to the vault without that click; a locked vault asks for Touch ID or the master password first.

import { randomUUID } from 'node:crypto'
import type { VaultSaveEdits, VaultSaveOffer } from '@shared/types'
import { cardBrand, cardLabel, digitsOnly, luhn } from '@shared/cards'
import type { Vault } from '../vault'
import { findSecrets, maskUsername, redactFound, type FoundSecret } from './detect'
import { isSecurePage, normalizeOrigin, originMatches, originOfUrl } from './origin'

/** What the page listener reports (values included: main only). */
export type BrowserCapture =
  | { kind: 'login'; url: string; username: string; password: string; newPassword?: string }
  | { kind: 'card'; url: string; number: string; expMonth?: number; expYear?: number; holder?: string; cvc?: string }

interface Held {
  offer: VaultSaveOffer
  /** The secret (password, key, card number, ID number). */
  value: string
  username?: string
  cvc?: string
  threadId?: string
  until: number
}

export interface SaveOffersDeps {
  vault: Vault
  /** Sites the user said "Never for this site" to (origins). */
  never: { get(): string[]; set(list: string[]): void }
  now?: () => number
  /** The browser offer appeared, changed or went away. */
  onBrowserChange?: () => void
}

const BROWSER_MS = 10 * 60_000
const CHAT_MS = 60 * 60_000
const hostOf = (origin: string): string => { try { return new URL(origin).host } catch { return '' } }
const slug = (s: string): string => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
const clip = (v: unknown, n: number): string => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n)

export class SaveOffers {
  private held = new Map<string, Held>()
  private browserId: string | null = null

  constructor(private d: SaveOffersDeps) {}

  private now(): number { return this.d.now ? this.d.now() : Date.now() }

  private prune(): void {
    const now = this.now()
    for (const [id, h] of this.held) if (h.until <= now) { this.held.delete(id); if (id === this.browserId) this.browserId = null }
  }

  /** Every value held right now (masked in anything bound for a model while it waits). */
  values(): string[] {
    this.prune()
    const out: string[] = []
    for (const h of this.held.values()) { out.push(h.value); if (h.cvc && h.cvc.length >= 4) out.push(h.cvc) }
    return out
  }

  neverList(): string[] { return [...new Set(this.d.never.get().filter((x) => typeof x === 'string'))] }

  removeNever(origin: string): string[] {
    const next = this.neverList().filter((o) => o !== origin)
    this.d.never.set(next)
    return next
  }

  // ---------------------------------------------------------------- browser

  /** The browser panel's current offer (metadata only), or null. */
  browserOffer(): VaultSaveOffer | null {
    this.prune()
    return this.browserId ? this.held.get(this.browserId)?.offer ?? null : null
  }

  private setBrowser(h: Held | null): VaultSaveOffer | null {
    if (this.browserId) this.held.delete(this.browserId)
    this.browserId = null
    if (h) { this.held.set(h.offer.id, h); this.browserId = h.offer.id }
    this.d.onBrowserChange?.()
    return h?.offer ?? null
  }

  /**
   * A form the user submitted in the browser panel. Returns the offer to show, or null when there is
   * nothing to offer: not HTTPS/loopback, "Never for this site", or already saved exactly like this.
   */
  fromBrowser(c: BrowserCapture): VaultSaveOffer | null {
    const url = String(c?.url ?? '')
    if (!isSecurePage(url)) return null
    const origin = originOfUrl(url)
    if (!origin || this.neverList().includes(origin)) return null
    if (c.kind === 'login') return this.loginOffer(origin, c)
    if (c.kind === 'card') return this.cardOffer(origin, c)
    return null
  }

  private loginOffer(origin: string, c: Extract<BrowserCapture, { kind: 'login' }>): VaultSaveOffer | null {
    const username = clip(c.username, 200)
    const password = String(c.password ?? '').slice(0, 512)
    const newPassword = c.newPassword ? String(c.newPassword).slice(0, 512) : ''
    if (!password && !newPassword) return null
    const host = hostOf(origin)
    const mine = this.d.vault.list().filter((e) => e.origin && originMatches(e.origin, origin + '/', { subdomains: !!e.subdomains }))
    const value = newPassword || password
    let update: string | undefined
    if (this.d.vault.isUnlocked()) {
      for (const e of mine) {
        let cred: ReturnType<Vault['credential']>
        try { cred = this.d.vault.credential(e.name) } catch { cred = undefined }
        if (!cred) continue
        const sameUser = !username || !cred.username || cred.username.toLowerCase() === username.toLowerCase()
        if (!sameUser) continue
        if (cred.password === value) return null
        // A sign-in with a different password for a saved account, or a change-password form.
        update = e.name
        break
      }
    } else {
      // Locked: the saved passwords can't be compared. A change-password form is an update; a sign-in
      // for an account already saved here isn't asked about (it most likely is the saved one).
      const hint = maskUsername(username)
      const same = mine.find((e) => !username || !e.username || e.username === hint)
      if (same && !newPassword) return null
      if (same) update = same.name
    }
    const offer: VaultSaveOffer = {
      id: randomUUID(), source: 'browser', kind: 'login', title: update ? `Update saved password for ${host}?` : `Save login for ${host} to Vault?`,
      site: host, origin, name: update ?? (slug(host.replace(/^www\./, '').replace(/:\d+$/, '')) || 'login'), label: 'Password',
      ...(username ? { username: maskUsername(username) } : {}), ...(update ? { update: true, updates: update } : {}), status: 'pending'
    }
    return this.setBrowser({ offer, value, username, until: this.now() + BROWSER_MS })
  }

  private cardOffer(origin: string, c: Extract<BrowserCapture, { kind: 'card' }>): VaultSaveOffer | null {
    const number = digitsOnly(c.number ?? '')
    if (number.length < 12 || number.length > 19 || !luhn(number)) return null
    // Already saved: the full numbers are known while unlocked; brand and last 4 while locked.
    if (this.d.vault.isUnlocked()) { if (this.d.vault.cardNumbers().includes(number)) return null }
    else if (this.d.vault.cards().some((x) => x.last4 === number.slice(-4) && x.brand === cardBrand(number))) return null
    const brand = cardBrand(number)
    const label = cardLabel({ nickname: '', brand, last4: number.slice(-4) })
    const expMonth = Number(c.expMonth) || undefined
    const expYear = Number(c.expYear) ? (Number(c.expYear) < 100 ? 2000 + Number(c.expYear) : Number(c.expYear)) : undefined
    const holder = clip(c.holder, 80)
    const cvc = digitsOnly(c.cvc ?? '').slice(0, 4)
    const needs: VaultSaveOffer['needs'] = [...(!expMonth || !expYear ? ['expiry' as const] : []), ...(!holder ? ['holder' as const] : [])]
    const offer: VaultSaveOffer = {
      id: randomUUID(), source: 'browser', kind: 'card', title: `Save card ending ${number.slice(-4)} to Vault?`,
      site: hostOf(origin), origin, name: label, label, brand, last4: number.slice(-4),
      ...(expMonth ? { expMonth } : {}), ...(expYear ? { expYear } : {}), ...(holder ? { holder } : {}), ...(cvc ? { hasCvc: true } : {}),
      ...(needs.length ? { needs } : {}), status: 'pending'
    }
    return this.setBrowser({ offer, value: number, ...(cvc ? { cvc } : {}), until: this.now() + BROWSER_MS })
  }

  // ---------------------------------------------------------------- chat

  /**
   * Takes secrets out of a message the user typed. Returns the text to store and send (each value is
   * [redacted]) and the offers to show next to it. Nothing is saved.
   */
  scanChat(text: string, threadId?: string): { text: string; offers: VaultSaveOffer[] } {
    const t = String(text ?? '')
    const found = findSecrets(t)
    if (!found.length) return { text: t, offers: [] }
    this.prune()
    const offers = found.map((f, i) => this.chatOffer(f, i, threadId))
    return { text: redactFound(t, found), offers }
  }

  private chatOffer(f: FoundSecret, ordinal: number, threadId?: string): VaultSaveOffer {
    const kind: VaultSaveOffer['kind'] = f.kind === 'password' ? 'login' : f.kind
    const host = f.site ? hostOf(f.site) : ''
    const needs: VaultSaveOffer['needs'] = []
    if ((kind === 'login' || kind === 'api_key') && !f.site) needs.push('site')
    if (kind === 'card') { if (!f.expMonth || !f.expYear) needs.push('expiry'); needs.push('holder') }
    const title = kind === 'login' ? `Save this password${host ? ` for ${host}` : ''} to Vault?`
      : kind === 'api_key' ? `Save this ${f.label} to Vault?`
      : kind === 'card' ? `Save card ending ${f.last4} to Vault?`
      : `Save this ${f.label} to Vault?`
    const offer: VaultSaveOffer = {
      id: randomUUID(), source: 'chat', kind, title, site: host, origin: f.site, name: f.name, label: f.label,
      ...(f.username ? { username: f.username } : {}), ...(f.brand ? { brand: f.brand, last4: f.last4 } : {}),
      ...(f.expMonth ? { expMonth: f.expMonth, expYear: f.expYear } : {}), ...(f.idKind ? { idKind: f.idKind } : {}),
      ...(needs.length ? { needs } : {}), ordinal, status: 'pending'
    }
    this.held.set(offer.id, { offer, value: f.value, ...(f.username ? { username: f.username } : {}), ...(threadId ? { threadId } : {}), until: this.now() + CHAT_MS })
    return offer
  }

  /** Whether an offer's value is still held (a restart forgets them). */
  alive(id: string): boolean {
    this.prune()
    return this.held.has(String(id ?? ''))
  }

  // ---------------------------------------------------------------- the user's answer

  /** "Not now": forgets the value. */
  dismiss(id: string): void {
    const h = this.held.get(String(id ?? ''))
    if (!h) return
    this.held.delete(h.offer.id)
    if (h.offer.id === this.browserId) this.setBrowser(null)
  }

  /** "Never for this site": forgets the value and never asks on this site again. */
  never(id: string): string[] {
    const h = this.held.get(String(id ?? ''))
    const origin = h?.offer.origin
    this.dismiss(id)
    if (!origin) return this.neverList()
    const next = [...new Set([...this.neverList(), origin])].slice(-500)
    this.d.never.set(next)
    return next
  }

  /**
   * "Save": the user's click. A locked vault asks for Touch ID or the master password first (a vault
   * with nothing stronger than a click opens on this one). Returns the item's name.
   */
  async save(id: string, edits: VaultSaveEdits = {}): Promise<{ name: string; offer: VaultSaveOffer; threadId?: string }> {
    this.prune()
    const h = this.held.get(String(id ?? ''))
    if (!h) throw new Error('This was not kept (SahilBot only holds it for a while, and forgets it on restart). Type it again to save it.')
    const o = h.offer
    const what = o.kind === 'login' ? (o.update ? `update the password for ${o.site}` : `save the login for ${o.site || 'this site'}`) : o.kind === 'card' ? `save the card ending ${o.last4}` : `save your ${o.label}`
    const vault = this.d.vault
    if (!vault.isUnlocked() && !vault.presenceOnly()) await vault.ensureUnlocked(what, true)
    let name = ''
    if (o.kind === 'login' || o.kind === 'api_key') {
      // A page's login stays with the page it was typed on (the window can't move it to another site).
      const site = o.source === 'browser' ? o.origin : clip(edits.site ?? o.origin, 300)
      if (!site) throw new Error('Add the site this is for (for example github.com).')
      const origin = normalizeOrigin(site)
      if (o.update && o.updates) {
        vault.set({ name: o.updates, origin: vault.list().find((e) => e.name === o.updates)?.origin || origin, password: h.value })
        name = o.updates
      } else {
        const base = slug(edits.name || o.name) || slug(hostOf(origin)) || 'login'
        name = this.freeName(base, origin)
        const username = o.source === 'browser' ? h.username ?? '' : clip(edits.username ?? h.username ?? '', 200)
        vault.set({ name, origin, username, password: h.value, ...(o.kind === 'api_key' ? { notes: o.label } : {}) })
      }
    } else if (o.kind === 'card') {
      const month = edits.expMonth ?? o.expMonth ?? ''
      const year = edits.expYear ?? o.expYear ?? ''
      const holder = clip(edits.holder ?? o.holder ?? '', 80)
      const remember = !!edits.rememberCvc && !!h.cvc
      const nickname = clip(edits.name ?? '', 60)
      const before = new Set(vault.cards().map((c) => c.id))
      const list = vault.setCard({ nickname: nickname && nickname !== o.label ? nickname : '', number: h.value, expMonth: month, expYear: year, holder, ...(remember ? { cvc: h.cvc } : { clearCvc: true }) })
      name = list.find((c) => !before.has(c.id))?.nickname ?? o.label
    } else {
      const label = clip(edits.name || o.name, 60) || o.label
      name = this.freeItemName(label)
      vault.saveItem({ type: 'identity', name, kind: o.idKind ?? 'other', number: h.value })
    }
    this.held.delete(o.id)
    if (o.id === this.browserId) this.setBrowser(null)
    return { name, offer: { ...o, status: 'saved', savedAs: name }, ...(h.threadId ? { threadId: h.threadId } : {}) }
  }

  /** A login name not taken by another site's login ("github", "github-2"). */
  private freeName(base: string, origin: string): string {
    // Another account on the same site gets its own entry too (the same account would be an update).
    void origin
    const taken = new Set(this.d.vault.list().map((e) => e.name))
    if (!taken.has(base)) return base
    for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
    return `${base}-${Date.now()}`
  }

  private freeItemName(base: string): string {
    const taken = new Set(this.d.vault.items().map((x) => x.name.toLowerCase()))
    if (!taken.has(base.toLowerCase())) return base
    for (let i = 2; i < 100; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
    return `${base} ${Date.now()}`
  }
}
