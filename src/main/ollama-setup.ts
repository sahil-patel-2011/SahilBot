import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { dataDir } from './paths'

/**
 * One-click local models: SahilBot installs Ollama itself (no admin password: ~/Applications when
 * /Applications is locked) and runs its server in the background so the user never opens Terminal.
 *
 * Trust: the zip comes from Ollama's GitHub release, whose API publishes a SHA-256 digest for each
 * asset; the download must match it. The unpacked app must also pass codesign/notarization, carry
 * Ollama's exact bundle id, and be signed by the same Apple team as the first Ollama SahilBot
 * trusted (pinned in the data folder). `ollama serve` only ever runs from a bundle that passes
 * those checks, or from the Homebrew / /usr/local CLI.
 */

const RELEASE_API = 'https://api.github.com/repos/ollama/ollama/releases/latest'
const ASSET = 'Ollama-darwin.zip'
/** Used only when the GitHub API can't be reached (then there's no digest and the team pin is required). */
const FALLBACK_DOWNLOAD = 'https://ollama.com/download/Ollama-darwin.zip'
const APP_DIRS = ['/Applications', join(homedir(), 'Applications')]
const CLI_PATHS = ['/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']

/** CFBundleIdentifier of Ollama.app (ollama/ollama app/darwin/Ollama.app/Contents/Info.plist). */
export const OLLAMA_BUNDLE_IDS: readonly string[] = ['com.electron.ollama']

export type SetupEvent = { phase: 'download' | 'verify' | 'install' | 'start' | 'done' | 'error'; pct?: number; error?: string }

const run = (cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((ok) => execFile(cmd, args, { timeout: 120_000 }, (e, stdout, stderr) => ok({ ok: !e, out: `${stdout}${stderr}` })))

const writable = (dir: string): boolean => { try { accessSync(dir, constants.W_OK); return true } catch { return false } }
const isFile = (p: string): boolean => { try { return statSync(p).isFile() } catch { return false } }

// ---------------------------------------------------------------- pure checks (unit-tested)

export interface CodeIdentity { identifier?: string; teamId?: string; authorities: string[] }

/** Reads `codesign -dv --verbose=4` output (it prints to stderr; pass stdout+stderr). */
export function parseCodesign(out: string): CodeIdentity {
  const field = (k: string): string | undefined => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, 'm'))
    const v = m?.[1].trim()
    return v && v !== 'not set' ? v : undefined
  }
  const authorities = [...out.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim())
  return { identifier: field('Identifier'), teamId: field('TeamIdentifier'), authorities }
}

export function isAllowedBundleId(id: string | undefined): boolean {
  return !!id && OLLAMA_BUNDLE_IDS.includes(id)
}

/** "sha256:<64 hex>" → the lowercase hex; anything else → undefined. */
export function parseDigest(d: unknown): string | undefined {
  const m = typeof d === 'string' ? d.trim().match(/^sha256:([0-9a-f]{64})$/i) : null
  return m ? m[1].toLowerCase() : undefined
}

/** Whether a downloaded file's SHA-256 (hex) equals the release digest. A malformed digest never matches. */
export function digestMatches(expected: string | undefined, actualHex: string): boolean {
  const want = parseDigest(expected)
  return !!want && /^[0-9a-f]{64}$/i.test(actualHex) && want === actualHex.toLowerCase()
}

export interface ReleaseAsset { url: string; digest?: string; size?: number; version?: string }

/** The macOS zip from a GitHub "latest release" response, only if it points at ollama/ollama's own downloads. */
export function pickAsset(release: unknown): ReleaseAsset | undefined {
  const r = release as { tag_name?: unknown; assets?: Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown }> } | null
  const a = Array.isArray(r?.assets) ? r!.assets.find((x) => x?.name === ASSET) : undefined
  const url = typeof a?.browser_download_url === 'string' ? a.browser_download_url : ''
  if (!url.startsWith('https://github.com/ollama/ollama/releases/download/') || !url.endsWith(`/${ASSET}`)) return undefined
  return {
    url,
    digest: parseDigest(a!.digest) ? String(a!.digest) : undefined,
    size: typeof a!.size === 'number' ? a!.size : undefined,
    version: typeof r!.tag_name === 'string' ? r!.tag_name : undefined
  }
}

/** Why a signed bundle isn't the Ollama SahilBot trusts, or null if it is. `pinnedTeam` is the team first trusted. */
export function identityProblem(id: CodeIdentity, pinnedTeam: string | undefined): string | null {
  if (!isAllowedBundleId(id.identifier)) return `unexpected bundle id ${id.identifier ?? '(none)'}`
  if (!id.teamId || !/^[A-Z0-9]{10}$/.test(id.teamId)) return 'no Apple team id in its signature'
  if (!id.authorities.some((a) => /^Developer ID Application: /.test(a))) return 'not signed with a Developer ID'
  if (pinnedTeam && id.teamId !== pinnedTeam) return `signed by team ${id.teamId}, not ${pinnedTeam}`
  return null
}

// ---------------------------------------------------------------- the pinned signing team

export interface TrustStore { team(): string | undefined; pin(team: string): void }

const fileStore: TrustStore = {
  team() {
    try {
      const t = (JSON.parse(readFileSync(join(dataDir(), 'ollama-trust.json'), 'utf8')) as { teamId?: unknown }).teamId
      return typeof t === 'string' && /^[A-Z0-9]{10}$/.test(t) ? t : undefined
    } catch { return undefined }
  },
  pin(teamId) {
    try { writeFileSync(join(dataDir(), 'ollama-trust.json'), JSON.stringify({ teamId, pinnedAt: new Date().toISOString() })) } catch { /* best-effort */ }
  }
}
let trust: TrustStore = fileStore
/** Swaps where the pinned TeamIdentifier lives (tests, or a settings-backed store). */
export function setOllamaTrustStore(s: TrustStore): void { trust = s; verified.clear() }

// ---------------------------------------------------------------- verifying a bundle

/** path → the result for the bundle as it was (mtime), so a start doesn't re-hash the whole app. */
const verified = new Map<string, { key: string; ok: boolean }>()

const stamp = (app: string): string => {
  try {
    const s = statSync(app)
    const exe = [join(app, 'Contents', 'Resources', 'ollama'), join(app, 'Contents', 'MacOS', 'Ollama')].map((p) => { try { return statSync(p).mtimeMs } catch { return 0 } })
    return `${s.mtimeMs}:${s.ino}:${exe.join(':')}`
  } catch { return '' }
}

/**
 * Full check of an Ollama.app on disk: intact signature (deep, strict), Apple notarization, Ollama's
 * bundle id, and the pinned signing team. With no pin yet, `pinIfNew` records this bundle's team.
 */
export async function verifyOllamaApp(app: string, pinIfNew = false): Promise<{ ok: true; teamId: string } | { ok: false; reason: string }> {
  const sig = await run('codesign', ['--verify', '--deep', '--strict', app])
  if (!sig.ok) return { ok: false, reason: 'its code signature is broken' }
  const gate = await run('spctl', ['--assess', '--type', 'execute', '-vv', app])
  if (!gate.ok || !/source=Notarized Developer ID/i.test(gate.out)) return { ok: false, reason: 'Apple hasn\'t notarized it' }
  const id = parseCodesign((await run('codesign', ['-dv', '--verbose=4', app])).out)
  const pinned = trust.team()
  const problem = identityProblem(id, pinned)
  if (problem) return { ok: false, reason: problem }
  if (!pinned && pinIfNew) trust.pin(id.teamId!)
  return { ok: true, teamId: id.teamId! }
}

async function verifiedCached(app: string): Promise<boolean> {
  const key = stamp(app)
  const hit = verified.get(app)
  if (hit && hit.key === key) return hit.ok
  // An Ollama the user installed themselves is trusted (and pinned) if it passes the same checks.
  const ok = (await verifyOllamaApp(app, true)).ok
  verified.set(app, { key, ok })
  return ok
}

/** Every Ollama.app in the usual places. */
function ollamaApps(): string[] {
  return APP_DIRS.map((d) => join(d, 'Ollama.app')).filter((p) => existsSync(p))
}

/** Ollama.app wherever it's installed. */
export function findOllamaApp(): string | undefined {
  return ollamaApps()[0]
}

const inApp = (app: string): string[] => [join(app, 'Contents', 'Resources', 'ollama'), join(app, 'Contents', 'MacOS', 'ollama')]

/** Whether some `ollama` command exists (unverified; for the "installed?" check in the UI). */
export function findOllamaBinary(): string | undefined {
  return [...ollamaApps().flatMap(inApp), ...CLI_PATHS].find(isFile)
}

/** An `ollama` command that's safe to run: inside a verified Ollama.app, or the Homebrew / /usr/local CLI. */
export async function verifiedOllamaBinary(): Promise<string | undefined> {
  for (const app of ollamaApps()) {
    const bin = inApp(app).find(isFile)
    if (bin && (await verifiedCached(app))) return bin
  }
  return CLI_PATHS.find(isFile)
}

export async function ollamaUp(baseUrl: string): Promise<boolean> {
  try {
    return (await fetch(`${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/api/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

let server: ChildProcess | null = null

/** Starts `ollama serve` in the background if it isn't answering yet. Resolves true once it answers. */
export async function startOllama(baseUrl: string): Promise<boolean> {
  if (await ollamaUp(baseUrl)) return true
  const bin = await verifiedOllamaBinary()
  if (!bin) return false
  // Flash attention, and an 8-bit KV cache (needs flash attention): about half the context memory at
  // no visible quality cost, so a 64k window fits beside a 27B model. The user's own settings win.
  server = spawn(bin, ['serve'], { detached: false, stdio: 'ignore', env: { ...process.env, OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? '1', OLLAMA_KV_CACHE_TYPE: process.env.OLLAMA_KV_CACHE_TYPE ?? 'q8_0' } })
  server.on('exit', () => { server = null })
  for (let i = 0; i < 40; i++) {
    if (await ollamaUp(baseUrl)) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** Stops the server only if SahilBot started it (an Ollama the user runs themselves keeps running). */
export function stopOllama(): void {
  server?.kill('SIGTERM')
  server = null
}

let busy: Promise<void> | null = null

export function setupOllama(baseUrl: string, emit: (e: SetupEvent) => void): Promise<void> {
  busy ??= install(baseUrl, emit).finally(() => { busy = null })
  return busy
}

/** The release asset from GitHub, or the plain download (no digest) if the API can't be reached. */
async function releaseAsset(): Promise<ReleaseAsset> {
  try {
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SahilBot' }, signal: AbortSignal.timeout(15_000) })
    if (res.ok) {
      const a = pickAsset(await res.json())
      if (a) return a
    }
  } catch { /* offline or rate-limited: fall through */ }
  return { url: FALLBACK_DOWNLOAD }
}

const SECURITY_FAIL = 'The downloaded Ollama didn\'t pass SahilBot\'s security check, so it wasn\'t installed. Download it yourself from ollama.com.'

async function install(baseUrl: string, emit: (e: SetupEvent) => void): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'sahilbot-ollama-'))
  try {
    if (!(await verifiedOllamaBinary())) {
      // 1. Download, with progress, hashing as it streams.
      emit({ phase: 'download', pct: 0 })
      const asset = await releaseAsset()
      const res = await fetch(asset.url, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`The Ollama download failed (${res.status}). Check your internet connection and try again.`)
      const total = Number(res.headers.get('content-length')) || asset.size || 0
      const zip = join(work, ASSET)
      const file = createWriteStream(zip)
      const hash = createHash('sha256')
      let got = 0
      let last = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        hash.update(chunk)
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r))
        const pct = total ? Math.min(100, Math.floor((got / total) * 100)) : 0
        if (pct !== last) { last = pct; emit({ phase: 'download', pct }) }
      }
      await new Promise<void>((ok, fail) => file.end((e?: Error | null) => (e ? fail(e) : ok())))

      // 2. The bytes must be the ones GitHub published; then unpack and check who signed the app.
      emit({ phase: 'verify' })
      if (asset.digest && !digestMatches(asset.digest, hash.digest('hex'))) {
        throw new Error('The Ollama download didn\'t match the checksum Ollama published, so SahilBot didn\'t install it. Try again, or download it yourself from ollama.com.')
      }
      // Without a published digest, only an Ollama signed by the team SahilBot already trusts is accepted.
      if (!asset.digest && !trust.team()) throw new Error('SahilBot couldn\'t get Ollama\'s published checksum from GitHub, so it didn\'t install the download. Try again in a few minutes, or download it yourself from ollama.com.')
      const unz = await run('ditto', ['-x', '-k', zip, join(work, 'x')])
      const app = join(work, 'x', 'Ollama.app')
      if (!unz.ok || !existsSync(app)) throw new Error('The Ollama download was damaged. Try again.')
      const pre = await verifyOllamaApp(app)
      if (!pre.ok) throw new Error(SECURITY_FAIL)

      // 3. Install where this account can write (no admin password needed for ~/Applications).
      //    Never copy over an existing Ollama.app (ditto would merge the two bundles): set it aside.
      emit({ phase: 'install' })
      const dir = writable(APP_DIRS[0]) ? APP_DIRS[0] : APP_DIRS[1]
      mkdirSync(dir, { recursive: true })
      const dest = join(dir, 'Ollama.app')
      if (existsSync(dest)) {
        const aside = join(dir, `Ollama.app.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`)
        try { renameSync(dest, aside) } catch (e) { throw new Error(`Couldn't move the existing Ollama out of the way: ${(e as Error).message.slice(0, 160)}`) }
      }
      verified.clear()
      const cp = await run('ditto', [app, dest])
      if (!cp.ok) throw new Error(`Couldn't install Ollama: ${cp.out.trim().slice(0, 200)}`)
      // 4. Check the installed copy itself, then remember who signed it.
      const post = await verifyOllamaApp(dest, true)
      if (!post.ok) {
        rmSync(dest, { recursive: true, force: true })
        throw new Error(SECURITY_FAIL)
      }
    }

    // 5. Run its server in the background.
    emit({ phase: 'start' })
    if (!(await startOllama(baseUrl))) throw new Error('Ollama is installed but didn\'t start. Open Ollama from your Applications folder once, then press Check again.')
    emit({ phase: 'done' })
  } catch (e) {
    emit({ phase: 'error', error: (e as Error).message })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
