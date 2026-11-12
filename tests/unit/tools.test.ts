import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { insideRoot, fileTools, resolvePath } from '../../src/main/agent/tools/files'
import { ToolRegistry } from '../../src/main/agent/registry'
import { emptyState, type ToolDef } from '../../src/main/agent/types'
import { chunk, readable } from '../../src/main/agent/tools/web'

describe('workspace sandbox', () => {
  const root = mkdtempSync(join(tmpdir(), 'ws-'))
  test('rejects .. and absolute escapes', () => {
    expect(() => insideRoot(root, '../x')).toThrow(/outside/)
    expect(() => insideRoot(root, '/etc/passwd')).toThrow(/outside/)
    expect(insideRoot(root, 'a/b.txt')).toMatch(/a\/b\.txt$/)
  })
  test('rejects symlinks that point outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'out-'))
    symlinkSync(outside, join(root, 'link'))
    expect(() => insideRoot(root, 'link/secret.txt')).toThrow(/outside/)
  })
  test('file_write keeps a backup on overwrite and file_read reads docs', async () => {
    const docs = mkdtempSync(join(tmpdir(), 'docs-'))
    writeFileSync(join(docs, 'index.md'), '# Manual')
    const [read, write] = fileTools(() => root, docs)
    const ctx = { state: { roots: [] } } as never
    await write.run({ path: 'notes/a.md', content: 'v1' }, ctx)
    await write.run({ path: 'notes/a.md', content: 'v2' }, ctx)
    expect((await read.run({ path: 'notes/a.md' }, ctx)).text).toBe('v2')
    expect((await read.run({ path: '.foreman/backups' }, ctx)).text).toMatch(/notes__a\.md/)
    expect((await read.run({ path: 'docs/index.md' }, ctx)).text).toBe('# Manual')
    await expect(write.run({ path: 'notes/a.md', content: 'x', mode: 'create' }, ctx)).rejects.toThrow(/already exists/)
  })
})

describe('attached folders', () => {
  test('absolute paths work only inside attached roots', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    const attached = mkdtempSync(join(tmpdir(), 'att-'))
    const other = mkdtempSync(join(tmpdir(), 'other-'))
    writeFileSync(join(attached, 'notes.txt'), 'hello')
    writeFileSync(join(other, 'secret.txt'), 'nope')
    const [read, write] = fileTools(() => ws, ws)
    const ctx = { state: { roots: [attached] } } as never
    expect((await read.run({ path: join(attached, 'notes.txt') }, ctx)).text).toBe('hello')
    await write.run({ path: join(attached, 'new.md'), content: 'x' }, ctx)
    expect(resolvePath(join(attached, 'new.md'), ws, [attached])).toBe(join(attached, 'new.md'))
    await expect(read.run({ path: join(other, 'secret.txt') }, ctx)).rejects.toThrow(/attached/)
    await expect(write.run({ path: join(attached, '../escape.txt'), content: 'x' }, ctx)).rejects.toThrow(/attached/)
  })
  test('deleting asks even in Bypass; move onto an existing file is destructive', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    writeFileSync(join(ws, 'a.txt'), '1')
    writeFileSync(join(ws, 'b.txt'), '2')
    const manage = fileTools(() => ws, ws).find((t) => t.name === 'file_manage')!
    expect(manage.hardStop!({ op: 'delete', path: 'a.txt' })).toMatch(/Trash/)
    expect((manage.effect as (a: unknown) => string)({ op: 'delete', path: 'a.txt' })).toBe('destructive')
    expect((manage.effect as (a: unknown) => string)({ op: 'move', path: 'a.txt', to: 'b.txt' })).toBe('destructive')
    expect((manage.effect as (a: unknown) => string)({ op: 'move', path: 'a.txt', to: 'c.txt' })).toBe('write_local')
  })
})

describe('tool registry', () => {
  const mk = (name: string, core = false): ToolDef => ({ name, core, label: name, effect: 'read', description: name, parameters: { type: 'object' }, run: async () => ({ text: '' }) })
  test('loads connector tools without a cap and only appends', () => {
    const r = new ToolRegistry()
    r.register(...Array.from({ length: 9 }, (_, i) => mk(`core${i}`, true)), ...Array.from({ length: 10 }, (_, i) => mk(`gmail_${i}`)))
    const state = emptyState()
    r.load(state, ['gmail_0', 'gmail_1'])
    const before = r.listFor(state).map((t) => t.name)
    r.load(state, ['gmail_2'])
    const after = r.listFor(state).map((t) => t.name)
    expect(after.slice(0, before.length)).toEqual(before)
    r.load(state, ['gmail_3', 'gmail_4', 'gmail_5'])
    expect(r.listFor(state)).toHaveLength(9 + 6)
    expect(r.listFor(state).slice(0, 9).every((t) => t.core)).toBe(true)
  })
  test('search ranks by name and group', () => {
    const r = new ToolRegistry()
    r.register({ ...mk('gmail_search'), group: 'Gmail', description: 'Search email' }, { ...mk('calendar_list'), group: 'Calendar', description: 'List events' })
    expect(r.search('gmail', emptyState())[0].name).toBe('gmail_search')
  })
})

describe('fetch_page helpers', () => {
  test('readable text drops scripts and nav', () => {
    const html = `<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><article><h1>Hello</h1><p>${'Real content. '.repeat(40)}</p></article></body></html>`
    const r = readable(html, 'https://x.test')
    expect(r.text).toContain('Real content.')
    expect(r.text).not.toContain('evil()')
  })
  test('chunks are ~1.5k tokens', () => {
    const parts = chunk('word '.repeat(5000))
    expect(parts.length).toBeGreaterThan(3)
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(5250)
  })
})

import { parseBing, parseDuckDuckGo, parseDuckDuckGoLite, parseMojeek } from '../../src/main/agent/tools/web'
import { citedUrls } from '../../src/main/agent/loop'
describe('research helpers', () => {
  test('DuckDuckGo HTML results decode the real URL and drop ads', () => {
    const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fqwen.ai%2Fblog%2Fqwen3.8&rut=x">Qwen3.8 is here</a><a class="result__snippet">Released today.</a></div>
      <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`
    expect(parseDuckDuckGo(html)).toEqual([{ title: 'Qwen3.8 is here', url: 'https://qwen.ai/blog/qwen3.8', snippet: 'Released today.' }])
  })
  test('cited URLs are extracted without trailing punctuation', () => {
    expect(citedUrls('See [1] https://a.com/x. And (https://b.org/y), done')).toEqual(['https://a.com/x', 'https://b.org/y'])
  })
})

describe('keyless search fallbacks parse their pages', () => {
  test('DuckDuckGo Lite, Bing and Mojeek', () => {
    expect(parseDuckDuckGoLite('<table><tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fanthropic.com%2Fcompany">Company</a></td></tr><tr><td class="result-snippet">About us</td></tr></table>'))
      .toEqual([{ title: 'Company', url: 'https://anthropic.com/company', snippet: 'About us' }])
    const enc = Buffer.from('https://en.wikipedia.org/wiki/Anthropic').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(parseBing(`<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&&p=x&u=a1${enc}&ntb=1">Anthropic - Wikipedia</a></h2><div class="b_caption"><p>An AI company.</p></div></li></ol>`))
      .toEqual([{ title: 'Anthropic - Wikipedia', url: 'https://en.wikipedia.org/wiki/Anthropic', snippet: 'An AI company.' }])
    expect(parseMojeek('<ul class="results-standard"><li><a class="title" href="https://example.com/a">A</a><p class="s">snip</p></li></ul>'))
      .toEqual([{ title: 'A', url: 'https://example.com/a', snippet: 'snip' }])
  })
})
