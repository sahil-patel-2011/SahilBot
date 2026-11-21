import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { UpdateStatus } from '@shared/types'

// In-app updates for the Mac app. Builds are signed ad hoc unless a Developer ID is set up, which Squirrel
// (electron-updater) refuses, so SahilBot installs updates itself:
//   1. read the newest GitHub release (tag v<version>-<build>) and compare its build with this one;
//   2. download SahilBot-mac-arm64.zip next to the user's data (never inside it), check its SHA-256 against
//      the release's SHA256SUMS.txt, unpack it with ditto and check the signature and the build inside;
//   3. on "Restart to update": copy the user's data to a backup folder, quit, and let a small script swap
//      the app bundle once SahilBot has exited (putting the old one back if anything fails), then reopen it.
// The data folder (chats, bots, memories, connectors, settings, onboarding) is never touched: the app bundle
// is the only thing replaced, and a dated copy of the data stays in "SahilBot Backups".

export const REPO = 'sahil-patel-2011/SahilBot'
export const ASSET = 'SahilBot-mac-arm64.zip'
const SUMS = 'SHA256SUMS.txt'
/** Copies of the data folder kept in the backups folder (oldest go first). */
export const KEEP_BACKUPS = 5
/** Big, re-downloadable or throwaway parts of the data folder left out of a backup. */
const SKIP = new Set(['models', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'ShaderCache', 'blob_storage', 'logs'])

export const backupsDir = (): string => join(homedir(), 'Library', 'Application Support', 'SahilBot Backups')
/** The second copy of every backup, in a separate folder (your home folder, not iCloud-synced Documents). */
export const mirrorBackupsDir = (): string => join(homedir(), 'SahilBot Backups')
export const KEEP_MIRROR = 3
const updatesDir = (): string => join(homedir(), 'Library', 'Application Support', 'SahilBot Updates')

/** "v0.1.0-128" → { version: '0.1.0', build: 128 }. */
export function parseTag(tag: string): { version: string; build: number } | undefined {
  const m = /^v?(\d+\.\d+\.\d+)-(\d+)$/.exec(tag.trim())
  return m ? { version: m[1], build: Number(m[2]) } : undefined
}

const semver = (v: string): number[] => v.split('.').map((x) => Number(x) || 0)

/** Whether a release is newer than this build: the version first, then the build number. */
export function isNewer(release: { version: string; build: number }, current: { version: string; build: number }): boolean {
  const a = semver(release.version), b = semver(current.version)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return release.build > current.build
}

/** The SHA-256 for a file name from a SHA256SUMS.txt body. */
export function sumFor(sums: string, file: string): string | undefined {
  for (const line of sums.split('\n')) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (m && m[2] === file) return m[1]
  }
  return undefined
}

/** The .app bundle this process runs from (/Applications/SahilBot.app). */
export const bundleOf = (execPath: string): string => resolve(execPath, '..', '..', '..')

/** CFBundleVersion (the build number) from an app bundle's Info.plist. */
export function bundleBuild(bundle: string): number {
  try {
    const plist = join(bundle, 'Contents', 'Info.plist')
    const xml = /<key>CFBundleVersion<\/key>\s*<string>(\d+)<\/string>/.exec(readFileSync(plist, 'utf8'))?.[1]
    if (xml) return Number(xml)
    // A binary plist: plutil reads it.
    return Number(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', plist], { encoding: 'utf8', timeout: 5000 }).trim()) || 0
  } catch { return 0 }
}

const run = (cmd: string, args: string[]): Promise<void> => new Promise((ok, fail) => execFile(cmd, args, { timeout: 10 * 60_000 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim().slice(0, 300))) : ok())))
/** Copies a file or folder: ditto on the Mac (keeps extended attributes), plain fs elsewhere (Linux server, tests). */
const copyTree = (from: string, to: string): Promise<void> => existsSync('/usr/bin/ditto') ? run('/usr/bin/ditto', [from, to]) : Promise.resolve(cpSync(from, to, { recursive: true, verbatimSymlinks: true }))

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(path), h)
  return h.digest('hex')
}

/**
 * Copies the data folder to a dated backup (the database consistently, everything else as is, minus caches
 * and re-downloadable models) and keeps the newest KEEP_BACKUPS. Returns the backup's folder.
 */
export async function backupData(dataDir: string, label: string, o: {
  vacuumInto?: (path: string) => void; now?: Date; to?: string; mirror?: string | null
  /** Adds what lives outside the data folder (backup.ts: the knowledge vault, a readable export, the key recovery file). */
  extras?: (dest: string) => Promise<void> | void
  /** A third copy in a folder the user picked (Settings → Backups), keeping its newest KEEP_MIRROR. */
  extraMirror?: string
} = {}): Promise<string> {
  const root = o.to ?? backupsDir()
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  if (resolve(root) === resolve(dataDir) || resolve(root).startsWith(resolve(dataDir) + '/')) throw new Error('The backup location must be separate from the live data folder.')
  mkdirSync(root, { recursive: true })
  const dest = mkdtempSync(join(root, `${stamp} ${label}`.replace(/[^\w .-]+/g, '_') + '-'))
  for (const name of readdirSync(dataDir)) {
    if (SKIP.has(name) || /^foreman\.db(-wal|-shm)?$/.test(name) || name.startsWith('Singleton')) continue
    await copyTree(join(dataDir, name), join(dest, name))
    if (!existsSync(join(dest, name))) throw new Error(`Backup did not copy ${name}. The update has been stopped.`)
  }
  // The database: a consistent copy while it's open (VACUUM INTO), else the files themselves.
  const db = join(dataDir, 'foreman.db')
  if (o.vacuumInto) {
    // Never silently fall back to copying a live SQLite WAL: it can yield an inconsistent backup.
    o.vacuumInto(join(dest, 'foreman.db'))
    if (existsSync(db) && !existsSync(join(dest, 'foreman.db'))) throw new Error('The database backup was not created. Nothing has been updated.')
  } else for (const s of ['', '-wal', '-shm']) if (existsSync(db + s)) copyFileSync(db + s, join(dest, `foreman.db${s}`))
  if (o.extras) { try { await o.extras(dest) } catch (e) { console.error('[backup] extras:', (e as Error).message) } }
  writeFileSync(join(dest, 'README.txt'), `A copy of SahilBot's data (${label}). To restore it, quit SahilBot and copy these files back into:\n${dataDir}\n`)
  writeFileSync(join(dest, '.complete.json'), JSON.stringify({ at: Date.now(), source: resolve(dataDir), label, entries: readdirSync(dest) }))
  pruneBackups(root)
  // The same backup in a second place, so losing one folder never loses the data.
  const mirror = o.mirror === undefined ? (o.to ? undefined : mirrorBackupsDir()) : o.mirror || undefined
  if (mirror && resolve(mirror) !== resolve(root)) {
    try {
      mkdirSync(mirror, { recursive: true })
      await copyTree(dest, join(mirror, basename(dest)))
      pruneBackups(mirror, KEEP_MIRROR)
    } catch (e) { console.error('[backup] second copy failed:', (e as Error).message) }
  }
  if (o.extraMirror && ![root, mirror].some((m) => m && resolve(m) === resolve(o.extraMirror!))) {
    try {
      mkdirSync(o.extraMirror, { recursive: true })
      await copyTree(dest, join(o.extraMirror, basename(dest)))
      pruneBackups(o.extraMirror, KEEP_MIRROR)
    } catch (e) { console.error('[backup] extra copy failed:', (e as Error).message) }
  }
  return dest
}

/** Keeps the newest KEEP_BACKUPS backups (only folders this module made: they start with a date). */
export function pruneBackups(root: string, keep = KEEP_BACKUPS): void {
  if (!existsSync(root)) return
  const dated = readdirSync(root).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort()
  for (const old of dated.slice(0, Math.max(0, dated.length - keep))) rmSync(join(root, old), { recursive: true, force: true })
}

/**
 * First start of a new version: back up the database before migrations run (a copy of the files: the
 * database isn't open yet). Remembers the version in the data folder. Never runs on a fresh install.
 */
export function backupBeforeUpgrade(dataDir: string, version: string, build: number, root = backupsDir()): string | undefined {
  const marker = join(dataDir, '.sahilbot-version')
  const now = `${version}-${build}`
  const was = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined
  let dest: string | undefined
  if (was !== now && existsSync(join(dataDir, 'foreman.db'))) {
    dest = join(root, `${new Date().toISOString().replace(/[:.]/g, '-')} database before ${now} (from ${was ?? 'earlier install'})`)
    mkdirSync(dest, { recursive: true })
    for (const s of ['', '-wal', '-shm']) if (existsSync(join(dataDir, `foreman.db${s}`))) copyFileSync(join(dataDir, `foreman.db${s}`), join(dest, `foreman.db${s}`))
    pruneBackups(root)
  }
  if (was !== now) writeFileSync(marker, now)
  return dest
}

/** The swap script: waits for SahilBot to exit, swaps the bundle (rolling back on failure), reopens it. */
export function swapScript(): string {
  return `#!/bin/sh
# $1 pid  $2 installed app  $3 new app  $4 log
PID="$1"; APP="$2"; NEW="$3"; LOG="$4"; OPEN="\${SAHILBOT_OPEN:-open}"
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 600 ]; do sleep 0.2; i=$((i+1)); done
if kill -0 "$PID" 2>/dev/null; then echo "update cancelled: app is still running" >> "$LOG"; exit 1; fi
OLD="$APP.previous"
rm -rf "$OLD"
# A leftover that can't be removed would swallow the app (mv into a folder): stop instead.
if [ -e "$OLD" ]; then echo "update cancelled: could not clear $OLD" >> "$LOG"; "$OPEN" "$APP"; exit 1; fi
if ! mv "$APP" "$OLD"; then
  echo "update cancelled: could not preserve installed app" >> "$LOG"
  "$OPEN" "$APP"
  exit 1
fi
if mv "$NEW" "$APP"; then
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null
  echo "updated $(date)" >> "$LOG"
  CHECK="\${SAHILBOT_CHECK:-pgrep -f}"
  if ! "$OPEN" "$APP"; then
    mv "$APP" "$NEW.failed"
    mv "$OLD" "$APP"
    echo "launch failed, restoring $(date)" >> "$LOG"
    "$OPEN" "$APP"
  else
    # Still running after a while? If the new version quit or crashed straight away, put the old one back.
    # (Once it has run cleanly for a minute, the new app removes the old copy itself: Updater.markHealthy.)
    sleep "\${SAHILBOT_SETTLE:-25}"
    if ! $CHECK "$APP/Contents/MacOS/" >/dev/null 2>&1; then
      echo "new version exited right after launch, restoring $(date)" >> "$LOG"
      rm -rf "$NEW.failed"
      mv "$APP" "$NEW.failed" && mv "$OLD" "$APP" && "$OPEN" "$APP"
    fi
  fi
else
  echo "update failed, restoring $(date)" >> "$LOG"
  # A failed cross-volume move can leave a partial destination: never mistake it for a working app.
  if [ -e "$APP" ]; then mv "$APP" "$NEW.failed" || exit 1; fi
  mv "$OLD" "$APP" || exit 1
  "$OPEN" "$APP"
fi
`
}

export interface UpdaterDeps {
  execPath: string
  version: string
  packaged: boolean
  dataDir: string
  emit(status: UpdateStatus): void
  quit(): void
  openUrl(url: string): void
  /** A consistent copy of the open database (Db VACUUM INTO). */
  vacuumInto?(path: string): void
  /** The daily backup goes through Settings → Backups (backup.ts), so it carries the vault, export and key recovery file. */
  dailyBackup?(): Promise<unknown>
  fetch?: typeof fetch
}

export interface ReleaseSize { version: string; build: number; size: number; date: string }

export class Updater {
  private status: UpdateStatus = { state: 'idle' }
  private staged?: { app: string; tag: string }
  private checking?: Promise<UpdateStatus>
  private timer?: ReturnType<typeof setInterval>
  private etag?: string
  private lastRelease?: unknown
  private startup?: ReturnType<typeof setTimeout>
  private backupTimer?: ReturnType<typeof setInterval>
  private backingUp = false
  private installing?: Promise<UpdateStatus>

  constructor(private d: UpdaterDeps) {}

  get current(): { version: string; build: number } {
    return { version: this.d.version, build: this.d.packaged ? bundleBuild(bundleOf(this.d.execPath)) : 0 }
  }

  get(): UpdateStatus { return { ...this.status, current: `${this.current.version} (build ${this.current.build})` } }

  private set(s: UpdateStatus): UpdateStatus { this.status = s; const out = this.get(); this.d.emit(out); return out }

  /** Checks shortly after start, then every 5 minutes (and when the Mac wakes: index.ts); a found update downloads in the background. */
  start(): void {
    if (!this.d.packaged || process.platform !== 'darwin') return
    this.cleanup()
    this.healthTimer = setTimeout(() => this.markHealthy(), 60_000)
    this.startup = setTimeout(() => { void this.check().catch(() => undefined); void this.maintainBackup() }, 10_000)
    this.backupTimer = setInterval(() => void this.maintainBackup(), 24 * 3600_000)
    this.timer = setInterval(() => void this.check().catch(() => undefined), 5 * 60_000)
  }

  /**
   * Leftovers from earlier updates: the old "SahilBot.app.previous" next to the app (it showed up in
   * Spotlight as a second SahilBot), staging copies, and downloads of versions already installed.
   */
  cleanup(): void {
    const installed = bundleOf(this.d.execPath)
    for (const p of [`${installed}.update-staging`, `${installed}.update-staging.failed`]) {
      try { if (existsSync(p)) rmSync(p, { recursive: true, force: true }) } catch { /* not ours to remove */ }
    }
    try {
      const dir = updatesDir()
      for (const n of existsSync(dir) ? readdirSync(dir) : []) {
        const t = parseTag(n)
        if (t && !isNewer(t, this.current)) rmSync(join(dir, n), { recursive: true, force: true })
      }
    } catch { /* ignore */ }
  }

  private healthTimer?: ReturnType<typeof setTimeout>
  /**
   * This version has run cleanly for a minute: remove the copy of the previous version the update kept for
   * rollback, so only one SahilBot is installed (and Spotlight shows one).
   */
  markHealthy(): void {
    const prev = `${bundleOf(this.d.execPath)}.previous`
    try { if (existsSync(prev)) rmSync(prev, { recursive: true, force: true }) } catch { /* not ours to remove */ }
  }

  stop(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer); if (this.timer) clearInterval(this.timer); if (this.startup) clearTimeout(this.startup); if (this.backupTimer) clearInterval(this.backupTimer) }

  /** Keep a recent secondary copy even between app updates. Failure never replaces the live profile. */
  private async maintainBackup(): Promise<void> {
    if (this.backingUp || this.installing || !existsSync(this.d.dataDir)) return
    const root = backupsDir()
    const completed = existsSync(root) ? readdirSync(root).filter((n) => existsSync(join(root, n, '.complete.json'))).sort().at(-1) : undefined
    if (completed && Date.now() - statSync(join(root, completed, '.complete.json')).mtimeMs < 24 * 3600_000) return
    this.backingUp = true
    try { await (this.d.dailyBackup ? this.d.dailyBackup() : backupData(this.d.dataDir, 'daily profile copy', { vacuumInto: this.d.vacuumInto })) }
    catch (e) { console.error('[backup]', (e as Error).message) }
    finally { this.backingUp = false }
  }

  private historyCache?: { at: number; list: ReleaseSize[] }
  /** Published versions with their download size (Settings → What's new), cached for 10 minutes. */
  async history(): Promise<ReleaseSize[]> {
    if (this.historyCache && Date.now() - this.historyCache.at < 10 * 60_000) return this.historyCache.list
    const f = this.d.fetch ?? fetch
    try {
      const res = await f(`https://api.github.com/repos/${REPO}/releases?per_page=40`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'SahilBot' }, signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return this.historyCache?.list ?? []
      const rels = await res.json() as Array<{ tag_name: string; published_at?: string; assets: Array<{ name: string; size: number }> }>
      const list = rels.flatMap((r) => {
        const t = parseTag(r.tag_name)
        const zip = r.assets.find((a) => a.name === ASSET)
        return t && zip ? [{ version: t.version, build: t.build, size: zip.size, date: r.published_at ?? '' }] : []
      })
      this.historyCache = { at: Date.now(), list }
      return list
    } catch { return this.historyCache?.list ?? [] }
  }

  check(): Promise<UpdateStatus> {
    if (this.status.state === 'ready' || this.status.state === 'installing') return Promise.resolve(this.get())
    this.checking ??= this.doCheck().finally(() => { this.checking = undefined })
    return this.checking
  }

  private async doCheck(): Promise<UpdateStatus> {
    if (!this.d.packaged) return this.set({ state: 'unsupported', detail: 'Updates install in the app from Applications, not in development.' })
    // A copy built on this Mac (npm run install:mac) has no release build number: a release could be older code.
    if (!this.current.build) return this.set({ state: 'unsupported', detail: 'This copy was built on this Mac, so it doesn\'t replace itself with a release. Rebuild it to update.' })
    const f = this.d.fetch ?? fetch
    this.set({ state: 'checking' })
    try {
      // Conditional request: an unchanged release answers 304, which doesn't count against GitHub's hourly limit
      // (so checking every few minutes is free).
      const res = await f(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'SahilBot', ...(this.etag && this.lastRelease ? { 'if-none-match': this.etag } : {}) }, signal: AbortSignal.timeout(20_000) })
      if (res.status !== 304 && !res.ok) throw new Error(res.status === 404 ? 'No release is published yet.' : `GitHub answered ${res.status}.`)
      type Release = { tag_name: string; body?: string; html_url?: string; assets: Array<{ name: string; browser_download_url: string; size: number }> }
      const rel = res.status === 304 && this.lastRelease ? this.lastRelease as Release : await res.json() as Release
      if (res.status !== 304) { this.lastRelease = rel; this.etag = res.headers?.get?.('etag') ?? undefined }
      const next = parseTag(rel.tag_name)
      if (!next || !isNewer(next, this.current)) return this.set({ state: 'current', checkedAt: Date.now() })
      const zip = rel.assets.find((a) => a.name === ASSET)
      const sums = rel.assets.find((a) => a.name === SUMS)
      if (!zip || !sums) throw new Error('The newest release has no Mac app to download.')
      const label = `${next.version} (build ${next.build})`
      const notes = (rel.body ?? '').replace(/\r/g, '').slice(0, 2000)
      const dir = join(updatesDir(), `v${next.version}-${next.build}`)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, ASSET)
      const want = sumFor(await (await f(sums.browser_download_url, { signal: AbortSignal.timeout(30_000) })).text(), ASSET)
      if (!want) throw new Error('The release has no checksum for the Mac app.')
      if (!existsSync(file) || statSync(file).size !== zip.size || (await sha256(file)) !== want) {
        this.set({ state: 'downloading', version: label, notes, progress: 0, size: zip.size })
        const dl = await f(zip.browser_download_url, { signal: AbortSignal.timeout(30 * 60_000) })
        if (!dl.ok || !dl.body) throw new Error(`The download failed (${dl.status}).`)
        let got = 0
        const counted = Readable.fromWeb(dl.body as never).on('data', (c: Buffer) => {
          got += c.length
          const p = Math.min(99, Math.floor((got / Math.max(1, zip.size)) * 100))
          if (p !== this.status.progress) this.set({ state: 'downloading', version: label, notes, progress: p, size: zip.size })
        })
        await pipeline(counted, createWriteStream(file))
        if ((await sha256(file)) !== want) { rmSync(file, { force: true }); throw new Error('The download didn\'t match its checksum, so it wasn\'t used.') }
      }
      // Unpack next to the installed app's folder (same disk, so the swap is two renames).
      const stage = join(dir, 'app')
      rmSync(stage, { recursive: true, force: true })
      mkdirSync(stage, { recursive: true })
      await run('/usr/bin/ditto', ['-x', '-k', file, stage])
      const app = join(stage, 'SahilBot.app')
      if (!existsSync(app)) throw new Error('The download has no SahilBot.app inside.')
      await run('/usr/bin/codesign', ['--verify', '--deep', app]).catch((e: Error) => { throw new Error(`The new app's signature didn't check out (${e.message}).`) })
      if (bundleBuild(app) !== next.build) throw new Error(`The download is build ${bundleBuild(app)}, not ${next.build}.`)
      this.staged = { app, tag: rel.tag_name }
      return this.set({ state: 'ready', version: label, notes, size: zip.size })
    } catch (e) {
      return this.set({ state: 'error', detail: (e as Error).message })
    }
  }

  /** Backs up the data, then quits; the swap script replaces the app and reopens it. */
  install(): Promise<UpdateStatus> {
    if (this.installing) return this.installing
    this.installing = this.doInstall().finally(() => { this.installing = undefined })
    return this.installing
  }

  private async doInstall(): Promise<UpdateStatus> {
    if (this.status.state !== 'ready' || !this.staged) return this.get()
    const installed = bundleOf(this.d.execPath)
    try { accessSync(dirname(installed), constants.W_OK) } catch {
      this.d.openUrl(`https://github.com/${REPO}/releases/latest`)
      return this.set({ ...this.status, state: 'error', detail: `SahilBot can't replace itself in ${dirname(installed)}. The download page is open: drag the new SahilBot to that folder (your chats and settings stay).` })
    }
    this.set({ ...this.status, state: 'installing' })
    try {
      const backup = await backupData(this.d.dataDir, `before ${this.status.version ?? this.staged.tag}`, { vacuumInto: this.d.vacuumInto })
      const replacement = `${installed}.update-staging`
      if (existsSync(replacement)) rmSync(replacement, { recursive: true, force: true })
      await run('/usr/bin/ditto', [this.staged.app, replacement])
      await run('/usr/bin/codesign', ['--verify', '--deep', replacement])
      if (bundleBuild(replacement) !== bundleBuild(this.staged.app)) throw new Error('The staged app did not copy correctly. Nothing has been replaced.')
      const script = join(updatesDir(), 'swap.sh')
      writeFileSync(script, swapScript(), { mode: 0o755 })
      const child = spawn('/bin/sh', [script, String(process.pid), installed, replacement, join(updatesDir(), 'update.log')], { detached: true, stdio: 'ignore' })
      child.unref()
      this.set({ ...this.status, state: 'installing', detail: `Your data is backed up in ${backup}.` })
      setTimeout(() => this.d.quit(), 300)
      // Still running after the script stopped waiting: the quit was cancelled, so nothing was installed.
      setTimeout(() => { if (this.status.state === 'installing') this.set({ ...this.status, state: 'ready', detail: 'SahilBot didn\'t quit, so the update wasn\'t installed. Try again when nothing is running.' }) }, 150_000).unref?.()
      return this.get()
    } catch (e) {
      return this.set({ ...this.status, state: 'ready', detail: `Couldn't start the update: ${(e as Error).message}` })
    }
  }
}
