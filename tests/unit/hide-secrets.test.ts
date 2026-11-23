import { expect, test } from 'vitest'
import { hideCopiedSecrets } from '../../src/main/agent/notes'

// Agent Arena: a model read .env and pasted the live Stripe key into its answer. The harness hides it.
// Fake keys in real keys' shapes, built at run time so no key-shaped string sits in the source.
const stripe = ['sk', 'live', 'TEST0fake0not0a0real0key0000'].join('_')
const sendgrid = ['SG', 'testFakeKey', 'not0a0real0key0'].join('.')
const mine = ['sk', 'live', 'userTypedKey123456'].join('_')

test('a live secret copied out of a file is hidden in the answer; one the user typed stays', () => {
  const env = `STRIPE_SECRET_KEY=${stripe}\nSENDGRID_API_KEY=${sendgrid}\nREDIS_URL=redis://localhost:6379`
  const out = hideCopiedSecrets(`Stripe (key ${stripe}), SendGrid ${sendgrid} and Redis at redis://localhost:6379.`, env, 'Look at .env')
  expect(out).not.toContain(stripe)
  expect(out).not.toContain(sendgrid)
  expect(out).toContain('sk_live…[hidden]')
  expect(out).toContain('redis://localhost:6379')
  // The user's own key, pasted by them: their answer may repeat it.
  expect(hideCopiedSecrets(`Using ${mine}`, mine, `my key is ${mine}`)).toContain(mine)
  // Nothing secret: unchanged.
  expect(hideCopiedSecrets('All good.', env, '')).toBe('All good.')
})

test('a quoted .env value is hidden when the answer copies it without the quotes', () => {
  const env = `DB_PASSWORD="hunter2-very-long-pw"\nAPP_TOKEN='tok_abcdefgh12345'`
  const out = hideCopiedSecrets('The password is hunter2-very-long-pw and the token tok_abcdefgh12345.', env, 'check .env')
  expect(out).not.toContain('hunter2-very-long-pw')
  expect(out).not.toContain('tok_abcdefgh12345')
})
