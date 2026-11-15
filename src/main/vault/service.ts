import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VaultChangeInfo, VaultLevel, VaultNoteFull, VaultNoteInfo, VaultSearchHit, VaultSettings, VaultStatus } from '@shared/vault'
import type { Db } from '../db'
import { VaultCompiler, type CompilerDeps } from './compile'
import { day, normalizeType, plainText, safeTitle, titleKey, type NoteType } from './notes'
import { VAULT_TITLE, retrieve, vaultBudget, vaultLines } from './retrieve'
import { SHARED, VaultStore, type VaultNote, type VaultNoteMeta } from './store'
import { zipFiles } from './zip'

// The knowledge vault, put together: settings (on/off, folder, how much to remember, per bot), the
// store, the compiler the learning pass runs, retrieval for each run's context block, search for the
// vault tool, and what the Vault view needs (notes, backlinks, graph, changes with Undo, export).

export const DEFAULT_VAULT: VaultSettings = { enabled: true, dir: '', level: 'aggressive', docs: true, activity: true, bots: {} }
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
    bots
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

  constructor(private d: VaultServiceDeps) {
    this.store = new VaultStore(() => this.root(), () => this.now())
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

  root(): string {
    const dir = this.settings().dir
    return dir ? dir.replace(/^~(?=\/|$)/, this.d.home ?? homedir()) : this.defaultRoot()
  }

  setSettings(patch: Partial<Omit<VaultSettings, 'bots'>>): VaultSettings {
    const before = this.root()
    const next = cleanVaultSettings({ ...this.settings(), ...patch, bots: this.settings().bots })
    if (next.dir && !next.dir.startsWith('/') && !next.dir.startsWith('~')) throw new Error('Choose a full folder path for the vault.')
    this.d.db.setSetting(SETTINGS_KEY, next)
    if (this.root() !== before) { this.store.ensure(); this.d.onRootChange?.(this.root()) }
    this.changed()
    return next
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
      const skip = o.local === false ? (n: VaultNoteMeta): boolean => n.tags.includes('sahilbot/activity') : undefined
      const picked = retrieve(this.store, { query: o.query.slice(0, 4000), sections: this.sectionsFor(o.spaceId), window: o.window, level, keyword: this.keywordFor(), skip })
      const lines = vaultLines(picked, vaultBudget(o.window, level))
      return lines.length ? { title: VAULT_TITLE, lines } : null
    } catch {
      return null
    }
  }

  search(query: string, sections?: string[], k = 12): VaultSearchHit[] {
    const secs = sections ?? this.store.sections()
    const picked = retrieve(this.store, { query, sections: secs, window: 1_000_000, keyword: this.keywordFor() }).slice(0, k)
    const terms = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
    return picked.map((r) => {
      const lines = plainText(r.note.body).split('\n').map((l) => l.trim()).filter((l) => l && !/^#/.test(l))
      const hit = lines.find((l) => terms.some((t) => l.toLowerCase().includes(t))) ?? r.note.summary
      return { path: r.note.path, title: r.note.title, type: r.note.type, section: r.note.section, snippet: (hit ?? '').replace(/^[-*]\s+/, '').slice(0, 280), score: Math.round(r.score * 1000) / 1000 }
    })
  }

  // ---------------------------------------------------------------- the Vault view

  info(n: VaultNoteMeta): VaultNoteInfo {
    return { path: n.path, title: n.title, type: n.type, section: n.section, tags: n.tags, created: n.created, updated: n.updated, trust: n.trust, summary: n.summary, links: n.links, generated: n.generated, mtime: n.mtime }
  }

  list(): VaultNoteInfo[] {
    this.store.ensure()
    return this.store.list().map((n) => this.info(n))
  }

  full(n: VaultNote): VaultNoteFull {
    const prefer = [n.section, SHARED]
    const resolved: Record<string, string | null> = {}
    for (const l of n.links) resolved[l] = this.store.resolve(l, prefer)?.path ?? null
    return { ...this.info(n), text: n.text, body: n.body, aliases: n.aliases, sources: n.sources, backlinks: this.store.backlinks(n.path), resolved }
  }

  read(path: string): VaultNoteFull | null {
    const n = this.store.read(path)
    return n ? this.full(n) : null
  }

  save(path: string, text: string, actor = 'you'): VaultNoteFull | null {
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

  /** obsidian://open for the vault or one note (Obsidian asks to open the folder as a vault the first time). */
  obsidianUrl(path?: string): string {
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
      obsidian: this.obsidianInstalled(), lastCompiledAt: st.lastAt, lastSummary: st.lastSummary, settings: this.settings()
    }
  }

  /** "Aggressive" with work waiting: passes every 10 minutes instead of 30. */
  passEvery(): number {
    return this.settings().enabled && this.settings().level === 'aggressive' && this.compiler.wants(this.now()) ? 10 * 60_000 : 30 * 60_000
  }

  /** A title → the note's path, looked up from `from`'s area first. */
  resolve(ref: string, from?: string): string | null {
    const sec = from ? this.store.read(from)?.section : undefined
    return this.store.resolve(ref, sec ? [sec, SHARED] : [SHARED])?.path ?? null
  }

  changed(): void {
    try { this.d.onChange?.() } catch { /* the window may be gone */ }
  }

  /** Same title key: for callers matching notes by name. */
  static key(t: string): string { return titleKey(t) }
}
