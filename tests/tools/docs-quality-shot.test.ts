import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { runDocsShots } from './docs-quality/harness'

// Dev helper: renders the sample documents (6-page report, memo, resume, invoice, deck, financial model)
// with the real generators and saves every page as a PNG for visual review, plus a contact sheet per
// document. Output: $DOCS_SHOTS_DIR (default <tmp>/sahilbot-docs-shots). DOCS_SHOTS_ROOT=<folder> renders
// with another copy of src/main/docs (before/after comparisons); DOCS_SHOTS_ONLY=report,memo for a subset.
//
//   npx vitest run --config vitest.tools.config.mts tests/tools/docs-quality-shot.test.ts

test('docs quality screenshots', async () => {
  const out = process.env.DOCS_SHOTS_DIR ?? join(tmpdir(), 'sahilbot-docs-shots')
  mkdirSync(out, { recursive: true })
  const summary = await runDocsShots(out, { docsRoot: process.env.DOCS_SHOTS_ROOT, only: process.env.DOCS_SHOTS_ONLY?.split(',').filter(Boolean) })
  const lines: string[] = []
  for (const [name, s] of Object.entries(summary)) {
    if (s.error) { lines.push(`${name}: ERROR ${s.error}`); continue }
    lines.push(`${name}: ${s.pages} page(s) via ${s.method}${s.sheet ? `\n  sheet: ${s.sheet}` : ''}\n  ${s.images.join('\n  ')}${s.overflow?.length ? `\n  overflow: ${s.overflow.join('; ')}` : ''}${s.lowContrast?.length ? `\n  low contrast: ${s.lowContrast.join('; ')}` : ''}${s.warnings?.length ? `\n  warnings: ${s.warnings.join('; ')}` : ''}`)
  }
  writeFileSync(join(out, 'index.txt'), `Docs shots in ${out}\n${lines.join('\n')}\n`)
  console.log(`Docs shots in ${out} (list: ${join(out, 'index.txt')})\n${lines.join('\n')}`)
  expect(Object.values(summary).filter((s) => s.error)).toEqual([])
  for (const s of Object.values(summary)) for (const p of s.images) expect(existsSync(p)).toBe(true)
}, 300_000)
