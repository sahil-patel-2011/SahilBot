import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { projectInstructions } from '../../src/main/agent/project-instructions'

test('AGENTS.md from the repo root down to the working folder, outermost first, bounded (as Codex reads it)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pi-'))
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
  writeFileSync(join(repo, 'AGENTS.md'), 'Use pnpm. Run pnpm test before committing.')
  writeFileSync(join(repo, 'packages', 'web', 'CLAUDE.md'), 'This package uses React 19.')
  const pi = projectInstructions(join(repo, 'packages', 'web'))!
  expect(pi.files.map((f) => f.slice(repo.length))).toEqual(['/AGENTS.md', '/packages/web/CLAUDE.md'])
  expect(pi.text.indexOf('pnpm')).toBeLessThan(pi.text.indexOf('React 19'))
  writeFileSync(join(repo, 'AGENTS.md'), 'x'.repeat(20_000))
  expect(projectInstructions(repo)!.text).toMatch(/cut at 8 KB/)
  expect(projectInstructions(join(tmpdir(), 'no-such-folder-xyz'))).toBeUndefined()
  // No git root: only the folder itself, never the folders above it.
  const loose = mkdtempSync(join(tmpdir(), 'pi-loose-'))
  expect(projectInstructions(loose)).toBeUndefined()
})
