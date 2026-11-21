import { expect, test } from 'vitest'
import { claimsDone, givesUp, PROFILES, ALL_FEATURES } from '../../src/main/agent/harness-features'

test('a false "I\'ve done it" is a claim about the world, not the reply itself or the user\'s own work', () => {
  for (const t of ['I\'ve saved the summary to your note "Standup".', 'It\'s been sent to Acme.', 'The post has been published.', 'It\'s live at https://x.example'])
    expect(claimsDone(t), t).toBe(true)
  for (const t of ['Done: the change is made.', 'I\'ve written a summary below.', 'Should I save it?', 'Once you\'ve saved it, I can share it.', 'You already sent it yesterday.', 'Here is the plan.', 'Nothing has been sent yet.', 'The file hasn\'t been saved: the folder is read-only.'])
    expect(claimsDone(t), t).toBe(false)
})

test('giving up is noticed; a plain answer isn\'t', () => {
  expect(givesUp('I couldn\'t get the churn rate: the CRM report doesn\'t exist.')).toBe(true)
  expect(givesUp('I was unable to find that report.')).toBe(true)
  expect(givesUp('Unable to access the dashboard right now.')).toBe(true)
  expect(givesUp('Churn this quarter is 3.0%.')).toBe(false)
  expect(givesUp('I couldn\'t find a free slot Tuesday, but Wednesday at 3 works.')).toBe(false)
  expect(givesUp('I can\'t send email from here, so here\'s a draft.')).toBe(false)
})

test('profiles only switch features off; SahilBot has them all', () => {
  expect(PROFILES.sahilbot).toEqual(ALL_FEATURES)
  for (const p of Object.values(PROFILES)) for (const k of Object.keys(ALL_FEATURES) as Array<keyof typeof ALL_FEATURES>) expect(typeof p[k]).toBe('boolean')
})

test('the user\'s price limit is checked against what was chosen, not against everything the results listed', async () => {
  const { overLimit } = await import('../../src/main/agent/harness-features')
  const results = 'Hotel Palatino $240/night (4.8 stars)\nCasa Verde $185/night (4.5 stars)'
  expect(overLimit('Find a hotel in Rome under $200 a night', 'I shortlisted Hotel Palatino.', results, '')?.item).toBe('Hotel Palatino')
  expect(overLimit('Find a hotel in Rome under $200 a night', 'Shortlisted Casa Verde at $185.', results, '{"q":"Casa Verde"}')).toBeUndefined()
  expect(overLimit('Find a hotel in Rome', 'I shortlisted Hotel Palatino.', results, '')).toBeUndefined()
  expect(overLimit('max 200 dollars', '', results, '{"q":"Hotel Palatino"}')?.priceText).toBe('$240')
  // Set aside in the reply, a generic price line, or a $2k limit: no nudge.
  expect(overLimit('under $200', 'I skipped Hotel Palatino ($240) since it\'s over your budget; Casa Verde fits.', results, '{"q":"Casa Verde"}')).toBeUndefined()
  expect(overLimit('under $200', 'The total price is $199.', 'Total: $350\nPrice: $249', '')).toBeUndefined()
  expect(overLimit('a laptop under $2k', 'I picked the MacBook Air.', 'MacBook Air $1,099', '')).toBeUndefined()
})

test('more pages are noticed from the usual markers, never on the last page', async () => {
  const { morePages } = await import('../../src/main/agent/harness-features')
  expect(morePages('Open tickets, page 1 of 3: 40 tickets. next_cursor=p2')).toBe('page 1 of 3')
  expect(morePages('{"items":[...],"has_more":true}')).toMatch(/has_more/)
  expect(morePages('{"next_page_token":"abc123"}')).toMatch(/next_page_token/)
  expect(morePages('Open tickets, page 3 of 3: 22 tickets. No more pages.')).toBeUndefined()
  expect(morePages('page 1 of 1')).toBeUndefined()
  expect(morePages('{"next_cursor": null}')).toBeUndefined()
  expect(morePages('next_page = undefined')).toBeUndefined()
})

test('a refusal or bad input is a plain failure; a timeout may have gone through', async () => {
  const { definiteFailure } = await import('../../src/main/agent/runtime/policy')
  for (const e of ['Invalid date: use YYYY-MM-DD', 'EACCES: permission denied, open /Shared/Finance', 'Validation failed: title is required', '403 Forbidden']) expect(definiteFailure(e), e).toBe(true)
  // Might have gone through: transport errors, and errors after the send (an element gone after a submit, a bad reply body, a partial batch).
  for (const e of ['ETIMEDOUT: the server took too long', 'socket hang up', '503 Service Unavailable', 'Request timed out after 30s', 'something odd happened', 'no such element: #submit', 'Expected JSON, got HTML', '409 conflict on item 3 of 5', 'fetch failed', '404 Not Found']) expect(definiteFailure(e), e).toBe(false)
})

test('a read checks an uncertain write when it reads the same service', async () => {
  const { sameThing } = await import('../../src/main/agent/runtime/verification')
  expect(sameThing('send_invoice', 'list_sent_invoices')).toBe(true)
  expect(sameThing('gmail__send_message', 'gmail__search_threads')).toBe(true)
  expect(sameThing('send_invoice', 'web_search')).toBe(false)
  expect(sameThing('post_tweet', 'file_read')).toBe(false)
})
