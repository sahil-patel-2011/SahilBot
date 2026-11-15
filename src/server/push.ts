// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291), on node:crypto.
// A paired device that turns notifications on gives its browser's push subscription; the server then
// reaches it while the app is closed (phones included, once the web app is on the home screen on iOS).
// Payloads are end-to-end encrypted to the browser: the push service (Apple, Google, Mozilla) sees only
// ciphertext. Keys and subscriptions are sealed with the master key.

import { createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { EncryptedFile } from './secrets'
import type { NotifyPayload } from './host'
import type { PushSender } from './hub'

export interface PushSubscription { endpoint: string; keys: { p256dh: string; auth: string } }

interface PushState { vapid: { privatePem: string; publicRaw: string }; subs: Record<string, PushSubscription & { added: string }> }

const b64u = (b: Buffer): string => b.toString('base64url')
const unb64u = (s: string): Buffer => Buffer.from(String(s), 'base64url')

/** The uncompressed P-256 point (65 bytes) of a public key. */
function rawPublic(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string }
  return Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])
}

/** Checks a subscription before keeping it: HTTPS to a public push service, keys of the right sizes. */
export function validSubscription(s: unknown): s is PushSubscription {
  const x = s as PushSubscription
  if (!x || typeof x.endpoint !== 'string' || !x.keys || typeof x.keys.p256dh !== 'string' || typeof x.keys.auth !== 'string') return false
  let u: URL
  try { u = new URL(x.endpoint) } catch { return false }
  const h = u.hostname.replace(/^\[|\]$/g, '')
  if (u.protocol !== 'https:' || isIP(h) || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false
  return unb64u(x.keys.p256dh).length === 65 && unb64u(x.keys.auth).length === 16 && x.endpoint.length < 2000
}

/** RFC 8291 aes128gcm: the body to POST for `plaintext` to a browser with these keys. */
export function encryptPayload(plaintext: Buffer, p256dh: string, authSecret: string, o: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {}): Buffer {
  const ua = unb64u(p256dh)
  const auth = unb64u(authSecret)
  const ecdh = o.ecdh ?? createECDH('prime256v1')
  if (!o.ecdh) ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(ua)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32))
  const salt = o.salt ?? randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const c = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([c.update(Buffer.concat([plaintext, Buffer.from([2])])), c.final(), c.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

/** RFC 8292: the Authorization header for a push service. */
export function vapidHeader(endpoint: string, privateKey: KeyObject, publicRaw: Buffer, subject: string, now = Date.now()): string {
  const aud = new URL(endpoint).origin
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })))
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(publicRaw)}`
}

export class WebPush implements PushSender {
  private file: EncryptedFile<PushState>
  private state: PushState
  private priv: KeyObject
  private pubRaw: Buffer

  constructor(dir: string, key: Buffer, private o: { subject?: string; fetch?: typeof fetch; log?: (s: string) => void } = {}) {
    this.file = new EncryptedFile(join(dir, 'push.enc'), key, 'sahilbot-server-push:v1')
    const existing = this.file.read()
    if (existing) this.state = existing
    else {
      const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      this.state = { vapid: { privatePem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, publicRaw: b64u(rawPublic(kp.publicKey)) }, subs: {} }
      this.file.write(this.state)
    }
    this.priv = createPrivateKey(this.state.vapid.privatePem)
    this.pubRaw = rawPublic(createPublicKey(this.priv))
  }

  /** The application server key browsers subscribe with (base64url). */
  publicKey(): string { return b64u(this.pubRaw) }

  subscribe(deviceId: string, sub: unknown): boolean {
    if (!validSubscription(sub)) return false
    this.state.subs[deviceId] = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: new Date().toISOString() }
    this.file.write(this.state)
    return true
  }

  unsubscribe(deviceId: string): boolean {
    if (!this.state.subs[deviceId]) return false
    delete this.state.subs[deviceId]
    this.file.write(this.state)
    return true
  }

  has(deviceId: string): boolean { return !!this.state.subs[deviceId] }

  async send(deviceId: string, payload: NotifyPayload): Promise<boolean> {
    const sub = this.state.subs[deviceId]
    if (!sub) return false
    const body = encryptPayload(Buffer.from(JSON.stringify({ title: payload.title, body: payload.body, threadId: payload.threadId, tag: payload.tag })), sub.keys.p256dh, sub.keys.auth)
    try {
      const r = await (this.o.fetch ?? fetch)(sub.endpoint, {
        method: 'POST',
        headers: {
          Authorization: vapidHeader(sub.endpoint, this.priv, this.pubRaw, this.o.subject ?? 'mailto:server@sahilbot.invalid'),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: payload.kind === 'needs-you' || payload.kind === 'question' ? 'high' : 'normal',
          ...(payload.tag ? { Topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {})
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(15_000)
      })
      // Gone: the browser unsubscribed or the subscription expired.
      if (r.status === 404 || r.status === 410) { this.unsubscribe(deviceId); return false }
      if (!r.ok) this.o.log?.(`push to ${deviceId}: ${r.status}`)
      return r.ok
    } catch (e) {
      this.o.log?.(`push to ${deviceId}: ${(e as Error).message}`)
      return false
    }
  }
}
