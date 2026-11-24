import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Db } from '../../src/main/db'
import { SettingsStore } from '../../src/main/settings'
import { LEGACY_PAGES, NOT_IN_SETTINGS, PAGE_TITLES, SECTION_OF, SETTINGS_INDEX, searchSettings, sectionTitle } from '../../src/renderer/src/lib/settings-index'

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
    ['budget', 'monthly-limit'],
    ['passwords', 'passwords'],
    ['approval', 'autonomy'],
    ['remember', 'remember-auto'],
    ['grok', 'key-xai'],
    ['login', 'open-at-login'],
    ['microphone', 'mac-permissions']
  ])('"%s" finds %s first', (q, anchor) => {
    expect(searchSettings(q)[0]?.anchor).toBe(anchor)
  })

  test('⌘K finds Developer mode settings only in Developer mode', () => {
    // Settings shows the basics; these rows show in Developer mode only, so search lists them only then.
    const devOnly = ['birthday', 'workspace', 'quick-ask', 'dev-mode', 'auto-prefers', 'local-models', 'model-list', 'mcp-server', 'speech-model', 'backups', 'usage', 'phone-access']
    expect(SETTINGS_INDEX.filter((e) => e.devOnly).map((e) => e.anchor).sort()).toEqual([...devOnly].sort())
    for (const [q, anchor] of [['whisper', 'speech-model'], ['workspace folder', 'workspace'], ['birthday', 'birthday'], ['backup', 'backups'], ['ollama', 'local-models'], ['developer', 'dev-mode'], ['quick ask', 'quick-ask']]) {
      expect(searchSettings(q).map((e) => e.anchor), q).not.toContain(anchor)
      expect(searchSettings(q, { dev: true })[0]?.anchor, q).toBe(anchor)
    }
    // The basics are found either way.
    for (const a of ['user-name', 'me-contact', 'theme', 'open-at-login', 'updates', 'key-anthropic', 'key-openai', 'key-xai', 'chatgpt-plan', 'grok-plan', 'monthly-limit', 'connect-apps', 'voice-openai', 'mac-permissions', 'passwords'])
      expect(SETTINGS_INDEX.find((e) => e.anchor === a)?.devOnly, a).toBeFalsy()
  })

  test('results name the page they open on; old and folded page ids still open the right page', () => {
    expect(sectionTitle('general')).toBe('General')
    expect(sectionTitle('models')).toBe('AI')
    expect(sectionTitle('usage')).toBe('AI')
    expect(sectionTitle('permissions')).toBe('Privacy')
    expect(sectionTitle('memory')).toBe('Memory')
    expect(LEGACY_PAGES.keys).toEqual({ page: 'models' })
    // Memory isn't listed in Settings any more, but a link or a search still opens it there.
    expect(SECTION_OF.memory).toBe('memory')
    expect(searchSettings('remember')[0]).toMatchObject({ anchor: 'remember-auto', page: 'memory' })
  })

  test('removed settings are gone from search; old page ids still open the right page', () => {
    // Nov 2026: the advanced settings were removed (the bot picks sensible defaults; ask it in chat for the rest).
    for (const q of ['openrouter', 'temperature', 'fast mode', 'tiingo', 'text size', 'chat width', 'tint']) expect(searchSettings(q).filter((e) => e.advanced)).toEqual([])
    expect(searchSettings('nothing like this')).toEqual([])
    expect(searchSettings('whisper', { server: true })).toEqual([])
    for (const v of Object.values(LEGACY_PAGES)) expect(Object.keys(PAGE_TITLES)).toContain(v.page)
    expect(LEGACY_PAGES.passwords).toEqual({ page: 'privacy', tab: 'passwords' })
  })
})
