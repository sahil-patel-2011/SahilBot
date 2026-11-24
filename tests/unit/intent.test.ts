import { describe, expect, test } from 'vitest'
import { intentTools } from '../../src/main/agent/intent'

const known = new Set(['code', 'git', 'jobs', 'computer', 'app', 'app_help', 'create_page', 'update_page', 'research', 'mail', 'doc_create', 'doc_read', 'doc_edit', 'doc_export'])

describe('on-demand tools from the request', () => {
  test('each kind of request loads only what it needs', () => {
    expect(intentTools('Fix the failing unit test in my repo', known)).toEqual(['code', 'git', 'jobs'])
    expect(intentTools('Click Save in Numbers', known)).toEqual(['computer', 'app', 'app_help'])
    expect(intentTools('Make me a dashboard of Q4 sales', known).filter((t) => !t.startsWith('doc_'))).toEqual(['create_page', 'update_page'])
    expect(intentTools('What do recent studies say about creatine?', known)).toEqual(['research'])
    expect(intentTools('Clean up my inbox', known)).toEqual(['mail'])
    expect(intentTools('Draft a memo about the new schedule', known)).toEqual(['doc_create', 'doc_read', 'doc_edit', 'doc_export'])
  })
  test('an email to write from the user\'s words loads no mail tools; reading, replying or sending does (IWD-01)', () => {
    for (const q of ['Draft a two-line email to my landlord about the leak', 'Write a short email to my teacher saying I will be late', 'Compose an email to Jane thanking her',
      'Can you help me write an email to my boss asking for Friday off?', 'I need to email my landlord about a leak, write it for me']) expect(intentTools(q, known), q).not.toContain('mail')
    for (const q of ['Write an email to Jane and send it', 'Draft a reply to the email from my landlord', 'Clean up my inbox', 'Write an email to Jane about what my emails from Bob said']) expect(intentTools(q, known), q).toContain('mail')
  })
  test('small talk and plain questions load nothing extra', () => {
    expect(intentTools('hey, how are you?', known)).toEqual([])
    expect(intentTools('What is 15% of 240?', known)).toEqual([])
  })
  test('a code project loads the coding tools; unknown tools are never loaded', () => {
    expect(intentTools('summarize what changed', known, { codeProject: true })).toEqual(['code', 'git', 'jobs'])
    expect(intentTools('Fix the bug', new Set(['code']))).toEqual(['code'])
  })
})

import { intentTools as loadFor } from '../../src/main/agent/intent'
test('handing work to a coding agent loads the Cursor tool with code and git', () => {
  const known = new Set(['cursor', 'code', 'git', 'maps', 'research'])
  expect(loadFor('Hand this bug to Cursor and have it open a PR', known)).toEqual(expect.arrayContaining(['cursor', 'code', 'git']))
  expect(loadFor('Move the cursor on the screen', known)).not.toContain('cursor')
})
