import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // CI runners are slower than a dev Mac; give each test more room there.
  test: { include: ['tests/unit/**/*.test.ts'], testTimeout: process.env.CI ? 30_000 : 5_000 }
})
