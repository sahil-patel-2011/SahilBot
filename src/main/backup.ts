import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync, statSync, realpathSync, cpSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { b64, benchmarkKdf, canonical, deriveFromPassword, open, seal, unb64, wipe, type KdfParams } from './secure/crypto'
import { SECRETISH, type Memory } from './memory'
import type { BackupStatus } from '@shared/types'

export type { BackupStatus }

// "A copy of everything in a separate place" (docs/backups.md). The daily backup (updater.ts backupData) copies
// the data folder; this module adds what lives elsewhere or needs this Mac's Keychain to read:
//   vault/              the knowledge vault folder (its .history too; not .trash, symlinks or files over 50 MB)
//   export/             memories.md, decisions.md and memories.json: readable without SahilBot (no secrets)
//   keys.sbrecovery     every saved API key and connector token, encrypted with a key from the user's recovery
//                       password (scrypt + AES-256-GCM), so the keys can be restored on another Mac without
//                       this Mac's Keychain. Written only once a recovery password is set.
//
// Left out of keys.sbrecovery on purpose: the passwords vault's own keys (vault2:*). With them, anyone who had a
// copy of the data folder and the recovery password could open saved passwords and cards that are otherwise
// bound to this Mac's Keychain (and the master password). Passwords have their own encrypted export (Settings →
// Privacy & Security → Passwords → Backup). The recovery key itself (backup:*) is left out too.

export const RECOVERY_FILE = 'keys.sbrecovery'
export const RECOVERY_FORMAT = 'sahilbot-recovery'
/** The derived recovery key and its parameters, kept as a Keychain-sealed secret (never the password). */
export const RECOVERY_SECRET = 'backup:recoveryKey'
/** Files bigger than this are left out of the vault copy. */
export const MAX_VAULT_FILE = 50 * 1024 * 1024
const MIN_PASSWORD = 10

/** Secret names never written to a recovery file. */
export const excludedFromRecovery = (name: string): boolean => /^vault\d*:/.test(name) || name.startsWith('backup:')

const inside = (child: string, parent: string): boolean => {
  const c = resolve(child), p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}
const real = (p: string): string => { try { return realpathSync(p) } catch { return resolve(p) } }

// ------------------------------------------------------------------ the knowledge vault

export interface VaultCopyResult { files: number; bytes: number; skipped: number }

/**
 * Copies the knowledge vault folder into `dest`. Refuses a vault that is (or holds) the data folder or a backup
 * folder, never follows a symlink, and leaves out .trash and files over MAX_VAULT_FILE. Plain fs only (no ditto),
 * so it works the same in tests.
 */
export function copyVaultFolder(src: string, dest: string, o: { dataDir: string; backupRoots: string[]; maxBytes?: number }): VaultCopyResult {
  const root = real(src)
  if (!existsSync(root) || !statSync(root).isDirectory()) return { files: 0, bytes: 0, skipped: 0 }
  const forbidden = [o.dataDir, ...o.backupRoots].filter(Boolean).map(real)
  for (const f of forbidden) {
    if (inside(root, f)) throw new Error('The knowledge vault is inside SahilBot\'s data or backup folder, so it isn\'t copied separately.')
  }
  const max = o.maxBytes ?? MAX_VAULT_FILE
  const r: VaultCopyResult = { files: 0, bytes: 0, skipped: 0 }
  const walk = (dir: string, out: string): void => {
    mkdirSync(out, { recursive: true })
    for (const name of readdirSync(dir)) {
      const from = join(dir, name)
      if (name === '.trash' || name === '.DS_Store') continue
      // A backup folder (or the data folder) somewhere inside the vault: never copy a backup into itself.
      if (forbidden.some((f) => inside(f, from))) { r.skipped++; continue }
      const st = lstatSync(from)
      if (st.isSymbolicLink()) { r.skipped++; continue }
      if (st.isDirectory()) walk(from, join(out, name))
      else if (st.isFile()) {
        if (st.size > max) { r.skipped++; continue }
        copyFileSync(from, join(out, name))
        r.files++; r.bytes += st.size
      }
    }
  }
  walk(root, dest)
  return r
}

// ------------------------------------------------------------------ readable export of memories and decisions

const CATEGORY_TITLES: Record<string, string> = {
  profile: 'About you', preference: 'Preferences', person: 'People', location: 'Places', work: 'Work', project: 'Projects',
  trip: 'Trips', date: 'Dates', link: 'Links', fact: 'Facts', rule: 'Rules', worklog: 'Work log', decision: 'Decisions'
}
const day = (t: number): string => new Date(t).toISOString().slice(0, 10)
/** A memory that reads like it holds a secret is left out of the readable export. */
const exportable = (m: Memory): boolean => !SECRETISH.test(m.content)

/** memories.md, decisions.md and memories.json in `dir`. Returns how many memories were written. */
export function writeMemoryExport(dir: string, memories: Memory[], o: { spaceName?: (id: string) => string | undefined; now?: Date } = {}): { memories: number; decisions: number } {
  mkdirSync(dir, { recursive: true })
  const list = memories.filter(exportable)
  const scopeOf = (m: Memory): string => (m.spaceId ? `Only ${o.spaceName?.(m.spaceId) ?? 'one bot'}` : 'Shared (every bot)')
  const stamp = (o.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16)
  const tag = (m: Memory): string => [m.provenance === 'untrusted' ? 'unverified' : '', m.source && m.source !== 'chat' ? m.source : ''].filter(Boolean).join(', ')

  const notDecisions = list.filter((m) => m.category !== 'decision')
  const lines: string[] = [`# SahilBot memories`, '', `Exported ${stamp}. ${notDecisions.length} memories; decisions are in decisions.md.`, '']
  const scopes = [...new Set(notDecisions.map(scopeOf))].sort((a, b) => (a.startsWith('Shared') ? -1 : b.startsWith('Shared') ? 1 : a.localeCompare(b)))
  for (const scope of scopes) {
    lines.push(`## ${scope}`, '')
    const inScope = notDecisions.filter((m) => scopeOf(m) === scope)
    const cats = [...new Set(inScope.map((m) => m.category))].sort((a, b) => Object.keys(CATEGORY_TITLES).indexOf(a) - Object.keys(CATEGORY_TITLES).indexOf(b))
    for (const c of cats) {
      lines.push(`### ${CATEGORY_TITLES[c] ?? c}`, '')
      for (const m of inScope.filter((x) => x.category === c)) lines.push(`- ${m.content.replace(/\s+/g, ' ').trim()} _(${day(m.updatedAt)}${tag(m) ? `, ${tag(m)}` : ''})_`)
      lines.push('')
    }
  }
  writeFileSync(join(dir, 'memories.md'), lines.join('\n'))

  const decisions = list.filter((m) => m.category === 'decision').sort((a, b) => b.updatedAt - a.updatedAt)
  const d: string[] = ['# Your decisions', '', `Exported ${stamp}. What you chose, newest first ("context → choice").`, '']
  for (const m of decisions) d.push(`- ${day(m.updatedAt)} · ${m.content.replace(/\s+/g, ' ').trim()}${m.spaceId ? ` _(${scopeOf(m)})_` : ''}`)
  if (!decisions.length) d.push('No decisions saved yet.')
  writeFileSync(join(dir, 'decisions.md'), d.join('\n') + '\n')

  writeFileSync(join(dir, 'memories.json'), JSON.stringify({
    format: 'sahilbot-memories', v: 1, exportedAt: (o.now ?? new Date()).toISOString(),
    memories: list.map((m) => ({ id: m.id, category: m.category, content: m.content, scope: m.spaceId ? (o.spaceName?.(m.spaceId) ?? m.spaceId) : 'shared', source: m.source, provenance: m.provenance ?? 'trusted', createdAt: new Date(m.createdAt).toISOString(), updatedAt: new Date(m.updatedAt).toISOString() }))
  }, null, 2))
  return { memories: list.length, decisions: decisions.length }
}

// ------------------------------------------------------------------ the recovery file (API keys)

export interface RecoveryKey { key: Buffer; kdf: KdfParams }
interface RecoveryHeader { format: typeof RECOVERY_FORMAT; v: 1; kdf: KdfParams; created: string; count: number }
interface RecoveryFileJson extends RecoveryHeader { data: string }

/** Stretches a new recovery password (fresh salt, parameters benchmarked on this Mac). */
export async function makeRecoveryKey(password: string, o: { quick?: boolean } = {}): Promise<RecoveryKey> {
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the recovery password.`)
  const { ms: _ms, ...kdf } = await benchmarkKdf({ quick: o.quick, prefer: 'scrypt' })
  return { key: await deriveFromPassword(password, kdf), kdf }
}

const headerAad = (h: RecoveryHeader): string => canonical({ format: h.format, v: h.v, kdf: h.kdf, created: h.created, count: h.count })

/** The recovery file's text: the header in the clear (no names), the keys sealed with the recovery key. */
export function sealRecovery(rk: RecoveryKey, entries: Record<string, string>, now = new Date()): string {
  const clean = Object.fromEntries(Object.entries(entries).filter(([n, v]) => v && !excludedFromRecovery(n)))
  const header: RecoveryHeader = { format: RECOVERY_FORMAT, v: 1, kdf: rk.kdf, created: now.toISOString(), count: Object.keys(clean).length }
  const plain = Buffer.from(JSON.stringify({ secrets: clean }), 'utf8')
  try {
    const body: RecoveryFileJson = { ...header, data: b64(seal(rk.key, plain, headerAad(header))) }
    return JSON.stringify(body, null, 2) + '\n'
  } finally { wipe(plain) }
}

export class RecoveryError extends Error {
  constructor(message: string, readonly code: 'format' | 'password') { super(message); this.name = 'RecoveryError' }
}

/** Opens a recovery file with the password. A wrong password or an edited file fails with RecoveryError. */
export async function openRecovery(text: string, password: string): Promise<Record<string, string>> {
  let f: RecoveryFileJson
  try { f = JSON.parse(text) as RecoveryFileJson } catch { throw new RecoveryError('That isn\'t a SahilBot recovery file.', 'format') }
  if (f?.format !== RECOVERY_FORMAT || f.v !== 1 || !f.kdf || typeof f.data !== 'string') throw new RecoveryError('That isn\'t a SahilBot recovery file (or it was made by a newer version).', 'format')
  if (f.kdf.alg === 'scrypt' && (f.kdf.N > 2 ** 21 || f.kdf.r > 32 || f.kdf.p > 16)) throw new RecoveryError('This recovery file asks for unsafe settings, so it wasn\'t opened.', 'format')
  const key = await deriveFromPassword(String(password ?? ''), f.kdf)
  let plain: Buffer | undefined
  try {
    plain = open(key, unb64(f.data), headerAad(f))
    const parsed = JSON.parse(plain.toString('utf8')) as { secrets?: Record<string, unknown> }
    return Object.fromEntries(Object.entries(parsed.secrets ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && !excludedFromRecovery(e[0])))
  } catch {
    throw new RecoveryError('Wrong recovery password, or the file was changed.', 'password')
  } finally { wipe(key, plain) }
}

export interface SecretsLike {
  names(): string[]
  get(name: string): string | undefined
  set(name: string, value: string | null): void
  has(name: string): boolean
}

/** Saves the recovered keys. Keys already saved here are kept unless `replace`. Never returns values. */
export function restoreSecrets(entries: Record<string, string>, secrets: SecretsLike, replace = false): { restored: number; kept: number } {
  let restored = 0, kept = 0
  for (const [name, value] of Object.entries(entries)) {
    if (excludedFromRecovery(name) || !value) continue
    if (!replace && secrets.has(name)) { kept++; continue }
    secrets.set(name, value)
    restored++
  }
  return { restored, kept }
}

const keyToJson = (rk: RecoveryKey): string => JSON.stringify({ key: b64(rk.key), kdf: rk.kdf })
const keyFromJson = (s: string | undefined): RecoveryKey | undefined => {
  if (!s) return undefined
  try { const j = JSON.parse(s) as { key: string; kdf: KdfParams }; const key = unb64(j.key); return key.length === 32 && j.kdf ? { key, kdf: j.kdf } : undefined } catch { return undefined }
}

// ------------------------------------------------------------------ the service behind Settings → Backups


export interface BackupDeps {
  dataDir: string
  mainDir: string
  mirrorDir: string
  /** Makes the dated data-folder backup (updater.ts backupData); calls `extras(dest)` before it's marked complete. */
  backupData(o: { extras: (dest: string) => Promise<void> | void; extraMirror?: string }): Promise<string>
  vaultRoot(): string
  memories(): Memory[]
  spaceName?(id: string): string | undefined
  secrets: SecretsLike
  getSetting<T>(key: string): T | undefined
  setSetting(key: string, value: unknown): void
  quickKdf?: boolean
  now?: () => Date
}

const EXTRA_KEY = 'backup:extraDir'
const LAST_KEY = 'backup:last'

function folderBytes(dir: string): number {
  let n = 0
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      try { const st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile()) n += st.size } catch { /* gone */ }
    }
  }
  try { walk(dir) } catch { /* unreadable */ }
  return n
}

export class BackupService {
  private running?: Promise<string>
  private lastError?: string
  constructor(private d: BackupDeps) {}

  extraDir(): string | undefined { return this.d.getSetting<string>(EXTRA_KEY) || undefined }

  /** Checks a folder the user picked for the extra copy. */
  checkExtraDir(path: string): string | undefined {
    if (!path || !existsSync(path)) return 'That folder doesn\'t exist.'
    const p = real(path)
    if (inside(p, real(this.d.dataDir)) || inside(real(this.d.dataDir), p)) return 'Pick a folder outside SahilBot\'s data folder.'
    if (inside(p, real(this.d.mainDir)) || inside(p, real(this.d.mirrorDir))) return 'That\'s already one of the backup folders. Pick another place, like an external drive.'
    return undefined
  }

  setExtraDir(path: string | null): { ok: boolean; error?: string } {
    if (!path) { this.d.setSetting(EXTRA_KEY, null); return { ok: true } }
    const err = this.checkExtraDir(path)
    if (err) return { ok: false, error: err }
    this.d.setSetting(EXTRA_KEY, resolve(path))
    return { ok: true }
  }

  hasRecovery(): boolean { return !!keyFromJson(this.d.secrets.get(RECOVERY_SECRET)) }

  async setRecoveryPassword(password: string): Promise<void> {
    const rk = await makeRecoveryKey(password, { quick: this.d.quickKdf })
    try { this.d.secrets.set(RECOVERY_SECRET, keyToJson(rk)) } finally { wipe(rk.key) }
  }

  clearRecovery(): void { this.d.secrets.set(RECOVERY_SECRET, null) }

  /** The recovery file's text for the keys saved now, or undefined without a recovery password. */
  recoveryText(): string | undefined {
    const rk = keyFromJson(this.d.secrets.get(RECOVERY_SECRET))
    if (!rk) return undefined
    const entries: Record<string, string> = {}
    for (const n of this.d.secrets.names()) {
      if (excludedFromRecovery(n)) continue
      const v = this.d.secrets.get(n)
      if (v) entries[n] = v
    }
    try { return sealRecovery(rk, entries, this.now()) } finally { wipe(rk.key) }
  }

  private now(): Date { return this.d.now?.() ?? new Date() }

  /** What goes into a backup besides the data folder (also used by the daily backup). Returns notes for the status line. */
  async extras(dest: string): Promise<string[]> {
    const notes: string[] = []
    const includes: string[] = ['database & settings']
    try {
      const r = copyVaultFolder(this.d.vaultRoot(), join(dest, 'vault'), { dataDir: this.d.dataDir, backupRoots: [this.d.mainDir, this.d.mirrorDir, this.extraDir() ?? ''] })
      if (r.files) includes.push('knowledge vault')
      if (r.skipped) notes.push(`${r.skipped} vault item${r.skipped === 1 ? '' : 's'} left out (links, or files over 50 MB)`)
    } catch (e) { notes.push((e as Error).message) }
    try {
      writeMemoryExport(join(dest, 'export'), this.d.memories(), { spaceName: this.d.spaceName, now: this.now() })
      includes.push('memories & decisions')
    } catch (e) { notes.push(`Memories weren't exported: ${(e as Error).message}`) }
    try {
      const text = this.recoveryText()
      if (text) { writeFileSync(join(dest, RECOVERY_FILE), text, { mode: 0o600 }); includes.push('API keys (recovery password)') }
      else includes.push('API keys (this Mac\'s Keychain only)')
    } catch (e) { notes.push(`The key recovery file wasn't written: ${(e as Error).message}`) }
    writeFileSync(join(dest, 'BACKUP-CONTENTS.txt'), [
      'What this SahilBot backup holds:',
      '- foreman.db and the other files: SahilBot\'s data folder (chats, memories, settings; API keys sealed with this Mac\'s Keychain).',
      '- vault/: your knowledge vault notes (Markdown, opens in Obsidian).',
      '- export/: memories.md, decisions.md and memories.json, readable anywhere.',
      `- ${RECOVERY_FILE}: your API keys, encrypted with your recovery password (Settings → Privacy & Security → Backups → Restore keys). Only there once you set a recovery password.`,
      ''
    ].join('\n'))
    this.d.setSetting(LAST_KEY, { includes, note: notes.join('; ') || undefined })
    return notes
  }

  /** Backs up now (one at a time). */
  backupNow(): Promise<string> {
    this.running ??= (async () => {
      try {
        const dest = await this.d.backupData({ extras: async (dest) => { await this.extras(dest) }, extraMirror: this.extraDir() })
        this.lastError = undefined
        return dest
      } catch (e) { this.lastError = (e as Error).message; throw e }
    })().finally(() => { this.running = undefined })
    return this.running
  }

  /** Copies a finished backup folder into the extra folder and keeps its newest `keep`. */
  static copyToExtra(src: string, extra: string, keep = 3): void {
    mkdirSync(extra, { recursive: true })
    cpSync(src, join(extra, basename(src)), { recursive: true, verbatimSymlinks: true })
    const dated = readdirSync(extra).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort()
    for (const old of dated.slice(0, Math.max(0, dated.length - keep))) rmSync(join(extra, old), { recursive: true, force: true })
  }

  async restoreKeys(text: string, password: string, replace = false): Promise<{ restored: number; kept: number }> {
    const entries = await openRecovery(text, password)
    return restoreSecrets(entries, this.d.secrets, replace)
  }

  status(): BackupStatus {
    const folders: BackupStatus['folders'] = [{ kind: 'main', path: this.d.mainDir }, { kind: 'mirror', path: this.d.mirrorDir }]
    const extra = this.extraDir()
    if (extra) folders.push({ kind: 'extra', path: extra })
    let last: BackupStatus['last']
    const root = this.d.mainDir
    const done = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, '.complete.json'))).sort().at(-1) : undefined
    const saved = this.d.getSetting<{ includes?: string[]; note?: string }>(LAST_KEY)
    if (done) {
      const path = join(root, done)
      let info: { at?: number; label?: string } = {}
      try { info = JSON.parse(readFileSync(join(path, '.complete.json'), 'utf8')) as typeof info } catch { /* older backup */ }
      const has = (n: string): boolean => existsSync(join(path, n))
      const includes = ['database & settings', ...(has('vault') ? ['knowledge vault'] : []), ...(has('export') ? ['memories & decisions'] : []), ...(has(RECOVERY_FILE) ? ['API keys (recovery password)'] : ['API keys (this Mac\'s Keychain only)'])]
      last = { at: info.at ?? statSync(path).mtimeMs, path, bytes: folderBytes(path), label: info.label ?? '', includes }
    }
    return { folders, last, running: !!this.running, recoveryPassword: this.hasRecovery(), note: saved?.note, error: this.lastError }
  }
}

/** Every saved secret's name (the settings rows "secret:<name>"). */
export function secretNames(rows: Array<{ key: string }>): string[] {
  return rows.map((r) => r.key.slice('secret:'.length)).filter(Boolean)
}
