import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * A real installed build. Not app.isPackaged: Electron decides that from the executable's name, and
 * development runs use a copy renamed to SahilBot (scripts/brand-dev.mjs).
 */
export const isPackaged = (): boolean => app.isPackaged && !/node_modules[\\/]electron[\\/]dist[\\/]/.test(process.execPath)

// FOREMAN_DATA_DIR lets tests run against a throwaway profile.
export function dataDir(): string {
  const dir = process.env.FOREMAN_DATA_DIR || app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function sub(...parts: string[]): string {
  const dir = join(dataDir(), ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The project root in development (the folder with package.json); resources in a packaged app. */
export function appRoot(): string {
  if (isPackaged()) return process.resourcesPath
  let dir = __dirname
  while (dir !== dirname(dir) && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return dir
}
