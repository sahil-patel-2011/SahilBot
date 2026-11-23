import { expect, test } from 'vitest'
import { stripDirectives } from '../../src/shared/directives'

// Grok Bot head-to-head: ":codex-file-citation{path=…}" leaked into the chat after the invoice was saved.
test('internal directives and citation markers are removed; code is left alone', () => {
  expect(stripDirectives('Saved the invoice :codex-file-citation{path=/Users/s/Downloads/inv.pdf line_range_start=1 line_range_end=3} to Downloads.')).toBe('Saved the invoice to Downloads.')
  expect(stripDirectives('See 【F:src/app.ts†L10-L20】 for the fix.')).toBe('See for the fix.')
  expect(stripDirectives('Use `:codex-file-citation{x}` literally')).toBe('Use `:codex-file-citation{x}` literally')
  expect(stripDirectives('```\nconst a = {b: 1}\n:x{y}\n```')).toBe('```\nconst a = {b: 1}\n:x{y}\n```')
  expect(stripDirectives('Ratio 3:1 and {braces} stay.')).toBe('Ratio 3:1 and {braces} stay.')
})
