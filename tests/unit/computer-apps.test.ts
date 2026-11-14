import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { afterAll, describe, expect, test } from 'vitest'
import { AX_TEXT, formatAxText } from '../../src/main/computer/apps/ax-text'
import { CHROMIUM_SCRIPTS, jsDisabled, jsHelp, PAGE_TEXT_JS, pickTab, SAFARI_SCRIPTS } from '../../src/main/computer/apps/browsers'
import { cellWrites, formatTable, parseCell, parseRange } from '../../src/main/computer/apps/cells'
import { formatXcode, XCODE_SCRIPTS } from '../../src/main/computer/apps/devtools'
import { FINDER_SCRIPTS } from '../../src/main/computer/apps/finder'
import { IWORK_SCRIPTS, KEYNOTE_SCRIPTS, NUMBERS_SCRIPTS, PAGES_SCRIPTS } from '../../src/main/computer/apps/iwork'
import { MUSIC_SCRIPTS, PLAYER, SPOTIFY_SCRIPTS, spotifyUri } from '../../src/main/computer/apps/media'
import { messageHandle, MESSAGES_SCRIPTS, MESSAGES_SEND } from '../../src/main/computer/apps/messages'
import { EXCEL_SCRIPTS, parseExcelRead, POWERPOINT_SCRIPTS, WORD_SCRIPTS } from '../../src/main/computer/apps/office'
import { PREVIEW_SCRIPTS, sipsArgs } from '../../src/main/computer/apps/preview'
import { ADAPTERS, catalog, consequentialOf, describeCall, effectOf, findAdapter, hardStopOf, helpText, route } from '../../src/main/computer/apps/registry'
import { paneUrl } from '../../src/main/computer/apps/settings'
import { FRONT_TITLE, titleShows } from '../../src/main/computer/apps/slack'
import { appHelpTool, appTool, argsOf, explainError, type AppToolDeps } from '../../src/main/computer/apps/tool'
import { checkArgs, insideRoots, webUrl } from '../../src/main/computer/apps/types'
import { wrap } from '../../src/main/computer/scripts'

// App adapters: routing, effects, argument checks and script generation. No script here runs against a
// real app: JXA sources are compiled by node only, and the tool runs against fakes.

const ws = mkdtempSync(join(tmpdir(), 'sb-apps-'))
afterAll(() => rmSync(ws, { recursive: true, force: true }))
const scope = { roots: [], workspace: ws }

describe('routing', () => {
  test('apps by name, alias or bundle id', () => {
    expect(findAdapter('Finder')?.id).toBe('finder')
    expect(findAdapter('chrome')?.id).toBe('chrome')
    expect(findAdapter('Google Chrome')?.id).toBe('chrome')
    expect(findAdapter('excel')?.id).toBe('excel')
    expect(findAdapter('Microsoft Excel.app')?.id).toBe('excel')
    expect(findAdapter('vs code')?.id).toBe('vscode')
    expect(findAdapter('System Preferences')?.id).toBe('system_settings')
    expect(findAdapter('system_settings')?.id).toBe('system_settings')
    expect(findAdapter('com.apple.iWork.Numbers')?.id).toBe('numbers')
    expect(findAdapter('Photoshop')).toBeUndefined()
  })
  test('unknown apps and actions explain what exists', () => {
    expect((route('Photoshop', 'open') as { error: string }).error).toMatch(/computer use/)
    expect((route('Finder', 'explode') as { error: string }).error).toMatch(/Its actions: open, reveal/)
    expect('adapter' in route('Safari', 'open-url')).toBe(true)
  })
  test('every adapter is complete: ids unique, a skill that ships, every action described', () => {
    const ids = ADAPTERS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of ADAPTERS) {
      expect(existsSync(join('packs/skills', a.skill, 'SKILL.md')), a.skill).toBe(true)
      expect(Object.keys(a.actions).length).toBeGreaterThan(0)
      for (const [id, x] of Object.entries(a.actions)) {
        expect(typeof x.describe({}), `${a.id}.${id}`).toBe('string')
        expect(x.summary.length, `${a.id}.${id}`).toBeGreaterThan(3)
      }
      expect(helpText(a)).toContain(a.name)
    }
    expect(catalog()).toContain('Microsoft PowerPoint')
  })
  test('the skills ship with frontmatter', () => {
    for (const s of ['computer-use-playbook', 'app-finder', 'app-browsers', 'app-office', 'app-iwork', 'app-messages-slack', 'app-media', 'app-dev-tools', 'app-system-settings']) {
      const t = readFileSync(join('packs/skills', s, 'SKILL.md'), 'utf8')
      expect(t, s).toMatch(new RegExp(`^---\\nname: ${s}\\ndescription: .{20,}\\n`))
    }
  })
})

describe('what each call can do (effects and approvals)', () => {
  const inside = join(ws, 'a.txt')
  writeFileSync(inside, 'x')
  mkdirSync(join(ws, 'dest'), { recursive: true })
  writeFileSync(join(ws, 'dest', 'clash.txt'), 'y')
  writeFileSync(join(ws, 'clash.txt'), 'z')

  test('Finder: routine inside the chat\'s folders; outside or replacing asks; the Trash always asks', () => {
    expect(effectOf('Finder', 'move', { paths: [inside], to: join(ws, 'dest') }, scope)).toBe('write_local')
    expect(effectOf('Finder', 'move', { paths: [join(ws, 'clash.txt')], to: join(ws, 'dest') }, scope)).toBe('destructive')
    expect(effectOf('Finder', 'move', { paths: [inside], to: '/etc' }, scope)).toBe('destructive')
    expect(effectOf('Finder', 'move', { paths: ['/etc/hosts'], to: join(ws, 'dest') }, scope)).toBe('destructive')
    expect(effectOf('Finder', 'rename', { path: inside, name: 'b.txt' }, scope)).toBe('write_local')
    expect(effectOf('Finder', 'rename', { path: inside, name: 'clash.txt' }, scope)).toBe('destructive')
    expect(effectOf('Finder', 'trash', { paths: [inside] }, scope)).toBe('destructive')
    expect(hardStopOf('Finder', 'trash', { paths: [inside, inside] })).toMatch(/2 item\(s\) to the Trash/)
    expect(effectOf('Finder', 'selection', {}, scope)).toBe('read')
    expect(effectOf('Finder', 'open', { path: 'x.pdf' }, scope)).toBe('write_local')
    expect(hardStopOf('Finder', 'open', { path: '/Applications/Calculator.app' })).toMatch(/runs it/)
    expect(hardStopOf('Finder', 'open', { path: 'install.command' })).toMatch(/runs it/)
    expect(hardStopOf('Finder', 'open', { path: 'report.pdf' })).toBeNull()
    expect(insideRoots('sub/new.txt', scope)).toBe(true)
    expect(insideRoots('/private/etc', scope)).toBe(false)
  })
  test('sending messages always asks, in every mode', () => {
    for (const [app, args] of [['Messages', { to: '+1 555 123 4567', text: 'hi' }], ['Slack', { channel: '#general', text: 'hi' }]] as const) {
      expect(effectOf(app, 'send', args, scope)).toBe('write_external')
      expect(consequentialOf(app, 'send', args, { granted: true })).toBe(true)
      expect(hardStopOf(app, 'send', args)).toMatch(/sends a/)
    }
    expect(describeCall('Messages', 'send', { to: 'ann@example.com', text: 'See you at 6' })).toBe('Messages: Send a message to ann@example.com: "See you at 6"')
  })
  test('mouse-and-keyboard actions follow computer use: one OK per task, always asked unattended', () => {
    expect(effectOf('Slack', 'switch_channel', { channel: 'x' }, scope)).toBe('write_external')
    expect(consequentialOf('Slack', 'switch_channel', { channel: 'x' }, { granted: false })).toBe(true)
    expect(consequentialOf('Slack', 'switch_channel', { channel: 'x' }, { granted: true })).toBe(false)
    expect(consequentialOf('Slack', 'switch_channel', { channel: 'x' }, { granted: true, unattended: true })).toBe(true)
    expect(hardStopOf('vscode', 'command', { name: 'Git: Discard All Changes' })).toMatch(/Discard/)
    expect(hardStopOf('vscode', 'command', { name: 'Format Document' })).toBeNull()
  })
  test('browsers: opening a page is routine navigation; reads are reads', () => {
    expect(effectOf('Safari', 'open_url', { url: 'example.com' }, scope)).toBe('write_external')
    expect(consequentialOf('Safari', 'open_url', { url: 'example.com' }, { granted: false })).toBe(false)
    expect(effectOf('Google Chrome', 'read_page', {}, scope)).toBe('read')
    expect(effectOf('Google Chrome', 'tabs', {}, scope)).toBe('read')
  })
  test('documents: edits are local; exporting over a file or outside the folders asks', () => {
    expect(effectOf('Numbers', 'write', { cells: { A1: 1 } }, scope)).toBe('write_local')
    expect(effectOf('Keynote', 'export_pdf', { to: join(ws, 'deck.pdf') }, scope)).toBe('write_local')
    expect(effectOf('Keynote', 'export_pdf', { to: inside }, scope)).toBe('destructive')
    expect(effectOf('Microsoft Word', 'export_pdf', { to: '/Users/Shared/out.pdf' }, scope)).toBe('destructive')
    expect(effectOf('Preview', 'export', { path: inside, to: join(ws, 'x.png') }, scope)).toBe('write_local')
    expect(effectOf('Finder', 'help', {}, scope)).toBe('read')
    expect(effectOf('Nope', 'whatever', {}, scope)).toBe('read')
  })
})

describe('scripts', () => {
  const jxa: Record<string, string> = {
    AX_TEXT, PLAYER, FRONT_TITLE,
    ...Object.fromEntries(Object.entries(FINDER_SCRIPTS).map(([k, v]) => [`FINDER_${k}`, v])),
    ...Object.fromEntries(Object.entries(SAFARI_SCRIPTS).map(([k, v]) => [`SAFARI_${k}`, v])),
    ...Object.fromEntries(Object.entries(CHROMIUM_SCRIPTS).map(([k, v]) => [`CHROMIUM_${k}`, v])),
    ...Object.fromEntries(Object.entries(NUMBERS_SCRIPTS).map(([k, v]) => [`NUMBERS_${k}`, v])),
    ...Object.fromEntries(Object.entries(PAGES_SCRIPTS).map(([k, v]) => [`PAGES_${k}`, v])),
    ...Object.fromEntries(Object.entries(KEYNOTE_SCRIPTS).map(([k, v]) => [`KEYNOTE_${k}`, v])),
    ...Object.fromEntries(Object.entries(IWORK_SCRIPTS).map(([k, v]) => [`IWORK_${k}`, v])),
    ...Object.fromEntries(Object.entries(MUSIC_SCRIPTS).map(([k, v]) => [`MUSIC_${k}`, v])),
    ...Object.fromEntries(Object.entries(SPOTIFY_SCRIPTS).map(([k, v]) => [`SPOTIFY_${k}`, v])),
    ...Object.fromEntries(Object.entries(MESSAGES_SCRIPTS).map(([k, v]) => [`MESSAGES_${k}`, v])),
    ...Object.fromEntries(Object.entries(PREVIEW_SCRIPTS).map(([k, v]) => [`PREVIEW_${k}`, v])),
    ...Object.fromEntries(Object.entries(XCODE_SCRIPTS).map(([k, v]) => [`XCODE_${k}`, v]))
  }
  const applescripts: Record<string, string> = {
    MESSAGES_SEND,
    ...Object.fromEntries(Object.entries(EXCEL_SCRIPTS).map(([k, v]) => [`EXCEL_${k}`, v])),
    ...Object.fromEntries(Object.entries(WORD_SCRIPTS).map(([k, v]) => [`WORD_${k}`, v])),
    ...Object.fromEntries(Object.entries(POWERPOINT_SCRIPTS).map(([k, v]) => [`POWERPOINT_${k}`, v]))
  }

  test('every JXA script compiles as JavaScript (checked with node, never run against an app)', () => {
    expect(Object.keys(jxa).length).toBeGreaterThan(35)
    for (const [name, fn] of Object.entries(jxa)) expect(() => new Script(wrap(fn)), name).not.toThrow()
    expect(() => new Script(PAGE_TEXT_JS)).not.toThrow()
  })
  test('AppleScripts take their data as argv only', () => {
    for (const [name, src] of Object.entries(applescripts)) {
      expect(src, name).toMatch(/^on run argv\n/)
      expect(src, name).toContain('end run')
      expect(src, name).not.toMatch(/\$\{/)
    }
    expect(applescripts).toMatchSnapshot()
  })
  test('only the Messages send script sends; the browsers only ever run SahilBot\'s own page-text script', () => {
    expect(Object.entries({ ...jxa, ...applescripts }).filter(([, s]) => /\bsend\b[^(]/.test(s) && /tell application "Messages"/.test(s)).map(([n]) => n)).toEqual(['MESSAGES_SEND'])
    expect(PAGE_TEXT_JS).not.toMatch(/value|password|cookie|localStorage|fetch|XMLHttpRequest/i)
  })
})

describe('pure helpers', () => {
  test('cell addresses and writes', () => {
    expect(parseCell('B3')).toEqual({ row: 3, col: 2 })
    expect(parseCell('$AA$10')).toEqual({ row: 10, col: 27 })
    expect(() => parseCell('A0')).toThrow()
    expect(() => parseCell('A1); do shell script "x"')).toThrow(/isn't a cell address/)
    expect(parseRange('C3:A1')).toEqual({ from: { row: 1, col: 1 }, to: { row: 3, col: 3 } })
    expect(cellWrites({ cells: { a1: 'Name', B2: 42 } })).toEqual([{ cell: 'A1', value: 'Name' }, { cell: 'B2', value: 42 }])
    expect(cellWrites({ start: 'Y1', values: [['a', 'b', 'c'], [1, null, '=SUM(Y2:AA2)']] })).toEqual([
      { cell: 'Y1', value: 'a' }, { cell: 'Z1', value: 'b' }, { cell: 'AA1', value: 'c' }, { cell: 'Y2', value: 1 }, { cell: 'AA2', value: '=SUM(Y2:AA2)' }
    ])
    expect(() => cellWrites({})).toThrow(/Give cells/)
    expect(formatTable([['a', 'b'], ['1\t2', null]], 'B2')).toBe('\tB\tC\n2\ta\tb\n3\t1 2\t')
    expect(parseExcelRead('Book1\tSheet1\t$A$1:$B$2\nName\tTotal\nAnn\t3\n')).toEqual({ book: 'Book1', sheet: 'Sheet1', address: '$A$1:$B$2', rows: [['Name', 'Total'], ['Ann', '3']] })
  })
  test('addresses, handles, links, panes', () => {
    expect(webUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(() => webUrl('javascript:alert(1)')).toThrow(/Only web addresses/)
    expect(() => webUrl('file:///etc/passwd')).toThrow(/Only web addresses/)
    expect(messageHandle('+1 (555) 123-4567')).toBe('+15551234567')
    expect(messageHandle('ann@example.com')).toBe('ann@example.com')
    expect(() => messageHandle('Ann')).toThrow(/chat_id/)
    expect(spotifyUri('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=x')).toBe('spotify:track:4uLU6hMCjMI75M1A2tKUQC')
    expect(spotifyUri('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toBe('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')
    expect(() => spotifyUri('rick astley')).toThrow()
    expect(paneUrl('Screen Recording').url).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    expect(paneUrl('wifi').pane).toBe('wi-fi')
    expect(paneUrl('Date and Time').pane).toBe('date & time')
    expect(() => paneUrl('nonsense pane')).toThrow(/Panes:/)
    expect(sipsArgs('/a/in.heic', '/a/out.jpg', { max_size: 1200 })).toEqual(['-s', 'format', 'jpeg', '-Z', '1200', '/a/in.heic', '--out', '/a/out.jpg'])
    expect(() => sipsArgs('/a', '/b.docx')).toThrow(/Can't convert/)
  })
  test('tabs, JavaScript-from-Apple-Events detection, Slack titles', () => {
    const tabs = [{ window: 1, tab: 1, title: 'Inbox', url: 'https://mail.example.com', active: false }, { window: 1, tab: 2, title: 'Docs', url: 'https://docs.example.com', active: true }, { window: 2, tab: 1, title: 'News', url: 'https://news.example.com', active: true }]
    expect(pickTab(tabs, {}).title).toBe('Docs')
    expect(pickTab(tabs, { match: 'news' }).window).toBe(2)
    expect(pickTab(tabs, { window: 1, tab: 1 }).title).toBe('Inbox')
    expect(() => pickTab(tabs, { match: 'zzz' })).toThrow(/No tab matches/)
    expect(jsDisabled('Executing JavaScript through AppleScript is turned off. To turn it on, from the menu bar, go to View > Developer > Allow JavaScript from Apple Events.')).toBe(true)
    expect(jsDisabled('You must enable \'Allow JavaScript from Apple Events\' in the Developer section of Safari Settings to use \'do JavaScript\'.')).toBe(true)
    expect(jsDisabled('Can\'t get window 3')).toBe(false)
    expect(jsHelp('safari', 'Safari')).toMatch(/Develop menu/)
    expect(titleShows('general (Channel) - Acme - Slack', '#general')).toBe(true)
    expect(titleShows('design-team (Channel) - Acme - Slack', 'design')).toBe(false)
    expect(titleShows('Ann Lee (DM) - Acme - Slack', 'Ann Lee')).toBe(true)
  })
  test('argument checks name what is wrong', () => {
    const a = findAdapter('Finder')!.actions.move
    expect(checkArgs(a, { paths: ['x'], to: 'y' }, 'Finder move')).toBeNull()
    expect(checkArgs(a, { paths: ['x'] }, 'Finder move')).toMatch(/to is required/)
    expect(checkArgs(a, { paths: ['x'], to: 'y', force: true }, 'Finder move')).toMatch(/unknown argument force/)
    expect(checkArgs(findAdapter('Music')!.actions.volume, { level: '40' }, 'Music volume')).toBeNull()
    expect(argsOf({ app: 'Safari', action: 'open_url', url: 'a.com', args: { new_window: true } })).toEqual({ url: 'a.com', new_window: true })
  })
  test('errors in words the user can act on', () => {
    expect(explainError('Numbers', 'execution error: Not authorized to send Apple events to Numbers. (-1743)')).toMatch(/Privacy & Security → Automation/)
    expect(explainError('Excel', 'Microsoft Excel got an error: Application isn\'t running. (-600)')).toMatch(/isn't running/)
    expect(explainError('Xcode', 'doesn\'t understand the “build” message. (-1708)')).toMatch(/computer use/)
  })
  test('reading order of on-screen text, Xcode results', () => {
    expect(formatAxText({ windows: ['Chat'], items: [{ role: 'StaticText', text: 'second', x: 0, y: 50 }, { role: 'StaticText', text: 'first', x: 0, y: 10 }, { role: 'Button', text: 'Send', x: 5, y: 50 }, { role: 'StaticText', text: 'first', x: 0, y: 10 }] }))
      .toBe('Window: Chat\nfirst\nsecond\n[Button] Send')
    expect(formatXcode('build', { workspace: 'App', scheme: 'App', completed: true, status: 'failed', errors: [{ message: 'Cannot find x in scope', file: '/p/A.swift', line: 12 }], warningCount: 0 }))
      .toContain('- Cannot find x in scope (A.swift:12) [/p/A.swift]')
  })
})

// ------------------------------------------------------------------ the tool, with fakes

function fakes(o: { running?: boolean; installed?: boolean; title?: string } = {}) {
  const calls: Array<{ kind: string; fn?: string; input?: any; args?: string[]; cmd?: string }> = []
  const deps: AppToolDeps = {
    osa: async (fn, input) => {
      calls.push({ kind: 'jxa', fn, input })
      if (fn === SAFARI_SCRIPTS.TABS) return [{ window: 1, tab: 1, title: 'Docs', url: 'https://docs.example.com', active: true }]
      if (fn === SAFARI_SCRIPTS.JS) return { ok: false, error: 'You must enable \'Allow JavaScript from Apple Events\' in the Developer section of Safari Settings' }
      if (fn === FRONT_TITLE) return o.title ?? 'random (Channel) - Acme - Slack'
      if (fn === NUMBERS_SCRIPTS.WRITE) return { doc: 'Budget', sheet: 'Sheet 1', table: 'Table 1', written: (input as { writes: unknown[] }).writes.length }
      return { ok: true }
    },
    applescript: async (src, args) => { calls.push({ kind: 'as', fn: src, args }); return src === EXCEL_SCRIPTS.WRITE ? `Book1\tSheet1\t${(args.length - 2) / 2}` : 'ok' },
    sh: async (cmd, args) => { calls.push({ kind: 'sh', cmd, args }); return '' },
    computer: async (args) => { calls.push({ kind: 'computer', input: args }); return { text: 'ok' } },
    macApps: async (args) => { calls.push({ kind: 'mac_apps', input: args }); return { text: 'Created the note.', display: 'created note' } },
    installed: async () => (o.installed === false ? undefined : '/Applications/X.app'),
    running: async () => o.running ?? true,
    granted: () => true
  }
  const tool = appTool(() => ws, deps)
  const ctx = { threadId: 't', signal: new AbortController().signal, state: { roots: [] }, askUser: async () => 'ok' } as never
  return { tool, ctx, calls }
}

describe('the app tool', () => {
  test('help lists an app\'s actions; app_help lists the apps', async () => {
    const f = fakes()
    const h = await f.tool.run({ app: 'Numbers', action: 'help' }, f.ctx)
    expect(h.text).toMatch(/- write \{doc\?, sheet\?, table\?, cells\?, start\?, values\?\}/)
    expect(h.text).toContain('app-iwork')
    expect((await appHelpTool().run({}, f.ctx)).text).toContain('Slack')
  })
  test('opens a page in Safari with the address as data', async () => {
    const f = fakes()
    const out = await f.tool.run({ app: 'Safari', action: 'open_url', args: { url: 'example.com/x' } }, f.ctx)
    expect(out.text).toMatch(/Opened https:\/\/example.com\/x/)
    expect(f.calls[0]).toMatchObject({ kind: 'jxa', fn: SAFARI_SCRIPTS.OPEN, input: { app: 'Safari', url: 'https://example.com/x', newWindow: false } })
  })
  test('read_page explains how to turn on JavaScript from Apple Events', async () => {
    const f = fakes()
    const out = await f.tool.run({ app: 'Safari', action: 'read_page' }, f.ctx)
    expect(out.text).toMatch(/Allow JavaScript from Apple Events/)
    expect(out.text).toMatch(/Only the user should turn it on/)
    expect(f.calls.find((c) => c.fn === SAFARI_SCRIPTS.JS)?.input.js).toBe(PAGE_TEXT_JS)
  })
  test('reads refuse to launch a closed app; missing apps are reported', async () => {
    const f = fakes({ running: false })
    expect((await f.tool.run({ app: 'Safari', action: 'tabs' }, f.ctx)).text).toMatch(/isn't open/)
    expect(f.calls).toEqual([])
    await expect(fakes({ installed: false }).tool.run({ app: 'Microsoft Excel', action: 'workbooks' }, f.ctx)).rejects.toThrow(/isn't installed/)
  })
  test('bad arguments never reach a script', async () => {
    const f = fakes()
    await expect(f.tool.run({ app: 'Finder', action: 'move', args: { paths: ['a'] } }, f.ctx)).rejects.toThrow(/to is required/)
    await expect(f.tool.run({ app: 'Safari', action: 'open_url', args: { url: 'javascript:alert(1)' } }, f.ctx)).rejects.toThrow(/Only web addresses/)
    expect(f.calls).toEqual([])
  })
  test('cell writes go to Numbers as JSON and to Excel as address/value pairs', async () => {
    const f = fakes()
    await f.tool.run({ app: 'Numbers', action: 'write', args: { start: 'B2', values: [[1, '=B2*2']] } }, f.ctx)
    await f.tool.run({ app: 'excel', action: 'write', args: { sheet: 'Q3', cells: { C5: 'Total', D5: true } } }, f.ctx)
    expect(f.calls.map((c) => (c.kind === 'jxa' ? { kind: c.kind, input: c.input } : { kind: c.kind, args: c.args }))).toMatchSnapshot()
  })
  test('Finder rename inside the workspace (real files in a temp folder)', async () => {
    const f = fakes()
    writeFileSync(join(ws, 'draft.txt'), 'hi')
    const out = await f.tool.run({ app: 'Finder', action: 'rename', args: { path: 'draft.txt', name: 'final.txt' } }, f.ctx)
    expect(out.text).toMatch(/Renamed draft.txt to final.txt/)
    expect(existsSync(join(ws, 'final.txt'))).toBe(true)
    await expect(f.tool.run({ app: 'Finder', action: 'rename', args: { path: 'final.txt', name: '../escape.txt' } }, f.ctx)).rejects.toThrow(/can't contain/)
  })
  test('Slack send stops before typing when the wrong channel is open', async () => {
    const f = fakes({ title: 'random (Channel) - Acme - Slack' })
    await expect(f.tool.run({ app: 'Slack', action: 'send', args: { channel: '#general', text: 'hello\nteam' } }, f.ctx)).rejects.toThrow(/Didn't send/)
    const keys = f.calls.filter((c) => c.kind === 'computer').map((c) => c.input)
    expect(keys.some((k) => k.text === 'hello\nteam')).toBe(false)
    const g = fakes({ title: 'general (Channel) - Acme - Slack' })
    await g.tool.run({ app: 'Slack', action: 'send', args: { channel: '#general', text: 'hello\nteam' } }, g.ctx)
    expect(g.calls.filter((c) => c.kind === 'computer').map((c) => c.input)).toEqual([
      { action: 'activate_app', app: 'Slack' }, { action: 'key', keys: 'cmd+k' }, { action: 'wait', seconds: 0.5 }, { action: 'type', text: 'general' }, { action: 'wait', seconds: 0.8 },
      { action: 'key', keys: 'return' }, { action: 'wait', seconds: 1 }, { action: 'type', text: 'hello\nteam', method: 'paste' }, { action: 'key', keys: 'return' }
    ])
  })
  test('Notes, Reminders and Calendar go through mac_apps', async () => {
    const f = fakes()
    await f.tool.run({ app: 'Notes', action: 'create', args: { title: 'Plan', body: 'Steps' } }, f.ctx)
    expect(f.calls).toEqual([{ kind: 'mac_apps', input: { action: 'notes_create', title: 'Plan', body: 'Steps' } }])
  })
  test('the tool\'s classification hooks', () => {
    const f = fakes()
    const eff = f.tool.effect as (a: never, c: { roots: string[] }) => string
    expect(eff({ app: 'Finder', action: 'trash', args: { paths: ['x'] } } as never, { roots: [] })).toBe('destructive')
    expect(f.tool.hardStop!({ app: 'Messages', action: 'send', args: { to: 'a@b.co', text: 'x' } })).toMatch(/sends a message/)
    expect(f.tool.describe!({ app: 'Keynote', action: 'add_slide', args: { title: 'Q3' } })).toBe('Keynote: Add a slide "Q3" to the Keynote presentation')
  })
})
