import { describe, expect, test } from 'vitest'
import { parseRule, ruleMatches, ruleVerdict, stem } from '../../src/main/agent/permissions'
import { cleanRules } from '../../src/main/settings'
import type { CustomRule } from '../../src/shared/types'

const allow = (when: string): CustomRule => ({ id: `a-${when}`, when, action: 'allow' })
const ask = (when: string): CustomRule => ({ id: `q-${when}`, when, action: 'ask' })

const sendEmail = { tool: 'send_email', label: 'Send email', summary: 'Send an email to sam@example.com: "Lunch Friday?"', args: '{\n  "to": "sam@example.com",\n  "subject": "Lunch Friday?"\n}' }
const searchEmail = { tool: 'search_email', label: 'Search email', summary: 'Search your inbox for "invoice"', args: '{\n  "query": "invoice"\n}' }
const npmInstall = { tool: 'run_command', label: 'Run command', summary: 'Run `npm install lodash` in ~/proj', args: '{\n  "command": "npm install lodash",\n  "cwd": "~/proj"\n}' }
const npmTest = { tool: 'run_command', label: 'Run command', summary: 'Run `npm test`', args: '{\n  "command": "npm test"\n}' }
const deleteFile = { tool: 'files', label: 'Files', summary: 'Delete notes.txt (it goes to the Trash)', args: '{\n  "op": "delete",\n  "path": "notes.txt"\n}' }
const buyClick = { tool: 'browser', label: 'Browser', summary: 'Click "Buy now" on amazon.com', args: '{\n  "action": "click",\n  "ref": "e12"\n}' }

describe('stem', () => {
  test.each([
    ['send', 'sends', 'sending', 'sent'],
    ['install', 'installs', 'installing', 'installed'],
    ['delete', 'deletes', 'deleting', 'deleted'],
    ['run', 'runs', 'running', 'ran'],
    ['reply', 'replies', 'replied', 'replying'],
    ['post', 'posts', 'posting', 'posted'],
    ['search', 'searches', 'searching', 'searched'],
    ['push', 'pushes', 'pushing', 'pushed'],
    ['create', 'creates', 'creating', 'created'],
    ['commit', 'commits', 'committing', 'committed'],
    ['buy', 'buys', 'buying', 'bought'],
    ['write', 'writes', 'writing', 'wrote'],
    ['message', 'messages', 'messaging', 'messaged'],
    ['setting', 'settings', 'set', 'sets']
  ])('%s family meets in one form', (...forms) => {
    const s = forms.map(stem)
    expect(new Set(s).size).toBe(1)
  })

  test('different verbs stay different', () => {
    expect(stem('send')).not.toBe(stem('search'))
    expect(stem('post')).not.toBe(stem('push'))
    expect(stem('email')).not.toBe(stem('mail'))
  })

  test('short words and numbers are left alone', () => {
    expect(stem('npm')).toBe('npm')
    expect(stem('git')).toBe('git')
    expect(stem('2024s')).toBe('2024s')
  })
})

describe('parseRule', () => {
  test('drops filler words and stems the rest', () => {
    expect(parseRule('When it wants to send an email').stems).toEqual(['send', 'email'])
  })
  test('pulls out tool: names and quoted phrases', () => {
    const r = parseRule('tool:run_command "npm install"')
    expect(r.tools).toHaveLength(1)
    expect(r.tools[0].test('run_command')).toBe(true)
    expect(r.phrases).toEqual(['npm install'])
    expect(r.stems).toEqual([])
  })
  test('rule text past 1000 characters is ignored', () => {
    expect(parseRule(`${'x '.repeat(500)}zebra`).stems).not.toContain('zebra')
  })
})

describe('ruleMatches', () => {
  test('"send email" matches sending an email but not searching email', () => {
    expect(ruleMatches('send email', sendEmail)).toBe(true)
    expect(ruleMatches('send email', searchEmail)).toBe(false)
  })
  test('word forms: "sending emails" and "sends an e-mail"', () => {
    expect(ruleMatches('sending emails', sendEmail)).toBe(true)
    expect(ruleMatches('Sends emails', sendEmail)).toBe(true)
  })
  test('"npm install" matches run_command with npm install in its arguments', () => {
    expect(ruleMatches('npm install', npmInstall)).toBe(true)
    expect(ruleMatches('run npm install', npmInstall)).toBe(true)
    expect(ruleMatches('npm install', npmTest)).toBe(false)
  })
  test('case-insensitive', () => {
    expect(ruleMatches('NPM INSTALL', npmInstall)).toBe(true)
    expect(ruleMatches('Click BUY', buyClick)).toBe(true)
  })
  test('every word must appear', () => {
    expect(ruleMatches('npm install react', npmInstall)).toBe(false)
    expect(ruleMatches('delete files', deleteFile)).toBe(true)
    expect(ruleMatches('delete photos', deleteFile)).toBe(false)
  })
  test('tool: rules match by tool name, with * as a wildcard', () => {
    expect(ruleMatches('tool:run_command', npmInstall)).toBe(true)
    expect(ruleMatches('tool:run_command', sendEmail)).toBe(false)
    expect(ruleMatches('tool:RUN_COMMAND', npmTest)).toBe(true)
    expect(ruleMatches('tool:send_*', sendEmail)).toBe(true)
    expect(ruleMatches('tool:send_*', searchEmail)).toBe(false)
    // A partial tool name is not a match.
    expect(ruleMatches('tool:run', npmInstall)).toBe(false)
  })
  test('tool: plus words narrows to both', () => {
    expect(ruleMatches('tool:run_command npm install', npmInstall)).toBe(true)
    expect(ruleMatches('tool:run_command npm install', npmTest)).toBe(false)
  })
  test('quoted phrases must appear as written', () => {
    expect(ruleMatches('"npm install"', npmInstall)).toBe(true)
    expect(ruleMatches('"install npm"', npmInstall)).toBe(false)
  })
  test('a rule made only of filler words matches nothing', () => {
    expect(ruleMatches('anything', npmInstall)).toBe(false)
    expect(ruleMatches('when it wants to do something', npmInstall)).toBe(false)
    expect(ruleMatches('', npmInstall)).toBe(false)
  })
  test('words are whole words, not substrings', () => {
    // "post" must not match "postgres"; "mail" must not match "email".
    expect(ruleMatches('post', { tool: 'run_command', summary: 'Run psql postgres', args: '{}' })).toBe(false)
    expect(ruleMatches('mail', sendEmail)).toBe(false)
  })
  test('snake_case and camelCase are split into words', () => {
    expect(ruleMatches('run command', npmTest)).toBe(true)
    expect(ruleMatches('create event', { tool: 'gcal.createEvent', args: '{}' })).toBe(true)
  })
})

describe('ruleVerdict', () => {
  test('no rules: null', () => {
    expect(ruleVerdict(undefined, npmInstall)).toBeNull()
    expect(ruleVerdict([], npmInstall)).toBeNull()
  })
  test('allow rule matches: allow', () => {
    expect(ruleVerdict([allow('npm install')], npmInstall)).toBe('allow')
  })
  test('nothing matches: null', () => {
    expect(ruleVerdict([allow('npm install'), ask('send email')], npmTest)).toBeNull()
  })
  test('ask first wins over allow', () => {
    expect(ruleVerdict([allow('tool:run_command'), ask('npm install')], npmInstall)).toBe('ask')
    expect(ruleVerdict([ask('npm install'), allow('tool:run_command')], npmInstall)).toBe('ask')
    expect(ruleVerdict([allow('tool:run_command'), ask('npm install')], npmTest)).toBe('allow')
  })
  test('"send email" ask rule does not catch a search', () => {
    expect(ruleVerdict([ask('send email')], searchEmail)).toBeNull()
    expect(ruleVerdict([ask('send email')], sendEmail)).toBe('ask')
  })
  test('ignores malformed rules', () => {
    const bad = [{ id: 'x', when: 42, action: 'allow' }, { id: 'y', when: 'npm install', action: 'maybe' }, null] as unknown as CustomRule[]
    expect(ruleVerdict(bad, npmInstall)).toBeNull()
  })
  test('only the first 20 rules of each kind count', () => {
    const many = Array.from({ length: 20 }, (_, i) => allow(`never${i} matches`))
    expect(ruleVerdict([...many, allow('npm install')], npmInstall)).toBeNull()
    // Ask rules have their own 20.
    expect(ruleVerdict([...many, ask('npm install')], npmInstall)).toBe('ask')
  })
  test('label and summary count, not just the tool name', () => {
    expect(ruleVerdict([ask('click buy')], buyClick)).toBe('ask')
    expect(ruleVerdict([ask('amazon')], buyClick)).toBe('ask')
  })
})

describe('cleanRules (saved settings)', () => {
  test('trims, caps length, drops junk and duplicates', () => {
    const out = cleanRules([
      { id: '1', when: '  send   email ', action: 'ask' },
      { id: '2', when: 'Send email', action: 'ask' },
      { id: '3', when: 'x'.repeat(1500), action: 'allow' },
      { id: '4', when: '', action: 'allow' },
      { id: '5', when: 'ok', action: 'nope' },
      'garbage'
    ])
    expect(out.map((r) => r.id)).toEqual(['1', '3'])
    expect(out[0].when).toBe('send email')
    expect(out[1].when).toHaveLength(1000)
  })
  test('at most 20 of each kind', () => {
    const rules = [
      ...Array.from({ length: 25 }, (_, i) => ({ id: `a${i}`, when: `allow ${i}`, action: 'allow' })),
      ...Array.from({ length: 25 }, (_, i) => ({ id: `q${i}`, when: `ask ${i}`, action: 'ask' }))
    ]
    const out = cleanRules(rules)
    expect(out.filter((r) => r.action === 'allow')).toHaveLength(20)
    expect(out.filter((r) => r.action === 'ask')).toHaveLength(20)
  })
  test('not an array: empty', () => {
    expect(cleanRules(undefined)).toEqual([])
    expect(cleanRules({})).toEqual([])
  })
})
