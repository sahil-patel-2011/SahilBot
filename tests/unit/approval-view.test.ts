import { describe, expect, test } from 'vitest'
import { approvalView } from '../../src/renderer/src/lib/approval-view'
import { filesFromSteps, nameFromJob, rowSubtitle } from '../../src/renderer/src/lib/ux'

const args = (o: unknown): string => JSON.stringify(o, null, 2)

describe('approval cards say what will happen, with a preview', () => {
  test('writing a file: "Save <name> in your workspace" and its first lines', () => {
    const v = approvalView({ tool: 'file_write', label: 'Write file', args: args({ path: 'team-plan-summary.md', content: '# Team plan\nBest value for 5 people: $75/month.' }) })
    expect(v.title).toEqual(['Save ', 'team-plan-summary.md', ' in your workspace'])
    expect(v.preview).toMatchObject({ kind: 'file', name: 'team-plan-summary.md', markdown: true, lines: 2, more: 0 })
    const long = approvalView({ tool: 'file_write', args: args({ path: '/Users/me/Clients/app.ts', content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), mode: 'append' }) })
    expect(long.title).toEqual(['Add to ', 'app.ts', ' in Clients'])
    expect(long.preview).toMatchObject({ kind: 'file', markdown: false, lines: 30, more: 20, append: true })
  })
  test('a command: the command in a box, and the one-line reason', () => {
    const v = approvalView({ tool: 'run_command', summary: 'Run in Terminal: npm ci · installs the project\'s packages from its lockfile', args: args({ command: 'npm ci', cwd: '/Users/me/app' }) })
    expect(v.title[0]).toBe('Run a command in Terminal')
    expect(v.preview).toEqual({ kind: 'command', command: 'npm ci', cwd: '/Users/me/app', why: 'installs the project\'s packages from its lockfile', background: false })
  })
  test('a browser click: "Click Submit on example.com"', () => {
    const v = approvalView({ tool: 'browser', summary: 'Click button "Submit" on example.com', args: args({ action: 'click', ref: 'e12' }) })
    expect(v.title).toEqual(['Click ', 'Submit', ' on example.com'])
    expect(v.preview).toMatchObject({ kind: 'click', target: 'Submit', role: 'button', site: 'example.com' })
  })
  test('emails and messages: To, Subject and the start of the body', () => {
    const v = approvalView({ tool: 'mail', label: 'Mail', summary: 'Send email to sam@example.com', args: args({ action: 'send', to: ['sam@example.com'], subject: 'Q3 numbers', body: 'Hi Sam,\nHere they are.' }) })
    expect(v.title).toEqual(['Send to ', 'sam@example.com', ''])
    expect(v.preview).toEqual({ kind: 'message', to: 'sam@example.com', channel: undefined, subject: 'Q3 numbers', body: 'Hi Sam,\nHere they are.' })
    const slack = approvalView({ tool: 'slack__post_message', args: args({ channel: '#launch', text: 'Shipping today' }) })
    expect(slack.title).toEqual(['Post in ', '#launch', ''])
  })
  test('anything else: the tool\'s own words and a few readable settings (raw arguments stay in Technical details)', () => {
    const v = approvalView({ tool: 'notion__create_page', label: 'Notion', summary: 'Create a page "Roadmap"', args: args({ title: 'Roadmap', parent: { id: 'x' }, body: 'x'.repeat(400) }) })
    expect(v.title).toEqual(['Create a page "Roadmap"', '', ''])
    expect(v.preview).toEqual({ kind: 'fields', rows: [['Title', 'Roadmap']] })
    expect(approvalView({ tool: 'x', label: 'Thing' }).title).toEqual(['Allow ', 'Thing', '?'])
  })
})

describe('plain sidebar rows and quick paths', () => {
  test('a bot row shows its last message, else its label, else a hint; never filler', () => {
    const b = { kind: 'bot' as const, members: [] as string[] }
    expect(rowSubtitle({ ...b, lastPreview: 'Q3 spend was $12,400, mostly ads.' })).toBe('Q3 spend was $12,400, mostly ads.')
    expect(rowSubtitle({ ...b, lastPreview: 'local', label: 'Research helper' })).toBe('Research helper')
    expect(rowSubtitle({ ...b })).toBe('No messages yet')
    expect(rowSubtitle({ ...b, lastPreview: 'local', lastAt: Date.now() - 2 * 3_600_000 })).toBe('Active 2h ago')
    expect(rowSubtitle({ kind: 'group', members: ['a', 'b'] })).toBe('2 bots')
  })
  test('a new bot is named after its job when no name was typed', () => {
    expect(nameFromJob('track my competitors weekly and report back.')).toBe('Track my competitors weekly')
    expect(nameFromJob('  ')).toBe('')
  })
  test('files a run made: one card per file, latest call wins, failures and pages left out', () => {
    const step = (id: string, name: string, meta: Record<string, unknown>) => ({ call: { id, name }, result: { meta } })
    expect(filesFromSteps([
      step('1', 'file_write', { status: 'ok', path: '/w/a.md' }),
      step('2', 'file_write', { status: 'error', path: '/w/b.md' }),
      step('3', 'create_document', { status: 'ok', path: '/w/deck.pptx' }),
      step('4', 'file_write', { status: 'ok', path: '/w/a.md' }),
      step('5', 'file_write', { status: 'ok', path: '/w/site.html' }),
      step('6', 'web_search', { status: 'ok' })
    ])).toEqual([{ key: '3', path: '/w/deck.pptx' }, { key: '4', path: '/w/a.md' }])
  })

  test('office results get a file card; a doc_export file only when no document card shows it', () => {
    const step = (id: string, name: string, meta: Record<string, unknown>) => ({ call: { id, name }, result: { meta } })
    const steps = [step('1', 'office', { status: 'ok', path: '/w/merged.pdf' }), step('2', 'doc_export', { status: 'ok', path: '/w/Report.docx' })]
    expect(filesFromSteps(steps)).toEqual([{ key: '1', path: '/w/merged.pdf' }])
    expect(filesFromSteps(steps, { exports: true })).toEqual([{ key: '1', path: '/w/merged.pdf' }, { key: '2', path: '/w/Report.docx' }])
  })
})
