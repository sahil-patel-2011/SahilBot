import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error plain ESM script without types
import { SERVER_STABLE, STABLE, findArtifacts, parseArgs, plan, prepare, releaseNotes, tagFor } from '../../scripts/release.mjs'

// The release workflow's publish step (scripts/release.mjs), run without gh.
describe('release script', () => {
  test('finds this build\'s DMG and ZIP, ignoring blockmaps and stable copies', () => {
    const files = ['SahilBot-0.1.0-42-arm64.dmg', 'SahilBot-0.1.0-42-arm64.dmg.blockmap', 'SahilBot-0.1.0-42-arm64.zip', 'latest-mac.yml', STABLE.dmg]
    expect(findArtifacts(files, '0.1.0', '42')).toEqual({ dmg: 'SahilBot-0.1.0-42-arm64.dmg', zip: 'SahilBot-0.1.0-42-arm64.zip' })
    expect(() => findArtifacts(['SahilBot-0.1.0-42-arm64.zip'], '0.1.0', '42')).toThrow(/one \.dmg/)
  })

  test('copies versioned and stable names with checksums', () => {
    const dist = mkdtempSync(join(tmpdir(), 'sb-release-'))
    writeFileSync(join(dist, 'SahilBot-0.1.0-7-arm64.dmg'), 'dmg')
    writeFileSync(join(dist, 'SahilBot-0.1.0-7-arm64.zip'), 'zip')
    const f = prepare({ dist, version: '0.1.0', build: '7' })
    for (const p of [...f.all, ...f.stable]) expect(existsSync(p)).toBe(true)
    expect(readFileSync(join(f.out, STABLE.dmg), 'utf8')).toBe('dmg')
    const sums = readFileSync(join(f.out, 'SHA256SUMS.txt'), 'utf8')
    expect(sums).toContain(`  ${STABLE.zip}`)
    expect(sums).toContain('  SahilBot-0.1.0-7-mac-arm64.dmg')
  })

  test('SahilBot Server tarballs in dist/server go along with versioned and stable names', () => {
    const dist = mkdtempSync(join(tmpdir(), 'sb-release-'))
    writeFileSync(join(dist, 'SahilBot-0.1.0-7-arm64.dmg'), 'dmg')
    writeFileSync(join(dist, 'SahilBot-0.1.0-7-arm64.zip'), 'zip')
    mkdirSync(join(dist, 'server'))
    writeFileSync(join(dist, 'server', SERVER_STABLE.arm64), 'pi')
    writeFileSync(join(dist, 'server', SERVER_STABLE.x64), 'vm')
    const f = prepare({ dist, version: '0.1.0', build: '7' })
    for (const n of [SERVER_STABLE.arm64, SERVER_STABLE.x64, 'SahilBot-server-0.1.0-7-linux-arm64.tar.gz']) expect(f.all).toContain(join(f.out, n))
    expect(f.stable).toContain(join(f.out, SERVER_STABLE.arm64))
    expect(readFileSync(join(f.out, SERVER_STABLE.x64), 'utf8')).toBe('vm')
    expect(readFileSync(join(f.out, 'SHA256SUMS.txt'), 'utf8')).toContain(`  ${SERVER_STABLE.arm64}`)
    const notes = releaseNotes({ version: '0.1.0', build: '7', sha: 'abcdef1', signing: 'adhoc', repo: 'o/r', server: f.server })
    expect(notes).toContain(`https://github.com/o/r/releases/latest/download/${SERVER_STABLE.arm64}`)
    expect(notes).toContain('install.sh')
    // Without server tarballs the Mac release is unchanged.
    expect(releaseNotes({ version: '0.1.0', build: '7', sha: 'abcdef1', signing: 'adhoc', repo: 'o/r' })).not.toContain('SahilBot Server')
  })

  test('the versioned release is Latest; the rolling one is a prerelease moved to the new commit', () => {
    const files = { all: ['a.dmg', 'a.zip', STABLE.dmg, STABLE.zip, 'SHA256SUMS.txt'], stable: [STABLE.dmg, STABLE.zip, 'SHA256SUMS.txt'] }
    const fresh = plan({ version: '0.1.0', build: '42', sha: 'abc', files, notesFile: 'n.md', rollingNotesFile: 'r.md', exists: () => false })
    expect(fresh[0].slice(0, 3)).toEqual(['release', 'create', 'v0.1.0-42'])
    expect(fresh[0]).toContain('--latest')
    expect(fresh[0]).not.toContain('--prerelease')
    expect(fresh.at(-1)!.slice(0, 3)).toEqual(['release', 'create', 'latest'])
    expect(fresh.at(-1)).toContain('--prerelease')
    // A re-run: replace the files and delete the old rolling release (and its tag) first.
    const rerun = plan({ version: '0.1.0', build: '42', sha: 'abc', files, notesFile: 'n.md', rollingNotesFile: 'r.md', exists: () => true })
    expect(rerun.map((s: string[]) => s.slice(0, 2).join(' '))).toEqual(['release upload', 'release edit', 'release delete', 'release create'])
    expect(rerun[0]).toContain('--clobber')
    expect(rerun[2]).toContain('--cleanup-tag')
  })

  test('notes explain the first launch unless notarized', () => {
    const o = { version: '0.1.0', build: '42', sha: '0123456789', repo: 'sahil-patel-2011/SahilBot' }
    expect(releaseNotes({ ...o, signing: 'adhoc' })).toMatch(/right-click.*Open/)
    expect(releaseNotes({ ...o, signing: 'adhoc' })).toContain('https://github.com/sahil-patel-2011/SahilBot/releases/latest/download/SahilBot-mac-arm64.dmg')
    expect(releaseNotes({ ...o, signing: 'notarized' })).not.toMatch(/right-click/)
    expect(tagFor('0.1.0', '42')).toBe('v0.1.0-42')
    expect(() => parseArgs(['--version', '0.1.0', '--build', 'x', '--sha', 'a', '--signing', 'adhoc'])).toThrow(/build/)
  })
})
