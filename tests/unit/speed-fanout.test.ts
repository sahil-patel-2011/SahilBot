import { describe, expect, test } from 'vitest'
import { appToolsFor } from '../../src/main/agent/intent'
import { executeWorkflow, WORKFLOW_PARALLEL } from '../../src/main/agent/runtime/workflow'

// Faster with connected apps: a named app's tools are there from the first step, and a workflow's independent
// calls run at the same time.

const tools = [
  { name: 'notion__search', group: 'Notion', connector: true },
  { name: 'notion__fetch', group: 'Notion', connector: true },
  { name: 'gcal__list_events', group: 'Google Calendar', connector: true },
  { name: 'slack__post', group: 'Slack', connector: true },
  { name: 'web_search', group: 'Web' }
]

describe('connected apps named in the request', () => {
  test.each([
    ['Summarize my Notion page about the launch', ['notion__search', 'notion__fetch']],
    ["What's on my calendar tomorrow?", ['gcal__list_events']],
    ['Post the recap in Slack and check my calendar', ['gcal__list_events', 'slack__post']]
  ])('"%s" loads that app\'s tools up front', (text, want) => {
    expect(appToolsFor(text, tools).sort()).toEqual([...want].sort())
  })
  test('nothing for requests that name no app, and never a built-in tool', () => {
    expect(appToolsFor('Explain photosynthesis', tools)).toEqual([])
    expect(appToolsFor('search the web for google news', tools)).toEqual([])
  })
  test('capped', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `linear__t${i}`, group: 'Linear', connector: true }))
    expect(appToolsFor('triage my Linear issues', many, 12)).toHaveLength(12)
  })
})

describe('workflow', () => {
  test('independent calls run at the same time; dependents wait for them', async () => {
    const started: Array<{ tool: string; at: number }> = []
    const t0 = Date.now()
    const invokeTool = async (tool: string): Promise<{ text: string; data: unknown }> => {
      started.push({ tool, at: Date.now() - t0 })
      await new Promise((r) => setTimeout(r, 150))
      return { text: tool, data: { items: [tool] } }
    }
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) => ({ id: `read${i}`, op: 'call' as const, tool: `read${i}` })),
      { id: 'sum', op: 'call' as const, tool: 'summarize', dependsOn: ['read0', 'read1', 'read2', 'read3'], args: { first: { $ref: 'read0/data/items' } } }
    ]
    const r = await executeWorkflow(nodes, { invokeTool: invokeTool as never, signal: new AbortController().signal })
    expect(r.every((x) => x.status === 'done')).toBe(true)
    const took = Date.now() - t0
    expect(WORKFLOW_PARALLEL).toBeGreaterThanOrEqual(4)
    // Four 150 ms reads at once, then the summary: about 300 ms, not 750 ms.
    expect(took).toBeLessThan(600)
    expect(started.find((s) => s.tool === 'summarize')!.at).toBeGreaterThanOrEqual(140)
  })
})
