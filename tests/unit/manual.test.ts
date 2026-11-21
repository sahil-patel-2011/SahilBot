import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Manual, manualTool, sections } from '../../src/main/agent/tools/manual'

// The agent's manual lookup over the real docs/ folder: plain questions find the page that answers them.
const DOCS = resolve(__dirname, '../../docs')
const manual = new Manual(DOCS)
const top = (q: string): string[] => manual.search(q, 3).map((h) => h.page)

describe('manual search finds the right page', () => {
  test.each([
    ['how do I hand a coding task to Cursor and review what comes back', 'coding-agents.md'],
    ['verify a PMID is real and not retracted', 'medical.md'],
    ['restore my API keys on a new Mac with the recovery password', 'backups.md'],
    ['make a financial model with formulas for the business', 'business.md'],
    ['tolerance stackup and stress calculation for a bracket', 'engineering.md'],
    ['make a deck and export it to PowerPoint', 'artifacts.md'],
    ['which permission mode asks before sending email', 'permissions.md'],
    ['decision log in the vault', 'vault.md']
  ])('%s → %s', (q, page) => {
    expect(top(q)).toContain(page)
  })

  test('results carry the page, heading and a snippet; one page never fills the list', () => {
    const hits = manual.search('Cursor cloud agents pull request', 6)
    expect(hits[0].heading.length).toBeGreaterThan(0)
    expect(hits[0].text.length).toBeGreaterThan(0)
    const perPage = new Map<string, number>()
    for (const h of hits) perPage.set(h.page, (perPage.get(h.page) ?? 0) + 1)
    expect(Math.max(...perPage.values())).toBeLessThanOrEqual(2)
  })

  test('nothing to search for returns nothing', () => {
    expect(manual.search('the of and')).toEqual([])
  })
})

describe('manual read', () => {
  test('a section by heading, loosely matched', () => {
    const r = manual.read('coding-agents', 'write the brief')
    expect(r.heading).toBe('Write the brief')
    expect(r.text).toContain('acceptance criteria')
  })
  test('a whole page is size-capped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manual-'))
    writeFileSync(join(dir, 'big.md'), `# Big\n\n## Part\n${'word '.repeat(10_000)}`)
    const r = new Manual(dir).read('big.md', undefined, 2000)
    expect(r.cut).toBe(true)
    expect(r.text.length).toBeLessThan(2200)
  })
  test('paths outside the manual are refused', () => {
    for (const bad of ['../package.json', '/etc/passwd', 'docs/../../secrets.md', 'sub/page.md', '..']) expect(() => manual.read(bad), bad).toThrow()
    expect(() => manual.read('docs/tools.md')).not.toThrow()
  })
  test('an unknown page or heading lists what exists', () => {
    expect(() => manual.read('nope.md')).toThrow(/Pages: .*tools\.md/)
    expect(() => manual.read('tools.md', 'no such heading')).toThrow(/Sections:/)
  })
})

describe('sections and the tool', () => {
  test('pages split into their ## sections, ### nested under them', () => {
    const s = sections('x.md', '# Title\nintro\n## One\na\n### Sub\nb\n## Two\nc')
    expect(s.map((x) => x.heading)).toEqual(['Title', 'One', 'One › Sub', 'Two'])
  })
  test('the tool is core, read-only, and returns readable text', async () => {
    const t = manualTool(DOCS)
    expect(t.core).toBe(true)
    expect(t.effect).toBe('read')
    const r = await t.run({ action: 'search', query: 'hand off to Cursor' } as never, {} as never) as { text: string }
    expect(r.text).toContain('coding-agents.md')
    const page = await t.run({ action: 'read', page: 'business.md', heading: 'Recurring work' } as never, {} as never) as { text: string }
    expect(page.text).toContain('schedule')
  })
})
