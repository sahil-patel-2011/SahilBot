// Packs SahilBot Server into a tarball for one platform (the release workflow runs it for linux arm64 and x64):
//
//   node scripts/server/package.mjs --arch arm64|x64 [--os linux|darwin] [--out dist/server] [--no-install]
//
// Needs `npm run build && npm run build:server` first. The tarball unpacks to sahilbot-server/ with:
//   bin/sahilbot-server       launcher (uses a Node 22.13+ on PATH, or ./node/bin/node when the installer put one there)
//   out/server, out/renderer  the server bundle and the web UI
//   node_modules              production dependencies for that OS and CPU (npm ci --omit=dev --os --cpu)
//   packs, docs, resources    built-in skills and rules, the manual, the icon
//   install.sh, systemd and launchd templates (scripts/server)
// Native binaries for other platforms are pruned. --no-install skips node_modules (to inspect the layout).

import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const arch = opt('arch', process.arch === 'arm64' ? 'arm64' : 'x64')
const os = opt('os', 'linux')
const outDir = resolve(root, opt('out', 'dist/server'))
const install = !args.includes('--no-install')
if (!['arm64', 'x64'].includes(arch)) throw new Error(`--arch must be arm64 or x64 (got ${arch})`)
if (!['linux', 'darwin'].includes(os)) throw new Error(`--os must be linux or darwin (got ${os})`)
for (const f of ['out/server/index.js', 'out/server/web/bridge.js', 'out/renderer/index.html']) {
  if (!existsSync(join(root, f))) throw new Error(`Missing ${f}: run npm run build && npm run build:server first.`)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = `SahilBot-server-${os}-${arch}`
const stage = join(outDir, 'stage', name)
const top = join(stage, 'sahilbot-server')
rmSync(join(outDir, 'stage', name), { recursive: true, force: true })
mkdirSync(top, { recursive: true })

const copy = (from, to = from, filter) => cpSync(join(root, from), join(top, to), { recursive: true, filter })
copy('out/server')
copy('out/renderer', 'out/renderer', (src) => !/overlay\.html$/.test(src))
copy('packs')
copy('docs')
copy('resources')
for (const f of ['package-lock.json', 'THIRD_PARTY_NOTICES.md', 'README.md']) if (existsSync(join(root, f))) copy(f)
// The app's package.json for npm ci (it must match the lock file); replaced by the server's own below.
copy('package.json')
for (const f of ['install.sh', 'sahilbot.service', 'app.sahilbot.server.plist']) copy(join('scripts', 'server', f), f)
chmodSync(join(top, 'install.sh'), 0o755)
mkdirSync(join(top, 'bin'))
writeFileSync(join(top, 'bin', 'sahilbot-server'), `#!/bin/sh
# SahilBot Server launcher: the Node the installer placed next to it, else the one on PATH.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ -x "$HERE/node/bin/node" ]; then NODE="$HERE/node/bin/node"; else NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ]; then echo "SahilBot Server needs Node.js 22.13+ (24 LTS recommended). Run $HERE/install.sh" >&2; exit 1; fi
exec "$NODE" "$HERE/out/server/index.js" "$@"
`)
chmodSync(join(top, 'bin', 'sahilbot-server'), 0o755)
writeFileSync(join(top, 'VERSION'), `${pkg.version}\n`)

if (install) {
  // Production dependencies for the target, fetched for that OS and CPU (optional native packages included),
  // with no install scripts run (nothing downloads extra binaries at install time).
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${os}`, `--cpu=${arch}`], { cwd: top, stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' } })
  // onnxruntime-node ships every platform's library; keep only this one.
  const ort = join(top, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3')
  if (existsSync(ort)) {
    for (const p of readdirSync(ort)) if (p !== os) rmSync(join(ort, p), { recursive: true, force: true })
    if (existsSync(join(ort, os))) for (const a of readdirSync(join(ort, os))) if (a !== arch) rmSync(join(ort, os, a), { recursive: true, force: true })
  }
  // Caches, docs and tests inside packages: not needed to run.
  for (const junk of ['.cache', '.package-lock.json']) rmSync(join(top, 'node_modules', junk), { recursive: true, force: true })
}

// The server's own package.json: the runtime dependencies only, no install scripts.
writeFileSync(join(top, 'package.json'), JSON.stringify({ name: 'sahilbot-server', productName: 'SahilBot Server', version: pkg.version, private: true, description: 'SahilBot Server: always-on bots (docs/server.md)', main: 'out/server/index.js', bin: { 'sahilbot-server': 'bin/sahilbot-server' }, engines: { node: '>=22.13' }, dependencies: pkg.dependencies }, null, 2))

mkdirSync(outDir, { recursive: true })
const tarball = join(outDir, `${name}.tar.gz`)
rmSync(tarball, { force: true })
execFileSync('tar', ['-czf', tarball, '-C', stage, 'sahilbot-server'], { stdio: 'inherit' })
rmSync(join(outDir, 'stage', name), { recursive: true, force: true })
console.log(`Packed ${tarball}`)
