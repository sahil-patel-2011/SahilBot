import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { lastToolOutput, refFor, startMockLlm, type MockLlm, type ScriptedReply } from '../fixtures/mock-llm'
import { startTestSite, type TestSite } from '../fixtures/test-site'

// Planner ⇄ Executor computer use, end to end in the hidden app: the mock model server plays both models (the
// planner on llama3.3:70b, the executor on qwen3.8:27b), the executor drives the in-app browser on a local test
// site, disagrees once with the plan (the screen has no "Billing" topic), the planner revises, and its done check
// passes. Nothing here controls the real screen: the browser is SahilBot's own (hidden) web view.

const browser = (args: Record<string, unknown>): ScriptedReply => ({ toolCalls: [{ name: 'browser', arguments: JSON.stringify(args) }], delay: 0 })
const checkpoint = (args: Record<string, unknown>): ScriptedReply => ({ toolCalls: [{ name: 'checkpoint', arguments: JSON.stringify(args) }], delay: 0 })
const planner = (json: Record<string, unknown>): ScriptedReply => ({ content: JSON.stringify(json), delay: 0 })
/** The latest browser snapshot of the contact form in a request. */
const formSnap = (req: Record<string, any>): string => String([...req.messages].reverse().find((m: any) => m.role === 'tool' && String(m.content).includes('Page: "Contact')).content)

describe('computer use: planner + executor', () => {
  let llm: MockLlm
  let site: TestSite
  beforeAll(async () => { [llm, site] = await Promise.all([startMockLlm(), startTestSite()]) })
  afterAll(async () => { await Promise.all([llm.close(), site.close()]) })

  test('plan → execute → disagreement → revised plan → done check, with both models on one timeline', async () => {
    // Two local models on the mock server: the bigger one plans, the smaller one executes.
    llm.models = ['qwen3.8:27b', 'qwen3.5:9b']
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64' })
    await page.evaluate(() => window.foreman.settings.set({ computerUse: { mode: 'pair', executor: 'qwen3.5:9b', planner: 'qwen3.8:27b' } } as never))

    llm.script.push(
      // Planner: the plan (two checkpoints; the second names a topic the form doesn't have).
      planner({ summary: 'Fill in the Acme contact form without sending it', constraints: ["don't send the form"], checkpoints: [
        { goal: 'The Acme contact form is open', success: 'The "Contact us" page shows the name, message and topic fields' },
        { goal: 'Name, message and topic Billing filled in', success: 'Your name: Sam Rivera, Message: Need a quote for 40 seats, Topic: Billing; not sent' }
      ] }),
      // Executor: open the form, look, report checkpoint 1 done.
      browser({ action: 'navigate', url: `${site.url}/quote` }),
      browser({ action: 'snapshot' }),
      checkpoint({ status: 'done', checkpoint: 1, sees: 'Contact us page with Your name, Message and Topic', evidence: 'The three fields are on the page' }),
      // Planner: next.
      planner({ action: 'next', message: 'Fill in the name and message, and set Topic to Billing.' }),
      // Executor: the screen contradicts the plan.
      checkpoint({ status: 'disagree', reason: 'contradicts_screen', sees: 'Topic offers only Sales and Support', why: 'There is no Billing topic on this form', suggestion: 'Use Sales: a quote request is a sales question' }),
      // Planner: agrees and revises.
      planner({ action: 'revise', verdict: 'agree', message: 'Right, there is no Billing. Use Sales.', plan: { checkpoints: [{ goal: 'Name, message and topic Sales filled in', success: 'Your name: Sam Rivera, Message: Need a quote for 40 seats, Topic: Sales; not sent' }] } }),
      // Executor: fills the form (no send).
      (req) => browser({ action: 'type', ref: refFor(formSnap(req), 'textbox', 'Your name'), text: 'Sam Rivera' }),
      (req) => browser({ action: 'type', ref: refFor(formSnap(req), 'textbox', 'Message'), text: 'Need a quote for 40 seats' }),
      (req) => browser({ action: 'select', ref: refFor(formSnap(req), 'combobox', 'Topic'), option: 'Sales' }),
      browser({ action: 'snapshot' }),
      (req) => checkpoint({ status: 'done', sees: lastToolOutput(req).includes('Sam Rivera') ? 'Name Sam Rivera, message filled, Topic Sales, not sent' : 'fields filled', evidence: 'All three fields show the values' }),
      // Planner: the final done check passes.
      planner({ action: 'finish', message: 'Name, message and Sales topic are filled in and the form was not sent.' }),
      { content: 'The contact form is filled in (Sam Rivera, "Need a quote for 40 seats", topic Sales). I did not send it.', delay: 0 }
    )
    await page.fill('[data-testid="composer-input"]', `Go to the website ${site.url}/quote and fill in the contact form: my name is Sam Rivera, the message is "Need a quote for 40 seats", topic Billing. Don't send it.`)
    await page.keyboard.press('Enter')
    await expect.poll(() => llm.script.length, { timeout: 45_000 }).toBe(0).catch((e) => {
      for (const r of llm.requests) console.log('REQ', r.model, (r.tools ?? []).length, JSON.stringify(r.messages.at(-1)).slice(0, 400))
      throw e
    })
    await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 20_000 }).toBe(0)

    // The planner's requests went to the planner model with no tools; every other request was the executor's.
    const plannerReqs = llm.requests.filter((r) => r.model === 'qwen3.8:27b')
    const executorReqs = llm.requests.filter((r) => r.model === 'qwen3.5:9b')
    expect(plannerReqs).toHaveLength(4)
    expect(plannerReqs.every((r) => !r.tools?.length)).toBe(true)
    expect(executorReqs.length).toBe(llm.requests.length - 4)
    expect((executorReqs[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(expect.arrayContaining(['browser', 'checkpoint']))
    // The planner saw the executor's disagreement, and the executor got the revised plan back.
    expect(JSON.stringify(plannerReqs[2].messages)).toContain('There is no Billing topic on this form')
    const revised = String(executorReqs.find((r) => JSON.stringify(r.messages).includes('revised the plan'))?.messages.filter((m: any) => m.role === 'tool').at(-1).content)
    expect(revised).toMatch(/revised the plan[\s\S]*topic Sales/)

    // Not sent: the form never reached the server.
    expect(site.submissions).toEqual([])

    // One "Planner ⇄ Executor" card in the chat with both models' messages, the disagreement and the done check.
    const card = page.locator('[data-testid="cua-card"]')
    await expect.poll(() => card.count()).toBe(1)
    await expect.poll(() => page.locator('[data-testid="cua-state"]').innerText()).toMatch(/^Done · 2 of 2/)
    const kinds = await page.locator('[data-testid="cua-entry"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-who')}:${e.getAttribute('data-kind')}`))
    expect(kinds).toEqual(expect.arrayContaining(['planner:plan', 'executor:report', 'executor:disagree', 'planner:revise', 'planner:finish']))
    expect(kinds.indexOf('executor:disagree')).toBeLessThan(kinds.indexOf('planner:revise'))
    expect(await card.innerText()).toMatch(/Qwen3\.8 27B[\s\S]*plans[\s\S]*executes/i)
    expect(await page.locator('[data-testid="assistant-bubble"]').last().innerText()).toContain('I did not send it')
    await app.close()
  })
})
