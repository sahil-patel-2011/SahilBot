import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { launch, tempProfile } from './app'
import { lastToolOutput, startMockLlm, type MockLlm } from '../fixtures/mock-llm'
import { FAKE_KEYS, startFakeOnshape, type FakeOnshape } from '../fixtures/fake-onshape'

// "Build this in CAD", end to end in the real app (hidden) with a scripted model and a fake Onshape server:
// the request loads the CAD tools up front (no find_tools), the agent walks the design workflow with
// cad_design (brief → concepts → plan → build → verify → deliver), the chat shows the Design progress card,
// the fake Onshape gets a new document with a cube and a fillet, and the STEP export lands in the workspace.

let llm: MockLlm
let onshape: FakeOnshape
const idle = async (page: Page): Promise<void> => {
  await expect.poll(() => llm.script.length, { timeout: 40_000 }).toBe(0)
  await expect.poll(() => page.locator('[data-testid="stop"]').count(), { timeout: 40_000 }).toBe(0)
}
const call = (name: string, args: unknown) => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }] })
const names = (r: Record<string, any>): string[] => (r.tools ?? []).map((t: any) => t.function.name)

describe('CAD: build a part from a sentence', () => {
  beforeAll(async () => { llm = await startMockLlm(); onshape = await startFakeOnshape() })
  afterAll(async () => { await llm.close(); await onshape.close() })

  test('"build a 40 mm cube with a 5 mm fillet in CAD" runs the design workflow against Onshape and shows the progress view', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sb-cad-ws-'))
    const { app, page } = await launch(tempProfile(), llm.url, { FOREMAN_RAM_GB: '64', FOREMAN_ONSHAPE_URL: onshape.url })
    try {
      await page.evaluate(({ w, k }) => window.foreman.settings.set({ workspaceDir: w, onshapeAccessKey: k.accessKey, onshapeSecretKey: k.secretKey } as never), { w: ws, k: FAKE_KEYS })
      const plan = {
        name: '40 mm filleted cube', units: 'mm',
        variables: [{ name: 'side', value: 40 }, { name: 'fillet_r', value: 5 }],
        features: [{ op: 'cube', id: 'body', name: 'Cube', side: '#side' }, { op: 'fillet', id: 'round', name: 'Edge fillet', edges: { of: 'body' }, radius: '#fillet_r' }],
        expect: { bbox_mm: [40, 40, 40], tolerance_mm: 0.01, volume_mm3: 61592.18, volume_tolerance_pct: 0.5, parts: 1 },
        exports: ['STEP']
      }
      llm.script.push(
        call('cad_design', { action: 'brief', brief: { goal: '40 mm cube with a 5 mm fillet on every edge', units: 'mm', dimensions: ['40 mm cube', '5 mm fillet, all 12 edges'], process: 'fdm', material: 'PLA' } }),
        call('cad_design', { action: 'concepts', concepts: [{ name: 'Cube + fillet', summary: 'Cube feature, one fillet on every edge', scores: { manufacturability: 5, cost: 5 } }, { name: 'Sketch + extrude', summary: 'Square sketch extruded 40 mm, then fillets', scores: { manufacturability: 5, cost: 5 } }], recommended: 0, reasons: 'two features, fully parametric' }),
        call('cad_design', { action: 'plan', plan }),
        call('cad_design', { action: 'build' }),
        call('cad_design', { action: 'verify' }),
        call('cad_design', { action: 'deliver' }),
        (req) => ({ content: /Design summary/.test(lastToolOutput(req)) ? 'Built the 40 mm cube with 5 mm fillets in Onshape; all checks pass. STEP exported.' : `unexpected: ${lastToolOutput(req).slice(0, 200)}` })
      )
      await page.fill('[data-testid="composer-input"]', 'build a 40 mm cube with a 5 mm fillet in CAD')
      await page.keyboard.press('Enter')
      await idle(page)

      // Listening: the agent path, with the CAD tools loaded before the first step (no find_tools call).
      const first = llm.requests[0]
      expect(names(first)).toEqual(expect.arrayContaining(['cad_design', 'onshape', 'todo']))
      expect(llm.requests.flatMap((r) => r.messages).filter((m: any) => m.role === 'assistant').flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function.name))).not.toContain('find_tools')
      expect(String(first.messages[0].content)).not.toContain('# Chatting')

      // Each step's result went back to the model.
      const outs = llm.requests.map((r) => lastToolOutput(r))
      expect(outs.some((o) => /Design brief recorded/.test(o))).toBe(true)
      expect(outs.some((o) => /Built "40 mm filleted cube" in Onshape \(a new document\)/.test(o))).toBe(true)
      expect(outs.some((o) => /PASS Size: 40 × 40 × 40 mm/.test(o) && /PASS Volume/.test(o))).toBe(true)

      // The progress view: the plan card titled Design, every phase ticked.
      await expect.poll(() => page.locator('[data-testid="assistant-bubble"]').last().innerText().catch(() => ''), { timeout: 15_000 }).toContain('all checks pass')
      const card = page.locator('[data-testid="plan-card"]')
      await card.waitFor({ timeout: 10_000 })
      expect(await card.locator('.plan-title').innerText()).toBe('Design complete')
      const steps = await page.locator('[data-testid="plan-step"]').allInnerTexts()
      expect(steps.map((s) => s.split(':')[0])).toEqual(['Design brief', 'Concepts', 'Plan', 'Build', 'Verify'])
      expect(steps[1]).toContain('2 options → Cube + fillet')
      expect(await page.locator('[data-testid="plan-step"].ps-done').count()).toBe(5)

      // The fake Onshape: a new private document with the variables, the cube and the fillet, all signed.
      expect(onshape.seen.every((s) => s.signed)).toBe(true)
      const created = onshape.seen.find((s) => s.method === 'POST' && s.path === '/api/v17/documents')
      expect(created?.body).toMatchObject({ name: '40 mm filleted cube', isPublic: false })
      const doc = [...onshape.docs.values()].find((d) => d.name === '40 mm filleted cube')!
      expect(doc.elements[0].features.map((f) => f.feature.featureType)).toEqual(['assignVariable', 'assignVariable', 'cube', 'fillet'])
      expect(doc.elements[0].features.every((f) => f.status === 'OK')).toBe(true)
      // Nothing was deleted, and the STEP export is in the workspace.
      expect(onshape.seen.some((s) => s.method === 'DELETE')).toBe(false)
      const step = join(ws, 'exports', 'onshape', '40 mm filleted cube - Part Studio 1.step')
      expect(existsSync(step)).toBe(true)
      expect(readFileSync(step, 'utf8')).toMatch(/^ISO-10303-21/)
      // A new document is routine: no approval card was needed.
      expect(await page.locator('[data-testid="approval-card"]').count()).toBe(0)
    } finally {
      await app.close()
    }
  }, 120_000)
})
