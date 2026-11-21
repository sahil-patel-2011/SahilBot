import { existsSync, lstatSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

// Project instructions, the way Codex reads AGENTS.md (github.com/openai/codex, Apache-2.0): the files in the
// chat's folder and in each folder above it up to the repository root (the folder with .git), outermost
// first, so a subfolder's file adds to or overrides the repo's. AGENTS.md is the shared convention (Codex,
// Cursor, Jules, Zed…); CLAUDE.md and GROK.md are read too when a folder has no AGENTS.md. Bounded: 8 KB per
// file, 16 KB in all, at most 6 folders up.

const NAMES = ['AGENTS.md', 'CLAUDE.md', 'GROK.md']
const PER_FILE = 8_000
const TOTAL = 16_000

export interface ProjectInstructions { files: string[]; text: string }

export function projectInstructions(folder: string | null | undefined): ProjectInstructions | undefined {
  if (!folder) return undefined
  let dir = resolve(folder)
  try { if (!statSync(dir).isDirectory()) return undefined } catch { return undefined }
  // The chain: this folder up to the repo root (or 6 levels when there's no git root).
  const chain: string[] = []
  for (let i = 0; i < 7; i++) {
    chain.push(dir)
    if (existsSync(join(dir, '.git'))) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  if (!chain.some((d) => existsSync(join(d, '.git')))) chain.splice(1)
  const files: string[] = []
  const parts: string[] = []
  let used = 0
  for (const d of chain.reverse()) {
    const name = NAMES.find((n) => existsSync(join(d, n)))
    if (!name) continue
    const path = join(d, name)
    let text = ''
    try {
      // A real file only (a symlink could point at ~/.ssh or a credentials file), read no further than needed.
      const st = lstatSync(path)
      if (!st.isFile() || st.size === 0) continue
      const fd = openSync(path, 'r')
      try { const buf = Buffer.alloc(Math.min(st.size, PER_FILE + 1)); readSync(fd, buf, 0, buf.length, 0); text = buf.toString('utf8').trim() } finally { closeSync(fd) }
    } catch { continue }
    if (!text) continue
    if (text.length > PER_FILE) text = `${text.slice(0, PER_FILE)}\n[… cut at ${PER_FILE / 1000} KB]`
    if (used + text.length > TOTAL) break
    used += text.length
    files.push(path)
    parts.push(`From ${relative(resolve(folder), path) || name}:\n${text}`)
  }
  return files.length ? { files, text: parts.join('\n\n') } : undefined
}
