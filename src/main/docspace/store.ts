import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { DocAuthor, DocBlock, DocContent, DocSheet, DocDiff, DocEvent, DocInfo, DocSnapshot, DocType, DocVersionInfo, LibraryItem } from '@shared/types'
import { changeKeys, diffContent, diffView, isEmptyDelta, summarize } from './diff'
import { preview } from './inline'
import { merge3 } from './merge'
import { applyOps, opTargets, type DocOp } from './ops'
import { addr, emptySheet, evaluateSheet, fitSheet, MAX_COLS, MAX_ROWS, parseAddr } from './sheet'
import { isBlockId, newId } from './markdown'

// Live documents, stored per chat in the app database (its own tables, made here). Every change is a
// version with its author, time and a one-line summary; the bot edits against a base version and gets a
// conflict instead of overwriting what the user changed in the meantime.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docspace_docs (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, space_id TEXT, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'doc',
  version INTEGER NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS docspace_docs_thread ON docspace_docs(thread_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS docspace_docs_space ON docspace_docs(space_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS docspace_versions (
  doc_id TEXT NOT NULL REFERENCES docspace_docs(id) ON DELETE CASCADE, n INTEGER NOT NULL, author TEXT NOT NULL,
  at INTEGER NOT NULL, summary TEXT NOT NULL, changed TEXT NOT NULL DEFAULT '[]', content TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (doc_id, n));
`

/** User saves this close together (and not yet seen by the bot) fold into one version. */
const COALESCE_MS = 120_000
const MAX_CONTENT = 2_000_000

type Row = Record<string, unknown>

export class DocConflictError extends Error {}

export interface EditResult {
  snapshot: DocSnapshot
  notes: string[]
  added: string[]
  /** Set when the edit was applied on top of newer changes it didn't touch. */
  rebasedOver?: number
}

export class DocStore {
  private listeners = new Set<(e: DocEvent) => void>()
  /** Runs before the bot reads or edits a document, so unsaved edits in the editor are saved first. */
  beforeBotAccess?: (id: string) => Promise<void>

  constructor(private sql: DatabaseSync, private now: () => number = () => Date.now()) {
    this.sql.exec(SCHEMA)
  }

  onChange(cb: (e: DocEvent) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  // ---------------------------------------------------------------- reading

  private row(id: string): Row {
    const r = this.sql.prepare('SELECT * FROM docspace_docs WHERE id = ?').get(String(id ?? '')) as Row | undefined
    if (!r) throw new Error(`No document "${id}". Use doc_read without "doc" for this chat's latest document, or doc_create to make one.`)
    return r
  }

  private lastVersion(id: string): Row {
    return this.sql.prepare('SELECT * FROM docspace_versions WHERE doc_id = ? ORDER BY n DESC LIMIT 1').get(id) as Row
  }

  private toInfo(r: Row): DocInfo {
    const v = this.lastVersion(r.id as string)
    return {
      id: r.id as string,
      threadId: r.thread_id as string,
      ...(r.space_id ? { spaceId: r.space_id as string } : {}),
      title: r.title as string,
      type: r.type as DocType,
      version: r.version as number,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      lastAuthor: (v?.author as DocAuthor) ?? 'bot',
      lastSummary: (v?.summary as string) ?? ''
    }
  }

  has(id: string): boolean {
    return !!this.sql.prepare('SELECT 1 FROM docspace_docs WHERE id = ?').get(String(id ?? ''))
  }

  info(id: string): DocInfo {
    return this.toInfo(this.row(id))
  }

  get(id: string): DocSnapshot {
    const r = this.row(id)
    const content = JSON.parse(r.content as string) as DocContent
    const info = this.toInfo(r)
    return { ...info, content, ...(info.type === 'sheet' ? { computed: evaluateSheet(content.sheet?.cells ?? {}) } : {}) }
  }

  list(threadId: string): DocInfo[] {
    return (this.sql.prepare('SELECT * FROM docspace_docs WHERE thread_id = ? ORDER BY updated_at DESC').all(threadId) as Row[]).map((r) => this.toInfo(r))
  }

  /** The chat's most recently changed document. */
  latest(threadId: string): DocInfo | undefined {
    return this.list(threadId)[0]
  }

  /** A bot's documents, for its Library. */
  libraryItems(spaceId: string, limit = 200): LibraryItem[] {
    return (this.sql.prepare('SELECT id, title, type, thread_id, updated_at FROM docspace_docs WHERE space_id = ? ORDER BY updated_at DESC LIMIT ?').all(spaceId, limit) as Row[])
      .map((r) => ({ kind: 'file', title: r.title as string, url: `sahilbot-doc:${r.id as string}`, docId: r.id as string, at: r.updated_at as number, threadId: r.thread_id as string }))
  }

  versions(id: string): DocVersionInfo[] {
    this.row(id)
    return (this.sql.prepare('SELECT n, author, at, summary, changed FROM docspace_versions WHERE doc_id = ? ORDER BY n DESC').all(id) as Row[])
      .map((r) => ({ n: r.n as number, author: r.author as DocAuthor, at: r.at as number, summary: r.summary as string, changed: JSON.parse(r.changed as string) as string[] }))
  }

  version(id: string, n: number): DocContent {
    const r = this.sql.prepare('SELECT content FROM docspace_versions WHERE doc_id = ? AND n = ?').get(id, n) as Row | undefined
    if (!r) throw new Error(`Document ${id} has no version ${n}.`)
    return JSON.parse(r.content as string) as DocContent
  }

  diff(id: string, from: number, to: number): DocDiff {
    return diffView(this.version(id, from), this.version(id, to), from, to)
  }

  /** The bot saw version n (doc_read / doc_edit result): later user saves start a new version, never fold into it. */
  markSeen(id: string, n: number): void {
    this.sql.prepare('UPDATE docspace_versions SET seen = 1 WHERE doc_id = ? AND n = ?').run(id, n)
  }

  // ---------------------------------------------------------------- writing

  create(o: { threadId: string; spaceId?: string; title: string; type?: DocType; content: Omit<DocContent, 'title'> & { title?: string }; author: DocAuthor; summary?: string }): DocSnapshot {
    const id = `d${randomUUID().replace(/-/g, '').slice(0, 10)}`
    const type: DocType = o.type === 'sheet' ? 'sheet' : 'doc'
    const title = cleanTitle(o.content.title ?? o.title)
    const content: DocContent = { title, blocks: type === 'sheet' ? [] : o.content.blocks ?? [], ...(type === 'sheet' ? { sheet: fitSheet(o.content.sheet ?? emptySheet()) } : {}) }
    const json = this.check(content)
    const at = this.now()
    const summary = o.summary?.trim() || (o.author === 'bot' ? 'Created the document' : 'Created')
    this.sql.exec('BEGIN')
    try {
      this.sql.prepare('INSERT INTO docspace_docs(id, thread_id, space_id, title, type, version, content, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)')
        .run(id, o.threadId, o.spaceId ?? null, title, type, json, at, at)
      this.sql.prepare('INSERT INTO docspace_versions(doc_id, n, author, at, summary, changed, content) VALUES(?, 1, ?, ?, ?, ?, ?)')
        .run(id, o.author, at, summary, JSON.stringify(content.blocks.map((b) => b.id)), json)
      this.sql.exec('COMMIT')
    } catch (e) {
      this.sql.exec('ROLLBACK')
      throw e
    }
    this.emit({ docId: id, threadId: o.threadId, version: 1, author: o.author, summary, changed: content.blocks.map((b) => b.id), removed: [] })
    return this.get(id)
  }

  private check(c: DocContent): string {
    const json = JSON.stringify(c)
    if (json.length > MAX_CONTENT) throw new Error(`The document is too large (${Math.round(json.length / 1000)} KB; the limit is ${MAX_CONTENT / 1000} KB). Split it into several documents.`)
    return json
  }

  /**
   * Stores `next` as the new version (or folds it into the user's last version when that one is recent and
   * the bot hasn't seen it). Returns the snapshot; a change that changes nothing stores nothing.
   */
  private commit(id: string, next: DocContent, author: DocAuthor, summary?: string, o: { fold?: boolean } = {}): DocSnapshot {
    const r = this.row(id)
    const head = JSON.parse(r.content as string) as DocContent
    next = { ...next, title: cleanTitle(next.title), ...(r.type === 'sheet' ? { sheet: fitSheet(next.sheet ?? emptySheet()), blocks: [] } : {}) }
    const delta = diffContent(head, next)
    if (isEmptyDelta(delta)) return this.get(id)
    const json = this.check(next)
    const at = this.now()
    const last = this.lastVersion(id)
    const fold = o.fold !== false && author === 'user' && last.author === 'user' && !last.seen && (last.n as number) > 1 && at - (last.at as number) < COALESCE_MS
    let n = (r.version as number) + 1
    this.sql.exec('BEGIN')
    try {
      if (fold) {
        n = last.n as number
        const prev = this.version(id, n - 1)
        const d = diffContent(prev, next)
        if (isEmptyDelta(d)) {
          // Back to how it was before: the version is no longer a change.
          this.sql.prepare('DELETE FROM docspace_versions WHERE doc_id = ? AND n = ?').run(id, n)
          n -= 1
        } else {
          this.sql.prepare('UPDATE docspace_versions SET at = ?, summary = ?, changed = ?, content = ? WHERE doc_id = ? AND n = ?')
            .run(at, summary?.trim() || summarize(prev, next, d), JSON.stringify(changeKeys(d)), json, id, n)
        }
      } else {
        this.sql.prepare('INSERT INTO docspace_versions(doc_id, n, author, at, summary, changed, content) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(id, n, author, at, summary?.trim() || summarize(head, next, delta), JSON.stringify(changeKeys(delta)), json)
      }
      this.sql.prepare('UPDATE docspace_docs SET title = ?, version = ?, content = ?, updated_at = ? WHERE id = ?').run(next.title, n, json, at, id)
      this.sql.exec('COMMIT')
    } catch (e) {
      this.sql.exec('ROLLBACK')
      throw e
    }
    const snap = this.get(id)
    this.emit({
      docId: id, threadId: snap.threadId, version: n, author, summary: snap.lastSummary,
      changed: [...delta.changed, ...delta.added, ...delta.moved, ...(delta.title ? ['title'] : []), ...delta.cells.map((c) => `cell:${c}`)],
      removed: delta.removed
    })
    return snap
  }

  /**
   * The user's edits, made on top of version `base`. If the bot changed the document since, the edits are
   * merged in by block (the user's version of a block wins where both changed it).
   */
  saveUser(id: string, base: number, input: DocContent): DocSnapshot {
    const cur = this.get(id)
    const mine = normalizeContent(input, cur.type)
    if (!Number.isInteger(base) || base < 1 || base > cur.version) throw new Error(`Unknown base version ${base}.`)
    const next = base === cur.version ? mine : merge3(this.version(id, base), cur.content, mine)
    return this.commit(id, next, 'user')
  }

  /** Restores an older version as a new version (nothing is lost). */
  restore(id: string, n: number, author: DocAuthor = 'user'): DocSnapshot {
    const old = this.version(id, n)
    const snap = this.commit(id, old, author, `Restored version ${n}`, { fold: false })
    // Later typing starts a new version rather than folding into the restore.
    this.markSeen(id, snap.version)
    return snap
  }

  /** Change keys since version `base` (exclusive), with who changed each last. */
  changesSince(id: string, base: number): Map<string, DocAuthor> {
    const out = new Map<string, DocAuthor>()
    for (const r of this.sql.prepare('SELECT author, changed FROM docspace_versions WHERE doc_id = ? AND n > ? ORDER BY n').all(id, base) as Row[]) {
      for (const k of JSON.parse(r.changed as string) as string[]) out.set(k, r.author as DocAuthor)
    }
    return out
  }

  /**
   * The bot's doc_edit: ops validated against version `base`. When the document changed since then and the
   * ops touch any of those changes, nothing is applied and a DocConflictError says what changed. Otherwise
   * the ops apply to the current version.
   */
  editBot(id: string, base: number, ops: DocOp[], summary?: string, rand?: () => number): EditResult {
    const cur = this.get(id)
    if (!Number.isInteger(base) || base < 1 || base > cur.version) {
      throw new Error(`"base" must be the version you read (1 to ${cur.version}); this document is at version ${cur.version}. Read it with doc_read.`)
    }
    let rebasedOver: number | undefined
    if (base !== cur.version) {
      const baseContent = this.version(id, base)
      const changes = this.changesSince(id, base)
      const hit = new Set<string>()
      for (const op of ops ?? []) for (const k of opTargets(op, baseContent, cur.content)) if (changes.has(k)) hit.add(k)
      if (hit.size) throw new DocConflictError(conflictMessage(cur, base, [...hit], changes))
      rebasedOver = base
    }
    const res = applyOps(cur.content, ops, { type: cur.type, rand })
    const snap = this.commit(id, res.content, 'bot', summary)
    this.markSeen(id, snap.version)
    return { snapshot: snap, notes: res.notes, added: res.added, ...(rebasedOver !== undefined ? { rebasedOver } : {}) }
  }

  private emit(e: DocEvent): void {
    for (const cb of this.listeners) { try { cb(e) } catch { /* a listener's problem */ } }
  }
}

function conflictMessage(cur: DocSnapshot, base: number, hit: string[], changes: Map<string, DocAuthor>): string {
  const byId = new Map(cur.content.blocks.map((b) => [b.id, b]))
  const who = (k: string): string => (changes.get(k) === 'user' ? 'the user' : 'an earlier edit of yours')
  const lines = hit.slice(0, 12).map((k) => {
    if (k === 'title') return `- the title (changed by ${who(k)}) is now "${cur.title}"`
    if (k.startsWith('cell:')) return `- cell ${k.slice(5)} (changed by ${who(k)}) is now "${cur.content.sheet?.cells[k.slice(5)] ?? ''}"`
    const b = byId.get(k)
    if (!b) return `- [${k}] was deleted by ${who(k)}`
    const text = b.type === 'table' ? `a table with ${b.rows?.length ?? 0} rows` : `"${preview(b.text ?? '', 120)}"`
    return `- [${k}] was changed by ${who(k)} and now reads: ${text}`
  })
  const users = hit.some((k) => changes.get(k) === 'user')
  return [
    `Conflict: ${users ? 'the user changed this document' : 'the document changed'} after version ${base} (it is now version ${cur.version}), and your edit touches what changed:`,
    ...lines,
    `Nothing was applied. Call doc_read to get the latest content, then redo your edit with base ${cur.version}, keeping ${users ? "the user's" : 'those'} changes.`
  ].join('\n')
}

const TYPES = new Set(['h1', 'h2', 'h3', 'p', 'bullet', 'numbered', 'check', 'quote', 'code', 'table', 'divider', 'image', 'callout'])
const TONE_SET = new Set(['info', 'tip', 'warn', 'danger'])
const str = (v: unknown, max = 100_000): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)

/** Content from the editor, checked: known block types and fields only, unique valid ids. */
export function normalizeContent(c: unknown, type: DocType): DocContent {
  const x = (c ?? {}) as Partial<DocContent>
  const taken = new Set<string>()
  const blocks: DocBlock[] = []
  if (type !== 'sheet') {
    for (const raw of Array.isArray(x.blocks) ? x.blocks.slice(0, 5000) : []) {
      const b = (raw ?? {}) as Partial<DocBlock>
      if (!b.type || !TYPES.has(b.type)) continue
      const id = isBlockId(b.id) && !taken.has(b.id) ? b.id : newId(taken)
      taken.add(id)
      const out: DocBlock = { id, type: b.type }
      const text = str(b.text)
      if (text !== undefined && b.type !== 'divider' && b.type !== 'image' && b.type !== 'table') out.text = text
      if (['bullet', 'numbered', 'check'].includes(b.type) && Number.isInteger(b.indent) && b.indent! > 0) out.indent = Math.min(5, b.indent!)
      if (b.type === 'check') out.checked = !!b.checked
      if (b.type === 'code' && str(b.lang, 40)) out.lang = str(b.lang, 40)
      if (b.type === 'table') {
        const rows = Array.isArray(b.rows) ? b.rows.slice(0, 500).map((r) => (Array.isArray(r) ? r.slice(0, 50).map((v) => String(v ?? '').slice(0, 10_000)) : [''])) : [['']]
        out.rows = rows.length ? rows : [['']]
        out.header = b.header !== false
      }
      if (b.type === 'image') { out.src = str(b.src, 4000) ?? ''; if (str(b.alt, 500)) out.alt = str(b.alt, 500) }
      if (b.type === 'callout') out.tone = b.tone && TONE_SET.has(b.tone) ? b.tone : 'info'
      blocks.push(out)
    }
  }
  let sheet: DocSheet | undefined
  if (type === 'sheet') {
    const sh = (x.sheet ?? {}) as Partial<DocSheet>
    const cells: Record<string, string> = {}
    for (const [k, v] of Object.entries(sh.cells ?? {})) {
      const p = parseAddr(k)
      const val = String(v ?? '').slice(0, 10_000)
      if (p && p.r < MAX_ROWS && p.c < MAX_COLS && val !== '') cells[addr(p.c, p.r)] = val
    }
    sheet = fitSheet({ rows: Math.min(MAX_ROWS, Math.max(1, Number(sh.rows) || 1)), cols: Math.min(MAX_COLS, Math.max(1, Number(sh.cols) || 1)), cells, header: sh.header !== false })
  }
  return { title: cleanTitle(x.title), blocks, ...(sheet ? { sheet } : {}) }
}

export function cleanTitle(t: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return (s.length > 200 ? s.slice(0, 200).trimEnd() : s) || 'Untitled'
}
