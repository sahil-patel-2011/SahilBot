import type { VaultEntry } from '@shared/types'
import type { Db } from './db'
import type { Secrets } from './secrets'

/**
 * Saved logins. Names and sites are listed in plain settings so the UI and the model
 * can refer to them; usernames and passwords are Keychain-encrypted and only ever
 * leave this class to be typed into a matching field by the browser.
 */
export class Vault {
  constructor(private db: Db, private secrets: Secrets) {}

  private index(): Array<{ name: string; origin: string }> {
    return this.db.getSetting<Array<{ name: string; origin: string }>>('vault:index') ?? []
  }

  list(): VaultEntry[] {
    return this.index().map((e) => ({ ...e, username: this.read(e.name)?.username ?? '' }))
  }

  names(): Array<{ name: string; origin: string }> {
    return this.index()
  }

  private read(name: string): { username: string; password: string } | undefined {
    const raw = this.secrets.get(`vault:${name}`)
    return raw ? (JSON.parse(raw) as { username: string; password: string }) : undefined
  }

  set(e: VaultEntry & { password?: string }): void {
    const name = e.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    if (!name) throw new Error('Name is required')
    const origin = normalizeOrigin(e.origin)
    const prev = this.read(name)
    const password = e.password || prev?.password
    if (!password) throw new Error('Password is required')
    this.secrets.set(`vault:${name}`, JSON.stringify({ username: e.username, password }))
    this.db.setSetting('vault:index', [...this.index().filter((x) => x.name !== name), { name, origin }])
  }

  remove(name: string): void {
    this.secrets.set(`vault:${name}`, null)
    this.db.setSetting('vault:index', this.index().filter((x) => x.name !== name))
  }

  /** Only for typing into a verified field. */
  credential(name: string): { origin: string; username: string; password: string } | undefined {
    const idx = this.index().find((x) => x.name === name)
    const v = this.read(name)
    return idx && v ? { origin: idx.origin, ...v } : undefined
  }

  /** Used by the leak check that blocks any tool call containing a saved password. */
  passwords(): string[] {
    return this.index().map((e) => this.read(e.name)?.password).filter((p): p is string => !!p)
  }
}

export function normalizeOrigin(s: string): string {
  const t = s.trim()
  try {
    return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).origin
  } catch {
    throw new Error(`"${s}" is not a valid site`)
  }
}

/** Same host, or the page is on a subdomain of the saved host (login.example.com for example.com). */
export function originMatches(saved: string, pageUrl: string): boolean {
  try {
    const a = new URL(saved), b = new URL(pageUrl)
    if (a.protocol !== b.protocol) return false
    if (a.port !== b.port) return false
    return b.hostname === a.hostname || b.hostname.endsWith(`.${a.hostname}`)
  } catch {
    return false
  }
}
