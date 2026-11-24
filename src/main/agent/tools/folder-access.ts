import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ToolContext, ToolDef } from '../types'

/**
 * macOS asks once before an app may open Downloads, Desktop or Documents, and the first file call there waits on
 * that hidden dialog (report EHA-02: "sat 3+ min on Reading …/Downloads with no message"). The file tools read and
 * write synchronously, which would freeze the app while the dialog waits, so the folder is opened first without
 * blocking: after 3 s the chat says to look for the dialog, and the tool runs once the folder answers.
 */
const PROTECTED = new Set(['Downloads', 'Desktop', 'Documents'])
const granted = new Set<string>()

/** The protected home folders these paths are in ("~/Downloads/x.pdf" → "/Users/you/Downloads"). */
export function protectedFolders(paths: unknown[], cwd?: string, home = homedir()): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !p.trim()) continue
    const full = p.startsWith('~/') ? join(home, p.slice(2)) : isAbsolute(p) ? p : cwd ? resolve(cwd, p) : ''
    if (!full) continue
    const rel = relative(home, full)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    const top = rel.split(sep)[0]
    if (PROTECTED.has(top)) out.add(join(home, top))
  }
  return [...out]
}

/** The path-like arguments of any tool call (path, from, to, out, dir, file, paths): what it may open. */
export function pathArgs(a: Record<string, unknown> | undefined): unknown[] {
  const x = a ?? {}
  return [x.path, x.from, x.to, x.out, x.dir, x.file, x.folder, ...(Array.isArray(x.paths) ? x.paths : [])]
}

/** The protected folders a shell command names or runs in ("ls ~/Downloads", "cd /Users/you/Desktop && …"). */
export function commandFolders(command: string, cwd: string, home = homedir()): string[] {
  const named = [...command.matchAll(/(?:~|\$HOME|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)\/(Downloads|Desktop|Documents)\b/g)].map((m) => join(home, m[1]))
  return protectedFolders([cwd, ...named], cwd, home)
}

/** The folder's name in the chat's hint ("Downloads"). */
const nameOf = (folder: string): string => folder.split(sep).filter(Boolean).pop() ?? folder

/**
 * Opens each folder once (asynchronously), saying after `ms` that macOS may be asking. Never throws: a refusal shows
 * up as the tool's own error. `open` is the probe (tests replace it).
 */
export async function askFolderAccess(folders: string[], ctx: Pick<ToolContext, 'progress'>, o: { ms?: number; open?: (dir: string) => Promise<unknown> } = {}): Promise<void> {
  for (const dir of folders) {
    if (granted.has(dir)) continue
    let hinted = false
    const hint = setTimeout(() => { hinted = true; ctx.progress?.(`macOS may be asking to let SahilBot open your ${nameOf(dir)} folder. Look for its dialog and click OK`, { waitingOnYou: true }) }, o.ms ?? 3000)
    try { await (o.open ?? readdir)(dir); granted.add(dir) } catch { /* refused or missing: the tool says so */ } finally { clearTimeout(hint) }
    // Answered: the working line stops asking about a dialog that is gone.
    if (hinted) ctx.progress?.(`Opened your ${nameOf(dir)} folder`)
  }
}

/** A file tool that opens a protected folder first (its path, from and to arguments). */
export function withFolderAccess<T extends ToolDef>(tool: T): T {
  const run = tool.run.bind(tool)
  return {
    ...tool,
    run: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const a = args ?? {}
      const folders = protectedFolders([a.path, a.from, a.to, ...(Array.isArray(a.paths) ? a.paths : [])], ctx.workspaceDir)
      if (folders.length) await askFolderAccess(folders, ctx)
      return run(args as never, ctx)
    }
  } as T
}

/** Tests: forget which folders already answered. */
export function resetFolderAccess(): void { granted.clear() }
