import type { Db } from '../../db'
import type { ToolDef } from '../types'
import { changesOf, lastUndoable, undoRun, undoSummary, type UndoResult } from '../undo-journal'

/** The user asked, in their own latest message, to undo or put something back (a page or an email can't). */
const ASKED = /\b(undo|un-do|revert|roll ?back|put (it|them|that|those|everything) back|take (it|that) back|restore (it|them|the|my)|change (it|them) back|go back to (how|what) it was)\b/i

/** The tasks in a chat, oldest first: each one is the user's message that started it (a side question never starts one). */
export const taskKeys = (db: Db, threadId: string): string[] =>
  db.listMessages(threadId).filter((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.aside).map((m) => m.id)

/**
 * The task an assistant message belongs to: the user's message that started the run (loop.ts beginRun). A side
 * question asked mid-task ("18% of $1,740?") never starts one, and a message sent while it ran (steer, stop) only did
 * when it opened a run of its own (it has changes under its id); else the task is the message before it.
 */
export function taskOf(db: Db, threadId: string, messageId: string): string | undefined {
  const ms = db.listMessages(threadId)
  const i = ms.findIndex((m) => m.id === messageId)
  for (let j = (i < 0 ? ms.length : i) - 1; j >= 0; j--) {
    const m = ms[j]
    if (m.role !== 'user' || m.meta?.hidden || m.meta?.aside) continue
    if (m.meta?.steer && !changesOf(threadId, m.id)) {
      // Sent mid-task: the task is the run it joined, unless nothing earlier started one.
      const earlier = ms.slice(0, j).some((x) => x.role === 'user' && !x.meta?.hidden && !x.meta?.aside)
      if (earlier) continue
    }
    return m.id
  }
  return undefined
}

/** Undo a task's file changes and say so in the chat (a system line, like Grok Bot's "Deleted routine · …"). */
export function undoTask(db: Db, threadId: string, key: string, post?: (text: string) => void): UndoResult {
  const r = undoRun(threadId, key)
  post?.(undoSummary(r))
  return r
}

/** A bot deleted from this chat a moment ago (still undoable), and how to bring it back. */
export interface UndoBots {
  lastDeleted: (threadId: string) => { id: string; name: string; at: number } | undefined
  restore: (spaceId: string) => void
}

/** "Undo that": takes back the file changes of this chat's previous task (or a bot it just deleted). */
export function undoTool(db: Db, bots?: UndoBots): ToolDef<Record<string, never>> {
  return {
    name: 'undo_changes',
    label: 'Undo',
    core: true,
    effect: 'write_local',
    description: 'Undo the file changes from this chat\'s previous task: files it changed go back to how they were, files it made are taken away (kept in a holding folder, not deleted). Only when the user asks to undo, revert or put things back. Changes made by terminal commands, emails sent or posts made can\'t be undone this way: say so.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run(_a, ctx) {
      const said = [...db.listMessages(ctx.threadId)].reverse().find((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.handoff && !m.meta?.fromApp)?.content ?? ''
      if (!ASKED.test(said)) throw new Error('Only undo when the user asks you to in this chat.')
      const key = lastUndoable(ctx.threadId, taskKeys(db, ctx.threadId))
      // "Delete it" then "undo": the bot comes back (when that delete is newer than the last file changes).
      const gone = bots?.lastDeleted(ctx.threadId)
      if (gone && gone.at >= (key ? db.getMessage(key)?.createdAt ?? 0 : 0)) {
        bots!.restore(gone.id)
        const now = db.getSpace(gone.id)?.name ?? gone.name
        return { text: `Brought back ${gone.name}${now !== gone.name ? ` as ${now} (another bot is called ${gone.name} now)` : ''} with its chat and routines.`, display: `brought back ${gone.name}`, verification: { passed: !!db.listSpaces().some((s) => s.id === gone.id), criterion: 'Bot restored', detail: `${gone.name} is in the bot list again.` } }
      }
      if (!key) return { text: 'There are no file changes from an earlier task in this chat to undo.', display: 'nothing to undo' }
      const files = changesOf(ctx.threadId, key)?.files.length ?? 0
      const r = undoRun(ctx.threadId, key)
      const text = undoSummary(r)
      return { text, display: `undid ${files} file change${files === 1 ? '' : 's'}`, verification: { passed: r.skipped.length === 0, criterion: 'Files back as they were', detail: text } }
    }
  }
}
