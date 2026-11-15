// SahilBot Server's stand-in for the macOS Keychain: one 256-bit master key, and everything secret
// (API keys, connector tokens, the vault's K1) sealed with AES-256-GCM under it (src/main/secure/crypto.ts).
//
// Where the master key comes from, strongest first:
//   1. systemd credentials: $CREDENTIALS_DIRECTORY/sahilbot-master-key (LoadCredentialEncrypted=, TPM-bound)
//   2. SAHILBOT_MASTER_KEY: 32 bytes as 64 hex characters or base64 (a secret manager, a Docker secret)
//   3. a passphrase (SAHILBOT_PASSPHRASE or --passphrase-file): stretched with scrypt; salt in keyring.json
//   4. otherwise a random key in <data>/server/master.key (mode 0600): protected by file permissions only
// The keyring remembers which kind made the data, so a server set up with a passphrase refuses to start
// without it instead of quietly making a new key (which would make every saved secret unreadable).

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { b64, deriveFromPassword, KEY_BYTES, open, seal, unb64, VaultCryptoError, type ScryptParams } from '../main/secure/crypto'

export type KeyKind = 'credential' | 'env' | 'passphrase' | 'keyfile'
export interface MasterKey { kind: KeyKind; key: Buffer; /** Short fingerprint for logs (never the key). */ id: string }

interface Keyring { v: 1; kind: KeyKind; /** scrypt parameters (passphrase only). */ kdf?: ScryptParams; /** seal(key, "sahilbot") to tell a wrong key from a right one. */ check: string }

const CHECK_AAD = 'sahilbot-server-keyring'
const fingerprint = (key: Buffer): string => createHash('sha256').update(key).digest('hex').slice(0, 12)

/** Parses a 32-byte key given as hex or base64. */
export function parseKey(text: string): Buffer {
  const t = text.trim()
  const key = /^[0-9a-f]{64}$/i.test(t) ? Buffer.from(t, 'hex') : Buffer.from(t, 'base64')
  if (key.length !== KEY_BYTES) throw new Error('The master key must be 32 bytes (64 hex characters or base64).')
  return key
}

/** Writes a file only its owner can read, atomically (a crash never leaves half a key). */
export function writePrivate(file: string, data: string | Buffer): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* not supported here */ }
}

export interface KeyOptions {
  /** The server's own folder (<data>/server). */
  dir: string
  env?: NodeJS.ProcessEnv
  passphrase?: string
  /** scrypt cost; tests pass a small one. */
  scryptN?: number
}

/** Finds (or on first run creates) the master key. Throws with a clear message when it can't be the right one. */
export async function resolveMasterKey(o: KeyOptions): Promise<MasterKey> {
  const env = o.env ?? process.env
  const ringFile = join(o.dir, 'keyring.json')
  const ring = existsSync(ringFile) ? (JSON.parse(readFileSync(ringFile, 'utf8')) as Keyring) : undefined
  let kind: KeyKind
  let key: Buffer
  let kdf: ScryptParams | undefined
  const cred = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, 'sahilbot-master-key') : ''
  const passphrase = o.passphrase ?? env.SAHILBOT_PASSPHRASE
  if (cred && existsSync(cred)) { kind = 'credential'; key = parseKey(readFileSync(cred, 'utf8')) }
  else if (env.SAHILBOT_MASTER_KEY) { kind = 'env'; key = parseKey(env.SAHILBOT_MASTER_KEY) }
  else if (passphrase) {
    kind = 'passphrase'
    kdf = ring?.kdf ?? { alg: 'scrypt', N: o.scryptN ?? 2 ** 16, r: 8, p: 1, salt: b64(randomBytes(16)) }
    key = await deriveFromPassword(passphrase, kdf)
  } else {
    if (ring && ring.kind !== 'keyfile') {
      throw new Error(ring.kind === 'passphrase'
        ? 'This server was set up with a passphrase. Start it with SAHILBOT_PASSPHRASE or --passphrase-file.'
        : `This server's secrets are sealed with a master key from ${ring.kind === 'env' ? 'SAHILBOT_MASTER_KEY' : 'systemd credentials'}, which is missing.`)
    }
    kind = 'keyfile'
    const file = join(o.dir, 'master.key')
    if (existsSync(file)) key = parseKey(readFileSync(file, 'utf8'))
    else { key = randomBytes(KEY_BYTES); writePrivate(file, key.toString('hex')) }
  }
  if (ring) {
    try { open(key, unb64(ring.check), CHECK_AAD) } catch (e) {
      if (e instanceof VaultCryptoError) throw new Error(kind === 'passphrase' ? 'Wrong passphrase for this server.' : 'This master key does not match the one this server was set up with.')
      throw e
    }
    if (ring.kind !== kind) writePrivate(ringFile, JSON.stringify({ ...ring, kind, kdf } satisfies Keyring, null, 2))
  } else {
    writePrivate(ringFile, JSON.stringify({ v: 1, kind, kdf, check: b64(seal(key, Buffer.from('sahilbot'), CHECK_AAD)) } satisfies Keyring, null, 2))
  }
  return { kind, key, id: fingerprint(key) }
}

const SECRET_AAD = 'sahilbot-server-secret:v1'

/**
 * Electron's safeStorage, on the server: what Secrets (src/main/secrets.ts) encrypts with. Same contract:
 * encryptString gives opaque bytes, decryptString throws on anything it didn't make.
 */
export class ServerSafeStorage {
  constructor(private key: Buffer | null) {}
  setKey(key: Buffer): void { this.key = key }
  isEncryptionAvailable(): boolean { return !!this.key }
  encryptString(text: string): Buffer {
    if (!this.key) throw new Error('The server has no master key yet.')
    return seal(this.key, Buffer.from(String(text), 'utf8'), SECRET_AAD)
  }
  decryptString(data: Buffer): string {
    if (!this.key) throw new Error('The server has no master key yet.')
    return open(this.key, Buffer.from(data), SECRET_AAD).toString('utf8')
  }
  getSelectedStorageBackend(): string { return 'sahilbot_server_aes_gcm' }
  setUsePlainTextEncryption(): void { /* never */ }
}

/** A JSON file sealed with AES-256-GCM (the device list, push keys). Tampering or a wrong key reads as an error. */
export class EncryptedFile<T> {
  constructor(private file: string, private key: Buffer, private aad: string) {}
  exists(): boolean { return existsSync(this.file) }
  read(): T | undefined {
    if (!existsSync(this.file)) return undefined
    return JSON.parse(open(this.key, readFileSync(this.file), this.aad).toString('utf8')) as T
  }
  write(value: T): void {
    writePrivate(this.file, seal(this.key, Buffer.from(JSON.stringify(value), 'utf8'), this.aad))
  }
}
