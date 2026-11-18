import { createHash } from 'node:crypto'
import type { Db } from '../db'
import type { WorkingMemoryPage } from '../agent/task-memory'
import { renderNote, safeTitle } from './notes'
import type { VaultService } from './service'

// A project's durable task memory (agent/task-memory.ts) as a page in its vault area:
// "<project area>/Working memory.md" (e.g. "Bots/Website relaunch/Working memory.md"). The database is the
// record; the page is its user-visible, exportable, editable mirror, rewritten when the memory changes. An edit
// of the page (in the Vault view or in Obsidian) is read back the next time the memory is used: the user's
// added lines are their own words, deleted or changed ones become history. A change a bot made through the
// vault tool is read back as the agent's (unverified), never as the user's.

const KEY = 'workingMemory:pages'
export const WORKING_MEMORY_TAG = 'sahilbot/working-memory'
const ACTOR = 'working memory'

interface Written { path: string; hash: string; at: number }
const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex')

export function workingMemoryPage(vault: VaultService, db: Db): WorkingMemoryPage {
  const written = (): Record<string, Written> => db.getSetting<Record<string, Written>>(KEY) ?? {}
  const pathFor = (projectId: string): string | null => {
    const section = vault.sectionFor(projectId)
    return section ? `${section}/Working memory.md` : null
  }
  return {
    edited(projectId) {
      if (!vault.settings().enabled) return null
      const w = written()[projectId]
      if (!w) return null
      const n = vault.store.read(w.path)
      if (!n || hashOf(n.text) === w.hash) return null
      // Who changed it last: the user (the Vault view, or outside the app in Obsidian), or a bot.
      const last = vault.store.changes(300).find((c) => c.path === w.path && !c.undoneAt)
      const byUser = !last || last.actor === 'you' || last.actor === ACTOR
      return { text: n.text, byUser, writtenAt: w.at }
    },
    write(projectId, title, markdown) {
      if (!vault.settings().enabled) return
      const rel = written()[projectId]?.path ?? pathFor(projectId)
      if (!rel) return
      const name = safeTitle(title)
      const day = new Date().toISOString().slice(0, 10)
      const cur = vault.store.read(rel)
      const text = renderNote({
        fm: { type: 'project', title: name, tags: [WORKING_MEMORY_TAG], aliases: [], sources: [], created: cur?.fm.created ?? day, updated: day, trust: 'trusted', extra: {} },
        body: markdown
      })
      if (cur?.text === text) {
        db.setSetting(KEY, { ...written(), [projectId]: { path: rel, hash: hashOf(text), at: Date.now() } })
        return
      }
      vault.store.ensure()
      vault.store.write(rel, text, { actor: ACTOR, why: 'saved before a compaction or a notes change' })
      db.setSetting(KEY, { ...written(), [projectId]: { path: rel, hash: hashOf(vault.store.read(rel)?.text ?? text), at: Date.now() } })
      if (!cur) vault.store.rebuildIndexes()
      vault.changed()
    }
  }
}
