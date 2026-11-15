import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Are local models already on this Mac? Used once, to migrate installs from before local models became
// opt-in (settings.ts): a quick look at where Ollama and LM Studio keep downloaded models. No server is
// contacted and nothing is started.

/** Folders that hold downloaded local models. */
export function localModelDirs(home = homedir()): string[] {
  return [
    join(home, '.ollama', 'models', 'manifests'),
    join(home, '.lmstudio', 'models'),
    join(home, '.cache', 'lm-studio', 'models')
  ]
}

/** True when any of `dirs` has a file somewhere inside (looked at a few levels deep, at most ~500 entries). */
export function anyFileIn(dirs: string[], maxEntries = 500): boolean {
  let seen = 0
  const visit = (dir: string, depth: number): boolean => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return false }
    for (const n of names) {
      if (++seen > maxEntries) return false
      if (n.startsWith('.')) continue
      const p = join(dir, n)
      try {
        const st = statSync(p)
        if (st.isFile() && st.size > 0) return true
        if (st.isDirectory() && depth < 6 && visit(p, depth + 1)) return true
      } catch { /* unreadable: skip */ }
    }
    return false
  }
  return dirs.some((d) => visit(d, 0))
}

export function hasLocalModels(home = homedir()): boolean {
  return anyFileIn(localModelDirs(home))
}
