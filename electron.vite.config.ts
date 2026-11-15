import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rollupOptions: { external: ['node:sqlite'] } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // overlay: the SahilBot cursor overlay's tiny bridge (src/main/computer/overlay-window.ts).
    build: { rollupOptions: { input: { index: resolve('src/preload/index.ts'), overlay: resolve('src/preload/overlay.ts') } } }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
    // overlay.html: the SahilBot cursor overlay page (static, strict CSP).
    // minify: electron-vite leaves the renderer unminified by default; minified it parses and compiles in a
    // fraction of the time at launch (1.6 MB → about a third). Rarely used surfaces are split out on top of
    // that (src/renderer/src/lazy.tsx). The main process stays readable (its stack traces go in logs).
    build: { minify: true, rollupOptions: { input: { index: resolve('src/renderer/index.html'), overlay: resolve('src/renderer/overlay.html') } } }
  }
})
