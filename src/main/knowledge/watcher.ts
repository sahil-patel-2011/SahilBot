import { watch, type FSWatcher } from 'node:fs'
import { join, sep } from 'node:path'
import { skipDir } from './ignore'

// Watches source folders (recursively; FSEvents on macOS) and reports changed paths in batches after
// things settle, so saving a file or checking out a branch is one update, not hundreds.

export class FolderWatcher {
  private watchers = new Map<string, FSWatcher>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private onChange: (paths: string[]) => void, private debounceMs = 1500) {}

  /** Watches exactly these folders (starts new ones, stops ones no longer listed). */
  set(roots: string[]): void {
    for (const [root, w] of this.watchers) if (!roots.includes(root)) { w.close(); this.watchers.delete(root) }
    for (const root of roots) {
      if (this.watchers.has(root)) continue
      try {
        const w = watch(root, { recursive: true, persistent: false }, (_ev, name) => {
          if (!name) return
          const rel = String(name)
          // Changes inside ignored folders (node_modules, .git, build output) never matter.
          if (rel.split(sep).slice(0, -1).some((p) => skipDir(p))) return
          this.pending.add(join(root, rel))
          this.schedule()
        })
        w.on('error', () => { w.close(); this.watchers.delete(root) })
        this.watchers.set(root, w)
      } catch { /* folder gone or not watchable: the periodic rescan covers it */ }
    }
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const paths = [...this.pending]
      this.pending.clear()
      if (paths.length) this.onChange(paths)
    }, this.debounceMs)
  }

  get roots(): string[] {
    return [...this.watchers.keys()]
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    this.pending.clear()
  }
}
