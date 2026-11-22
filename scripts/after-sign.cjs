// electron-builder afterSign: re-signs the app with SahilBot's own self-signed certificate when the release has
// one (the SELF_SIGN_P12 repository secret, imported into a temporary keychain by the release workflow).
//
// Why: an ad-hoc signature is the build's own hash, so to macOS every update is a different app. It drops the
// permissions you granted (Screen Recording, Accessibility, Automation, Full Disk Access) and Keychain access.
// With a fixed certificate the app's identity ("app.sahilbot.desktop" + this certificate) stays the same from
// build to build, so updates keep them. It isn't an Apple Developer ID: the first launch still asks once.
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

exports.default = async function afterSign(ctx) {
  const keychain = process.env.SAHILBOT_SELF_SIGN_KEYCHAIN
  const identity = process.env.SAHILBOT_SELF_SIGN_IDENTITY
  if (ctx.electronPlatformName !== 'darwin' || !keychain || !identity) return
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  const entitlements = join(__dirname, '..', 'build', 'entitlements.mac.plist')
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--options', 'runtime', '--entitlements', entitlements, '--keychain', keychain, '--sign', identity, app], { stdio: 'inherit' })
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`Re-signed ${app} with "${identity}" (a stable identity across updates).`)
}
