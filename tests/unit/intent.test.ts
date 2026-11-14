import { describe, expect, test } from 'vitest'
import { intentTools } from '../../src/main/agent/intent'

const known = new Set(['code', 'git', 'jobs', 'computer', 'app', 'app_help', 'create_page', 'update_page', 'research', 'mail', 'doc_create', 'doc_read', 'doc_edit', 'doc_export'])

describe('on-demand tools from the request', () => {
  test('each kind of request loads only what it needs', () => {
    expect(intentTools('Fix the failing unit test in my repo', known)).toEqual(['code', 'git', 'jobs'])
    expect(intentTools('Click Save in Numbers', known)).toEqual(['computer', 'app', 'app_help'])
    expect(intentTools('Make me a dashboard of Q4 sales', known)).toEqual(['create_page', 'update_page'])
    expect(intentTools('What do recent studies say about creatine?', known)).toEqual(['research'])
    expect(intentTools('Clean up my inbox', known)).toEqual(['mail'])
    expect(intentTools('Draft a memo about the new schedule', known)).toEqual(['doc_create', 'doc_read', 'doc_edit', 'doc_export'])
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
