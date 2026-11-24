import { describe, expect, test } from 'vitest'
import { chatPrompt, compactPrompt, harnessPrompt } from '../../src/main/agent/prompt'

// The head-to-head report locks the guidance the tests probe, so a prompt edit can't quietly drop it.
const opts = { userName: 'Sam', workspaceDir: '/Users/sam/SahilBot', spacePrompt: 'Be helpful.', spaceName: 'SahilBot' }
const full = harnessPrompt(opts)
const chat = chatPrompt(opts)
const compact = compactPrompt(opts)

describe('coding guidance (CDA-01, CDA-02, CDA-05, CDA-06)', () => {
  test('a new script: plain, short, tested once, copy-paste steps', () => {
    expect(full).toContain('about 80 lines')
    expect(full).toContain('copy-paste steps')
    expect(full).toContain('no low-level system bindings')
  })

  test('scripts that rename or move files: dry run, no overwrite, skip with a note, safe to re-run, edge cases tested', () => {
    expect(full).toContain('a dry run by default (--apply does it)')
    expect(full).toContain('never overwrite (add -2, -3 on a name clash)')
    expect(full).toContain('safe to run twice')
    expect(full).toMatch(/Test a clash, a re-run and a file with no metadata on the sample/)
  })

  test('a package missing here: say so, test the rest, give the install line, no install loops', () => {
    expect(full).toContain("A package that isn't installed here")
    expect(full).toContain("Don't loop on installs")
  })

  test('shell one-liners: one command, one sentence, macOS flags', () => {
    expect(full).toContain('A shell one-liner')
    expect(full).toContain("BSD sed -i ''")
  })

  test('an existing file the user didn\'t ask to change is never replaced: "name (2).ext"', () => {
    expect(full).toContain('save yours as "name (2).py"')
    expect(full).toContain('save the new one beside it as "name (2).ext"')
  })
})

describe('fast path guidance (ALA-04, PCA-02, ARB, IWA, IWB)', () => {
  test('stable knowledge needs no tools, in every prompt the app sends', () => {
    expect(chat).toContain('Stable knowledge needs no tools')
    expect(full).toContain('Stable knowledge needs no tools')
    expect(compact).toContain('no tools for stable facts or math')
    // The old "look up dates, numbers" rule (which sent "boiling point in °F" to a web search) is gone.
    for (const p of [chat, full]) {
      expect(p).not.toContain('dates, numbers')
      expect(p).not.toContain('This applies in plain chat too')
    }
    // A short email is written directly, with no mail search or skill first.
    expect(chat).toContain('Draft the email directly')
    expect(full).toContain('a short email to write from what the user said needs no skill and no mail search')
  })

  test('a limit or format the user sets is exact', () => {
    expect(full).toContain('Constraints are exact')
    expect(chat).toContain('Constraints are exact')
    expect(compact).toContain('A length or format the user sets is exact')
    expect(full).toContain('Count before you send')
  })

  test('typos, translation, homework and common health questions are answered directly', () => {
    expect(chat).toContain('Translation: the translation first')
    expect(full).toContain('Read through typos, shorthand and slang')
    expect(chat).toContain('Common, well-established health questions: a direct, safe answer and when to see a doctor')
  })

  test('the opening line doesn\'t push price hunting', () => {
    expect(full).toContain("I'll check a few hotels and restaurants first.")
    expect(full).not.toContain('real hotel and restaurant prices for those dates')
  })
})

describe('documents (SDA-01, DPA-01, DPA-02)', () => {
  test('a file asked for by format goes straight to one create_document call; totals are =SUM formulas', () => {
    expect(full).toContain('one create_document call (pdf, docx, pptx or xlsx)')
    expect(full).toContain('with no doc_create first')
    expect(full).toContain('sheets[].totals true (writes =SUM)')
    expect(full).toContain('for drafts the user wants to write or edit with you')
    expect(full).not.toContain('doc_create, then doc_export that format')
  })
})
