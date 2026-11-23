import { expect, test } from 'vitest'
import { createBotTool, manageBotTool } from '../../src/main/agent/tools/bots'
import { Db } from '../../src/main/db'

// Grok Bot head-to-head: "Make me a Homework Helper bot" repurposed the existing New bot, took 4 minutes and a trip
// to the Needs you page; "Delete the Homework Helper bot" couldn't be done by asking.
function setup() {
  const db = new Db(':memory:')
  const main = db.createSpace('New bot', '#000', { isMain: true, shape: 'mascot' })
  const chat = db.createThread(main.id, 'auto', null)
  const prompts = new Map<string, string>()
  const greeted: string[] = []
  const pins: string[] = []
  const create = createBotTool({
    create: (name, color, shape, icon) => { const s = db.createSpace(name, color, { kind: 'bot', shape: shape as never, icon }); return { spaceId: s.id, threadId: db.createThread(s.id, 'auto', null).id } },
    setPrompt: (id, t) => prompts.set(id, t),
    setLabel: (id, label) => db.updateSpace(id, { label }),
    greet: (threadId, text) => { greeted.push(text); db.insertMessage({ threadId, role: 'assistant', content: text, kind: 'normal', status: 'done' }) }
  }, db, () => undefined)
  const manage = manageBotTool({ remove: (id) => db.deleteSpace(id), pin: (id, on) => (on ? pins.push(id) : undefined) }, db, () => undefined)
  const say = (text: string) => db.insertMessage({ threadId: chat.id, role: 'user', content: text, kind: 'normal', status: 'done' })
  const ctx = { threadId: chat.id, state: { roots: [], loaded: [], todos: [] } } as never
  return { db, main, create, manage, say, ctx, prompts, greeted, pins }
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

test('a bot is only created when the user asked; deleting asks first; the main bot is never deleted', async () => {
  const h = setup()
  h.say('Summarize this page for me')
  await expect(h.create.run({ name: 'Sneaky', job: 'x', instructions: 'x' }, h.ctx)).rejects.toThrow(/Only create a bot when the user asks/)
  h.say('Make me a Homework Helper bot')
  await h.create.run({ name: 'Homework Helper', job: 'Homework help', instructions: 'Help with homework.' }, h.ctx)
  expect(h.manage.hardStop?.({ bot: 'Homework Helper', action: 'delete' } as never, {} as never)).toMatch(/deleting the bot Homework Helper/)
  expect(h.manage.hardStop?.({ bot: 'Homework Helper', action: 'hide' } as never, {} as never)).toBeNull()
  h.say('Pin the homework helper')
  await h.manage.run({ bot: 'homework', action: 'pin' }, h.ctx)
  expect(h.pins).toHaveLength(1)
  h.say('Delete the Homework Helper bot')
  await h.manage.run({ bot: 'Homework Helper', action: 'delete' }, h.ctx)
  expect(h.db.listSpaces().some((s) => s.name === 'Homework Helper')).toBe(false)
  h.say('Delete New bot')
  await expect(h.manage.run({ bot: 'New bot', action: 'delete' }, h.ctx)).rejects.toThrow(/main bot/)
})
