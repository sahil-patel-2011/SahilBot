import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Phone access (src/main/phone) serves the renderer to paired phones with the browser bridge in front of it:
 * the preload built against a WebSocket ipcRenderer (src/server/web). Built next to the main process as
 * out/web/bridge.js (SahilBot Server builds its own copy: scripts/build-server.mjs).
 */
function phoneBridge(): Plugin {
  return {
    name: 'sahilbot-phone-bridge',
    apply: 'build',
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        resolve: { alias: { '@shared': resolve('src/shared'), electron: resolve('src/server/web/electron-web.ts') } },
        build: {
          outDir: resolve('out/web'),
          emptyOutDir: true,
          target: 'es2022',
          minify: true,
          reportCompressedSize: false,
          lib: { entry: resolve('src/server/web/bridge.ts'), formats: ['iife'], name: 'SahilBotBridge', fileName: () => 'bridge.js' }
        }
      })
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [phoneBridge()],
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
