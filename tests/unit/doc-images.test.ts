import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { markdownToBlocks } from '../../src/main/docspace/markdown'
import { localizeImages } from '../../src/main/agent/tools/docspace'

test('images: paths with spaces, captions, and web pictures saved into the workspace (bracketed when the path has spaces)', async () => {
  const b = markdownToBlocks('![](/Users/sam/Desktop/Screen Shot 1.png)\n\n![Chart](/tmp/q3.png "Q3 revenue")\n\n![](</tmp/a b.png>)')
  expect(b.filter((x) => x.type === 'image').map((x) => [x.src, x.alt])).toEqual([['/Users/sam/Desktop/Screen Shot 1.png', undefined], ['/tmp/q3.png', 'Chart'], ['/tmp/a b.png', undefined]])
  expect(markdownToBlocks('![](/tmp/q3.png "Q3 revenue")')[0].alt).toBe('Q3 revenue')
  const ws = join(mkdtempSync(join(tmpdir(), 'ws ')), 'My Work')
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex')
  const fake = (async (url: string) => (String(url).includes('ok') ? new Response(png, { headers: { 'content-type': 'image/png' } }) : new Response('nope', { status: 404 }))) as typeof fetch
  const md = '![](https://x.example/ok.png)\n\n![](https://x.example/ok.png?v=2)\n\n![](https://x.example/missing.png)\n\nSee https://x.example/ok.png in the text.'
  const out = (await localizeImages(md, ws, fake))!
  const files = [...out.matchAll(/!\[\]\(<([^>]+)>\)/g)].map((m) => m[1])
  expect(files).toHaveLength(2)
  expect(files[0]).not.toBe(files[1])
  expect(existsSync(files[0]) && readFileSync(files[0]).subarray(0, 4).toString('hex')).toBe('89504e47')
  // A failed download and plain text links stay as they were.
  expect(out).toContain('![](https://x.example/missing.png)')
  expect(out).toContain('See https://x.example/ok.png in the text.')
  expect(markdownToBlocks(out).filter((x) => x.type === 'image').map((x) => x.src)).toEqual([files[0], files[1], 'https://x.example/missing.png'])
})
