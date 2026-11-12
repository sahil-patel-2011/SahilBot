// Builds SahilBot for this Mac and installs it in /Applications (or ~/Applications without admin rights).
//   npm run install:mac
// Without a Developer ID the app is signed ad hoc: it runs on this Mac (and any Mac it's copied to
// without a quarantine flag). For downloads from the web, sign with a Developer ID and notarize.
import { execFileSync, execSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = (cmd, env = {}) => execSync(cmd, { stdio: 'inherit', env: { ...process.env, ...env } })
const out = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }) } catch (e) { return String(e.stdout ?? '') } }

const devId = /Developer ID Application/.test(out('security', ['find-identity', '-v', '-p', 'codesigning']))
console.log(devId ? '› Signing with your Developer ID' : '› No Developer ID found: signing ad hoc for this Mac')

if (!process.argv.includes('--skip-build')) {
  run('npx electron-vite build')
  run(`npx electron-builder --mac dmg zip --arm64 ${devId ? '' : '-c.mac.identity=-'}`, devId ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
}

const built = join('dist', 'mac-arm64', 'SahilBot.app')
if (!existsSync(built)) throw new Error(`Build output missing: ${built}`)
run(`codesign --verify --deep --strict "${built}"`)

// /Applications needs an admin account; otherwise the per-user ~/Applications (Spotlight and Launchpad see both).
const writable = (dir) => { try { accessSync(dir, constants.W_OK); return true } catch { return false } }
const apps = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications')
mkdirSync(apps, { recursive: true })
const target = join(apps, 'SahilBot.app')
// A copy in the other folder isn't touched; say so, since Spotlight would show both.
for (const other of ['/Applications/SahilBot.app', join(homedir(), 'Applications', 'SahilBot.app')]) {
  if (other !== target && existsSync(other) && writable(join(other, '..'))) console.log(`› Note: an older copy is also at ${other}`)
}
// Quit the installed copy if it's running, then replace it.
if (out('pgrep', ['-f', `${target}/Contents/MacOS/`]).trim()) {
  console.log('› Quitting the running SahilBot')
  out('osascript', ['-e', `tell application "${target}" to quit`])
  for (let i = 0; i < 20 && out('pgrep', ['-f', `${target}/Contents/MacOS/`]).trim(); i++) execSync('sleep 0.5')
}
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
run(`ditto "${built}" "${target}"`)
out('xattr', ['-dr', 'com.apple.quarantine', target])
// Register with Launch Services so Spotlight, Launchpad and "Open With" see it right away.
out('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', target])

console.log(`\n✓ Installed ${target}`)
console.log(`  Installer for other Macs: ${out('ls', ['dist']).split('\n').filter((f) => f.endsWith('.dmg')).map((f) => join('dist', f)).join(', ')}`)
