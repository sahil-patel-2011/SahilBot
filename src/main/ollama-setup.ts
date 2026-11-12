import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * One-click local models: SahilBot installs Ollama itself (no admin password: ~/Applications when
 * /Applications is locked), checks Apple's notarization before trusting it, and runs its server in
 * the background so the user never opens Terminal or another app.
 */

const DOWNLOAD = 'https://ollama.com/download/Ollama-darwin.zip'
const APP_DIRS = ['/Applications', join(homedir(), 'Applications')]

export type SetupEvent = { phase: 'download' | 'verify' | 'install' | 'start' | 'done' | 'error'; pct?: number; error?: string }

const run = (cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> =>
  new Promise((ok) => execFile(cmd, args, { timeout: 120_000 }, (e, stdout, stderr) => ok({ ok: !e, out: `${stdout}${stderr}` })))

const writable = (dir: string): boolean => { try { accessSync(dir, constants.W_OK); return true } catch { return false } }

/** Ollama.app wherever it's installed. */
export function findOllamaApp(): string | undefined {
  return APP_DIRS.map((d) => join(d, 'Ollama.app')).find((p) => existsSync(p))
}

/** The `ollama` command: inside the app bundle (layouts differ by version), or a CLI install. */
export function findOllamaBinary(): string | undefined {
  const app = findOllamaApp()
  const inApp = app ? [join(app, 'Contents', 'Resources', 'ollama'), join(app, 'Contents', 'MacOS', 'ollama')] : []
  return [...inApp, '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama'].find((p) => { try { return statSync(p).isFile() } catch { return false } })
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
  const bin = findOllamaBinary()
  if (!bin) return false
  server = spawn(bin, ['serve'], { detached: false, stdio: 'ignore', env: { ...process.env, OLLAMA_FLASH_ATTENTION: process.env.OLLAMA_FLASH_ATTENTION ?? '1' } })
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

async function install(baseUrl: string, emit: (e: SetupEvent) => void): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), 'sahilbot-ollama-'))
  try {
    if (!findOllamaBinary()) {
      // 1. Download, with progress.
      emit({ phase: 'download', pct: 0 })
      const res = await fetch(DOWNLOAD, { redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`The Ollama download failed (${res.status}). Check your internet connection and try again.`)
      const total = Number(res.headers.get('content-length')) || 0
      const zip = join(work, 'Ollama-darwin.zip')
      const file = createWriteStream(zip)
      let got = 0
      let last = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        got += chunk.length
        if (!file.write(chunk)) await new Promise((r) => file.once('drain', r))
        const pct = total ? Math.floor((got / total) * 100) : 0
        if (pct !== last) { last = pct; emit({ phase: 'download', pct }) }
      }
      await new Promise<void>((ok, fail) => file.end((e?: Error | null) => (e ? fail(e) : ok())))

      // 2. Unpack and check it's the real, Apple-notarized app before installing it.
      emit({ phase: 'verify' })
      const unz = await run('ditto', ['-x', '-k', zip, join(work, 'x')])
      const app = join(work, 'x', 'Ollama.app')
      if (!unz.ok || !existsSync(app)) throw new Error('The Ollama download was damaged. Try again.')
      const sig = await run('codesign', ['--verify', '--deep', '--strict', app])
      const gate = await run('spctl', ['--assess', '--type', 'execute', '-vv', app])
      const info = await run('codesign', ['-dv', '--verbose=2', app])
      if (!sig.ok || !gate.ok || !/Notarized Developer ID/i.test(gate.out) || !/Identifier=com\.\S*ollama/i.test(info.out)) {
        throw new Error('The downloaded Ollama didn\'t pass Apple\'s security check, so SahilBot didn\'t install it. Download it yourself from ollama.com.')
      }

      // 3. Install where this account can write (no admin password needed for ~/Applications).
      emit({ phase: 'install' })
      const dir = writable(APP_DIRS[0]) ? APP_DIRS[0] : APP_DIRS[1]
      mkdirSync(dir, { recursive: true })
      const cp = await run('ditto', [app, join(dir, 'Ollama.app')])
      if (!cp.ok) throw new Error(`Couldn't install Ollama: ${cp.out.trim().slice(0, 200)}`)
    }

    // 4. Run its server in the background.
    emit({ phase: 'start' })
    if (!(await startOllama(baseUrl))) throw new Error('Ollama is installed but didn\'t start. Open Ollama from your Applications folder once, then press Check again.')
    emit({ phase: 'done' })
  } catch (e) {
    emit({ phase: 'error', error: (e as Error).message })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
