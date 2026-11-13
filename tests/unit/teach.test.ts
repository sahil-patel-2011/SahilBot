import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TeachStep } from '@shared/types'

vi.mock('electron', () => ({}))
const T = await import('../../src/main/browser/teach')
const { pushStep, sanitizeStep, looksLikeSecret, isSecretField, redactUrl, stepToText, stepsToText, teachMessage, fromPage, listenerScript, TeachRecorder, MAX_STEPS, MAX_MS, SECRET, TEACH_INSTRUCTION } = T

const step = (s: Partial<TeachStep> & Pick<TeachStep, 'kind'>): TeachStep => ({ at: 0, tab: 1, ...s })

describe('collapsing and dedupe', () => {
  test('keystrokes in one field become one type step with the final text', () => {
    const steps: TeachStep[] = []
    for (const [i, t] of ['h', 'he', 'hel', 'hello'].entries()) pushStep(steps, step({ kind: 'type', role: 'searchbox', name: 'Search', selector: '#q', text: t, at: i * 100 }))
    expect(steps).toHaveLength(1)
    expect(steps[0].text).toBe('hello')
  })
  test('a different field, or a key in between, starts a new step', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'type', name: 'First name', selector: '#first', text: 'Ada' }))
    pushStep(steps, step({ kind: 'type', name: 'Last name', selector: '#last', text: 'Lovelace' }))
    pushStep(steps, step({ kind: 'key', key: 'Enter', selector: '#last' }))
    pushStep(steps, step({ kind: 'type', name: 'Last name', selector: '#last', text: 'Byron' }))
    expect(steps.map((s) => s.kind)).toEqual(['type', 'type', 'key', 'type'])
  })
  test('the click that focused a field is folded into the typing', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'click', role: 'textbox', name: 'Email', selector: '#email' }))
    pushStep(steps, step({ kind: 'type', role: 'textbox', name: 'Email', selector: '#email', text: 'a@b.co' }))
    expect(steps).toHaveLength(1)
    expect(steps[0].kind).toBe('type')
  })
  test('double clicks and held keys are dropped; toggles keep their final state', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'click', role: 'button', name: 'Save', selector: '#save', at: 0 }))
    pushStep(steps, step({ kind: 'click', role: 'button', name: 'Save', selector: '#save', at: 200 }))
    pushStep(steps, step({ kind: 'click', role: 'button', name: 'Save', selector: '#save', at: 5000 }))
    expect(steps).toHaveLength(2)
    pushStep(steps, step({ kind: 'click', role: 'checkbox', name: 'Remember', checked: true, at: 6000 }))
    pushStep(steps, step({ kind: 'click', role: 'checkbox', name: 'Remember', checked: false, at: 6300 }))
    expect(steps).toHaveLength(3)
    expect(steps[2].checked).toBe(false)
    pushStep(steps, step({ kind: 'key', key: 'Enter', at: 7000 }))
    pushStep(steps, step({ kind: 'key', key: 'Enter', at: 7100 }))
    expect(steps).toHaveLength(4)
  })
  test('redirects collapse into one navigation; a navigation right after a click is its result', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'navigate', cause: 'address', url: 'https://example.com', at: 0 }))
    pushStep(steps, step({ kind: 'navigate', cause: 'page', url: 'https://www.example.com/', at: 300 }))
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ cause: 'address', url: 'https://www.example.com/' })
    pushStep(steps, step({ kind: 'click', role: 'link', name: 'Pricing', at: 9000 }))
    pushStep(steps, step({ kind: 'navigate', cause: 'page', url: 'https://www.example.com/pricing', at: 9400 }))
    expect(steps[2].cause).toBe('action')
  })
  test('URL rewrites while typing are noise', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'type', name: 'Search', selector: '#q', text: 'cats' }))
    expect(pushStep(steps, step({ kind: 'navigate', cause: 'page', inPage: true, url: 'https://x.com/?q=cats', at: 50 }))).toBe('dropped')
    expect(steps).toHaveLength(1)
  })
  test('choosing in a dropdown replaces the click that opened it', () => {
    const steps: TeachStep[] = []
    pushStep(steps, step({ kind: 'click', role: 'combobox', name: 'Country', selector: '#country' }))
    pushStep(steps, step({ kind: 'select', role: 'combobox', name: 'Country', selector: '#country', text: 'Canada' }))
    expect(steps).toEqual([expect.objectContaining({ kind: 'select', text: 'Canada' })])
  })
})

describe('secret redaction', () => {
  test('password fields are never recorded, whatever was typed', () => {
    const s = sanitizeStep(step({ kind: 'type', name: 'Password', selector: '#pw', inputType: 'password', text: 'hunter2' }))
    expect(s.text).toBe(SECRET)
    expect(s.secret).toBe(true)
    // ...even when the page called the field something innocent
    expect(sanitizeStep(step({ kind: 'type', name: 'Enter it', inputType: 'password', text: 'x' })).text).toBe(SECRET)
  })
  test('card, one-time-code and new-password autocomplete fields are secret', () => {
    for (const ac of ['cc-number', 'cc-csc', 'cc-exp', 'one-time-code', 'current-password', 'new-password', 'billing cc-number']) {
      expect(sanitizeStep(step({ kind: 'type', name: 'Field', autocomplete: ac, text: '4242' })).text).toBe(SECRET)
    }
    expect(sanitizeStep(step({ kind: 'select', name: 'Month', autocomplete: 'cc-exp-month', text: '04' })).text).toBe(SECRET)
  })
  test('fields labelled as codes, PINs, CVV or keys are secret; ordinary ones are not', () => {
    expect(isSecretField({ name: 'Verification code' })).toBe(true)
    expect(isSecretField({ name: 'CVV' })).toBe(true)
    expect(isSecretField({ name: 'API key' })).toBe(true)
    expect(isSecretField({ selector: 'input[name="otp"]' })).toBe(true)
    expect(isSecretField({ name: 'Card number' })).toBe(true)
    expect(isSecretField({ name: 'Search' })).toBe(false)
    expect(isSecretField({ name: 'Passenger name' })).toBe(false)
    expect(isSecretField({ name: 'Shipping address' })).toBe(false)
    expect(sanitizeStep(step({ kind: 'type', name: 'Enter the code we sent', text: '482913' })).text).toBe(SECRET)
    expect(sanitizeStep(step({ kind: 'type', name: 'Zip code', text: '30303' })).text).toBe('30303')
  })
  test('text that looks like a key, token or card number is hidden in any field', () => {
    for (const v of ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-proj-ABCDEFGHIJKLMNOPQRSTUV12', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAIOSFODNN7EXAMPLE',
      'xoxb-123456789012-abcdefghijkl', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', '4242 4242 4242 4242', 'password: hunter2', 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4', '123-45-6789']) {
      expect(looksLikeSecret(v), v).toBe(true)
      expect(sanitizeStep(step({ kind: 'type', name: 'Notes', text: v })).text).toBe(SECRET)
    }
    for (const v of ['hello world', 'Atlanta, GA', 'jane@example.com', 'https://example.com/a/b', '1234 5678', 'Quarterly report 2024']) expect(looksLikeSecret(v), v).toBe(false)
  })
  test('tokens in URLs are redacted but the page stays readable', () => {
    expect(redactUrl('https://app.io/reset?token=abc123&lang=en')).toBe(`https://app.io/reset?token=${SECRET}&lang=en`)
    expect(redactUrl('https://app.io/cb?code=xyz&state=s1')).toBe(`https://app.io/cb?code=${SECRET}&state=${SECRET}`)
    expect(redactUrl('https://app.io/#access_token=abc&x=1')).toBe(`https://app.io/#access_token=${SECRET}&x=1`)
    expect(redactUrl('https://user:pw@app.io/inbox')).toBe('https://app.io/inbox')
    expect(redactUrl('https://app.io/invite/a1b2c3d4e5f6g7h8i9j0k1l2m3/join')).toBe(`https://app.io/invite/${SECRET}/join`)
    expect(redactUrl('https://duckduckgo.com/?q=weather')).toBe('https://duckduckgo.com/?q=weather')
  })
  test('the page listener reports secret fields without their value', () => {
    expect(fromPage({ t: 'x', type: 'input', name: 'Password', secret: true, value: 'leak' })).toMatchObject({ kind: 'type', text: '', secret: true })
    expect(fromPage({ type: 'bogus' })).toBeNull()
    // the listener itself checks password type, cc-/one-time-code autocomplete and labels before sending
    const src = listenerScript('tok')
    expect(src).toContain("'password'")
    expect(src).toContain('one-time-code')
    expect(src).toContain('"tok"')
    expect(() => new Function(src)).not.toThrow()
  })
})

describe('step text', () => {
  test('each step reads as plain English', () => {
    expect(stepToText(step({ kind: 'navigate', cause: 'address', url: 'https://www.example.com/billing/' }))).toBe('Go to example.com/billing')
    expect(stepToText(step({ kind: 'navigate', cause: 'action', url: 'https://example.com/x' }))).toBe('The page opens example.com/x')
    expect(stepToText(step({ kind: 'click', role: 'button', name: 'Download PDF' }))).toBe('Click the button "Download PDF"')
    expect(stepToText(step({ kind: 'click', role: 'link', name: 'Invoices' }))).toBe('Click the link "Invoices"')
    expect(stepToText(step({ kind: 'click', role: 'checkbox', name: 'Paid', checked: true }))).toBe('Click the checkbox "Paid" (turns it on)')
    expect(stepToText(step({ kind: 'type', name: 'Search', text: 'march' }))).toBe('Type "march" into the "Search" field')
    expect(stepToText(step({ kind: 'type', name: 'Password', text: SECRET, secret: true }))).toBe(`Type ${SECRET} into the "Password" field`)
    expect(stepToText(step({ kind: 'select', name: 'Month', text: 'March' }))).toBe('Choose "March" in "Month"')
    expect(stepToText(step({ kind: 'key', key: 'Enter', name: 'Search' }))).toBe('Press Enter in "Search"')
    expect(stepToText(step({ kind: 'tab', op: 'switch', tab: 2, title: 'Inbox' }))).toBe('Switch to tab 2 ("Inbox")')
    expect(stepToText(step({ kind: 'download', filename: 'invoice.pdf', url: 'https://files.example.com/a/invoice.pdf' }))).toBe('Download "invoice.pdf" from files.example.com')
    expect(stepToText(step({ kind: 'history', op: 'back' }))).toBe('Go back')
    expect(stepToText(step({ kind: 'click', role: 'button', name: 'Pay', frame: 'js.stripe.com' }))).toContain('inside the embedded js.stripe.com frame')
  })
  test('the chat message has the goal, numbered steps and the skill instruction; details go to the model', () => {
    const steps = [
      step({ kind: 'navigate', cause: 'address', url: 'https://billing.example.com' }),
      step({ kind: 'type', name: 'Password', text: SECRET, secret: true }),
      step({ kind: 'click', role: 'button', name: 'Download', selector: '#dl' })
    ]
    const m = teachMessage({ name: 'Monthly invoices', goal: 'Get the latest invoice PDF', steps, ms: 95_000 })
    expect(m.text.split('\n')[0]).toBe('Teach: Monthly invoices')
    expect(m.text).toContain('Goal: Get the latest invoice PDF')
    expect(m.text).toContain('(3 steps, 2 min)')
    expect(m.text).toContain('1. Go to billing.example.com\n2. Type ‹secret› into the "Password" field\n3. Click the button "Download"')
    expect(m.text).toContain(TEACH_INSTRUCTION)
    expect(m.text).toContain('"monthly-invoices"')
    expect(m.text).not.toContain('#dl')
    expect(m.note).toContain('selector=#dl')
    expect(m.note).toContain('never put them in the skill'.replace('never', 'Never'))
    expect(stepsToText(steps).split('\n')).toHaveLength(3)
  })
})

describe('caps', () => {
  afterEach(() => { vi.useRealTimers() })
  test(`a recording holds at most ${MAX_STEPS} steps`, () => {
    const steps: TeachStep[] = []
    for (let i = 0; i < MAX_STEPS; i++) expect(pushStep(steps, step({ kind: 'click', role: 'button', name: `B${i}`, at: i * 1000 }))).toBe('added')
    expect(pushStep(steps, step({ kind: 'click', role: 'button', name: 'one more', at: 999_999 }))).toBe('full')
    expect(steps).toHaveLength(MAX_STEPS)
  })
  test('the recorder stops itself at the step cap and keeps the steps', async () => {
    const changes = vi.fn()
    const r = new TeachRecorder(changes)
    await r.start({ by: 'user', tabs: [] })
    for (let i = 0; i < MAX_STEPS + 5; i++) r.record(null, { kind: 'click', role: 'button', name: `B${i}`, at: 0 })
    expect(r.state()).toMatchObject({ status: 'stopped', limit: 'steps', steps: MAX_STEPS })
    expect(r.state()!.recent).toHaveLength(3)
    const m = r.compose('Many clicks')
    expect(m.text).toContain(`${MAX_STEPS}. Click the button "B${MAX_STEPS - 1}"`)
    expect(r.state()).toBeUndefined()
  })
  test('the recorder stops itself after 10 minutes', async () => {
    vi.useFakeTimers()
    const r = new TeachRecorder(() => undefined)
    await r.start({ by: 'agent', tabs: [], name: 'Check grades', threadId: 't1' })
    r.record(null, { kind: 'navigate', cause: 'address', url: 'https://school.example.com', at: 0 })
    vi.advanceTimersByTime(MAX_MS + 10)
    expect(r.state()).toMatchObject({ status: 'stopped', limit: 'time', steps: 1, by: 'agent', threadId: 't1' })
    r.record(null, { kind: 'click', role: 'button', name: 'Late', at: 0 })
    expect(r.state()!.steps).toBe(1)
    expect(r.compose('').text.split('\n')[0]).toBe('Teach: Check grades')
  })
  test("the bot's own actions are not recorded", async () => {
    const r = new TeachRecorder(() => undefined)
    await r.start({ by: 'user', tabs: [] })
    r.hold()
    r.record(null, { kind: 'click', role: 'button', name: 'Bot click', at: 0 })
    r.release()
    r.record(null, { kind: 'click', role: 'button', name: 'Right after', at: 0 })
    expect(r.state()!.steps).toBe(0)
    r.cancel()
    expect(r.state()).toBeUndefined()
  })
})
