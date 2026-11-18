import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import type { ObsidianFolderCheck, ObsidianSyncStatus, ObsidianVaultChoice, VaultChangeInfo, VaultLevel, VaultNoteFull, VaultNoteInfo, VaultSearchHit, VaultSettings, VaultSettingsPatch, VaultStatus } from '@shared/vault'
import type { Db } from '../db'
import { VaultCompiler, type CompilerDeps } from './compile'
import { day, mergeBody, normalizeType, plainText, safeTitle, titleKey, type NoteType } from './notes'
import { DEFAULT_OBSIDIAN, ObsidianReader, ObsidianSync, checkObsidianFolder, cleanObsidianSettings, detectObsidianVaults, isObsidianVault, obsidianOpenUrl } from './obsidian'
import { VAULT_TITLE, retrieve, vaultBudget, vaultLines, type Retrieved } from './retrieve'
import { OBSIDIAN_PREFIX, OBSIDIAN_SECTION, SHARED, VaultStore, isGeneratedPath, type ChangeInfo, type VaultChange, type VaultNote, type VaultNoteMeta } from './store'
import { zipFiles } from './zip'

// The knowledge vault, put together: settings (on/off, folder, how much to remember, per bot), the
// store, the compiler the learning pass runs, retrieval for each run's context block, search for the
// vault tool, and what the Vault view needs (notes, backlinks, graph, changes with Undo, export).

export const DEFAULT_VAULT: VaultSettings = { enabled: true, dir: '', level: 'aggressive', docs: true, activity: true, bots: {}, obsidian: { ...DEFAULT_OBSIDIAN } }
const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const SETTINGS_KEY = 'vault:settings'
const BOTS_KEY = 'vault:sections'

export function cleanVaultSettings(v: unknown): VaultSettings {
  const x = (v ?? {}) as Partial<VaultSettings>
  const lvl = (l: unknown): VaultLevel | undefined => (l === 'normal' || l === 'aggressive' ? l : undefined)
  const bots: VaultSettings['bots'] = {}
  if (x.bots && typeof x.bots === 'object') {
    for (const [id, b] of Object.entries(x.bots).slice(0, 500)) {
      if (!b || typeof b !== 'object') continue
      const e: { enabled?: boolean; level?: VaultLevel } = {}
      if (typeof b.enabled === 'boolean') e.enabled = b.enabled
      if (lvl(b.level)) e.level = lvl(b.level)
      if (Object.keys(e).length) bots[id] = e
    }
  }
  return {
    enabled: x.enabled !== false,
    dir: typeof x.dir === 'string' ? x.dir.trim().slice(0, 1000) : '',
    level: lvl(x.level) ?? 'aggressive',
    docs: x.docs !== false,
    activity: x.activity !== false,
    bots,
    obsidian: cleanObsidianSettings(x.obsidian)
  }
}

export interface VaultServiceDeps {
  db: Db
  workspace: () => string
  /** The knowledge index's keyword search over a folder (absolute paths, best first). */
  keyword?: (query: string, root: string, limit: number) => string[]
  docs?: CompilerDeps['docs']
  activity?: CompilerDeps['activity']
  isRunning?: (threadId: string) => boolean
  isAppThread?: (threadId: string) => boolean
  secretValues?: () => string[]
  /** The vault folder changed (the knowledge base may need to index it). */
  onRootChange?: (root: string) => void
  onChange?: () => void
  now?: () => number
  home?: string
}

export class VaultService {
  readonly store: VaultStore
  readonly compiler: VaultCompiler
  /** The user's own notes in their Obsidian vault (outside SahilBot's subfolder), read-only. */
  readonly obsidianReader: ObsidianReader
  /** Picks up edits made in Obsidian to SahilBot's own notes (logged with Undo). */
  readonly obsidianSync: ObsidianSync
  /** Folders the user chose with the folder picker this session (any other new vault path is refused). */
  private picked = new Set<string>()
  private syncStarted = false

  constructor(private d: VaultServiceDeps) {
    this.store = new VaultStore(() => this.root(), () => this.now())
    this.obsidianReader = new ObsidianReader({
      vault: () => (this.obsidianActive() ? this.obsidianVaultRoot() : ''),
      subfolder: () => this.settings().obsidian.subfolder,
      exclude: () => this.readerExclude(),
      now: () => this.now()
    })
    this.obsidianSync = new ObsidianSync({
      store: this.store,
      active: () => this.obsidianActive(),
      vault: () => this.obsidianVaultRoot(),
      subfolder: () => this.settings().obsidian.subfolder,
      reader: this.obsidianReader,
      onChange: () => this.changed()
    })
    this.store.hooks = {
      before: (rel) => this.obsidianSync.before(rel),
      wrote: (rel) => this.obsidianSync.wrote(rel),
      gone: (rel) => this.obsidianSync.gone(rel)
    }
    // Undo of an approved edit to one of the user's own notes.
    this.store.external = {
      read: (path) => this.obsidianReader.read(path)?.text,
      write: (path, text) => this.obsidianReader.write(path, text)
    }
    this.compiler = new VaultCompiler({
      db: d.db,
      store: () => this.store,
      enabled: () => this.settings().enabled,
      level: () => this.settings().level,
      botEnabled: (spaceId) => this.botEnabled(spaceId),
      sectionFor: (spaceId) => this.sectionFor(spaceId),
      isMainBot: (spaceId) => !!d.db.getSpace(spaceId)?.isMain,
      isRunning: d.isRunning,
      isAppThread: d.isAppThread,
      secretValues: d.secretValues,
      docs: d.docs ? { ...d.docs, enabled: () => this.settings().docs && d.docs!.enabled() } : undefined,
      activity: d.activity ? { ...d.activity, enabled: () => this.settings().activity && d.activity!.enabled() } : undefined
    })
  }

  private now(): number { return this.d.now?.() ?? Date.now() }

  // ---------------------------------------------------------------- settings

  settings(): VaultSettings {
    return cleanVaultSettings(this.d.db.getSetting(SETTINGS_KEY))
  }

  defaultRoot(): string {
    return join(this.d.workspace() || join(this.d.home ?? homedir(), 'SahilBot'), 'SahilBot Vault')
  }

  /** Where SahilBot writes: the Obsidian subfolder when that's on, else the folder setting (or the default). */
  root(): string {
    if (this.obsidianActive()) return join(this.obsidianVaultRoot(), ...this.settings().obsidian.subfolder.split('/'))
    return this.previousRoot()
  }

  /** The folder SahilBot uses without Obsidian (kept as it was while Obsidian mode is on). */
  previousRoot(): string {
    const dir = this.settings().dir
    return dir ? dir.replace(/^~(?=\/|$)/, this.d.home ?? homedir()) : this.defaultRoot()
  }

  setSettings(patch: VaultSettingsPatch): VaultSettings {
    const before = this.root()
    const cur = this.settings()
    const obs = patch.obsidian ? cleanObsidianSettings({ ...cur.obsidian, ...patch.obsidian }) : cur.obsidian
    // Checked when turning it on or picking another folder (turning it off always works, even if the vault is gone).
    if (patch.obsidian && obs.vault && (obs.enabled || obs.vault !== cur.obsidian.vault)) {
      obs.vault = obs.vault.replace(/^~(?=\/|$)/, this.d.home ?? homedir())
      const check = checkObsidianFolder(obs.vault)
      obs.vault = check.path
      // A new vault folder comes only from the folder picker or Obsidian's own list of vaults.
      if (obs.vault !== cur.obsidian.vault && !this.allowedFolder(obs.vault)) throw new Error('Choose your Obsidian vault with “Choose folder…” or from the vaults Obsidian lists.')
      if (obs.enabled && within(resolve(this.previousRoot()), obs.vault)) throw new Error('That folder is inside SahilBot\'s own vault folder. Choose your Obsidian vault instead.')
    }
    const next = cleanVaultSettings({ ...cur, ...patch, obsidian: obs, bots: cur.bots })
    if (next.dir && !next.dir.startsWith('/') && !next.dir.startsWith('~')) throw new Error('Choose a full folder path for the vault.')
    this.d.db.setSetting(SETTINGS_KEY, next)
    this.obsidianReader.invalidate()
    const moved = this.root() !== before
    if (moved) { this.store.invalidateAll(); this.store.ensure(); this.d.onRootChange?.(this.root()) }
    if (moved || patch.obsidian) {
      if (this.syncStarted && this.obsidianActive()) this.obsidianSync.start()
      else this.obsidianSync.stop()
      // The first look at SahilBot's notes in the vault: what's there now is what it knows.
      if (moved && this.obsidianActive()) { try { this.obsidianSync.rescan() } catch { /* the watcher retries */ } }
    }
    this.changed()
    return next
  }

  // ---------------------------------------------------------------- "Use my Obsidian vault"

  /** Obsidian mode is on and its vault folder is there (an unplugged drive: SahilBot uses its own folder meanwhile). */
  obsidianActive(): boolean {
    const o = this.settings().obsidian
    if (!o.enabled || !o.vault) return false
    try { return statSync(o.vault).isDirectory() } catch { return false }
  }

  obsidianVaultRoot(): string { return resolve(this.settings().obsidian.vault || '/nonexistent') }

  /** The user's exclude list, plus SahilBot's previous folder when it sits inside the vault (never read twice). */
  private readerExclude(): string[] {
    const ex = [...this.settings().obsidian.exclude]
    const prev = resolve(this.previousRoot()), root = this.obsidianVaultRoot()
    if (prev !== root && within(root, prev)) ex.push(`${relative(root, prev).split(sep).join('/')}/`)
    return ex
  }

  /** Vaults Obsidian knows about (one-click choices). */
  detectObsidian(): ObsidianVaultChoice[] {
    return detectObsidianVaults(this.d.home ?? homedir())
  }

  /** A folder the user chose in the folder picker: allowed as the vault from now on (this session). */
  allowObsidianFolder(path: string): ObsidianFolderCheck {
    const c = checkObsidianFolder(path)
    this.picked.add(c.path)
    return c
  }

  private allowedFolder(path: string): boolean {
    const p = resolve(path)
    return this.picked.has(p) || this.detectObsidian().some((v) => v.path === p)
  }

  /** Starts the watcher (the app calls this once it's up; tests call obsidianSync.rescan() directly). */
  startSync(): void {
    this.syncStarted = true
    if (!this.obsidianActive()) return
    try { this.store.ensure() } catch { /* the vault folder went away */ }
    this.obsidianSync.start()
  }

  stopSync(): void {
    this.syncStarted = false
    this.obsidianSync.stop()
  }

  obsidianStatus(): ObsidianSyncStatus {
    const o = this.settings().obsidian
    const exists = !!o.vault && existsSync(o.vault)
    const prev = this.previousRoot()
    let previousNotes = 0
    if (o.vault) {
      const walk = (dir: string, depth: number): void => {
        if (depth > 8 || previousNotes > 5000) return
        let names: string[] = []
        try { names = readdirSync(dir) } catch { return }
        for (const n of names) {
          if (n.startsWith('.')) continue
          const p = join(dir, n)
          let st
          try { st = statSync(p) } catch { continue }
          if (st.isDirectory()) walk(p, depth + 1)
          else if (/\.md$/i.test(n) && !isGeneratedPath(relative(prev, p).split(sep).join('/'))) previousNotes++
        }
      }
      if (resolve(prev) !== resolve(this.root())) walk(prev, 0)
    }
    return {
      enabled: o.enabled, vault: o.vault, name: o.vault ? o.vault.split('/').filter(Boolean).pop() ?? '' : '', subfolder: o.subfolder,
      root: o.vault ? join(o.vault, ...o.subfolder.split('/')) : '', exists, isVault: exists && isObsidianVault(o.vault),
      watching: this.obsidianActive() && this.obsidianSync.watching, notes: this.obsidianActive() ? this.obsidianReader.notes().length : 0,
      lastPickedUp: this.obsidianSync.last, previousRoot: prev, previousNotes
    }
  }

  /** The user's own notes in their Obsidian vault, newest first (read-only here). */
  obsidianNotes(limit = 2000): VaultNoteInfo[] {
    if (!this.obsidianActive()) return []
    return this.obsidianReader.notes().slice(0, limit).map((n) => this.info(n))
  }

  /**
   * "Copy my existing SahilBot notes into this vault": every note in the previous folder is copied into
   * the subfolder (" 2" names when one is there already). The previous folder is never changed. One
   * Undo (in Changes) takes the whole copy back out.
   */
  copyExisting(): { copied: number; renamed: number; from: string; to: string } {
    if (!this.obsidianActive()) throw new Error('Turn on “Use my Obsidian vault” first.')
    const from = resolve(this.previousRoot()), to = resolve(this.store.root)
    if (from === to || within(to, from) || within(from, to)) throw new Error('Those are the same folder.')
    const out = { copied: 0, renamed: 0, from, to }
    if (!existsSync(from)) return out
    this.store.ensure()
    const group = randomUUID()
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 10 || out.copied > 20_000) return
      let names: string[] = []
      try { names = readdirSync(dir) } catch { return }
      for (const name of names) {
        if (name.startsWith('.')) continue
        const p = join(dir, name)
        const r = rel ? `${rel}/${name}` : name
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { walk(p, r, depth + 1); continue }
        if (!/\.md$/i.test(name) || isGeneratedPath(r) || st.size > 5 * 1024 * 1024) continue
        let dest = r
        for (let i = 2; existsSync(this.store.abs(dest)); i++) dest = r.replace(/\.md$/i, ` ${i}.md`)
        if (dest !== r) out.renamed++
        this.store.write(dest, readFileSync(p, 'utf8'), { actor: 'you', why: `copied from ${from}`, group })
        out.copied++
      }
    }
    walk(from, '', 0)
    if (out.copied) { this.store.rebuildIndexes(); this.changed() }
    return out
  }

  /**
   * An edit of one of the user's own notes (outside SahilBot's subfolder), only after the user approved
   * it (the vault tool asks every time). `content` replaces the body, `points` are added under "## Notes";
   * the frontmatter is kept exactly as written. The earlier version goes to SahilBot's .history and the
   * change is logged with Undo.
   */
  editObsidianNote(path: string, edit: { content?: string; points?: string[]; from?: string }, info: ChangeInfo): VaultChange {
    if (!this.obsidianActive()) throw new Error('“Use my Obsidian vault” is off.')
    const n = this.obsidianReader.find(path)
    if (!n) throw new Error(`No note "${path}" in your Obsidian vault (or it's in a folder SahilBot doesn't read).`)
    const fmRaw = n.text.replace(/^\uFEFF/, '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)?.[0] ?? ''
    let body: string
    if (edit.content?.trim()) body = `${edit.content.trim()}\n`
    else if (edit.points?.length) {
      const m = mergeBody(n.body, { title: n.title, points: edit.points, day: day(this.now()), from: edit.from })
      if (!m.added) throw new Error('Those points are in the note already.')
      body = m.body
    } else throw new Error('edit_obsidian_note needs content (the new body) or points to add.')
    const text = `${fmRaw}${fmRaw && !fmRaw.endsWith('\n') ? '\n' : ''}${body}`
    const history = this.store.keepHistory(n.path, n.text)
    this.obsidianReader.write(n.path, text)
    const c = this.store.record({ actor: info.actor, op: 'update', path: n.path, title: n.title, why: info.why ?? 'edited your note (you approved it)', threadId: info.threadId, history })
    this.changed()
    return c
  }

  /** The file for a note path (SahilBot's own, or "obsidian:…" for the user's own). */
  absOf(path: string): string {
    return path.startsWith(OBSIDIAN_PREFIX) ? this.obsidianReader.abs(path) : this.store.abs(path)
  }

  setBot(spaceId: string, patch: { enabled?: boolean | null; level?: VaultLevel | null }): VaultSettings {
    const s = this.settings()
    const cur = { ...(s.bots[spaceId] ?? {}) }
    if (patch.enabled === null) delete cur.enabled
    else if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled
    if (patch.level === null) delete cur.level
    else if (patch.level === 'normal' || patch.level === 'aggressive') cur.level = patch.level
    const bots = { ...s.bots, [spaceId]: cur }
    if (!Object.keys(cur).length) delete bots[spaceId]
    this.d.db.setSetting(SETTINGS_KEY, { ...s, bots })
    this.changed()
    return this.settings()
  }

  botEnabled(spaceId: string | null | undefined): boolean {
    const s = this.settings()
    if (!s.enabled) return false
    return !spaceId || s.bots[spaceId]?.enabled !== false
  }

  levelFor(spaceId: string | null | undefined): VaultLevel {
    const s = this.settings()
    return (spaceId ? s.bots[spaceId]?.level : undefined) ?? s.level
  }

  // ---------------------------------------------------------------- areas

  /** A bot's (or project's) own area, "Bots/<name>", made on first use and kept when it's renamed. */
  sectionFor(spaceId: string | null | undefined): string | null {
    if (!spaceId) return null
    const sp = this.d.db.getSpace(spaceId)
    if (!sp || sp.kind === 'group') return null
    const map = this.d.db.getSetting<Record<string, string>>(BOTS_KEY) ?? {}
    if (map[spaceId]) return map[spaceId]
    const taken = new Set(Object.values(map))
    const base = VaultStore.botSection(sp.name)
    let sec = base
    for (let i = 2; taken.has(sec) || sec === `Bots/${SHARED}`; i++) sec = `${base} ${i}`
    this.d.db.setSetting(BOTS_KEY, { ...map, [spaceId]: sec })
    return sec
  }

  /** What a bot may read: Shared and its own area (never another bot's). */
  sectionsFor(spaceId: string | null | undefined): string[] {
    const own = this.sectionFor(spaceId)
    return own ? [SHARED, own] : [SHARED]
  }

  /** Where a bot's trusted writes go by default: the main bot's to Shared, others' to their own area. */
  writeSectionFor(spaceId: string | null | undefined): string {
    const sp = spaceId ? this.d.db.getSpace(spaceId) : undefined
    if (!sp || sp.isMain || sp.kind === 'group') return SHARED
    return this.sectionFor(spaceId) ?? SHARED
  }

  // ---------------------------------------------------------------- retrieval

  private keywordFor(): ((q: string, limit: number) => string[]) | undefined {
    const kw = this.d.keyword
    if (!kw) return undefined
    const root = this.store.root
    return (q, limit) => kw(q, root, limit)
  }

  /**
   * The vault section of a run's <context> block: the notes most relevant to `query` within the budget
   * for this model's window, or null (vault off, off for this bot, or nothing relevant).
   */
  context(o: { spaceId: string | null; query: string; window: number; local?: boolean }): { title: string; lines: string[] } | null {
    try {
      if (!this.botEnabled(o.spaceId) || !o.query.trim()) return null
      const level = this.levelFor(o.spaceId)
      // Activity digests (other apps' window titles) never go to a cloud model from here.
      // A project's working memory page is in the run's context already (its core) and recalled step by step.
      const skip = (n: VaultNoteMeta): boolean => n.tags.includes('sahilbot/working-memory') || (o.local === false && n.tags.includes('sahilbot/activity'))
      const picked = retrieve(this.store, { query: o.query.slice(0, 4000), sections: this.sectionsFor(o.spaceId), window: o.window, level, keyword: this.keywordFor(), skip })
      // The user's own notes in their Obsidian vault (never excluded folders), ranked the same way.
      const mine = this.obsidianPicks(o.query.slice(0, 4000), o.window, level)
      const lines = vaultLines(mine.length ? [...picked, ...mine].sort((a, b) => b.score - a.score) : picked, vaultBudget(o.window, level))
      return lines.length ? { title: VAULT_TITLE, lines } : null
    } catch {
      return null
    }
  }

  private obsidianPicks(query: string, window: number, level?: VaultLevel): Retrieved[] {
    if (!this.obsidianActive() || !query.trim()) return []
    try { return retrieve(this.obsidianReader, { query, sections: [OBSIDIAN_SECTION], window, level }) } catch { return [] }
  }

  /**
   * Notes for a query, best first: SahilBot's own (in `sections`) and, with "Use my Obsidian vault" on,
   * the user's own notes (section "Obsidian", path "obsidian:…", source 'obsidian') unless obsidian=false.
   */
  search(query: string, sections?: string[], k = 12, o: { obsidian?: boolean } = {}): VaultSearchHit[] {
    const secs = sections ?? this.store.sections()
    const own = retrieve(this.store, { query, sections: secs, window: 1_000_000, keyword: this.keywordFor() }).slice(0, k)
    const mine = o.obsidian === false ? [] : this.obsidianPicks(query, 1_000_000).slice(0, k)
    const picked = mine.length ? [...own, ...mine].sort((a, b) => b.score - a.score).slice(0, k) : own
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    return picked.map((r) => {
      const lines = plainText(r.note.body).split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l))
      const hit = lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? r.note.summary
      return { path: r.note.path, title: r.note.title, type: r.note.type, section: r.note.section, snippet: (hit ?? '').replace(/^[-*]\s+/, '').slice(0, 280), score: Math.round(r.score * 1000) / 1000, ...(r.note.path.startsWith(OBSIDIAN_PREFIX) ? { source: 'obsidian' as const } : {}) }
    })
  }

  // ---------------------------------------------------------------- the Vault view

  info(n: VaultNoteMeta): VaultNoteInfo {
    return { path: n.path, title: n.title, type: n.type, section: n.section, tags: n.tags, created: n.created, updated: n.updated, trust: n.trust, summary: n.summary, links: n.links, generated: n.generated, mtime: n.mtime, ...(n.path.startsWith(OBSIDIAN_PREFIX) ? { source: 'obsidian' as const } : {}) }
  }

  list(): VaultNoteInfo[] {
    this.store.ensure()
    return this.store.list().map((n) => this.info(n))
  }

  full(n: VaultNote): VaultNoteFull {
    const prefer = [n.section, SHARED]
    const resolved: Record<string, string | null> = {}
    const mine = n.path.startsWith(OBSIDIAN_PREFIX)
    const user = (l: string): string | undefined => (this.obsidianActive() ? this.obsidianReader.find(l)?.path : undefined)
    for (const l of n.links) resolved[l] = (mine ? user(l) ?? this.store.resolve(l, [SHARED])?.path : this.store.resolve(l, prefer)?.path ?? user(l)) ?? null
    return { ...this.info(n), text: n.text, body: n.body, aliases: n.aliases, sources: n.sources, backlinks: mine ? [] : this.store.backlinks(n.path), resolved }
  }

  read(path: string): VaultNoteFull | null {
    if (path.startsWith(OBSIDIAN_PREFIX)) {
      const u = this.obsidianActive() ? this.obsidianReader.read(path) : undefined
      return u ? this.full(u) : null
    }
    const n = this.store.read(path)
    return n ? this.full(n) : null
  }

  private readOnly(path: string): void {
    if (path.startsWith(OBSIDIAN_PREFIX)) throw new Error('Your own Obsidian notes are read-only in SahilBot. Edit them in Obsidian.')
  }

  save(path: string, text: string, actor = 'you'): VaultNoteFull | null {
    this.readOnly(path)
    this.store.write(path, text.slice(0, 500_000), { actor, why: 'edited' })
    this.store.rebuildIndexes()
    this.changed()
    return this.read(path)
  }

  create(o: { title: string; type?: string; section?: string }, actor = 'you'): string {
    const title = safeTitle(o.title)
    const section = o.section && (o.section === SHARED || /^Bots\/[^/]+$/.test(o.section)) ? o.section : SHARED
    const type = normalizeType(o.type ?? 'fact') as NoteType
    this.store.ensure()
    const cur = this.store.find(section, title)
    if (cur) return cur.path
    const r = this.store.upsert({ section, type: type === 'index' ? 'fact' : type, title }, { actor, why: 'new note' })
    this.store.rebuildIndexes()
    this.changed()
    return r.path
  }

  trash(path: string, actor = 'you'): void {
    this.readOnly(path)
    this.store.trash(path, { actor, why: 'deleted' })
    this.store.rebuildIndexes()
    this.changed()
  }

  changes(limit = 200): VaultChangeInfo[] {
    return this.store.changes(limit).map((c) => ({
      id: c.id, at: c.at, actor: c.actor, op: c.op, path: c.path, title: c.title, why: c.why, threadId: c.threadId, undoneAt: c.undoneAt,
      canUndo: !c.undoneAt && ((c.op === 'create' && existsSync(this.store.abs(c.path))) || (c.op === 'update' && !!c.history && existsSync(this.store.abs(c.history))) || (c.op === 'trash' && !!c.movedTo && existsSync(this.store.abs(c.movedTo))))
    }))
  }

  undo(id: string): VaultChangeInfo[] {
    this.store.revert(id, { actor: 'you' })
    this.store.rebuildIndexes()
    this.changed()
    return this.changes()
  }

  obsidianInstalled(): boolean {
    const home = this.d.home ?? homedir()
    return existsSync('/Applications/Obsidian.app') || existsSync(join(home, 'Applications', 'Obsidian.app'))
  }

  /**
   * obsidian://open for the vault or one note. With "Use my Obsidian vault" on:
   * `?vault=<vault folder name>&file=<path in the vault without .md>` (SahilBot's notes include the
   * subfolder); otherwise `?path=` (works for any folder: Obsidian asks to open it as a vault the first time).
   */
  obsidianUrl(path?: string): string {
    if (this.obsidianActive()) {
      const sub = this.settings().obsidian.subfolder
      const file = !path ? `${sub}/Home.md` : path.startsWith(OBSIDIAN_PREFIX) ? this.obsidianReader.relOf(path) : `${sub}/${this.store.rel(this.store.abs(path))}`
      return obsidianOpenUrl(this.obsidianVaultRoot(), file)
    }
    const abs = path ? this.store.abs(path) : this.store.root
    return `obsidian://open?path=${encodeURIComponent(abs)}`
  }

  /** Writes the vault (without .history, .trash and SahilBot's own folder) to a zip in `outDir`. */
  exportZip(outDir: string): string {
    this.store.ensure()
    const files: Array<{ name: string; data: Buffer; mtime: Date }> = []
    const root = this.store.root
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 10) return
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) walk(p, `${rel}${name}/`, depth + 1)
        else if (st.size <= 50 * 1024 * 1024) files.push({ name: `SahilBot Vault/${rel}${name}`, data: readFileSync(p), mtime: st.mtime })
      }
    }
    walk(root, '', 0)
    mkdirSync(outDir, { recursive: true })
    let out = join(outDir, `SahilBot Vault ${day(this.now())}.zip`)
    for (let i = 2; existsSync(out); i++) out = join(outDir, `SahilBot Vault ${day(this.now())} ${i}.zip`)
    writeFileSync(out, zipFiles(files))
    return out
  }

  status(): VaultStatus {
    const notes = this.store.list().filter((n) => !n.generated)
    const st = this.compiler.state()
    const bySection = new Map<string, number>()
    for (const n of notes) bySection.set(n.section, (bySection.get(n.section) ?? 0) + 1)
    return {
      enabled: this.settings().enabled, root: this.root(), defaultRoot: this.defaultRoot(), notes: notes.length,
      sections: [...bySection].map(([section, n]) => ({ section, notes: n })).sort((a, b) => (a.section === SHARED ? -1 : b.section === SHARED ? 1 : a.section.localeCompare(b.section))),
      obsidian: this.obsidianInstalled(), obsidianVault: this.obsidianStatus(), lastCompiledAt: st.lastAt, lastSummary: st.lastSummary, settings: this.settings()
    }
  }

  /** "Aggressive" with work waiting: passes every 10 minutes instead of 30. */
  passEvery(): number {
    return this.settings().enabled && this.settings().level === 'aggressive' && this.compiler.wants(this.now()) ? 10 * 60_000 : 30 * 60_000
  }

  /** A title → the note's path, looked up from `from`'s area first. */
  resolve(ref: string, from?: string): string | null {
    if (from?.startsWith(OBSIDIAN_PREFIX)) return (this.obsidianActive() ? this.obsidianReader.find(ref)?.path : undefined) ?? this.store.resolve(ref, [SHARED])?.path ?? null
    const sec = from ? this.store.read(from)?.section : undefined
    return this.store.resolve(ref, sec ? [sec, SHARED] : [SHARED])?.path ?? (this.obsidianActive() ? this.obsidianReader.find(ref)?.path : undefined) ?? null
  }

  changed(): void {
    try { this.d.onChange?.() } catch { /* the window may be gone */ }
  }

  /** Same title key: for callers matching notes by name. */
  static key(t: string): string { return titleKey(t) }
}
