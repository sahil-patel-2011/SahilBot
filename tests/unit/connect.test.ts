import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { BotTemplate, ConnectorPreset } from '@shared/types'
import { ConnectorIcons, PRESETS, iconDomain } from '../../src/main/connectors'
import { addTemplate, loadTemplates, scheduleProblems, templateProblems, templatePrompt } from '../../src/main/templates'
import { nextRun } from '../../src/main/scheduler'
import { MAIN_CHIPS, MORE_CATEGORIES, SECTION_ORDER, chipOf, letterColor, matches, recommended } from '../../src/renderer/src/lib/connect-catalog'

const preset = (id: string): ConnectorPreset => PRESETS.find((p) => p.id === id)!

describe('app icon domains', () => {
  test('derives the site from the MCP host', () => {
    expect(iconDomain(preset('notion'))).toBe('notion.com')
    expect(iconDomain(preset('linear'))).toBe('linear.app')
    expect(iconDomain(preset('zapier'))).toBe('zapier.com')
    expect(iconDomain(preset('ahrefs'))).toBe('ahrefs.com')
    expect(iconDomain(preset('miro'))).toBe('miro.com')
    expect(iconDomain(preset('neon'))).toBe('neon.tech')
    expect(iconDomain({ url: 'https://www.example.co/mcp' })).toBe('example.co')
  })
  test('explicit domains win where the host would be wrong', () => {
    expect(iconDomain(preset('gmail'))).toBe('mail.google.com/mail/')
    expect(iconDomain(preset('gcal-web'))).toBe('calendar.google.com/calendar/')
    expect(iconDomain(preset('github'))).toBe('github.com')
    expect(iconDomain(preset('sentry'))).toBe('sentry.io')
    expect(iconDomain(preset('cursor-app'))).toBe('cursor.com')
  })
  test('nothing to fetch for app: URLs, local hosts or the custom entry', () => {
    expect(iconDomain({ url: 'app:mac_apps' })).toBeNull()
    expect(iconDomain({ url: 'http://127.0.0.1:3000/mcp' })).toBeNull()
    expect(iconDomain({ url: 'http://localhost:3000/mcp' })).toBeNull()
    expect(iconDomain(preset('custom'))).toBeNull()
  })
  test('every catalog app except custom has an icon domain', () => {
    expect(PRESETS.filter((p) => p.id !== 'custom' && !iconDomain(p)).map((p) => p.id)).toEqual([])
  })
})

describe('icon cache', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400, 1)])
  const fakeFetch = (fail: (url: string) => boolean, calls: string[]) => (async (url: string) => {
    calls.push(url)
    if (fail(url)) return new Response('nope', { status: 404 })
    return new Response(png, { status: 200, headers: { 'content-type': url.includes('duckduckgo') ? 'image/x-icon' : 'image/png' } })
  }) as unknown as typeof fetch

  test('returns cached icons at once, fetches the rest in the background, falls back, and keeps them on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icons-'))
    const ps = [preset('notion'), preset('slack')]
    const calls: string[] = []
    let changed = 0
    const icons = new ConnectorIcons(dir, ps, () => changed++, fakeFetch((u) => u.includes('google.com/s2') && u.includes('slack'), calls))
    expect(icons.all()).toEqual({})
    await (icons as unknown as { running: Promise<void> }).running
    await new Promise((r) => setTimeout(r, 300))
    const got = icons.all()
    expect(got.notion).toMatch(/^data:image\/png;base64,/)
    expect(got.slack).toMatch(/^data:image\/x-icon;base64,/)
    expect(calls.some((u) => u.includes('icons.duckduckgo.com/ip3/slack.com.ico'))).toBe(true)
    expect(calls.some((u) => u.includes('domain=notion.com'))).toBe(true)
    expect(changed).toBeGreaterThan(0)
    expect(readdirSync(dir).sort()).toEqual(['misses.json', 'notion.png', 'slack.ico'])
    // A new session reads the files and fetches nothing.
    const again: string[] = []
    const icons2 = new ConnectorIcons(dir, ps, () => undefined, fakeFetch(() => false, again))
    expect(Object.keys(icons2.all()).sort()).toEqual(['notion', 'slack'])
    expect(again).toEqual([])
  })

  test('a site with a path asks for that page\'s icon', async () => {
    const calls: string[] = []
    const icons = new ConnectorIcons(mkdtempSync(join(tmpdir(), 'icons-')), [preset('gmail')], () => undefined, fakeFetch(() => false, calls))
    icons.all()
    await (icons as unknown as { running: Promise<void> }).running
    expect(calls[0]).toContain('domain_url=https%3A%2F%2Fmail.google.com%2Fmail%2F')
  })

  test('remembers misses instead of refetching every time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'icons-'))
    const calls: string[] = []
    const icons = new ConnectorIcons(dir, [preset('notion')], () => undefined, fakeFetch(() => true, calls))
    icons.all()
    await (icons as unknown as { running: Promise<void> }).running
    const n = calls.length
    expect(n).toBe(2)
    icons.all()
    expect(calls.length).toBe(n)
    expect(new ConnectorIcons(dir, [preset('notion')], () => undefined, fakeFetch(() => true, calls)).all()).toEqual({})
    expect(calls.length).toBe(n)
  })
})

describe('connect categories', () => {
  test('every preset lands in a known section', () => {
    for (const p of PRESETS) expect(SECTION_ORDER as readonly string[]).toContain(p.category)
  })
  test('apps are grouped sensibly', () => {
    const cat = (id: string): string => preset(id).category
    expect(['gcal', 'gdrive', 'notion', 'linear', 'asana'].map(cat)).toEqual(Array(5).fill('Productivity'))
    expect(['gmail', 'slack'].map(cat)).toEqual(['Communication', 'Communication'])
    expect(['figma', 'canva'].map(cat)).toEqual(['Design', 'Design'])
    expect(['github', 'vercel', 'supabase', 'sentry'].map(cat)).toEqual(Array(4).fill('Code'))
    expect(chipOf(cat('stripe'))).toBe('More')
    expect(chipOf(cat('posthog'))).toBe('More')
    expect(chipOf(cat('hubspot'))).toBe('More')
    expect(chipOf('Design')).toBe('Design')
  })
  test('built-in apps stay in "Built in"; browser sign-ins sit next to the app they automate', () => {
    // Cursor connects with an API key (Cloud Agents), so it's with the code apps, not built in; Outlook signs in
    // with Microsoft from its own panel, so it's with the communication apps.
    expect(PRESETS.filter((p) => p.auth === 'app' && p.id !== 'cursor-app' && p.id !== 'outlook').every((p) => p.category === 'Built in')).toBe(true)
    expect(PRESETS.find((p) => p.id === 'cursor-app')?.category).toBe('Code')
    expect(PRESETS.find((p) => p.id === 'outlook')?.category).toBe('Communication')
    expect(PRESETS.filter((p) => p.category === 'Built in').length).toBeGreaterThanOrEqual(2)
    // "Gmail (in SahilBot's browser)" is listed with Gmail (below its one-click connector), not apart from it.
    expect(['gmail-web', 'gcal-web', 'gdrive-web'].map((id) => preset(id).category)).toEqual(['gmail', 'gcal', 'gdrive'].map((id) => preset(id).category))
  })
  test('More holds every section that is not a main chip', () => {
    expect(MORE_CATEGORIES).toEqual(SECTION_ORDER.filter((c) => !(MAIN_CHIPS as readonly string[]).includes(c)))
    expect(MORE_CATEGORIES).not.toContain('Productivity')
    expect(MORE_CATEGORIES).toContain('Finance & commerce')
    // Most common first; Password Managers sits under More.
    expect([...MAIN_CHIPS]).toEqual(['Productivity', 'Communication', 'Code', 'Design'])
    expect(MORE_CATEGORIES).toContain('Password Managers')
  })
  test('recommendations skip connected apps; search and letter colors', () => {
    const r = recommended(PRESETS, new Set(['gmail']))
    expect(r).toHaveLength(6)
    expect(r.map((p) => p.id)).not.toContain('gmail')
    expect(matches('pull req', 'GitHub', 'Repos, issues and pull requests.')).toBe(true)
    expect(matches('figma', 'Notion')).toBe(false)
    expect(letterColor('#FFD02F')).toBe('#111')
    expect(letterColor('#4A154B')).toBe('#fff')
  })
})

describe('bot templates', () => {
  const dir = resolve('packs/templates')
  const skillNames = readdirSync(resolve('packs/skills')).filter((d) => existsSync(join(resolve('packs/skills'), d, 'SKILL.md')))
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  test('30–40 templates, each valid, named after its file', () => {
    expect(files.length).toBeGreaterThanOrEqual(30)
    expect(files.length).toBeLessThanOrEqual(40)
    for (const f of files) {
      const t = JSON.parse(readFileSync(join(dir, f), 'utf8')) as BotTemplate
      expect(templateProblems(t, skillNames), f).toEqual([])
      expect(`${t.id}.json`).toBe(f)
    }
    expect(loadTemplates(dir)).toHaveLength(files.length)
  })

  test('every suggested routine has a schedule that runs', () => {
    const now = new Date('2026-11-12T10:00:00')
    for (const t of loadTemplates(dir)) {
      for (const r of t.routines) {
        expect(scheduleProblems(r.schedule), `${t.id}: ${r.title}`).toEqual([])
        expect(nextRun(r.schedule, now), `${t.id}: ${r.title}`).not.toBeNull()
      }
    }
  })

  test('instructions set approval limits', () => {
    for (const t of loadTemplates(dir)) expect(t.instructions, t.id).toMatch(/never|limits/i)
    const health = loadTemplates(dir).find((t) => t.id === 'health-notes')!
    expect(health.instructions).toMatch(/not .*medical advice|don't give medical advice/i)
    expect(health.instructions).toMatch(/911/)
  })

  test('rejects broken templates', () => {
    expect(templateProblems({ id: 'X Y', name: '', color: 'red', shape: 'mascot', routines: [{ title: 't', prompt: 'short', schedule: { type: 'once', at: '2020-01-01' } }] }).length).toBeGreaterThan(4)
    expect(scheduleProblems({ type: 'weekly', days: ['funday'], time: '25:00' })).toHaveLength(2)
    expect(scheduleProblems({ type: 'daily', time: '07:30' })).toEqual([])
  })

  test('adding creates the bot, its paused routines and its first message', () => {
    const t = loadTemplates(dir).find((x) => x.routines.length >= 2)!
    const log: string[] = []
    const r = addTemplate(t, {
      createBot: (name, color, shape) => { log.push(`bot ${name} ${color} ${shape}`); return { spaceId: 's1', threadId: 't1' } },
      setPrompt: (id, text) => { log.push(`prompt ${id}`); expect(text).toContain(t.instructions.trim()); expect(text).toContain(t.routines[0].title) },
      createRoutine: (x) => { log.push(`routine ${x.spaceId} ${x.title}`); if (x.title === t.routines[0].title) throw new Error('bad') },
      postAssistant: (id, text) => log.push(`say ${id} ${text === t.starterMessage.trim()}`),
      changed: () => log.push('changed')
    })
    expect(r).toEqual({ spaceId: 's1', threadId: 't1' })
    expect(log[0]).toBe(`bot ${t.name} ${t.color} ${t.shape}`)
    expect(log.filter((l) => l.startsWith('routine s1'))).toHaveLength(t.routines.length)
    expect(log.at(-2)).toBe('say t1 true')
    expect(log.at(-1)).toBe('changed')
    expect(templatePrompt(t)).toMatch(/only enable it after the user says yes/)
  })
})

describe('per-tool switches', () => {
  test('switched-off tools are never registered, and switching back on registers them live', async () => {
    const { Connectors } = await import('../../src/main/connectors')
    const { ToolRegistry } = await import('../../src/main/agent/registry')
    const store = new Map<string, unknown>()
    const db = { getSetting: (k: string) => store.get(k), setSetting: (k: string, v: unknown) => void store.set(k, v) }
    const registry = new ToolRegistry()
    const c = new Connectors(db as never, { get: () => undefined, set: () => undefined } as never, registry, () => undefined)
    const cfg = c.save({ name: 'Notes', kind: 'stdio', command: process.execPath, args: [resolve('tests/fixtures/mcp-notes-server.mjs')], enabled: true, disabledTools: ['send_note'] })
    const st = await c.connect(cfg.id, false)
    try {
      expect(st.state).toBe('connected')
      expect(st.toolNames?.sort()).toEqual(['search_notes', 'send_note'])
      expect(st.tools).toBe(1)
      const names = (): string[] => registry.all().map((t) => t.name).sort()
      expect(names()).toEqual(['notes__search_notes'])
      expect(c.setToolEnabled(cfg.id, 'send_note', true).disabledTools).toBeUndefined()
      expect(names()).toEqual(['notes__search_notes', 'notes__send_note'])
      c.setToolEnabled(cfg.id, 'search_notes', false)
      expect(names()).toEqual(['notes__send_note'])
      expect(c.list()[0].disabledTools).toEqual(['search_notes'])
      expect(c.statuses()[0].tools).toBe(1)
    } finally {
      await c.disconnect(cfg.id)
    }
  }, 20_000)
})
