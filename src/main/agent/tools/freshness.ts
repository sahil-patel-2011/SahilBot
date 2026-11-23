import { statSync } from 'node:fs'

// Stale-write protection (as in Claude Code's editor): when the agent overwrites a whole file it read or wrote
// earlier in this chat, the file must still be the version it saw. If the user (or another program) changed it in
// the meantime, the write is refused with a note to read it again, so their edit isn't silently replaced.
// A file the agent never read is written as before (a backup is kept); exact-text edits (code edit) are safe on
// their own, since they apply to the file as it is now.

const seen = new Map<string, { mtimeMs: number; size: number }>()
const key = (threadId: string, full: string): string => `${threadId}\0${full}`

/** The agent saw this file as it is now (read it, or just wrote it). */
export function noteSeen(threadId: string | undefined, full: string): void {
  if (!threadId) return
  try {
    const s = statSync(full)
    seen.set(key(threadId, full), { mtimeMs: s.mtimeMs, size: s.size })
    if (seen.size > 5000) seen.delete(seen.keys().next().value!)
  } catch { /* gone: nothing to remember */ }
}

/**
 * An existing file this chat never opened (or wrote): replacing it blind could wipe someone's work (Grok Bot
 * head-to-head: a script with the same name was overwritten without asking). The model reads it, picks a new
 * name, or asks. Empty files don't count.
 */
export function unseenReason(threadId: string | undefined, full: string, shown: string): string | undefined {
  if (!threadId || seen.has(key(threadId, full))) return undefined
  try {
    if (statSync(full).size === 0) return undefined
  } catch { return undefined }
  const dot = shown.lastIndexOf('.')
  const alt = dot > 0 ? `${shown.slice(0, dot)}-2${shown.slice(dot)}` : `${shown}-2`
  return `${shown} already exists and this chat hasn't opened it, so nothing was written. Read it first if you mean to change it, save yours as ${alt} instead, or ask the user whether to replace it.`
}

/** Why an overwrite would replace a change the agent hasn't seen, or undefined when it's safe. */
export function staleReason(threadId: string | undefined, full: string, shown: string): string | undefined {
  if (!threadId) return undefined
  const was = seen.get(key(threadId, full))
  if (!was) return undefined
  try {
    const s = statSync(full)
    if (s.mtimeMs === was.mtimeMs && s.size === was.size) return undefined
    return `${shown} changed on disk since you last read it (it was edited outside this chat, ${new Date(s.mtimeMs).toLocaleTimeString()}). Nothing was written. Read it again with file_read and write your change on top of the current version.`
  } catch { return undefined }
}
