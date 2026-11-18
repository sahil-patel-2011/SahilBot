// Phone access (Settings → General → Phone access, docs/phone-access.md): the Mac app serves its own UI to
// the user's phones, so they can check on bots, answer Needs-you questions and approvals, and chat, with
// push notifications. Nothing new runs on the network: it is SahilBot Server's front door (src/server: the
// pairing, devices, audit log, WebSocket hub and Web Push), hosted by this Mac's main process.
//
// - Off by default. On, it listens with HTTPS (a self-signed certificate made on this Mac) on the home
//   network's private address and/or the Tailscale address, never a public one, and drops connections from
//   anywhere else (net.ts). No port forwarding, no relay, no telemetry.
// - A phone pairs with a one-time code (in the QR code's link, with the certificate's fingerprint for the
//   phone to check), gets an HttpOnly device cookie, and can be removed here at any time. The device list
//   and push keys are sealed with a key kept in the Keychain; only hashes of device tokens are stored.
// - What a phone may call is policy.ts: the Mac's own screen (browser panel, dialogs, microphone) and the
//   vault stay on the Mac, and purchases and one-time codes are approved only in the Mac's window.

import { execFile } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import type { PhoneAccessStatus, PhoneHostInfo, ServerAuditEntry, ServerDeviceInfo } from '@shared/types'
import { makeQr, qrPath } from '@shared/qr'
import { AuditLog } from '../../server/audit'
import { Devices, formatCode, PairingCodes, RateLimiter } from '../../server/auth'
import { host } from '../../server/host'
import { HttpFront } from '../../server/http'
import { Hub, type CallHook } from '../../server/hub'
import { WebPush } from '../../server/push'
import { loadTls, type TlsFiles } from '../../server/tls'
import { setDeviceNotifier } from '../notify'
import { addAdapter, broadcast, registerHandler, type RpcContext } from '../rpc'
import { bindPlan, detectTailscale, peerAllowed, phoneAddresses, type PhoneAddress, type TailscaleInfo } from './net'
import { PHONE_ANSWERS, phoneDenied, phoneGetsEvent, PURCHASE_ON_MAC, purchaseAnswerAllowed } from './policy'

export const DEFAULT_PORT = 8788
const KEY_SECRET = 'phoneAccessKey'
const SETTING = 'phoneAccess'

interface Saved { enabled: boolean; port: number; lan: boolean; tailscale: boolean }
const DEFAULTS: Saved = { enabled: false, port: DEFAULT_PORT, lan: true, tailscale: true }

export interface PhoneDeps {
  db: { getSetting<T>(key: string): T | null | undefined; setSetting(key: string, value: unknown): void }
  /** Keychain-backed secrets (src/main/secrets.ts). */
  secrets: { get(name: string): string | undefined; set(name: string, value: string | null): void; available(): boolean }
  /** Phone access keeps its files in <dataDir>/phone-access. */
  dataDir: string
  /** The renderer bundle and the browser bridge (out/renderer, out/web/bridge.js). */
  uiDir: string
  bridgeFile: string
  version: string
  /** A chat's open requests (approvals, questions, purchases), as the Mac window gets them. */
  pending(threadId: string): unknown
  /** Answers a purchase or one-time-code card (a phone may only deny). */
  purchaseRespond(threadId: string, id: string, nonce: string, answer: string): unknown
  /** The Mac's foreman-file: answer, so attachments and images show on the phone under the same rules. */
  fileResponse(req: Request): Promise<Response>
  /** Hidden test runs: SAHILBOT_PHONE_* overrides apply (loopback, port, push sink). */
  hidden: boolean
  log?: (line: string) => void
}

/** The Mac's Bonjour name (scutil's LocalHostName), which phones on the same Wi-Fi resolve as name.local. */
function localHostName(): Promise<string | undefined> {
  return new Promise((ok) => {
    if (process.platform !== 'darwin') { ok(undefined); return }
    execFile('scutil', ['--get', 'LocalHostName'], { timeout: 2000 }, (e, out) => {
      const n = e ? '' : String(out).trim()
      ok(/^[A-Za-z0-9-]{1,63}$/.test(n) ? n : undefined)
    })
  })
}

/** The QR code's link: the address, the one-time code and the certificate's fingerprint (the start of its SHA-256). */
export function pairingUrl(hostName: string, port: number, code: string, fingerprint: string): string {
  const h = isIP(hostName) === 6 ? `[${hostName}]` : hostName
  const fp = fingerprint.replace(/:/g, '').slice(0, 16).toUpperCase()
  return `https://${h}:${port}/pair#code=${encodeURIComponent(formatCode(code))}&fp=${fp}`
}

/** A test run's push service: the encrypted push is handed to a local sink instead of Apple, Google or Mozilla. */
function sinkFetch(sink: string): typeof fetch {
  return (async (endpoint: string | URL | Request, init?: RequestInit) => {
    const body = init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('base64') : ''
    return fetch(sink, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: String(endpoint), headers: init?.headers ?? {}, body }) })
  }) as typeof fetch
}

export class PhoneAccess {
  private dir: string
  private front: HttpFront | null = null
  private hub: Hub | null = null
  private devices: Devices | null = null
  private codes: PairingCodes | null = null
  private audit: AuditLog | null = null
  private push: WebPush | null = null
  private tls: TlsFiles | null = null
  private detach: (() => void) | null = null
  private watch: ReturnType<typeof setInterval> | null = null
  private listening: string[] = []
  private port = DEFAULT_PORT
  private error: string | undefined
  private pairing: PhoneAccessStatus['pairing'] | undefined
  private ts: TailscaleInfo = { installed: false, connected: false }
  private tsAt = 0
  private bonjour: string | undefined
  private starting: Promise<void> | null = null
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly limiter = new RateLimiter({ perKey: 5, total: 20, windowMs: 15 * 60_000 })

  constructor(private d: PhoneDeps) {
    this.dir = join(d.dataDir, 'phone-access')
  }

  // ---------------------------------------------------------------- settings

  private saved(): Saved { return { ...DEFAULTS, ...(this.d.db.getSetting<Partial<Saved>>(SETTING) ?? {}) } }
  private save(p: Partial<Saved>): Saved { const s = { ...this.saved(), ...p }; this.d.db.setSetting(SETTING, s); return s }
  private env(name: string): string | undefined { return this.d.hidden ? process.env[name] : undefined }
  private addresses(): PhoneAddress[] { return phoneAddresses(networkInterfaces()) }
  private plan(): string[] { return bindPlan(this.addresses(), this.saved(), { loopbackOnly: this.env('SAHILBOT_PHONE_TEST_BIND') === '127.0.0.1' }) }

  /** The key that seals the device list and push keys: random, kept in the Keychain. */
  private masterKey(): Buffer {
    if (!this.d.secrets.available()) throw new Error('The Keychain is locked or unavailable, so paired phones can’t be stored safely.')
    const hex = this.d.secrets.get(KEY_SECRET)
    if (hex && /^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
    // A new key: anything sealed with an old one (another Mac, a reset Keychain) can't be read, so start over.
    for (const f of ['devices.enc', 'push.enc', 'pairing.json']) rmSync(join(this.dir, f), { force: true })
    const key = randomBytes(32)
    this.d.secrets.set(KEY_SECRET, key.toString('hex'))
    return key
  }

  // ---------------------------------------------------------------- on and off

  /** Starts it when it was left on (app launch). */
  async resume(): Promise<void> {
    if (this.saved().enabled) await this.start().catch((e) => { this.error = (e as Error).message; this.d.log?.(`[phone] ${this.error}`) })
  }

  async setEnabled(on: boolean): Promise<PhoneAccessStatus> {
    this.save({ enabled: !!on })
    if (on) {
      this.error = undefined
      try { await this.start() } catch (e) { this.error = (e as Error).message }
      if (this.front && !this.pairing && this.devices?.active().length === 0) this.newCode()
    } else await this.stop()
    this.changed()
    return this.status()
  }

  async setOptions(o: { lan?: boolean; tailscale?: boolean }): Promise<PhoneAccessStatus> {
    const p: Partial<Saved> = {}
    if (typeof o.lan === 'boolean') p.lan = o.lan
    if (typeof o.tailscale === 'boolean') p.tailscale = o.tailscale
    this.save(p)
    if (this.front) await this.rebind()
    this.changed()
    return this.status()
  }

  private async start(): Promise<void> {
    if (this.front) return
    if (this.starting) return this.starting
    this.starting = this.open().finally(() => { this.starting = null })
    return this.starting
  }

  private async open(): Promise<void> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const key = this.masterKey()
    this.bonjour = await localHostName()
    await this.tailscale(true)
    this.audit ??= new AuditLog(join(this.dir, 'audit.log'))
    this.devices ??= new Devices(this.dir, key)
    this.codes ??= new PairingCodes(join(this.dir, 'pairing.json'))
    const sink = this.env('SAHILBOT_PHONE_PUSH_SINK')
    this.push ??= new WebPush(this.dir, key, { fetch: sink ? sinkFetch(sink) : undefined, subject: 'mailto:phone-access@sahilbot.invalid', log: (l) => this.d.log?.(`[phone push] ${l}`) })
    const devices = this.devices
    const push = this.push
    if (!this.hub) {
      const hub = new Hub({ audit: this.audit, version: this.d.version, host: 'mac', onDirectSend: () => undefined, hook: this.hook(), events: phoneGetsEvent })
      hub.activeDevices = () => devices.active().map((x) => x.id)
      hub.push = push
      hub.onChange = () => this.changed()
      this.hub = hub
      this.detach = addAdapter(hub.adapter())
      setDeviceNotifier((ids, payload) => hub.notify(ids, payload))
    }
    // The phone loads attachments and images from the Mac through the same foreman-file: rules.
    host.protocols.set('foreman-file', (req) => this.d.fileResponse(req))
    host.version = this.d.version
    host.ready = true
    this.tls = this.loadCert()
    await this.listen()
    this.audit.write('server.start', { detail: `Phone access on ${this.listening.join(', ') || '(no network yet)'}:${this.port}` })
    // Wi-Fi changes, Tailscale connects: listen where the Mac is now.
    this.watch = setInterval(() => { if (this.plan().join() !== this.listening.join()) void this.rebind() }, Number(this.env('SAHILBOT_PHONE_WATCH_MS')) || 15_000)
    this.watch.unref?.()
  }

  /** The certificate: made once on this Mac, for its names and its home and Tailscale addresses. */
  private loadCert(): TlsFiles {
    const names = [this.bonjour ? `${this.bonjour}.local` : '', this.ts.dnsName ?? '', this.ts.ip ?? ''].filter(Boolean)
    let t = loadTls({ dir: this.dir, names })
    // A certificate made before Tailscale (or a new Wi-Fi address) was here doesn't name it. Remade only
    // while no phone is paired: a paired phone may have chosen to trust this one.
    const want = [...names, ...this.plan().filter((ip) => ip !== '127.0.0.1')]
    if (!want.every((n) => covers(t.cert, n)) && this.devices?.active().length === 0) {
      rmSync(join(this.dir, 'tls'), { recursive: true, force: true })
      t = loadTls({ dir: this.dir, names })
    }
    return t
  }

  private async listen(): Promise<void> {
    const plan = this.plan()
    const wanted = Number(this.env('SAHILBOT_PHONE_PORT') ?? this.saved().port)
    const front = new HttpFront({
      uiDir: this.d.uiDir, bridgeFile: this.d.bridgeFile, host: 'mac',
      tls: this.tls!, certDer: this.tls!.selfSigned ? new X509Certificate(this.tls!.cert).raw : undefined,
      devices: this.devices!, codes: this.codes!, limiter: this.limiter, audit: this.audit!, hub: this.hub!,
      policy: { allowHosts: [this.bonjour ? `${this.bonjour}.local` : '', this.ts.dnsName ?? ''].filter(Boolean) },
      peerAllowed,
      status: () => ({ version: this.d.version, phones: this.devices!.active().length })
    })
    this.listening = []
    this.error = plan.length ? undefined : this.noNetwork()
    // The saved port first (a Home Screen app remembers it), then the next few if something else took it.
    let port = wanted
    for (let attempt = 0; attempt < 10 && plan.length; attempt++) {
      try {
        for (const ip of plan) { const r = await front.listen(port, ip); port = r.port; this.listening.push(ip) }
        break
      } catch (e) {
        await front.close()
        this.listening = []
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || wanted === 0) { this.error = `Couldn’t listen: ${(e as Error).message}`; break }
        port = wanted + attempt + 1
      }
    }
    if (this.listening.length) {
      this.port = port
      if (wanted !== 0 && port !== this.saved().port) this.save({ port })
      this.error = undefined
    } else if (!this.error) this.error = `Port ${wanted} and the next ones are in use.`
    this.front = front
  }

  private noNetwork(): string {
    const s = this.saved()
    if (!s.lan && !s.tailscale) return 'Choose home Wi-Fi, Tailscale or both.'
    if (s.lan && !s.tailscale) return 'This Mac isn’t on a home network right now.'
    if (!s.lan) return this.ts.installed ? 'Tailscale isn’t connected on this Mac.' : 'Tailscale isn’t installed on this Mac.'
    return 'This Mac isn’t on a home network or Tailscale right now.'
  }

  private async rebind(): Promise<void> {
    if (!this.front) return
    await this.tailscale(true)
    const old = this.front
    this.front = null
    await old.close()
    this.tls = this.loadCert()
    await this.listen()
    this.audit?.write('server.start', { detail: `Phone access moved to ${this.listening.join(', ') || '(no network)'}:${this.port}` })
    this.changed()
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined)
    if (this.watch) { clearInterval(this.watch); this.watch = null }
    const front = this.front
    this.front = null
    this.listening = []
    this.pairing = undefined
    this.codes?.clear()
    if (this.hub) { this.hub.dispose(); this.hub = null }
    this.detach?.()
    this.detach = null
    setDeviceNotifier(null)
    host.protocols.delete('foreman-file')
    if (front) { await front.close(); this.audit?.write('server.stop', { detail: 'Phone access off' }) }
    this.devices?.dispose()
  }

  // ---------------------------------------------------------------- what a phone may call

  private hook(): CallHook {
    return (ch, args, s) => {
      switch (ch) {
        case 'chat:pending': return { answer: () => this.d.pending(String(args[0] ?? '')) }
        case 'purchase:respond': return { answer: () => purchaseAnswerAllowed(args[3]) ? this.d.purchaseRespond(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? ''), 'deny') : { ok: false, error: PURCHASE_ON_MAC } }
        case 'server:pushKey': return { answer: () => this.push?.publicKey() ?? null }
        case 'server:pushSubscribe': return { answer: () => { const ok = !!this.push?.subscribe(s.deviceId, args[0]); this.changed(); return ok } }
        case 'server:pushUnsubscribe': return { answer: () => { const ok = !!this.push?.unsubscribe(s.deviceId); this.changed(); return ok } }
        case 'server:pushTest': return { answer: () => this.hub!.notify([s.deviceId], { title: 'SahilBot', body: 'Notifications work on this phone.', kind: 'info', tag: 'test' }) }
        case 'server:phoneInfo': return { answer: (): PhoneHostInfo => ({ mac: this.bonjour ?? hostname().replace(/\.local$/, ''), version: this.d.version, device: this.rows(s.deviceId).find((x) => x.id === s.deviceId) }) }
        case 'server:devices': return { answer: () => this.rows(s.deviceId).filter((x) => x.id === s.deviceId) }
      }
      if (PHONE_ANSWERS[ch]) return { answer: PHONE_ANSWERS[ch] }
      if (ch.startsWith('server:')) return { deny: 'Paired phones are managed on your Mac: Settings → General → Phone access.' }
      const why = phoneDenied(ch)
      return why ? { deny: why } : undefined
    }
  }

  // ---------------------------------------------------------------- pairing and devices

  private async tailscale(fresh = false): Promise<TailscaleInfo> {
    if (fresh || Date.now() - this.tsAt > 30_000) { this.ts = await detectTailscale(this.addresses()); this.tsAt = Date.now() }
    return this.ts
  }

  /** A new one-time code and its QR link. Tailscale's address works at home and away, so it's the default when connected. */
  newCode(via?: 'lan' | 'lan-ip' | 'tailscale'): PhoneAccessStatus['pairing'] {
    if (!this.front || !this.codes || !this.tls) throw new Error('Turn on Phone access first.')
    const addrs = this.addresses()
    const listening = new Set(this.listening)
    const lanIp = addrs.find((a) => a.kind === 'lan' && listening.has(a.ip))?.ip
    const tsIp = addrs.find((a) => a.kind === 'tailscale' && listening.has(a.ip))?.ip
    const test = this.listening[0] === '127.0.0.1' ? '127.0.0.1' : undefined
    const pick = via ?? (tsIp ? 'tailscale' : 'lan')
    const hostName = test ?? (pick === 'tailscale' ? tsIp : pick === 'lan' && this.bonjour ? `${this.bonjour}.local` : lanIp) ?? lanIp ?? tsIp
    if (!hostName) throw new Error(this.error ?? 'Phone access isn’t listening on any network right now.')
    const c = this.codes.create({ label: 'Phone access' })
    this.audit?.write('pair.code', { detail: `Phone access (${pick})` })
    const url = pairingUrl(hostName, this.port, c.code, this.tls.fingerprint)
    this.pairing = { code: formatCode(c.code), expires: c.expires, url, via: pick, qr: qrPath(makeQr(url)) }
    this.changed()
    return this.pairing
  }

  private rows(current?: string): ServerDeviceInfo[] {
    if (!this.devices) return []
    const sessions = this.hub?.list() ?? []
    return this.devices.list().map((x) => ({ ...x, current: x.id === current, sessions: sessions.filter((s) => s.deviceId === x.id).length, push: !!this.push?.has(x.id) }))
  }

  revoke(id: string): PhoneAccessStatus {
    if (this.devices?.revoke(String(id ?? ''))) {
      this.audit?.write('device.revoke', { device: String(id), detail: 'from the Mac' })
      this.push?.unsubscribe(String(id))
      this.hub?.closeDevice(String(id), 'this phone was removed on the Mac')
    }
    this.changed()
    return this.status()
  }

  rename(id: string, name: string): PhoneAccessStatus {
    if (this.devices?.rename(String(id ?? ''), String(name ?? ''))) this.audit?.write('device.rename', { device: String(id), detail: String(name ?? '').slice(0, 60) })
    this.changed()
    return this.status()
  }

  auditLog(limit = 200): ServerAuditEntry[] {
    return this.audit?.recent(Math.max(1, Math.min(1000, Number(limit) || 200))) ?? (existsSync(join(this.dir, 'audit.log')) ? new AuditLog(join(this.dir, 'audit.log')).recent(limit) : [])
  }

  status(): PhoneAccessStatus {
    const s = this.saved()
    // A shown code that was used or ran out disappears.
    if (this.pairing && (this.pairing.expires < Date.now() || !this.codes?.live())) this.pairing = undefined
    const listening = new Set(this.listening)
    return {
      enabled: s.enabled,
      running: !!this.front && this.listening.length > 0,
      error: s.enabled ? this.error : undefined,
      port: this.front ? this.port : s.port,
      lan: s.lan,
      tailscale: s.tailscale,
      addresses: this.addresses().map((a) => ({ ...a, listening: listening.has(a.ip) })),
      tailscaleInfo: this.ts,
      localName: this.bonjour ? `${this.bonjour}.local` : undefined,
      fingerprint: this.tls?.fingerprint,
      pairing: this.pairing,
      devices: this.rows().filter((x) => !x.revokedAt)
    }
  }

  /** Tells the Mac window (Settings) something changed; a burst of changes sends one event. */
  private changed(): void {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => { this.changeTimer = null; broadcast('phoneAccess:changed') }, 150)
    this.changeTimer.unref?.()
  }

  /** The Mac window's Settings → General → Phone access. Phones can't call these (policy.ts, and here). */
  register(): void {
    const mac = (ctx: RpcContext): void => { if (ctx.transport === 'ws') throw new Error('Phone access is managed on your Mac.') }
    registerHandler('phoneAccess:status', async (ctx) => { mac(ctx); await this.tailscale(); return this.status() })
    registerHandler('phoneAccess:setEnabled', (ctx, on) => { mac(ctx); return this.setEnabled(on === true) })
    registerHandler('phoneAccess:setOptions', (ctx, o) => { mac(ctx); return this.setOptions((o ?? {}) as { lan?: boolean; tailscale?: boolean }) })
    registerHandler('phoneAccess:newCode', (ctx, via) => { mac(ctx); this.newCode(via === 'lan' || via === 'lan-ip' || via === 'tailscale' ? via : undefined); return this.status() })
    registerHandler('phoneAccess:revoke', (ctx, id) => { mac(ctx); return this.revoke(String(id ?? '')) })
    registerHandler('phoneAccess:rename', (ctx, id, name) => { mac(ctx); return this.rename(String(id ?? ''), String(name ?? '')) })
    registerHandler('phoneAccess:audit', (ctx, limit) => { mac(ctx); return this.auditLog(Number(limit) || 200) })
  }
}

/** Whether a certificate names this host or address. */
function covers(certPem: string, name: string): boolean {
  try {
    const x = new X509Certificate(certPem)
    return isIP(name) ? !!x.checkIP(name) : !!x.checkHost(name)
  } catch { return false }
}
