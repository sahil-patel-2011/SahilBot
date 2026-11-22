import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Agent Arena (tests/arena): real harnesses against one simulated model. Skipped unless ARENA=1.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/arena/**/*.test.ts'], testTimeout: 3_600_000, hookTimeout: 60_000 }
})
