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

test('"I can\'t access that" is a claim about ability (worth trying first); a safety refusal isn\'t', async () => {
  const { claimsCant } = await import('../../src/main/agent/harness-features')
  for (const t of ['I don\'t have access to your files.', 'I can\'t browse the web, but here is what I know.', 'As an AI, I can\'t open apps on your Mac.', 'I\'m not able to read that PDF.']) expect(claimsCant(t), t).toBe(true)
  for (const t of ['I can\'t help with that.', 'I won\'t do that: it could hurt someone.', 'Here is the summary.', 'I can send it once you confirm.']) expect(claimsCant(t), t).toBe(false)
})

import { claimsCant as cant2, claimsDone as done2, givesUp as up2, morePages as pages2, overLimit as over2 } from '../../src/main/agent/harness-features'

test('curly apostrophes, sentence scope, scaled limits and last pages (review fixes)', () => {
  // Models often write ’: the checks read it like '.
  expect(done2('I’ve sent the email.')).toBe(true)
  expect(up2('I couldn’t find the report.')).toBe(true)
  expect(cant2('I can’t access your files.')).toBe(true)
  // A claim followed by an honest note or a question is still a claim; "nothing has been sent yet" isn't one.
  expect(done2('I\'ve saved it. Nothing was deleted.')).toBe(true)
  expect(done2('I\'ve sent it. Anything else?')).toBe(true)
  expect(done2('Nothing has been sent yet.')).toBe(false)
  expect(up2('I couldn\'t send it: the address bounced.')).toBe(true)
  // "$2 million" isn't a $2 limit; totals and fees aren't choices.
  expect(over2('find a house under $2 million', 'Villa A is a great pick.', 'Villa A - $1,900,000', '')).toBeUndefined()
  expect(over2('a gift under $50', 'Your order total is ready.', 'Order total: $75\nCandle - $30', '')).toBeUndefined()
  expect(over2('a gift under $50', 'I picked the Wool Scarf.', 'Wool Scarf - $80', '')).toMatchObject({ item: 'Wool Scarf' })
  // A cursor of 0, or a next page past the last, isn't more pages.
  expect(pages2('{"next_cursor": 0}')).toBeUndefined()
  expect(pages2('{"next_page": 2, "total_pages": 1}')).toBeUndefined()
  expect(pages2('{"next_page": 2, "total_pages": 3}')).toBeTruthy()
  expect(pages2('{"next_cursor": "abc123"}')).toBeTruthy()
})

test('a "done" claim backed by a successful tool of the same kind is not challenged, even if the tool is labeled read-only', async () => {
  const { claimBacked } = await import('../../src/main/agent/harness-features')
  expect(claimBacked('It\'s live: https://blog.example/clicks', ['publish_post'])).toBe(true)
  expect(claimBacked('I\'ve sent the email to Acme.', ['gmail__send_message'])).toBe(true)
  expect(claimBacked('Published and emailed the link.', ['publish_post'])).toBe(false)
  expect(claimBacked('I\'ve saved the summary to your notes.', ['web_search', 'fetch_page'])).toBe(false)
  expect(claimBacked('I\'ve saved it.', [])).toBe(false)
})

// Honesty (HTA-01/03): the common claims count, a long reply is still read, and the reply itself is no claim.
test('"done" claims: created, wrote, added, updated… count when they name something in the world', async () => {
  const { claimBacked, claimsDone: done } = await import('../../src/main/agent/harness-features')
  for (const t of ['I created budget.xlsx in Downloads.', 'I\'ve written rename_photos.py to your Desktop.', 'I added the dentist to your calendar.', 'I\'ve updated the invoice.', 'I fixed the bug in app.ts.', 'I\'ve cancelled the order.', 'I\'ve downloaded the report.', 'I\'ve signed in to your account.', `${'Here is the long part. '.repeat(120)}I've emailed it to Sam.`])
    expect(done(t), t).toBe(true)
  for (const t of ['I wrote a short poem for you:', 'I\'ve added a section on hotels below.', 'I updated my answer above.', 'Done.', 'Here\'s what I created for you:\n\nA plan.', 'The store opened in 2010.'])
    expect(done(t), t).toBe(false)
  // Only the verbs it claims need backing (not "opened" in a sentence that claims nothing).
  expect(claimBacked('I\'ve saved report.pdf. The store opened in 2010.', ['file_write'])).toBe(true)
  expect(claimBacked('I created budget.xlsx in Downloads.', ['create_document'])).toBe(true)
  expect(claimBacked('I\'ve moved the photos to the Trip folder.', ['file_manage'])).toBe(true)
  expect(claimBacked('I\'ve emailed the invoice to Sam.', ['save_invoice'])).toBe(false)
})

test('a question for the user ends the run; a closing "anything else?" does not count', async () => {
  const { asksUserNow } = await import('../../src/main/agent/harness-features')
  for (const t of ['Which date works, Friday or Saturday?', 'I found two flights. Which one should I book?', 'What\'s the delivery address?'])
    expect(asksUserNow(t), t).toBe(true)
  for (const t of ['Saved it. Anything else?', 'Done. Let me know if you need anything else?', 'Saved budget.xlsx.', 'Here is the plan. Sound good?'])
    expect(asksUserNow(t), t).toBe(false)
})

test('the prompts ask for one plain sentence about what could not be checked, never "all checks passed"', async () => {
  const { chatPrompt, harnessPrompt } = await import('../../src/main/agent/prompt')
  const base = { userName: 'Sam', workspaceDir: '/w', spacePrompt: '', spaceName: 'Main' }
  expect(harnessPrompt(base)).toMatch(/anything you couldn't check, plainly; never "all checks passed"/)
  expect(chatPrompt(base)).toMatch(/Never say you did something \(saved, sent, booked\) unless a tool in this chat did it/)
})
