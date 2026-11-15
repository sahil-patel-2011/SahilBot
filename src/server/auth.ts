// Who may use SahilBot Server: paired devices only.
//
// Pairing: the server shows a one-time code (on first start, `sahilbot-server pair`, or from an already
// paired device). A browser trades it, once, for a long random device token: an HttpOnly, SameSite=Strict
// cookie (Secure over HTTPS); the Mac app gets the token itself and keeps it in the Keychain. The server
// stores only a SHA-256 of each token, so a copy of its files can't sign in. Every device can be revoked.
// Failed codes are rate-limited per address and in total; too many failures burn the code.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { EncryptedFile, writePrivate } from './secrets'

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 10
export const CODE_TTL_MS = 10 * 60_000
/** Wrong guesses one code survives in total (all addresses) before it is burned. */
export const CODE_MAX_FAILURES = 10
export const COOKIE = 'sb_device'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string): boolean => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }

/** XXXXX-XXXXX → XXXXXXXXXX, upper case, no spaces or dashes. */
export function normalizeCode(code: string): string {
  return String(code ?? '').toUpperCase().replace(/[\s-]/g, '')
}
export function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`
}

interface StoredCode { hash: string; expires: number; failures: number; label?: string }

/**
 * One-time pairing codes, kept (hashed) in a file so `sahilbot-server pair` in another process can add one
 * to a running server.
 */
export class PairingCodes {
  constructor(private file: string, private now: () => number = Date.now) {}

  private load(): StoredCode[] {
    if (!existsSync(this.file)) return []
    try { return (JSON.parse(readFileSync(this.file, 'utf8')) as StoredCode[]).filter((c) => c.expires > this.now() && c.failures < CODE_MAX_FAILURES) } catch { return [] }
  }
  private save(codes: StoredCode[]): void { writePrivate(this.file, JSON.stringify(codes)) }

  /** A new code (returned once, never stored in the clear). */
  create(o: { ttlMs?: number; label?: string } = {}): { code: string; expires: number } {
    let code = ''
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    const expires = this.now() + (o.ttlMs ?? CODE_TTL_MS)
    this.save([...this.load(), { hash: sha256(code), expires, failures: 0, label: o.label }].slice(-20))
    return { code, expires }
  }

  /** Uses up a code: true once for a valid one. A wrong code counts against every live code. */
  consume(input: string): boolean {
    const want = sha256(normalizeCode(input))
    const codes = this.load()
    const i = codes.findIndex((c) => same(c.hash, want))
    if (i >= 0) { codes.splice(i, 1); this.save(codes); return true }
    for (const c of codes) c.failures++
    this.save(codes)
    return false
  }

  live(): number { return this.load().length }
  clear(): void { this.save([]) }
}

export interface Device {
  id: string
  name: string
  kind: 'browser' | 'app'
  createdAt: string
  lastSeen?: string
  lastIp?: string
  tokenHash: string
  revokedAt?: string
}
/** A device as the UI may see it (no token hash). */
export type DeviceInfo = Omit<Device, 'tokenHash'> & { current?: boolean }

/** Paired devices, sealed with the master key. */
export class Devices {
  private file: EncryptedFile<{ devices: Device[]; csrfKey: string }>
  private state: { devices: Device[]; csrfKey: string }
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null

  private path: string
  private mtime = 0

  constructor(dir: string, key: Buffer) {
    this.path = join(dir, 'devices.enc')
    this.file = new EncryptedFile(this.path, key, 'sahilbot-server-devices:v1')
    this.state = this.file.read() ?? { devices: [], csrfKey: randomBytes(32).toString('hex') }
    if (!this.file.exists()) this.file.write(this.state)
    this.mtime = this.stamp()
  }

  private stamp(): number { try { return statSync(this.path).mtimeMs } catch { return 0 } }

  /** Picks up changes another process made (`sahilbot-server revoke` while the server runs). */
  private sync(): void {
    const m = this.stamp()
    if (m && m !== this.mtime) { this.state = this.file.read() ?? this.state; this.mtime = m }
  }

  private flush(): void { this.sync(); this.write() }
  private write(): void { this.file.write(this.state); this.mtime = this.stamp() }

  /** A new device and its token (the only time the token exists in the clear). */
  add(name: string, kind: Device['kind'], ip?: string): { device: Device; token: string } {
    this.sync()
    const token = randomBytes(32).toString('base64url')
    const device: Device = { id: randomBytes(6).toString('hex'), name: name.slice(0, 80) || 'Device', kind, createdAt: new Date().toISOString(), lastIp: ip, tokenHash: sha256(token) }
    this.state.devices.push(device)
    this.write()
    return { device, token }
  }

  /** The (not revoked) device a token belongs to. */
  check(token: string | undefined): Device | undefined {
    if (!token || token.length < 20 || token.length > 200) return undefined
    this.sync()
    const h = sha256(token)
    return this.state.devices.find((d) => !d.revokedAt && same(d.tokenHash, h))
  }

  /** Last seen time and address; saved at most every few seconds. */
  seen(id: string, ip?: string): void {
    const d = this.state.devices.find((x) => x.id === id)
    if (!d) return
    d.lastSeen = new Date().toISOString()
    if (ip) d.lastIp = ip
    if (!this.dirtyTimer) this.dirtyTimer = setTimeout(() => { this.dirtyTimer = null; const keep = { ...d }; this.sync(); const now = this.state.devices.find((x) => x.id === keep.id); if (now) { now.lastSeen = keep.lastSeen; now.lastIp = keep.lastIp } this.write() }, 5000)
    this.dirtyTimer.unref?.()
  }

  revoke(id: string): boolean {
    this.sync()
    const d = this.state.devices.find((x) => x.id === id && !x.revokedAt)
    if (!d) return false
    d.revokedAt = new Date().toISOString()
    this.write()
    return true
  }

  rename(id: string, name: string): boolean {
    this.sync()
    const d = this.state.devices.find((x) => x.id === id)
    if (!d) return false
    d.name = String(name).slice(0, 80) || d.name
    this.write()
    return true
  }

  get(id: string): Device | undefined { return this.state.devices.find((d) => d.id === id) }
  list(): DeviceInfo[] { this.sync(); return this.state.devices.map(({ tokenHash: _t, ...d }) => d) }
  active(): Device[] { this.sync(); return this.state.devices.filter((d) => !d.revokedAt) }

  /** The CSRF token for a device's cookie session (sent with every POST; readable only same-origin). */
  csrf(deviceId: string): string { return createHmac('sha256', this.state.csrfKey).update(deviceId).digest('base64url') }
  csrfOk(deviceId: string, token: string | undefined): boolean { return !!token && same(this.csrf(deviceId), token) }

  dispose(): void { if (this.dirtyTimer) { clearTimeout(this.dirtyTimer); this.dirtyTimer = null; this.flush() } }
}

/** Failures per key (an address) in a sliding window, plus a total for all keys. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private all: number[] = []
  constructor(private o: { perKey: number; total: number; windowMs: number }, private now: () => number = Date.now) {}

  private trim(xs: number[]): number[] { const from = this.now() - this.o.windowMs; return xs.filter((t) => t > from) }

  /** Milliseconds until another try is allowed (0 = allowed now). */
  retryAfter(key: string): number {
    const mine = this.trim(this.hits.get(key) ?? [])
    this.all = this.trim(this.all)
    if (mine.length >= this.o.perKey) return mine[0] + this.o.windowMs - this.now()
    if (this.all.length >= this.o.total) return this.all[0] + this.o.windowMs - this.now()
    return 0
  }
  fail(key: string): void {
    const mine = this.trim(this.hits.get(key) ?? [])
    mine.push(this.now())
    this.hits.set(key, mine)
    this.all.push(this.now())
    if (this.hits.size > 10_000) this.hits.clear()
  }
  reset(key: string): void { this.hits.delete(key) }
}

// ------------------------------------------------------------------ hosts and origins

export interface HostPolicy {
  /** Extra names the server answers to (exact, or *.suffix). */
  allowHosts: string[]
}

/** The host part of a Host header or URL host, lower case, without port or IPv6 brackets. */
export function hostOnly(host: string): string {
  const h = String(host ?? '').trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') > 0 ? h.indexOf(']') : undefined)
  const i = h.lastIndexOf(':')
  return i > 0 && h.indexOf(':') === i ? h.slice(0, i) : h
}

/**
 * Whether a Host header names this server. Stops DNS rebinding: a page on evil.example that re-points its
 * name at 127.0.0.1 still sends Host: evil.example. IP literals, localhost, this machine's name (and
 * .local), Tailscale names (*.ts.net) and --allow-host entries are allowed.
 */
export function hostAllowed(host: string | undefined, policy: HostPolicy): boolean {
  if (!host) return false
  const h = hostOnly(host)
  if (!h) return false
  if (isIP(h)) return true
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const me = hostname().toLowerCase()
  if (h === me || h === `${me}.local` || h === me.replace(/\.local$/, '')) return true
  if (h.endsWith('.ts.net')) return true
  return policy.allowHosts.some((a) => { const x = a.toLowerCase(); return x.startsWith('*.') ? h.endsWith(x.slice(1)) : h === x })
}

/**
 * Same-origin check for browser requests: the Origin header must be this very server (scheme and host as
 * the browser reached it). Requests without an Origin are not from a page and get no cookie-based access.
 */
export function originAllowed(origin: string | undefined, host: string | undefined, secure: boolean): boolean {
  if (!origin || !host || origin === 'null') return false
  try {
    const o = new URL(origin)
    return o.protocol === (secure ? 'https:' : 'http:') && o.host.toLowerCase() === host.toLowerCase()
  } catch { return false }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** The device cookie: HttpOnly, SameSite=Strict, a year; Secure whenever the page is HTTPS. */
export function deviceCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`
}
export function clearCookie(secure: boolean): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

/** A short device name from a User-Agent ("Safari on iPhone"). */
export function deviceName(ua: string | undefined): string {
  const s = String(ua ?? '')
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android' : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : ''
  const br = /Edg\//.test(s) ? 'Edge' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : /SahilBot/.test(s) ? 'SahilBot' : ''
  return [br, os].filter(Boolean).join(' on ') || 'Browser'
}
