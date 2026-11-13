import { describe, expect, test } from 'vitest'
import { MAX_TEXT_CHARS, MAX_URL_CHARS, parseSahilbotUrl, prefillScript, resolveUrlBot, type UrlAction } from '../../src/main/mcp-server/url-scheme'
import type { Space } from '../../src/shared/types'

const space = (id: string, name: string, extra: Partial<Space> = {}): Space =>
  ({ id, name, color: '#000', shape: 'blob', kind: 'bot', isMain: false, folder: null, pinned: false, hidden: false, members: [], model: null, createdAt: 0, ...extra }) as Space

const spaces = [
  space('main', 'SahilBot', { isMain: true }),
  space('w', 'Writer'),
  space('g', 'Ghost', { hidden: true }),
  space('team', 'Team', { kind: 'group' }),
  space('p', 'Planner', { kind: 'project' })
]

const ok = (url: string): UrlAction => {
  const r = parseSahilbotUrl(url)
  if (!r.ok) throw new Error(r.error)
  return r.action
}

describe('sahilbot:// links', () => {
  test('ask and new, with bot and text', () => {
    expect(ok('sahilbot://ask?bot=Writer&text=Draft%20a%20reply%0Aplease')).toEqual({ kind: 'ask', bot: 'Writer', text: 'Draft a reply\nplease', truncated: false })
    expect(ok('sahilbot://new?bot=Writer')).toEqual({ kind: 'new', bot: 'Writer', text: '', truncated: false })
    expect(ok('sahilbot://ask?text=hi')).toMatchObject({ kind: 'ask', bot: null, text: 'hi' })
    expect(ok('sahilbot:ask?bot=Writer&text=x')).toMatchObject({ kind: 'ask', bot: 'Writer' })
    expect(ok('sahilbot:///new?text=x')).toMatchObject({ kind: 'new', text: 'x' })
    expect(ok('SAHILBOT://ASK?bot=Writer&text=a+b')).toMatchObject({ kind: 'ask', text: 'a b' })
  })

  test('never auto-sends: send/auto/submit parameters are ignored and nothing in the action can send', () => {
    const a = ok('sahilbot://ask?bot=Writer&text=Delete%20everything&send=1&auto=true&submit=yes&mode=bypass')
    expect(a).toEqual({ kind: 'ask', bot: 'Writer', text: 'Delete everything', truncated: false })
    expect(Object.keys(a).sort()).toEqual(['bot', 'kind', 'text', 'truncated'])
    // The composer script only fills an empty box: it has no send, submit or Enter in it.
    const js = prefillScript('hello')
    expect(js).toContain('sahilbot:compose')
    expect(js).not.toMatch(/send|submit|Enter|keydown|click/i)
  })

  test('length limits: long text is cut, huge links and long bot names are refused', () => {
    const long = ok(`sahilbot://ask?text=${'a'.repeat(MAX_TEXT_CHARS + 50)}`)
    expect(long.text).toHaveLength(MAX_TEXT_CHARS)
    expect(long.truncated).toBe(true)
    expect(parseSahilbotUrl(`sahilbot://ask?text=${'a'.repeat(MAX_URL_CHARS)}`)).toMatchObject({ ok: false })
    expect(parseSahilbotUrl(`sahilbot://ask?bot=${'b'.repeat(81)}`)).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) })
  })

  test('bad links are refused', () => {
    expect(parseSahilbotUrl('https://example.com/ask?text=x')).toMatchObject({ ok: false })
    expect(parseSahilbotUrl('sahilbot://run?text=x')).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown action/) })
    expect(parseSahilbotUrl('sahilbot://')).toMatchObject({ ok: false })
    expect(parseSahilbotUrl('')).toMatchObject({ ok: false })
    expect(parseSahilbotUrl(42)).toMatchObject({ ok: false })
    expect(parseSahilbotUrl('not a url')).toMatchObject({ ok: false })
  })

  test('control characters and hidden bidi overrides are stripped; newlines stay', () => {
    expect(ok('sahilbot://ask?text=a%00b%1Bc%E2%80%AEd%0D%0Ae').text).toBe('abcd\ne')
  })

  test('which bot: fuzzy names, SahilBot itself, and unknown bots fall back to SahilBot', () => {
    expect(resolveUrlBot(ok('sahilbot://ask?bot=writer'), spaces)).toEqual({ botId: 'w' })
    expect(resolveUrlBot(ok('sahilbot://ask?bot=@Writer'), spaces)).toEqual({ botId: 'w' })
    expect(resolveUrlBot(ok('sahilbot://ask?bot=SahilBot'), spaces)).toEqual({ botId: null })
    expect(resolveUrlBot(ok('sahilbot://ask'), spaces)).toEqual({ botId: null })
    expect(resolveUrlBot(ok('sahilbot://ask?bot=Nobody%20Here'), spaces)).toEqual({ botId: null, unknownBot: 'Nobody Here' })
    // Groups and projects aren't bots a link can open this way.
    expect(resolveUrlBot(ok('sahilbot://ask?bot=Team'), spaces).botId).not.toBe('team')
    expect(resolveUrlBot(ok('sahilbot://ask?bot=Planner'), spaces).botId).not.toBe('p')
    // A hidden bot is still the user's own: a link may open it.
    expect(resolveUrlBot(ok('sahilbot://ask?bot=Ghost'), spaces)).toEqual({ botId: 'g' })
  })

  test('the prefill script embeds text safely as a string literal', () => {
    const nasty = '"); window.evil = 1; (" </script>`${x}`'
    const js = prefillScript(nasty)
    // Evaluating the literal part gives back exactly the text.
    const lit = js.slice(js.indexOf('const t = ') + 10, js.indexOf('; const el'))
    expect(JSON.parse(lit)).toBe(nasty)
  })
})
