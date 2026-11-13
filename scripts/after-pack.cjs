// electron-builder afterPack: the bundled whisper-server must find its dylibs next to it, not in
// the build folder it was compiled in. Runs before signing, so the signature covers the change.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const bin = join(app, 'Contents', 'Resources', 'whisper', 'whisper-server')
  if (!existsSync(bin)) return
  const rpaths = execFileSync('otool', ['-l', bin], { encoding: 'utf8' })
    .split('\n').filter((l) => l.trim().startsWith('path ')).map((l) => l.trim().split(/\s+/)[1])
  for (const p of rpaths) if (p !== '@executable_path') execFileSync('install_name_tool', ['-delete_rpath', p, bin])
  if (!rpaths.includes('@executable_path')) execFileSync('install_name_tool', ['-add_rpath', '@executable_path', bin])
}
