import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { SettingsStore } from '../../src/main/settings'
import { LEGACY_PAGES, NOT_IN_SETTINGS, PAGE_TITLES, SETTINGS_INDEX, searchSettings } from '../../src/renderer/src/lib/settings-index'

// Settings search finds every setting: each index entry points at a row that exists (its data-setting anchor),
// every anchored row is in the index, and every saved setting has a row someone can search for.

const SOURCES = ['SettingsModal.tsx', 'MemoryManager.tsx', 'ServerSettings.tsx', 'GrokPlanSettings.tsx'].map((f) => readFileSync(resolve('src/renderer/src/components', f), 'utf8')).join('\n')
const anchors = new Set([...SOURCES.matchAll(/<Row\b[^>]*?\sid="([a-z0-9-]+)"/g), ...SOURCES.matchAll(/data-setting="([a-z0-9-]+)"/g)].map((m) => m[1]))

const secrets = { get: () => undefined, set: () => undefined, has: () => false } as never

describe('the settings search index', () => {
  test('every entry points at a row that exists, and every anchored row has an entry', () => {
    const indexed = new Set(SETTINGS_INDEX.map((e) => e.anchor))
    expect(indexed.size).toBe(SETTINGS_INDEX.length)
    expect([...indexed].filter((a) => !anchors.has(a))).toEqual([])
    expect([...anchors].filter((a) => !indexed.has(a))).toEqual([])
  })

  test('every saved setting can be found', () => {
    const s = new SettingsStore(new Db(':memory:'), secrets).get() as unknown as Record<string, unknown>
    const keys: string[] = []
    for (const [k, v] of Object.entries(s)) {
      keys.push(k)
      if (v && typeof v === 'object' && !Array.isArray(v) && !['providers', 'sampling', 'botModes', 'fastMode', 'computerUse', 'modelContext', 'mcpServer', 'botAutonomy', 'botSwarm', 'voiceInput', 'keys', 'keysSaved', 'onshapeKeyParts'].includes(k)) for (const sub of Object.keys(v)) keys.push(`${k}.${sub}`)
    }
    const covered = new Set(SETTINGS_INDEX.flatMap((e) => e.keys ?? []))
    const missing = keys.filter((k) => !NOT_IN_SETTINGS.has(k) && !covered.has(k) && !covered.has(k.split('.')[0]))
    expect(missing).toEqual([])
  })

  test.each([
    ['dark mode', 'theme'],
    ['whisper', 'speech-model'],
    ['budget', 'monthly-limit'],
    ['openrouter', 'servers'],
    ['temperature', 'sampling'],
    ['fast mode', 'fast-mode'],
    ['passwords', 'passwords'],
    ['approval', 'approval-rules'],
    ['remember', 'remember-auto'],
    ['tiingo', 'tool-keys'],
    ['health', 'sensitive'],
    ['context window', 'context-window']
  ])('"%s" finds %s first', (q, anchor) => {
    expect(searchSettings(q)[0]?.anchor).toBe(anchor)
  })

  test('Advanced settings say so; old page ids still open the right page', () => {
    expect(searchSettings('openrouter')[0]).toMatchObject({ page: 'models', advanced: true })
    expect(searchSettings('nothing like this')).toEqual([])
    expect(searchSettings('whisper', { server: true })).toEqual([])
    for (const v of Object.values(LEGACY_PAGES)) expect(Object.keys(PAGE_TITLES)).toContain(v.page)
    expect(LEGACY_PAGES.passwords).toEqual({ page: 'privacy', tab: 'passwords' })
  })
})
