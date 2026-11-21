import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { BackupService, RECOVERY_FILE, RECOVERY_SECRET, RecoveryError, copyVaultFolder, excludedFromRecovery, makeRecoveryKey, openRecovery, restoreSecrets, sealRecovery, writeMemoryExport, type SecretsLike } from '../../src/main/backup'
import { backupData } from '../../src/main/updater'
import type { Memory } from '../../src/main/memory'

const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const PW = 'correct horse battery staple'

function fakeSecrets(init: Record<string, string> = {}): SecretsLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(init))
  return {
    map,
    names: () => [...map.keys()],
    get: (n) => map.get(n),
    set: (n, v) => { if (v === null || v === '') map.delete(n); else map.set(n, v) },
    has: (n) => map.has(n)
  }
}

const mem = (id: string, category: Memory['category'], content: string, spaceId: string | null = null, at = Date.UTC(2026, 10, 20)): Memory =>
  ({ id, category, content, spaceId, projectId: spaceId, source: 'chat', provenance: 'trusted', createdAt: at, updatedAt: at })

describe('key recovery file', () => {
  test('round trip: the keys come back with the password, never with another', async () => {
    const rk = await makeRecoveryKey(PW, { quick: true })
    const text = sealRecovery(rk, { 'key:https://api.anthropic.com': 'sk-ant-123', braveKey: 'BSA-xyz' })
    // Names and values are not readable in the file.
    expect(text).not.toContain('sk-ant-123')
    expect(text).not.toContain('anthropic')
    expect(JSON.parse(text).count).toBe(2)
    expect(await openRecovery(text, PW)).toEqual({ 'key:https://api.anthropic.com': 'sk-ant-123', braveKey: 'BSA-xyz' })
    await expect(openRecovery(text, 'wrong password!!')).rejects.toBeInstanceOf(RecoveryError)
    await expect(openRecovery(text, 'wrong password!!')).rejects.toThrow('Wrong recovery password')
  })

  test('an edited file fails (body or header), and junk is refused as not a recovery file', async () => {
    const rk = await makeRecoveryKey(PW, { quick: true })
    const text = sealRecovery(rk, { a: '1' })
    const j = JSON.parse(text)
    const flipped = Buffer.from(j.data, 'base64'); flipped[flipped.length - 20] ^= 1
    await expect(openRecovery(JSON.stringify({ ...j, data: flipped.toString('base64') }), PW)).rejects.toThrow('changed')
    await expect(openRecovery(JSON.stringify({ ...j, count: 5 }), PW)).rejects.toThrow('changed')
    await expect(openRecovery('{"hello":1}', PW)).rejects.toThrow('isn\'t a SahilBot recovery file')
    await expect(openRecovery('not json', PW)).rejects.toThrow('isn\'t a SahilBot recovery file')
    await expect(openRecovery(JSON.stringify({ ...j, kdf: { ...j.kdf, N: 2 ** 30 } }), PW)).rejects.toThrow('unsafe')
  })

  test('short passwords are refused; the passwords vault\'s keys and the recovery key are never included', async () => {
    await expect(makeRecoveryKey('short', { quick: true })).rejects.toThrow('10 characters')
    expect(excludedFromRecovery('vault2:k1')).toBe(true)
    expect(excludedFromRecovery(RECOVERY_SECRET)).toBe(true)
    expect(excludedFromRecovery('key:https://api.openai.com')).toBe(false)
    const rk = await makeRecoveryKey(PW, { quick: true })
    const out = await openRecovery(sealRecovery(rk, { 'vault2:k1': 'K1', 'vault2:kbio': 'B', [RECOVERY_SECRET]: 'x', ok: 'yes' }), PW)
    expect(out).toEqual({ ok: 'yes' })
  })

  test('restore keeps keys already here unless replace', () => {
    const s = fakeSecrets({ a: 'mine' })
    expect(restoreSecrets({ a: 'theirs', b: 'new', 'vault2:k1': 'nope' }, s)).toEqual({ restored: 1, kept: 1 })
    expect(s.map.get('a')).toBe('mine')
    expect(s.map.get('b')).toBe('new')
    expect(s.map.has('vault2:k1')).toBe(false)
    expect(restoreSecrets({ a: 'theirs' }, s, true)).toEqual({ restored: 1, kept: 0 })
    expect(s.map.get('a')).toBe('theirs')
  })
})

describe('knowledge vault copy', () => {
  test('copies notes and .history; leaves out .trash, symlinks and big files', () => {
    const vault = tmp('sb-vault-'), dest = join(tmp('sb-dest-'), 'vault'), outside = tmp('sb-outside-')
    mkdirSync(join(vault, 'Shared', 'People'), { recursive: true })
    writeFileSync(join(vault, 'Home.md'), '# Home')
    writeFileSync(join(vault, 'Shared', 'People', 'Jane.md'), '# Jane')
    mkdirSync(join(vault, '.history')); writeFileSync(join(vault, '.history', 'Jane.1.md'), 'old')
    mkdirSync(join(vault, '.trash')); writeFileSync(join(vault, '.trash', 'Gone.md'), 'gone')
    writeFileSync(join(outside, 'secret.txt'), 'outside the vault')
    symlinkSync(outside, join(vault, 'escape'))
    writeFileSync(join(vault, 'big.bin'), Buffer.alloc(2048))
    const r = copyVaultFolder(vault, dest, { dataDir: tmp('sb-data-'), backupRoots: [], maxBytes: 1024 })
    expect(readFileSync(join(dest, 'Shared', 'People', 'Jane.md'), 'utf8')).toBe('# Jane')
    expect(existsSync(join(dest, '.history', 'Jane.1.md'))).toBe(true)
    expect(existsSync(join(dest, '.trash'))).toBe(false)
    expect(existsSync(join(dest, 'escape'))).toBe(false)
    expect(existsSync(join(dest, 'big.bin'))).toBe(false)
    expect(r).toMatchObject({ files: 3, skipped: 2 })
  })

  test('a vault inside the data or backup folder is refused; a backup folder inside the vault is skipped', () => {
    const data = tmp('sb-data-')
    mkdirSync(join(data, 'vault'))
    expect(() => copyVaultFolder(join(data, 'vault'), join(tmp('sb-d-'), 'v'), { dataDir: data, backupRoots: [] })).toThrow('inside')
    const vault = tmp('sb-vault-')
    writeFileSync(join(vault, 'a.md'), 'a')
    mkdirSync(join(vault, 'Backups')); writeFileSync(join(vault, 'Backups', 'old.db'), 'x')
    const dest = join(tmp('sb-d-'), 'v')
    copyVaultFolder(vault, dest, { dataDir: data, backupRoots: [join(vault, 'Backups')] })
    expect(existsSync(join(dest, 'a.md'))).toBe(true)
    expect(existsSync(join(dest, 'Backups'))).toBe(false)
  })
})

describe('readable export', () => {
  test('memories grouped by scope and category, decisions apart, nothing secret-looking', () => {
    const dir = tmp('sb-export-')
    const r = writeMemoryExport(dir, [
      mem('1', 'profile', 'Goes by Jeff. Urologist.'),
      mem('2', 'preference', 'Wants summaries as bullet points.'),
      mem('3', 'decision', 'Payment provider → Stripe (over Paddle)'),
      mem('4', 'rule', 'Always cite PMIDs.', 'bot1'),
      mem('5', 'fact', 'My bank password is hunter2')
    ], { spaceName: (id) => (id === 'bot1' ? 'Research bot' : undefined) })
    expect(r).toEqual({ memories: 4, decisions: 1 })
    const md = readFileSync(join(dir, 'memories.md'), 'utf8')
    expect(md).toContain('## Shared (every bot)')
    expect(md).toContain('### About you')
    expect(md).toContain('## Only Research bot')
    expect(md).not.toContain('Stripe')
    expect(md).not.toContain('hunter2')
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toContain('Payment provider → Stripe (over Paddle)')
    const json = JSON.parse(readFileSync(join(dir, 'memories.json'), 'utf8'))
    expect(json.memories).toHaveLength(4)
    expect(JSON.stringify(json)).not.toContain('hunter2')
  })
})

describe('BackupService', () => {
  const setup = (secrets = fakeSecrets({ 'key:https://api.anthropic.com': 'sk-ant-1', 'vault2:k1': 'K1' })) => {
    const data = tmp('sb-data-'), main = tmp('sb-main-'), mirror = tmp('sb-mirror-'), vault = tmp('sb-vault-')
    writeFileSync(join(data, 'foreman.db'), 'DB')
    writeFileSync(join(vault, 'Home.md'), '# Home')
    const settings = new Map<string, unknown>()
    const svc = new BackupService({
      dataDir: data, mainDir: main, mirrorDir: mirror,
      backupData: (o) => backupData(data, 'profile copy', { to: main, mirror, extras: o.extras, extraMirror: o.extraMirror }),
      vaultRoot: () => vault,
      memories: () => [mem('1', 'decision', 'Format → PDF'), mem('2', 'preference', 'Short answers.')],
      secrets,
      getSetting: <T,>(k: string) => settings.get(k) as T | undefined,
      setSetting: (k, v) => { settings.set(k, v) },
      quickKdf: true
    })
    return { svc, data, main, mirror, vault, secrets }
  }

  test('a backup holds the data, the vault, the export, and keys only after a recovery password is set', async () => {
    const { svc, main, mirror, secrets } = setup()
    const first = await svc.backupNow()
    expect(readFileSync(join(first, 'foreman.db'), 'utf8')).toBe('DB')
    expect(readFileSync(join(first, 'vault', 'Home.md'), 'utf8')).toBe('# Home')
    expect(readFileSync(join(first, 'export', 'decisions.md'), 'utf8')).toContain('Format → PDF')
    expect(existsSync(join(first, RECOVERY_FILE))).toBe(false)
    expect(svc.status().last?.includes).toContain('API keys (this Mac\'s Keychain only)')

    await svc.setRecoveryPassword(PW)
    expect(svc.hasRecovery()).toBe(true)
    // The password itself is never stored.
    expect(secrets.map.get(RECOVERY_SECRET)).not.toContain(PW)
    const second = await svc.backupNow()
    const text = readFileSync(join(second, RECOVERY_FILE), 'utf8')
    expect(await openRecovery(text, PW)).toEqual({ 'key:https://api.anthropic.com': 'sk-ant-1' })
    // The second copy has it too.
    expect(readdirSync(mirror).some((n) => existsSync(join(mirror, n, RECOVERY_FILE)))).toBe(true)
    const st = svc.status()
    expect(st.recoveryPassword).toBe(true)
    expect(st.last?.includes).toEqual(expect.arrayContaining(['knowledge vault', 'memories & decisions', 'API keys (recovery password)']))
    expect(st.folders.map((f) => f.path)).toEqual([main, mirror])

    // On a new Mac: restore from the file.
    const fresh = fakeSecrets({})
    const other = setup(fresh).svc
    expect(await other.restoreKeys(text, PW)).toEqual({ restored: 1, kept: 0 })
    expect(fresh.map.get('key:https://api.anthropic.com')).toBe('sk-ant-1')
    await expect(other.restoreKeys(text, 'not the password')).rejects.toThrow('Wrong recovery password')
  })

  test('the extra folder must be outside the data and backup folders, and gets a copy of each backup', async () => {
    const { svc, data, main } = setup()
    expect(svc.setExtraDir(join(data)).ok).toBe(false)
    expect(svc.setExtraDir(main).ok).toBe(false)
    expect(svc.setExtraDir('/no/such/folder').ok).toBe(false)
    const extra = tmp('sb-extra-')
    expect(svc.setExtraDir(extra)).toEqual({ ok: true })
    await svc.backupNow()
    expect(readdirSync(extra).filter((n) => /^\d{4}-/.test(n))).toHaveLength(1)
    expect(svc.status().folders.map((f) => f.kind)).toEqual(['main', 'mirror', 'extra'])
  })
})
