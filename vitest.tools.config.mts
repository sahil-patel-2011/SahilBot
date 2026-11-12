import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Dev-only helpers (screenshots, benchmarks). Not part of the test suites.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/tools/**/*.test.ts'], testTimeout: 120_000 }
})
