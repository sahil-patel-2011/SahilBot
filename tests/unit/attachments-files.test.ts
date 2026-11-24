import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { MAX_ATTACH_BYTES, attachmentNotes, blobName, categoryOf, processAttachment, screencaptureArgs, takeScreenshot } from '../../src/main/attach-process'
import { scanFolder } from '../../src/main/knowledge/folder-scan'
import { fileTools, neverOutside, outsidePath, resolvePath } from '../../src/main/agent/tools/files'
import { cwdFor } from '../../src/main/agent/tools/shell'
import { chatScope } from '../../src/main/agent/tools/knowledge'
import { chipDetail, fromTransfer, mergeAttachments, oversize, rejectedText } from '../../src/renderer/src/lib/attachments'

const dir = (p = 'sb-att-'): string => realpathSync(mkdtempSync(join(tmpdir(), p)))
// A 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('attachment processing: types, size caps, HEIC', () => {
  test('categories come from the name, sniffing only unknown names', () => {
    const d = dir()
    const unknownText = join(d, 'notes.weird'); writeFileSync(unknownText, 'plain words')
    const unknownBin = join(d, 'blob.weird'); writeFileSync(unknownBin, Buffer.from([0, 1, 2, 3, 0, 255]))
    expect(categoryOf(join(d, 'a.png'))).toBe('image')
    expect(categoryOf(join(d, 'IMG_1.HEIC'))).toBe('image')
    expect(categoryOf(join(d, 'paper.pdf'))).toBe('pdf')
    expect(categoryOf(join(d, 'deck.pptx'))).toBe('office')
    expect(categoryOf(join(d, 'old.doc'))).toBe('binary')
    expect(categoryOf(join(d, 'main.ts'))).toBe('code')
    expect(categoryOf(join(d, 'Makefile'))).toBe('code')
    expect(categoryOf(join(d, 'data.csv'))).toBe('text')
    expect(categoryOf(join(d, 'movie.mov'))).toBe('binary')
    expect(categoryOf(unknownText)).toBe('text')
    expect(categoryOf(unknownBin)).toBe('binary')
    expect(categoryOf(d, true)).toBe('folder')
  })

  test('text, code, documents, binaries and folders are described; nothing is read into the note', async () => {
    const d = dir()
    writeFileSync(join(d, 'a.md'), '# Hi')
    writeFileSync(join(d, 'b.py'), 'print(1)')
    writeFileSync(join(d, 'c.pdf'), '%PDF-1.4 fake')
    writeFileSync(join(d, 'd.zip'), Buffer.from([0x50, 0x4b, 3, 4, 0, 0]))
    const r = await Promise.all(['a.md', 'b.py', 'c.pdf', 'd.zip'].map((n) => processAttachment(join(d, n))))
    const ok = r.map((x) => (x.ok ? x.attachment : null))
    expect(ok.map((a) => a?.category)).toEqual(['text', 'code', 'pdf', 'binary'])
    expect(ok[3]?.note).toMatch(/zip archive, 6 B: listed, not read as text/)
    expect(ok[2]?.note).toMatch(/extracted/)
    const folder = await processAttachment(d)
    expect(folder.ok && folder.attachment.kind).toBe('folder')

    const notes = attachmentNotes([...ok.filter((a): a is NonNullable<typeof a> => !!a), { path: d, name: 'd', kind: 'folder', category: 'folder', files: 4 }]).join('\n')
    expect(notes).toContain('Attached files')
    expect(notes).toContain('PDF: file_read extracts its text')
    expect(notes).toMatch(/d\.zip \(6 B, zip archive.*don't read it as text/)
    expect(notes).toContain('code: read it with file_read')
    expect(notes).toMatch(/Attached folders[\s\S]*knowledge_search with scope "chat"[\s\S]*\(4 indexable files\)/)
    expect(notes).not.toContain('# Hi')
  })

  test('files over the cap are refused with a clear message', async () => {
    const d = dir()
    const big = join(d, 'huge.bin')
    writeFileSync(big, '')
    truncateSync(big, MAX_ATTACH_BYTES + 1)
    const r = await processAttachment(big)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/Files up to 100\.0 MB can be attached; for a bigger one, attach the folder/)
    expect((await processAttachment(join(d, 'missing.txt'))).ok).toBe(false)
  })

  test('images go to vision scaled down; HEIC is converted to JPEG first (sips stubbed)', async () => {
    const d = dir()
    const png = join(d, 'shot.png'); writeFileSync(png, PNG)
    const heic = join(d, 'IMG_0001.HEIC'); writeFileSync(heic, 'fake heic')
    const edges: number[] = []
    const imageDataUrl = async (p: string, edge: number): Promise<string> => { edges.push(edge); return `data:image/x;base64,${Buffer.from(p).toString('base64')}` }
    const a = await processAttachment(png, { imageDataUrl })
    expect(a.ok && a.attachment.kind).toBe('image')
    expect(edges[0]).toBe(2048)
    const jpg = join(d, 'converted.jpg')
    const b = await processAttachment(heic, { imageDataUrl, heicToJpeg: async () => { writeFileSync(jpg, 'jpeg'); return jpg } })
    expect(b.ok).toBe(true)
    if (b.ok) {
      expect(b.attachment).toMatchObject({ kind: 'image', path: jpg, mime: 'image/jpeg', name: 'IMG_0001.jpg', note: 'converted from HEIC to JPEG' })
      expect(Buffer.from(b.attachment.dataUrl!.split(',')[1], 'base64').toString()).toBe(jpg)
    }
    // A failed conversion still attaches the file (listed, with why).
    const c = await processAttachment(heic, { imageDataUrl, heicToJpeg: async () => { throw new Error('sips failed') } })
    expect(c.ok && c.attachment).toMatchObject({ kind: 'file', category: 'image' })
    expect(c.ok && c.attachment.note).toMatch(/couldn't convert/)
    // An image the viewer can't decode is listed, not shown.
    const e = await processAttachment(png, { imageDataUrl: async () => null })
    expect(e.ok && e.attachment.kind).toBe('file')
  })

  test('pasted data gets a safe name; screenshots use the interactive region picker and can be cancelled', async () => {
    expect(blobName('', 'image/png')).toBe('Pasted image.png')
    expect(blobName('../../etc/passwd', 'text/plain')).toBe('passwd.txt')
    expect(blobName('.hidden', 'image/jpeg')).toBe('hidden.jpg')
    expect(screencaptureArgs('/x.png').slice(0, 2)).toEqual(['-i', '-x'])
    const tmp = dir('sb-shot-')
    const calls: string[][] = []
    const taken = await takeScreenshot({ tmp, now: new Date(2026, 10, 15, 9, 5, 7), run: async (bin, args) => { calls.push([bin, ...args]); writeFileSync(args[args.length - 1], PNG) } })
    expect(calls[0][0]).toBe('/usr/sbin/screencapture')
    expect(calls[0]).toContain('-i')
    expect(taken).toMatch(/Screenshot 2026-11-15 at 09\.05\.07\.png$/)
    expect(existsSync(taken!)).toBe(true)
    // Esc: no file, nothing attached.
    expect(await takeScreenshot({ tmp, run: async () => undefined })).toBeNull()
  })
})

describe('attached folders: counted with the knowledge base ignore rules', () => {
  test('node_modules, build output, hidden folders, secrets and .gitignore matches are skipped; progress is reported', async () => {
    const d = dir('sb-folder-')
    const w = (rel: string, text = 'x'): void => { mkdirSync(join(d, rel, '..'), { recursive: true }); writeFileSync(join(d, rel), text) }
    w('README.md', '# Project')
    w('src/app.ts', 'export const a = 1')
    w('src/notes/plan.md', 'plan')
    w('node_modules/lib/index.js', 'module')
    w('build/out.js', 'built')
    w('.git/config', '[core]')
    w('.env', 'KEY=secret')
    w('id_rsa', 'key')
    w('private/diary.md', 'secret diary')
    w('.gitignore', 'private/\n')
    const events: number[] = []
    const r = await scanFolder(d, { everyMs: 0, onProgress: (e) => events.push(e.files) })
    expect(r.files).toBe(3)
    expect(r.sample.map((p) => p.slice(d.length + 1)).sort()).toEqual(['README.md', 'src/app.ts', 'src/notes/plan.md'])
    expect(r.bytes).toBeGreaterThan(0)
    expect(events.at(-1)).toBe(3)
    // The limit is reported as truncated.
    expect((await scanFolder(d, { maxFiles: 2 })).truncated).toBe(true)
    // Places SahilBot never indexes are refused.
    await expect(scanFolder('/System')).rejects.toThrow(/never indexed|system/)
  })
})

describe('working folder: relative paths, writes outside ask, commands run there', () => {
  test('relative paths resolve in the working folder; outside paths are found (and secrets/system never)', () => {
    const ws = dir('sb-ws-')
    const wf = dir('sb-wf-')
    const other = dir('sb-other-')
    expect(resolvePath('a.md', ws, [wf], { base: wf })).toBe(join(wf, 'a.md'))
    expect(resolvePath('a.md', ws, [wf])).toBe(join(ws, 'a.md'))
    expect(() => resolvePath(join(other, 'x.md'), ws, [wf], { base: wf })).toThrow(/outside the workspace/)
    expect(resolvePath(join(other, 'x.md'), ws, [wf], { base: wf, allowOutside: true })).toBe(join(other, 'x.md'))
    expect(outsidePath(join(other, 'x.md'), ws, [wf], wf)).toBe(join(other, 'x.md'))
    expect(outsidePath(join(wf, 'x.md'), ws, [wf], wf)).toBeNull()
    expect(outsidePath('docs/index.md', ws, [], wf)).toBeNull()
    expect(neverOutside('/etc/hosts')).toMatch(/system/)
    expect(neverOutside(join(other, '.env'))).toMatch(/secrets/)
    expect(() => resolvePath('/etc/hosts', ws, [], { allowOutside: true })).toThrow(/outside the workspace and the folders the user attached/)
    expect(outsidePath('/etc/hosts', ws, [])).toBeNull()
  })

  test('file tools: writing outside asks first (hard stop), runs only once approved; reading in the working folder just works', async () => {
    const ws = dir('sb-ws-')
    const wf = dir('sb-wf-')
    const other = dir('sb-other-')
    writeFileSync(join(wf, 'notes.md'), 'in the folder')
    const [read, write, , manage] = fileTools(() => ws, ws)
    const state = { roots: [wf], folder: wf, loaded: [], alwaysAllow: [], todos: [] }
    const ctx = { state } as never
    expect((await read.run({ path: 'notes.md' }, ctx)).text).toBe('in the folder')
    expect(read.hardStop!({ path: 'notes.md' }, { roots: [wf], folder: wf })).toBeNull()
    await write.run({ path: 'new.md', content: 'made here' }, ctx)
    expect(readFileSync(join(wf, 'new.md'), 'utf8')).toBe('made here')

    const out = join(other, 'escape.md')
    expect(write.hardStop!({ path: out, content: 'x' }, { roots: [wf], folder: wf })).toMatch(/writing .*escape\.md, outside your folders/)
    expect(read.hardStop!({ path: out }, { roots: [wf], folder: wf })).toMatch(/reading/)
    expect(manage.hardStop!({ op: 'copy', path: 'notes.md', to: out }, { roots: [wf], folder: wf })).toMatch(/copying to/)
    await expect(write.run({ path: out, content: 'x' }, ctx)).rejects.toThrow(/outside the workspace/)
    await write.run({ path: out, content: 'approved' }, { state, approved: true } as never)
    expect(readFileSync(out, 'utf8')).toBe('approved')
    // Secret files outside are refused even when approved.
    await expect(write.run({ path: join(other, '.env'), content: 'x' }, { state, approved: true } as never)).rejects.toThrow(/secrets/)
  })

  test('commands start in the working folder', () => {
    const ws = dir('sb-ws-')
    const wf = dir('sb-wf-')
    const att = dir('sb-att-')
    expect(cwdFor(undefined, { state: { roots: [att, wf], folder: wf } as never, workspaceDir: ws })).toBe(wf)
    expect(cwdFor(undefined, { state: { roots: [att] } as never, workspaceDir: ws })).toBe(att)
    mkdirSync(join(wf, 'sub'))
    expect(cwdFor('sub', { state: { roots: [wf], folder: wf } as never, workspaceDir: ws })).toBe(join(wf, 'sub'))
  })

  test('knowledge_search scope "chat" covers the chat folders that are indexed', () => {
    const kb = { sources: () => [{ path: '/w/proj', kind: 'attached', label: 'p', spaceId: null, removable: true }] } as never
    expect(chatScope(kb, ['/w/proj/sub', '/elsewhere'])).toEqual({ folders: ['/w/proj/sub'], label: '/w/proj/sub' })
    expect(chatScope(kb, [])).toMatchObject({ error: expect.stringMatching(/no attached or working folder/) })
    expect(chatScope(kb, ['/elsewhere'])).toMatchObject({ error: expect.stringMatching(/aren't in the knowledge base/) })
  })
})

describe('composer helpers', () => {
  test('chips, drops, size limits and messages', () => {
    expect(chipDetail({ path: '/a.pdf', name: 'a.pdf', kind: 'file', size: 2_200_000, category: 'pdf' })).toBe('PDF · 2.1 MB')
    expect(chipDetail({ path: '/f', name: 'f', kind: 'folder', files: 1204, truncated: true })).toBe('Folder · 1,204+ files')
    const f = (name: string, size: number): File => ({ name, size } as File)
    const { ok, rejected } = oversize([f('a.txt', 10), f('b.mov', 200 * 1024 * 1024)])
    expect(ok.map((x) => x.name)).toEqual(['a.txt'])
    expect(rejectedText(rejected)).toMatch(/Couldn't attach b\.mov: .*up to 100\.0 MB/)
    const dt = { files: [] as unknown as FileList, types: ['text/uri-list'], getData: () => '# comment\nhttps://example.com/cat.png\nfile:///etc/passwd' }
    expect(fromTransfer(dt).urls).toEqual(['https://example.com/cat.png'])
    expect(mergeAttachments([{ path: '/a', name: 'a', kind: 'file' }], [{ path: '/a', name: 'a', kind: 'file' }, { path: '/b', name: 'b', kind: 'file' }]).map((a) => a.path)).toEqual(['/a', '/b'])
  })
})
