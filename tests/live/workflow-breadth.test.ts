import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { launch } from '../accept/app'

const path = process.env.SAHILBOT_CODEX_PATH
const cases = [
  {
    name: 'code',
    output: 'test_summary.json',
    seed: {
      'price.py': 'def total_cents(price_cents, quantity, discount_percent):\n    return int(price_cents * quantity * (100 - discount_percent) / 100)\n',
      'check.py': 'from price import total_cents\nassert total_cents(101, 1, 50) == 51\nassert total_cents(299, 3, 15) == 762\nassert total_cents(123, 0, 0) == 0\nprint("3 checks passed")\n'
    },
    prompt: 'In this synthetic workspace, repair price.py so total_cents rounds half up to the nearest cent using integer arithmetic. Preserve the function name and arguments. Read and run the existing check.py without editing it. Save test_summary.json with only {"checks_passed":3,"rounding":"half_up"} if the checks succeed, and return the same JSON in chat. Use only the workspace and no connected apps.',
    expected: { checks_passed: 3, rounding: 'half_up' }
  },
  {
    name: 'office',
    output: 'meeting.json',
    prompt: 'Turn the synthetic meeting notes into a handoff. Alex owns the test matrix, due Dec 3. Priya owns the demo script, due Dec 5. The team decided to use the acrylic enclosure. Purchasing the enclosure is only proposed. An idea to rewrite the landing page has no owner or commitment. Save meeting.json and show the same object in chat. Use exactly the keys decisions (array of strings; use "acrylic enclosure"), actions (array of {owner, task, due} in due date order; task is "test matrix" or "demo script"; ISO dates in 2026), and unresolved (array of strings "enclosure purchase" and "landing page rewrite" in the order mentioned). Do not use connected apps.',
    expected: { decisions: ['acrylic enclosure'], actions: [{ owner: 'Alex', task: 'test matrix', due: '2026-12-03' }, { owner: 'Priya', task: 'demo script', due: '2026-12-05' }], unresolved: ['enclosure purchase', 'landing page rewrite'] }
  },
  {
    name: 'electrical engineering',
    output: 'resistor.json',
    prompt: 'Use only these synthetic specs for a low-voltage series LED circuit. Supply 4.75–5.25 V, LED forward voltage 1.8–2.2 V, target 6–10 mA at all specified corners. Choose from 330, 390 and 470 ohms, all ±5%. Compute each option at worst cases, verify units, and identify the only one that meets the targets. Save resistor.json and return the same JSON with chosen_ohms, minimum_ma and maximum_ma for that option rounded to 2 decimals, and rejected_ohms as an ascending number array. Do not browse or order anything.',
    expected: { chosen_ohms: 390, minimum_ma: 6.23, maximum_ma: 9.31, rejected_ohms: [330, 470] }
  },
  {
    name: 'browser reviews and travel',
    output: 'dinner.json',
    page: '<h1>Saturday dinner reviews — synthetic fixture</h1><h2>Harbor Table</h2><p>Open Saturday, step-free entrance, dinner $27. Recent reviews praise quiet seating; two mention slow service.</p><h2>Juniper House</h2><p>Open Saturday, step-free entrance, dinner $34. Reviews praise the sea view.</p><h2>Rail Stop</h2><p>Open Saturday, dinner $22; stairs only. Reviews praise fast service.</p>',
    prompt: 'Use the built-in browser to read the synthetic fixture at {url}. Pick a Saturday dinner spot for a trip that is step-free and $30 or less. Use the latest review notes. Save dinner.json and return the same JSON with keys restaurant, price_usd, praise, caveat. Keep praise and caveat to the short exact phrases from the source. Do not book anything or use any other site.',
    expected: { restaurant: 'Harbor Table', price_usd: 27, praise: 'quiet seating', caveat: 'slow service' }
  },
  {
    name: 'vacation itinerary',
    output: 'vacation.json',
    page: '<h1>Weekend timetable — synthetic fixture</h1><p>Saturday train arrives 11:35. Hotel bag drop is from 12:00. The Harbor Ferry leaves 12:15 from the hotel pier, a 5-minute walk. The history museum is open Sunday 09:00–16:00, $14. The aquarium opens Sunday at 11:00, $23. The Sunday train leaves 13:00, a 20-minute walk from either attraction. Allow 20 minutes at the station.</p>',
    prompt: 'Read the synthetic vacation timetable with the built-in browser at {url}. Make a two-day plan with the ferry after the hotel bag drop on Saturday and one Sunday attraction that costs at most $20 and is open at 09:30. For Sunday, compute the latest time they can leave the attraction and meet the train buffer. Use exact names Harbor Ferry and history museum and 24-hour times. Save vacation.json and return the same JSON with keys saturday_activity, saturday_departure, sunday_activity, sunday_visit, latest_leave, sunday_cost_usd. Do not book or use any other site.',
    expected: { saturday_activity: 'Harbor Ferry', saturday_departure: '12:15', sunday_activity: 'history museum', sunday_visit: '09:30', latest_leave: '12:20', sunday_cost_usd: 14 }
  }
]

describe.skipIf(!process.env.SAHILBOT_LIVE_WORKFLOWS || !path)('cloud workflow breadth', () => {
  test.concurrent.each(cases)('$name produces and verifies its deliverable', async (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'sahilbot-live-breadth-'))
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    for (const [name, contents] of Object.entries(scenario.seed ?? {})) writeFileSync(join(workspace, name), contents)
    const html = scenario.page
    const server = html ? createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html) }) : undefined
    if (server) await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    const address = server?.address()
    const prompt = scenario.prompt.replace('{url}', address && typeof address === 'object' ? `http://127.0.0.1:${address.port}/` : '')
    let app: Awaited<ReturnType<typeof launch>>['app'] | undefined
    try {
      const setup = await launch(join(dir, 'profile'), '', {
        SAHILBOT_CODEX_PATH: path!, SAHILBOT_QUIET: '1', SAHILBOT_EPHEMERAL_PLAN_THREADS: '1', FOREMAN_NO_BRAIN: '', FOREMAN_NO_VERIFY: '',
        SAHILBOT_KNOWLEDGE: '0', SAHILBOT_LEARNING: '0'
      })
      app = setup.app
      const result = await setup.page.evaluate(async ([folder, text]) => {
        await window.foreman.settings.set({ workspaceDir: folder, local: { enabled: false }, defaultModel: 'auto' })
        await window.foreman.chatgptPlan.connect({ signIn: false })
        const ids = (await window.foreman.models.list()).models.map((model) => model.id)
        if (!ids.length || ids.some((id) => !id.startsWith('chatgpt-plan/'))) throw new Error('The benchmark requires a ChatGPT plan and local models off.')
        const { threadId } = await window.foreman.spaces.create({ name: 'Workflow benchmark', intro: false })
        const status = await new Promise<string>((resolve, reject) => {
          const dispose = () => { clearTimeout(timer); unlisten() }
          const unlisten = window.foreman.chat.onEvent((event) => {
            if (event.threadId !== threadId || event.type !== 'run' || event.status === 'started') return
            dispose()
            resolve(event.status)
          })
          const timer = setTimeout(() => { dispose(); reject(new Error('Benchmark exceeded its time budget.')) }, 210_000)
          void window.foreman.chat.send({ threadId, text }).catch((error) => { dispose(); reject(error) })
        })
        const messages = await window.foreman.threads.messages(threadId)
        return {
          status,
          answer: messages.findLast((message) => message.role === 'assistant' && message.content && !message.meta?.superseded)?.content ?? '',
          tools: messages.filter((message) => message.role === 'tool' && message.meta?.status === 'ok').map((message) => message.toolName)
        }
      }, [workspace, prompt])
      expect(result.status, result.answer).toBe('finished')
      const { answer } = result
      expect(JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))).toEqual(scenario.expected)
      expect(JSON.parse(readFileSync(join(workspace, scenario.output), 'utf8'))).toEqual(scenario.expected)
      if (scenario.seed) {
        expect(readFileSync(join(workspace, 'check.py'), 'utf8')).toBe(scenario.seed['check.py'])
        expect(result.tools).toContain('run_command')
      }
      if (scenario.page) expect(result.tools).toContain('browser')
    } finally {
      await app?.close()
      if (server) await new Promise<void>((ok) => server.close(() => ok()))
    }
  })
})
