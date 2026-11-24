import { parseHTML } from 'linkedom'
import { beforeAll, describe, expect, test } from 'vitest'
import { isGenericStop, isNamedStop, isStopAll, isStopRequest, namesMatch, stopTarget } from '../../src/main/agent/stop-intent'
import { isAside, quickMath } from '../../src/main/agent/aside'
import { plainProgress, plainStep } from '../../src/shared/step-words'
import { folderName, madeText, runFacts, showsFinishLine, statusLine, took } from '../../src/renderer/src/lib/run-summary'
import { fname } from '../../src/renderer/src/lib/steps'
import { queueWords, stopWords } from '../../src/renderer/src/lib/queue-words'
import type { Message } from '../../src/shared/types'

type TV = typeof import('../../src/renderer/src/components/ThreadView')
let doingPlain: TV['doingPlain'], stallText: TV['stallText'], workLabel: TV['workLabel']
beforeAll(async () => {
  // The renderer expects a browser: a DOM and the preload's api object.
  const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
  const g = globalThis as Record<string, unknown>
  g.window = Object.assign(window, { foreman: {} })
  g.document = document
  ;({ doingPlain, stallText, workLabel } = await import('../../src/renderer/src/components/ThreadView'))
})

// The words people use to control a task mid-way (report MCC-02, acceptance "Stop by words"), the one working line
// (MCD-01: never paths, commands or tool names), and the finish line (MCD-04: what was made, where, how long).

describe('stop by words', () => {
  test('"Stop Test 5 now" and its kin are stops of the task at hand', () => {
    for (const t of ['Stop Test 5 now', 'stop test 5', 'Cancel test 5', 'stop the trip plan', 'Stop the invoice', 'stop working on that', 'stop "Test 5" please'])
      expect(isNamedStop(t, ['Test 5', 'Test 5: plan the trip']), t).toBe(true)
    expect(stopTarget('Stop Test 5 now')).toBe('test 5')
    expect(stopTarget('cancel the trip plan')).toBe('trip plan')
    expect(isGenericStop('test 5')).toBe(true)
  })
  test('a stop that names a chat matches its title or task, whole words only', () => {
    expect(namesMatch('acme invoice', ['Invoice', 'Make the Acme invoice for March'])).toBe(true)
    expect(namesMatch('test 5', ['Test 50'])).toBe(false)
    expect(namesMatch('it', ['it'])).toBe(false)
  })
  test('steering and requests that mention stopping are not stops', () => {
    for (const t of ['stop using commas', 'cancel the 3pm meeting', 'stop at the first result and summarize', 'stop the server on port 3000', 'cancel my reminder', 'stop asking me questions', 'end it with a joke', 'bus stop near me', ''])
      expect(isNamedStop(t, ['Trip']), t).toBe(false)
  })
  test('"stop everything" means every task', () => {
    for (const t of ['Stop everything', 'stop all tasks', 'cancel all of them', 'stop every task now', 'please stop everything!'])
      expect(isStopAll(t), t).toBe(true)
    for (const t of ['stop', 'stop it', 'stop all of it', 'stop using everything you found'])
      expect(isStopAll(t), t).toBe(false)
    expect(isStopRequest('stop all of it')).toBe(true)
  })
})

describe('side questions', () => {
  test('arithmetic without a "?" is answered at once, beside the job', () => {
    expect(isAside('18% of $1,740')).toBe(true)
    expect(quickMath('18% of $1,740')).toBe('18% of $1,740 = $313.20.')
    expect(isAside('add prices to the list')).toBe(false)
  })
})

describe('the working line in plain words', () => {
  const step = (name: string, args: Record<string, unknown>) => ({ call: { id: 'c', name, arguments: JSON.stringify(args) }, at: 0 })
  const leaks = /[/\\~]|\$ |_|mcp|python3|\.py\b|sahil/i
  test('no command, path or tool name reaches it', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['run_command', { command: 'python3 /Users/sahil/Downloads/rename_photos.py' }], ['run_command', { command: 'pytest -q' }],
      ['mcp__sb_mac_apps__reminders_list', {}], ['mcp__gmail__search', { q: 'x' }], ['schedule', {}], ['manage_bot', {}], ['api_request', { url: 'https://x' }],
      ['undo_changes', {}], ['chat_history', {}], ['gmail_imap', {}], ['file_write', { path: '/Users/sahil/Downloads/inv.pdf' }], ['some_new_tool', {}],
      ['browser', { action: 'navigate', url: 'https://example.com/a/b' }], ['mac_apps', { action: 'reminders_add' }]
    ]
    for (const [name, args] of cases) {
      const w = plainStep(name, args)
      expect(w, name).not.toMatch(leaks)
      expect(doingPlain(step(name, args) as never), name).toBe(w)
    }
    expect(plainStep('run_command', { command: 'python3 x.py' })).toBe('Running the script')
    expect(plainStep('run_command', { command: 'npx vitest run' })).toBe('Testing the work')
    expect(plainStep('mcp__gmail__search', {})).toBe('Working in Gmail')
    expect(plainStep('mac_apps', { action: 'reminders_add' })).toBe('Checking Reminders')
  })
  test('raw progress is never shown; plain notes are', () => {
    expect(plainProgress('$ npm test', 'code')).toBe(false)
    expect(plainProgress('PASS src/a.test.ts', 'run_command')).toBe(false)
    expect(plainProgress('Saved /Users/sahil/x.txt')).toBe(false)
    expect(plainProgress('Generating the image')).toBe(true)
    expect(workLabel({ progress: 'collected 12 items in /tmp/x', progressTool: 'run_command', doing: 'Testing the work' })).toBe('Testing the work')
    expect(workLabel({ progress: 'Generating the image', progressTool: 'generate_image', doing: 'Making the image' })).toBe('Generating the image')
    // The plan step is the steadiest wording.
    expect(workLabel({ plan: 'Find hotels under 150 dollars', progress: 'Generating the image', doing: 'Reading a page' })).toBe('Find hotels under 150 dollars')
  })
  test('a stall says what it works on and what is stuck', () => {
    const stall = { text: 'Still on it: reading a page is taking longer than usual (1 min). Retry it, skip it, or keep waiting.', tool: 'watchdog', step: 'Reading a page', stuck: true }
    expect(stallText({ who: 'Trip Bot', label: 'Find hotels', stall })).toBe('Still working on find hotels: reading a page is taking longer than usual')
    expect(stallText({ who: 'Trip Bot', label: 'Reading a page', stall })).toBe('Still on it: reading a page is taking longer than usual')
    expect(stallText({ who: 'Trip Bot', label: 'x', stall: { text: 'Still on it: waiting for you to unlock your vault (Touch ID or your password).', tool: 'watchdog' } })).toMatch(/^Trip Bot is waiting for you to unlock your vault/)
    expect(stallText({ who: 'x', stall: { text: 'Generating', tool: 'generate_image' } })).toBeNull()
  })
  test('a file in the home folder never shows the username', () => {
    expect(fname('/Users/sahil/notes.txt')).toBe('notes.txt')
    expect(fname('/Users/sahil/Downloads')).toBe('Downloads')
    expect(folderName('/Users/sahil/notes.txt')).toBe('your home folder')
    expect(folderName('/Users/sahil/Downloads/inv.pdf')).toBe('Downloads')
  })
})

describe('the finish line', () => {
  let n = 0
  const msg = (p: Partial<Message>): Message => ({ id: `m${++n}`, threadId: 't', role: 'tool', kind: 'normal', status: 'done', content: '', createdAt: 0, ...p } as Message)
  const tool = (name: string, args: Record<string, unknown>, at: number, meta: Record<string, unknown> = {}) => msg({ role: 'tool', toolName: name, createdAt: at, meta: { status: 'ok', args: JSON.stringify(args), ...meta } })
  test('what was made, where, how long', () => {
    const ms = [
      msg({ role: 'user', content: 'make the invoice', createdAt: 1000 }),
      tool('file_write', { path: '/Users/sahil/Downloads/invoice.pdf' }, 2000, { path: '/Users/sahil/Downloads/invoice.pdf' }),
      msg({ role: 'user', content: '18% of $1,740', createdAt: 3000, meta: { aside: true } }),
      msg({ role: 'assistant', content: '18% of $1,740 = $313.20.', createdAt: 3100, meta: { aside: true } }),
      msg({ role: 'assistant', content: 'Made it.', createdAt: 73_000 })
    ]
    const f = runFacts(ms)!
    // The side question didn't start a new run: the file still counts.
    expect(f.made).toEqual(['/Users/sahil/Downloads/invoice.pdf'])
    expect(madeText(f)).toBe('Made invoice.pdf in Downloads')
    expect(statusLine(f, { input: 10, output: 5, usd: 0.02, cloud: true, calls: 1, models: [] }, { simple: true })).toBe('Done in 1 min 12 s · Made invoice.pdf in Downloads')
    expect(took(40_000)).toBe('40 s')
    expect(took(3_900_000)).toBe('1 h 5 min')
  })
  test('a stopped task never says "Done"', () => {
    const ms = [
      msg({ role: 'user', content: 'research printers', createdAt: 0 }),
      tool('web_search', { query: 'printers' }, 1000),
      msg({ role: 'user', content: 'stop', createdAt: 2000, meta: { steer: true, stopRequest: true } }),
      msg({ role: 'assistant', content: 'Stopped.', createdAt: 2100, meta: { stopped: true } })
    ]
    const f = runFacts(ms)!
    expect(f.stopped).toBe(true)
    expect(f.actions).toBe(1)
    expect(statusLine(f, null)).toBe('')
    expect(statusLine({ ...f, paths: ['/w/a.md'], made: ['/w/a.md'], ms: 5000 }, null)).toBe('Stopped after 5 s · Made a.md in w')
  })
  test('"Stop everything" typed in an idle chat leaves its last task alone', () => {
    const done = [
      msg({ role: 'user', content: 'make the invoice', createdAt: 0 }),
      tool('file_write', { path: '/Users/sahil/Downloads/invoice.pdf' }, 1000, { path: '/Users/sahil/Downloads/invoice.pdf' }),
      msg({ role: 'assistant', content: 'Made it.', createdAt: 48_000 })
    ]
    expect(statusLine(runFacts(done)!, null, { simple: true })).toBe('Done in 48 s · Made invoice.pdf in Downloads')
    const ms = [...done,
      msg({ role: 'user', content: 'Stop everything', createdAt: 1_800_000, meta: { stopRequest: true } }),
      msg({ role: 'assistant', content: 'Stopped Trip plan.', createdAt: 1_800_100, meta: { stopNote: true } })]
    // Its own turn: no "Stopped after 30 min" on the invoice, and nothing to finish-line under the note.
    expect(runFacts(ms)).toBeNull()
  })
  test('a bot chat gets the finish line for real work, not only when a file was made', () => {
    const f = { commands: 0, files: 0, jobs: 0, actions: 14, since: 0, until: 0, paths: [], made: [], ms: 180_000 }
    expect(showsFinishLine(f, { simple: true, onlyMade: true })).toBe(true)
    expect(statusLine(f, null, { simple: true })).toBe('Done in 3 min · 14 actions')
    expect(showsFinishLine({ ...f, actions: 1 }, { simple: true, onlyMade: true })).toBe(false)
    expect(showsFinishLine({ ...f, actions: 1, paths: ['/w/a.md'] }, { simple: true, onlyMade: true })).toBe(true)
    expect(showsFinishLine({ ...f, actions: 0 }, { simple: true })).toBe(false)
  })
})

describe('queue by words', () => {
  test('"when you\'re done, also…" waits for the task', () => {
    for (const t of ['When you\'re done, also make a PDF', 'after that, email it to me', 'once you’re finished send it to Sam', 'Also, when you are done, add a cover'.replace(/^Also, /, '')])
      expect(queueWords(t), t).toBe(true)
    for (const t of ['make it 4 printers', 'what\'s done so far?', 'stop'])
      expect(queueWords(t), t).toBe(false)
  })
  test('a typed stop under an open question card stops; other text answers the card', () => {
    for (const t of ['Stop Test 5 now', 'stop', 'Stop everything', 'cancel the trip plan', 'stop the invoice'])
      expect(stopWords(t, 'Invoice for Acme'), t).toBe(true)
    for (const t of ['stop using commas', 'Make it shorter', 'cancel the 3pm meeting', 'stop the music'])
      expect(stopWords(t, 'Invoice for Acme'), t).toBe(false)
  })
})
