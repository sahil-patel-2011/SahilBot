// Development runs use Electron's own app bundle, so macOS shows "Electron" in the menu bar, Dock,
// Cmd-Tab, Activity Monitor and permission prompts. This renames that local copy to SahilBot the same
// way electron-builder does for the packaged app: bundle, executable, helper apps, names and icon.
// It only touches node_modules/electron and is safe to run repeatedly.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)
const NAME = 'SahilBot'
const pkg = join(import.meta.dirname, '..', 'node_modules', 'electron')
const dist = join(pkg, 'dist')
const app = join(dist, `${NAME}.app`)
// Whatever the bundle is called now (Electron.app fresh from npm, or an earlier name), it becomes NAME.app.
const current = existsSync(dist) ? readdirSync(dist).find((d) => d.endsWith('.app')) : undefined
if (!current) process.exit(0)
const prev = current.replace(/\.app$/, '')
if (current !== `${NAME}.app`) renameSync(join(dist, current), app)
const plist = (p, key, value) => execFileSync('plutil', ['-replace', key, '-string', value, p])

// Main executable
const macos = join(app, 'Contents', 'MacOS')
for (const old of ['Electron', prev]) if (old !== NAME && existsSync(join(macos, old))) renameSync(join(macos, old), join(macos, NAME))
const info = join(app, 'Contents', 'Info.plist')
for (const k of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) plist(info, k, NAME)

// Helpers: Electron looks for "<executable name> Helper (…).app".
const fw = join(app, 'Contents', 'Frameworks')
for (const dir of readdirSync(fw).filter((d) => / Helper.*\.app$/.test(d) && !d.startsWith(`${NAME} `))) {
  const helper = dir.replace(/^.*? Helper/, `${NAME} Helper`)
  renameSync(join(fw, dir), join(fw, helper))
  const exeFrom = join(fw, helper, 'Contents', 'MacOS', dir.replace(/\.app$/, ''))
  const exe = helper.replace(/\.app$/, '')
  if (existsSync(exeFrom)) renameSync(exeFrom, join(fw, helper, 'Contents', 'MacOS', exe))
  const hinfo = join(fw, helper, 'Contents', 'Info.plist')
  for (const k of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) plist(hinfo, k, exe)
}

const icns = join(import.meta.dirname, '..', 'build', 'icon.icns')
if (existsSync(icns)) copyFileSync(icns, join(app, 'Contents', 'Resources', 'electron.icns'))
// `require('electron')` returns dist/<path.txt>.
writeFileSync(join(pkg, 'path.txt'), `${NAME}.app/Contents/MacOS/${NAME}`)

// Renaming breaks the bundle's ad-hoc signature; sign it again (ad-hoc, local only).
try { execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' }) } catch { /* best effort */ }
const now = new Date()
utimesSync(app, now, now)
try { execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]) } catch { /* best effort */ }
