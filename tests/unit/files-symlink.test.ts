import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { insideRoot, outsidePath } from '../../src/main/agent/tools/files'

// Found live: the workspace was stored by its real path (/private/var/…) while the agent used /var/…, so reading
// its own report asked for permission as "outside your folders". A symlinked prefix names the same place.
describe('paths through a symlinked prefix', () => {
  const base = mkdtempSync(join(tmpdir(), 'symroot-'))
  const realWs = join(realpathSync(base), 'ws')
  mkdirSync(realWs)
  writeFileSync(join(realWs, 'report.pdf'), 'x')
  const link = join(realpathSync(base), 'link')
  symlinkSync(realWs, link)

  test('an absolute path via the symlink is inside the real workspace', () => {
    expect(insideRoot(realWs, join(link, 'report.pdf'))).toBe(join(realWs, 'report.pdf'))
    expect(insideRoot(realWs, join(link, 'new', 'deck.pptx'))).toBe(join(realWs, 'new', 'deck.pptx'))
    expect(outsidePath(join(link, 'report.pdf'), realWs)).toBeNull()
  })

  test('the OS temp folder (macOS /var → /private/var) works both ways', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'))
    writeFileSync(join(ws, 'a.txt'), 'x')
    expect(outsidePath(join(ws, 'a.txt'), realpathSync(ws))).toBeNull()
    expect(outsidePath(join(realpathSync(ws), 'a.txt'), ws)).toBeNull()
  })

  test('a symlink that leads outside is still outside', () => {
    const other = mkdtempSync(join(tmpdir(), 'other-'))
    symlinkSync(other, join(realWs, 'escape'))
    expect(() => insideRoot(realWs, join(realWs, 'escape', 'secret.txt'))).toThrow(/outside/)
  })
})
