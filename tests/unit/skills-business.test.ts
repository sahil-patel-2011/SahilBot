import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { SkillStore } from '../../src/main/skills'

// Business and ideas packs for founders and "function bots": novel ideas with a novelty check, complaint
// mining, invoice collections, the weekly newsletter, meeting prep and contract scope lookups.

const PACKS = join(process.cwd(), 'packs', 'skills')
const store = new SkillStore(mkdtempSync(join(tmpdir(), 'sk-biz-')), PACKS)
const top = (q: string, k = 3): string[] => store.relevant(q).slice(0, k).map((r) => r.skill.name)
const raw = (n: string): string => readFileSync(join(PACKS, n, 'SKILL.md'), 'utf8')
const front = (n: string): Record<string, string> => Object.fromEntries((raw(n).match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '').split('\n').map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1], m[2].trim()]))

const NEW_PACKS: Record<string, string> = {
  'ideas-novelty-check': 'Ideas',
  'business-complaint-mining': 'Business',
  'business-invoice-collections': 'Business',
  'business-weekly-newsletter': 'Business',
  'business-meeting-prep': 'Business',
  'business-contract-scope': 'Business'
}

// [request, acceptable skills (any one in the top 3)]
const CASES: Array<[string, string[]]> = [
  ['give me novel startup ideas nobody has built yet', ['ideas-new-business']],
  ['does this idea already exist', ['ideas-novelty-check']],
  ['check if anyone built this already', ['ideas-novelty-check']],
  ['what are people complaining about with dental scheduling software on reddit', ['business-complaint-mining']],
  ['is this a real problem people would pay for', ['business-complaint-mining', 'ideas-validate-business']],
  ['which invoices are overdue and draft reminders', ['business-invoice-collections']],
  ["draft this week's newsletter from what shipped in slack", ['business-weekly-newsletter']],
  ['prep me for my 2pm', ['business-meeting-prep']],
  ['what scope did we agree with Client C', ['business-contract-scope']],
  ['do a market research report on the pet insurance industry with a competitor table', ['market-research']]
]

describe('business packs: format', () => {
  test('each new pack parses with name, description, category and triggers', () => {
    for (const [n, cat] of Object.entries(NEW_PACKS)) {
      const f = front(n)
      const sk = store.get(n)
      expect(sk, n).toBeDefined()
      expect(f.name, n).toBe(n)
      expect(f.source, n).toBe('you')
      expect(f.uses, n).toBe('0')
      expect(sk!.category, n).toBe(cat)
      expect(sk!.description.length, n).toBeGreaterThan(40)
      expect(sk!.description.length, n).toBeLessThanOrEqual(150)
      expect((f.triggers ?? '').split(',').map((t) => t.trim()).filter(Boolean).length, n).toBeGreaterThanOrEqual(8)
      expect(sk!.body, n).toMatch(/^## /m)
      expect(sk!.body.length, n).toBeLessThanOrEqual(4800)
    }
  })

  test('the function-bot packs search the brain first and cite sources as chips', () => {
    for (const n of ['business-invoice-collections', 'business-weekly-newsletter', 'business-meeting-prep', 'business-contract-scope']) {
      const b = store.get(n)!.body
      expect(b, n).toMatch(/`about`/)
      expect(b, n).toMatch(/`vault`/)
      expect(b, n).toMatch(/memory search/)
      expect(b, n).toMatch(/[A-Z][a-z]+ · [A-Z][a-z]{2} \d{1,2}/)
    }
    expect(store.get('business-contract-scope')!.body).toMatch(/not legal advice/)
    for (const n of ['business-invoice-collections', 'business-weekly-newsletter']) expect(store.get(n)!.body, n).toMatch(/[Nn]ever send/)
  })

  test('ideas run the novelty check and complaint mining; quotes are short and never invented', () => {
    const ideas = store.get('ideas-new-business')!.body
    expect(ideas).toContain('ideas-novelty-check')
    expect(ideas).toContain('business-complaint-mining')
    expect(ideas).toMatch(/New \/ Underserved niche \/ Crowded → reshaped \/ Dropped/)
    expect(store.get('ideas-validate-business')!.body).toContain('business-complaint-mining')
    expect(store.get('market-research')!.body).toContain('business-complaint-mining')
    const nc = store.get('ideas-novelty-check')!.body
    for (const s of ['site:producthunt.com', 'site:github.com', '"is there an app"', 'alternative to <X>', 'Google Patents']) expect(nc, s).toContain(s)
    expect(nc).toMatch(/[Aa]bsence of evidence/)
    const cm = store.get('business-complaint-mining')!.body
    expect(cm).toMatch(/under ~25 words/)
    expect(cm).toMatch(/[Nn]ever fabricate/)
    expect(cm).toMatch(/Go.*Reshape.*Kill/)
  })
})

describe('business packs: selection (SkillStore.relevant)', () => {
  test(`${CASES.length} requests pick the right skill in the top 3`, () => {
    const misses: string[] = []
    for (const [q, want] of CASES) {
      const got = top(q)
      if (!want.some((w) => got.includes(w))) misses.push(`${q} → want ${want.join(' or ')}, got ${got.join(', ') || '(none)'}`)
    }
    expect(misses).toEqual([])
  })

  test('each new pack is found from its own description', () => {
    const miss = Object.keys(NEW_PACKS).filter((n) => !top(store.get(n)!.description).includes(n))
    expect(miss).toEqual([])
  })
})
