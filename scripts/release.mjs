// Publishes a CI build to GitHub Releases (used by .github/workflows/release.yml).
//
//   node scripts/release.mjs --version 0.1.0 --build 42 --sha <commit> --signing adhoc|signed|notarized [--dist dist] [--dry-run]
//
// 1. Finds the DMG and ZIP electron-builder wrote to dist/ (SahilBot-<version>-<build>-arm64.*).
// 2. Copies them to dist/release/ twice: the versioned names (kept for history) and the stable names
//    SahilBot-mac-arm64.dmg / SahilBot-mac-arm64.zip, plus SHA256SUMS.txt. SahilBot Server tarballs in
//    dist/server (SahilBot-server-linux-arm64.tar.gz, -x64) go along the same way when present.
// 3. Creates the versioned release v<version>-<build> with every file, marked Latest. GitHub's
//    /releases/latest/download/<name> always resolves to the newest non-prerelease release, and every
//    versioned release carries the stable names, so
//    https://github.com/<repo>/releases/latest/download/SahilBot-mac-arm64.dmg is always the newest build.
// 4. Replaces the rolling prerelease tagged `latest` (stable names only, moved to this commit). Being a
//    prerelease, it can never take the Latest badge from the versioned release.
// --dry-run prints the gh commands instead of running them (the files are still prepared).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const STABLE = { dmg: 'SahilBot-mac-arm64.dmg', zip: 'SahilBot-mac-arm64.zip' }
/** SahilBot Server tarballs (docs/server.md), built by the workflow's server job into <dist>/server. Optional. */
export const SERVER_STABLE = { arm64: 'SahilBot-server-linux-arm64.tar.gz', x64: 'SahilBot-server-linux-x64.tar.gz' }

/** The server tarballs present in <dist>/server (any of them may be missing; the Mac release goes out anyway). */
export function findServerArtifacts(serverDir) {
  if (!existsSync(serverDir)) return {}
  const files = readdirSync(serverDir)
  return Object.fromEntries(Object.entries(SERVER_STABLE).filter(([, n]) => files.includes(n)).map(([arch, n]) => [arch, join(serverDir, n)]))
}
export const ROLLING_TAG = 'latest'

export function parseArgs(argv) {
  const o = { dist: 'dist', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') o.dryRun = true
    else if (a.startsWith('--')) o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]
  }
  for (const k of ['version', 'build', 'sha', 'signing']) if (!o[k]) throw new Error(`Missing --${k}`)
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error(`Bad --version ${o.version}`)
  if (!/^\d+$/.test(o.build)) throw new Error(`Bad --build ${o.build}`)
  if (!['adhoc', 'signed', 'notarized'].includes(o.signing)) throw new Error(`Bad --signing ${o.signing}`)
  // Values reach gh as arguments only; still, nothing but a commit hash and owner/name is accepted.
  if (!/^[0-9a-f]{7,40}$/i.test(o.sha)) throw new Error(`Bad --sha ${o.sha}`)
  if (o.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error(`Bad --repo ${o.repo}`)
  if (o.dist !== undefined && (typeof o.dist !== 'string' || !o.dist)) throw new Error('Bad --dist')
  return o
}

export const tagFor = (version, build) => `v${version}-${build}`

/** The one DMG and one ZIP for this build in dist/ (newest naming first, then any arm64 build). */
export function findArtifacts(files, version, build) {
  const pick = (ext) => {
    const exact = files.filter((f) => f === `SahilBot-${version}-${build}-arm64.${ext}`)
    const any = files.filter((f) => new RegExp(`^SahilBot-.*arm64\\.${ext}$`).test(f) && !Object.values(STABLE).includes(f))
    const found = exact.length ? exact : any
    if (found.length !== 1) throw new Error(`Expected one .${ext} in dist, found ${found.length ? found.join(', ') : 'none'}`)
    return found[0]
  }
  return { dmg: pick('dmg'), zip: pick('zip') }
}

export function releaseNotes({ version, build, sha, signing, repo, server }) {
  const base = repo ? `https://github.com/${repo}` : ''
  const link = repo ? `${base}/releases/latest/download/${STABLE.dmg}` : STABLE.dmg
  const lines = [
    `SahilBot ${version}, build ${build} (${sha.slice(0, 7)}). Apple Silicon (M1 or newer), macOS 13 Ventura or later.`,
    '',
    `**Always-current download:** ${link}`,
    '',
    '### Install',
    '1. Open the DMG and drag SahilBot to Applications. No admin rights? Drag it to the Applications folder in your home folder (`~/Applications`) instead.',
    '2. Open SahilBot from Applications or Spotlight.'
  ]
  if (signing === 'notarized') lines.push('', 'Signed with a Developer ID and notarized by Apple: it opens with a normal double-click.')
  else {
    lines.push('',
      signing === 'signed'
        ? '**Signed but not notarized.** macOS asks before the first launch:'
        : '**Not notarized (ad-hoc signed).** This build isn\'t signed with an Apple Developer ID, so macOS blocks the first launch:',
      '- macOS 13–14: right-click (or Control-click) SahilBot in Applications → **Open** → **Open**.',
      '- macOS 15 or later: double-click it once, then System Settings → Privacy & Security → **Open Anyway** next to SahilBot.',
      '- Or in Terminal: `xattr -dr com.apple.quarantine /Applications/SahilBot.app`',
      '',
      'After the first launch it opens normally.')
  }
  lines.push('', `Files: \`${STABLE.dmg}\` and \`${STABLE.zip}\` (always the newest build), the versioned copies of this build, and \`SHA256SUMS.txt\`.`)
  if (server?.length) {
    const url = (n) => (repo ? `https://github.com/${repo}/releases/latest/download/${n}` : n)
    lines.push('', '### SahilBot Server (always-on bots on a Raspberry Pi, a VM or a Mac mini)',
      `Linux ${server.map((n) => `[${n.includes('arm64') ? 'arm64 (Raspberry Pi 4/5, 64-bit OS)' : 'x64'}](${url(n)})`).join(' · ')}. On a Raspberry Pi 5 (8 GB recommended, 4 GB minimum):`,
      '```sh',
      `curl -fsSLO ${url(SERVER_STABLE.arm64)}`,
      `tar -xzf ${SERVER_STABLE.arm64} && ./sahilbot-server/install.sh`,
      '```',
      'The installer sets up Node.js if needed, a service that starts at boot, and prints a pairing code. See docs/server.md.')
  }
  return lines.join('\n')
}

export function rollingNotes({ version, build, sha, repo }) {
  const tag = tagFor(version, build)
  return [
    `Rolling build: always the newest commit on main. Currently ${version} build ${build} (${sha.slice(0, 7)}), the same files as ${repo ? `[${tag}](https://github.com/${repo}/releases/tag/${tag})` : tag}.`,
    '',
    `For a link that never changes, use ${repo ? `https://github.com/${repo}/releases/latest/download/${STABLE.dmg}` : `/releases/latest/download/${STABLE.dmg}`}.`
  ].join('\n')
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Copies the build to <dist>/release with versioned and stable names; returns the file lists. */
export function prepare({ dist, version, build }) {
  const { dmg, zip } = findArtifacts(readdirSync(dist), version, build)
  const out = join(dist, 'release')
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const versioned = { dmg: `SahilBot-${version}-${build}-mac-arm64.dmg`, zip: `SahilBot-${version}-${build}-mac-arm64.zip` }
  for (const ext of ['dmg', 'zip']) {
    const src = join(dist, ext === 'dmg' ? dmg : zip)
    copyFileSync(src, join(out, versioned[ext]))
    copyFileSync(src, join(out, STABLE[ext]))
  }
  const names = [versioned.dmg, versioned.zip, STABLE.dmg, STABLE.zip]
  const stableNames = [STABLE.dmg, STABLE.zip]
  for (const [arch, src] of Object.entries(findServerArtifacts(join(dist, 'server')))) {
    const v = `SahilBot-server-${version}-${build}-linux-${arch}.tar.gz`
    copyFileSync(src, join(out, v))
    copyFileSync(src, join(out, SERVER_STABLE[arch]))
    names.push(v, SERVER_STABLE[arch])
    stableNames.push(SERVER_STABLE[arch])
  }
  writeFileSync(join(out, 'SHA256SUMS.txt'), names.map((n) => `${sha256(join(out, n))}  ${n}`).join('\n') + '\n')
  return {
    out,
    all: [...names, 'SHA256SUMS.txt'].map((n) => join(out, n)),
    stable: [...stableNames, 'SHA256SUMS.txt'].map((n) => join(out, n)),
    server: stableNames.filter((n) => n.startsWith('SahilBot-server-'))
  }
}

/** The gh commands that publish both releases, in order. `exists` says whether a tag's release is already there. */
export function plan({ version, build, sha, files, notesFile, rollingNotesFile, exists }) {
  const tag = tagFor(version, build)
  const steps = []
  // A re-run of the same workflow run: replace that release's files instead of failing.
  if (exists(tag)) steps.push(['release', 'upload', tag, ...files.all, '--clobber'], ['release', 'edit', tag, '--latest', '--notes-file', notesFile])
  else steps.push(['release', 'create', tag, ...files.all, '--target', sha, '--title', `SahilBot ${version} (build ${build})`, '--notes-file', notesFile, '--latest'])
  if (exists(ROLLING_TAG)) steps.push(['release', 'delete', ROLLING_TAG, '--cleanup-tag', '--yes'])
  steps.push(['release', 'create', ROLLING_TAG, ...files.stable, '--target', sha, '--title', 'Latest build (rolling)', '--notes-file', rollingNotesFile, '--prerelease'])
  return steps
}

function main() {
  const o = parseArgs(process.argv.slice(2))
  const repo = o.repo || process.env.GITHUB_REPOSITORY || ''
  const files = prepare(o)
  const notesFile = join(files.out, 'NOTES.md')
  const rollingNotesFile = join(files.out, 'ROLLING.md')
  writeFileSync(notesFile, releaseNotes({ ...o, repo, server: files.server }))
  writeFileSync(rollingNotesFile, rollingNotes({ ...o, repo }))
  const gh = (args, quiet = false) => execFileSync('gh', [...args, ...(repo ? ['--repo', repo] : [])], { stdio: quiet ? 'ignore' : 'inherit' })
  const exists = (tag) => {
    if (o.dryRun) return false
    try { gh(['release', 'view', tag], true); return true } catch { return false }
  }
  for (const step of plan({ ...o, files, notesFile, rollingNotesFile, exists })) {
    if (o.dryRun) console.log(`gh ${step.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}${repo ? ` --repo ${repo}` : ''}`)
    else gh(step)
  }
  const link = `https://github.com/${repo || '<owner>/<repo>'}/releases/latest/download/${STABLE.dmg}`
  console.log(`\n${o.dryRun ? 'Would publish' : 'Published'} ${tagFor(o.version, o.build)} (${o.signing}). Download: ${link}`)
  if (process.env.GITHUB_STEP_SUMMARY && !o.dryRun) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `### SahilBot ${o.version} build ${o.build}\n\nDownload: ${link}\n\nSigning: ${o.signing}\n`, { flag: 'a' })
  if (!existsSync(files.stable[0])) throw new Error('stable DMG missing')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
