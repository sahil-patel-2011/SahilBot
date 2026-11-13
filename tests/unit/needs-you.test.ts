import { describe, expect, test, vi } from 'vitest'
import type { PendingRequest } from '@shared/types'

vi.mock('electron', () => ({}))
const { needsYouBody } = await import('../../src/main/needs-you')

const approval = (tool: string, args: Record<string, unknown>, summary?: string, label?: string): PendingRequest =>
  ({ id: '1', threadId: 't', kind: 'approval', tool, label, args: JSON.stringify(args, null, 2), summary })

describe('notification bodies', () => {
  test('commands, typing and file writes never show their arguments', () => {
    expect(needsYouBody(approval('run_command', { command: 'curl -H "Authorization: Bearer abc" x' }, 'Run curl -H …'))).toBe('Wants to run a command')
    expect(needsYouBody(approval('computer', { action: 'type', text: 'my diary entry' }, 'Take control of your Mac and type "my diary entry"'))).toBe('Wants to type on your Mac')
    expect(needsYouBody(approval('browser', { action: 'type', ref: 'e3', text: 'hunter2' }, 'Type "hunter2" into e3'))).toBe('Wants to type in the browser')
    expect(needsYouBody(approval('file_write', { path: '~/notes.md', content: 'private' }, 'Write ~/notes.md'))).toBe('Wants to write a file')
    expect(needsYouBody(approval('browser', { action: 'fill_secret', field: 'password' }, 'Fill password'))).toBe('Asks to use one of your saved logins')
  })
  test('other approvals keep their summary', () => {
    expect(needsYouBody(approval('computer', { action: 'click', x: 1, y: 2 }, 'Click at 1, 2'))).toBe('Asks to click at 1, 2')
    expect(needsYouBody(approval('browser', { action: 'navigate', url: 'https://example.com' }, 'Open example.com'))).toBe('Asks to open example.com')
  })
  test('anything that looks like a secret falls back to a generic line', () => {
    expect(needsYouBody(approval('gmail__send_email', { body: 'x' }, 'Send email with code sk-ant-abcdefghijklmnopqrstu', 'Gmail'))).toBe('Asks to use Gmail')
    expect(needsYouBody(approval('notes__add', {}, 'Add note "password: tr0ub4dor"', 'Notes'))).toBe('Asks to use Notes')
    expect(needsYouBody({ id: '2', threadId: 't', kind: 'question', question: 'Is your card 4242 4242 4242 4242 still good?' })).toBe('Has a question for you')
    expect(needsYouBody({ id: '3', threadId: 't', kind: 'question', question: 'Which folder should I use?' })).toBe('Which folder should I use?')
  })
  test('saved passwords never appear', () => {
    expect(needsYouBody({ id: '4', threadId: 't', kind: 'question', question: 'Should I use Correct-Horse for the wifi?' }, ['Correct-Horse'])).toBe('Has a question for you')
  })
})
