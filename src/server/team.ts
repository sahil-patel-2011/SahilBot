// Team access: teammates the owner invited can ask the owner's brain from their own phone or laptop, and
// nothing else. A separate role from paired devices, on purpose:
//   - its own cookie (sb_team) and its own token store: a teammate token is never a device token, so it
//     can't load the app, open the WebSocket, or call anything but /team/api/* (http.ts);
//   - each teammate has a scope the owner set (sources, people and clients, topics, bots); the answer is
//     written only from facts the brain reader returns for that scope, enforced on the Mac, server-side;
//   - read-only: no actions on the owner's accounts, never texts (unless allowed), private notes, the
//     secrets vault, or other teammates' questions;
//   - rate-limited per teammate; every question is logged (the audit log, and Team questions for the owner);
//   - the owner revokes a teammate at once (all their devices are signed out).
// Members, their token hashes and the question log are sealed with the same Keychain-backed master key as
// the device list; only SHA-256 hashes of tokens and codes are stored.

import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { cleanBrainScope, DEFAULT_BRAIN_SCOPE, type BrainScope, type BrainSourceRef, type TeamMemberInfo, type TeamQuestion } from '@shared/brain-access'
import { CODE_ALPHABET, CODE_LENGTH, CODE_MAX_FAILURES, CODE_TTL_MS, normalizeCode } from './auth'
import { EncryptedFile } from './secrets'

export const TEAM_COOKIE = 'sb_team'
export const MAX_MEMBERS = 50
export const MAX_QUESTIONS = 1000
/** Questions one teammate may ask: per 10 minutes and per day. */
export const ASKS_PER_10_MIN = 20
export const ASKS_PER_DAY = 150
export const MAX_QUESTION_CHARS = 500

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && x.length > 0 && timingSafeEqual(x, y) }

export interface TeamMemberRecord {
  id: string
  name: string
  role: string
  scope: BrainScope
  createdAt: number
  revokedAt?: number
  pairedAt?: number
  lastSeenAt?: number
  tokens: Array<{ hash: string; createdAt: number }>
}

interface InviteCode { hash: string; memberId: string; expires: number; failures: number }

interface State {
  members: TeamMemberRecord[]
  codes: InviteCode[]
  questions: TeamQuestion[]
  csrfKey: string
}

export const cleanText = (s: unknown, max: number): string => String(s ?? '').normalize('NFKC').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

export class TeamStore {
  private file: EncryptedFile<State>
  private state: State
  private hits = new Map<string, number[]>()

  constructor(dir: string, key: Buffer, private now: () => number = Date.now) {
    this.file = new EncryptedFile(join(dir, 'team.enc'), key, 'sahilbot-team:v1')
    let s: State | undefined
    try { s = this.file.read() } catch { s = undefined }
    this.state = s ?? { members: [], codes: [], questions: [], csrfKey: randomBytes(32).toString('hex') }
    this.state.members = (this.state.members ?? []).map((m) => ({ ...m, scope: cleanBrainScope(m.scope), tokens: m.tokens ?? [] }))
    this.state.codes ??= []
    this.state.questions ??= []
  }

  private save(): void { this.file.write(this.state) }

  // ---------------------------------------------------------------- members

  info(m: TeamMemberRecord): TeamMemberInfo {
    return { id: m.id, name: m.name, role: m.role, scope: m.scope, createdAt: m.createdAt, ...(m.pairedAt ? { pairedAt: m.pairedAt } : {}), ...(m.lastSeenAt ? { lastSeenAt: m.lastSeenAt } : {}), ...(m.revokedAt ? { revokedAt: m.revokedAt } : {}), questions: this.state.questions.filter((q) => q.memberId === m.id).length }
  }

  members(): TeamMemberRecord[] { return this.state.members }
  get(id: string): TeamMemberRecord | undefined { return this.state.members.find((m) => m.id === id) }

  /** A new teammate and their first one-time code. */
  invite(o: { name: unknown; role: unknown; scope?: unknown }): { member: TeamMemberRecord; code: string; expires: number } {
    const name = cleanText(o.name, 60)
    const role = cleanText(o.role, 40) || 'Teammate'
    if (!name) throw new Error('Give your teammate a name.')
    const live = this.state.members.filter((m) => !m.revokedAt)
    if (live.length >= MAX_MEMBERS) throw new Error(`You can invite up to ${MAX_MEMBERS} teammates.`)
    if (live.some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already on your team. Use “New code” on their row for another device.`)
    const member: TeamMemberRecord = { id: randomBytes(6).toString('hex'), name, role, scope: cleanBrainScope(o.scope ?? DEFAULT_BRAIN_SCOPE), createdAt: this.now(), tokens: [] }
    this.state.members.push(member)
    const c = this.newCode(member.id)
    return { member, ...c }
  }

  /** A one-time code for a teammate (10 minutes); older unused codes for them stop working. */
  newCode(memberId: string): { code: string; expires: number } {
    const m = this.get(memberId)
    if (!m || m.revokedAt) throw new Error('That teammate was removed.')
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const expires = this.now() + CODE_TTL_MS
    this.state.codes = [...this.state.codes.filter((c) => c.memberId !== memberId && c.expires > this.now()), { hash: sha256(code), memberId, expires, failures: 0 }].slice(-50)
    this.save()
    return { code, expires }
  }

  /** Trades a code, once, for a teammate token. A wrong code counts against every live code. */
  redeem(input: string): { member: TeamMemberRecord; token: string } | null {
    const want = sha256(normalizeCode(input))
    const now = this.now()
    this.state.codes = this.state.codes.filter((c) => c.expires > now && c.failures < CODE_MAX_FAILURES)
    const i = this.state.codes.findIndex((c) => same(c.hash, want))
    if (i < 0) { for (const c of this.state.codes) c.failures++; this.save(); return null }
    const [c] = this.state.codes.splice(i, 1)
    const m = this.get(c.memberId)
    if (!m || m.revokedAt) { this.save(); return null }
    const token = `sbt_${randomBytes(32).toString('base64url')}`
    m.tokens = [...m.tokens, { hash: sha256(token), createdAt: now }].slice(-5)
    m.pairedAt = now
    this.save()
    return { member: m, token }
  }

  /** The (not removed) teammate a token belongs to. Device tokens never match: they live in another store. */
  check(token: string | undefined): TeamMemberRecord | undefined {
    if (!token || !token.startsWith('sbt_') || token.length > 200) return undefined
    const h = sha256(token)
    return this.state.members.find((m) => !m.revokedAt && m.tokens.some((t) => same(t.hash, h)))
  }

  seen(id: string): void {
    const m = this.get(id)
    if (!m) return
    const first = !m.lastSeenAt || this.now() - m.lastSeenAt > 60_000
    m.lastSeenAt = this.now()
    if (first) this.save()
  }

  setScope(id: string, scope: unknown): TeamMemberRecord {
    const m = this.get(id)
    if (!m || m.revokedAt) throw new Error('That teammate was removed.')
    m.scope = cleanBrainScope({ ...m.scope, ...(scope && typeof scope === 'object' ? scope : {}) })
    this.save()
    return m
  }

  /** Removes a teammate: every token and code of theirs stops working at once. */
  revoke(id: string): boolean {
    const m = this.get(id)
    if (!m || m.revokedAt) return false
    m.revokedAt = this.now()
    m.tokens = []
    this.state.codes = this.state.codes.filter((c) => c.memberId !== id)
    this.save()
    return true
  }

  /** Signs out one device (its own token only). */
  signOut(token: string): void {
    const h = sha256(token)
    for (const m of this.state.members) m.tokens = m.tokens.filter((t) => !same(t.hash, h))
    this.save()
  }

  csrf(memberId: string): string { return createHmac('sha256', this.state.csrfKey).update(`team:${memberId}`).digest('base64url') }
  csrfOk(memberId: string, token: string | undefined): boolean { return !!token && same(this.csrf(memberId), token) }

  // ---------------------------------------------------------------- rate limits

  /** Takes one question from the teammate's allowance, or says how long to wait. */
  take(memberId: string): { ok: true } | { ok: false; retryInS: number } {
    const now = this.now()
    const day = (this.hits.get(memberId) ?? []).filter((t) => now - t < 86_400_000)
    const recent = day.filter((t) => now - t < 600_000)
    if (recent.length >= ASKS_PER_10_MIN) return { ok: false, retryInS: Math.ceil((600_000 - (now - recent[0])) / 1000) }
    if (day.length >= ASKS_PER_DAY) return { ok: false, retryInS: Math.ceil((86_400_000 - (now - day[0])) / 1000) }
    day.push(now)
    this.hits.set(memberId, day)
    return { ok: true }
  }

  // ---------------------------------------------------------------- questions

  logQuestion(q: Omit<TeamQuestion, 'id' | 'at'>): TeamQuestion {
    const entry: TeamQuestion = { ...q, id: randomUUID(), at: this.now() }
    this.state.questions = [...this.state.questions, entry].slice(-MAX_QUESTIONS)
    this.save()
    return entry
  }

  question(id: string): TeamQuestion | undefined { return this.state.questions.find((q) => q.id === id) }

  /** The owner's answer to a question the brain couldn't answer. */
  ownerAnswer(id: string, text: string, chips: BrainSourceRef[] = []): TeamQuestion | undefined {
    const q = this.question(id)
    if (!q) return undefined
    q.ownerAnswer = cleanText(text, 2000)
    q.ownerAnsweredAt = this.now()
    q.status = 'owner'
    if (chips.length) q.chips = chips
    this.save()
    return q
  }

  /** Newest first. A teammate's own (memberId) or everyone's (the owner). */
  questions(o: { memberId?: string; limit?: number } = {}): TeamQuestion[] {
    const list = o.memberId ? this.state.questions.filter((q) => q.memberId === o.memberId) : this.state.questions
    return list.slice(-(o.limit ?? 200)).reverse()
  }
}

export function teamCookie(token: string, secure: boolean): string {
  return `${TEAM_COOKIE}=${token}; Path=/team; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`
}
export function clearTeamCookie(secure: boolean): string {
  return `${TEAM_COOKIE}=; Path=/team; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}
