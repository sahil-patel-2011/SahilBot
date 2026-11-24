import { afterEach, expect, test, vi } from 'vitest'
import { createBotTool, iconFor, manageBotTool, resetBotPrompts } from '../../src/main/agent/tools/bots'
import { undoTool } from '../../src/main/agent/tools/undo'
import { botTrash, BOT_UNDO_MS } from '../../src/main/bot-trash'
import { Db } from '../../src/main/db'

afterEach(() => { vi.useRealTimers() })

// Grok Bot head-to-head: "Make me a Homework Helper bot" repurposed the existing New bot, took 4 minutes and a trip
// to the Needs you page; "Delete the Homework Helper bot" couldn't be done by asking.
function setup() {
  const db = new Db(':memory:')
  const main = db.createSpace('New bot', '#000', { isMain: true, shape: 'mascot' })
  const chat = db.createThread(main.id, 'auto', null)
  const prompts = new Map<string, string>()
  const greeted: string[] = []
  const pins: string[] = []
  const cards: Array<{ threadId: string; name: string; icon: string }> = []
  const stopped: string[] = []
  const resets: string[] = []
  const bin = botTrash(db, { stop: (ids) => stopped.push(...ids), emit: () => undefined })
  const create = createBotTool({
    create: (name, color, shape, icon) => { const s = db.createSpace(name, color, { kind: 'bot', shape: shape as never, icon }); return { spaceId: s.id, threadId: db.createThread(s.id, 'auto', null).id } },
    setPrompt: (id, t) => prompts.set(id, t),
    setLabel: (id, label) => db.updateSpace(id, { label }),
    greet: (threadId, text) => { greeted.push(text); db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done' }) },
    card: (threadId, bot) => cards.push({ threadId, name: bot.name, icon: bot.icon })
  }, db, () => undefined)
  const manage = manageBotTool({
    remove: (id, threadId) => bin.remove(id, threadId), restore: (id) => bin.restore(id), pin: (id, on) => (on ? pins.push(id) : undefined),
    getPrompt: (id) => prompts.get(id) ?? '', setPrompt: (id, t) => prompts.set(id, t), resetPrompt: (id) => resets.push(id)
  }, db, () => undefined)
  const say = (text: string) => db.insertMessage({ threadId: chat.id, role: 'user', content: text, kind: 'normal', status: 'done' })
  const reply = (text: string) => db.insertMessage({ threadId: chat.id, role: 'assistant', content: text, kind: 'normal', status: 'done' })
  const ctx = { threadId: chat.id, state: { roots: [], loaded: [], todos: [] } } as never
  const make = async (name: string, instructions = `You are ${name}. You help with homework.`) => {
    say(`Make me a bot called ${name}`)
    await create.run({ name, job: 'Homework help', instructions, icon: '📚' }, ctx)
    return db.listSpaces().find((s) => s.name === name)!
  }
  return { db, main, chat, create, manage, say, reply, ctx, prompts, greeted, pins, cards, bin, stopped, resets, make }
}

test('"make me a … bot" creates a new bot with its own chat, job, icon and hello; the main bot is untouched', async () => {
  const h = setup()
  h.say('Make me a Homework Helper bot for chemistry and algebra, with its own icon')
  const r = await h.create.run({ name: 'Homework Helper', job: 'Chemistry and algebra homework help', instructions: 'You help with chemistry and algebra homework, step by step.', color: 'teal', icon: '🧪' }, h.ctx)
  expect(r.text).toMatch(/Created Homework Helper/)
  const bot = h.db.listSpaces().find((s) => s.name === 'Homework Helper')!
  expect(bot).toMatchObject({ kind: 'bot', icon: '🧪', label: 'Chemistry and algebra homework help', isMain: false })
  expect(h.prompts.get(bot.id)).toContain('chemistry')
  expect(h.greeted[0]).toMatch(/Hi, I'm Homework Helper 🧪/)
  expect(h.db.getSpace(h.main.id)!.name).toBe('New bot')
  // Same name again: refused, not duplicated.
  await expect(h.create.run({ name: 'homework helper', job: 'x', instructions: 'x' }, h.ctx)).rejects.toThrow(/already exists/)
})

test('a bot is only created when the user asked; deleting asks no card (it can be undone); the main bot is never deleted', async () => {
  const h = setup()
  h.say('Summarize this page for me')
  await expect(h.create.run({ name: 'Sneaky', job: 'x', instructions: 'x' }, h.ctx)).rejects.toThrow(/Only create a bot when the user asks/)
  h.say('Make me a Homework Helper bot')
  await h.create.run({ name: 'Homework Helper', job: 'Homework help', instructions: 'Help with homework.' }, h.ctx)
  // Deleting asks no card: it can be undone instead (below).
  expect(h.manage.hardStop).toBeUndefined()
  expect(h.manage.effect).toBe('write_local')
  h.say('Pin the homework helper')
  await h.manage.run({ bot: 'homework', action: 'pin' }, h.ctx)
  expect(h.pins).toHaveLength(1)
  h.say('Delete the Homework Helper bot')
  await h.manage.run({ bot: 'Homework Helper', action: 'delete' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.name === 'Homework Helper')).toBe(false)
  h.say('Delete New bot')
  await expect(h.manage.run({ bot: 'New bot', action: 'delete' }, h.ctx)).rejects.toThrow(/main bot/)
  // Asked to hide is not asked to delete.
  await h.make('Quiz Master')
  h.say('Hide Quiz Master')
  await expect(h.manage.run({ bot: 'Quiz Master', action: 'delete' }, h.ctx)).rejects.toThrow(/Only change a bot/)
})

test('deleting by asking is undoable: "Deleted X · Undo", restore brings back the bot, its chat and its groups; then it is really deleted', async () => {
  vi.useFakeTimers()
  const h = setup()
  const bot = await h.make('Homework Helper')
  const botChat = h.db.listThreads(bot.id)[0]
  h.db.insertMessage({ threadId: botChat.id, role: 'user', content: 'Balance H2 + O2', kind: 'normal', status: 'done' })
  const group = h.db.createSpace('Study group', '#000', { kind: 'group', members: [bot.id] })
  h.say('Delete the Homework Helper bot')
  const r = await h.manage.run({ bot: 'Homework Helper', action: 'delete' }, h.ctx)
  expect(r.text).toMatch(/Deleted Homework Helper/)
  expect(r.data).toMatchObject({ undoBot: bot.id })
  // Gone from every list at once; its chat stopped; the group dropped it.
  expect(h.db.listSpaces().some((s) => s.id === bot.id)).toBe(false)
  expect(h.db.listThreads().some((t) => t.id === botChat.id)).toBe(false)
  expect(h.db.searchThreads('H2').some((t) => t.id === botChat.id)).toBe(false)
  expect(h.stopped).toContain(botChat.id)
  expect(h.db.getSpace(group.id)!.members).toEqual([])
  const notice = h.db.listMessages(h.chat.id).find((m) => m.meta?.botUndo)!
  expect(notice).toMatchObject({ kind: 'notice', content: 'Deleted Homework Helper' })
  // Still there 30 s later, and "undo" brings it all back.
  vi.advanceTimersByTime(30_000)
  h.say('undo')
  await h.manage.run({ bot: 'Homework Helper', action: 'restore' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.id === bot.id)).toBe(true)
  expect(h.db.listMessages(botChat.id).some((m) => m.content === 'Balance H2 + O2')).toBe(true)
  expect(h.db.getSpace(group.id)!.members).toEqual([bot.id])
  expect(h.db.getMessage(notice.id)!.meta?.undone).toBe(true)
  // The purge that was due is cancelled by Undo.
  vi.advanceTimersByTime(BOT_UNDO_MS)
  expect(h.db.getSpace(bot.id)).toBeTruthy()
  // Deleted again and left alone: really deleted after the Undo time.
  h.say('Delete Homework Helper again')
  await h.manage.run({ bot: 'Homework Helper', action: 'delete' }, h.ctx)
  vi.advanceTimersByTime(BOT_UNDO_MS + 1)
  expect(h.db.getSpace(bot.id)).toBeUndefined()
  expect(h.db.listMessages(botChat.id)).toHaveLength(0)
  h.say('undo')
  await expect(h.manage.run({ bot: 'Homework Helper', action: 'restore' }, h.ctx)).rejects.toThrow(/no recently deleted bot/)
})

test('"undo" through undo_changes brings back the bot just deleted in this chat; a restart purges old deletes', async () => {
  const h = setup()
  const bot = await h.make('Study Buddy')
  h.say('Delete Study Buddy')
  await h.manage.run({ bot: 'Study Buddy', action: 'delete' }, h.ctx)
  const undo = undoTool(h.db, { lastDeleted: (t) => h.bin.lastDeleted(t), restore: (id) => h.bin.restore(id) })
  h.say('undo')
  const r = await undo.run({}, h.ctx)
  expect(r.text).toMatch(/Brought back Study Buddy/)
  expect(h.db.listSpaces().some((s) => s.id === bot.id)).toBe(true)
  // Deleted before the app quit, longer ago than the Undo time: gone at the next start.
  h.db.trashSpace(bot.id, Date.now() - BOT_UNDO_MS - 1000)
  botTrash(h.db, { stop: () => undefined, emit: () => undefined }).resume()
  expect(h.db.getSpace(bot.id)).toBeUndefined()
})

test('a "yes" or a short answer to the bot\'s question counts as asking; "no" never does', async () => {
  const h = setup()
  await h.make('Homework Helper 2')
  h.say('Delete the Homework Helper 2 bot')
  h.reply('Delete Homework Helper 2 and its chat?')
  h.say('no')
  await expect(h.manage.run({ bot: 'Homework Helper 2', action: 'delete' }, h.ctx)).rejects.toThrow(/Only change a bot/)
  h.say('Delete the Homework Helper 2 bot')
  h.reply('Delete Homework Helper 2 and its chat?')
  h.say('Yes')
  await h.manage.run({ bot: 'Homework Helper 2', action: 'delete' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.name === 'Homework Helper 2')).toBe(false)
  // create_bot after "What should I call it?" → "Study Pal".
  h.say('Make me a new bot for chemistry')
  h.reply('What should I call it?')
  h.say('Study Pal')
  await h.create.run({ name: 'Study Pal', job: 'Chemistry help', instructions: 'You help with chemistry.' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.name === 'Study Pal')).toBe(true)
  // A long unrelated message in between ends it.
  h.say('Summarize this article about the history of the printing press for me please')
  await expect(h.create.run({ name: 'Sneaky', job: 'x', instructions: 'x' }, h.ctx)).rejects.toThrow(/Only create a bot/)
})

test('rename by chat: "Change its name to Study Buddy" works, the instructions follow, a taken name is refused', async () => {
  const h = setup()
  const bot = await h.make('Homework Helper', 'You are Homework Helper. You help with chemistry.')
  await h.make('Quiz Master')
  h.say('Change its name to Study Buddy')
  await h.manage.run({ bot: 'Homework Helper', action: 'rename', name: 'Study Buddy' }, h.ctx)
  expect(h.db.getSpace(bot.id)!.name).toBe('Study Buddy')
  expect(h.db.listThreads(bot.id)[0].title).toBe('Study Buddy')
  expect(h.prompts.get(bot.id)).toBe('You are Study Buddy. You help with chemistry.\n')
  h.say('Rename it Quiz Master')
  await expect(h.manage.run({ bot: 'Study Buddy', action: 'rename', name: 'quiz master' }, h.ctx)).rejects.toThrow(/already exists/)
})

test('"Make it stricter": manage_bot update changes that bot\'s instructions, icon and color, not the main bot\'s', async () => {
  const h = setup()
  h.prompts.set(h.main.id, 'You are the main bot.\n')
  const bot = await h.make('Homework Helper')
  h.say('Make it stricter')
  const r = await h.manage.run({ bot: 'Homework Helper', action: 'update', instructions: 'You are Homework Helper. Be strict: never give the answer, only hints.', icon: '🧪', color: 'blue' }, h.ctx)
  expect(r.text).toMatch(/Updated Homework Helper: instructions, icon 🧪, color blue/)
  expect(h.prompts.get(bot.id)).toMatch(/Be strict/)
  expect(h.db.getSpace(bot.id)).toMatchObject({ icon: '🧪', color: '#0EA5E9' })
  expect(h.prompts.get(h.main.id)).toBe('You are the main bot.\n')
  h.say('Change it')
  await expect(h.manage.run({ bot: 'Homework Helper', action: 'update' }, h.ctx)).rejects.toThrow(/Say what to change/)
})

test('a partial name that fits several bots asks which one instead of picking the first', async () => {
  const h = setup()
  await h.make('Homework Helper')
  await h.make('Helper Pro')
  h.say('Delete the helper bot')
  await expect(h.manage.run({ bot: 'helper', action: 'delete' }, h.ctx)).rejects.toThrow(/Which one: (Homework Helper or Helper Pro|Helper Pro or Homework Helper)\?/)
  expect(h.db.listSpaces().filter((s) => s.kind === 'bot' && !s.isMain)).toHaveLength(2)
  h.say('Delete Helper Pro')
  await h.manage.run({ bot: 'helper pro', action: 'delete' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.name === 'Helper Pro')).toBe(false)
})

test('every new bot gets an icon (one that fits its job when none is given) and a card in the chat that asked', async () => {
  const h = setup()
  h.say('Make me a bot called Homework Helper 2 for chemistry and algebra, with its own icon')
  await h.create.run({ name: 'Homework Helper 2', job: 'Chemistry and algebra homework', instructions: 'You help with chemistry and algebra.' }, h.ctx)
  expect(h.db.listSpaces().find((s) => s.name === 'Homework Helper 2')!.icon).toBe('🧪')
  expect(h.cards).toEqual([{ threadId: h.chat.id, name: 'Homework Helper 2', icon: '🧪' }])
  expect(iconFor('Inbox and replies')).toBe('📬')
  expect(iconFor('Something else entirely')).toBe('✨')
  // Not an emoji: the fallback, not the text.
  h.say('Make me a bot called Mailer for my inbox')
  await h.create.run({ name: 'Mailer', job: 'Inbox', instructions: 'You keep the inbox tidy.', icon: 'mail' }, h.ctx)
  expect(h.db.listSpaces().find((s) => s.name === 'Mailer')!.icon).toBe('📬')
})

test('rename swaps the old name only as a whole word in the instructions', async () => {
  const h = setup()
  const bot = await h.make('Ace', 'You are Ace. Keep your place in the reading; Ace\'s notes come first.')
  h.say('Rename it Study Buddy')
  await h.manage.run({ bot: 'Ace', action: 'rename', name: 'Study Buddy' }, h.ctx)
  expect(h.prompts.get(bot.id)).toBe('You are Study Buddy. Keep your place in the reading; Study Buddy\'s notes come first.\n')
})

test('a rename or new instructions from another chat reach the bot\'s ongoing conversation (its frozen prompt is reset)', async () => {
  const h = setup()
  const bot = await h.make('Homework Helper')
  h.say('Rename it Study Buddy')
  await h.manage.run({ bot: 'Homework Helper', action: 'rename', name: 'Study Buddy' }, h.ctx)
  h.say('Make it stricter')
  await h.manage.run({ bot: 'Study Buddy', action: 'update', instructions: 'You are Study Buddy. Be strict.' }, h.ctx)
  expect(h.resets).toEqual([bot.id, bot.id])
  // An icon only changes nothing in its prompt.
  h.say('Give it a 🧪 icon')
  await h.manage.run({ bot: 'Study Buddy', action: 'update', icon: '🧪' }, h.ctx)
  expect(h.resets).toHaveLength(2)
  // resetBotPrompts: its own chat and a group it is in lose their snapshots; a chat working right now is cleared when it ends.
  const own = h.db.listThreads(bot.id)[0]
  const group = h.db.createSpace('Study group', '#000', { kind: 'group', members: [bot.id] })
  const groupChat = h.db.createThread(group.id, 'auto', null)
  const other = h.db.createThread(h.main.id, 'auto', null)
  for (const t of [own, groupChat, other]) { const st = h.db.getState(t.id); st.systemSnapshot = 'Bot: Homework Helper'; st.snapshots = { [bot.id]: 'old' }; h.db.setState(t.id, st) }
  let idle: (r: string) => void = () => undefined
  resetBotPrompts(h.db, bot.id, { isRunning: (t) => t === groupChat.id, whenIdle: () => new Promise((r) => { idle = r }) })
  expect(h.db.getState(own.id).systemSnapshot).toBeUndefined()
  expect(h.db.getState(groupChat.id).snapshots).toEqual({ [bot.id]: 'old' })
  expect(h.db.getState(other.id).systemSnapshot).toBe('Bot: Homework Helper')
  idle('idle')
  await Promise.resolve(); await Promise.resolve()
  expect(h.db.getState(groupChat.id).systemSnapshot).toBeUndefined()
  expect(h.db.getState(groupChat.id).snapshots).toEqual({})
})

test('once a deleted bot is really gone, its "Deleted X · Undo" line loses the Undo', async () => {
  vi.useFakeTimers()
  const emitted: Array<Record<string, unknown> | undefined> = []
  const h = setup()
  const bin = botTrash(h.db, { stop: () => undefined, emit: (m) => emitted.push(m.meta) })
  const bot = await h.make('Quizzy')
  bin.remove(bot.id, h.chat.id)
  const notice = h.db.listMessages(h.chat.id).find((m) => m.meta?.botUndo)!
  expect(notice.meta?.expired).toBeUndefined()
  // Kept at least 30 s.
  vi.advanceTimersByTime(30_000)
  expect(h.db.trashedAt(bot.id)).toBeDefined()
  vi.advanceTimersByTime(BOT_UNDO_MS)
  expect(h.db.getSpace(bot.id)).toBeUndefined()
  expect(h.db.getMessage(notice.id)!.meta?.expired).toBe(true)
  expect(emitted.at(-1)?.expired).toBe(true)
})
