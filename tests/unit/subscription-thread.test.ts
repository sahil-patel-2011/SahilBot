import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { WireMessage } from '../../src/main/llm/client'
import { SubscriptionThread } from '../../src/main/llm/subscription-thread'
import { INSTALL_COMMANDS, installScript } from '../../src/main/llm/cli-install'

const dir = (): string => mkdtempSync(join(tmpdir(), 'sahilbot-thread-'))

test('the delta holds what the provider missed: other models\' replies and tool steps, not its own last answer', () => {
  const home = dir()
  const thread = new SubscriptionThread(home, 'chat')
  thread.bind('t1')
  const first: WireMessage[] = [{ role: 'system', content: 'S' }, { role: 'user', content: 'one' }]
  thread.advance(first)
  const later: WireMessage[] = [...first, { role: 'assistant', content: 'own answer' }, { role: 'user', content: 'two' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', content: 'found it', tool_call_id: 'c1' }, { role: 'assistant', content: 'other model answer' }, { role: 'user', content: 'three' }]
  expect(thread.delta(later)?.map((m) => m.content ?? m.tool_calls?.[0].function.name)).toEqual(['two', 'web_search', 'found it', 'other model answer', 'three'])
  expect(thread.continues(later)).toBe(true)
  // A new instance reads the saved record (the app restarted).
  expect(new SubscriptionThread(home, 'chat').continues(later)).toBe(true)
  // Changed instructions come first.
  expect(thread.delta([{ role: 'system', content: 'S2' }, ...later.slice(1)])?.[0]).toEqual({ role: 'system', content: 'S2' })
})

test('a compacted or edited history no longer continues the provider thread', () => {
  const thread = new SubscriptionThread(dir(), 'chat')
  thread.bind('t1')
  thread.advance([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'two' }])
  expect(thread.continues([{ role: 'user', content: 'summary' }, { role: 'user', content: 'three' }, { role: 'user', content: 'four' }, { role: 'user', content: 'five' }])).toBe(false)
  expect(thread.continues([{ role: 'user', content: 'one (edited)' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'two' }, { role: 'user', content: 'x' }])).toBe(false)
  // A new provider thread starts with no record of what it holds.
  thread.bind('t2')
  expect(thread.delta([{ role: 'user', content: 'one' }])).toBeUndefined()
})

test('the Terminal installer runs the vendor\'s official one-liner, then its own sign-in', () => {
  expect(INSTALL_COMMANDS).toEqual({ codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', grok: 'curl -fsSL https://x.ai/cli/install.sh | bash' })
  const script = installScript({ name: 'Codex', install: INSTALL_COMMANDS.codex, find: 'BIN="$(command -v codex)"', signIn: '"$BIN" login' })
  const lines = script.split('\n')
  expect(lines[0]).toBe('#!/bin/zsh -l')
  const at = (needle: string): number => lines.findIndex((line) => line.startsWith(needle))
  expect(at(INSTALL_COMMANDS.codex)).toBeGreaterThan(0)
  expect(at('BIN=')).toBeGreaterThan(at(INSTALL_COMMANDS.codex))
  expect(at('"$BIN" login')).toBeGreaterThan(at('BIN='))
  expect(installScript({ name: 'Codex', find: 'BIN=/x', signIn: '"$BIN" login' })).not.toContain('curl')
})
