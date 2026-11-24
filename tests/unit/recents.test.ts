import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'

// Recents list only chats you typed in yourself: not ones a routine, a Memory draft, another bot or a connected app
// started in SahilBot's space (the sidebar also leaves out every bot's conversation and SahilBot's own one).
test('a chat counts as yours only once you typed in it', () => {
  const db = new Db(':memory:')
  const main = db.createSpace('SahilBot', '#000', { isMain: true })
  const say = (threadId: string, content: string, meta?: Record<string, unknown>) => db.insertMessage({ threadId, role: 'user', kind: 'normal', status: 'done', content, ...(meta ? { meta } : {}) })
  const mine = db.createThread(main.id, 'auto', null); say(mine.id, 'Plan my trip')
  const empty = db.createThread(main.id, 'auto', null)
  const routine = db.createThread(main.id, 'auto', null); say(routine.id, '⏰ Remind me', { scheduled: 'x' })
  const draft = db.createThread(main.id, 'auto', null); say(draft.id, 'Draft the proposal', { brainPrompt: 'p1' })
  const handoff = db.createThread(main.id, 'auto', null); say(handoff.id, 'From Inbox bot', { handoff: true })
  const app = db.createThread(main.id, 'auto', null); say(app.id, 'From an app', { fromApp: 'Raycast' })
  const by = Object.fromEntries(db.listThreads(main.id).map((t) => [t.id, t.byUser]))
  expect(by[mine.id]).toBe(true)
  expect([empty, routine, draft, handoff, app].map((t) => by[t.id])).toEqual([false, false, false, false, false])
  // Once you reply in a routine's chat, it's yours too.
  say(routine.id, 'Thanks, push it to 5pm')
  expect(db.getThread(routine.id)?.byUser).toBe(true)
})
