import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { launch } from '../accept/app'

const codexPath = process.env.SAHILBOT_CODEX_PATH
const cases = [
  {
    file: 'reconciliation.json',
    prompt: `Run this benchmark using only the synthetic data below. Do not access accounts, browse the web, or send messages. Reconcile a warehouse ledger in listed row order. Apply APPROVED rows only. Record a repeated ID as a duplicate without applying it twice. Reject an approved ship or transfer when the source has insufficient stock at that row, and continue processing later rows. Starting inventory: North A=12 B=7 C=0; South A=3 B=8 C=9. Rows (id,status,operation,item,units,location):
T1,APPROVED,TRANSFER,A,5,North to South
T1,APPROVED,TRANSFER,A,5,North to South
T2,APPROVED,SHIP,B,4,South
T3,PENDING,RECEIVE,C,6,North
T4,APPROVED,SHIP,C,10,South
T5,APPROVED,RECEIVE,C,2,South
T6,APPROVED,SHIP,C,10,South
T7,APPROVED,TRANSFER,B,3,South to North
T8,APPROVED,RECEIVE,A,4,North
Return exactly one JSON object with fields north, south, totals, net_change, applied, duplicates, pending, rejected. The first four fields are objects keyed A, B and C. The rest are arrays of IDs in row order. Also save the exact JSON as reconciliation.json in your test workspace and report it in chat. Use a temporary file location if your environment has no designated workspace. Check the arithmetic independently before finishing.`,
    expected: { north: { A: 11, B: 10, C: 0 }, south: { A: 8, B: 1, C: 1 }, totals: { A: 19, B: 11, C: 1 }, net_change: { A: 4, B: -4, C: -8 }, applied: ['T1', 'T2', 'T5', 'T6', 'T7', 'T8'], duplicates: ['T1'], pending: ['T3'], rejected: ['T4'] }
  },
  {
    file: 'rover.json',
    prompt: 'Use only the synthetic data in this prompt, with no web, connected accounts, or messaging. A rover can carry up to 12 kg and work up to 8 hours. Select a subset of jobs to maximize total value. If tied, prefer fewer hours, then less weight, then lexicographically earliest sorted array of selected IDs. Each row is ID,hours,kg,value: A,2,6,7; B,2,4,8; C,3,2,9; D,4,4,13; E,1,4,6; F,2,1,5; G,1,3,4; H,2,5,9. C requires A, E requires B, H requires F, and D and G cannot both be selected. Check all possible subsets with a short local calculation before you finish. Return and save rover.json as one JSON object with keys selected (sorted array), hours, kg, value, and other_max_value_subsets (array of sorted ID arrays for every other feasible subset that ties the winning value before applying the tiebreakers). Save the file in your test workspace or a temporary directory and show the JSON in chat.',
    expected: { selected: ['B', 'D', 'E'], hours: 7, kg: 12, value: 27, other_max_value_subsets: [['D', 'F', 'H']] }
  },
  {
    file: 'routes.json',
    prompt: 'Use this synthetic directed route map only. Never browse, use connected accounts, or send messages. Edges are S→A 2, S→B 2, S→C 5, A→C 1, B→C 1, A→T 5 (closed in every scenario), B→T 5, C→T 3, A→B 1, C→A 1, C→B 1, S→T 6. Find the lowest-cost simple path from S to T. Break ties by fewest edges, then by the alphabetical order of the node sequences. Check three independent scenarios: normal (only A→T closed), direct_closed (also close S→T), and two_closed (also close S→T and C→T). Return one JSON object with keys normal, direct_closed, two_closed. Each value has keys path (array of node labels), cost (number), and alternatives (arrays of node labels for all other paths with the same minimum cost before applying tiebreakers, sorted alphabetically). Check the results independently, save that exact JSON as routes.json in your workspace, and show it in chat.',
    expected: { normal: { path: ['S', 'T'], cost: 6, alternatives: [['S', 'A', 'C', 'T'], ['S', 'B', 'C', 'T']] }, direct_closed: { path: ['S', 'A', 'C', 'T'], cost: 6, alternatives: [['S', 'B', 'C', 'T']] }, two_closed: { path: ['S', 'B', 'T'], cost: 7, alternatives: [] } }
  }
]

describe.skipIf(!process.env.SAHILBOT_LIVE_DELIVERABLES || !codexPath)('live ChatGPT plan deliverables', () => {
  test.each(cases)('the chat answer and the saved artifact match for $file', async ({ file, prompt, expected }) => {
    const dir = mkdtempSync(join(tmpdir(), 'sahilbot-live-deliverables-'))
    const workspace = join(dir, 'workspace')
    mkdirSync(workspace)
    const { app, page } = await launch(join(dir, 'profile'), '', {
      SAHILBOT_CODEX_PATH: codexPath!, SAHILBOT_QUIET: '1', SAHILBOT_EPHEMERAL_PLAN_THREADS: '1',
      FOREMAN_BASE_URL: '', FOREMAN_NO_BRAIN: '', FOREMAN_NO_VERIFY: '',
      SAHILBOT_KNOWLEDGE: '0', SAHILBOT_LEARNING: '0'
    })
    try {
      const { local, modelIds } = await page.evaluate(async (folder) => {
        await window.foreman.settings.set({ workspaceDir: folder, defaultModel: 'auto', local: { enabled: false } })
        await window.foreman.chatgptPlan.setPrefs({ preferPlan: true })
        await window.foreman.chatgptPlan.connect({ signIn: false })
        return {
          local: (await window.foreman.settings.get()).local?.enabled,
          modelIds: (await window.foreman.models.list()).models.map((model) => model.id)
        }
      }, workspace)
      expect(local).toBe(false)
      expect(modelIds).not.toHaveLength(0)
      expect(modelIds.every((id) => id.startsWith('chatgpt-plan/'))).toBe(true)

      const result = await page.evaluate(async (text) => {
        const { threadId } = await window.foreman.spaces.create({ name: 'Synthetic benchmark', intro: false })
        const status = await new Promise<string>((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); unlisten() }
          const unlisten = window.foreman.chat.onEvent((event) => {
            if (event.threadId !== threadId || event.type !== 'run' || event.status === 'started') return
            cleanup()
            resolve(event.status)
          })
          const timer = setTimeout(() => { cleanup(); reject(new Error('The benchmark exceeded 200 seconds.')) }, 200_000)
          void window.foreman.chat.send({ threadId, text }).catch((error) => { cleanup(); reject(error) })
        })
        const messages = await window.foreman.threads.messages(threadId)
        const answer = messages.findLast((message) => message.role === 'assistant' && message.content && !message.meta?.superseded)?.content ?? ''
        return { status, answer }
      }, prompt)
      expect(result.status).toBe('finished')
      const { answer } = result
      expect(JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))).toEqual(expected)
      expect(JSON.parse(readFileSync(join(workspace, file), 'utf8'))).toEqual(expected)
    } finally {
      await app.close()
    }
  })
})
