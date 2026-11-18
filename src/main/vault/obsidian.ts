import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, watch, writeFileSync, type Dirent, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ObsidianFolderCheck, ObsidianSettings, ObsidianVaultChoice } from '@shared/vault'
import { parseNote, summaryOf, titleKey, wikilinks } from './notes'
import type { NoteSource } from './retrieve'
import { OBSIDIAN_PREFIX, OBSIDIAN_SECTION, VaultStore, isGeneratedPath, type VaultNote, type VaultNoteMeta } from './store'

// "Use my Obsidian vault" (docs/vault.md):
//   - SahilBot's own notes (Home, Changelog, Shared/, Bots/…) and its .history/, .trash/ and .sahilbot/
//     live in one subfolder of the user's vault ("SahilBot" by default): the VaultStore's root moves there.
//   - ObsidianReader: read-only access to the rest of the user's vault for search and recall (dot folders,
//     SahilBot's subfolder and the user's exclude list are never read; `..` and symlinks leaving the vault
//     are refused). Paths are "obsidian:<path in the vault>".
//   - ObsidianSync: notices edits made in Obsidian to SahilBot's own notes (a watcher plus a rescan) and
//     logs them in Changes as "you (in Obsidian)" with a copy of the earlier version, so Undo works for
//     them too. The last version SahilBot wrote or saw of each note is kept in .sahilbot/last/.
// Pure helpers (detection, settings cleaning, the obsidian:// URL) are exported for tests.

export const DEFAULT_SUBFOLDER = 'SahilBot'
export const OBSIDIAN_ACTOR = 'you (in Obsidian)'
export const DEFAULT_OBSIDIAN: ObsidianSettings = { enabled: false, vault: '', subfolder: DEFAULT_SUBFOLDER, exclude: [] }

const posix = (p: string): string => p.split(sep).join('/')
export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

// ---------------------------------------------------------------- picking the vault

/** The folder has `.obsidian/` (Obsidian has opened it as a vault). */
export function isObsidianVault(dir: string): boolean {
  try { return statSync(join(dir, '.obsidian')).isDirectory() } catch { return false }
}

/**
 * The vaults Obsidian knows about (~/Library/Application Support/obsidian/obsidian.json:
 * `{ "vaults": { "<id>": { "path": "/abs", "ts": 123, "open": true } } }`), only those whose folder
 * still exists with `.obsidian/` inside, most recently opened first.
 */
export function detectObsidianVaults(home: string): ObsidianVaultChoice[] {
  let j: unknown
  try { j = JSON.parse(readFileSync(join(home, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), 'utf8')) } catch { return [] }
  const vaults = (j as { vaults?: unknown })?.vaults
  if (!vaults || typeof vaults !== 'object') return []
  const out = new Map<string, ObsidianVaultChoice>()
  for (const v of Object.values(vaults as Record<string, unknown>).slice(0, 200)) {
    const x = v as { path?: unknown; ts?: unknown; open?: unknown }
    if (!x || typeof x.path !== 'string' || !isAbsolute(x.path)) continue
    const path = resolve(x.path)
    if (out.has(path) || !isObsidianVault(path)) continue
    out.set(path, { path, name: basename(path), ...(typeof x.ts === 'number' && Number.isFinite(x.ts) ? { ts: x.ts } : {}), ...(x.open === true ? { open: true } : {}) })
  }
  return [...out.values()].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
}

/** A folder the user chose: it must be a folder; `isVault` says whether Obsidian has opened it. */
export function checkObsidianFolder(path: string): ObsidianFolderCheck {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Choose a full folder path.')
  const p = resolve(path)
  let st
  try { st = statSync(p) } catch { throw new Error('That folder doesn\'t exist.') }
  if (!st.isDirectory()) throw new Error('That\'s a file, not a folder.')
  if (p === resolve('/')) throw new Error('Choose your Obsidian vault\'s folder, not the whole disk.')
  return { path: p, name: basename(p), isVault: isObsidianVault(p) }
}

/** SahilBot's subfolder: a relative path of plain folder names (no dot folders, no `..`). Default "SahilBot". */
export function cleanSubfolder(v: unknown): string {
  if (typeof v !== 'string') return DEFAULT_SUBFOLDER
  const parts = v.replace(/\\/g, '/').split('/')
    .map((s) => s.replace(/[*"<>:|?#^[\]\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => s.replace(/^\.+/, '').trim())
    .filter(Boolean)
  const out = parts.join('/').slice(0, 120).replace(/\/+$/, '')
  return out || DEFAULT_SUBFOLDER
}

/** The exclude list: vault-relative folder or file prefixes ("Private/", "Journal/2024"). */
export function cleanExclude(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v.slice(0, 200)) {
    if (typeof x !== 'string') continue
    let p = x.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
    if (!p || p.split('/').some((s) => s === '..')) continue
    p = p.slice(0, 300)
    if (!out.some((o) => o.toLowerCase() === p.toLowerCase())) out.push(p)
    if (out.length >= 100) break
  }
  return out
}

export function cleanObsidianSettings(v: unknown): ObsidianSettings {
  const x = (v ?? {}) as Partial<ObsidianSettings>
  const vault = typeof x.vault === 'string' ? x.vault.trim().slice(0, 1000) : ''
  return { enabled: x.enabled === true && !!vault, vault, subfolder: cleanSubfolder(x.subfolder), exclude: cleanExclude(x.exclude) }
}

/** On the exclude list (prefix match, case-insensitive like the Mac's disks). `rel`: relative to the vault root. */
export function isExcluded(rel: string, exclude: string[]): boolean {
  const r = posix(rel).replace(/^\/+/, '').toLowerCase()
  return exclude.some((e) => {
    const p = e.toLowerCase()
    return p.endsWith('/') ? `${r}/`.startsWith(p) : r.startsWith(p)
  })
}

/** Inside SahilBot's subfolder (relative to the vault root; case-insensitive). */
export function inSubfolder(rel: string, subfolder: string): boolean {
  const r = posix(rel).toLowerCase(), s = subfolder.toLowerCase()
  return r === s || r.startsWith(`${s}/`)
}

/**
 * Opens a note (or the vault) in Obsidian: `obsidian://open?vault=<folder name>&file=<path in the vault,
 * without .md>`. Obsidian names a vault by its folder name.
 */
export function obsidianOpenUrl(vaultRoot: string, file?: string): string {
  let u = `obsidian://open?vault=${encodeURIComponent(basename(resolve(vaultRoot)))}`
  if (file) u += `&file=${encodeURIComponent(posix(file).replace(/^\/+/, '').replace(/\.md$/i, ''))}`
  return u
}

// ---------------------------------------------------------------- reading the user's own vault

export interface ObsidianReaderOptions {
  /** The vault root, '' when "Use my Obsidian vault" is off. */
  vault: () => string
  subfolder: () => string
  exclude: () => string[]
  now?: () => number
  maxFiles?: number
  maxFileBytes?: number
  maxDepth?: number
}

/** The user's own notes, outside SahilBot's subfolder: read-only, cached by mtime/size and content hash. */
export class ObsidianReader implements NoteSource {
  private cache = new Map<string, { mtime: number; size: number; hash: string; note: VaultNote }>()
  private scanned: { at: number; key: string; list: VaultNote[] } | null = null

  constructor(private o: ObsidianReaderOptions) {}

  private now(): number { return this.o.now?.() ?? Date.now() }
  get root(): string { const v = this.o.vault(); return v ? resolve(v) : '' }
  private key(): string { return `${this.root}|${this.o.subfolder()}|${this.o.exclude().join('\n')}` }

  invalidate(): void { this.scanned = null }

  /** The vault-relative path of "obsidian:<rel>" (or a bare rel), refusing what the reader never reads. */
  relOf(path: string): string {
    const raw = path.startsWith(OBSIDIAN_PREFIX) ? path.slice(OBSIDIAN_PREFIX.length) : path
    const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!this.root) throw new Error('"Use my Obsidian vault" is off.')
    if (!rel || isAbsolute(raw) || rel.split('/').some((s) => !s || s === '..' || s.startsWith('.'))) throw new Error('That path is outside your Obsidian vault.')
    if (!/\.md$/i.test(rel)) throw new Error('Only Markdown notes (.md) in your Obsidian vault can be read.')
    if (inSubfolder(rel, this.o.subfolder())) throw new Error('That note is in SahilBot\'s own folder: use its normal path.')
    if (isExcluded(rel, this.o.exclude())) throw new Error('That note is in a folder you excluded. SahilBot never reads it.')
    return rel
  }

  /** The real file for a note path, refusing `..`, dot folders, excluded paths and symlinks that leave the vault. */
  abs(path: string): string {
    const rel = this.relOf(path)
    const root = this.root
    const p = resolve(root, rel)
    if (!within(root, p)) throw new Error('That path is outside your Obsidian vault.')
    if (!existsSync(p)) return p
    let real: string, realRoot: string
    try { real = realpathSync(p); realRoot = realpathSync(root) } catch { throw new Error('That note can\'t be read.') }
    if (!within(realRoot, real)) throw new Error('That note links to a file outside your Obsidian vault.')
    const realRel = posix(relative(realRoot, real))
    if (realRel.split('/').some((s) => s.startsWith('.')) || isExcluded(realRel, this.o.exclude()) || inSubfolder(realRel, this.o.subfolder())) {
      throw new Error('That note links to a place SahilBot doesn\'t read.')
    }
    return real
  }

  private parse(rel: string, text: string, mtime: number, size: number): VaultNote {
    const { fm, body } = parseNote(text)
    if (!/^---\n(?:[\s\S]*?\n)?type:/.test(text.replace(/\r\n?/g, '\n'))) fm.type = VaultStore.typeOfPath(rel)
    const file = rel.split('/').pop()!.replace(/\.md$/i, '')
    return {
      path: `${OBSIDIAN_PREFIX}${rel}`, title: fm.title || file, type: fm.type === 'index' ? 'fact' : fm.type, section: OBSIDIAN_SECTION, tags: fm.tags, aliases: fm.aliases,
      sources: fm.sources, created: fm.created, updated: fm.updated, trust: fm.trust ?? 'trusted', links: wikilinks(body), summary: summaryOf(body),
      mtime, size, generated: false, text, body, fm
    }
  }

  private load(rel: string, abs: string, mtime: number, size: number): VaultNote | undefined {
    const hit = this.cache.get(rel)
    if (hit && hit.mtime === mtime && hit.size === size) return hit.note
    if (size > (this.o.maxFileBytes ?? 1024 * 1024)) return undefined
    let text: string
    try { text = readFileSync(abs, 'utf8') } catch { return undefined }
    const hash = sha256(text)
    // Touched but the same words (a sync tool, a re-save): keep the parsed note.
    if (hit && hit.hash === hash) { hit.mtime = mtime; hit.size = size; return hit.note }
    const note = this.parse(rel, text, mtime, size)
    this.cache.set(rel, { mtime, size, hash, note })
    return note
  }

  /** Every readable note, newest first. Cached for a few seconds; the watcher clears it on edits. */
  list(): VaultNoteMeta[] { return this.notes() }

  notes(): VaultNote[] {
    const root = this.root
    if (!root || !existsSync(root)) return []
    const key = this.key()
    if (this.scanned && this.scanned.key === key && this.now() - this.scanned.at < 10_000) return this.scanned.list
    let realRoot: string
    try { realRoot = realpathSync(root) } catch { return [] }
    const sub = this.o.subfolder(), ex = this.o.exclude()
    const maxFiles = this.o.maxFiles ?? 10_000, maxDepth = this.o.maxDepth ?? 12
    const out: VaultNote[] = []
    const seen = new Set<string>()
    const walk = (dir: string, relDir: string, depth: number): void => {
      if (depth > maxDepth || out.length >= maxFiles) return
      let ents: Dirent[] = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const d of ents) {
        if (out.length >= maxFiles) return
        if (d.name.startsWith('.')) continue
        const rel = relDir ? `${relDir}/${d.name}` : d.name
        const p = join(dir, d.name)
        if (d.isDirectory()) {
          if (inSubfolder(rel, sub) || isExcluded(`${rel}/`, ex)) continue
          walk(p, rel, depth + 1)
          continue
        }
        if (!/\.md$/i.test(d.name) || isExcluded(rel, ex)) continue
        let real = p
        if (d.isSymbolicLink()) {
          // A linked note counts only when it points at a readable note inside the vault (folders aren't followed).
          try { real = realpathSync(p) } catch { continue }
          const rr = posix(relative(realRoot, real))
          if (!within(realRoot, real) || rr.split('/').some((s) => s.startsWith('.')) || isExcluded(rr, ex) || inSubfolder(rr, sub)) continue
        } else if (!d.isFile()) continue
        let st
        try { st = statSync(real) } catch { continue }
        if (!st.isFile()) continue
        seen.add(rel)
        const n = this.load(rel, real, st.mtimeMs, st.size)
        if (n) out.push(n)
      }
    }
    walk(root, '', 0)
    for (const k of [...this.cache.keys()]) if (!seen.has(k)) this.cache.delete(k)
    out.sort((a, b) => b.mtime - a.mtime)
    this.scanned = { at: this.now(), key, list: out }
    return out
  }

  read(path: string): VaultNote | undefined {
    let rel: string, p: string
    try { rel = this.relOf(path); p = this.abs(path) } catch { return undefined }
    let st
    try { st = statSync(p) } catch { return undefined }
    if (!st.isFile()) return undefined
    return this.load(rel, p, st.mtimeMs, st.size)
  }

  /** A note by "obsidian:<path>", path, title, alias or file name. */
  find(ref: string): VaultNote | undefined {
    const r = ref.trim().replace(/^\[\[|\]\]$/g, '').replace(/\|.*$/, '').replace(/#.*$/, '')
    if (!r) return undefined
    if (r.startsWith(OBSIDIAN_PREFIX)) return this.read(r.endsWith('.md') ? r : `${r}.md`)
    const all = this.notes()
    const byPath = all.find((n) => n.path === `${OBSIDIAN_PREFIX}${r}` || n.path === `${OBSIDIAN_PREFIX}${r}.md`)
    if (byPath) return byPath
    const k = titleKey(r.split('/').pop()!.replace(/\.md$/i, ''))
    return all.find((n) => titleKey(n.title) === k || n.aliases.some((a) => titleKey(a) === k) || titleKey(n.path.split('/').pop()!.replace(/\.md$/i, '')) === k)
  }

  /**
   * Writes one of the user's own notes: only for an edit the user approved (the vault tool's
   * edit_obsidian_note, and Undo of one). The note must already exist and be readable.
   */
  write(path: string, text: string): void {
    const p = this.abs(path)
    if (!existsSync(p)) throw new Error('That note isn\'t in your Obsidian vault any more.')
    const tmp = `${p}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, p)
    this.invalidate()
  }
}

// ---------------------------------------------------------------- noticing edits made in Obsidian

interface Manifest { v: 1; files: Record<string, { hash: string; mtime: number; size: number }> }

export interface ObsidianSyncOptions {
  store: VaultStore
  /** "Use my Obsidian vault" is on (the store's root is the subfolder). */
  active: () => boolean
  /** The vault root, for the watcher. */
  vault: () => string
  subfolder: () => string
  reader: ObsidianReader
  /** Something changed: the UI refreshes. */
  onChange?: () => void
  /** The fallback rescan interval (default 30 s). */
  every?: number
  debounce?: number
}

export interface PickedUp { at: number; op: 'create' | 'update' | 'trash'; path: string; title: string }

export class ObsidianSync {
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private soon: ReturnType<typeof setTimeout> | null = null
  private outsideSoon: ReturnType<typeof setTimeout> | null = null
  private manifest: Manifest | null = null
  private manifestRoot = ''
  private busy = false
  last?: PickedUp

  constructor(private o: ObsidianSyncOptions) {}

  private get root(): string { return this.o.store.root }
  private get manifestPath(): string { return join(this.root, '.sahilbot', 'last.json') }
  private shadowPath(rel: string): string { return join(this.root, '.sahilbot', 'last', ...rel.split('/')) }

  /** SahilBot's own notes this tracks: Markdown outside dot folders, not Home/Changelog/Index. */
  static tracked(rel: string): boolean {
    return /\.md$/i.test(rel) && !rel.split('/').some((s) => s.startsWith('.')) && !isGeneratedPath(rel)
  }

  // ------------------------------------------------ lifecycle

  get watching(): boolean { return !!this.watcher }

  start(): void {
    this.stop()
    if (!this.o.active()) return
    const vault = this.o.vault()
    try {
      this.watcher = watch(vault, { recursive: true, encoding: 'utf8' }, (_ev, name) => this.onEvent(typeof name === 'string' ? name : null))
      this.watcher.on('error', () => { try { this.watcher?.close() } catch { /* gone */ } this.watcher = null })
    } catch { this.watcher = null /* the timer below still picks edits up */ }
    this.timer = setInterval(() => { try { this.rescan() } catch { /* next time */ } }, this.o.every ?? 30_000)
    this.timer.unref?.()
    this.poke()
  }

  stop(): void {
    try { this.watcher?.close() } catch { /* closed */ }
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    if (this.outsideSoon) clearTimeout(this.outsideSoon)
    this.timer = this.soon = this.outsideSoon = null
  }

  /** Rescan shortly (a watcher event, the window got focus). */
  poke(): void {
    if (!this.o.active()) return
    if (this.soon) clearTimeout(this.soon)
    this.soon = setTimeout(() => { this.soon = null; try { this.rescan() } catch { /* next time */ } }, this.o.debounce ?? 700)
    this.soon.unref?.()
  }

  private onEvent(name: string | null): void {
    const sub = this.o.subfolder()
    const f = name ? posix(name) : null
    if (f && !inSubfolder(f, sub)) {
      // The user's own notes: only re-read for search (never logged as SahilBot changes).
      if (f.split('/').some((s) => s.startsWith('.'))) return
      this.o.reader.invalidate()
      if (!this.outsideSoon) {
        this.outsideSoon = setTimeout(() => { this.outsideSoon = null; try { this.o.onChange?.() } catch { /* window gone */ } }, 1500)
        this.outsideSoon.unref?.()
      }
      return
    }
    // SahilBot's own bookkeeping (.history, .trash, .sahilbot) never triggers a rescan.
    if (f && f.slice(sub.length + 1).split('/').some((s) => s.startsWith('.'))) return
    this.poke()
  }

  // ------------------------------------------------ the last-known copies

  private loadManifest(): Manifest | null {
    if (this.manifest && this.manifestRoot === this.root) return this.manifest
    this.manifest = null
    this.manifestRoot = this.root
    try {
      const m = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as Manifest
      if (m && m.v === 1 && m.files && typeof m.files === 'object') this.manifest = m
    } catch { /* none yet */ }
    return this.manifest
  }

  private saveManifest(m: Manifest): void {
    mkdirSync(dirname(this.manifestPath), { recursive: true })
    const tmp = `${this.manifestPath}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(m))
    renameSync(tmp, this.manifestPath)
    this.manifest = m
    this.manifestRoot = this.root
  }

  private readShadow(rel: string): string | undefined {
    try { return readFileSync(this.shadowPath(rel), 'utf8') } catch { return undefined }
  }

  private writeShadow(rel: string, text: string): void {
    const p = this.shadowPath(rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, text)
  }

  /** Remembers a note's current file as the last version SahilBot knows. */
  private remember(m: Manifest, rel: string): void {
    const p = join(this.root, ...rel.split('/'))
    const text = readFileSync(p, 'utf8')
    const st = statSync(p)
    this.writeShadow(rel, text)
    m.files[rel] = { hash: sha256(text), mtime: st.mtimeMs, size: st.size }
  }

  // ------------------------------------------------ the store's hooks (SahilBot's own writes)

  /** Before SahilBot changes a note: an Obsidian edit made since is logged first. */
  before(rel: string): void {
    if (!this.o.active() || this.busy || !ObsidianSync.tracked(rel)) return
    const m = this.loadManifest()
    if (!m) return
    const p = join(this.root, ...rel.split('/'))
    if (!existsSync(p)) return
    if (this.check(m, rel, p) !== 'same') { this.saveManifest(m); this.o.store.invalidateAll() }
  }

  /** SahilBot wrote (or put back) a note: that's now the known version. */
  wrote(rel: string): void {
    if (!this.o.active() || !ObsidianSync.tracked(rel)) return
    const m = this.loadManifest() ?? (this.baseline(), this.loadManifest())
    if (!m) return
    try { this.remember(m, rel); this.saveManifest(m) } catch { /* the next rescan sees it */ }
  }

  /** SahilBot moved a note to its trash. */
  gone(rel: string): void {
    if (!this.o.active() || !ObsidianSync.tracked(rel)) return
    const m = this.loadManifest()
    if (!m || !m.files[rel]) return
    delete m.files[rel]
    this.saveManifest(m)
  }

  // ------------------------------------------------ rescanning

  /** SahilBot's notes on disk now (relative to its folder). */
  private files(): string[] {
    const out: string[] = []
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 10 || out.length > 20_000) return
      let ents: Dirent[] = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const d of ents) {
        if (d.name.startsWith('.')) continue
        const r = rel ? `${rel}/${d.name}` : d.name
        if (d.isDirectory()) walk(join(dir, d.name), r, depth + 1)
        else if (d.isFile() && ObsidianSync.tracked(r)) out.push(r)
      }
    }
    walk(this.root, '', 0)
    return out
  }

  /** First run: what's there now is what SahilBot knows (nothing is logged). */
  baseline(): number {
    const m: Manifest = { v: 1, files: {} }
    const files = this.files()
    for (const rel of files) { try { this.remember(m, rel) } catch { /* unreadable */ } }
    this.saveManifest(m)
    return files.length
  }

  /**
   * One note against its last-known version: 'logged' when an Obsidian edit (or new note) was logged,
   * 'touched' when only its file date changed, 'same' otherwise.
   */
  private check(m: Manifest, rel: string, p: string): 'same' | 'touched' | 'logged' {
    let st
    try { st = statSync(p) } catch { return 'same' }
    const e = m.files[rel]
    if (e && e.mtime === st.mtimeMs && e.size === st.size) return 'same'
    let text: string
    try { text = readFileSync(p, 'utf8') } catch { return 'same' }
    const hash = sha256(text)
    if (e && e.hash === hash) { e.mtime = st.mtimeMs; e.size = st.size; return 'touched' }
    const store = this.o.store
    const title = parseNote(text).fm.title || rel.split('/').pop()!.replace(/\.md$/i, '')
    if (e) {
      const prev = this.readShadow(rel)
      const history = prev !== undefined ? store.keepHistory(rel, prev) : undefined
      store.record({ actor: OBSIDIAN_ACTOR, op: 'update', path: rel, title, why: 'edited in Obsidian', history })
      this.last = { at: store.now(), op: 'update', path: rel, title }
    } else {
      store.record({ actor: OBSIDIAN_ACTOR, op: 'create', path: rel, title, why: 'made in Obsidian' })
      this.last = { at: store.now(), op: 'create', path: rel, title }
    }
    this.writeShadow(rel, text)
    m.files[rel] = { hash, mtime: st.mtimeMs, size: st.size }
    return 'logged'
  }

  /**
   * Compares SahilBot's notes with the last versions it wrote or saw: edits and new notes made in
   * Obsidian are logged as "you (in Obsidian)" (the earlier version kept in .history); a note deleted
   * there is logged as moved to trash, with its last copy in .trash so Undo puts it back. Returns how
   * many changes were picked up.
   */
  rescan(): number {
    if (!this.o.active() || this.busy || !existsSync(this.root)) return 0
    this.busy = true
    let picked = 0
    try {
      const m = this.loadManifest()
      if (!m) { this.baseline(); return 0 }
      let dirty = false
      const now = this.files()
      const seen = new Set(now)
      for (const rel of now) {
        const r = this.check(m, rel, join(this.root, ...rel.split('/')))
        if (r !== 'same') dirty = true
        if (r === 'logged') picked++
      }
      const store = this.o.store
      for (const rel of Object.keys(m.files)) {
        if (seen.has(rel) || existsSync(join(this.root, ...rel.split('/')))) continue
        const prev = this.readShadow(rel)
        const title = (prev !== undefined ? parseNote(prev).fm.title : undefined) || rel.split('/').pop()!.replace(/\.md$/i, '')
        const movedTo = prev !== undefined ? store.keepTrash(rel, prev) : undefined
        store.record({ actor: OBSIDIAN_ACTOR, op: 'trash', path: rel, title, why: 'deleted in Obsidian', movedTo })
        this.last = { at: store.now(), op: 'trash', path: rel, title }
        delete m.files[rel]
        dirty = true
        picked++
      }
      if (dirty) this.saveManifest(m)
      if (picked) {
        store.invalidateAll()
        try { store.rebuildIndexes() } catch { /* indexes catch up later */ }
        try { this.o.onChange?.() } catch { /* window gone */ }
      }
      return picked
    } finally {
      this.busy = false
    }
  }

}
