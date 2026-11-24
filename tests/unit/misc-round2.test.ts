import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { harnessPrompt } from '../../src/main/agent/prompt'
import { chatHistoryTool } from '../../src/main/agent/tools/chat-history'
import { computerTool } from '../../src/main/agent/tools/computer'
import { coreTools } from '../../src/main/agent/tools/core'
import { formatEvents } from '../../src/main/agent/tools/apps'
import { memoryTool } from '../../src/main/agent/tools/memory'
import { botWall, isChallengePage, keyless, webTools } from '../../src/main/agent/tools/web'
import { ResultStore } from '../../src/main/agent/context'
import type { ToolContext, ToolDef } from '../../src/main/agent/types'
import { calendarItems } from '../../src/main/brain/sources'
import { appTool } from '../../src/main/computer/apps/tool'
import { WINDOWS } from '../../src/main/computer/scripts'
import { ContextEngine } from '../../src/main/context-engine/service'
import { askOnlyCategories, categoriesOf } from '../../src/main/context-engine/sensitive'
import { Db } from '../../src/main/db'
import { vetCandidate, type MemoryCandidate } from '../../src/main/learning/extract'
import { MemoryStore } from '../../src/main/memory'
import { Scheduler } from '../../src/main/scheduler'
import { DEFAULT_CONTEXT_ENGINE } from '../../src/shared/context-engine'

// Round-2 review fixes: memory (sensitive details the idle learners keep, "forget my address", what the bot lists as
// remembered, chat_history recall), research (blocked search engines, bot walls, chips), desktop control (the
// Accessibility card), connectors (connect_app, the Mac calendar, event routines).

afterEach(() => { vi.unstubAllGlobals() })

const cand = (fact: string, evidence: string, kind: MemoryCandidate['kind'] = 'profile'): MemoryCandidate => ({ fact, kind, about: 'user', evidence })
const vet = (c: MemoryCandidate, userText: string, extra: Partial<Parameters<typeof vetCandidate>[1]> = {}) =>
  vetCandidate(c, { userText, origin: 'user', existing: [], canHoldBotRules: true, ...extra })

test('the idle learner keeps health, money, ID, faith, politics and sexuality only when the user asked to remember', () => {
  expect(vet(cand('User has ADHD.', 'I have ADHD'), 'I have ADHD so lists help me').ok).toBe(false)
  expect(vet(cand('User has ADHD.', 'I have ADHD'), 'I have ADHD so lists help me').why).toBe('sensitive')
  expect(vet(cand('User has ADHD.', 'remember that I have ADHD'), 'remember that I have ADHD').ok).toBe(true)
  // The "remember" can be elsewhere in the same message.
  expect(vet(cand('User has ADHD.', 'I have ADHD'), 'Please remember this: I have ADHD').ok).toBe(true)
  for (const [fact, ev] of [['User takes 20mg Lexapro daily.', 'I take 20mg Lexapro daily'], ['User\'s passport expires in May 2027.', 'my passport expires in May 2027'], ['User is gay.', 'I am gay'], ['User votes Democrat.', 'I vote Democrat'], ['User earns $140k a year.', 'I earn $140k a year']] as const) {
    expect(vet(cand(fact, ev), ev).ok, fact).toBe(false)
  }
  // Allergies and diet are safety facts: kept on their own.
  expect(vet(cand('User is allergic to peanuts.', 'I am allergic to peanuts'), 'I am allergic to peanuts').ok).toBe(true)
  expect(vet(cand('User is vegetarian.', 'I am vegetarian'), 'I am vegetarian').ok).toBe(true)
  expect(askOnlyCategories('User is allergic to peanuts.')).toEqual([])
  expect(askOnlyCategories('User has diabetes and a peanut allergy.')).toEqual(['health'])
  // A category the user turned off (Privacy) is never learned, even when asked.
  const off = { ...DEFAULT_CONTEXT_ENGINE.sensitive, health: false }
  expect(vet(cand('User is allergic to peanuts.', 'remember I am allergic to peanuts'), 'remember I am allergic to peanuts', { optins: off }).ok).toBe(false)
  // Everyday facts are untouched.
  expect(vet(cand('User lives in Austin.', 'I live in Austin', 'location'), 'I live in Austin').ok).toBe(true)
})

test('salary in everyday words is money', () => {
  expect(categoriesOf('User earns $140k a year.')).toContain('finance')
  expect(categoriesOf('I make $95,000 a year')).toContain('finance')
  expect(categoriesOf('She makes 3 cakes a week')).not.toContain('finance')
  expect(categoriesOf('He earns 5 points per level')).not.toContain('finance')
})

function engineSetup() {
  const db = new Db(':memory:')
  const memory = new MemoryStore(db)
  const ws = mkdtempSync(join(tmpdir(), 'ce-ws-'))
  let clock = Date.parse('2026-11-24T10:00:00Z')
  const engine = new ContextEngine({ db, memory, workspace: () => ws, now: () => clock })
  const main = db.createSpace('SahilBot', '#000', { isMain: true })
  const hooks = () => ({ async ask() { return '{"entities":[]}' }, check() {}, now: () => clock })
  return { db, memory, engine, main, hooks, advance: (ms: number) => { clock += ms }, at: () => clock }
}

test('People & Places keeps a chat\'s health details only when the user asked to remember them', async () => {
  const reply = JSON.stringify({ entities: [{ type: 'person', name: 'Raj Patel', facts: [
    { key: 'condition', value: 'diabetes', from: 'user', evidence: 'Raj Patel was diagnosed with diabetes' },
    { key: 'likes', value: 'cricket', from: 'user', evidence: 'Raj loves cricket' },
    { key: 'allergy', value: 'peanuts', from: 'user', evidence: 'Raj is allergic to peanuts' }] }] })
  const learn = async (text: string): Promise<string> => {
    const h = engineSetup()
    const t = h.db.createThread(h.main.id, 'auto', null)
    h.db.insertMessage({ threadId: t.id, role: 'user', content: text, kind: 'normal', status: 'done', createdAt: h.at() } as never)
    h.advance(3 * 60_000)
    await h.engine.learn({ ...h.hooks(), ask: async () => reply })
    return JSON.stringify(h.engine.store.exportAll())
  }
  const said = await learn('My brother Raj Patel was diagnosed with diabetes. Raj loves cricket. Raj is allergic to peanuts.')
  expect(said).toMatch(/cricket/)
  expect(said).toMatch(/peanuts/)
  expect(said).not.toMatch(/diabetes/)
  expect(await learn('Remember this: my brother Raj Patel was diagnosed with diabetes. Raj loves cricket. Raj is allergic to peanuts.')).toMatch(/diabetes/)
})

test('"forget my address" also removes it from the user\'s People & Places card', async () => {
  const h = engineSetup()
  h.engine.remember({ name: 'me', key: 'address', value: '42 Oak St', spaceId: null, tainted: false })
  h.memory.save('Lives at 42 Oak St', 'location', null)
  const user = h.engine.store.entities({ type: 'person' }).find((e) => e.isUser)!
  expect(h.engine.store.attributes(user.id).map((a) => a.key)).toContain('address')
  const space = h.db.createSpace('Coach', '#000')
  const thread = h.db.createThread(space.id, 'auto', null)
  const tool = memoryTool(h.memory, h.db, undefined, undefined, () => h.engine)
  const r = await tool.run({ action: 'forget', query: 'my address' }, { threadId: thread.id } as ToolContext)
  expect(r.text).toMatch(/Forgot "Lives at 42 Oak St"/)
  expect(r.text).toMatch(/Also removed from People & Places/)
  expect(h.engine.store.attributes(user.id).map((a) => a.key)).not.toContain('address')
  expect(JSON.stringify(h.engine.store.exportAll())).not.toMatch(/42 Oak St/)
  // Nothing in memory, only on the card: still removed.
  h.engine.remember({ name: 'me', key: 'birthday', value: 'March 3', spaceId: null, tainted: false })
  const b = await tool.run({ action: 'forget', query: 'my birthday' }, { threadId: thread.id } as ToolContext)
  expect(b.text).toMatch(/Removed it from People & Places/)
  expect(h.engine.store.attributes(user.id).map((a) => a.key)).not.toContain('birthday')
})

test('"what do you remember about me" leaves out the work log', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Coach', '#000')
  const t = db.createThread(space.id, 'auto', null)
  const memory = new MemoryStore(db)
  memory.save('Prefers metric units', 'preference', null)
  for (let i = 1; i <= 3; i++) memory.save(`2026-11-2${i}: routine "Atlanta weather" ran → 54°F`, 'worklog', space.id)
  const tool = memoryTool(memory, db)
  const r = await tool.run({ action: 'list' }, { threadId: t.id } as ToolContext)
  expect(r.text).not.toMatch(/Work log:/)
  expect(r.text).not.toMatch(/Atlanta weather/)
  expect(r.text).toMatch(/Prefers metric units/)
  expect(r.text).toMatch(/3 work-log entries not shown/)
  // Asked for the bot's own record: shown.
  expect((await tool.run({ action: 'list', scope: 'bot' }, { threadId: t.id } as ToolContext)).text).toMatch(/Work log:/)
})

test('chat_history finds an earlier message worded differently from the search', async () => {
  const db = new Db(':memory:')
  const t = db.createThread(db.createSpace('Bot', '#000').id, 'auto', null)
  db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: 'my landlord is Mike, mike@acme.com' })
  db.insertMessage({ threadId: t.id, role: 'assistant', kind: 'normal', status: 'done', content: 'Got it.' })
  db.insertMessage({ threadId: t.id, role: 'user', kind: 'normal', status: 'done', content: 'what is the weather today' })
  const r = await chatHistoryTool(db).run({ action: 'search', query: 'landlord email' }, { threadId: t.id } as ToolContext)
  const hits = r.data as Array<{ passage: string }>
  expect(hits[0].passage).toMatch(/landlord is Mike/)
  expect(hits.some((h) => /weather/.test(h.passage))).toBe(false)
  // The exact phrase still comes first.
  const exact = await chatHistoryTool(db).run({ action: 'search', query: 'weather today' }, { threadId: t.id } as ToolContext)
  expect((exact.data as Array<{ passage: string }>)[0].passage).toMatch(/weather today/)
})

test('the skills section never invites saving a skill mid-task; research answers always end with numbered Sources', () => {
  const p = harnessPrompt({ userName: 'Sam', workspaceDir: '/tmp', spacePrompt: '', spaceName: 'SahilBot', skills: '- invoice: making an invoice' })
  expect(p).not.toMatch(/improve it with memory\(action="save_skill"\)/)
  expect(p).toMatch(/Don't save or change skills during a task/)
  expect(p).toMatch(/always end with "Sources:"/)
})

test('a blocked search engine is not "no results"', async () => {
  const challenge = '<html><body><div class="anomaly-modal">Unfortunately, bots use DuckDuckGo too.</div></body></html>'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(challenge, { status: 202 })))
  await expect(keyless('weather atlanta', 6, new AbortController().signal)).rejects.toThrow(/isn't reachable/)
  // A real, empty results page from one engine: no results.
  let n = 0
  vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0 ? new Response(challenge, { status: 202 }) : new Response('<html><body><ul class="results"></ul></body></html>', { status: 200 }))))
  await expect(keyless('xyzzy plugh', 6, new AbortController().signal)).resolves.toEqual([])
})

test('bot-wall detection: a short real page is a page; a 503 may be an outage', () => {
  expect(isChallengePage('Just a moment...', 'Checking your browser before accessing the site.')).toBe(true)
  expect(isChallengePage('Example', 'Access denied. Please verify you are a human.')).toBe(true)
  const article = `How to fix "Access denied" errors in Windows\n${'When Windows says access denied, the account usually lacks permission on the folder. Open Properties, then Security, and give your account Full control; then try again and the error goes away for good. '.repeat(2)}`
  expect(article.length).toBeLessThan(1500)
  expect(isChallengePage('Fixing access denied', article)).toBe(false)
  expect(botWall('https://www.example.com/x', 'HTTP 503')).toMatch(/unavailable or blocking automated reading/)
  expect(botWall('https://www.example.com/x', 'HTTP 403')).toMatch(/bot wall/)
})

test('web_search gives a chip for every numbered result it returns', async () => {
  const html = `<html><body>${Array.from({ length: 6 }, (_, i) => `<div class="result"><a class="result__a" href="https://site${i}.example.com/">Result ${i + 1}</a><a class="result__snippet">snippet ${i}</a></div>`).join('')}</body></html>`
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200 })))
  const tools = webTools(() => ({ provider: 'duckduckgo' }) as never) as ToolDef[]
  const search = tools.find((t) => t.name === 'web_search')!
  const r = await search.run({ query: 'x' }, { threadId: 't', signal: new AbortController().signal } as ToolContext)
  expect(r.sources).toHaveLength(6)
})

test('after "Not now" the Accessibility prompt and card are not raised again on every later step of the run', async () => {
  const mac = { prompts: 0, cards: 0 }
  const computer = computerTool({
    enterMini: () => undefined,
    capture: async () => ({ dataUrl: '', width: 1, height: 1 }),
    trusted: (prompt) => { if (prompt) mac.prompts++; return false },
    osa: async (fn) => (fn === WINDOWS ? [] : { app: 'Calculator', pid: 7, windows: [], nodes: [] })
  })
  const ctx = { threadId: 't1', runId: 'run1', signal: new AbortController().signal, state: { roots: [] }, waitForUser: async () => { mac.cards++; return 'Not now' } } as unknown as ToolContext
  await expect(computer.run({ action: 'ui', app: 'Calculator' } as never, ctx)).rejects.toThrow(/Accessibility permission is off/)
  await expect(computer.run({ action: 'ui', app: 'Calculator' } as never, ctx)).rejects.toThrow(/Accessibility permission is off/)
  expect(mac.prompts).toBe(1)
  expect(mac.cards).toBe(1)
  // The user's next message (a new run) asks again.
  await expect(computer.run({ action: 'ui', app: 'Calculator' } as never, { ...ctx, runId: 'run2' } as ToolContext)).rejects.toThrow(/Accessibility/)
  expect(mac.cards).toBe(2)
})

test('the app tool: Accessibility off shows the same card and the step runs again by itself once it is on', async () => {
  let on = false, asked = 0, runs = 0
  const tool = appTool(() => tmpdir(), {
    osa: async () => { runs++; if (!on) throw new Error('execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'); return ['/Users/sam/a.txt'] },
    installed: async () => '/System/Library/CoreServices/Finder.app', running: async () => true, granted: () => true,
    needAccessibility: async () => { asked++; if (on) return false; on = true; return true }
  })
  const ctx = { threadId: 't', signal: new AbortController().signal, state: { roots: [] } } as unknown as ToolContext
  const r = await tool.run({ app: 'Finder', action: 'selection' }, ctx)
  expect(r.text).toMatch(/a\.txt/)
  expect(asked).toBe(1)
  expect(runs).toBe(2)
})

test('connect_app: a connected Google Drive is not Google Calendar', async () => {
  const connect = coreTools(new ResultStore(mkdtempSync(join(tmpdir(), 'res-')))).find((t) => t.name === 'connect_app')!
  const offered: string[] = []
  const drive = [{ name: 'google_drive_search', description: '[Google Drive] Search files', loaded: false, connector: true, group: 'Google Drive' }]
  const ctx = {
    threadId: 't', state: {},
    searchTools: () => drive,
    loadTools: (n: string[]) => n,
    offerConnect: async (app: string) => { offered.push(app); return [{ name: 'gcal_list_events', description: '[Google Calendar] List events', loaded: false, connector: true }] }
  } as unknown as ToolContext
  const r = await connect.run({ app: 'Google Calendar', reason: 'read tomorrow' }, ctx)
  expect(offered).toEqual(['Google Calendar'])
  expect(r.text).toMatch(/gcal_list_events/)
  expect(r.text).not.toMatch(/google_drive_search/)
  // The app asked for is connected: no tile.
  const r2 = await connect.run({ app: 'Google Drive', reason: 'find the deck' }, ctx)
  expect(offered).toHaveLength(1)
  expect(r2.text).toMatch(/google_drive_search/)
})

test('the Mac calendar says when scripting may have missed repeating events, and points to Google Calendar when empty', () => {
  const range = { from: new Date(2026, 10, 25), to: new Date(2026, 10, 26) }
  const one = [{ cal: 'Home', title: 'Dentist', start: new Date(2026, 10, 25, 9).toISOString(), end: new Date(2026, 10, 25, 10).toISOString(), where: '' }]
  expect(formatEvents(one, range, 'calendar')).toMatch(/can miss repeating events/)
  expect(formatEvents(one, range, 'eventkit')).not.toMatch(/repeating/)
  expect(formatEvents([], range, 'eventkit')).toMatch(/Google Calendar, if connected, is read with its own tools/)
})

test('an invite to an event created before the routine still sets off "when someone invites me"', async () => {
  const db = new Db(':memory:')
  const space = db.createSpace('Assistant', '#000')
  const s = new Scheduler(db, async () => 'done', () => undefined)
  const t = s.create({ title: 'Invites', prompt: 'Tell me', schedule: { type: 'when', kind: 'calendar' }, spaceId: space.id })
  const old = new Date(t.createdAt - 10 * 86_400_000).toISOString()
  const later = new Date(t.createdAt + 60_000).toISOString()
  const ev = (self: Record<string, unknown>) => JSON.stringify({ items: [{ id: `e${Math.random()}`, summary: 'Planning', start: { dateTime: '2026-12-03T15:00:00Z' }, created: old, updated: later, attendees: [{ email: 'boss@x.com' }, { email: 'me@x.com', self: true, ...self }] }] })
  const invite = calendarItems('gcal', ev({ responseStatus: 'needsAction' }))
  expect(invite[0].invited).toBe(true)
  expect(s.onItems(invite)).toEqual([t.id])
  await expect.poll(() => s.isRunning(t.id)).toBe(false)
  // An old event the user already accepted, edited later: not new.
  expect(s.onItems(calendarItems('gcal', ev({ responseStatus: 'accepted' })))).toEqual([])
})
