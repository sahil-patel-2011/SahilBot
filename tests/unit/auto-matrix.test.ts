import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Effort, ModelInfo } from '@shared/types'

// Every test here runs the whole routing simulation many times: generous limits so a busy CI runner doesn't time out.
vi.setConfig({ testTimeout: 60_000 })
vi.mock('electron', () => ({ shell: { trashItem: async () => undefined }, app: { getPath: () => '/tmp', isPackaged: false } }))
const sim = await import('../fixtures/auto-sim')
const { classifyTask } = await import('../../src/main/llm/task-classifier')
const { autoRoute, planFallback } = await import('../../src/main/llm/auto-route')
const { ModelHealth, failureKind } = await import('../../src/main/llm/model-health')
const { routeTask, payPerUse } = await import('../../src/main/llm/routing-table')

// Auto, simulated (docs/model-routing.md "Simulated guarantees"): every realistic setup × every request of the
// routing eval set, through the same decision the agent loop makes, with the invariants checked independently
// of how Auto keeps them. No network, no model calls. Each failure prints the setup and the item.

const NOW = Date.UTC(2026, 10, 15, 12)
const ITEMS = sim.EVAL.items
const TASKS = new Map(ITEMS.map((it) => [it.id, classifyTask(it.text, sim.contextOf(it))]))

describe('configuration matrix', () => {
  const setups = sim.setups()
  const counts = new Map<string, number>()
  const examples = new Map<string, string[]>()
  let checked = 0
  let ms = 0
  beforeAll(() => {
    const t0 = Date.now()
    for (const s of setups) {
      sim.applyPrefs(s)
      const health = new ModelHealth()
      const seen402 = new Set<string>()
      for (const it of ITEMS) {
        const task = TASKS.get(it.id)!
        const voice = !!it.ctx?.voice
        const p = sim.pickFor(s, task, { voice, health, now: NOW })
        const v = sim.violations({ s, item: it, task, pick: p, usable: sim.usableFor(s), health, now: NOW })
        const first = p.failed?.[0] ?? p.result?.model
        if (first && seen402.has(first)) v.push(`out-of-credit-model-retried-on-a-later-request: ${first}`)
        for (const f of p.failed ?? []) seen402.add(f)
        checked++
        for (const x of v) {
          const k = x.split(':')[0]
          counts.set(k, (counts.get(k) ?? 0) + 1)
          const ex = examples.get(k) ?? []
          if (ex.length < 4) ex.push(`${x} | ${sim.setupName(s)} | ${it.id} "${it.text.slice(0, 60)}"`)
          examples.set(k, ex)
        }
      }
    }
    sim.resetPrefs()
    ms = Date.now() - t0
  }, 180_000) // ~500K routing decisions: a few seconds here, longer on CI runners
  afterAll(() => sim.resetPrefs())

  test('every setup × every eval item keeps every invariant', () => {
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    console.log(`[auto-matrix] ${setups.length} setups × ${ITEMS.length} items = ${checked} picks (× ${sim.FAST.length} fast settings) in ${ms} ms; violations ${total}`)
    for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}\n    ${examples.get(k)!.join('\n    ')}`)
    expect(checked).toBe(setups.length * ITEMS.length)
    expect(Object.fromEntries(counts)).toEqual({})
  })

  test('the whole matrix runs in well under a minute', () => expect(ms).toBeLessThan(45_000))
})

describe('GPT-6.2: Sol for routine research and reasoning, Astra only for the hardest work', () => {
  // Every research and math item of the eval set, on every key setup with an OpenAI key, Best result and Balanced,
  // with and without local models and Fable (plenty of budget, an account with credit).
  const base = sim.setups().filter((s) => sim.hasOpenAIKey(s.keys) && !s.keys.startsWith('plan') && s.spending === 'plenty' && !s.noCredit && s.preference !== 'cheapest')
  const reasoning = ITEMS.filter((it) => ['research', 'math'].includes(TASKS.get(it.id)!.category) && !TASKS.get(it.id)!.signals.study)
  const routed = (s: (typeof base)[number], it: (typeof ITEMS)[number]): string | undefined => {
    sim.applyPrefs(s)
    try { return sim.pickFor(s, TASKS.get(it.id)!, { voice: !!it.ctx?.voice, health: new ModelHealth(), now: NOW }).result?.model } finally { sim.resetPrefs() }
  }
  test('the eval set has routine and hardest research and math to check', () => {
    expect(reasoning.filter((it) => TASKS.get(it.id)!.difficulty === 2).length).toBeGreaterThanOrEqual(3)
    expect(reasoning.filter((it) => TASKS.get(it.id)!.difficulty === 3).length).toBeGreaterThanOrEqual(1)
  })
  test('routine (difficulty 0-2) research and math never go to GPT-6.2 Astra; difficulty 2 goes to GPT-6.2 Sol when GPT is the pick', () => {
    let n = 0
    for (const s of base) for (const it of reasoning) {
      const d = TASKS.get(it.id)!.difficulty
      if (d >= 3) continue
      const m = routed(s, it)
      expect(m, `${sim.setupName(s)} | ${it.id} "${it.text.slice(0, 60)}"`).not.toBe('gpt-6.2-astra')
      if (d === 2 && m?.startsWith('gpt-')) expect(m, `${sim.setupName(s)} | ${it.id}`).toBe('gpt-6.2-sol')
      n++
    }
    expect(n).toBeGreaterThan(100)
  })
  test('the hardest research and math (difficulty 3) get GPT-6.2 Astra on Best result with an OpenAI key and no Fable', () => {
    const hard = reasoning.filter((it) => TASKS.get(it.id)!.difficulty === 3 && !TASKS.get(it.id)!.needsVision)
    for (const s of base.filter((x) => x.preference === 'best' && !x.fable && x.keys === 'openai')) for (const it of hard) expect(routed(s, it), `${sim.setupName(s)} | ${it.id}`).toBe('gpt-6.2-astra')
  })
  test('superseded GPT-6 Astra / GPT-6.1 Sol are never Auto\'s pick when the 6.2 models are on', () => {
    // The older two switched on by hand next to the 6.2 lineup (as the Models page lists them, rank 2 + gen / 100).
    const gpt = sim.usableFor(base.find((s) => s.keys === 'openai')!)
    const older = [['gpt-6-astra', 'gpt-6.2-astra', 2.06], ['gpt-6.1-sol', 'gpt-6.2-sol', 2.061]] as const
    const both = [...sim.usableFor(base[0]), ...older.map(([id, newer, rank]) => ({ ...gpt.find((m) => m.id === newer)!, id, rank }))]
    for (const it of ITEMS) {
      const m = autoRoute({ requested: 'auto', usable: both, task: TASKS.get(it.id)!, preference: 'best', voice: !!it.ctx?.voice, health: new ModelHealth(), now: NOW }).model
      expect(['gpt-6-astra', 'gpt-6.1-sol']).not.toContain(m)
    }
  })
})

describe('stability across a conversation', () => {
  /** Provider and model switches between consecutive turns that continue the same work. */
  function flipRate(stable: boolean): { turns: number; pairs: number; providerFlips: number; modelFlips: number; flips: Map<string, number> } {
    const convs = sim.conversations()
    const classified = convs.map(sim.classifyConversation)
    let pairs = 0, providerFlips = 0, modelFlips = 0, turns = 0
    const flips = new Map<string, number>()
    for (const s of sim.setups().filter((x) => !x.noCredit && x.spending === 'plenty')) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      const health = new ModelHealth()
      convs.forEach((conv, ci) => {
        let prev: { model: string; category: import('../../src/main/llm/task-classifier').TaskCategory } | undefined
        conv.forEach((_turn, ti) => {
          const task = classified[ci][ti]
          const p = sim.pickFor(s, task, { health, now: NOW, previous: stable ? prev : undefined })
          turns++
          const m = p.result?.model
          if (prev && m) {
            // The same piece of work: a follow-up, the same kind of request, or a light chat turn ("thanks!").
            const same = task.rule === 'follow-up' || task.category === prev.category || (task.category === 'chat' && task.difficulty <= 1)
            const pf = sim.providerOfModel(prev.model, usable) !== sim.providerOfModel(m, usable)
            if (same) {
              pairs++
              if (pf) { providerFlips++; const k = `${prev.model}→${m} ${prev.category}→${task.category} d${task.difficulty} ${s.preference}`; flips.set(k, (flips.get(k) ?? 0) + 1) }
              if (prev.model !== m) modelFlips++
            }
          }
          if (m) prev = { model: m, category: task.category }
        })
      })
    }
    sim.resetPrefs()
    return { turns, pairs, providerFlips, modelFlips, flips }
  }

  test('follow-ups and same-kind requests keep the chat\'s model (flip rate, with and without the stability rule)', () => {
    const before = flipRate(false)
    const after = flipRate(true)
    const pct = (a: number, b: number): string => `${(100 * a / b).toFixed(2)}%`
    for (const [name, r] of [['without the stability rule', before], ['with it', after]] as const) {
      console.log(`[auto-matrix] ${name}: ${r.turns} turns, ${r.pairs} same-work pairs: provider flips ${r.providerFlips} (${pct(r.providerFlips, r.pairs)}), model flips ${r.modelFlips} (${pct(r.modelFlips, r.pairs)})`)
    }
    console.log([...after.flips].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `  ${k}: ${n}`).join('\n'))
    // A light turn steps down from a model costing over 2x the fresh pick (keepPrevious), so some model flips are wanted.
    expect(after.providerFlips / after.pairs).toBeLessThan(0.0125)
    expect(after.modelFlips / after.pairs).toBeLessThan(0.1)
    expect(after.providerFlips).toBeLessThan(before.providerFlips / 2)
  }, 60_000) // two full simulated conversations: slow on a busy CI runner
})

describe('determinism and manual picks', () => {
  test('the same inputs give the same pick (every 5th setup, every item, twice)', () => {
    let n = 0
    for (const s of sim.setups().filter((_, i) => i % 5 === 0)) {
      sim.applyPrefs(s)
      const a = new ModelHealth(), b = new ModelHealth()
      for (const it of ITEMS) {
        const task = TASKS.get(it.id)!
        const x = sim.pickFor(s, task, { voice: !!it.ctx?.voice, health: a, now: NOW })
        const y = sim.pickFor(s, task, { voice: !!it.ctx?.voice, health: b, now: NOW })
        expect(y.result?.model ?? y.error, `${sim.setupName(s)} | ${it.id}`).toBe(x.result?.model ?? x.error)
        expect(y.result?.label, it.id).toBe(x.result?.label)
        n++
      }
    }
    sim.resetPrefs()
    expect(n).toBeGreaterThan(50_000)
  }, 60_000) // many full routing passes: slow on a busy runner

  test('a model picked by name is used exactly: every model, every setup, cooling down or not', () => {
    for (const s of sim.setups().filter((x) => x.preference === 'best' && x.spending === 'plenty' && !x.fable)) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      const health = new ModelHealth()
      for (const m of sim.listed(s)) {
        health.mark(m, Object.assign(new Error('insufficient_quota'), { status: 402 }), NOW)
        for (const id of ['cod-002', 'chat-001', 'cu-001', 'voice-001']) {
          const it = ITEMS.find((x) => x.id === id) ?? ITEMS[0]
          const r = autoRoute({ requested: m.id, usable, task: TASKS.get(it.id)!, preference: 'best', voice: !!it.ctx?.voice, health, now: NOW })
          expect(r, `${sim.setupName(s)} ${m.id} ${id}`).toMatchObject({ model: m.id, manual: true })
        }
      }
    }
    sim.resetPrefs()
  })
})

// ---------------------------------------------------------------------------------------------------
// Failures, with fake provider responses (the providers' own error mappers build them).
// ---------------------------------------------------------------------------------------------------

const { openaiError, streamResponses } = await import('../../src/main/llm/openai-responses')
const { xaiError } = await import('../../src/main/llm/xai-client')
const { PlanLimitError } = await import('../../src/main/llm/codex/session')
const { retryInfo, withRetries, retryPolicy } = await import('../../src/main/llm/retry')
const { fallbackNotice } = await import('../../src/main/agent/choices')
const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null })

interface Scenario { name: string; err: (model: string, provider: string) => Error; retried: boolean; kind: string; scope: 'model' | 'provider' | 'none'; words: RegExp }
const SCENARIOS: Scenario[] = [
  { name: 'rate limit (429, Retry-After 20 s)', retried: true, kind: 'rate-limit', scope: 'model', words: /rate limited/,
    err: (m, p) => p === 'openai' ? openaiError(429, { message: 'Rate limit reached', code: 'rate_limit_exceeded' }, headers({ 'retry-after': '20' }), m) : p === 'xai' ? xaiError(429, 'Too many requests', headers({ 'retry-after': '20' }), m) : Object.assign(new Error('Claude is rate-limiting requests right now. Try again in a moment.'), { status: 429, retryAfterMs: 20_000 }) },
  { name: 'overloaded (529 / 503)', retried: true, kind: 'overloaded', scope: 'model', words: /overloaded/,
    err: (m, p) => p === 'openai' ? openaiError(503, { message: 'The server is overloaded', code: 'server_is_overloaded' }, undefined, m) : Object.assign(new Error('Claude is overloaded or unavailable right now. Try again shortly.'), { status: 529 }) },
  { name: 'out of credit (HTTP 429 insufficient_quota / Anthropic credit balance / xAI 402)', retried: false, kind: 'quota', scope: 'provider', words: /out of API credit/,
    err: (m, p) => p === 'openai' ? openaiError(429, { message: 'You exceeded your current quota', code: 'insufficient_quota', type: 'insufficient_quota' }, undefined, m) : p === 'xai' ? xaiError(402, 'Your team has run out of credits', undefined, m) : Object.assign(new Error("Anthropic won't run more requests on this account right now (Your credit balance is too low to access the Anthropic API). Check your Anthropic billing."), { status: 402 }) },
  { name: 'model not found / deprecated (404)', retried: false, kind: 'not-found', scope: 'model', words: /not available on this account/,
    err: (m, p) => p === 'openai' ? openaiError(404, { message: `The model ${m} has been deprecated`, code: 'model_not_found' }, undefined, m) : p === 'xai' ? xaiError(404, 'model not found', undefined, m) : Object.assign(new Error(`Claude rejected the request: model: ${m}`), { status: 404 }) },
  { name: 'context too long', retried: false, kind: 'context', scope: 'none', words: /too long for its context window/,
    err: (m, p) => p === 'openai' ? openaiError(400, { message: 'This model\'s maximum context length is 1050000 tokens', code: 'context_length_exceeded' }, undefined, m) : p === 'xai' ? xaiError(400, 'maximum prompt length exceeded: too long', undefined, m) : Object.assign(new Error('Claude rejected the request: prompt is too long: 1200000 tokens > 1000000 maximum'), { status: 400 }) },
  { name: 'content-policy refusal', retried: false, kind: 'refusal', scope: 'none', words: /usage policy/,
    err: (m, p) => p === 'openai' ? openaiError(400, { message: 'Invalid prompt: flagged as potentially violating our usage policy', code: 'invalid_prompt' }, undefined, m) : Object.assign(new Error('Claude rejected the request: Output blocked by content filtering policy (usage policies)'), { status: 400 }) },
  { name: 'network drop', retried: true, kind: 'network', scope: 'provider', words: /not responding/,
    err: () => Object.assign(new Error('The connection to the provider closed before the reply finished.'), { network: true }) },
  { name: 'ChatGPT plan limit reached', retried: false, kind: 'plan-limit', scope: 'provider', words: /ChatGPT plan limit/,
    err: () => new PlanLimitError('Your ChatGPT plan\'s usage limit is reached. It resets at 14:00.', Math.floor(NOW / 1000) + 2 * 3600) }
]

describe('failures: Auto falls back, remembers, says so once, never loops', () => {
  const FAIL_TASKS = ['cod-002', 'res-001', 'wri-001', 'chat-010', 'math-001', 'off-001', 'cu-001'].map((id) => ITEMS.find((x) => x.id === id) ?? ITEMS[0])
  const keySetups = sim.KEY_SETUPS.flatMap((keys) => [false, true].map((local) => ({ keys, local, preference: 'best' as const, spending: 'plenty' as const, fable: false, noCredit: false })))
  let covered = 0

  test.each(SCENARIOS.map((x) => [x.name, x] as const))('%s', (_, sc) => {
    for (const s of keySetups) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      for (const it of FAIL_TASKS) {
        const task = TASKS.get(it.id)!
        const health = new ModelHealth()
        let first
        try { first = autoRoute({ requested: 'auto', usable, task, preference: 'best', health, now: NOW }) } catch { continue }
        const cur = usable.find((m) => m.id === first.model)!
        if (sc.kind === 'plan-limit' && cur.provider !== 'chatgpt') continue
        const err = sc.err(cur.id, cur.provider)
        const where = `${sim.setupName(s)} | ${it.id} | ${cur.id}`
        // Retried first only when retrying can help; out of credit never.
        expect(retryInfo(err).retry, where).toBe(sc.retried)
        expect(failureKind(err), where).toBe(sc.kind)
        const mark = health.mark(cur, err, NOW)
        const scope = sc.kind === 'quota' && cur.provider === 'openai' ? 'model' : sc.scope
        expect(mark.scope, where).toBe(scope)
        for (const midRun of [false, true]) {
          const tried = new Set([cur.id])
          const f = planFallback({ usable, task, current: cur, err, tried, preference: 'best', health, now: NOW, midRun })
          // A content-policy refusal stops: no other model is asked (no shopping around a safety decision).
          if (sc.kind === 'refusal') {
            expect(f.model, where).toBeUndefined()
            expect(f.note, where).toMatch(/declined this request under its usage policy/)
            continue
          }
          if (!f.model) {
            // Only when nothing else may take over (said so).
            expect(f.note, where).toMatch(/no other model/)
            const rest = usable.filter((m) => m.id !== cur.id && !health.blocked(m, NOW) && (scope !== 'provider' || m.provider !== cur.provider) && (sc.kind !== 'refusal' || m.provider !== cur.provider) && (sc.kind !== 'context' || sim.windowOf(m) > sim.windowOf(cur)))
            const ok = rest.filter((m) => !(task.category === 'computer-use' && m.provider === 'xai'))
            expect(ok.map((m) => m.id), where).toEqual([])
            continue
          }
          const next = f.model
          expect(usable.map((m) => m.id), where).toContain(next.id)
          expect(next.id, where).not.toBe(cur.id)
          if (scope === 'provider' || sc.kind === 'refusal') expect(next.provider, where).not.toBe(cur.provider)
          if (sc.kind === 'context') expect(sim.windowOf(next), where).toBeGreaterThan(sim.windowOf(cur))
          if (task.category === 'computer-use') expect(next.provider, where).not.toBe('xai')
          // One clear note, naming both models and the reason.
          expect(f.note, where).toContain(cur.label!)
          expect(f.note, where).toContain(next.label!)
          expect(f.note, where).toMatch(sc.words)
          // Same provider first mid-run (a failure of that one model); otherwise the table's order.
          const sameOk = usable.filter((m) => m.provider === cur.provider && m.id !== cur.id && !health.blocked(m, NOW) && !sim.isPremium(m))
          if (midRun && scope === 'model' && sc.kind !== 'refusal' && sameOk.length && routeTask(sameOk, task, { preference: 'best' })) expect(next.provider, where).toBe(cur.provider)
          if (!midRun) {
            const pool = usable.filter((m) => m.id !== cur.id && !health.blocked(m, NOW) && (scope !== 'provider' || m.provider !== cur.provider) && (sc.kind !== 'refusal' || m.provider !== cur.provider) && (sc.kind !== 'context' || sim.windowOf(m) > sim.windowOf(cur)) && !sim.isPremium(m))
            expect(next.id, where).toBe(routeTask(pool, task, { preference: 'best' })!.model.id)
          }
          covered++
        }
        // Later requests skip it (and its provider, for a provider-wide failure) until the cooldown ends.
        if (scope !== 'none') {
          let later
          try { later = autoRoute({ requested: 'auto', usable, task, preference: 'best', health, now: NOW + 1000 }) } catch { later = undefined }
          // (When nothing else is left, a soft cooldown — rate limit, overload, dropped connection — is lifted.)
          const others = usable.filter((m) => !health.blocked(m, NOW + 1000) && !(task.category === 'computer-use' && m.provider === 'xai'))
          if (later && (others.length || ['quota', 'plan-limit', 'not-found', 'auth'].includes(sc.kind))) {
            expect(later.model, where).not.toBe(cur.id)
            if (scope === 'provider') expect(usable.find((m) => m.id === later!.model)!.provider, where).not.toBe(cur.provider)
          }
          const after = autoRoute({ requested: 'auto', usable, task, preference: 'best', health, now: NOW + 8 * 24 * 3600_000 })
          expect(after.model, `${where} after the cooldown`).toBe(first.model)
        }
      }
    }
    sim.resetPrefs()
  })

  test('never loops: every model failing in turn is tried once each, at most 3 in a run, then a readable error', () => {
    for (const s of keySetups) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      for (const it of FAIL_TASKS) {
        const task = TASKS.get(it.id)!
        for (const sc of SCENARIOS) {
          const health = new ModelHealth()
          let r
          try { r = autoRoute({ requested: 'auto', usable, task, preference: 'best', health, now: NOW }) } catch { continue }
          const tried = new Set([r.model])
          const seq = [r.model]
          let cur = usable.find((m) => m.id === r!.model)!
          // The loop's cap: two switches per run (three models), each to a model not tried yet.
          for (let sw = 0; sw < 2; sw++) {
            const err = sc.err(cur.id, cur.provider)
            health.mark(cur, err, NOW)
            const f = planFallback({ usable, task, current: cur, err, tried, preference: 'best', health, now: NOW, midRun: true })
            if (!f.model) break
            expect(tried.has(f.model.id), `${sim.setupName(s)} ${it.id} ${sc.name}: ${seq.join(' → ')} → ${f.model.id}`).toBe(false)
            tried.add(f.model.id); seq.push(f.model.id); cur = f.model
          }
          expect(new Set(seq).size).toBe(seq.length)
          expect(seq.length).toBeLessThanOrEqual(3)
        }
      }
    }
    sim.resetPrefs()
  })

  test('the stream error seen live ({type:"error", error:{code:"insufficient_quota"}}) is a 402, sent once, never retried', async () => {
    const saved = { ...retryPolicy }
    Object.assign(retryPolicy, { baseMs: 0, maxMs: 0 })
    let opens = 0
    const fetchStub = vi.fn(async () => {
      opens++
      const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"error","error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}\n\n')); c.close() } })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const req = { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-6.2-sol', messages: [{ role: 'user' as const, content: 'hi' }], sampling: {} as never, maxTokens: 1000, effort: 'high' as const }
      let caught: unknown
      try { for await (const _ of withRetries(() => streamResponses(req))) void _ } catch (e) { caught = e }
      expect(opens).toBe(1)
      expect((caught as { status?: number }).status).toBe(402)
      expect(failureKind(caught)).toBe('quota')
      expect(fallbackNotice('GPT-6.2 Sol', 'GPT-6.1 Terra', caught as Error, { rest: true })).toBe('GPT-6.2 Sol is unavailable (out of API credit); used GPT-6.1 Terra for the rest of this task.')
      // HTTP-level billing limits (429 insufficient_quota) are 402 too.
      expect(retryInfo(openaiError(429, { code: 'insufficient_quota', message: 'quota' }, undefined, 'gpt-6.2-sol')).retry).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      Object.assign(retryPolicy, saved)
    }
  })

  test('a rate limit cools the model down for exactly its Retry-After; soft cooldowns lift when nothing else is left', () => {
    const h = new ModelHealth()
    const m = sim.CLAUDE_MODELS[2]
    h.mark(m, Object.assign(new Error('429'), { status: 429, retryAfterMs: 20_000 }), NOW)
    expect(h.blocked(m, NOW + 19_000)?.kind).toBe('rate-limit')
    expect(h.blocked(m, NOW + 21_000)).toBeUndefined()
    // Only that model is on: the soft cooldown is ignored (the limit may have passed), a hard one never is.
    expect(h.filter([m], NOW + 1000).map((x) => x.id)).toEqual([m.id])
    h.mark(m, Object.assign(new Error('insufficient_quota'), { status: 402 }), NOW)
    expect(h.filter([m], NOW + 1000)).toEqual([])
  })

  afterAll(() => console.log(`[auto-matrix] failure scenarios: ${SCENARIOS.length} kinds × ${keySetups.length} key setups × ${FAIL_TASKS.length} requests; ${covered} fallbacks checked`))
})

// ---------------------------------------------------------------------------------------------------
// Effort: the rubric's level, the mid-run bump, and only values each model accepts on the wire.
// ---------------------------------------------------------------------------------------------------

const { buildClaudeRequest } = await import('../../src/main/llm/anthropic')
const { buildResponsesRequest } = await import('../../src/main/llm/openai-responses')
const { buildXaiRequest } = await import('../../src/main/llm/xai-client')
const { codexEffort } = await import('../../src/main/llm/codex/session')
const { CLAUDE } = await import('../../src/main/llm/claude-models')
const { OPENAI } = await import('../../src/main/llm/openai-models')
const { XAI } = await import('../../src/main/llm/xai-models')
const { escalateEffort, supportedEffort, FAIL_STEPS, PLAN_STEPS } = await import('../../src/main/llm/auto-effort')

const LV: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const SAMPLING = { temperature: 1, top_p: 1, top_k: 0, min_p: 0, presence_penalty: 0, repeat_penalty: 1 }
const wire = [{ role: 'system' as const, content: 'You are SahilBot.' }, { role: 'user' as const, content: 'hi' }]
/** CODEX model/list effort lists seen across Codex versions (and none at all). */
const CODEX_EFFORTS: string[][] = [[], ['low', 'medium', 'high'], ['minimal', 'low', 'medium', 'high'], ['low', 'medium', 'high', 'xhigh'], ['none', 'low', 'medium', 'high', 'xhigh', 'max']]

/** The effort a request body carries, and what the model accepts (undefined: takes no effort field). */
function sentEffort(model: string, effort: Effort): { sent?: string; accepted?: string[] } {
  if (model.startsWith('claude-')) {
    const { params } = buildClaudeRequest({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k', model, messages: wire, sampling: SAMPLING, maxTokens: 4096, effort })
    return { sent: (params.output_config as { effort?: string } | undefined)?.effort, accepted: CLAUDE.find((c) => c.id === model)?.efforts }
  }
  if (model.startsWith('grok-')) {
    const body = buildXaiRequest({ baseUrl: 'https://api.x.ai/v1', apiKey: 'k', model, messages: wire, sampling: SAMPLING, maxTokens: 4096, effort })
    const spec = XAI.find((x) => x.id === model)!
    return { sent: (body.reasoning as { effort?: string } | undefined)?.effort, accepted: spec.special ? [] : spec.efforts?.filter((e) => e !== 'none') }
  }
  const { body } = buildResponsesRequest({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model, messages: wire, sampling: SAMPLING, maxTokens: 4096, effort })
  return { sent: (body.reasoning as { effort?: string } | undefined)?.effort, accepted: OPENAI.find((o) => o.id === model)?.efforts }
}

const ALL_MODELS = [...CLAUDE.map((c) => c.id), ...OPENAI.filter((o) => o.api === 'responses' || o.efforts).map((o) => o.id), ...XAI.map((x) => x.id)]

describe('effort', () => {
  test('every model in the tables × every level: the body carries only a value the model accepts, the nearest one below', () => {
    let n = 0
    for (const model of ALL_MODELS) {
      for (const e of LV) {
        const { sent, accepted } = sentEffort(model, e)
        const where = `${model} @ ${e}`
        if (!accepted?.length) { expect(sent, where).toBeUndefined(); continue }
        expect(accepted, where).toContain(sent)
        expect(sent, where).not.toBe('none')
        // The nearest accepted level at or below; above only when none is below.
        const below = LV.slice(0, LV.indexOf(e) + 1).filter((l) => accepted.includes(l)).pop()
        expect(sent, where).toBe(below ?? LV.find((l) => accepted.includes(l)))
        // What the app reasons with (escalation, the step chip) is what is sent.
        expect(supportedEffort(model, e), where).toBe(sent)
        n++
      }
    }
    // The ChatGPT plan (Codex): only an effort the plan's model lists, or a plain level when it lists none.
    for (const list of CODEX_EFFORTS) for (const e of LV) {
      const sent = codexEffort(e, list)
      if (list.length) { if (sent !== undefined) expect(list, `${list} @ ${e}`).toContain(sent) } else expect(['low', 'medium', 'high']).toContain(sent)
      n++
    }
    console.log(`[auto-matrix] effort mapping: ${ALL_MODELS.length} models + ${CODEX_EFFORTS.length} Codex effort lists × ${LV.length} levels = ${n} request bodies checked`)
  })

  test('long runs with failures and growing plans: one bump at most, only on Auto, up to Extra, always a level the model takes', () => {
    // [failed calls, plan length] per step; some runs switch model mid-way (a fallback).
    const SCRIPTS: Array<{ name: string; steps: Array<[number, number]>; switchAt?: number }> = [
      { name: 'smooth', steps: Array.from({ length: 12 }, () => [0, 4]) },
      { name: 'keeps failing', steps: [[1, 3], [1, 3], [1, 3], [1, 3], [0, 3], [0, 3]] },
      { name: 'plan grows', steps: [[0, 3], [0, 5], [0, 8], [0, 9], [0, 12], [0, 14]] },
      { name: 'both, then a fallback model', steps: [[2, 6], [2, 10], [0, 11], [3, 11], [0, 11], [1, 12]], switchAt: 2 },
      { name: 'failures after the bump', steps: [[3, 2], [3, 2], [3, 2], [3, 9], [3, 12]] }
    ]
    const NEXT: Record<string, string> = { 'claude-opus-5-5': 'claude-sonnet-5-5', 'gpt-6.2-astra': 'gpt-6.2-sol', 'gpt-6.2-sol': 'gpt-6.1-terra', 'grok-4.7': 'gpt-6.2-sol', 'claude-haiku-5-5': 'gpt-6-luna', 'gpt-5.4': 'gpt-5.4-mini' }
    let runs = 0
    for (const first of ALL_MODELS) for (const start of LV) for (const choice of ['auto', 'high', 'max'] as const) for (const sc of SCRIPTS) {
      let model = first
      let bump: Effort | undefined
      let failures = 0
      const notes: string[] = []
      for (let i = 0; i < sc.steps.length; i++) {
        if (sc.switchAt === i && NEXT[model]) model = NEXT[model]
        const [failed, plan] = sc.steps[i]
        const now: Effort = choice !== 'auto' ? choice : bump && LV.indexOf(bump) > LV.indexOf(start) ? bump : start
        // Every request this run makes carries a value the model takes.
        const { sent, accepted } = sentEffort(model, now)
        if (accepted?.length) expect(accepted, `${first} ${sc.name} step ${i} ${model} @ ${now}`).toContain(sent)
        else expect(sent).toBeUndefined()
        if (choice !== 'auto') expect(now).toBe(choice)
        failures += failed
        if (!bump) {
          const up = escalateEffort({ choice, current: now, bumped: false, failures, planSteps: plan, model })
          if (up) { bump = up.level; notes.push(up.note) }
        }
      }
      const where = `${first} from ${start} (${choice}) · ${sc.name}`
      expect(notes.length, where).toBeLessThanOrEqual(1)
      if (choice !== 'auto') expect(notes, where).toEqual([])
      if (bump) {
        expect(LV.indexOf(bump), where).toBeLessThanOrEqual(LV.indexOf('xhigh'))
        expect(LV.indexOf(bump), where).toBeGreaterThan(LV.indexOf(start))
        expect(sc.steps.some(([, p]) => p > PLAN_STEPS) || sc.steps.reduce((a, [f]) => a + f, 0) >= FAIL_STEPS, where).toBe(true)
        expect(notes[0], where).toMatch(/^Thinking raised to (High|Extra|Medium) for the rest of this task: /)
      }
      runs++
    }
    console.log(`[auto-matrix] effort escalation: ${runs} simulated runs`)
  })

  test('Auto\'s effort is never below the rubric, on every item (voice keeps replies fast)', () => {
    for (const it of ITEMS) {
      const task = TASKS.get(it.id)!
      const e = sim.loopEffort(task, !!it.ctx?.voice, sim.contextOf(it))
      if (!it.ctx?.voice) expect(LV.indexOf(e), it.id).toBeGreaterThanOrEqual(LV.indexOf(task.effort))
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Swarm helpers, the council and the computer-use pair, per key setup.
// ---------------------------------------------------------------------------------------------------

const { assignModel, councilMembers, providerOf, roleSlots, ROLE_TIER } = await import('../../src/main/agent/swarm/models')
const { slotOf } = await import('../../src/main/llm/routing-table')
const { choosePair } = await import('../../src/main/agent/cua/pair')
const { isPremiumClaude } = await import('../../src/main/llm/claude-models')
const { isPremiumOpenAI } = await import('../../src/main/llm/openai-models')

describe('swarm helpers, council, computer-use pair', () => {
  const setups = sim.setups().filter((s) => s.preference === 'best' && !s.noCredit && (s.spending === 'plenty' || s.spending === 'none' || s.spending === 'exhausted'))
  const CATS = ['coding', 'research', 'writing', 'office', 'math', 'computer-use', 'agent-tools'] as const
  const ok = (s: import('../fixtures/auto-sim').Setup, usable: ModelInfo[], id: string, where: string, o: { lead?: string } = {}): void => {
    const m = usable.find((x) => x.id === id)
    expect(m, `${where}: ${id} isn't usable`).toBeDefined()
    if (!s.local) expect(sim.isLocal(m!), `${where}: local model ${id} with local off`).toBe(false)
    if (s.spending !== 'plenty') expect(payPerUse(m!), `${where}: paid ${id} under ${s.spending}`).toBe(false)
    expect(isPremiumOpenAI(id), `${where}: ${id}`).toBe(false)
    if (!s.fable && !(o.lead && isPremiumClaude(o.lead))) expect(isPremiumClaude(id), `${where}: Fable without the setting`).toBe(false)
  }

  test('helpers: bots mix providers, agent chats stay on the lead\'s; always usable, within the limit and local opt-in', () => {
    let n = 0
    for (const s of setups) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      for (const cat of CATS) {
        const task = classifyTask(cat === 'coding' ? 'Refactor the auth module and update the tests' : `A hard ${cat} task`, {})
        let lead
        try { lead = autoRoute({ requested: 'auto', usable, task: { ...task, category: cat, difficulty: 3 }, preference: 'best', health: new ModelHealth(), now: NOW }).model } catch { continue }
        const leadInfo = usable.find((m) => m.id === lead)!
        for (const role of Object.keys(ROLE_TIER) as Array<keyof typeof ROLE_TIER>) for (const crossProvider of [false, true]) {
          const where = `${sim.setupName(s)} · ${cat} · ${role} · ${crossProvider ? 'bot' : 'agent chat'} · lead ${lead}`
          const h = assignModel(role, { usable, category: cat, lead, leadCloud: !sim.isLocal(leadInfo), crossProvider, authorProvider: providerOf(leadInfo) })
          ok(s, usable, h.model, where, { lead })
          if (!crossProvider) expect(providerOf(usable.find((m) => m.id === h.model)!), where).toBe(providerOf(leadInfo))
          if (cat === 'computer-use') expect(usable.find((m) => m.id === h.model)!.provider === 'xai' && leadInfo.provider !== 'xai', where).toBe(false)
          n++
        }
      }
    }
    sim.resetPrefs()
    console.log(`[auto-matrix] swarm: ${n} helper assignments checked`)
  })

  test('council: the best Claude and the best GPT; with one provider its two strongest (said so) or no council (said why)', () => {
    for (const s of setups) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      const c = councilMembers('auto', usable)
      const where = sim.setupName(s)
      for (const id of c.members) ok(s, usable, id, where)
      const providers = new Set(c.members.map((id) => providerOf(usable.find((m) => m.id === id)!)))
      const cloud = usable.filter((m) => !sim.isLocal(m))
      // "Best" by the hardest row of tool-heavy agent work (swarm/models.ts roleSlots), Claude and GPT each.
      const row = roleSlots('hard', 'agent-tools', s.fable)
      const firstOf = (p: string): ModelInfo | undefined => row.map((slot) => cloud.find((m) => slotOf(m) === slot && providerOf(m) === p)).find(Boolean)
      const claudeBest = firstOf('anthropic')
      const gptBest = firstOf('openai')
      if (claudeBest && gptBest) expect(c.members.sort(), where).toEqual([claudeBest.id, gptBest.id].sort())
      else if (new Set(cloud.map((m) => m.provider)).size >= 2) expect(providers.size, where).toBe(2)
      else if (cloud.length >= 2) { expect(c.members.length, where).toBe(2); expect(c.note, where).toMatch(/Only one cloud provider/) }
      else { expect(c.members, where).toEqual([]); expect(c.note, where).toMatch(/needs at least two cloud models/) }
    }
    sim.resetPrefs()
  })

  test('computer-use pair: never Grok, never the ChatGPT plan when another model can see the screen, executor sees screenshots', () => {
    const text = 'Open Mail, find the invoice from Acme, then go to the Acme portal in Safari and fill out the payment form'
    for (const s of setups) for (const pref of ['best', 'balanced', 'cheapest'] as const) {
      sim.applyPrefs(s)
      const usable = sim.usableFor(s)
      const task = { ...classifyTask(text, {}), category: 'computer-use' as const }
      let routed
      try { routed = autoRoute({ requested: 'auto', usable, task, preference: pref, health: new ModelHealth(), now: NOW }).model } catch { continue }
      for (const mode of ['auto', 'pair'] as const) {
        const d = choosePair({ mode, models: usable, category: 'computer-use', difficulty: 3, text, routed, variant: 'auto', preference: pref, fableForHardest: s.fable })
        const where = `${sim.setupName(s)} · ${pref} · ${mode}`
        if (!d.pair) continue
        for (const id of [d.planner, d.executor]) {
          ok(s, usable, id, where)
          const m = usable.find((x) => x.id === id)!
          expect(m.provider, `${where}: ${id}`).not.toBe('xai')
          if (usable.some((x) => x.provider !== 'chatgpt' && x.provider !== 'xai' && x.vision)) expect(m.provider, `${where}: ${id}`).not.toBe('chatgpt')
        }
        expect(usable.find((x) => x.id === d.executor)!.vision, where).toBe(true)
      }
    }
    sim.resetPrefs()
  })
})
