import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

/**
 * Playwright's own Chromium; when its exact build isn't downloaded, any headless shell (or full Chromium)
 * already installed: PLAYWRIGHT_CHROMIUM_PATH, then PLAYWRIGHT_BROWSERS_PATH, then Playwright's cache.
 */
export function chromiumPath(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH
  if (existsSync(chromium.executablePath())) return undefined
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')].filter((d): d is string => !!d && existsSync(d))
  for (const dir of dirs) {
    for (const d of readdirSync(dir).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
      for (const sub of readdirSync(join(dir, d))) {
        const exe = join(dir, d, sub, 'chrome-headless-shell')
        if (existsSync(exe)) return exe
      }
    }
    const full = join(dir, 'chromium')
    if (existsSync(full)) return full
  }
  return undefined
}
