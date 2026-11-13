import { createHash } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { chunkSections, type ChunkOptions } from './chunker'
import { extractFile, isRich, kindOf } from './extract'
import { IgnoreStack, inForbidden, insideCI, MAX_FILE_BYTES, relPosix, skipDir, skipFile } from './ignore'
import type { KnowledgeStore } from './store'

// Walks source folders, decides what may be read, and keeps the index in step with the disk:
// unchanged files (same size and modification time, or same content hash) are never re-read.

export interface IndexerOptions {
  /** Most files read from one source folder (default 20,000). */
  maxFiles?: number
  home?: string
  chunk?: ChunkOptions
  /** Awaited between files: pausing, and going slower while a chat is running. */
  pace?: () => Promise<void>
  /** Something was indexed or removed. */
  onProgress?: () => void
}

export type FileResult = 'indexed' | 'unchanged' | 'skipped' | 'removed' | 'ignored'

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const inside = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

export class Indexer {
  /** Files waiting to be (re)read, with the source folder that found them. */
  private queue = new Map<string, string>()
  private draining: Promise<void> | null = null
  /** Source folders that hit the file limit on their last walk. */
  readonly truncated = new Set<string>()
  current: string | null = null
  stopped = false

  constructor(readonly store: KnowledgeStore, private opts: IndexerOptions = {}) {}

  get queued(): number {
    return this.queue.size
  }

  get busy(): boolean {
    return !!this.draining || this.queue.size > 0
  }

  private get home(): string {
    return this.opts.home ?? homedir()
  }

  /**
   * Lists the files under `root` that may be indexed: skips forbidden places, ignored and hidden
   * folders, bundles, symlinks, secrets, unsupported formats and anything the .gitignore files exclude.
   */
  async walk(root: string, onFile: (path: string) => void, start = root): Promise<{ files: number; truncated: boolean }> {
    const max = this.opts.maxFiles ?? 20_000
    let files = 0
    let truncated = false
    let seen = 0
    // .gitignore files above `start` (when walking a sub-folder after a change).
    let base = new IgnoreStack()
    if (start !== root) {
      const rel = relPosix(root, start).split('/')
      for (let i = 0; i < rel.length; i++) {
        const dir = join(root, ...rel.slice(0, i))
        base = await withGitignore(base, root, dir)
      }
    }
    const visit = async (dir: string, ig: IgnoreStack): Promise<void> => {
      if (truncated || this.stopped || inForbidden(dir, this.home)) return
      let entries: Dirent[]
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      if (entries.some((e) => e.name === '.gitignore' && e.isFile())) ig = await withGitignore(ig, root, dir)
      for (const e of entries) {
        if (++seen % 250 === 0) await tick()
        if (e.isSymbolicLink()) continue
        const full = join(dir, e.name)
        const rel = relPosix(root, full)
        if (e.isDirectory()) {
          if (skipDir(e.name) || ig.ignored(rel, true)) continue
          await visit(full, ig)
          if (truncated) return
        } else if (e.isFile()) {
          if (skipFile(e.name) || ig.ignored(rel, false)) continue
          if (files >= max) { truncated = true; return }
          files++
          onFile(full)
        }
      }
    }
    await visit(start, base)
    if (start === root) { if (truncated) this.truncated.add(root); else this.truncated.delete(root) }
    return { files, truncated }
  }

  /** Whether a single path (from a change event) may be indexed under `root`. */
  async allowed(root: string, path: string): Promise<boolean> {
    if (!inside(root, path) || path === root || inForbidden(path, this.home)) return false
    const parts = relative(root, path).split(sep)
    if (parts.slice(0, -1).some((p) => skipDir(p)) || skipFile(parts[parts.length - 1])) return false
    let ig = new IgnoreStack()
    for (let i = 0; i < parts.length; i++) ig = await withGitignore(ig, root, join(root, ...parts.slice(0, i)))
    for (let i = 1; i < parts.length; i++) if (ig.ignored(parts.slice(0, i).join('/'), true)) return false
    return !ig.ignored(parts.join('/'), false)
  }

  /**
   * Walks every source folder, queues new and changed files, and removes files that are gone (or
   * now ignored). `full`: also drops files under no current source (a source was removed).
   */
  async scan(roots: string[], full = true): Promise<{ found: number; queued: number; removed: number }> {
    const seen = new Set<string>()
    let found = 0
    let queued = 0
    for (const root of roots) {
      if (this.stopped) break
      await this.walk(root, (p) => {
        found++
        if (seen.has(p)) return
        seen.add(p)
        if (this.queue.has(p)) return
        this.queue.set(p, root)
        queued++
      })
    }
    let removed = 0
    if (!this.stopped) {
      const stale = full ? this.store.paths() : roots.flatMap((r) => this.store.paths(r))
      for (const p of stale) if (!seen.has(p)) { this.store.remove(p); removed++ }
      if (removed) this.opts.onProgress?.()
    }
    return { found, queued, removed }
  }

  /** Paths reported changed by the watcher: re-read files, walk new folders, drop what's gone. */
  async changed(paths: string[], roots: string[]): Promise<void> {
    for (const p of new Set(paths)) {
      const root = roots.filter((r) => inside(r, p)).sort((a, b) => b.length - a.length)[0]
      if (!root) continue
      // lstat: a symlink (to a file or a folder) is never followed, whatever it points at.
      let st: Awaited<ReturnType<typeof lstat>> | null = null
      try { st = await lstat(p) } catch { st = null }
      if (!st || st.isSymbolicLink()) {
        if (this.store.removeUnder(p)) this.opts.onProgress?.()
        this.queue.delete(p)
        continue
      }
      if (basename(p) === '.gitignore') {
        // Ignore rules changed: re-check that whole folder.
        const dir = dirname(p)
        const seen = new Set<string>()
        await this.walk(root, (f) => { seen.add(f); this.queue.set(f, root) }, dir)
        for (const old of this.store.paths(dir)) if (!seen.has(old)) this.store.remove(old)
        continue
      }
      if (st.isDirectory()) {
        if (await this.allowedDir(root, p)) await this.walk(root, (f) => this.queue.set(f, root), p)
        continue
      }
      if (await this.allowed(root, p)) this.queue.set(p, root)
      else if (this.store.doc(p)) { this.store.remove(p); this.opts.onProgress?.() }
    }
  }

  private async allowedDir(root: string, dir: string): Promise<boolean> {
    if (dir === root) return true
    if (!inside(root, dir) || inForbidden(dir, this.home)) return false
    const parts = relative(root, dir).split(sep)
    if (parts.some((p) => skipDir(p))) return false
    let ig = new IgnoreStack()
    for (let i = 0; i < parts.length; i++) ig = await withGitignore(ig, root, join(root, ...parts.slice(0, i)))
    for (let i = 1; i <= parts.length; i++) if (ig.ignored(parts.slice(0, i).join('/'), true)) return false
    return true
  }

  /**
   * Where `path` really is, if that is still inside `root` (both resolved) and outside the forbidden
   * places; null otherwise. A path under a symlinked folder resolves outside and is refused.
   */
  async contained(root: string, path: string): Promise<string | null> {
    let r: string
    let p: string
    try { r = await realpath(root); p = await realpath(path) } catch { return null }
    if (!insideCI(r, p) || inForbidden(p, this.home)) return null
    return p
  }

  /** Reads one file into the index (or records why it can't be), unless it is unchanged. */
  async indexFile(path: string, root: string): Promise<FileResult> {
    const gone = (): FileResult => {
      if (this.store.doc(path)) { this.store.remove(path); return 'removed' }
      return 'ignored'
    }
    let st
    try { st = await lstat(path) } catch { return gone() }
    // Links are never read (lstat), and the real path must stay inside the source folder.
    if (st.isSymbolicLink() || !st.isFile()) return gone()
    if (!(await this.contained(root, path))) return gone()
    const mtime = Math.floor(st.mtimeMs)
    const old = this.store.doc(path)
    if (old && old.mtime === mtime && old.size === st.size) return 'unchanged'
    const base = { path, root, kind: kindOf(path), size: st.size, mtime }
    if (st.size > MAX_FILE_BYTES) {
      this.store.upsert({ ...base, hash: `size:${st.size}`, skipped: 'larger than 5 MB' }, [])
      return 'skipped'
    }
    // Opened without following a link swapped in since the checks, and only if it is the same file.
    let buf: Buffer
    try {
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const fst = await fh.stat()
        if (!fst.isFile() || fst.ino !== st.ino || fst.dev !== st.dev || fst.size > MAX_FILE_BYTES) return 'ignored'
        buf = await fh.readFile()
      } finally { await fh.close() }
    } catch { return 'ignored' }
    const hash = createHash('sha1').update(buf).digest('hex')
    if (old && old.hash === hash) { this.store.touch(path, mtime, st.size); return 'unchanged' }
    // Recorded before parsing: if the parser takes SahilBot down, the next launch sees this file as
    // unchanged (same size, time and hash) and doesn't try it again until it changes.
    if (isRich(path)) this.store.upsert({ ...base, hash, skipped: 'extracting' }, [])
    const ex = await extractFile(path, { data: buf })
    if ('skip' in ex) {
      this.store.upsert({ ...base, hash, skipped: ex.skip }, [])
      return 'skipped'
    }
    const chunks = chunkSections(ex.sections, this.opts.chunk)
    this.store.upsert({ ...base, kind: ex.kind, hash, skipped: chunks.length ? undefined : 'empty' }, chunks)
    return chunks.length ? 'indexed' : 'skipped'
  }

  /** Reads queued files until the queue is empty. Concurrent calls share one run. */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = (async () => {
        try {
          while (this.queue.size && !this.stopped) {
            const [path, root] = this.queue.entries().next().value as [string, string]
            this.queue.delete(path)
            this.current = path
            try {
              const r = await this.indexFile(path, root)
              if (r !== 'unchanged' && r !== 'ignored') this.opts.onProgress?.()
            } catch { /* one bad file never stops the rest */ }
            this.current = null
            await (this.opts.pace ? this.opts.pace() : tick())
          }
        } finally {
          this.current = null
          this.draining = null
        }
      })()
    }
    return this.draining
  }

  clearQueue(): void {
    this.queue.clear()
  }
}

async function withGitignore(ig: IgnoreStack, root: string, dir: string): Promise<IgnoreStack> {
  try {
    const text = await readFile(join(dir, '.gitignore'), 'utf8')
    return ig.with(dir === root ? '' : relPosix(root, dir), text)
  } catch {
    return ig
  }
}
