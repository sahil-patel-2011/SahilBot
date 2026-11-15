// TLS for `--listen` on a network address: the user's own certificate, or a self-signed one made on first
// run (ECDSA P-256, SHA-256, with this machine's names and addresses). Made with node:crypto and a small
// DER writer, no OpenSSL or dependencies. Browsers warn about a self-signed certificate until it is
// trusted; Tailscale (tailscale serve) gives a real certificate with no warning, which docs/server.md recommends.

import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname, networkInterfaces } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { writePrivate } from './secrets'

// ------------------------------------------------------------------ DER

const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), len(body.length), body])
const seq = (...xs: Buffer[]): Buffer => tlv(0x30, Buffer.concat(xs))
const set = (...xs: Buffer[]): Buffer => tlv(0x31, Buffer.concat(xs))
const int = (b: Buffer): Buffer => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b)
const oid = (dotted: string): Buffer => {
  const p = dotted.split('.').map(Number)
  const out: number[] = [p[0] * 40 + p[1]]
  for (const n of p.slice(2)) {
    const stack: number[] = [n & 0x7f]
    for (let x = n >> 7; x > 0; x >>= 7) stack.unshift((x & 0x7f) | 0x80)
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}
const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
const bits = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), b]))
const octets = (b: Buffer): Buffer => tlv(0x04, b)
const explicit = (n: number, b: Buffer): Buffer => tlv(0xa0 | n, b)
const bool = (v: boolean): Buffer => tlv(0x01, Buffer.from([v ? 0xff : 0]))
const time = (d: Date): Buffer => {
  const z = (n: number, w = 2): string => String(n).padStart(w, '0')
  const y = d.getUTCFullYear()
  const body = `${z(d.getUTCMonth() + 1)}${z(d.getUTCDate())}${z(d.getUTCHours())}${z(d.getUTCMinutes())}${z(d.getUTCSeconds())}Z`
  return y < 2050 ? tlv(0x17, Buffer.from(`${z(y % 100)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`))
}
const ipBytes = (ip: string): Buffer => {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number))
  const [head, tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h
  return Buffer.concat(groups.map((g) => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(g || '0', 16)); return b }))
}

/** A self-signed certificate for `names` (DNS names and IP addresses), valid for `days`. */
export function selfSigned(names: string[], days = 825): { cert: string; key: string } {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const priv: KeyObject = pair.privateKey
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' })
  const alg = seq(oid('1.2.840.10045.4.3.2'))
  const name = seq(set(seq(oid('2.5.4.3'), utf8('SahilBot Server'))), set(seq(oid('2.5.4.10'), utf8('SahilBot'))))
  const now = Date.now()
  const san = seq(...[...new Set(names)].map((n) => (isIP(n) ? tlv(0x87, ipBytes(n)) : tlv(0x82, Buffer.from(n, 'ascii')))))
  const ext = explicit(3, seq(
    seq(oid('2.5.29.19'), bool(true), octets(seq())),
    seq(oid('2.5.29.15'), bool(true), octets(bits(Buffer.from([0x80])))),
    seq(oid('2.5.29.37'), octets(seq(oid('1.3.6.1.5.5.7.3.1')))),
    seq(oid('2.5.29.17'), octets(san)),
    seq(oid('2.5.29.14'), octets(octets(createHash('sha1').update(spki).digest())))
  ))
  const serial = randomBytes(16)
  serial[0] &= 0x7f
  const tbs = seq(explicit(0, int(Buffer.from([2]))), int(serial), alg, name, seq(time(new Date(now - 3600_000)), time(new Date(now + days * 86400_000))), name, spki, ext)
  const sig = sign('sha256', tbs, priv)
  const der = seq(tbs, alg, bits(sig))
  const pem = (label: string, b: Buffer): string => `-----BEGIN ${label}-----\n${b.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n')}-----END ${label}-----\n`
  return { cert: pem('CERTIFICATE', der), key: priv.export({ type: 'pkcs8', format: 'pem' }) as string }
}

/** This machine's names and addresses (for the certificate). */
export function localNames(extra: string[] = []): string[] {
  const me = hostname()
  const ips = Object.values(networkInterfaces()).flat().filter((i): i is NonNullable<typeof i> => !!i).map((i) => i.address.split('%')[0]).filter((a) => !/^fe80:/i.test(a))
  return [...new Set(['localhost', me, `${me.replace(/\.local$/, '')}.local`, '127.0.0.1', '::1', ...ips, ...extra].filter(Boolean))]
}

export interface TlsFiles { cert: string; key: string; selfSigned: boolean; fingerprint: string; certPath: string }

/** The user's certificate (--cert/--key), else the server's self-signed one (made once, kept in <data>/server/tls). */
export function loadTls(o: { dir: string; certFile?: string; keyFile?: string; names?: string[] }): TlsFiles {
  if (o.certFile || o.keyFile) {
    if (!o.certFile || !o.keyFile) throw new Error('Pass both --cert and --key.')
    const cert = readFileSync(o.certFile, 'utf8')
    return { cert, key: readFileSync(o.keyFile, 'utf8'), selfSigned: false, fingerprint: new X509Certificate(cert).fingerprint256, certPath: o.certFile }
  }
  const certPath = join(o.dir, 'tls', 'cert.pem')
  const keyPath = join(o.dir, 'tls', 'key.pem')
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf8')
    const x = new X509Certificate(cert)
    // Renew a month before it runs out.
    if (new Date(x.validTo).getTime() - Date.now() > 30 * 86400_000) return { cert, key: readFileSync(keyPath, 'utf8'), selfSigned: true, fingerprint: x.fingerprint256, certPath }
  }
  const made = selfSigned(localNames(o.names))
  writePrivate(keyPath, made.key)
  writePrivate(certPath, made.cert)
  return { ...made, selfSigned: true, fingerprint: new X509Certificate(made.cert).fingerprint256, certPath }
}
