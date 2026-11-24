import { describe, expect, test } from 'vitest'
import { homeIdeas } from '../../src/main/ideas'

const none = { recent: [], apps: [], made: [], projects: [] }

describe('Home starter tiles', () => {
  test('a new user sees the generic set, and the deck tile has no fixed slide count', () => {
    const t = homeIdeas(none)
    expect(t.map((x) => x.label)).toEqual(['Plan a trip', 'Use my Mac', 'Morning brief', 'Make a deck', 'Build an app', 'Watch a page', 'Make a video'])
    expect(t.find((x) => x.label === 'Make a deck')!.text).not.toMatch(/\d+-slide/)
    expect(t.every((x) => !x.personal)).toBe(true)
  })

  test('habits, apps, files and projects come first; generic tiles fill the rest', () => {
    const t = homeIdeas({ recent: ['coding', 'coding', 'research', 'coding', 'chat'], apps: ['gmail', 'unknown-app'], made: ['.pptx', '.pptx'], projects: ['SahilBot'] })
    const labels = t.map((x) => x.label)
    expect(labels.length).toBe(7)
    expect(labels.slice(0, 3)).toEqual(expect.arrayContaining(['Fix or build code', 'Continue SahilBot', 'Triage my inbox']))
    expect(labels).toContain('Make a deck')
    expect(t.filter((x) => x.personal).length).toBeLessThanOrEqual(5)
    expect(new Set(labels).size).toBe(labels.length)
  })

  test('one stray request is not a habit; small talk never suggests anything', () => {
    const labels = homeIdeas({ ...none, recent: ['chat', 'chat', 'voice', 'math'] }).map((x) => x.label)
    expect(labels).not.toContain('Work it out')
    expect(labels[0]).toBe('Plan a trip')
  })

  test('long or empty project names are skipped', () => {
    const labels = homeIdeas({ ...none, projects: ['', 'x'.repeat(80)] }).map((x) => x.label)
    expect(labels.some((l) => l.startsWith('Continue'))).toBe(false)
  })
})
