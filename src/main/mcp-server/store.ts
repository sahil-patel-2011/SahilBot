import { randomUUID } from 'node:crypto'
import type { McpActivity, McpClientInfo } from '@shared/types'
import { cleanBrainScope, DEFAULT_BRAIN_SCOPE, type BrainScope } from '@shared/brain-access'
import { hashToken, newToken, sameHash } from './auth'

// Connected apps and what they did. Kept in the settings table (opaque JSON). Tokens are never stored,
// only their SHA-256; revoking removes the record, so the token stops working at once.

export const CLIENTS_KEY = 'mcpServer:clients'
export const ACTIVITY_KEY = 'mcpServer:activity'
export const MAX_CLIENTS = 20
export const ACTIVITY_KEEP = 200

export interface McpClientRecord {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastUsedAt: number | null
  /** bot id → the chat this app uses with that bot. */
  threads: Record<string, string>
  /** What of the user's brain this app may read (the brain tools); absent = the default scope. */
  scope?: BrainScope
}

/** An app's brain scope (the default for apps connected before scopes existed). */
export const scopeOf = (c: Pick<McpClientRecord, 'scope'>): BrainScope => cleanBrainScope(c.scope ?? DEFAULT_BRAIN_SCOPE)

export interface KeyValue {
  getSetting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
}

/** A client name as shown in Settings and in chats: one line, printable, at most 40 characters. */
export function cleanClientName(name: unknown): string {
  if (typeof name !== 'string') return ''
  return name.normalize('NFKC').replace(/[^\p{L}\p{N} ._()'&+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim()
}

export const publicClient = (c: McpClientRecord): McpClientInfo =>
  ({ id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt, bots: Object.keys(c.threads ?? {}).length, scope: scopeOf(c) })

export class McpClientStore {
  constructor(private kv: KeyValue, private now: () => number = Date.now) {}

  private all(): McpClientRecord[] {
    const v = this.kv.getSetting<McpClientRecord[]>(CLIENTS_KEY)
    return Array.isArray(v) ? v.filter((c) => c && typeof c.id === 'string' && typeof c.tokenHash === 'string').map((c) => ({ ...c, threads: c.threads ?? {} })) : []
  }

  private save(list: McpClientRecord[]): void {
    this.kv.setSetting(CLIENTS_KEY, list)
  }

  list(): McpClientRecord[] {
    return this.all()
  }

  get(id: string): McpClientRecord | undefined {
    return this.all().find((c) => c.id === id)
  }

  /** A new named client and its token (returned once, never stored). */
  create(rawName: unknown): { client: McpClientRecord; token: string } {
    const name = cleanClientName(rawName)
    if (!name) throw new Error('Give the app a name, like "Cursor" or "Claude Code".')
    const list = this.all()
    if (list.length >= MAX_CLIENTS) throw new Error(`You can connect up to ${MAX_CLIENTS} apps. Revoke one you no longer use first.`)
    if (list.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new Error(`An app named "${name}" is already connected. Revoke it first, or pick another name.`)
    const token = newToken()
    const client: McpClientRecord = { id: randomUUID(), name, tokenHash: hashToken(token), createdAt: this.now(), lastUsedAt: null, threads: {} }
    this.save([...list, client])
    return { client, token }
  }

  /** Sets what of the brain an app may read. */
  setScope(id: string, scope: unknown): McpClientRecord | undefined {
    const list = this.all()
    const c = list.find((x) => x.id === id)
    if (!c) return undefined
    c.scope = cleanBrainScope({ ...scopeOf(c), ...(scope && typeof scope === 'object' ? scope : {}) })
    this.save(list)
    return c
  }

  revoke(id: string): boolean {
    const list = this.all()
    const next = list.filter((c) => c.id !== id)
    if (next.length === list.length) return false
    this.save(next)
    return true
  }

  /** The client a token belongs to (constant-time comparison against every stored hash). */
  authenticate(token: string): McpClientRecord | undefined {
    const h = hashToken(token)
    let found: McpClientRecord | undefined
    for (const c of this.all()) if (sameHash(c.tokenHash, h)) found = c
    return found
  }

  touch(id: string): void {
    const list = this.all()
    const c = list.find((x) => x.id === id)
    if (!c) return
    c.lastUsedAt = this.now()
    this.save(list)
  }

  threadFor(clientId: string, botId: string): string | undefined {
    return this.get(clientId)?.threads[botId]
  }

  setThread(clientId: string, botId: string, threadId: string): void {
    const list = this.all()
    const c = list.find((x) => x.id === clientId)
    if (!c) return
    c.threads = { ...c.threads, [botId]: threadId }
    this.save(list)
  }

  /** True only for a chat this client created. */
  ownsThread(clientId: string, threadId: string): boolean {
    return Object.values(this.get(clientId)?.threads ?? {}).includes(threadId)
  }

  // ---------- activity log ----------

  log(e: Omit<McpActivity, 'at'> & { at?: number }): McpActivity {
    const entry: McpActivity = { at: e.at ?? this.now(), clientId: e.clientId, client: e.client.slice(0, 60), tool: e.tool.slice(0, 60), ok: e.ok, ...(e.detail ? { detail: e.detail.replace(/\s+/g, ' ').slice(0, 160) } : {}), ...(e.ms !== undefined ? { ms: Math.round(e.ms) } : {}) }
    const cur = this.kv.getSetting<McpActivity[]>(ACTIVITY_KEY)
    const next = [...(Array.isArray(cur) ? cur : []), entry].slice(-ACTIVITY_KEEP)
    this.kv.setSetting(ACTIVITY_KEY, next)
    return entry
  }

  /** Newest first. */
  activity(limit = 100): McpActivity[] {
    const cur = this.kv.getSetting<McpActivity[]>(ACTIVITY_KEY)
    return (Array.isArray(cur) ? cur : []).slice(-limit).reverse()
  }
}

/** A sliding-window limit per key (a client id): at most `limit` hits in `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  take(key: string): { ok: true } | { ok: false; retryInMs: number } {
    const t = this.now()
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return { ok: false, retryInMs: Math.max(1, this.windowMs - (t - recent[0])) }
    }
    recent.push(t)
    this.hits.set(key, recent)
    return { ok: true }
  }
}
