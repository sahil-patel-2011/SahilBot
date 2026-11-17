import { describe, expect, test, vi } from 'vitest'
import type { ChatEvent, PendingRequest } from '../../src/shared/types'

vi.mock('electron', () => ({}))
const { classifyPurchase, splitItem, findMoney, parseMoney, pickTotal, redactCards, PurchaseGate, READY_MS, clean } = await import('../../src/main/browser/checkout')
const { decide, containsSecret, PURCHASE_STOP, OTP_STOP } = await import('../../src/main/agent/permissions')
const { decideWithRule } = await import('../../src/main/agent/loop').catch(() => ({ decideWithRule: undefined as never }))
const { browserTool, samePurchase } = await import('../../src/main/agent/tools/browser')
const { needsYouBody } = await import('../../src/main/needs-you')
const { cardProblem, luhn, cardBrand, cardLabel } = await import('../../src/shared/cards')

describe('purchase detection', () => {
  const click = (label: string, extra: Record<string, unknown> = {}) => classifyPurchase({ kind: 'click', label, role: 'button', url: 'https://shop.test/product/1', ...extra }).purchase
  test.each(['Place order', 'Place your order', 'Buy now', 'Buy it now', 'Buy with 1-Click', 'Pay $42.10', 'Pay now', 'Complete purchase', 'Confirm and pay', 'Submit order', 'Order now', 'Purchase', 'Donate $5', 'Complete order · $19.99'])('"%s" is a purchase', (l) => {
    expect(click(l)).toBe(true)
  })
  test.each(['Add to cart', 'Add to bag', 'View cart', 'Apply coupon', 'Sign in', 'Continue shopping', 'Search', 'Payment options', 'Edit address'])('"%s" is not', (l) => {
    expect(click(l)).toBe(false)
    expect(click(l, { url: 'https://shop.test/checkout' })).toBe(false)
  })
  test('subscribe / start trial only count on a checkout or payment page', () => {
    expect(click('Subscribe')).toBe(false)
    expect(click('Subscribe', { url: 'https://news.test/subscribe/plan' })).toBe(true)
    expect(click('Start free trial', { payFields: true })).toBe(true)
  })
  test('generic submits count once card details are on the page', () => {
    expect(click('Continue')).toBe(false)
    expect(click('Continue', { payFilled: true })).toBe(true)
    expect(classifyPurchase({ kind: 'enter', label: 'ZIP', url: 'https://x.test/a', payFilled: true }).purchase).toBe(true)
    expect(click('Next', { submit: true, inPayForm: true, url: 'https://x.test/checkout/payment' })).toBe(true)
  })
  test('purchase links are purchases too (no link exemption)', () => {
    expect(click('Buy now', { role: 'link' })).toBe(true)
    expect(click('Buy now', { role: 'link', navLink: true })).toBe(true)
    expect(click('Buy now', { role: 'link', url: 'https://x.test/cart' })).toBe(true)
  })
  test('a search result whose title mentions a price only opens that page (found live: a research run waited 16 min)', () => {
    const label = 'Commure Scribe Pricing | Plans from $59/mo'
    expect(click(label, { role: 'link', navLink: true, url: 'https://www.bing.com/search?q=commure+pricing' })).toBe(false)
    // The same words as a button, a link that acts like one, or on a checkout page still ask.
    expect(click(label, { url: 'https://www.bing.com/search?q=commure+pricing' })).toBe(true)
    expect(click(label, { role: 'link', navLink: false, url: 'https://www.bing.com/search?q=x' })).toBe(true)
    expect(click(label, { role: 'link', navLink: true, url: 'https://shop.test/checkout' })).toBe(true)
    expect(click('Buy now for $59', { role: 'link', navLink: true, url: 'https://www.bing.com/search?q=x' })).toBe(true)
  })
  test('filling a card, typing a card number and payment dialogs are purchase steps', () => {
    expect(classifyPurchase({ kind: 'fill_payment' }).purchase).toBe(true)
    expect(classifyPurchase({ kind: 'type_card' }).purchase).toBe(true)
    expect(classifyPurchase({ kind: 'dialog', dialogText: 'Confirm payment of $20?' }).purchase).toBe(true)
    expect(classifyPurchase({ kind: 'dialog', dialogText: 'Leave this page?' }).purchase).toBe(false)
  })
})

describe('money and totals', () => {
  test.each([
    ['$1,234.56', 1234.56, 'USD'], ['US$ 12.00', 12, 'USD'], ['€12,50', 12.5, 'EUR'], ['12,50 €', 12.5, 'EUR'], ['1.234,56 €', 1234.56, 'EUR'],
    ['£9.99', 9.99, 'GBP'], ['¥1,200', 1200, 'JPY'], ['JPY 1200', 1200, 'JPY'], ['CHF 12.50', 12.5, 'CHF'], ['₹1,23,456.00', 123456, 'INR'],
    ['R$ 10,00', 10, 'BRL'], ['C$5', 5, 'CAD'], ['1 234,56 EUR', 1234.56, 'EUR'], ["CHF 1'234.50", 1234.5, 'CHF'], ['A$ 99', 99, 'AUD']
  ])('%s', (text, amount, currency) => {
    expect(parseMoney(text)).toMatchObject({ amount, currency })
  })
  test('the order total beats subtotal, shipping and plain totals; the button amount is a fallback', () => {
    const rows = [
      { label: 'Subtotal', text: 'Subtotal $40.00' },
      { label: 'Shipping', text: 'Shipping $5.00' },
      { label: 'Total', text: 'Total $45.00' },
      { label: 'Order total', text: 'Order total $47.10' }
    ]
    expect(pickTotal(rows)).toMatchObject({ amount: 47.1, currency: 'USD' })
    expect(pickTotal(rows.slice(0, 2))).toBeNull()
    expect(pickTotal([], 'Pay €19,99')).toMatchObject({ amount: 19.99, currency: 'EUR' })
    expect(pickTotal([{ label: 'Total', text: 'Shipping $5.00 Total $45.00' }])).toMatchObject({ amount: 45 })
    expect(findMoney('2 × $10.00 = $20.00').map((m) => m.amount)).toEqual([10, 20])
    expect(splitItem('Ceramic mug × 2 $24.00')).toEqual({ name: 'Ceramic mug × 2', price: '$24.00' })
  })
})

describe('card helpers and redaction', () => {
  test('Luhn, brand, expiry', () => {
    expect(luhn('4242 4242 4242 4242')).toBe(true)
    expect(luhn('4242 4242 4242 4241')).toBe(false)
    expect(cardBrand('378282246310005')).toBe('amex')
    expect(cardBrand('5555555555554444')).toBe('mastercard')
    expect(cardProblem({ number: '4242424242424242', month: 1, year: 2020 })).toMatch(/expiry/)
    expect(cardProblem({ number: '4242424242424242', month: 12, year: 2099, cvc: '12' })).toMatch(/3 digits/)
    expect(cardProblem({ number: '4242424242424242', month: 12, year: 2099, cvc: '123' })).toBeNull()
    expect(cardLabel({ nickname: 'Personal', brand: 'visa', last4: '4242' })).toBe('Personal (Visa ending 4242)')
  })
  test('saved numbers are hidden however they are written', () => {
    const n = ['4242424242424242']
    const t = redactCards('a 4242 4242 4242 4242 b 4242-4242-4242-4242 c 4242424242424242 d 4111111111111111', n)
    expect(t).not.toMatch(/4242\s?-?4242/)
    expect(t).toContain('•••• 4242')
    expect(t).toContain('4111111111111111')
  })
  test('the leak check blocks card numbers in any format', () => {
    const secrets = ['4242424242424242', '4242 4242 4242 4242']
    expect(containsSecret({ text: 'card 4242-4242-4242-4242' }, secrets)).toBe(true)
    expect(containsSecret({ text: 'card 4242.4242.4242.4242' }, secrets)).toBe(true)
    expect(containsSecret({ text: 'order 4242' }, secrets)).toBe(false)
  })
  test('notification bodies never carry card numbers, and purchase cards show nothing on the lock screen', () => {
    const appr: PendingRequest = { id: '1', threadId: 't', kind: 'approval', tool: 'browser', summary: 'Type "4242 4242 4242 4242" into textbox "Card"', args: '{"action":"click"}' }
    expect(needsYouBody(appr)).not.toMatch(/4242 4242/)
    const pur: PendingRequest = { id: '2', threadId: 't', kind: 'purchase', purchase: { step: 'submit', merchant: 'shop.test', url: 'https://shop.test/checkout', secure: true, action: 'Click "Place order"', items: [], total: null, payment: 'Visa ending 4242', shipping: 'Home', reasons: [], nonce: 'n', readyAt: 0, expiresAt: 0 } }
    expect(needsYouBody(pur)).not.toMatch(/4242|shop\.test/)
  })
  test('page text on the card has no direction overrides or control characters', () => {
    expect(clean('Pay‮redro ecalP\u0000 now')).toBe('Pay redro ecalP now')
  })
})

describe('the purchase gate', () => {
  const setup = (run: { helper?: boolean; unattended?: boolean } | null = {}, handoff = false) => {
    const events: ChatEvent[] = []
    let grants: string[] = []
    const gate = new PurchaseGate({ emit: (e) => events.push(e), runInfo: () => run ?? undefined, startedByHandoff: () => handoff, otpGrants: { get: () => grants, set: (g) => { grants = g } } })
    return { gate, events, grants: () => grants }
  }
  const info = { step: 'submit' as const, merchant: 'shop.test', url: 'https://shop.test/checkout', secure: true, action: 'Click "Place order"', items: [], total: { amount: 47.1, currency: 'USD', display: '$47.10' }, payment: 'Visa ending 4242', shipping: 'Home', reasons: ['x'] }
  const pending = (events: ChatEvent[]) => (events.find((e) => e.type === 'pending') as Extract<ChatEvent, { type: 'pending' }>).request

  test('unattended runs, helpers and handoffs are refused with "Purchases need you"', () => {
    expect(setup({ unattended: true }).gate.refusal('t')).toMatch(/^Purchases need you/)
    expect(setup({ helper: true }).gate.refusal('t')).toMatch(/^Purchases need you/)
    expect(setup({}, true).gate.refusal('t')).toMatch(/^Purchases need you/)
    expect(setup(null).gate.refusal('t')).toMatch(/^Purchases need you/)
    expect(setup({}).gate.refusal('t')).toBeNull()
  })

  test('approval is bound to the card: nonce, thread, timing; single use; no "always"', async () => {
    const { gate, events } = setup()
    const t0 = Date.now()
    const p = gate.request('t', info, new AbortController().signal, t0)
    const req = pending(events)
    expect(req.kind).toBe('purchase')
    expect(gate.respond('t', req.id, 'wrong', 'approve', t0 + READY_MS + 1).ok).toBe(false)
    expect(gate.respond('other', req.id, req.purchase!.nonce, 'approve', t0 + READY_MS + 1).ok).toBe(false)
    expect(gate.respond('t', req.id, req.purchase!.nonce, 'approve', t0 + 10).ok).toBe(false)
    expect(gate.respond('t', req.id, req.purchase!.nonce, 'always', t0 + READY_MS + 1).ok).toBe(false)
    expect(gate.respond('t', req.id, req.purchase!.nonce, 'approve', t0 + READY_MS + 1).ok).toBe(true)
    await expect(p).resolves.toBe('approve')
    // Used up: the same click can't approve again.
    expect(gate.respond('t', req.id, req.purchase!.nonce, 'approve', t0 + READY_MS + 2).ok).toBe(false)
    expect(events.some((e) => e.type === 'resolved')).toBe(true)
  })

  test('Stop cancels a waiting card', async () => {
    const { gate } = setup()
    const ctrl = new AbortController()
    const p = gate.request('t', info, ctrl.signal)
    ctrl.abort()
    await expect(p).resolves.toBe('deny')
    expect(gate.pending('t')).toHaveLength(0)
  })

  test('one-time codes: per chat, or always for a site; unattended only with a permanent grant', async () => {
    const s = setup({ unattended: true })
    expect(s.gate.otpRefusal('t', 'acme.test')).toMatch(/One-time codes need you/)
    const a = setup({})
    const t0 = Date.now()
    const p = a.gate.requestOtp('t', { site: 'acme.test', source: 'sms' }, new AbortController().signal, t0)
    const req = pending(a.events)
    expect(req.kind).toBe('otp')
    expect(Object.keys(req.otp!).sort()).toEqual(['expiresAt', 'nonce', 'readyAt', 'site', 'source'])
    expect(a.gate.respond('t', req.id, req.otp!.nonce, 'always', t0 + READY_MS + 1).ok).toBe(true)
    await expect(p).resolves.toBe('always')
    // Grants are kept per origin (scheme + host).
    expect(a.grants()).toEqual(['https://acme.test'])
    expect(a.gate.otpAllowed('another-chat', 'acme.test')).toBe(true)
    a.gate.revokeOtp('acme.test')
    expect(a.gate.otpAllowed('another-chat', 'acme.test')).toBe(false)
  })
})

describe('permissions: purchases and codes ask on their own card, whatever the mode or rules', () => {
  const base = { effect: 'write_external' as const, tool: 'browser', alwaysAllowed: false, hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true }
  test('no generic card (the gate asks), in every mode, with or without hard stops or Always allow', () => {
    for (const mode of ['ask', 'auto', 'bypass'] as const) {
      for (const hardStopsEnabled of [true, false]) {
        for (const alwaysAllowed of [true, false]) {
          expect(decide({ ...base, mode, hardStopsEnabled, alwaysAllowed, hardStop: `${PURCHASE_STOP}x` }).verdict).toBe('allow')
          expect(decide({ ...base, mode, hardStopsEnabled, alwaysAllowed, hardStop: `${OTP_STOP}x` }).verdict).toBe('allow')
        }
      }
    }
    if (decideWithRule) expect(decideWithRule({ ...base, mode: 'bypass', hardStop: `${PURCHASE_STOP}x` }, 'allow').verdict).toBe('allow')
  })
  test('a leaked secret is still denied first', () => {
    expect(decide({ ...base, mode: 'bypass', leaksSecret: true, hardStop: `${PURCHASE_STOP}x` }).verdict).toBe('deny')
  })
})

describe('the browser tool fails closed', () => {
  const fake = {
    refInfo: (r: string) => (r === 'e1' ? { backendNodeId: 1, role: 'button', name: 'Place order' } : undefined),
    pageUrl: () => 'https://shop.test/checkout', pendingDialog: null, teach: { state: () => undefined },
    commerce: () => ({ payFields: true, payFilled: true }), tabKey: () => 1, offeredDownloads: () => [],
    ensureRef: async (ref: string) => ({ ref }), takeBlockedCard: () => [], hiddenValues: () => [], humanCheck: async () => null,
    purchaseContext: async () => ({ url: 'https://shop.test/checkout', title: '', total: null, items: [], payFields: 1, payFilled: true, payFrames: [], target: { label: 'Place order', tag: 'button', type: 'submit', submit: true, inPayForm: true, formFilled: true, cardField: '' } }),
    click: vi.fn(async () => 'clicked'), showToUser: () => undefined
  }
  const vault = { cardNumbers: () => [], cardNames: () => [], addressNames: () => [] }
  test('a purchase click is a self-gated hard stop, and without a gate it is refused and nothing is clicked', async () => {
    const tool = browserTool(fake as never, vault as never)
    expect(tool.hardStop?.({ action: 'click', ref: 'e1' } as never)).toMatch(/^purchase: /)
    await expect(tool.run({ action: 'click', ref: 'e1' } as never, { threadId: 't', signal: new AbortController().signal } as never)).rejects.toThrow(/Purchases need you/)
    expect(fake.click).not.toHaveBeenCalled()
  })
  test('a page change between approval and click is detected', () => {
    const a = { url: 'u', total: { amount: 47.1, currency: 'USD', display: '$47.10' }, target: { label: 'Place order' } as never }
    expect(samePurchase(a, a)).toBe(true)
    expect(samePurchase(a, { ...a, total: { amount: 99, currency: 'USD', display: '$99' } })).toBe(false)
    expect(samePurchase(a, { ...a, url: 'v' })).toBe(false)
  })
})
