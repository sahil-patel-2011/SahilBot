import { stat } from 'node:fs/promises'
import type { FolderScanEvent } from '@shared/types'
import { Indexer } from './indexer'
import { refuseRoot } from './ignore'

// A folder attached to a chat: how much of it SahilBot can index, counted with the same rules the
// knowledge base uses (no node_modules, build output, hidden folders, secrets, .gitignore'd files or
// unsupported formats). Progress is reported as it goes, so a big folder shows a live count.

export interface ScanOptions {
  /** Most files counted (default 20,000, the knowledge base's own per-folder limit). */
  maxFiles?: number
  home?: string
  /** Progress, at most every `everyMs` (default 200 ms), and once at the end. */
  onProgress?: (e: FolderScanEvent) => void
  everyMs?: number
  signal?: AbortSignal
}

/** Counts the indexable files (and their bytes) under `root`. Throws for places SahilBot never reads. */
export async function scanFolder(root: string, o: ScanOptions = {}): Promise<FolderScanEvent & { sample: string[] }> {
  const why = refuseRoot(root, o.home)
  if (why) throw new Error(why)
  const files: string[] = []
  // walk() only reads the folder tree: no index (store) is involved.
  const ix = new Indexer(null as never, { maxFiles: o.maxFiles ?? 20_000, home: o.home })
  let last = 0
  const every = o.everyMs ?? 200
  let bytes = 0
  const report = (done: boolean, truncated?: boolean): void => {
    try { o.onProgress?.({ path: root, files: files.length, bytes, done, ...(truncated ? { truncated: true } : {}) }) } catch { /* window gone */ }
  }
  const pending: Array<Promise<void>> = []
  const { truncated } = await ix.walk(root, (p) => {
    if (o.signal?.aborted) { ix.stopped = true; return }
    files.push(p)
    pending.push(stat(p).then((st) => { bytes += st.size }, () => undefined))
    if (Date.now() - last > every) { last = Date.now(); report(false) }
  })
  await Promise.all(pending)
  report(true, truncated)
  return { path: root, files: files.length, bytes, done: true, ...(truncated ? { truncated: true } : {}), sample: files.slice(0, 20) }
}
