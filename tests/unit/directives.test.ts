import { expect, test } from 'vitest'
import { stripDirectives } from '../../src/shared/directives'
import { plain } from '../../src/main/db'

// Grok Bot head-to-head: ":codex-file-citation{path=…}" leaked into the chat after the invoice was saved.
test('internal directives and citation markers are removed; code is left alone', () => {
  expect(stripDirectives('Saved the invoice :codex-file-citation{path=/Users/s/Downloads/inv.pdf line_range_start=1 line_range_end=3} to Downloads.')).toBe('Saved the invoice to Downloads.')
  expect(stripDirectives('See 【F:src/app.ts†L10-L20】 for the fix.')).toBe('See for the fix.')
  expect(stripDirectives('Use `:codex-file-citation{x}` literally')).toBe('Use `:codex-file-citation{x}` literally')
  expect(stripDirectives('```\nconst a = {b: 1}\n:x{y}\n```')).toBe('```\nconst a = {b: 1}\n:x{y}\n```')
  expect(stripDirectives('Ratio 3:1 and {braces} stay.')).toBe('Ratio 3:1 and {braces} stay.')
})

// RLB-03: the form the report quotes, with a [label] before the braces, a long repository link, glued to
// punctuation, or bare.
test('the real Codex citation forms are removed too', () => {
  const url = 'https://github.com/acme/app/blob/0123456789abcdef0123456789abcdef01234567/inv.pdf#L1-L3'
  expect(stripDirectives(`Saved it :codex-file-citation[codex-file-citation]{line_range_start=1 line_range_end=3 path=/Users/s/inv.pdf ${'git'}_url="${url}"} done.`)).toBe('Saved it done.')
  expect(stripDirectives('Tests pass :codex-terminal-citation[codex-terminal-citation]{line_range_start=4 line_range_end=9 terminal_chunk_id=abc}.')).toBe('Tests pass.')
  expect(stripDirectives('Saved it.:codex-file-citation{path=/a/b}')).toBe('Saved it.')
  expect(stripDirectives('Saved it :codex-file-citation[x] and opened it.')).toBe('Saved it and opened it.')
  expect(stripDirectives('Saved it :codex-file-citation[x].')).toBe('Saved it.')
  // Ordinary Markdown and text are untouched.
  expect(stripDirectives('See [the guide](https://example.com/a) at ratio 3:1 {not markup}.')).toBe('See [the guide](https://example.com/a) at ratio 3:1 {not markup}.')
  expect(stripDirectives('Mix in a ratio of 2:3 [optional].')).toBe('Mix in a ratio of 2:3 [optional].')
})

test('sidebar previews leave internal markup out', () => {
  expect(plain('Saved **invoice.pdf** :codex-file-citation[codex-file-citation]{path=/Users/s/inv.pdf} to Downloads.')).toBe('Saved invoice.pdf to Downloads.')
})
