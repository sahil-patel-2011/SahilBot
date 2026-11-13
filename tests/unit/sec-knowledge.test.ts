import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test, vi } from 'vitest'
import { extractFile } from '../../src/main/knowledge/extract'
import { extractRich, zipProblem, zipStats } from '../../src/main/knowledge/extract-worker'
import { inForbidden, insideCI, opensDirectly, redactSecrets, refuseRoot } from '../../src/main/knowledge/ignore'
import { Indexer } from '../../src/main/knowledge/indexer'
import { KnowledgeStore } from '../../src/main/knowledge/store'

// M1 symlink escapes, M2 secret redaction, M3 extraction off the main thread, L3 Open, L6 roots.

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kbsec-')))
  const home = join(dir, 'home')
  mkdirSync(join(home, 'Library', 'App'), { recursive: true })
  writeFileSync(join(home, 'Library', 'App', 'config.json'), '{"note":"SECRETMARKER library data"}')
  mkdirSync(join(dir, 'elsewhere'), { recursive: true })
  writeFileSync(join(dir, 'elsewhere', 'private.md'), 'OUTSIDEMARKER private notes')
  const root = join(dir, 'src')
  mkdirSync(root)
  writeFileSync(join(root, 'a.md'), 'hello')
  const store = new KnowledgeStore(new DatabaseSync(':memory:'))
  const ix = new Indexer(store, { home })
  return { dir, home, root, store, ix }
}

describe('M1: symlinks never lead the index out of a source folder', () => {
  test('the reviewer\'s probe: links added after the scan and reported by the watcher are not followed', async () => {
    const { home, root, store, ix } = setup()
    await ix.scan([root]); await ix.drain()
    symlinkSync(join(home, 'Library', 'App'), join(root, 'docs'))
    symlinkSync(join(home, 'Library', 'App', 'config.json'), join(root, 'notes.json'))
    await ix.changed([join(root, 'docs'), join(root, 'notes.json')], [root]); await ix.drain()
    expect(store.paths()).toEqual([join(root, 'a.md')])
    expect(store.keyword('SECRETMARKER', [root], 10)).toEqual([])
  })

  test('a file under a symlinked folder (reported directly) is refused by its real path', async () => {
    const { dir, root, store, ix } = setup()
    symlinkSync(join(dir, 'elsewhere'), join(root, 'linked'))
    await ix.changed([join(root, 'linked', 'private.md')], [root]); await ix.drain()
    expect(await ix.indexFile(join(root, 'linked', 'private.md'), root)).toBe('ignored')
    expect(store.keyword('OUTSIDEMARKER', [root], 10)).toEqual([])
  })

  test('a file swapped for a link after it was indexed is dropped', async () => {
    const { dir, root, store, ix } = setup()
    await ix.scan([root]); await ix.drain()
    expect(store.doc(join(root, 'a.md'))).toBeTruthy()
    const { rmSync } = await import('node:fs')
    rmSync(join(root, 'a.md'))
    symlinkSync(join(dir, 'elsewhere', 'private.md'), join(root, 'a.md'))
    expect(await ix.indexFile(join(root, 'a.md'), root)).toBe('removed')
    expect(store.doc(join(root, 'a.md'))).toBeUndefined()
  })

  test('contained(): real path inside the real root and outside forbidden places', async () => {
    const { dir, home, root, ix } = setup()
    expect(await ix.contained(root, join(root, 'a.md'))).toBe(join(root, 'a.md'))
    symlinkSync(join(home, 'Library'), join(root, 'lib'))
    expect(await ix.contained(root, join(root, 'lib', 'App', 'config.json'))).toBeNull()
    expect(await ix.contained(root, join(dir, 'elsewhere', 'private.md'))).toBeNull()
  })
})

describe('M2: secrets in JSON, YAML, .env and plists are redacted', () => {
  const cases: Array<[string, RegExp, string]> = [
    ['{"password": "hunter2hunter", "user": "sam"}', /hunter2/, '"password": "[redacted]"'],
    ['{"refresh_token":"1//0gAbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}', /AbCdEf/, '"refresh_token":"[redacted]"'],
    ['{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n", "client_email": "a@b.iam"}', /MIIEvQ/, '"private_key": "[redacted]"'],
    ['{"client_secret":"GOCSPX-abc123def456"}', /GOCSPX/, '"client_secret":"[redacted]"'],
    ["apikey: 'abcd1234efgh5678'", /abcd1234/, "apikey: '[redacted]'"],
    ['DB_PASSWORD=supersecret1', /supersecret/, 'DB_PASSWORD=[redacted]'],
    ['<key>Password</key>\n\t<string>p@ss w0rd!</string>', /p@ss/, '<key>Password</key>\n\t<string>[redacted]</string>'],
    ['<key>api_key</key><string>zzzzyyyyxxxx</string>', /zzzz/, '<key>api_key</key><string>[redacted]</string>'],
    ['Authorization: Bearer abcdefghijklmnop1234', /abcdefghij/, 'Bearer [redacted]'],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', /wJalr/, 'aws_secret_access_key = [redacted]']
  ]
  for (const [input, gone, kept] of cases) {
    test(input.slice(0, 50), () => {
      const out = redactSecrets(input)
      expect(out).not.toMatch(gone)
      expect(out).toContain(kept)
    })
  }
  test('ordinary text is left alone', () => {
    expect(redactSecrets('The password policy needs 12 characters.')).toBe('The password policy needs 12 characters.')
    expect(redactSecrets('{"name": "Sam", "tokens": 42}')).toBe('{"name": "Sam", "tokens": 42}')
  })
})

/** A zip whose one entry unpacks to `size` bytes of zeros (deflates to almost nothing). */
async function zipOf(size: number, name = 'word/document.xml'): Promise<Buffer> {
  const JSZip = (await import('jszip')).default
  const z = new JSZip()
  z.file(name, Buffer.alloc(size))
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

describe('M3: documents are parsed in a worker with limits', () => {
  test('zip stats come from the central directory; an Office file that unpacks too big is refused before parsing', async () => {
    const buf = await zipOf(5_000_000)
    expect(buf.length).toBeLessThan(100_000)
    expect(zipStats(buf)).toMatchObject({ uncompressed: 5_000_000 }) // plus the folder entry JSZip adds
    expect(zipProblem(buf, 1_000_000)).toMatch(/unpacks to more than/)
    expect(zipProblem(buf)).toBe('')
    expect(zipProblem(Buffer.from('not a zip at all, just text'))).toMatch(/unreadable/)
  })

  test('extractFile refuses a zip bomb without parsing it', async () => {
    const { dir } = setup()
    const path = join(dir, 'bomb.docx')
    const buf = await zipOf(210 * 1024 * 1024)
    writeFileSync(path, buf)
    expect(await extractFile(path, { data: buf })).toEqual({ skip: expect.stringMatching(/unpacks to more than 200 MB/) })
  })

  test('a parse that runs too long is stopped (the worker is terminated)', async () => {
    const JSZip = (await import('jszip')).default
    const z = new JSZip()
    z.file('ppt/slides/slide1.xml', '<a:p><a:t>Hello</a:t></a:p>')
    const buf = Buffer.from(await z.generateAsync({ type: 'nodebuffer' }))
    await expect(extractRich('pptx', buf, { timeoutMs: 1 })).rejects.toThrow(/timed out/)
    // With time to finish, the same file parses in the worker.
    const r = await extractRich('pptx', buf)
    expect(r).toEqual({ kind: 'pptx', slides: [{ n: 1, texts: ['Hello'], notes: '' }] })
  })

  test('a file is recorded as "extracting" before parsing, so a crash can\'t loop at every launch', async () => {
    const { root, store, ix } = setup()
    const JSZip = (await import('jszip')).default
    const z = new JSZip()
    z.file('ppt/slides/slide1.xml', '<a:p><a:t>Deck text</a:t></a:p>')
    writeFileSync(join(root, 'deck.pptx'), Buffer.from(await z.generateAsync({ type: 'nodebuffer' })))
    const seen: Array<string | undefined> = []
    const upsert = store.upsert.bind(store)
    const spy = vi.spyOn(store, 'upsert').mockImplementation((doc, chunks) => { seen.push(doc.skipped); upsert(doc, chunks) })
    expect(await ix.indexFile(join(root, 'deck.pptx'), root)).toBe('indexed')
    expect(seen).toEqual(['extracting', undefined])
    // If parsing had taken SahilBot down, the 'extracting' record (same size, time and hash) means "unchanged".
    spy.mockRestore()
    const doc = store.doc(join(root, 'deck.pptx'))!
    store.upsert({ ...doc, skipped: 'extracting' }, [])
    expect(await ix.indexFile(join(root, 'deck.pptx'), root)).toBe('unchanged')
  })
})

describe('L3: "Open" only opens documents; code, scripts and web pages are shown in Finder', () => {
  test('which formats open directly', () => {
    for (const p of ['/a/b.pdf', '/a/b.docx', '/a/b.md', '/a/b.txt', '/a/b.csv', '/a/B.XLSX']) expect(opensDirectly(p)).toBe(true)
    for (const p of ['/a/b.py', '/a/b.rb', '/a/b.pl', '/a/b.php', '/a/b.js', '/a/b.html', '/a/b.sh', '/a/b.command', '/a/b.applescript', '/a/b.json', '/a/Makefile']) expect(opensDirectly(p)).toBe(false)
  })
})

describe('L6: forbidden folders are compared without regard to case; the home folder itself is refused', () => {
  const home = '/Users/sam'
  test('case-insensitive', () => {
    expect(inForbidden('/users/sam/library/Keychains/x', home)).toBe(true)
    expect(inForbidden('/Users/Sam/LIBRARY/x', home)).toBe(true)
    expect(inForbidden('/users/sam/.SSH/id_rsa', home)).toBe(true)
    expect(inForbidden('/Users/sam/Documents/x', home)).toBe(false)
    expect(refuseRoot('/users/sam/Library/Mobile Documents', home)).toMatch(/never indexed/)
    expect(refuseRoot('/system/x', home)).toMatch(/never indexed/)
    expect(insideCI('/Users/Sam', '/users/sam/a')).toBe(true)
    expect(insideCI('/Users/Sam', '/Users/Samuel/a')).toBe(false)
  })
  test('the home folder itself, and whole-disk folders in any case, are refused as sources', () => {
    expect(refuseRoot('/Users/sam', home)).toMatch(/whole home folder/)
    expect(refuseRoot('/users/SAM/', home)).toMatch(/whole home folder/)
    expect(refuseRoot('/USERS', home)).toMatch(/whole disk/)
    expect(refuseRoot('/Users/sam/Documents', home)).toBe('')
  })
})
