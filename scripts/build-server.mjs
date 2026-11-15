// Builds SahilBot Server (docs/server.md):
//   out/server/index.js       Node 22+ (CommonJS): src/server/index.ts with the Mac app's main process,
//                             `electron` replaced by src/server/platform/electron.ts
//   out/server/web/bridge.js  the browser bridge: the app's preload over a WebSocket (src/server/web)
// The web UI itself is the app's renderer bundle (out/renderer), built by `npm run build`.
//
//   node scripts/build-server.mjs          (also runs as part of npm run build:server)

import { build } from 'vite'
import { builtinModules } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const shared = resolve(root, 'src/shared')
// Packages stay in node_modules (the runtime dependencies and theirs, installed next to the server); SahilBot's
// own code is bundled. `electron` is never a package here: it's aliased to the headless implementation.
void pkg
const external = (id) => id.startsWith('node:') || builtinModules.includes(id) || (/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(\/.*)?$/i.test(id) && id !== 'electron' && !id.startsWith('@shared'))
const onwarn = (w, warn) => { if (w.code !== 'INEFFECTIVE_DYNAMIC_IMPORT') warn(w) }

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': shared, electron: resolve(root, 'src/server/platform/electron.ts') } },
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: resolve(root, 'src/server/index.ts'),
    outDir: resolve(root, 'out/server'),
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      external,
      onwarn,
      output: { format: 'cjs', entryFileNames: 'index.js', chunkFileNames: 'chunks/[name]-[hash].js' }
    }
  }
})

await build({
  root,
  configFile: false,
  logLevel: 'warn',
  resolve: { alias: { '@shared': shared, electron: resolve(root, 'src/server/web/electron-web.ts') } },
  build: {
    outDir: resolve(root, 'out/server/web'),
    emptyOutDir: false,
    target: 'es2022',
    minify: true,
    reportCompressedSize: false,
    rollupOptions: { onwarn },
    lib: { entry: resolve(root, 'src/server/web/bridge.ts'), formats: ['iife'], name: 'SahilBotBridge', fileName: () => 'bridge.js' }
  }
})

console.log('SahilBot Server built: out/server/index.js, out/server/web/bridge.js')
