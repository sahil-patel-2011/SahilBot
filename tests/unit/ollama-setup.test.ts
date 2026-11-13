import { describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { parseCodesign, isAllowedBundleId, parseDigest, digestMatches, pickAsset, identityProblem } = await import('../../src/main/ollama-setup')

// `codesign -dv --verbose=4 Ollama.app` (stderr), with a made-up team id.
const GOOD = `Executable=/Applications/Ollama.app/Contents/MacOS/Ollama
Identifier=com.electron.ollama
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=27+7 location=embedded
Hash type=sha256 size=32
CDHash=0123456789abcdef0123456789abcdef01234567
Signature size=9000
Authority=Developer ID Application: Example Ollama Inc (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=1 Nov 2026 at 10:00:00
Notarization Ticket=stapled
Info.plist entries=24
TeamIdentifier=ABCDE12345
Runtime Version=14.0.0
Sealed Resources version=2 rules=13 files=200
Internal requirements count=1 size=200
`
const EVIL = GOOD.replace('Identifier=com.electron.ollama', 'Identifier=com.evil.notollama')
const ADHOC = `Executable=/x/Ollama.app/Contents/MacOS/Ollama
Identifier=com.electron.ollama
Signature=adhoc
TeamIdentifier=not set
`

describe('codesign identity', () => {
  test('parses identifier, team and authorities', () => {
    expect(parseCodesign(GOOD)).toEqual({
      identifier: 'com.electron.ollama',
      teamId: 'ABCDE12345',
      authorities: ['Developer ID Application: Example Ollama Inc (ABCDE12345)', 'Developer ID Certification Authority', 'Apple Root CA']
    })
    expect(parseCodesign(ADHOC).teamId).toBeUndefined()
  })
  test('bundle id must match exactly', () => {
    expect(isAllowedBundleId('com.electron.ollama')).toBe(true)
    for (const id of ['com.evil.notollama', 'com.electron.ollama.evil', 'xcom.electron.ollama', 'COM.ELECTRON.OLLAMA', '', undefined]) expect(isAllowedBundleId(id)).toBe(false)
  })
  test('identity checks: bundle id, Developer ID, pinned team', () => {
    expect(identityProblem(parseCodesign(GOOD), undefined)).toBeNull()
    expect(identityProblem(parseCodesign(GOOD), 'ABCDE12345')).toBeNull()
    expect(identityProblem(parseCodesign(GOOD), 'ZZZZZ99999')).toMatch(/not ZZZZZ99999/)
    expect(identityProblem(parseCodesign(EVIL), undefined)).toMatch(/bundle id/)
    expect(identityProblem(parseCodesign(ADHOC), undefined)).toMatch(/team/)
    expect(identityProblem(parseCodesign(GOOD.replace(/^Authority=Developer ID Application.*$/m, 'Authority=Apple Development: someone')), undefined)).toMatch(/Developer ID/)
  })
})

describe('release digest', () => {
  const hex = 'a'.repeat(64)
  test('parses sha256 digests only', () => {
    expect(parseDigest(`sha256:${hex.toUpperCase()}`)).toBe(hex)
    expect(parseDigest(`sha512:${hex}`)).toBeUndefined()
    expect(parseDigest('sha256:abc')).toBeUndefined()
    expect(parseDigest(null)).toBeUndefined()
  })
  test('comparison fails closed', () => {
    expect(digestMatches(`sha256:${hex}`, hex)).toBe(true)
    expect(digestMatches(`sha256:${hex}`, hex.toUpperCase())).toBe(true)
    expect(digestMatches(`sha256:${hex}`, 'b'.repeat(64))).toBe(false)
    expect(digestMatches(undefined, hex)).toBe(false)
    expect(digestMatches('sha256:', '')).toBe(false)
  })
  test('picks the mac zip from ollama/ollama releases only', () => {
    const release = {
      tag_name: 'v0.40.16',
      assets: [
        { name: 'ollama-darwin.tgz', browser_download_url: 'https://github.com/ollama/ollama/releases/download/v0.40.16/ollama-darwin.tgz', digest: `sha256:${'c'.repeat(64)}` },
        { name: 'Ollama-darwin.zip', browser_download_url: 'https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip', digest: `sha256:${hex}`, size: 229245253 }
      ]
    }
    expect(pickAsset(release)).toEqual({ url: 'https://github.com/ollama/ollama/releases/download/v0.40.16/Ollama-darwin.zip', digest: `sha256:${hex}`, size: 229245253, version: 'v0.40.16' })
    const noDigest = { assets: [{ ...release.assets[1], digest: undefined }] }
    expect(pickAsset(noDigest)?.digest).toBeUndefined()
    expect(pickAsset({ assets: [{ ...release.assets[1], browser_download_url: 'https://evil.example/Ollama-darwin.zip' }] })).toBeUndefined()
    expect(pickAsset({ assets: [{ ...release.assets[1], browser_download_url: 'https://github.com/evil/ollama/releases/download/v1/Ollama-darwin.zip' }] })).toBeUndefined()
    expect(pickAsset({ message: 'API rate limit exceeded' })).toBeUndefined()
  })
})
