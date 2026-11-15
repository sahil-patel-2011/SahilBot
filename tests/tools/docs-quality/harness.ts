import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

// Bundles entry.ts (with the document generators from `docsRoot`, default src/main/docs) and runs it in
// Electron, hidden. Returns summary.json. `docsRoot` lets a copy of older generator code render the same
// samples for before/after comparisons.
export async function runDocsShots(outDir: string, o: { docsRoot?: string; only?: string[] } = {}): Promise<Record<string, any>> {
  const { build } = await import('vite')
  const root = resolve(__dirname, '../../..')
  // Inside the repo, so the bundle's package imports resolve from node_modules.
  const bundleDir = join(root, 'node_modules/.cache/sb-docs-shots')
  await build({
    configFile: false,
    logLevel: 'error',
    root,
    resolve: { alias: [...(o.docsRoot ? [{ find: /^.*\/src\/main\/docs\/create$/, replacement: join(o.docsRoot, 'create.ts') }] : []), { find: '@shared', replacement: join(root, 'src/shared') }] },
    build: { ssr: join(__dirname, 'entry.ts'), outDir: bundleDir, emptyOutDir: true, minify: false, rollupOptions: { external: (id: string) => !/^[./@\0]/.test(id) || /^@(?!shared)[\w-]+\//.test(id), output: { format: 'cjs', entryFileNames: 'entry.cjs' } } }
  })
  const electron = createRequire(import.meta.url)('electron') as unknown as string
  const r = spawnSync(electron, [join(bundleDir, 'entry.cjs')], {
    env: { ...process.env, SAHILBOT_HIDDEN: '1', DOCS_SHOT_OUT: outDir, DOCS_SHOT_ONLY: (o.only ?? []).join(','), ELECTRON_RUN_AS_NODE: '' },
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000
  })
  const summary = join(outDir, 'summary.json')
  if (!existsSync(summary)) throw new Error(`Electron run failed (${r.status}): ${r.stderr?.slice(-2000)}`)
  return JSON.parse(readFileSync(summary, 'utf8'))
}
