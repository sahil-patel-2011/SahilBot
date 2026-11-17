import { ACCOUNT_SERVERS } from './scripts'
import { MailNotRunning, type MailRunner } from './runner'
import { GMAIL_APP_PASSWORD_SECRET, GOOGLE_LINK_SETTING, appPasswordProblem, gmailAddressProblem, normalizeAppPassword, verifyGmail, type GmailCreds, type GmailTransport, type GoogleLink, type GoogleMethod } from './gmail-direct'

// Connect apps → Google: one tile, three ways, in this order.
//  a. Sign in with Google: the Gmail connector (Google's official MCP server, connectors.ts preset "gmail").
//  b. The Mac's Mail app: when Apple Mail already has a Google account, connecting just points SahilBot's
//     mail tool at it (no sign-in at all).
//  c. An app password (16 letters): Gmail over IMAP/SMTP (gmail-direct.ts, the gmail_imap tool).
// The choice is one link record (db setting GOOGLE_LINK_SETTING: method + address, no secrets); the app
// password is only in the Keychain-backed secrets store and is never returned by anything here.

export interface MailAccountRow { name: string; emails?: string[]; enabled?: boolean; type?: string; server?: string }

/** Apple Mail accounts that are Google ones: Gmail's servers, a gmail.com address, or a Google account type. */
export function googleMailAccounts(rows: MailAccountRow[]): Array<{ account: string; address: string }> {
  const out: Array<{ account: string; address: string }> = []
  for (const r of rows ?? []) {
    if (r.enabled === false) continue
    const emails = (r.emails ?? []).map((e) => String(e).trim()).filter((e) => e.includes('@'))
    const google = /gmail|google/i.test(r.server ?? '') || /gmail|google/i.test(r.type ?? '') || emails.some((e) => /@(gmail|googlemail)\.com$/i.test(e))
    if (google && emails[0]) out.push({ account: r.name, address: emails[0].toLowerCase() })
  }
  return out
}

export interface GoogleStatus {
  link: GoogleLink | null
  /** Sign in with Google: whether this build ships a Google client (else only "Use your own Google Cloud app"). */
  oauth: { builtin: boolean; ownClient: boolean; connected: boolean; configId?: string }
  /** Google accounts in Apple Mail (empty when none, or Mail isn't open: `mailOpen` says which). */
  mail: Array<{ account: string; address: string }>
  mailOpen: boolean
}

export interface DbLike { getSetting<T>(k: string): T | undefined | null; setSetting(k: string, v: unknown): void }
export interface SecretsLike { get(k: string): string | undefined; set(k: string, v: string | null): void }

export class GoogleConnect {
  constructor(private d: {
    db: DbLike
    secrets: SecretsLike
    runner: MailRunner
    oauth: () => GoogleStatus['oauth']
    transport?: GmailTransport
    changed?: () => void
  }) {}

  link(): GoogleLink | null {
    const v = this.d.db.getSetting<GoogleLink>(GOOGLE_LINK_SETTING)
    return v && typeof v === 'object' && ['oauth', 'mail', 'app-password'].includes(v.method) ? v : null
  }

  private setLink(method: GoogleMethod, address?: string): GoogleLink {
    const l: GoogleLink = { method, ...(address ? { address } : {}), at: Date.now() }
    this.d.db.setSetting(GOOGLE_LINK_SETTING, l)
    this.d.changed?.()
    return l
  }

  /** The app-password credentials for the gmail_imap tool (main only), or null. */
  credentials(): GmailCreds | null {
    const l = this.link()
    if (l?.method !== 'app-password' || !l.address) return null
    const pass = this.d.secrets.get(GMAIL_APP_PASSWORD_SECRET)
    return pass ? { user: l.address, pass } : null
  }

  async mailAccounts(): Promise<{ open: boolean; accounts: Array<{ account: string; address: string }> }> {
    try {
      const rows = await this.d.runner.call<MailAccountRow[]>(ACCOUNT_SERVERS, {}, { launch: false, timeoutMs: 20_000 })
      return { open: true, accounts: googleMailAccounts(rows) }
    } catch (e) {
      if (e instanceof MailNotRunning) return { open: false, accounts: [] }
      return { open: true, accounts: [] }
    }
  }

  /** `mail: false` skips asking Apple Mail (opening Connect apps shouldn't send Mail an Apple Event; the Google panel does). */
  async status(o: { mail?: boolean } = {}): Promise<GoogleStatus> {
    const m = o.mail === false ? { open: false, accounts: [] } : await this.mailAccounts()
    const oauth = this.d.oauth()
    // Signed in with Google (and nothing else chosen): that's the link.
    const link = this.link() ?? (oauth.connected ? { method: 'oauth' as const, at: 0 } : null)
    return { link, oauth, mail: m.accounts, mailOpen: m.open }
  }

  /** b. Use the Google account Apple Mail already has: SahilBot's mail tool works with it as is. */
  async useMail(address: string): Promise<GoogleLink> {
    const m = await this.mailAccounts()
    const hit = m.accounts.find((a) => a.address === String(address ?? '').trim().toLowerCase())
    if (!hit) throw new Error(m.open ? 'That Google account isn\'t in the Mail app any more. Add it in Mail → Settings → Accounts, or pick another way.' : 'Open the Mail app first, then try again.')
    this.d.secrets.set(GMAIL_APP_PASSWORD_SECRET, null)
    return this.setLink('mail', hit.address)
  }

  /** c. An app password: checked by signing in to Gmail's IMAP once, then kept in the Keychain. */
  async useAppPassword(address: string, password: string): Promise<GoogleLink> {
    const a = String(address ?? '').trim().toLowerCase()
    const problem = gmailAddressProblem(a) ?? appPasswordProblem(password)
    if (problem) throw new Error(problem)
    const pass = normalizeAppPassword(password)
    await verifyGmail({ user: a, pass }, this.d.transport)
    this.d.secrets.set(GMAIL_APP_PASSWORD_SECRET, pass)
    return this.setLink('app-password', a)
  }

  /** a. Signed in with Google (the Gmail connector connected): recorded so the tile says how. */
  useOauth(): GoogleLink {
    return this.setLink('oauth')
  }

  /** Forgets the link and any app password (the Gmail connector itself is disconnected by Connect apps). */
  disconnect(): void {
    this.d.secrets.set(GMAIL_APP_PASSWORD_SECRET, null)
    this.d.db.setSetting(GOOGLE_LINK_SETTING, null)
    this.d.changed?.()
  }
}
