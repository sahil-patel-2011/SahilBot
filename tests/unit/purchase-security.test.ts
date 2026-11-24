import { describe, expect, test, vi } from 'vitest'
import type { ChatEvent, PurchaseInfo } from '../../src/shared/types'

// Regression tests for the purchase / one-time-code / vault security review (probes a–d and popup).
vi.mock('electron', () => ({}))
const { classifyPurchase, PurchaseGate, isCheckoutUrl, benignClickLabel, otpSiteKey } = await import('../../src/main/browser/checkout')
const { decide, PURCHASE_STOP, spendsMoney } = await import('../../src/main/agent/permissions')
const { browserTool, clickEffect } = await import('../../src/main/agent/tools/browser')
const { pickCode, codeCandidate, codeSnippet, brandOf, domainOf, senderDomain } = await import('../../src/main/otp')
const { originMatches } = await import('../../src/main/vault')
const { registrableDomain, publicSuffix, isPublicSuffix, sameSite } = await import('../../src/main/psl')
const { containsCard, navLinkOf } = await import('../../src/main/browser/manager')
const { selfTarget } = await import('../../src/main/computer/ax')
const { computerTool } = await import('../../src/main/agent/tools/computer')

const vault = { cardNumbers: () => [], cardNames: () => [], addressNames: () => [] }
type Ctx = { url: string; total?: { amount: number; currency: string; display: string } | null; target?: Record<string, unknown> }

/** A fake browser: one target element e1 (role/name), a quantity field e2, a page URL. */
function fakeBrowser(role: string, name: string, url: string, o: { payFields?: boolean; ctx?: () => Ctx; extra?: Record<string, unknown> } = {}) {
  const log: string[] = []
  const fake: any = {
    refInfo: (r: string) => (r === 'e1' ? { backendNodeId: 1, role, name } : r === 'e2' ? { backendNodeId: 2, role: 'textbox', name: 'Quantity' } : undefined),
    pageUrl: () => url, pendingDialog: null, teach: { state: () => undefined },
    commerce: () => ({ payFields: !!o.payFields, payFilled: false }), tabKey: () => 1, offeredDownloads: () => [],
    ensureRef: async (ref: string) => ({ ref }), takeBlockedCard: () => [], hiddenValues: () => [], humanCheck: async () => null,
    purchaseContext: async () => {
      const c = o.ctx?.() ?? { url }
      return { url: c.url, title: '', total: c.total ?? null, items: [], payFields: o.payFields ? 1 : 0, payFilled: false, payFrames: [], target: { label: name, tag: role === 'link' ? 'a' : 'button', type: '', submit: false, inPayForm: false, formFilled: false, cardField: '', ...(c.target ?? {}) } }
    },
    click: vi.fn(async () => { log.push('click'); return 'clicked' }),
    pressEnter: vi.fn(async () => { log.push('enter'); return 'pressed Enter' }),
    type: vi.fn(async (_r: string, t: string, submit?: boolean) => { log.push(`type ${t}${submit ? ' +enter' : ''}`); return 'typed' }),
    select: vi.fn(), snapshot: async () => 'snap', showToUser: () => undefined, openPurchaseWindow: vi.fn(), closePurchaseWindow: vi.fn(),
    ...o.extra
  }
  return { fake, log }
}

function gateFor(o: { unattended?: boolean; handoff?: boolean; automated?: boolean; answer?: (p: PurchaseInfo) => 'approve' | 'deny' } = {}) {
  const cards: PurchaseInfo[] = []
  const gate: InstanceType<typeof PurchaseGate> = new PurchaseGate({
    emit: (e: ChatEvent) => {
      if (e.type !== 'pending') return
      const req = e.request
      setTimeout(() => {
        if (req.purchase) { cards.push(req.purchase); gate.respond('t', req.id, req.purchase.nonce, o.answer?.(req.purchase) ?? 'deny', Date.now() + 1000) }
      }, 1)
    },
    runInfo: () => ({ unattended: !!o.unattended }), startedByHandoff: () => !!o.handoff, automated: () => !!o.automated
  })
  return { gate, cards }
}

const ctx = { threadId: 't', signal: new AbortController().signal } as never

describe('probe a: purchases that used to slip through', () => {
  const cases: Array<[string, string, string]> = [
    ['link', 'Buy now', 'https://shop.example/product/42'],
    ['link', 'Place order', 'https://shop.example/review'],
    ['button', 'Jetzt kaufen', 'https://www.amazon.de/dp/B0C1234'],
    ['button', 'Zahlungspflichtig bestellen', 'https://www.amazon.de/gp/buy/spc/handlers/display.html'],
    ['button', 'Acheter maintenant', 'https://shop.fr/p/1'],
    ['button', 'Comprar ahora', 'https://tienda.es/p/1'],
    ['button', 'Finalizar compra', 'https://loja.com.br/p/1'],
    ['button', 'Acquista ora', 'https://negozio.it/p/1'],
    ['button', 'Nu betalen', 'https://winkel.nl/p/1'],
    ['button', '今すぐ購入', 'https://shop.jp/p/1'],
    ['button', '立即购买', 'https://shop.cn/p/1'],
    ['button', '결제하기', 'https://shop.kr/p/1'],
    ['button', 'Confirm swap', 'https://app.uniswap.org/swap'],
    ['button', 'Send', 'https://wallet.example/send'],
    ['button', 'Get', 'https://apps.example/app/1'],
    ['button', 'Tip $20', 'https://creator.example/u/x'],
    ['button', 'Upgrade to Pro', 'https://app.example/settings/plan'],
    ['button', 'Continue', 'https://shop.example/checkouts/cn/abc']
  ]
  test.each(cases)('%s "%s" @ %s is gated as a purchase in every mode', async (role, name, url) => {
    const { fake } = fakeBrowser(role, name, url)
    const tool = browserTool(fake, vault as never, {})
    const a = { action: 'click', ref: 'e1' } as never
    const hs = tool.hardStop!(a)
    expect(hs).toMatch(new RegExp(`^${PURCHASE_STOP}`))
    // The generic check lets it through to the tool, which shows its own Purchase card (or refuses).
    for (const mode of ['ask', 'auto', 'bypass'] as const) {
      expect(decide({ mode, effect: 'write_external', tool: 'browser', alwaysAllowed: true, hardStop: hs, hardStopsEnabled: false, tainted: false, leaksSecret: false, consequential: true }).verdict).toBe('allow')
    }
    // Without anyone to approve, nothing is clicked.
    await expect(tool.run(a, ctx)).rejects.toThrow(/Purchases need you/)
    expect(fake.click).not.toHaveBeenCalled()
    // With the user there, a Purchase card asks; declining clicks nothing.
    const { gate, cards } = gateFor()
    const out = await browserTool(fake, vault as never, { gate }).run(a, ctx)
    expect(cards).toHaveLength(1)
    expect(out.text).toMatch(/did not approve/)
    expect(fake.click).not.toHaveBeenCalled()
  })

  test('links: only a real <a href> to another page is plain navigation', () => {
    const r = (name: string, extra: Record<string, unknown> = {}) => ({ backendNodeId: 1, role: 'link', name, ...extra })
    expect(clickEffect(r('Docs', { tag: 'a', href: '/docs', navLink: true }))).toBe('read')
    expect(clickEffect(r('Docs', { tag: 'a', href: '#', navLink: false }))).toBe('write_external')
    expect(clickEffect(r('Docs', { tag: 'div', navLink: false }))).toBe('write_external')
    expect(clickEffect(r('Docs'))).toBe('write_external')
    // Never a read when the label speaks of paying, ordering or sending, or names a price.
    for (const name of ['Buy now', 'Place order', 'Checkout', 'Send', 'Get it for $9.99', 'Jetzt kaufen']) expect(clickEffect(r(name, { tag: 'a', href: '/x', navLink: true }))).not.toBe('read')
    expect(clickEffect({ backendNodeId: 1, role: 'tab', name: 'Pay $5' })).toBe('write_external')
    expect(navLinkOf('a', '/docs', 'https://x.test/home')).toBe(true)
    expect(navLinkOf('a', '#top', 'https://x.test/home')).toBe(false)
    expect(navLinkOf('a', 'javascript:void(0)', 'https://x.test/home')).toBe(false)
    expect(navLinkOf('a', '/home#reviews', 'https://x.test/home')).toBe(false)
    expect(navLinkOf('span', '/docs', 'https://x.test/home')).toBe(false)
    expect(navLinkOf('a', undefined, 'https://x.test/home')).toBe(false)
  })

  test('a link that acts like a button is a purchase on a checkout page; a real link is not', () => {
    const c = (navLink: boolean, label = 'Next step') => classifyPurchase({ kind: 'click', role: 'link', label, url: 'https://shop.test/checkout', navLink }).purchase
    expect(c(false)).toBe(true)
    expect(c(true)).toBe(false)
    expect(c(true, 'Pay now')).toBe(true)
  })

  test('checkout context: plural URLs, page totals and card fields; submits, Enter and icon buttons there are purchases', () => {
    for (const u of ['/checkouts/cn/1', '/subscriptions/new', '/orders/review', '/payments/confirm', '/carts/1', '/settings/plan', '/pricing']) expect(isCheckoutUrl(`https://x.test${u}`)).toBe(true)
    expect(isCheckoutUrl('https://x.test/blog/orderly-thoughts')).toBe(false)
    const base = { kind: 'click' as const, role: 'button', url: 'https://x.test/p/1' }
    expect(classifyPurchase({ ...base, label: 'Continue' }).purchase).toBe(false)
    expect(classifyPurchase({ ...base, label: 'Continue', hasTotal: true }).purchase).toBe(true)
    expect(classifyPurchase({ ...base, label: 'Weiter', payFields: true }).purchase).toBe(true)
    expect(classifyPurchase({ ...base, label: 'Gift options', hasTotal: true, submit: true }).purchase).toBe(true)
    expect(classifyPurchase({ ...base, label: '', hasTotal: true }).purchase).toBe(true)
    expect(classifyPurchase({ kind: 'enter', label: 'Gift message', url: 'https://shop.example/order/review' }).purchase).toBe(true)
    // Still not purchases: "Add to cart" and friends, unless they name an amount on a checkout page.
    expect(classifyPurchase({ ...base, label: 'Add to cart', hasTotal: true }).purchase).toBe(false)
    expect(classifyPurchase({ ...base, label: 'Add to cart · $12.00' }).purchase).toBe(false)
    expect(classifyPurchase({ ...base, label: 'Add to cart · $12.00', url: 'https://x.test/checkout' }).purchase).toBe(true)
    // Not every foreign word counts: "continue shopping", "sort by", "order history".
    expect(classifyPurchase({ ...base, label: 'Weiter einkaufen' }).purchase).toBe(false)
    expect(classifyPurchase({ ...base, label: 'Ordina per prezzo' }).purchase).toBe(false)
    expect(classifyPurchase({ ...base, label: '注文履歴' }).purchase).toBe(false)
  })

  test('clicks are consequential unless clearly benign; type + Enter is consequential', () => {
    expect(benignClickLabel('Sign in')).toBe(true)
    expect(benignClickLabel('Add to cart')).toBe(true)
    expect(benignClickLabel('')).toBe(false)
    expect(benignClickLabel('Do the thing')).toBe(false)
    expect(benignClickLabel('Next $5')).toBe(false)
    const { fake } = fakeBrowser('button', '', 'https://shop.example/product/42')
    const tool = browserTool(fake, vault as never, {})
    expect(tool.consequential!({ action: 'click', ref: 'e1' } as never, { threadId: 't' } as never)).toBe(true)
    expect(tool.consequential!({ action: 'type', ref: 'e2', text: 'x', submit: true } as never, { threadId: 't' } as never)).toBe(true)
    expect(tool.consequential!({ action: 'type', ref: 'e2', text: 'x' } as never, { threadId: 't' } as never)).toBe(false)
    // Auto clicks by itself; what stops a purchase is the browser's own Purchase card at the click (next tests).
    // A click whose description shows money, a steered click and Ask mode still ask here.
    const click = { mode: 'auto' as const, effect: 'write_external' as const, tool: 'browser', alwaysAllowed: false, hardStop: null, hardStopsEnabled: true, tainted: false, leaksSecret: false, consequential: true }
    expect(decide(click).verdict).toBe('allow')
    expect(decide({ ...click, spends: spendsMoney('browser', 'Click "Next $5" on shop.example', null) }).verdict).toBe('ask')
    expect(decide({ ...click, tainted: true }).verdict).toBe('ask')
    expect(decide({ ...click, mode: 'ask' }).verdict).toBe('ask')
  })

  test('unattended, helper and handoff runs never click or press Enter on a page with shopping signs', async () => {
    for (const who of [{ unattended: true }, { handoff: true }]) {
      const { fake } = fakeBrowser('button', 'Gift wrap', 'https://shop.example/p/1', { ctx: () => ({ url: 'https://shop.example/p/1', total: { amount: 30, currency: 'USD', display: '$30.00' } }) })
      const { gate } = gateFor(who)
      await expect(browserTool(fake, vault as never, { gate }).run({ action: 'click', ref: 'e1' } as never, ctx)).rejects.toThrow(/Purchases need you/)
      expect(fake.click).not.toHaveBeenCalled()
    }
    // Attended, no purchase: it just clicks.
    const { fake } = fakeBrowser('button', 'Gift wrap', 'https://shop.example/p/1', { ctx: () => ({ url: 'https://shop.example/p/1', total: { amount: 30, currency: 'USD', display: '$30.00' } }) })
    await browserTool(fake, vault as never, { gate: gateFor().gate }).run({ action: 'click', ref: 'e1' } as never, ctx)
    expect(fake.click).toHaveBeenCalledTimes(1)
  })
})

describe('probe b: typing happens before the Purchase card (no TOCTOU)', () => {
  test('fill_form: the card shows the total after typing, and the fields typed', async () => {
    let qty = 1
    const url = 'https://shop.example/checkout'
    const { fake, log } = fakeBrowser('button', 'Place order', url, {
      ctx: () => ({ url, total: { amount: 20 * qty, currency: 'USD', display: `$${20 * qty}.00` }, target: { type: 'submit', submit: true } }),
      extra: { type: vi.fn(async (_r: string, t: string) => { qty = Number(t); log.push(`type ${t}`); return 'typed' }) }
    })
    const { gate, cards } = gateFor({ answer: () => 'approve' })
    const out = await browserTool(fake, vault as never, { gate }).run({ action: 'fill_form', fields: [{ ref: 'e2', text: '50' }], submit_ref: 'e1' } as never, ctx)
    expect(log).toEqual(['type 50', 'click'])
    expect(cards).toHaveLength(1)
    expect(cards[0].total?.display).toBe('$1000.00')
    expect(cards[0].typed).toEqual([{ field: 'Quantity', value: '50' }])
    expect(out.text).toContain('approved this purchase step')
  })

  test('a change after approval (total) asks again before the click', async () => {
    let n = 0
    const url = 'https://shop.example/checkout'
    const { fake, log } = fakeBrowser('button', 'Place order', url, {
      // The page re-prices once, right after the first approval.
      ctx: () => ({ url, total: { amount: n++ >= 1 ? 99 : 20, currency: 'USD', display: '' }, target: { submit: true } })
    })
    const { gate, cards } = gateFor({ answer: () => 'approve' })
    await browserTool(fake, vault as never, { gate }).run({ action: 'fill_form', fields: [{ ref: 'e2', text: '1' }], submit_ref: 'e1' } as never, ctx)
    expect(cards.length).toBe(2)
    expect(cards[1].changed).toBe(true)
    expect(log.filter((l) => l === 'click')).toHaveLength(1)
  })

  test('declining the card leaves the typed fields but never submits', async () => {
    const url = 'https://shop.example/checkout'
    const { fake, log } = fakeBrowser('button', 'Place order', url, { ctx: () => ({ url, total: { amount: 5, currency: 'USD', display: '$5.00' } }) })
    const { gate } = gateFor({ answer: () => 'deny' })
    await browserTool(fake, vault as never, { gate }).run({ action: 'fill_form', fields: [{ ref: 'e2', text: '1' }], submit_ref: 'e1' } as never, ctx)
    expect(log).toEqual(['type 1'])
  })
})

describe('probe c: Enter on an order review page', () => {
  test('type + submit is a purchase step there: typed first, Enter only after the card', async () => {
    const url = 'https://shop.example/order/review'
    const { fake, log } = fakeBrowser('textbox', 'Gift message', url, { ctx: () => ({ url, target: { tag: 'input', type: 'text', submit: true } }) })
    fake.refInfo = (r: string) => (r === 'e2' ? { backendNodeId: 2, role: 'textbox', name: 'Gift message' } : undefined)
    const tool = browserTool(fake, vault as never, {})
    const a = { action: 'type', ref: 'e2', text: 'Happy birthday', submit: true } as never
    expect(tool.hardStop!(a)).toMatch(new RegExp(`^${PURCHASE_STOP}`))
    const { gate, cards } = gateFor({ answer: () => 'approve' })
    await browserTool(fake, vault as never, { gate }).run(a, ctx)
    expect(log).toEqual(['type Happy birthday', 'enter'])
    expect(cards).toHaveLength(1)
    expect(cards[0].action).toMatch(/Press Enter/)
    expect(cards[0].typed).toEqual([{ field: 'Gift message', value: 'Happy birthday' }])
  })
})

describe('probe d: one-time codes', () => {
  function otpSetup(o: { sms: Array<{ from: string; text: string; at: number }>; url?: string; answer?: 'approve' | 'always' | 'deny' }) {
    let unattended = false
    let grants: string[] = []
    let senders: Record<string, string[]> = {}
    const cards: any[] = []
    const gate: InstanceType<typeof PurchaseGate> = new PurchaseGate({
      emit: (e: ChatEvent) => { if (e.type === 'pending' && e.request.otp) { cards.push(e.request.otp); setTimeout(() => gate.respond('t', e.request.id, e.request.otp!.nonce, o.answer ?? 'approve', Date.now() + 1000), 1) } },
      runInfo: () => ({ unattended }), startedByHandoff: () => false,
      otpGrants: { get: () => grants, set: (g) => { grants = g } }, otpSenders: { get: () => senders, set: (v) => { senders = v } }
    })
    const filled: string[] = []
    const url = o.url ?? 'https://login.bank.example/2fa'
    const fake: any = { pageUrl: () => url, refInfo: () => undefined, commerce: () => ({}), tabKey: () => 1, offeredDownloads: () => [], ensureRef: async (r: string) => ({ ref: r }), takeBlockedCard: () => [], hiddenValues: () => [], humanCheck: async () => null, fillOtp: async (c: string) => { filled.push(c); return { filled: true } }, showToUser: () => {} }
    const tool = browserTool(fake, vault as never, { gate, sms: async () => o.sms })
    return { tool, gate, cards, filled, grants: () => grants, setUnattended: (v: boolean) => { unattended = v } }
  }

  test('a chat grant does not carry into a later unattended run in the same chat', async () => {
    const s = otpSetup({ sms: [{ from: 'alerts@bank.example', text: 'Your code is 123456', at: Date.now() }] })
    await s.tool.run({ action: 'fill_otp', source: 'sms' } as never, ctx)
    expect(s.filled).toEqual(['123456'])
    s.setUnattended(true)
    expect(s.gate.otpRefusal('t', 'https://login.bank.example')).toMatch(/One-time codes need you/)
    expect(s.gate.otpAllowed('t', 'https://login.bank.example')).toBe(false)
    await expect(s.tool.run({ action: 'fill_otp', source: 'sms' } as never, ctx)).rejects.toThrow(/One-time codes need you/)
    expect(s.filled).toHaveLength(1)
  })

  test('runs started by automation (goal, app) never use chat grants', () => {
    let automated = false
    const gate = new PurchaseGate({ emit: () => undefined, runInfo: () => ({}), startedByHandoff: () => false, automated: () => automated })
    ;(gate as any).chatGrants.set('t', new Set(['https://bank.example']))
    expect(gate.otpAllowed('t', 'https://bank.example')).toBe(true)
    automated = true
    expect(gate.otpAllowed('t', 'https://bank.example')).toBe(false)
    expect(gate.otpRefusal('t', 'https://bank.example')).toMatch(/One-time codes need you/)
  })

  test('grants are per origin: http and https, and other hosts, are different sites', () => {
    expect(otpSiteKey('bank.example')).toBe('https://bank.example')
    expect(otpSiteKey('https://bank.example/login')).toBe('https://bank.example')
    let grants = ['bank.example']
    const gate = new PurchaseGate({ emit: () => undefined, runInfo: () => undefined, startedByHandoff: () => false, otpGrants: { get: () => grants, set: (g) => { grants = g } } })
    expect(gate.otpAllowed('t', 'https://bank.example')).toBe(true)
    expect(gate.otpAllowed('t', 'http://bank.example')).toBe(false)
    expect(gate.otpAllowed('t', 'https://evil.bank.example')).toBe(false)
  })

  test('a lookalike site never gets another site\'s code without the user seeing the sender', async () => {
    const now = Date.now()
    const msgs = [{ from: '+1 555 0100', text: 'Your MyBank verification code is 482913. Do not share it.', at: now }]
    // No unmatched single-code fallback.
    expect(pickCode(msgs, 'secure-login-portal.com', now - 60_000)).toBeNull()
    // The card shows the sender and a snippet with the code hidden, flagged as an unverified sender.
    const s = otpSetup({ sms: msgs, url: 'https://secure-login-portal.com/verify', answer: 'deny' })
    const out = await s.tool.run({ action: 'fill_otp', source: 'sms' } as never, ctx)
    expect(out.text).toMatch(/didn't allow/)
    expect(s.filled).toHaveLength(0)
    expect(s.cards[0]).toMatchObject({ site: 'https://secure-login-portal.com', sender: '+1 555 0100', unverifiedSender: true })
    expect(s.cards[0].snippet).toContain('••••••')
    expect(s.cards[0].snippet).not.toContain('482913')
  })

  test('a sender confirmed with "Always" is remembered for that site; unattended runs still need a domain match or that confirmation', async () => {
    const now = Date.now()
    const msgs = [{ from: '+1 555 0100', text: 'Bank code 482913', at: now }]
    const s = otpSetup({ sms: msgs, answer: 'always' })
    await s.tool.run({ action: 'fill_otp', source: 'sms' } as never, ctx)
    expect(s.filled).toEqual(['482913'])
    expect(s.gate.confirmedSenders('t', 'https://login.bank.example')).toEqual(['15550100'])
    s.setUnattended(true)
    await s.tool.run({ action: 'fill_otp', source: 'sms' } as never, ctx)
    expect(s.filled).toHaveLength(2)
    expect(s.cards).toHaveLength(1)
  })

  test('PSL: chase.com.ve is not chase.com, and private suffixes are separate sites', () => {
    expect(domainOf('secure.chase.com.ve')).toBe('chase.com.ve')
    expect(brandOf('chase.com.ve')).toBe('chase')
    const now = Date.now()
    const msgs = [{ from: 'Chase <no-reply@chase.com>', text: 'Chase: Your one-time code is 112233', at: now }, { from: 'Other', text: 'Your code is 999999', at: now - 1000 }]
    expect(pickCode(msgs, 'secure.chase.com.ve', now - 60_000)).toBeNull()
    expect(pickCode(msgs, 'secure.chase.com', now - 60_000)?.code).toBe('112233')
    expect(codeCandidate(msgs, 'secure.chase.com.ve', now - 60_000)?.code).toBe('112233')
    expect(senderDomain('Acme <no-reply@mail.acme.co.uk>')).toBe('acme.co.uk')
    expect(codeSnippet('Your code is 123 456 for Acme', '123456')).toBe('Your code is •••••• for Acme')
  })
})

describe('Public Suffix List', () => {
  test.each([
    ['shop.example.co.uk', 'example.co.uk'], ['a.b.example.com.au', 'example.com.au'], ['www.chase.com.ve', 'chase.com.ve'],
    ['alice.github.io', 'alice.github.io'], ['x.alice.github.io', 'alice.github.io'], ['my-app.vercel.app', 'my-app.vercel.app'],
    ['bucket.s3.amazonaws.com', 'bucket.s3.amazonaws.com'], ['bucket.s3.us-west-2.amazonaws.com', 'bucket.s3.us-west-2.amazonaws.com'],
    ['site.netlify.app', 'site.netlify.app'], ['app.herokuapp.com', 'app.herokuapp.com'], ['x.pages.dev', 'x.pages.dev'],
    ['p.web.app', 'p.web.app'], ['p.firebaseapp.com', 'p.firebaseapp.com'], ['b.blogspot.com', 'b.blogspot.com'], ['w.azurewebsites.net', 'w.azurewebsites.net'],
    ['www.shop.co.jp', 'shop.co.jp'], ['loja.com.br', 'loja.com.br'], ['login.example.com', 'example.com'], ['localhost', 'localhost'], ['127.0.0.1', '127.0.0.1'],
    ['github.io', ''], ['co.uk', ''], ['https://Login.Example.COM:8443/x', 'example.com']
  ])('%s → %s', (host, reg) => {
    expect(registrableDomain(host)).toBe(reg)
  })
  test('suffix helpers', () => {
    expect(publicSuffix('a.b.co.uk')).toBe('co.uk')
    expect(publicSuffix('example.dev')).toBe('dev')
    expect(isPublicSuffix('vercel.app')).toBe(true)
    expect(isPublicSuffix('example.com')).toBe(false)
    expect(sameSite('a.example.com', 'b.example.com')).toBe(true)
    expect(sameSite('alice.github.io', 'bob.github.io')).toBe(false)
    expect(sameSite('chase.com', 'chase.com.ve')).toBe(false)
  })
})

describe('saved logins: exact origin by default', () => {
  test('never across a public suffix, and subdomains only when opted in', () => {
    expect(originMatches('https://github.io', 'https://attacker.github.io/login')).toBe(false)
    expect(originMatches('https://github.io', 'https://attacker.github.io/login', { subdomains: true })).toBe(false)
    expect(originMatches('https://google.com', 'https://sites.google.com/view/x')).toBe(false)
    expect(originMatches('https://google.com', 'https://accounts.google.com/x', { subdomains: true })).toBe(true)
    expect(originMatches('https://vercel.app', 'https://evil.vercel.app', { subdomains: true })).toBe(false)
    expect(originMatches('https://example.co.uk', 'https://login.example.co.uk', { subdomains: true })).toBe(true)
    expect(originMatches('https://example.com', 'https://example.com.evil.io', { subdomains: true })).toBe(false)
  })
})

describe('card leak check', () => {
  const card = '4242424242424242'
  test('finds a saved number however it is written: grouped, split across fields, URL-encoded, base64', () => {
    expect(containsCard('n=4242 4242 4242 4242', [card])).toBe(true)
    expect(containsCard('{"a":"4242","b":"4242","c":"4242","d":"4242"}', [card])).toBe(true)
    expect(containsCard('x=4242%204242%204242%204242', [card])).toBe(true)
    expect(containsCard(`payload=${Buffer.from(JSON.stringify({ pan: card })).toString('base64')}`, [card])).toBe(true)
    expect(containsCard(`p=${Buffer.from(`card:${card}`).toString('base64url')}`, [card])).toBe(true)
    expect(containsCard('total=42.42&qty=4', [card])).toBe(false)
    expect(containsCard(`p=${card}`, [])).toBe(false)
  })
})

describe('computer use never drives SahilBot itself', () => {
  const self = { pids: [100, 101], names: ['SahilBot', 'Electron'], bundleIds: ['app.sahilbot.desktop'], titles: ['SahilBot'], rects: [{ x: 1000, y: 0, width: 300, height: 200 }] }
  test('by pid, app name, bundle id, window title (app unknown) or a point on its windows', () => {
    expect(selfTarget(self, { pid: 101 })).toMatch(/SahilBot/)
    expect(selfTarget(self, { app: 'sahilbot' })).toMatch(/SahilBot/)
    expect(selfTarget(self, { bundleId: 'app.sahilbot.desktop' })).toMatch(/SahilBot/)
    expect(selfTarget(self, { window: 'SahilBot' })).toMatch(/SahilBot/)
    expect(selfTarget(self, { app: 'Finder', window: 'SahilBot' })).toBeNull()
    expect(selfTarget(self, { point: { x: 1100, y: 50 } })).toMatch(/SahilBot/)
    expect(selfTarget(self, { app: 'Notes', pid: 5, point: { x: 10, y: 10 } })).toBeNull()
    expect(selfTarget(undefined, { app: 'SahilBot' })).toBeNull()
  })
  test('the tool refuses before doing anything', async () => {
    const enterMini = vi.fn()
    const tool = computerTool({ enterMini, capture: vi.fn() as never, trusted: () => true, self: () => self })
    const c = { threadId: 't', signal: new AbortController().signal, state: {} } as never
    await expect(tool.run({ action: 'click', x: 1100, y: 50, coords: 'screen' } as never, c)).rejects.toThrow(/never clicks, types into or drives SahilBot/)
    await expect(tool.run({ action: 'activate_app', app: 'SahilBot' } as never, c)).rejects.toThrow(/SahilBot itself/)
    await expect(tool.run({ action: 'open_app', app: 'Electron' } as never, c)).rejects.toThrow(/SahilBot itself/)
    expect(enterMini).not.toHaveBeenCalled()
  })
})
