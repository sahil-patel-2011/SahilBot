import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { BotTemplate } from '@shared/types'
import { PRESETS } from '../../src/main/connectors'
import { addTemplate, loadTemplates, templateProblems, templatePrompt } from '../../src/main/templates'
import { botState, isContextTool, modelFamily, runPhase, runsOnLabel, shortModel, statusText, withUnread } from '../../src/shared/bot-status'
import { NO_PRESET, sourceInfo } from '../../src/renderer/src/lib/function-bots'

const dir = resolve('packs/templates')
const skillsDir = resolve('packs/skills')
const skillNames = readdirSync(skillsDir).filter((d) => existsSync(join(skillsDir, d, 'SKILL.md')))
const FUNCTION_IDS = ['accounting-bot', 'marketing-bot', 'sales-bot', 'contracts-bot', 'customer-support']
const read = (id: string): BotTemplate => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as BotTemplate

describe('function bot templates', () => {
  test('the five exist, are valid and grouped as function bots', () => {
    for (const id of FUNCTION_IDS) {
      const t = read(id)
      expect(templateProblems(t, skillNames), id).toEqual([])
      expect(t.group, id).toBe('function')
    }
    const loaded = loadTemplates(dir).filter((t) => t.group === 'function').map((t) => t.name)
    expect(loaded).toEqual(['Accounting', 'Contracts', 'Customer Support', 'Marketing', 'Sales'])
  })

  test('sources are connector presets (or a named app with no preset yet)', () => {
    const presetIds = new Set(PRESETS.map((p) => p.id))
    const expected: Record<string, string[]> = {
      'accounting-bot': ['quickbooks', 'gmail'], 'marketing-bot': ['slack', 'notion'], 'sales-bot': ['hubspot', 'zoom'], 'contracts-bot': ['gdrive', 'gmail'],
      'customer-support': ['gmail', 'gdrive', 'intercom', 'helpscout', 'front']
    }
    for (const id of FUNCTION_IDS) {
      const t = read(id)
      expect(t.sources, id).toEqual(expected[id])
      for (const s of t.sources!) expect(presetIds.has(s) || s in NO_PRESET, `${id}: ${s}`).toBe(true)
    }
  })

  test('starter tasks match the jobs, and skills exist', () => {
    const first: Record<string, string> = {
      'accounting-bot': 'Which invoices are overdue?', 'marketing-bot': "Draft this week's newsletter",
      'sales-bot': 'Prep me for my 2pm', 'contracts-bot': 'What scope did we agree with Client C?',
      'customer-support': 'Check the support inbox now'
    }
    for (const id of FUNCTION_IDS) {
      const t = read(id)
      expect(t.starterTasks?.[0], id).toBe(first[id])
      expect(t.starterTasks!.length, id).toBeGreaterThanOrEqual(3)
      expect(t.skills!.length, id).toBeGreaterThanOrEqual(3)
      for (const s of t.skills!) expect(skillNames, `${id}: ${s}`).toContain(s)
    }
  })

  test('instructions: brain first (real tool names), cite sources as chips, draft never send', () => {
    const toolsDir = resolve('src/main/agent/tools')
    const toolSrc = readdirSync(toolsDir).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(toolsDir, f), 'utf8')).join('\n')
    for (const id of FUNCTION_IDS) {
      const t = read(id)
      expect(t.instructions.length, id).toBeGreaterThanOrEqual(200)
      for (const tool of t.instructions.match(/`([a-z_]+)`/g) ?? []) expect(toolSrc, `${id}: ${tool}`).toContain(`name: '${tool.slice(1, -1)}'`)
      expect(t.instructions, id).toMatch(/`about`/)
      expect(t.instructions, id).toMatch(/`vault`/)
      expect(t.instructions, id).toMatch(/\[Email · Oct 14\]/)
      expect(t.instructions, id).toMatch(/Never send/)
      expect(t.routines.length, id).toBeGreaterThanOrEqual(1)
    }
    expect(templatePrompt(loadTemplates(dir).find((t) => t.id === 'sales-bot')!)).toMatch(/Suggested apps: hubspot, zoom/)
  })

  test('adding one posts its intro with the starter tasks as suggestions', () => {
    const t = loadTemplates(dir).find((x) => x.id === 'accounting-bot')!
    const posted: Array<{ text: string; meta?: Record<string, unknown> }> = []
    addTemplate(t, {
      createBot: () => ({ spaceId: 's', threadId: 't' }), setPrompt: () => undefined, createRoutine: () => undefined,
      postAssistant: (_id, text, meta) => { posted.push({ text, meta }) }, changed: () => undefined
    })
    expect(posted).toEqual([{ text: t.starterMessage.trim(), meta: { suggestions: t.starterTasks } }])
  })

  test('rejects bad new fields', () => {
    const ok = read('sales-bot')
    expect(templateProblems({ ...ok, sources: [] })).toContain('sources must be 1-6 short strings')
    expect(templateProblems({ ...ok, starterTasks: ['a', 'A'] })).toContain('starterTasks has duplicates')
    expect(templateProblems({ ...ok, group: 'other' as never })).toContain('group must be "function"')
    expect(templateProblems({ ...ok, sources: undefined })).toContain('function bots need sources and starterTasks')
    const { group: _g, sources: _s, starterTasks: _t, ...plain } = ok
    expect(templateProblems(plain)).toEqual([])
  })

  test('source chips: preset names, the no-preset fallback, connected through an alias', () => {
    const presets = [{ id: 'gmail', name: 'Gmail', color: '#EA4335' }, { id: 'gmail-web', name: 'Gmail (in SahilBot\'s browser)', color: '#EA4335' }]
    const s = sourceInfo(['quickbooks', 'gmail'], presets, [{ id: 'c1', preset: 'gmail-web' }], [{ id: 'c1', state: 'connected' }])
    expect(s).toEqual([
      { id: 'quickbooks', name: 'QuickBooks', color: '#2CA01C', preset: false, connected: false },
      { id: 'gmail', name: 'Gmail', color: '#EA4335', preset: true, connected: true }
    ])
    expect(sourceInfo(['gmail'], presets, [{ id: 'c1', preset: 'gmail' }], [{ id: 'c1', state: 'needs_auth' }])[0].connected).toBe(false)
  })
})

describe('bot status', () => {
  const user = { role: 'user' as const, content: 'Which invoices are overdue?', kind: 'normal' as const }
  const asst = (content: string, tools: string[] = []) => ({ role: 'assistant' as const, content, kind: 'normal' as const, toolCalls: tools.map((name) => ({ name })) })

  test('context tools: the brain, files, the web and connected apps\' reads', () => {
    for (const n of ['about', 'vault', 'memory', 'knowledge_search', 'web_search', 'quickbooks__search_invoices', 'gmail__get_thread', 'hubspot__list_deals']) expect(isContextTool(n), n).toBe(true)
    for (const n of ['file_write', 'gmail__send_message', 'gmail__create_draft', 'create_document', 'search']) expect(isContextTool(n), n).toBe(false)
  })

  test('run phase: pulling context until it writes or does more than read', () => {
    expect(runPhase([user])).toBe('context')
    expect(runPhase([user, asst('', ['about', 'vault'])])).toBe('context')
    expect(runPhase([user, asst('Let me check.', ['quickbooks__search_invoices'])])).toBe('context')
    expect(runPhase([user, asst('', ['about']), asst('3 overdue.')])).toBe('working')
    expect(runPhase([user, asst('', ['about', 'gmail__create_draft'])])).toBe('working')
    // Only the current turn counts.
    expect(runPhase([user, asst('', ['file_write']), asst('Done.'), user])).toBe('context')
  })

  test('state: running phase, else Done while unread, else Idle; fresher read state wins', () => {
    expect(botState({ running: true, phase: 'context', unread: true })).toBe('context')
    expect(botState({ running: true, unread: false })).toBe('working')
    expect(botState({ running: false, unread: true })).toBe('done')
    expect(botState({ running: false, unread: false })).toBe('idle')
    expect(withUnread({ state: 'done', runsOn: 'Claude' }, false)).toEqual({ state: 'idle', runsOn: 'Claude' })
    expect(withUnread(undefined, true).state).toBe('done')
    expect(withUnread({ state: 'context' }, false).state).toBe('context')
  })

  test('runs on: provider and model name to a family', () => {
    expect(runsOnLabel('anthropic', 'claude-opus-4-1')).toBe('Claude')
    expect(runsOnLabel('openrouter', 'anthropic/claude-sonnet-4')).toBe('Claude')
    expect(runsOnLabel('openai', 'gpt-5')).toBe('ChatGPT')
    expect(runsOnLabel('chatgpt', 'chatgpt-plan/gpt-5')).toBe('ChatGPT')
    expect(runsOnLabel('openrouter', 'google/gemini-2.5-pro')).toBe('Gemini')
    expect(runsOnLabel('xai', 'grok-4')).toBe('Grok')
    expect(runsOnLabel('ollama', 'gpt-oss:20b')).toBe('gpt-oss:20b on this Mac')
    expect(runsOnLabel('lmstudio', 'qwen/qwen3-8b', 'Qwen3 8B · Coding')).toBe('Qwen3 8B on this Mac')
    expect(runsOnLabel('custom', 'llama3')).toBe('llama3 on your model server')
    expect(modelFamily(undefined, 'mistral-large')).toBe('other')
    expect(shortModel('meta-llama/llama-3.3-70b')).toBe('llama-3.3-70b')
    expect(statusText({ state: 'context', runsOn: 'Claude' })).toBe('Pulling context… · runs on Claude')
    expect(statusText(undefined)).toBe('Idle')
  })
})
