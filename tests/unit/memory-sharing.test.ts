import { expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'

// Bots share what they learn: any bot, chat or agent can read what the other bots learned (labeled with the bot),
// never another bot's rules; the user can turn it off (Settings → Memory → Bots share what they learn).
function setup() {
  const db = new Db(':memory:')
  const inbox = db.createSpace('Inbox', '#111111')
  const scout = db.createSpace('Scout', '#222222')
  const memory = new MemoryStore(db)
  memory.nameOf = (id) => db.getSpace(id)?.name
  memory.save('2026-11-20: routine "Competitor watch" ran → Acme raised prices 12% on the Pro plan', 'worklog', scout.id)
  memory.save('Always reply to Acme in a formal tone', 'rule', scout.id)
  memory.save('Prefers metric units', 'preference', null)
  return { db, memory, inbox, scout }
}

test('another bot finds what Scout learned, labeled with Scout, but never Scout\'s rules', () => {
  const { memory, inbox } = setup()
  const hits = memory.teamSearch('Acme prices', inbox.id)
  expect(hits.map((h) => h.from)).toEqual(['Scout'])
  expect(hits[0].content).toContain('raised prices 12%')
  expect(memory.teamSearch('formal tone Acme', inbox.id).some((h) => h.category === 'rule')).toBe(false)
})

test('the context block of another bot carries the relevant item from the other bot', () => {
  const { memory, inbox } = setup()
  const block = memory.block({ spaceId: inbox.id, query: 'What did Acme do with their Pro plan prices?' })
  expect(block).toContain('From your other bots')
  expect(block).toContain('from Scout')
  expect(block).not.toContain('formal tone')
})

test('a bot does not see its own memories twice, and sharing can be turned off', () => {
  const { memory, scout, inbox } = setup()
  expect(memory.teamSearch('Acme prices', scout.id)).toEqual([])
  memory.shareAcrossBots = false
  expect(memory.teamSearch('Acme prices', inbox.id)).toEqual([])
  expect(memory.block({ spaceId: inbox.id, query: 'Acme Pro plan prices' })).not.toContain('From your other bots')
})
