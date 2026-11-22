import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// The real-work eval (tests/eval): scripted by default; REAL_WORK=1 with a key runs a real model. Not in the unit suite.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['tests/eval/**/*.test.ts'], testTimeout: 3_600_000, hookTimeout: 120_000, fileParallelism: false }
})
