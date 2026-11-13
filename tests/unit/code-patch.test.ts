import { describe, expect, test } from 'vitest'
import { applyHunks, clipDiff, diffLines, parsePatch, patchSummary, replaceExact, unifiedDiff } from '../../src/main/code/patch'

describe('replaceExact', () => {
  const src = 'function a() {\n  return 1\n}\n\nfunction b() {\n  return 1\n}\n'
  test('replaces a unique match and reports its line', () => {
    const r = replaceExact(src, 'function a() {\n  return 1', 'function a() {\n  return 2')
    expect(r.content).toContain('function a() {\n  return 2\n}')
    expect(r.content).toContain('function b() {\n  return 1\n}')
    expect(r.firstLine).toBe(1)
  })
  test('refuses an ambiguous match and lists where', () => {
    expect(() => replaceExact(src, '  return 1', '  return 3', false, 'x.ts')).toThrow(/occurs 2 times in x\.ts \(lines 2, 6\)/)
    expect(replaceExact(src, '  return 1', '  return 3', true).content.match(/return 3/g)).toHaveLength(2)
  })
  test('not found shows the closest lines', () => {
    expect(() => replaceExact(src, 'function c() {\n  return 9\n}', 'x')).toThrow(/not found[\s\S]*Closest lines/)
  })
  test('empty and no-op edits are rejected', () => {
    expect(() => replaceExact(src, '', 'x')).toThrow(/empty/)
    expect(() => replaceExact(src, 'a', 'a')).toThrow(/same/)
  })
  test('forgives indentation and re-indents the new text', () => {
    const file = 'class A {\n    run() {\n        go()\n    }\n}\n'
    const r = replaceExact(file, 'run() {\n    go()\n}', 'run() {\n    stop()\n}')
    expect(r.content).toBe('class A {\n    run() {\n        stop()\n    }\n}\n')
    expect(r.note).toMatch(/indentation/)
  })
  test('forgives trailing spaces and curly quotes', () => {
    expect(replaceExact('a = 1   \nb = 2\n', 'a = 1\nb = 2', 'a = 3\nb = 2').content).toBe('a = 3\nb = 2\n')
    expect(replaceExact('say("hi")\n', 'say(“hi”)', 'say("bye")').content).toBe('say("bye")\n')
  })
  test('keeps CRLF line endings', () => {
    expect(replaceExact('a\r\nb\r\nc\r\n', 'a\nb', 'x\ny').content).toBe('x\r\ny\r\nc\r\n')
  })
})

describe('parsePatch', () => {
  test('*** Begin Patch with add, update (move) and delete', () => {
    const fps = parsePatch(`*** Begin Patch
*** Add File: src/new.ts
+export const x = 1
*** Update File: src/a.ts
*** Move to: src/b.ts
@@ function a
-  return 1
+  return 2
*** Delete File: old.txt
*** End Patch`)
    expect(fps.map((f) => [f.op, f.path, f.moveTo])).toEqual([['add', 'src/new.ts', undefined], ['update', 'src/a.ts', 'src/b.ts'], ['delete', 'old.txt', undefined]])
    expect(fps[1].hunks[0].header).toBe('function a')
    expect(patchSummary(`*** Begin Patch\n*** Delete File: x\n*** End Patch`).deletes).toEqual(['x'])
  })
  test('unified / git diffs, including new and deleted files and fenced input', () => {
    const fps = parsePatch('```diff\ndiff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+new\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n```')
    expect(fps.map((f) => [f.op, f.path])).toEqual([['update', 'a.txt'], ['add', 'n.txt'], ['delete', 'gone.txt']])
    expect(fps[0].hunks[0].hint).toBe(1)
  })
  test('a removed line starting with "-- " is not a file header', () => {
    const fps = parsePatch('--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- a comment\n select 1\n')
    expect(fps[0].hunks[0].lines[0]).toEqual({ t: '-', s: '-- a comment' })
  })
  test('garbage is a clear error', () => {
    expect(() => parsePatch('hello')).toThrow(/No file changes/)
    expect(() => parsePatch('*** Begin Patch\nstray\n*** End Patch')).toThrow(/outside a file section/)
  })
})

describe('applyHunks', () => {
  const file = 'import a\n\ndef f():\n    x = 1\n    return x\n\ndef g():\n    x = 1\n    return x\n'
  test('uses the context header to pick the right place', () => {
    const [fp] = parsePatch('*** Begin Patch\n*** Update File: m.py\n@@ def g():\n-    x = 1\n+    x = 2\n*** End Patch')
    expect(applyHunks(file, fp.hunks, 'm.py').content).toBe(file.replace(/def g\(\):\n {4}x = 1/, 'def g():\n    x = 2'))
  })
  test('uses the line hint when context repeats', () => {
    const [fp] = parsePatch('--- a/m.py\n+++ b/m.py\n@@ -8,2 +8,2 @@\n-    x = 1\n+    x = 3\n     return x\n')
    const out = applyHunks(file, fp.hunks, 'm.py').content
    expect(out.split('\n')[7]).toBe('    x = 3')
    expect(out.split('\n')[3]).toBe('    x = 1')
  })
  test('tolerates wrong indentation and lost context prefixes', () => {
    const [fp] = parsePatch('*** Begin Patch\n*** Update File: m.py\n@@\ndef f():\n-  x = 1\n+  x = 5\n*** End Patch')
    const r = applyHunks(file, fp.hunks, 'm.py')
    expect(r.content).toContain('def f():\n    x = 5')
    expect(r.notes.join()).toMatch(/indentation/)
  })
  test('several hunks apply in order', () => {
    const [fp] = parsePatch('--- a/m.py\n+++ b/m.py\n@@ -1,1 +1,2 @@\n import a\n+import b\n@@ -7,3 +8,3 @@\n def g():\n-    x = 1\n+    x = 4\n')
    const out = applyHunks(file, fp.hunks, 'm.py').content
    expect(out.startsWith('import a\nimport b\n')).toBe(true)
    expect(out).toContain('def g():\n    x = 4')
  })
  test('a hunk that does not fit fails with the closest lines', () => {
    const [fp] = parsePatch('*** Begin Patch\n*** Update File: m.py\n@@\n def h():\n-    y = 1\n+    y = 2\n*** End Patch')
    expect(() => applyHunks(file, fp.hunks, 'm.py')).toThrow(/Hunk 1 in m\.py did not apply[\s\S]*def h\(\)/)
  })
})

describe('diff', () => {
  test('diffLines finds a minimal edit', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])
    expect(ops.filter((o) => o.t !== ' ').map((o) => `${o.t}${o.s}`)).toEqual(['-b', '+x', '+e'])
  })
  test('unifiedDiff formats hunks and counts', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
    const after = before.replace('line 3\n', 'line three\n').replace('line 18\n', '')
    const d = unifiedDiff('f.txt', before, after)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(2)
    expect(d.text).toMatch(/^--- a\/f\.txt\n\+\+\+ b\/f\.txt\n@@ -1,6 \+1,6 @@/)
    expect(d.text.match(/^@@/gm)).toHaveLength(2)
    expect(unifiedDiff('n.txt', null, 'hi\n').text).toMatch(/--- \/dev\/null[\s\S]*@@ -0,0 \+1,1 @@\n\+hi/)
    expect(unifiedDiff('same', 'a\n', 'a\n').text).toBe('')
  })
  test('random edits round-trip through the diff', () => {
    for (let seed = 1; seed < 30; seed++) {
      let s = seed
      const rnd = (): number => (s = (s * 16807) % 2147483647) / 2147483647
      const a = Array.from({ length: 40 }, () => String(Math.floor(rnd() * 8)))
      const b = a.filter(() => rnd() > 0.2).flatMap((x) => (rnd() > 0.85 ? [x, 'new'] : [x]))
      const ops = diffLines(a, b)
      expect(ops.filter((o) => o.t !== '+').map((o) => o.s)).toEqual(a)
      expect(ops.filter((o) => o.t !== '-').map((o) => o.s)).toEqual(b)
    }
  })
  test('clipDiff cuts at a hunk boundary', () => {
    const big = ['--- a/x', '+++ b/x', ...Array.from({ length: 50 }, (_, i) => `@@ -${i},1 +${i},1 @@\n-${'a'.repeat(300)}\n+b`)].join('\n')
    expect(clipDiff(big, 2000)).toMatch(/diff cut/)
  })
})
