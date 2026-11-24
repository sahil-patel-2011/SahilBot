import { afterEach, expect, test, vi } from 'vitest'
import { listedSources, orderByCitations } from '../../src/main/agent/citations'
import { isChallengePage, keyless, webTools } from '../../src/main/agent/tools/web'
import type { ToolContext } from '../../src/main/agent/types'

// Research answers: "[2]" opens the page the answer meant, bot walls are named and routed around, and an empty
// search says so honestly.

afterEach(() => { vi.unstubAllGlobals() })

const read = [
  { title: 'NPS: Tybee Island', url: 'https://www.nps.gov/tybee' },
  { title: 'Visit Savannah hotels', url: 'https://visitsavannah.com/hotels' }
]
const found = [{ title: 'Savannah food guide', url: 'https://eater.com/savannah' }]

test('the sources follow the answer\'s own "Sources:" list, so [n] links to the nth page it listed', () => {
  const answer = 'Hotels run about $180 a night [1], and the food tour is $65 [2]. Tybee is 20 minutes away [3].\n\nSources:\n[1] Visit Savannah hotels - https://visitsavannah.com/hotels\n[2] Savannah food guide - https://eater.com/savannah/\n[3] NPS: Tybee Island - https://nps.gov/tybee'
  const out = orderByCitations(answer, [...read, ...found])
  expect(out.map((s) => s.url)).toEqual(['https://visitsavannah.com/hotels', 'https://eater.com/savannah', 'https://www.nps.gov/tybee'])
})

test('a numbered or bulleted list works too, and unlisted sources come after', () => {
  const answer = 'Answer [1].\n\n**Sources:**\n1. [Savannah food guide](https://eater.com/savannah)\n'
  expect(listedSources(answer).get(1)).toEqual({ title: 'Savannah food guide', url: 'https://eater.com/savannah' })
  const out = orderByCitations(answer, [...read, ...found])
  expect(out[0].url).toBe('https://eater.com/savannah')
  expect(out).toHaveLength(3)
})

test('a listed URL the run did not record is still the one [n] opens', () => {
  const out = orderByCitations('See [1] and [2].\n\nSources:\n[1] City site https://savannahga.gov/parking\n[2] NPS https://www.nps.gov/tybee', read)
  expect(out.slice(0, 2).map((s) => s.url)).toEqual(['https://savannahga.gov/parking', 'https://www.nps.gov/tybee'])
  expect(out[0].title).toBe('City site')
})

test('without a list: the order the answer first mentions each page, then the rest', () => {
  const out = orderByCitations('Food: https://eater.com/savannah. Parks: https://www.nps.gov/tybee.', [...read, ...found])
  expect(out.map((s) => s.url)).toEqual(['https://eater.com/savannah', 'https://www.nps.gov/tybee', 'https://visitsavannah.com/hotels'])
  // No links at all: unchanged.
  expect(orderByCitations('Plain answer.', read)).toEqual(read)
})

const ctx = { signal: new AbortController().signal } as unknown as ToolContext
const page = (): ReturnType<typeof webTools>[1] => webTools(() => ({ provider: 'duckduckgo' }) as never)[1]

test('fetch_page: a 403 is named as a bot wall with what to do instead', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })))
  await expect(page().run({ url: 'https://www.zillow.com/homes/savannah' }, ctx)).rejects.toThrow(/zillow\.com blocks automated reading \(HTTP 403.*another reputable site.*Never try to get past a CAPTCHA/)
})

test('fetch_page: a "Just a moment..." challenge served with 200 is a bot wall too, not page text', async () => {
  const html = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site. Enable JavaScript and cookies to continue.</p></body></html>'
  vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })))
  await expect(page().run({ url: 'https://example-shop.com/item' }, ctx)).rejects.toThrow(/example-shop\.com blocks automated reading/)
  expect(isChallengePage('Captcha check', 'Please verify you are a human')).toBe(true)
  // A real article that mentions CAPTCHAs is a page.
  expect(isChallengePage('How CAPTCHAs work', 'x'.repeat(3000) + ' captcha')).toBe(false)
})

test('search: every engine answering with nothing is "no results" (with what to do), not "search is down"', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><body>No results</body></html>', { status: 200 })))
  expect(await keyless('zzqx flurb', 5, new AbortController().signal)).toEqual([])
  const search = webTools(() => ({ provider: 'duckduckgo' }) as never)[0]
  const r = await search.run({ query: 'zzqx flurb' }, ctx)
  expect(r.text).toMatch(/No results for "zzqx flurb"\. Try 1-2 differently worded or broader queries.*don't guess/)
  // Engines that can't be reached still say so.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  await expect(keyless('x', 5, new AbortController().signal)).rejects.toThrow(/isn't reachable/)
})
