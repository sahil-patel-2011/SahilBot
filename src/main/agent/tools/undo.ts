import type { Db } from '../../db'
import type { ToolDef } from '../types'
import { changesOf, lastUndoable, undoRun, undoSummary, type UndoResult } from '../undo-journal'

/** The user asked, in their own latest message, to undo or put something back (a page or an email can't). */
const ASKED = /\b(undo|un-do|revert|roll ?back|put (it|them|that|those|everything) back|take (it|that) back|restore (it|them|the|my)|change (it|them) back|go back to (how|what) it was)\b/i

/** The tasks in a chat, oldest first: each one is the user's message that started it. */
export const taskKeys = (db: Db, threadId: string): string[] =>
  db.listMessages(threadId).filter((m) => m.role === 'user' && !m.meta?.hidden).map((m) => m.id)

/** The task an assistant message belongs to: the user's message before it. */
export function taskOf(db: Db, threadId: string, messageId: string): string | undefined {
  const ms = db.listMessages(threadId)
  const i = ms.findIndex((m) => m.id === messageId)
  for (let j = (i < 0 ? ms.length : i) - 1; j >= 0; j--) if (ms[j].role === 'user' && !ms[j].meta?.hidden) return ms[j].id
  return undefined
}

/** Undo a task's file changes and say so in the chat (a system line, like Grok Bot's "Deleted routine · …"). */
export function undoTask(db: Db, threadId: string, key: string, post?: (text: string) => void): UndoResult {
  const r = undoRun(threadId, key)
  post?.(undoSummary(r))
  return r
}

/** "Undo that": takes back the file changes of this chat's previous task. */
export function undoTool(db: Db): ToolDef<Record<string, never>> {
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
      if (!key) return { text: 'There are no file changes from an earlier task in this chat to undo.', display: 'nothing to undo' }
      const files = changesOf(ctx.threadId, key)?.files.length ?? 0
      const r = undoRun(ctx.threadId, key)
      const text = undoSummary(r)
      return { text, display: `undid ${files} file change${files === 1 ? '' : 's'}`, verification: { passed: r.skipped.length === 0, criterion: 'Files back as they were', detail: text } }
    }
  }
}
