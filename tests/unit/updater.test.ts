import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { backupBeforeUpgrade, backupData, isNewer, parseTag, pruneBackups, sumFor, swapScript } from '../../src/main/updater'

// Updates never lose data: the data folder is copied before anything is replaced, only the app bundle is
// swapped (and put back if the swap fails), and a download is used only when its checksum matches.

describe('versions', () => {
  test('release tags are v<version>-<build>', () => {
    expect(parseTag('v0.1.0-131')).toEqual({ version: '0.1.0', build: 131 })
    expect(parseTag('latest')).toBeUndefined()
  })
  test('newer means a higher version, then a higher build', () => {
    expect(isNewer({ version: '0.1.0', build: 131 }, { version: '0.1.0', build: 128 })).toBe(true)
    expect(isNewer({ version: '0.1.0', build: 128 }, { version: '0.1.0', build: 128 })).toBe(false)
    expect(isNewer({ version: '0.2.0', build: 1 }, { version: '0.1.9', build: 500 })).toBe(true)
    expect(isNewer({ version: '0.1.0', build: 900 }, { version: '0.2.0', build: 1 })).toBe(false)
  })
  test('the checksum comes from SHA256SUMS.txt', () => {
    const a = 'a'.repeat(64), b = 'b'.repeat(64)
    expect(sumFor(`${a}  SahilBot-mac-arm64.dmg\n${b}  SahilBot-mac-arm64.zip\n`, 'SahilBot-mac-arm64.zip')).toBe(b)
    expect(sumFor(`${a}  other.zip\n`, 'SahilBot-mac-arm64.zip')).toBeUndefined()
  })
})

describe('backups', () => {
  test('a backup copies the data (minus caches and models) and keeps only the newest few', async () => {
    const data = mkdtempSync(join(tmpdir(), 'sb-data-'))
    const to = mkdtempSync(join(tmpdir(), 'sb-backups-'))
    writeFileSync(join(data, 'foreman.db'), 'DB')
    mkdirSync(join(data, 'spaces', 'bot1'), { recursive: true })
    writeFileSync(join(data, 'spaces', 'bot1', 'system.md'), 'You are a bot.')
    mkdirSync(join(data, 'models'))
    writeFileSync(join(data, 'models', 'whisper.bin'), 'big')
    mkdirSync(join(data, 'Cache'))
    const dest = await backupData(data, 'before 0.1.0 (build 131)', { to })
    expect(readFileSync(join(dest, 'foreman.db'), 'utf8')).toBe('DB')
    expect(readFileSync(join(dest, 'spaces', 'bot1', 'system.md'), 'utf8')).toBe('You are a bot.')
    expect(existsSync(join(dest, 'models'))).toBe(false)
    expect(existsSync(join(dest, 'Cache'))).toBe(false)
    // The original is untouched.
    expect(readFileSync(join(data, 'foreman.db'), 'utf8')).toBe('DB')
    for (let i = 0; i < 7; i++) mkdirSync(join(to, `2026-0${1 + (i % 9)}-01T00-00-0${i}Z old`))
    writeFileSync(join(to, 'not mine.txt'), 'kept')
    pruneBackups(to, 5)
    expect(readdirSync(to).filter((n) => /^\d{4}-/.test(n)).length).toBe(5)
    expect(existsSync(join(to, 'not mine.txt'))).toBe(true)
  })
})

describe('swap script', () => {
  const sh = (app: string, next: string, log: string, check = 'true'): void => {
    const script = join(mkdtempSync(join(tmpdir(), 'sb-swap-')), 'swap.sh')
    writeFileSync(script, swapScript(), { mode: 0o755 })
    // PID 999999 doesn't exist: no wait. SAHILBOT_OPEN=true: don't launch anything.
    execFileSync('/bin/sh', [script, '999999', app, next, log], { env: { ...process.env, SAHILBOT_OPEN: 'true', SAHILBOT_SETTLE: '0', SAHILBOT_CHECK: check } })
  }
  test('replaces the app bundle with the new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apps-'))
    const app = join(dir, 'SahilBot.app'), next = join(dir, 'stage', 'SahilBot.app')
    mkdirSync(app); writeFileSync(join(app, 'v'), 'old')
    mkdirSync(next, { recursive: true }); writeFileSync(join(next, 'v'), 'new')
    sh(app, next, join(dir, 'log'))
    expect(readFileSync(join(app, 'v'), 'utf8')).toBe('new')
    // The old copy stays until the new version has run cleanly for a minute (Updater.markHealthy removes it).
    expect(readFileSync(join(`${app}.previous`, 'v'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'log'), 'utf8')).toMatch(/updated/)
  })
  test('a new version that exits right after launch is rolled back to the old one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apps-'))
    const app = join(dir, 'SahilBot.app'), next = join(dir, 'stage', 'SahilBot.app')
    mkdirSync(app); writeFileSync(join(app, 'v'), 'old')
    mkdirSync(next, { recursive: true }); writeFileSync(join(next, 'v'), 'new')
    sh(app, next, join(dir, 'log'), 'false')
    expect(readFileSync(join(app, 'v'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'log'), 'utf8')).toMatch(/exited right after launch, restoring/)
  })
  test('a failed swap puts the old app back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sb-apps-'))
    const app = join(dir, 'SahilBot.app')
    mkdirSync(app); writeFileSync(join(app, 'v'), 'old')
    sh(app, join(dir, 'missing', 'SahilBot.app'), join(dir, 'log'))
    expect(readFileSync(join(app, 'v'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'log'), 'utf8')).toMatch(/restoring/)
  })
})


describe('backups in two places', () => {
  test('each backup is copied to a second folder, which keeps its newest three', async () => {
    const data = mkdtempSync(join(tmpdir(), 'sb-two-data-')), to = mkdtempSync(join(tmpdir(), 'sb-two-a-')), mirror = mkdtempSync(join(tmpdir(), 'sb-two-b-'))
    writeFileSync(join(data, 'settings.json'), '{"x":1}')
    for (let i = 0; i < 5; i++) await backupData(data, `copy ${i}`, { to, mirror, now: new Date(Date.UTC(2026, 10, 20, 10, i)) })
    const a = readdirSync(to).filter((n) => /^\d{4}/.test(n)), b = readdirSync(mirror).filter((n) => /^\d{4}/.test(n))
    expect(a).toHaveLength(5)
    expect(b).toHaveLength(3)
    expect(b.every((n) => a.includes(n))).toBe(true)
    expect(readFileSync(join(mirror, b[2], 'settings.json'), 'utf8')).toBe('{"x":1}')
  })
})

describe('backup failures and legacy upgrade protection', () => {
  test('a failed SQLite snapshot stops backup instead of copying an inconsistent live WAL', async () => {
    const data = mkdtempSync(join(tmpdir(), 'sb-failed-data-')), to = mkdtempSync(join(tmpdir(), 'sb-failed-backup-'))
    writeFileSync(join(data, 'foreman.db'), 'original')
    await expect(backupData(data, 'failure', { to, vacuumInto: () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
    expect(readFileSync(join(data, 'foreman.db'), 'utf8')).toBe('original')
    expect(readdirSync(to).some((n) => existsSync(join(to, n, '.complete.json')))).toBe(false)
  })
  test('an existing install without a version marker is backed up before its first upgrade', () => {
    const data = mkdtempSync(join(tmpdir(), 'sb-legacy-data-')), to = mkdtempSync(join(tmpdir(), 'sb-legacy-backup-'))
    writeFileSync(join(data, 'foreman.db'), 'bots, connectors, chats and onboarding')
    const backup = backupBeforeUpgrade(data, '0.1.0', 123, to)!
    expect(readFileSync(join(backup, 'foreman.db'), 'utf8')).toBe('bots, connectors, chats and onboarding')
    expect(backupBeforeUpgrade(data, '0.1.0', 123, to)).toBeUndefined()
  })
  test('a backup cannot be placed within the data folder', async () => {
    const data = mkdtempSync(join(tmpdir(), 'sb-loop-data-'))
    await expect(backupData(data, 'no recursive backup', { to: join(data, 'backups') })).rejects.toThrow('separate')
  })
})

describe('download progress', () => {
  test('"90 of 215 MB": whole megabytes, never past the total, nothing without a size', async () => {
    const { downloadedText } = await import('../../src/shared/bytes')
    expect(downloadedText(90_400_000, 214_566_926)).toBe('90 of 215 MB')
    expect(downloadedText(0, 214_566_926)).toBe('0 of 215 MB')
    expect(downloadedText(214_566_926, 214_566_926)).toBe('215 of 215 MB')
    expect(downloadedText(300_000_000, 214_566_926)).toBe('215 of 215 MB')
    expect(downloadedText(undefined, 214_566_926)).toBe('0 of 215 MB')
    expect(downloadedText(5, 0)).toBe('')
  })
})
