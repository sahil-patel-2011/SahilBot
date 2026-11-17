import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { outsidePath, resolvePath } from '../../src/main/agent/tools/files'
import { cwdFor, outsidePaths } from '../../src/main/agent/tools/shell'
import { mkdirSync } from 'node:fs'
import { sandboxProfile } from '../../src/main/code/proc'

// Files anywhere (on by default): the home folder is one of the chat's folders, so reading and editing files
// there never asks. Its system, private and secret places stay off limits, for files, commands and the sandbox.

const H = homedir()
const ws = join(tmpdir(), 'ws')
const roots = [H]

describe('files anywhere', () => {
  test.each(['.zshrc', '.bash_profile', '.gitconfig', '.npmrc', 'Library/LaunchAgents/com.x.plist'])('~/%s asks first (or is refused), for the file tool and for commands', (rel) => {
    const f = join(H, rel)
    expect(() => resolvePath(f, ws, roots)).toThrow()
    // Startup files ask; ones that hold secrets or start programs (.npmrc, launch agents) are refused outright.
    expect([f, null]).toContain(outsidePath(f, ws, roots))
    if (rel === '.zshrc' || rel === '.gitconfig') expect(outsidePath(f, ws, roots)).toBe(f)
    expect(outsidePaths(`echo 'export X=1' >> ${f}`, [ws, ...roots], ws)).toContain(f)
    // A note next to them stays free.
    expect(resolvePath(join(H, 'notes.md'), ws, roots)).toBe(join(H, 'notes.md'))
  })
  test('commands still start in the chat\'s workspace or folder, never in the home folder', () => {
    mkdirSync(ws, { recursive: true })
    expect(cwdFor(undefined, { workspaceDir: ws, state: { roots: [H] } as never })).toBe(ws)
    const proj = join(tmpdir(), 'proj-cwd'); mkdirSync(proj, { recursive: true })
    expect(cwdFor(undefined, { workspaceDir: ws, state: { roots: [proj, H] } as never })).toBe(proj)
  })
  test('a note in Documents is read and saved without asking', () => {
    const note = join(H, 'Documents/Obsidian Vault/Areas/School/Chemistry EP.md')
    expect(resolvePath(note, ws, roots)).toBe(note)
    expect(outsidePath(note, ws, roots)).toBeNull()
    // Without it, the same file asks first.
    expect(outsidePath(note, ws, [])).toBe(note)
  })
  test.each(['.ssh/id_ed25519', 'Library/Keychains/login.keychain-db', '.aws/credentials', 'Projects/app/.env'])('~/%s stays off limits', (rel) => {
    expect(() => resolvePath(join(H, rel), ws, roots)).toThrow()
  })
  test('commands: home files are inside, private ones are not', () => {
    expect(outsidePaths('cat ~/Documents/notes.txt', roots, H)).toEqual([])
    expect(outsidePaths('cat ~/.ssh/id_ed25519', roots, H)).toEqual([join(H, '.ssh/id_ed25519')])
    expect(outsidePaths('cp a.txt ~/Library/LaunchAgents/x.plist', roots, H)).toEqual([join(H, 'Library/LaunchAgents/x.plist')])
  })
  test('the sandbox opens the home folder but never login items, keys or shell startup files', () => {
    const p = sandboxProfile({ writable: [H] })
    expect(p).toContain('(deny file-write*\n')
    expect(p).toMatch(/Library\/LaunchAgents/)
    expect(p).toMatch(/\.zshrc/)
    expect(p.indexOf('Library/LaunchAgents')).toBeGreaterThan(p.indexOf('(allow file-write*'))
    expect(sandboxProfile({ writable: [ws] })).not.toMatch(/LaunchAgents/)
  })
})
