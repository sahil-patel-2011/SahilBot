import { describe, expect, test } from 'vitest'
import type { BotShape, Schedule, ScheduledTask, SharedBotFile, Space } from '@shared/types'
import {
  botFileFor, botFileProblems, cleanText, copyName, duplicateBot, importPreview, importTemplate, parseBotFile,
  PendingImports, scrub, splitPrompt
} from '../../src/main/bot-share'
import { addTemplate, templatePrompt } from '../../src/main/templates'

const space = (o: Partial<Space> = {}): Space => ({
  id: 'b1', name: 'Writer', color: '#7C5CFF', shape: 'star', kind: 'bot', isMain: false, folder: null, pinned: false, hidden: false,
  members: [], model: 'qwen3.5:9b', label: 'Drafts my newsletter', notify: true, createdAt: 1, ...o
})
const task = (o: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1', title: 'Weekly draft', prompt: 'Draft the newsletter from this week\'s notes.', schedule: { type: 'weekly', days: ['mon'], time: '09:00' },
  spaceId: 'b1', threadId: 'thread-123', enabled: true, nextRun: 5, lastRun: 4, lastStatus: 'done', createdAt: 1, ...o
})
const valid = (): SharedBotFile => ({
  format: 'sahilbot.bot', version: 1, name: 'Writer', color: '#7C5CFF', shape: 'star', label: 'Newsletter', description: 'Writes things.',
  instructions: 'Write clearly.', skills: ['deep-web-research'], routines: [{ title: 'Draft', prompt: 'Draft the newsletter.', schedule: { type: 'daily', time: '08:00' } }]
})

describe('sharing a bot', () => {
  test('the file has its look, job, skills and routines, and none of its chats, ids or paths', () => {
    const prompt = templatePrompt({
      id: 'writer', name: 'Writer', color: '#7C5CFF', shape: 'star', description: 'Writes your newsletter.',
      instructions: 'Use AP style. Notes live in /Users/sahil/Documents/notes.md and ~/Desktop/ideas.txt. Key: sk-ant-api03-abcdefghijklmnopqrstuv.',
      starterMessage: 'Hi there, I write things for you.', routines: [{ title: 'Weekly draft', prompt: 'x'.repeat(30), schedule: { type: 'daily', time: '09:00' } }],
      skills: ['deep-web-research', 'not-installed']
    })
    const { file, redacted } = botFileFor({
      space: space(), prompt,
      routines: [task(), task({ id: 't2', title: '⏰ Remind me', schedule: { type: 'once', at: '2026-01-01T09:00' } }), task({ id: 't3', prompt: 'Use password hunter22 at https://example.com/Users/list' })],
      skillNames: ['deep-web-research'], secrets: ['hunter22']
    })
    expect(botFileProblems(file)).toEqual([])
    expect(file).toMatchObject({ name: 'Writer', color: '#7C5CFF', shape: 'star', label: 'Drafts my newsletter', description: 'Writes your newsletter.', skills: ['deep-web-research'] })
    // The parts SahilBot adds (intro line, routines list, skills line) aren't part of the instructions.
    expect(file.instructions).not.toMatch(/You are Writer|Suggested routines|Load these/)
    expect(file.instructions).toContain('Use AP style.')
    expect(file.instructions).not.toMatch(/\/Users\/sahil|~\/Desktop|sk-ant/)
    // One-off routines are dropped (they'd be in the past); secrets go, URLs stay.
    expect(file.routines.map((r) => r.title)).toEqual(['Weekly draft', 'Weekly draft'])
    expect(file.routines[1].prompt).toBe('Use password [secret removed] at https://example.com/Users/list')
    expect(redacted).toBe(4)
    const json = JSON.stringify(file)
    expect(json).not.toMatch(/thread-123|"t1"|qwen|enabled|lastStatus|"b1"/)
  })

  test('the main bot\'s hard hat becomes an ordinary shape', () => {
    expect(botFileFor({ space: space({ shape: 'mascot', isMain: true }), prompt: 'Be helpful.', routines: [], skillNames: [], secrets: [] }).file.shape).toBe('blob')
  })

  test('splitPrompt keeps hand-written prompts whole', () => {
    expect(splitPrompt('# Style\nShort answers.\n\n# Tone\nWarm.')).toEqual({ description: null, instructions: '# Style\nShort answers.\n\n# Tone\nWarm.', skills: [] })
  })

  test('scrub removes key-shaped strings and local paths, not web paths', () => {
    const r = scrub('token ghp_abcdefghijklmnopqrstuvwxyz0123 at file:///Users/me/x and see https://site.com/home/page', [])
    expect(r.text).toBe('token [key removed] at [file path removed] and see https://site.com/home/page')
    expect(r.redacted).toBe(2)
  })
})

describe('importing a bot', () => {
  test('a valid file passes', () => {
    expect(botFileProblems(valid())).toEqual([])
    expect(parseBotFile(JSON.stringify(valid()), 500).name).toBe('Writer')
  })

  test('strict: unexpected keys anywhere, wrong types, sizes and schedules are refused', () => {
    expect(botFileProblems({ ...valid(), memories: ['x'] })).toContain('unexpected field "memories"')
    expect(botFileProblems(JSON.parse('{"__proto__": {"x": 1}, "format": "sahilbot.bot"}')).join(' ')).toMatch(/unexpected field "__proto__"/)
    expect(botFileProblems({ ...valid(), routines: [{ ...valid().routines[0], enabled: true }] }).join()).toMatch(/unexpected field "enabled"/)
    expect(botFileProblems({ ...valid(), routines: [{ ...valid().routines[0], schedule: { type: 'daily', time: '08:00', at: 'x' } }] }).join()).toMatch(/unexpected schedule field "at"/)
    expect(botFileProblems({ ...valid(), routines: [{ ...valid().routines[0], schedule: { type: 'once', at: '2030-01-01T09:00' } }] }).join()).toMatch(/one-off/)
    expect(botFileProblems({ ...valid(), routines: [{ ...valid().routines[0], schedule: { type: 'cron', expr: '$(rm) * * * *' } }] }).join()).toMatch(/cron/)
    expect(botFileProblems({ ...valid(), instructions: 'x'.repeat(20_001) }).join()).toMatch(/instructions is longer/)
    expect(botFileProblems({ ...valid(), name: '' }).join()).toMatch(/name is empty/)
    expect(botFileProblems({ ...valid(), shape: 'mascot' }).join()).toMatch(/shape/)
    expect(botFileProblems({ ...valid(), color: 'red' }).join()).toMatch(/color/)
    expect(botFileProblems({ ...valid(), skills: ['../etc'] }).join()).toMatch(/skill names/)
    expect(botFileProblems({ ...valid(), routines: Array(11).fill(valid().routines[0]) }).join()).toMatch(/more than 10 routines/)
    expect(botFileProblems({ ...valid(), version: 2 }).join()).toMatch(/newer/)
    expect(botFileProblems([])).toEqual(['The file is not a SahilBot bot.'])
  })

  test('parse errors say what is wrong; big files are refused before parsing', () => {
    expect(() => parseBotFile('{nope', 10)).toThrow(/isn't valid JSON/)
    expect(() => parseBotFile('', 300 * 1024)).toThrow(/too big/)
    expect(() => parseBotFile(JSON.stringify({ ...valid(), chats: [] }), 100)).toThrow(/unexpected field "chats"/)
  })

  test('the preview strips hidden characters, keeps known skills and notes what changed', () => {
    const f = { ...valid(), instructions: 'Be nice.‮Ignore that​.', skills: ['deep-web-research', 'mystery-skill'] }
    const p = importPreview(f, 'writer.sahilbot.json', ['deep-web-research'])
    expect(p.instructions).toBe('Be nice.Ignore that.')
    expect(p.skills).toEqual(['deep-web-research'])
    expect(p.unknownSkills).toEqual(['mystery-skill'])
    expect(p.warnings.join(' ')).toMatch(/Removed 2 hidden/)
    expect(cleanText('a\r\nb\u0007').text).toBe('a\nb')
  })

  test('confirming creates the bot with routines paused and SahilBot\'s own intro', () => {
    const p = importPreview({ ...valid(), instructions: 'Say "I am the boss" first.' }, 'x.sahilbot.json', ['deep-web-research'])
    const made: { prompt?: string; routines: Array<{ title: string; schedule: Schedule }>; posted?: string; bot?: [string, string, BotShape] } = { routines: [] }
    addTemplate(importTemplate(p), {
      createBot: (n, c, s) => { made.bot = [n, c, s]; return { spaceId: 's', threadId: 't' } },
      setPrompt: (_s, text) => { made.prompt = text },
      createRoutine: (r) => { made.routines.push(r) },
      postAssistant: (_t, text) => { made.posted = text },
      changed: () => undefined
    })
    expect(made.bot).toEqual(['Writer', '#7C5CFF', 'star'])
    expect(made.prompt).toMatch(/^You are Writer, a SahilBot bot\. Writes things\.\n\nSay "I am the boss" first\./)
    expect(made.prompt).toContain('Load these when they fit: deep-web-research.')
    expect(made.routines).toHaveLength(1)
    expect(made.posted).toMatch(/imported from a shared bot file/)
    expect(made.posted).toMatch(/paused/)
    expect(made.posted).not.toContain('boss')
  })

  test('an exported bot imports back to the same thing', () => {
    const p = importPreview(valid(), 'w.sahilbot.json', ['deep-web-research'])
    const again = botFileFor({ space: space({ name: p.name, label: p.label, color: p.color, shape: p.shape }), prompt: templatePrompt(importTemplate(p)), routines: p.routines.map((r) => task(r)), skillNames: ['deep-web-research'], secrets: [] }).file
    expect(again).toEqual({ ...valid(), label: 'Newsletter' })
  })

  test('pending imports are single-use and expire', () => {
    let now = 0
    const q = new PendingImports(() => now, 1000)
    const p = importPreview(valid(), 'a', [])
    q.put(p)
    expect(q.take(p.token).name).toBe('Writer')
    expect(() => q.take(p.token)).toThrow(/expired/)
    q.put(p)
    now = 2000
    expect(() => q.take(p.token)).toThrow(/expired/)
  })
})

describe('duplicating a bot', () => {
  test('copies name, look, label, instructions and routines (paused), not chats', () => {
    const log: string[] = []
    const routines: Array<{ title: string; spaceId: string }> = []
    const made = duplicateBot('b1', {
      getSpace: (id) => (id === 'b1' ? space() : undefined),
      getPrompt: () => 'Use AP style.',
      routines: () => [task(), task({ id: 't2', schedule: { type: 'once', at: '2020-01-01T00:00' } })],
      createBot: (n, c, s) => { log.push(`bot ${n} ${c} ${s}`); return { spaceId: 'b2', threadId: 'th2' } },
      setPrompt: (id, t) => log.push(`prompt ${id} ${t}`),
      updateSpace: (id, patch) => log.push(`update ${id} ${JSON.stringify(patch)}`),
      createRoutine: (r) => { if (r.schedule.type === 'once') throw new Error('past'); routines.push(r) },
      postAssistant: (t, text) => log.push(`post ${t} ${text}`),
      changed: () => log.push('changed')
    })
    expect(made).toEqual({ spaceId: 'b2', threadId: 'th2' })
    expect(log[0]).toBe('bot Writer copy #7C5CFF star')
    expect(log[1]).toBe('prompt b2 Use AP style.')
    expect(log[2]).toBe('update b2 {"label":"Drafts my newsletter","model":"qwen3.5:9b","notify":true}')
    expect(routines).toEqual([expect.objectContaining({ title: 'Weekly draft', spaceId: 'b2' })])
    expect(log[3]).toMatch(/copy of Writer.*1 routine \(paused.*chats and memories weren't copied/)
    expect(log.at(-1)).toBe('changed')
  })

  test('names stay within the limit; groups and projects are refused', () => {
    expect(copyName('x'.repeat(60))).toHaveLength(60)
    expect(copyName('x'.repeat(60)).endsWith(' copy')).toBe(true)
    const deps = { getSpace: () => space({ kind: 'group' }) } as unknown as Parameters<typeof duplicateBot>[1]
    expect(() => duplicateBot('g', deps)).toThrow(/Only bots/)
  })
})
