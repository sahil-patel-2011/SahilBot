import { describe, expect, test, vi } from 'vitest'
const { browserTool } = await import('../../src/main/agent/tools/browser')

// Review round 3 (RWB-02): a CAPTCHA on a site SahilBot only reads (research) is a bot wall: it moves on to another
// source with no hand-over card. On a site where it typed, filled, signed in or went to buy, the check is the user's.
function fakeBrowser() {
  const state = { url: 'about:blank' }
  const fake: any = {
    refInfo: (r: string) => ({ backendNodeId: 1, role: 'combobox', name: r === 'e9' ? 'Travelers' : 'Field' }),
    pageUrl: () => state.url, pageTitle: () => 'Page', pendingDialog: null, teach: { state: () => undefined },
    commerce: () => ({ payFields: 0, payFilled: false }), tabKey: () => 1, offeredDownloads: () => [], ensureRef: async (ref: string) => ({ ref }),
    takeBlockedCard: () => [], takeCardLeaks: () => [], hiddenValues: () => [],
    humanCheck: vi.fn(async () => 'CAPTCHA'), showToUser: vi.fn(),
    expectation: () => ({ tab: 1, origin: state.url.startsWith('http') ? new URL(state.url).origin : '' }),
    navigate: vi.fn(async (url: string) => { state.url = url; return `Opened ${url}` }),
    select: vi.fn(async () => 'chose 2'),
    getText: vi.fn(async () => 'text')
  }
  return { fake, state }
}

const ctx = (waitForUser: ReturnType<typeof vi.fn>) => ({ threadId: 't1', waitForUser, askUser: vi.fn(async () => 'Skip') }) as never

describe('human checks: bot wall in research, hand-over in sign-in or purchase', () => {
  test('a CAPTCHA on a page it only reads: no panel, no card, a note to use another source', async () => {
    const { fake } = fakeBrowser()
    const tool = browserTool(fake, {} as never)
    const wait = vi.fn(async () => 'Done')
    const out = await tool.run({ action: 'navigate', url: 'https://www.expedia.com/Hotels' } as never, ctx(wait))
    expect(wait).not.toHaveBeenCalled()
    expect(fake.showToUser).not.toHaveBeenCalled()
    expect(out.text).toMatch(/bot wall\. Don't wait or ask the user; use another result from web_search/)
  })

  test('after filling something on that site, the check is handed to the user', async () => {
    const { fake, state } = fakeBrowser()
    const tool = browserTool(fake, {} as never)
    const wait = vi.fn(async () => 'Skip')
    state.url = 'https://www.expedia.com/Hotels'
    await tool.run({ action: 'select', ref: 'e9', option: '2' } as never, ctx(wait))
    await tool.run({ action: 'navigate', url: 'https://www.expedia.com/Checkout' } as never, ctx(wait))
    expect(wait).toHaveBeenCalledTimes(1)
    expect(fake.showToUser).toHaveBeenCalled()
  })

  test('a site the user named in the request is theirs to get through: the check is handed over', async () => {
    const { fake } = fakeBrowser()
    const tool = browserTool(fake, {} as never, { userText: () => 'Open expedia.com/Hotels and find a room' })
    const wait = vi.fn(async () => 'Done')
    await tool.run({ action: 'navigate', url: 'https://www.expedia.com/Hotels' } as never, ctx(wait))
    expect(wait).toHaveBeenCalledTimes(1)
    expect(fake.showToUser).toHaveBeenCalled()
  })
})
