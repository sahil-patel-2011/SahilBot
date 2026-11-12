import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Live runs against a real model (needs FOREMAN_LIVE_KEY). Never part of the normal suites.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/live/**/*.test.ts'], testTimeout: 300_000, hookTimeout: 120_000, fileParallelism: false }
})
