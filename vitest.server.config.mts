import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// SahilBot Server tests (tests/server): the server booted in-process (the Mac app's main process with
// `electron` replaced by src/server/platform/electron.ts), plus the web UI in headless Chromium.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), electron: resolve('src/server/platform/electron.ts') } },
  test: { include: ['tests/server/**/*.test.ts'], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false, pool: 'forks' }
})
