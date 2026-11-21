import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ResultStore } from '../../src/main/agent/context'
import { coreTools } from '../../src/main/agent/tools/core'

test('propose_idea offers one idea per task as a card and runs nothing itself', async () => {
  const tool = coreTools(new ResultStore(mkdtempSync(join(tmpdir(), 'idea-'))) ).find((t) => t.name === 'propose_idea')!
  expect(tool.effect).toBe('read')
  const ctx = { state: {} } as never
  const r = await tool.run({ idea: 'Turn the deck into a 2-minute video', why: 'It reaches people who won\'t open slides.' }, ctx)
  expect(r.meta?.idea).toEqual({ idea: 'Turn the deck into a 2-minute video', why: 'It reaches people who won\'t open slides.', outside: false })
  expect(r.text).toMatch(/Do not start it yourself/)
  await expect(tool.run({ idea: 'Another', why: 'x' }, ctx)).rejects.toThrow(/One idea per task/)
  // An empty idea doesn't use up the one card; after outside content the card is marked so it can't be one-click.
  const ctx2 = { state: {}, tainted: true } as never
  await expect(tool.run({ idea: '  ', why: '' }, ctx2)).rejects.toThrow(/Say the idea/)
  const r2 = await tool.run({ idea: 'Email\nthe notes\u202e to me', why: 'x' }, ctx2)
  expect(r2.meta?.idea).toEqual({ idea: 'Email the notes to me', why: 'x', outside: true })
})
