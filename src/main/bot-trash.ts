import type { Message } from '@shared/types'
import type { Db } from './db'

/** How long a deleted bot can be brought back (Undo) before it and its chat are really deleted. */
export const BOT_UNDO_MS = 10 * 60_000

interface TrashRecord { at: number; groups: string[]; notices: string[] }

export interface BotTrashDeps {
  /** Stops the bot's chats and background jobs. */
  stop: (threadIds: string[]) => void
  /** Why this bot can't be deleted here (e.g. it runs on another Mac), else null. */
  blocked?: (spaceId: string) => string | null
  /** A message was added or changed (the "Deleted X · Undo" line). */
  emit: (m: Message) => void
  undoMs?: number
}

/**
 * Deleting a bot so it can be undone: it leaves every list at once and its chats and jobs stop, but it, its chat
 * and its routines are kept for `undoMs`; Undo (restore) brings it all back, groups included. After that it is
 * really deleted, also at the next start when the app quit first. The chat that asked gets "Deleted X · Undo".
 */
export function botTrash(db: Db, deps: BotTrashDeps) {
  const undoMs = deps.undoMs ?? BOT_UNDO_MS
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const key = (id: string): string => `trash:bot:${id}`

  function purge(id: string): void {
    clearTimeout(timers.get(id))
    timers.delete(id)
    if (db.trashedAt(id) === undefined) return
    const rec = db.getSetting<TrashRecord>(key(id))
    db.deleteSpace(id)
    db.setSetting(key(id), null)
    // "Deleted X · Undo" loses its Undo: there is nothing left to bring back.
    for (const mid of rec?.notices ?? []) {
      const m = db.getMessage(mid)
      if (!m || m.meta?.undone) continue
      const next = { ...m, meta: { ...m.meta, expired: true } }
      db.updateMessage(next)
      deps.emit(next)
    }
  }
  function schedule(id: string, ms: number): void {
    clearTimeout(timers.get(id))
    const t = setTimeout(() => { try { purge(id) } catch { /* the next start finishes it */ } }, Math.max(0, ms))
    t.unref?.()
    timers.set(id, t)
  }

  return {
    remove(id: string, threadId?: string): void {
      const space = db.getSpace(id)
      if (!space || db.trashedAt(id) !== undefined) return
      if (space.isMain) throw new Error("The main bot can't be deleted.")
      const why = deps.blocked?.(id)
      if (why) throw new Error(why)
      deps.stop(db.listThreads(id).map((t) => t.id))
      const groups = db.listSpaces().filter((x) => x.kind === 'group' && x.members.includes(id))
      for (const g of groups) db.updateSpace(g.id, { members: g.members.filter((m) => m !== id) })
      const at = Date.now()
      db.trashSpace(id, at)
      schedule(id, undoMs)
      const asked = threadId ? db.getThread(threadId) : undefined
      const notices: string[] = []
      if (asked && asked.spaceId !== id) {
        const m = db.insertMessage({ threadId: asked.id, role: 'assistant', content: `Deleted ${space.name}`, kind: 'notice', status: 'done', meta: { botUndo: { spaceId: id, name: space.name } } })
        notices.push(m.id)
        deps.emit(m)
      }
      db.setSetting(key(id), { at, groups: groups.map((g) => g.id), notices } satisfies TrashRecord)
    },

    restore(id: string): void {
      if (db.trashedAt(id) === undefined) throw new Error(db.getSpace(id) ? 'That bot is not deleted.' : 'That bot was deleted too long ago to bring back.')
      clearTimeout(timers.get(id))
      timers.delete(id)
      db.restoreSpace(id)
      // A bot with this name was made while it was deleted: the one brought back gets "(restored)", so a later
      // "delete Homework Helper" never acts on the wrong one.
      const back = db.getSpace(id)
      if (back && db.listSpaces().some((x) => x.id !== id && x.kind === 'bot' && x.name.toLowerCase() === back.name.toLowerCase())) {
        const name = `${back.name} (restored)`
        db.updateSpace(id, { name })
        for (const t of db.listThreads(id)) if (t.title === back.name) db.updateThread(t.id, { title: name })
      }
      const rec = db.getSetting<TrashRecord>(key(id))
      for (const gid of rec?.groups ?? []) { const g = db.getSpace(gid); if (g && !g.members.includes(id)) db.updateSpace(gid, { members: [...g.members, id] }) }
      db.setSetting(key(id), null)
      // "Deleted X · Undo" becomes "Deleted X · Undone".
      for (const mid of rec?.notices ?? []) {
        const m = db.getMessage(mid)
        if (!m) continue
        const next = { ...m, meta: { ...m.meta, undone: true } }
        db.updateMessage(next)
        deps.emit(next)
      }
    },

    /** The newest bot deleted from this chat that can still be brought back ("undo"). */
    lastDeleted(threadId: string): { id: string; name: string; at: number } | undefined {
      return db.trashedSpaces()
        .filter((t) => (db.getSetting<TrashRecord>(key(t.id))?.notices ?? []).some((mid) => db.getMessage(mid)?.threadId === threadId))
        .map((t) => ({ id: t.id, name: t.name, at: t.trashedAt }))
        .sort((a, b) => b.at - a.at)[0]
    },

    /** At start: bots past their Undo time go now, the rest when it ends. */
    resume(now = Date.now()): void {
      for (const t of db.trashedSpaces()) {
        const left = t.trashedAt + undoMs - now
        if (left <= 0) purge(t.id)
        else schedule(t.id, left)
      }
    },

    purge
  }
}
