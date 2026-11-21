import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { RELEASES, releaseDate } from '../../src/shared/release-notes'
// @ts-expect-error plain ESM script
import { notesProblem, whatsNew } from '../../scripts/release.mjs'

test('every release ships with notes: package.json is the newest What\'s new entry, versions are dates (YY.MM.DD)', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
  expect(RELEASES[0].version).toBe(pkg.version)
  for (const r of RELEASES) {
    expect(r.version).toMatch(/^\d{2}\.\d{1,2}\.\d{1,2}$/)
    const [y, m, d] = r.version.split('.').map(Number)
    expect(r.date).toBe(`20${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
    expect(r.title.length).toBeGreaterThan(5)
    expect(r.highlights.length).toBeGreaterThan(0)
    expect(r.sections.every((s) => s.items.length > 0)).toBe(true)
  }
  // Newest first, no repeats.
  expect(RELEASES.map((r) => r.date)).toEqual([...RELEASES.map((r) => r.date)].sort().reverse())
  expect(new Set(RELEASES.map((r) => r.version)).size).toBe(RELEASES.length)
  const [y, m, d] = RELEASES[0].date.split('-').map(Number)
  expect(releaseDate(RELEASES[0])).toBe(new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }))
})

test('the GitHub release page carries the same notes', () => {
  const md = whatsNew(RELEASES[0].version) as string
  expect(md).toContain(`What's new in ${RELEASES[0].version}`)
  expect(md).toContain(RELEASES[0].sections[0].items[0])
  expect(whatsNew('0.0.1')).toBe('')
})

test('a release is refused without notes for its version, or when the notes are more than two days old', () => {
  const v = RELEASES[0].version
  const day = new Date(`${RELEASES[0].date}T12:00:00Z`)
  expect(notesProblem(v, day)).toBe('')
  expect(notesProblem(v, new Date(day.getTime() + 2 * 86_400_000))).toBe('')
  expect(notesProblem(v, new Date(day.getTime() + 3 * 86_400_000))).toMatch(/3 days ago/)
  expect(notesProblem('0.1.0', day)).toMatch(/isn't a date|no notes/)
  expect(notesProblem('26.1.1', day)).toMatch(/no notes for 26.1.1/)
})
