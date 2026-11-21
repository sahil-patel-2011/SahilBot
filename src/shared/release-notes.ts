import data from './release-notes.json'

// What's new, newest first: shown in Settings → Updates → What's new, once after an update, and on the
// GitHub release page (scripts/release.mjs reads the same JSON). Versions are dates, like Tesla's:
// YY.MM.DD (26.11.20). package.json's version must match the newest entry (tests/unit/release-notes.test.ts),
// so every release ships with notes. Several builds on one day share a version; the build number tells
// them apart.

export interface Release { version: string; date: string; title: string; highlights: string[]; sections: Array<{ title: string; items: string[] }> }

export const RELEASES: Release[] = data as Release[]

/** "26.11.20" → "November 20, 2026". */
export function releaseDate(r: Release): string {
  const d = new Date(`${r.date}T12:00:00Z`)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

/** Today's version string: YY.MM.DD. */
export function dateVersion(d = new Date()): string {
  return `${String(d.getFullYear()).slice(2)}.${d.getMonth() + 1}.${d.getDate()}`
}
