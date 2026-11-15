// Vault cryptography: node:crypto only (no extra dependencies).
//
//   AES-256-GCM            every encryption, 96-bit random nonce, 128-bit tag, with associated data (AAD)
//   HKDF-SHA256            combines key factors into a key-encryption key (KEK) and derives sub-keys
//   scrypt (or Argon2id)   stretches the optional master password; Argon2id only where the runtime has it
//
// Keys and decrypted bytes are Buffers so they can be wiped (filled with zeros) after use. JavaScript
// strings can't be wiped; values that must become strings (to type them into a page) are dropped as soon
// as possible and left to the garbage collector. docs/secrets-vault.md describes the whole design.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import * as nodeCrypto from 'node:crypto'

export const KEY_BYTES = 32
export const NONCE_BYTES = 12
export const TAG_BYTES = 16
/** Packed ciphertext layout: version byte, nonce, ciphertext, tag. */
const PACK_VERSION = 1

export class VaultCryptoError extends Error {
  constructor(message = 'Decryption failed: the data was changed or the key is wrong.') {
    super(message)
    this.name = 'VaultCryptoError'
  }
}

export function randomKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

/** Overwrites a buffer with zeros (best effort: copies made by V8 or OpenSSL internals are out of reach). */
export function wipe(...bufs: Array<Buffer | Uint8Array | null | undefined>): void {
  for (const b of bufs) if (b && b.length) b.fill(0)
}

/** Deterministic JSON (sorted keys, no whitespace) for associated data: the same object always gives the same bytes. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x === undefined ? null : x)).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

/** AES-256-GCM with a fresh random 96-bit nonce. Returns version || nonce || ciphertext || tag. */
export function seal(key: Buffer, plaintext: Buffer, aad: string | Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error('AES-256 needs a 32-byte key')
  const nonce = randomBytes(NONCE_BYTES)
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  c.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad)
  const body = Buffer.concat([c.update(plaintext), c.final()])
  return Buffer.concat([Buffer.from([PACK_VERSION]), nonce, body, c.getAuthTag()])
}

/** Opens what seal() made. Any flipped bit, wrong key or different AAD throws VaultCryptoError. */
export function open(key: Buffer, packed: Buffer, aad: string | Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new VaultCryptoError('Wrong key size')
  if (packed.length < 1 + NONCE_BYTES + TAG_BYTES || packed[0] !== PACK_VERSION) throw new VaultCryptoError('Unknown or damaged ciphertext')
  const nonce = packed.subarray(1, 1 + NONCE_BYTES)
  const tag = packed.subarray(packed.length - TAG_BYTES)
  const body = packed.subarray(1 + NONCE_BYTES, packed.length - TAG_BYTES)
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    d.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch {
    throw new VaultCryptoError()
  }
}

/** HKDF-SHA256 to a 32-byte key. */
export function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), KEY_BYTES))
}

export function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

export function equalBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

// ------------------------------------------------------------------ password stretching

export interface ScryptParams { alg: 'scrypt'; N: number; r: number; p: number; salt: string }
export interface Argon2Params { alg: 'argon2id'; memory: number; passes: number; parallelism: number; salt: string }
export type KdfParams = ScryptParams | Argon2Params

const scryptMaxmem = (N: number, r: number): number => 128 * N * r * 2 + 32 * 1024 * 1024

/** Stretches a password into a 32-byte key with the stored parameters (async: runs on the libuv thread pool). */
export function deriveFromPassword(password: string, params: KdfParams): Promise<Buffer> {
  const pw = Buffer.from(password.normalize('NFKC'), 'utf8')
  const salt = Buffer.from(params.salt, 'base64')
  return new Promise<Buffer>((resolve, reject) => {
    const done = (err: Error | null, key?: Buffer): void => {
      wipe(pw)
      if (err || !key) reject(err ?? new Error('Key derivation failed'))
      else resolve(Buffer.from(key))
    }
    if (params.alg === 'scrypt') {
      scrypt(pw, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: scryptMaxmem(params.N, params.r) }, (e, k) => done(e, k))
    } else {
      const argon2 = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2
      if (!argon2) { wipe(pw); reject(new Error('Argon2id is not available in this runtime')); return }
      argon2('argon2id', { message: pw, nonce: salt, parallelism: params.parallelism, tagLength: KEY_BYTES, memory: params.memory, passes: params.passes }, (e, k) => done(e, k ? Buffer.from(k as Uint8Array) : undefined))
    }
  })
}

type Argon2Fn = (alg: string, p: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }, cb: (e: Error | null, k?: ArrayBuffer | Buffer) => void) => void

let argon2Probe: boolean | undefined
/**
 * Whether Argon2id really works here. Electron's Node exposes crypto.argon2 but its BoringSSL build
 * throws ERR_CRYPTO_ARGON2_NOT_SUPPORTED, so a tiny derivation is tried once.
 */
export function argon2Available(): boolean {
  if (argon2Probe !== undefined) return argon2Probe
  const sync = (nodeCrypto as unknown as { argon2Sync?: (alg: string, p: Record<string, unknown>) => Buffer }).argon2Sync
  try {
    argon2Probe = !!sync && sync('argon2id', { message: Buffer.from('x'), nonce: Buffer.alloc(16), parallelism: 1, tagLength: 32, memory: 64, passes: 1 }).length === 32
  } catch {
    argon2Probe = false
  }
  return argon2Probe
}

/** The strongest parameters this Mac computes in about half a second to a second (never weaker than the floor). */
export async function benchmarkKdf(o: { targetMs?: number; maxMs?: number; prefer?: 'scrypt' | 'argon2id'; quick?: boolean } = {}): Promise<KdfParams & { ms: number }> {
  const target = o.targetMs ?? 500
  const max = o.maxMs ?? 1000
  const salt = randomBytes(16).toString('base64')
  const time = async (p: KdfParams): Promise<number> => {
    const t = Date.now()
    wipe(await deriveFromPassword('benchmark', p))
    return Date.now() - t
  }
  // Tests: fixed, tiny parameters (the format and code path are the same).
  if (o.quick) return { alg: 'scrypt', N: 2 ** 10, r: 8, p: 1, salt, ms: 0 }
  const useArgon = (o.prefer ?? (argon2Available() ? 'argon2id' : 'scrypt')) === 'argon2id' && argon2Available()
  if (useArgon) {
    // Memory-hard first: 64 MiB minimum, up to 1 GiB; then passes.
    let best: Argon2Params & { ms: number } = { alg: 'argon2id', memory: 65536, passes: 3, parallelism: 4, salt, ms: 0 }
    best.ms = await time(best)
    for (const memory of [131072, 262144, 524288, 1048576]) {
      if (best.ms >= target) break
      const p: Argon2Params = { ...best, memory }
      const ms = await time(p)
      if (ms > max) break
      best = { ...p, ms }
    }
    return best
  }
  // scrypt: N = 2^17 (128 MiB) floor, raised while it stays under the ceiling (2^18 is ~0.55 s on an M-series Mac).
  let best: ScryptParams & { ms: number } = { alg: 'scrypt', N: 2 ** 17, r: 8, p: 1, salt, ms: 0 }
  best.ms = await time(best)
  for (const N of [2 ** 18, 2 ** 19, 2 ** 20]) {
    if (best.ms >= target) break
    const p: ScryptParams = { ...best, N }
    const ms = await time(p)
    if (ms > max) break
    best = { ...p, ms }
  }
  return best
}

export const b64 = (b: Buffer): string => b.toString('base64')
export const unb64 = (s: string): Buffer => Buffer.from(String(s ?? ''), 'base64')
