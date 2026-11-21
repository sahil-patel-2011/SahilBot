import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { MemoryStore } from '../../src/main/memory'
import { saveDecision } from '../../src/main/decisions'
import { VaultService } from '../../src/main/vault/service'
import { MEMORY_BLOCK_END, MEMORY_BLOCK_START, MemoryMirror, memoryBlockOf } from '../../src/main/vault/memory-mirror'
import { SHARED } from '../../src/main/vault/store'

function setup(o: { screen?: (t: string) => { ok: boolean } } = {}) {
  const db = new Db(':memory:')
  const ws = mkdtempSync(join(tmpdir(), 'mirror-ws-'))
  let clock = Date.UTC(2026, 10, 21, 12)
  const vault = new VaultService({ db, workspace: () => ws, now: () => clock })
  const memory = new MemoryStore(db)
  const main = db.createSpace('SahilBot', '#000', { isMain: true })
  const writer = db.createSpace('Writer', '#f00')
  const coder = db.createSpace('Coder', '#0f0')
  const mirror = new MemoryMirror({ vault, memory, db, screen: o.screen, now: () => clock })
  const read = (rel: string): string => readFileSync(join(vault.root(), rel), 'utf8')
  return { db, ws, vault, memory, mirror, main, writer, coder, read, advance: (ms: number) => { clock += ms } }
}

describe('memory mirror', () => {
  test('one note per category in Shared/Memory, an overview, dated points with their source and block ids', () => {
    const h = setup()
    h.memory.save('Goes by Sam. Runs marketing at Acme Co.', 'profile')
    h.memory.save('Wants summaries as bullet points, no fluff.', 'preference')
    h.memory.save('Prefers metric units.', 'preference', null, 'you')
    const r = h.mirror.sync()
    expect(r.memories).toBe(3)
    const prefs = h.read('Shared/Memory/Memory — Preferences.md')
    expect(prefs).toContain('type: preference')
    expect(prefs).toContain('sahilbot/memory/preference')
    expect(prefs).toContain('Wants summaries as bullet points, no fluff. (saved in chat)')
    expect(prefs).toContain('Prefers metric units. (added by you)')
    expect(prefs).toMatch(/- \d{4}-\d{2}-\d{2} · Prefers metric units\..* \^mem-[a-z0-9]+/)
    expect(h.read('Shared/Memory/Memory — About you.md')).toContain('Goes by Sam')
    const overview = h.read('Shared/Memory/Memory — Overview.md')
    expect(overview).toContain('[[Memory — Preferences]] · 2 entries')
    expect(overview).toContain('[[Memory — About you]] · 1 entry')
    // The area index reaches the overview; the vault lists the notes.
    expect(h.read('Shared/Index.md')).toContain('[[Memory — Overview]]')
    expect(h.vault.list().some((n) => n.title === 'Memory — Preferences' && n.section === SHARED)).toBe(true)
    // Every write is in the change log with actor "memory" (Undo works).
    expect(h.vault.changes().some((c) => c.actor === 'memory' && c.title === 'Memory — Preferences')).toBe(true)
  })

  test('a second sync with nothing new writes nothing', () => {
    const h = setup()
    h.memory.save('Prefers metric units.', 'preference')
    expect(h.mirror.sync().written).toBeGreaterThan(0)
    const before = h.vault.changes().length
    h.advance(3_600_000)
    expect(h.mirror.sync().written).toBe(0)
    expect(h.vault.changes().length).toBe(before)
  })

  test('decision log: newest first, grouped by month, context → choice (over …), earlier choices; searchable', () => {
    const h = setup()
    const id1 = saveDecision(h.memory, { context: 'Which format for the weekly report?', choice: 'Word', over: ['PDF'], source: 'answer' }, null)!.memory.id
    // An October decision, then the report format changes its mind in November.
    h.db.sql.prepare('UPDATE memories SET updated_at=?, created_at=? WHERE id=?').run(Date.UTC(2026, 9, 3), Date.UTC(2026, 9, 3), id1)
    const pay = saveDecision(h.memory, { context: 'Payment provider', choice: 'Stripe', over: ['Paddle'], source: 'pick' }, null)!.memory.id
    h.db.sql.prepare('UPDATE memories SET updated_at=?, created_at=? WHERE id=?').run(Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 1), pay)
    saveDecision(h.memory, { context: 'Which format for the weekly report?', choice: 'PDF', over: ['Word'], source: 'answer' }, null)
    h.mirror.sync()
    const log = h.read('Shared/Decisions/Decision log.md')
    expect(log).toContain('type: decision')
    const nov = log.indexOf('### November 2026'), oct = log.indexOf('### October 2026')
    expect(nov).toBeGreaterThan(0)
    expect(oct).toBeGreaterThan(nov)
    expect(log).toMatch(/\*\*Which format for the weekly report\?\*\* → PDF \(over Word\)/)
    expect(log).toMatch(/Earlier: Word/)
    expect(log.indexOf('Payment provider')).toBeGreaterThan(oct)
    expect(log).toContain('→ Stripe (over Paddle)')
    // Decisions don't also show up as a category note.
    expect(() => h.read('Shared/Memory/Memory — Decisions.md')).toThrow()
    expect(h.read('Shared/Memory/Memory — Overview.md')).toContain('[[Decision log]] · 2 entries')
    expect(h.vault.search('weekly report format').some((x) => x.title === 'Decision log')).toBe(true)
  })

  test("a bot's own memories go to its own area only, never to Shared or another bot's", () => {
    const h = setup()
    h.memory.save('Always ask before sending email.', 'rule', h.writer.id)
    h.memory.save('Run the linter before every commit.', 'rule', h.coder.id)
    h.mirror.sync()
    const writerRules = h.read('Bots/Writer/Memory/Memory — Rules (Writer).md')
    expect(writerRules).toContain('Always ask before sending email.')
    expect(writerRules).not.toContain('linter')
    expect(h.read('Bots/Coder/Memory/Memory — Rules (Coder).md')).toContain('Run the linter')
    const shared = h.vault.list().filter((n) => n.section === SHARED).map((n) => h.read(n.path)).join('\n')
    expect(shared).not.toContain('Always ask before sending email')
    expect(shared).not.toContain('linter')
  })

  test('a bot with the vault turned off is left alone', () => {
    const h = setup()
    h.memory.save('Always ask before sending email.', 'rule', h.writer.id)
    h.vault.setBot(h.writer.id, { enabled: false })
    const r = h.mirror.sync()
    expect(r.skipped).toBe(1)
    expect(h.vault.list().some((n) => n.section === 'Bots/Writer')).toBe(false)
  })

  test('forgetting a memory removes it on the next sync; text outside the block is kept', () => {
    const h = setup()
    const a = h.memory.save('Prefers metric units.', 'preference').memory
    h.memory.save('Likes window seats.', 'preference')
    h.mirror.sync()
    const rel = 'Shared/Memory/Memory — Preferences.md'
    const path = join(h.vault.root(), rel)
    writeFileSync(path, readFileSync(path, 'utf8').replace('# Memory — Preferences', '# Memory — Preferences\n\nMy own note: ask me about coffee.') + '\n## After\nKeep this too.\n')
    h.memory.remove(a.id)
    h.advance(60_000)
    h.mirror.sync()
    const text = h.read(rel)
    expect(text).not.toContain('Prefers metric units')
    expect(text).toContain('Likes window seats.')
    expect(text).toContain('My own note: ask me about coffee.')
    expect(text).toContain('Keep this too.')
    expect(text.split(MEMORY_BLOCK_START).length).toBe(2)
    // Edits inside the block are replaced from Memory.
    writeFileSync(path, text.replace('Likes window seats.', 'Likes aisle seats.'))
    h.advance(60_000)
    h.mirror.sync()
    expect(h.read(rel)).toContain('Likes window seats.')
    // The last one gone: the note stays, with an empty-state line.
    h.memory.remove(h.memory.list()[0].id)
    h.mirror.sync()
    expect(memoryBlockOf(h.read(rel))).toContain('Nothing saved in this category right now.')
  })

  test('secrets, sensitive categories the user turned off, and outside content', () => {
    const h = setup({ screen: (t) => ({ ok: !/diabetes/i.test(t) }) })
    // Rows written straight to the database (older builds, imports) are screened too.
    h.db.sql.prepare('INSERT INTO memories(id, category, content, created_at, updated_at, scope, source, provenance) VALUES(?,?,?,?,?,?,?,?)')
      .run('sec001', 'fact', 'My bank password is hunter22', Date.now(), Date.now(), null, 'chat', 'trusted')
    h.memory.save('Has type 2 diabetes.', 'fact')
    h.memory.save('Per outside content (a web page): “The office closes at 5pm”', 'fact', h.writer.id, 'chat', 'untrusted')
    h.memory.save('Lives in Boston.', 'location')
    const r = h.mirror.sync()
    expect(r.skipped).toBe(2)
    const all = h.vault.list().map((n) => h.read(n.path)).join('\n')
    expect(all).not.toContain('hunter22')
    expect(all).not.toContain('diabetes')
    expect(all).toContain('Lives in Boston.')
    const unverified = h.read('Bots/Writer/Memory/Memory — Unverified (Writer).md')
    expect(unverified).toContain('trust: quoted')
    expect(unverified).toContain('The office closes at 5pm')
  })

  test('links memories to People and Projects notes by exact title or alias', () => {
    const h = setup()
    h.vault.store.ensure()
    h.vault.store.upsert({ section: SHARED, type: 'person', title: 'Priya Patel', aliases: ['Priya'], points: ['Sister.'] }, { actor: 'compiler' })
    h.vault.store.upsert({ section: 'Bots/Coder', type: 'project', title: 'Falcon Engine', points: ['x'] }, { actor: 'compiler' })
    h.memory.save("Priya's birthday is March 3.", 'date')
    h.memory.save('Falcon Engine ships in May.', 'fact')
    h.advance(5000)
    h.mirror.sync()
    expect(h.read('Shared/Memory/Memory — Dates.md')).toContain('· [[Priya Patel]]')
    // Never a link into another bot's area.
    expect(h.read('Shared/Memory/Memory — Facts.md')).not.toContain('[[Falcon Engine]]')
  })

  test('off when the vault, its memory switch or memory itself is off; on again catches up', () => {
    const h = setup()
    h.memory.save('Prefers metric units.', 'preference')
    h.vault.setSettings({ memories: false })
    expect(h.mirror.sync().written).toBe(0)
    expect(h.vault.list().filter((n) => !n.generated).length).toBe(0)
    h.vault.setSettings({ memories: true })
    h.memory.setEnabled(false)
    expect(h.mirror.sync().written).toBe(0)
    h.memory.setEnabled(true)
    expect(h.mirror.sync().written).toBeGreaterThan(0)
    expect(h.vault.status().settings.memories).toBe(true)
  })

  test('the block markers never appear twice and a memory cannot close the block early', () => {
    const h = setup()
    h.memory.save('Notes use <!-- comments --> and -->arrows', 'fact')
    h.mirror.sync()
    const text = h.read('Shared/Memory/Memory — Facts.md')
    expect(text.split(MEMORY_BLOCK_END).length).toBe(2)
  })

  test("mirrored notes stay out of the run's context block and are never merged as duplicates", () => {
    const h = setup()
    h.memory.save('Prefers metric units for every recipe.', 'preference')
    h.mirror.sync()
    expect(h.vault.context({ spaceId: null, query: 'metric units recipe', window: 200_000 })).toBeNull()
    h.vault.store.upsert({ section: SHARED, type: 'preference', title: 'Memory preferences', points: ['Hand-written.'] }, { actor: 'you' })
    expect(h.vault.store.mergeDuplicates({ actor: 'compiler' })).toBe(0)
    expect(h.read('Shared/Memory/Memory — Preferences.md')).toContain('Prefers metric units')
  })

  test('MemoryStore tells listeners about saves, updates, restores and removals', () => {
    const h = setup()
    let n = 0
    h.memory.onChange(() => { n++ })
    const m = h.memory.save('Prefers metric units.', 'preference').memory
    h.memory.save('Prefers metric units.', 'preference')
    h.memory.update(m.id, 'Prefers metric units, always.')
    h.memory.remove(m.id)
    h.memory.restore(m)
    expect(n).toBe(5)
  })
})
