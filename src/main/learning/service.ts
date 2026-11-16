import type { LearnedItem, LearningSettings, LearningStatus, ModelInfo, Settings } from '@shared/types'
import type { Db } from '../db'
import { activityTexts, isRelayed } from '../agent/loop'
import { cost, priceFor, spendingMode } from '../llm/budget'
import { isPlanModel } from '../llm/codex/ids'
import { localOff } from '@shared/local-mode'
import { samplingFor } from '../llm/catalog'
import { isLocal, streamChat, type ChatRequest, type StreamPart } from '../llm/client'
import { def as providerDef } from '../llm/providers'
import { pick } from '../llm/router'
import { isUntrusted, rankMemories, similar, type Memory, type MemoryStore } from '../memory'
import type { SkillStore } from '../skills'
import { cleanLearning } from '../settings'
import { dayKey } from '../usage'
import {
  CONSOLIDATE_SYSTEM, LESSON_SYSTEM, MEMORY_SYSTEM, SKILL_SYSTEM, addressesFromUser, chatExcerpt, chatHasUntrusted, chatOrigin, hasSecret, keeper, lessonInput, lessonWorthy,
  mergedTextOk, nearDuplicates, parseConsolidation, parseLesson, parseMemoryCandidates, parseSkill, rejectKey, runTrace, segmentRuns, skillBody,
  skillRisk, skillWorthy, userTextOf, vetCandidate, wasRejected, type Origin, type RunInfo
} from './extract'
import { LearningStore, isPending, type LogEntry, type UndoPlan } from './store'

// Learning while SahilBot is open. A pass runs only while the app is running and idle (no chat or
// routine for 2 minutes, and nobody using the window); it stops the moment a run starts or the user
// does something, and picks up where it stopped next time. Each pass does a few small jobs:
//   a. memories the bots didn't save, from chats updated since the last pass;
//   b. tidying memories: near-duplicates merged, facts a newer one replaced retired, a cap per scope;
//   c. skills from multi-step work that went well;
//   d. lessons from repeated tool errors, declined actions and the user's corrections.
// Model: a local one first (the background task model when it's local, else the best local model); a
// cloud model (the ChatGPT plan, else the background one, else the cheapest) with "Use cloud models for
// learning" on (the default), within a small daily cap that also counts toward the monthly limit; with
// the monthly limit set to None only the ChatGPT plan. Everything learned goes in the log, with Undo.
// Outside content never teaches: a chat a connected app or another bot started, or a run that read web
// pages, email or other apps' output, gives no lessons or skills; memories from it are unverified (kept
// with the bot, never rules); a rule from a chat that read outside content waits for the user's OK.

export const IDLE_MS = 2 * 60_000
export const PASS_EVERY_MS = 30 * 60_000
const TICK_MS = 30_000
const DAY = 86_400_000
/** Chats never read before: only their last week. */
const LOOKBACK_MS = 7 * DAY
/** A run's outcome counts once the user replied, or after this long without a complaint. */
const SETTLE_MS = 30 * 60_000
const PER_PASS = { chats: 3, lessons: 2, skills: 1 }
const SCOPE_CAP = { shared: 250, bot: 150 }

type Chat = (req: ChatRequest) => AsyncIterable<StreamPart>

export interface LearningDeps {
  db: Db
  memory: MemoryStore
  skills: SkillStore
  settings: { get(): Settings }
  endpoints: { usable(): ModelInfo[]; for(model: string): { baseUrl: string; apiKey?: string }; list?(): Promise<unknown>; last?: unknown }
  /** A chat, routine or helper is running. */
  busy: () => boolean
  /** That chat is running right now (left alone until it's done). */
  isRunning?: (threadId: string) => boolean
  secretValues?: () => string[]
  /** A chat a connected app started. */
  isAppThread?: (threadId: string) => boolean
  fitWindow?: (model: string, window: number) => number
  onChange?: () => void
  /** Automatic passes wait for wall power (Learn now still runs). */
  onBattery?: () => boolean
  /** The model call (tests use a fake). */
  chat?: Chat
  /**
   * The knowledge vault's compile job (src/main/vault/compile.ts): it runs in the same idle passes, with
   * the same model choice and cloud budget. With work waiting it makes a pass happen even while learning
   * itself is off (then only the vault job runs), and may ask for passes more often (passEvery).
   */
  vault?: { wants(now?: number): boolean; run(h: { ask(system: string, user: string, maxTokens: number): Promise<string>; check(): void; now(): number }): Promise<number>; passEvery?(): number }
  now?: () => number
}

class Halt extends Error {}

/**
 * The cloud model for a learning pass: the ChatGPT plan first when it's connected (no per-request cost;
 * its own limits apply), else the cheapest capable model that's at least "light", else Auto's light pick.
 */
export function cheapestFor(remote: ModelInfo[]): ModelInfo | undefined {
  const capable = remote.filter((m) => m.tools !== false)
  const plan = capable.filter((m) => m.provider === 'chatgpt')
  if (plan.length) return pick(plan, 1)
  const price = (m: ModelInfo): number => { const p = priceFor(m.id); return p.known ? p.input + p.output * 0.25 : Infinity }
  const fit = capable.filter((m) => m.tier >= 1 && Number.isFinite(price(m)))
  if (fit.length) return [...fit].sort((a, b) => price(a) - price(b) || a.tier - b.tier || (b.rank ?? 0) - (a.rank ?? 0))[0]
  return pick(remote, 1)
}

const isRemote = (m: ModelInfo): boolean => m.note === 'remote' || !(providerDef(m.provider)?.local ?? true)
const KIND_NAME: Record<string, string> = { profile: 'About you', preference: 'Preference', rule: 'Rule', person: 'Person', location: 'Place', work: 'Work', project: 'Project', trip: 'Trip', date: 'Date', link: 'Link', fact: 'Fact' }

export class LearningService {
  readonly store: LearningStore
  private lastActivity: number
  private timer: ReturnType<typeof setInterval> | null = null
  private current: { ctrl: AbortController; manual: boolean; job: string; model: string; cloud: boolean } | null = null
  private stopped = false
  /** Set while the pass itself removes a memory (tidying, Undo): those aren't the user forgetting it. */
  private ownRemoval = false

  constructor(private d: LearningDeps) {
    this.store = new LearningStore(d.db)
    this.lastActivity = this.now()
    // The user (or a bot) forgot a memory: the log's copies of its words go, and it isn't learned again.
    d.memory.onRemove?.((m) => {
      if (this.ownRemoval) return
      this.store.purgeMemory(m.id)
      this.store.patch({ rejected: [...this.store.state().rejected, rejectKey(m.content)] })
      this.d.onChange?.()
    })
  }

  private removeOwn(id: string): boolean {
    this.ownRemoval = true
    try { return this.d.memory.remove(id) } finally { this.ownRemoval = false }
  }

  private now(): number { return this.d.now?.() ?? Date.now() }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  /** Quit: stop for good (never runs after this). */
  dispose(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.current?.ctrl.abort()
  }

  /** A run started (or the user did something): stop now; idle time starts over. "Learn now" passes only stop for runs. */
  activity(kind: 'run' | 'input' = 'input'): void {
    this.lastActivity = this.now()
    if (this.current && (kind === 'run' || !this.current.manual)) this.current.ctrl.abort()
  }

  settings(): LearningSettings {
    return cleanLearning(this.d.settings.get().learning)
  }

  private localModels(): ModelInfo[] {
    try { return this.d.endpoints.usable().filter((m) => !isRemote(m)) } catch { return [] }
  }

  /** "Remember things automatically" (default on). */
  enabled(): boolean {
    return this.settings().enabled ?? true
  }

  /** The model a pass uses, or why there isn't one. */
  choose(): { model: string; cloud: boolean } | { blocked: string } {
    const s = this.d.settings.get()
    const ls = this.settings()
    const bg = s.taskModels?.background
    let bgLocal = true
    if (bg) { try { bgLocal = isLocal(this.d.endpoints.for(bg).baseUrl) } catch { /* unknown: treated as local */ } }
    // Local models switched off (cloud-first setup): never a local model, and nothing to download.
    const off = localOff(s)
    if (bg && bgLocal && !off) return { model: bg, cloud: false }
    // Local first: a cloud background model is used only when no local model is available.
    const local = off ? [] : this.localModels()
    const best = pick(local, 2)
    if (best) return { model: best.id, cloud: false }
    if (!ls.cloudAllowed) {
      return { blocked: off
        ? 'Local models are off and cloud models aren’t allowed for learning, so it’s skipped. Turn on “Use cloud models for learning” (it stays within the daily cap).'
        : 'No local model is available. Start Ollama or LM Studio, or turn on “Use cloud models for learning”.' }
    }
    if (!s.cloud?.enabled) return { blocked: 'Cloud models are off (Settings → Models).' }
    // Monthly limit None: pay-per-use spending is off, so only the ChatGPT plan (no per-request cost) may learn.
    const none = spendingMode(s) === 'none'
    if (bg && !bgLocal && (!none || isPlanModel(bg))) return { model: bg, cloud: true }
    let remote: ModelInfo[] = []
    try { remote = this.d.endpoints.usable().filter(isRemote) } catch { remote = [] }
    if (none) remote = remote.filter((m) => isPlanModel(m.id) || m.provider === 'chatgpt')
    const cheap = cheapestFor(remote)
    if (!cheap && none) return { blocked: 'Your monthly spending limit is None, so cloud learning is skipped (a local model or the ChatGPT plan would be used).' }
    return cheap ? { model: cheap.id, cloud: true } : { blocked: 'No model is available for learning.' }
  }

  /** Why a pass can't run right now (beyond being busy or not idle), or undefined. */
  private blocked(): string | undefined {
    if (!this.enabled()) return 'Learning is off.'
    const c = this.choose()
    if ('blocked' in c) return c.blocked
    if (c.cloud && this.store.spentToday(this.now()) >= this.settings().dailyUsd) return `Today's cloud learning budget ($${this.settings().dailyUsd.toFixed(2)}) is used up.`
    return undefined
  }

  status(): LearningStatus {
    const st = this.store.state()
    const c = this.choose()
    const enabled = this.enabled()
    const blocked = this.blocked()
    return {
      enabled,
      blocked: enabled ? blocked : undefined,
      running: !!this.current,
      job: this.current?.job,
      lastRunAt: st.lastRunAt,
      lastSummary: st.lastSummary,
      nextRunAt: (enabled || this.vaultWants()) && !blocked ? Math.max((st.lastRunAt ?? 0) + this.passEvery(), this.lastActivity + IDLE_MS, this.now()) : undefined,
      model: 'model' in c ? c.model : undefined,
      cloud: 'model' in c ? c.cloud : false,
      localAvailable: this.localModels().length > 0,
      spentTodayUsd: this.store.spentToday(this.now()),
      settings: this.settings()
    }
  }

  private vaultWants(): boolean {
    try { return !!this.d.vault?.wants(this.now()) } catch { return false }
  }

  private passEvery(): number {
    try { return Math.min(PASS_EVERY_MS, this.d.vault?.passEvery?.() ?? PASS_EVERY_MS) } catch { return PASS_EVERY_MS }
  }

  /** Every 30 s: a pass when enabled (or the vault has work), idle for 2 minutes, due, and on wall power. */
  async tick(): Promise<void> {
    if (this.stopped || this.current) return
    if (this.d.busy()) { this.lastActivity = this.now(); return }
    if (!this.enabled()) {
      // Only the vault has work: quietly wait while no model is usable (or today's cloud budget is spent).
      if (!this.vaultWants()) return
      const c = this.choose()
      if ('blocked' in c || (c.cloud && this.store.spentToday(this.now()) >= this.settings().dailyUsd)) return
    }
    const now = this.now()
    if (now - this.lastActivity < IDLE_MS) return
    if (now < (this.store.state().lastRunAt ?? 0) + this.passEvery()) return
    if (this.d.onBattery?.()) return
    await this.pass(false)
  }

  /** "Learn now": starts a pass unless one is running or a chat is working. `vaultOnly`: the vault's "Compile now". */
  async runNow(o: { vaultOnly?: boolean } = {}): Promise<LearningStatus> {
    if (this.stopped || this.current) return this.status()
    if (this.d.busy()) throw new Error('A chat is working right now. Learning waits until it finishes.')
    const why = this.blocked()
    if (why && why !== 'Learning is off.') throw new Error(why)
    void this.pass(true, o.vaultOnly)
    return this.status()
  }

  /** One pass. Returns what it did, in a short line. */
  async pass(manual: boolean, vaultOnly = false): Promise<string> {
    if (this.current || this.stopped) return ''
    const c = this.choose()
    if ('blocked' in c) { this.store.patch({ lastSummary: c.blocked }); this.d.onChange?.(); return c.blocked }
    if (!this.d.endpoints.last && this.d.endpoints.list) await this.d.endpoints.list().catch(() => undefined)
    const ctrl = new AbortController()
    this.current = { ctrl, manual, job: 'Starting', model: c.model, cloud: c.cloud }
    this.d.onChange?.()
    const done = { memories: 0, tidied: 0, skills: 0, lessons: 0, notes: 0 }
    this.queued = 0
    let stoppedWhy = ''
    // An automatic pass with learning off ran for the vault alone.
    const learn = !vaultOnly && (manual || this.enabled())
    try {
      if (learn) {
        this.job('Reading recent chats')
        done.memories = await this.extractMemories()
        this.job('Looking for lessons and skills')
        const r = await this.fromRuns()
        done.lessons = r.lessons
        done.skills = r.skills
        this.job('Tidying memories')
        done.tidied = await this.consolidate()
      }
      if (this.d.vault && (manual || this.vaultWants())) {
        this.job('Compiling the knowledge vault')
        done.notes = await this.d.vault.run({ ask: (sys, user, max) => this.ask(sys, user, max), check: () => this.check(), now: () => this.now() })
      }
    } catch (e) {
      stoppedWhy = e instanceof Halt ? (e.message || 'Paused: you started using SahilBot.') : `Stopped: ${(e as Error).message.slice(0, 160)}`
    } finally {
      this.current = null
    }
    const parts = [
      done.memories && `${done.memories} ${done.memories === 1 ? 'memory' : 'memories'}`,
      done.lessons && `${done.lessons} ${done.lessons === 1 ? 'lesson' : 'lessons'}`,
      done.skills && `${done.skills} ${done.skills === 1 ? 'skill' : 'skills'}`,
      done.tidied && `${done.tidied} tidied`,
      done.notes && `${done.notes} vault ${done.notes === 1 ? 'note' : 'notes'}`
    ].filter(Boolean)
    const waiting = this.queued ? `${this.queued} waiting for your OK.` : ''
    const summary = [parts.length ? `Learned ${parts.join(', ')}.` : stoppedWhy || waiting ? '' : 'Nothing new to learn.', waiting, stoppedWhy].filter(Boolean).join(' ')
    // An interrupted pass doesn't count as a run: it resumes at the next idle moment.
    this.store.patch({ lastSummary: summary, ...(stoppedWhy && !parts.length ? {} : { lastRunAt: this.now() }) })
    this.d.onChange?.()
    return summary
  }

  private job(name: string): void {
    if (this.current) this.current.job = name
    this.d.onChange?.()
  }

  private check(): void {
    if (this.stopped) throw new Halt('Stopped.')
    if (this.current?.ctrl.signal.aborted) throw new Halt('Paused: you started using SahilBot.')
    if (this.d.busy()) { this.current?.ctrl.abort(); throw new Halt('Paused: a chat started.') }
  }

  /** One model call within the pass: aborts with the pass, stays inside the daily cloud cap. */
  private async ask(system: string, user: string, maxTokens: number): Promise<string> {
    this.check()
    const cur = this.current
    if (!cur) throw new Halt('Not running.')
    const s = this.d.settings.get()
    const input = Math.ceil((system.length + user.length) / 3.5)
    if (cur.cloud) {
      const cap = this.settings().dailyUsd
      if (this.store.spentToday(this.now()) + cost(cur.model, input, maxTokens * 2) > cap) throw new Halt(`Today's cloud learning budget ($${cap.toFixed(2)}) is used up.`)
    }
    const ep = this.d.endpoints.for(cur.model)
    const local = isLocal(ep.baseUrl)
    const chat = this.d.chat ?? streamChat
    let out = ''
    let usage: { promptTokens: number; completionTokens: number } | undefined
    try {
      for await (const part of chat({
        baseUrl: ep.baseUrl, apiKey: ep.apiKey, model: cur.model, maxTokens, signal: cur.ctrl.signal,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        sampling: { ...samplingFor(cur.model, s.sampling ?? {}), temperature: 0.2 },
        // Structured, short answers: no long thinking (and quick on local thinking models).
        effort: 'low',
        ...(local ? { contextWindow: this.d.fitWindow?.(cur.model, 16384) ?? 16384 } : {})
      })) {
        if (part.type === 'reset') out = ''
        else if (part.type === 'content') out += part.text
        else if (part.type === 'usage') usage = part
      }
    } catch (e) {
      if (cur.ctrl.signal.aborted || (e as Error).name === 'AbortError') throw new Halt('Paused: you started using SahilBot.')
      throw e
    } finally {
      if (cur.cloud) this.store.addSpend(cost(cur.model, usage?.promptTokens ?? input, usage?.completionTokens ?? Math.ceil(out.length / 3.5)), this.now())
    }
    return out
  }

  /** Items this pass left waiting for the user's OK. */
  private queued = 0

  private log(e: Omit<LogEntry, 'id' | 'at'>): void {
    this.store.add({ ...e, at: this.now() })
    this.d.onChange?.()
  }

  private originOf(threadId: string, msgs: Parameters<typeof chatOrigin>[0]): Origin {
    return this.d.isAppThread?.(threadId) ? 'app' : chatOrigin(msgs)
  }

  // ------------------------------------------------------------ a. memories the bots didn't save

  async extractMemories(): Promise<number> {
    const { db, memory } = this.d
    if (!memory.enabled) return 0
    const now = this.now()
    const st = this.store.state()
    const cursor = (id: string): number => st.threads[id] ?? now - LOOKBACK_MS
    const threads = db.listThreads().filter((t) => t.updatedAt > cursor(t.id) && now - t.updatedAt >= IDLE_MS && !this.d.isRunning?.(t.id))
    let saved = 0
    let read = 0
    for (const t of threads) {
      if (read >= PER_PASS.chats) break
      this.check()
      const msgs = db.listMessages(t.id)
      const since = cursor(t.id)
      const newest = Math.max(since, ...msgs.map((m) => m.createdAt))
      const fresh = msgs.filter((m) => m.createdAt > since && m.role === 'user' && !m.meta?.hidden && !isRelayed(m) && m.content.trim().length >= 12)
      const mark = (): void => { const s2 = this.store.state(); this.store.patch({ threads: { ...s2.threads, [t.id]: newest } }) }
      if (!fresh.length) { mark(); continue }
      read++
      const space = db.getSpace(t.spaceId)
      const botId = space && space.kind !== 'group' ? space.id : null
      const origin = this.originOf(t.id, msgs)
      const excerpt = chatExcerpt(msgs, since)
      const known = rankMemories(memory.list(botId), { spaceId: botId, query: excerpt.slice(-2000) }).filter((x) => x.m.category !== 'worklog').slice(0, 40).map((x) => `- ${x.m.content}`)
      const reply = await this.ask(MEMORY_SYSTEM, `<known>\n${known.join('\n') || '(nothing yet)'}\n</known>\n\n<chat title="${t.title.replace(/"/g, "'").slice(0, 80)}">\n${excerpt}\n</chat>`, 700)
      const userText = userTextOf(msgs)
      // The chat read outside content (a page, email, another app's output): a rule learned from it
      // waits for the user's OK instead of being saved.
      const sawOutside = chatHasUntrusted(msgs)
      for (const c of parseMemoryCandidates(reply)) {
        const v = vetCandidate(c, { userText, origin, existing: memory.list(botId), rejected: this.store.state().rejected, secretValues: this.d.secretValues?.() ?? [], canHoldBotRules: !!botId })
        if (!v.ok) continue
        const spaceId = v.bot ? botId : c.kind === 'project' && space?.kind === 'project' ? space.id : null
        const where = spaceId ? `only ${space?.name ?? 'this bot'}` : 'shared (about you)'
        if (v.kind === 'rule' && !v.untrusted && sawOutside) {
          if (this.store.list(1000).some((e) => e.undo?.op === 'pending-memory' && !e.undoneAt && similar(e.undo.content, c.fact))) continue
          this.queued++
          this.log({
            kind: 'memory', title: c.fact, detail: `Rule · ${where} · waiting for your OK (this chat also read outside content)`,
            threadId: t.id, spaceId, untrusted: false, origin: origin === 'user' ? undefined : origin,
            undo: { op: 'pending-memory', content: c.fact, kind: v.kind, spaceId }
          })
          continue
        }
        const r = memory.save(c.fact, v.kind, spaceId, 'learned', v.untrusted ? 'untrusted' : 'trusted')
        // save() refreshes a near-identical memory in the same scope: never reword one that way.
        if (r.replaced) { if (r.memory.content !== r.replaced) memory.update(r.memory.id, r.replaced); continue }
        saved++
        this.log({
          kind: 'memory', title: r.memory.content, detail: `${KIND_NAME[r.memory.category] ?? 'Fact'} · ${where}${v.untrusted ? ' · unverified (from outside content)' : ''}`,
          threadId: t.id, spaceId, untrusted: v.untrusted, origin: origin === 'user' ? undefined : origin,
          undo: { op: 'remove-memory', id: r.memory.id, content: r.memory.content }
        })
      }
      mark()
    }
    return saved
  }

  // ------------------------------------------------------------ c. skills and d. lessons, from finished runs

  async fromRuns(): Promise<{ lessons: number; skills: number }> {
    const { db } = this.d
    const now = this.now()
    const seen = new Set(this.store.state().runs)
    const lessons: Array<{ r: RunInfo; t: { id: string; title: string; spaceId: string } }> = []
    const skills: typeof lessons = []
    const skip: string[] = []
    for (const t of db.listThreads().filter((x) => x.updatedAt > now - LOOKBACK_MS && !this.d.isRunning?.(x.id)).slice(0, 40)) {
      for (const r of segmentRuns(db.listMessages(t.id))) {
        if (seen.has(r.opener.id)) continue
        if (!r.next && now - r.lastAt < SETTLE_MS) continue
        if (lessonWorthy(r)) lessons.push({ r, t })
        else if (skillWorthy(r)) skills.push({ r, t })
        else skip.push(r.opener.id)
      }
    }
    const markDone = (ids: string[]): void => { if (ids.length) this.store.patch({ runs: [...this.store.state().runs, ...ids] }) }
    markDone(skip)
    let nl = 0
    let ns = 0
    for (const { r, t } of lessons.slice(0, PER_PASS.lessons)) {
      this.check()
      if (await this.lesson(r, t)) nl++
      markDone([r.opener.id])
    }
    for (const { r, t } of skills.slice(0, PER_PASS.skills)) {
      this.check()
      if (await this.skill(r, t)) ns++
      markDone([r.opener.id])
    }
    return { lessons: nl, skills: ns }
  }

  private async lesson(r: RunInfo, t: { id: string; title: string; spaceId: string }): Promise<boolean> {
    const { db, memory } = this.d
    if (!memory.enabled) return false
    const space = db.getSpace(t.spaceId)
    if (!space || space.kind === 'group') return false
    const msgs = db.listMessages(t.id)
    const origin = this.originOf(t.id, msgs)
    // Error text from outside tools (pages, apps) and relayed words could be planted: a run that read any,
    // or a chat the user didn't start, teaches no lesson at all (corrections and declines included).
    if (origin !== 'user' || r.tainted) return false
    const reply = await this.ask(LESSON_SYSTEM, `<what_happened>\n${lessonInput(r)}\n</what_happened>`, 300)
    const text = parseLesson(reply)
    if (!text) return false
    const userText = userTextOf(msgs)
    if (hasSecret(text, this.d.secretValues?.() ?? [])) return false
    if (!addressesFromUser(text, userText)) return false
    const existing = memory.list(space.id).filter((m) => m.spaceId === space.id)
    if (existing.some((m) => similar(m.content, text)) || wasRejected(text, this.store.state().rejected)) return false
    const r2 = memory.save(text, 'rule', space.id, 'learned')
    if (r2.replaced) { memory.update(r2.memory.id, r2.replaced); return false }
    this.log({
      kind: 'lesson', title: r2.memory.content,
      detail: `From ${r.correction ? 'your correction' : r.denied.length ? 'a declined action' : 'repeated errors'} · only ${space.name}`,
      threadId: t.id, spaceId: space.id, untrusted: false,
      undo: { op: 'remove-memory', id: r2.memory.id, content: r2.memory.content }
    })
    return true
  }

  private async skill(r: RunInfo, t: { id: string; title: string; spaceId: string }): Promise<boolean> {
    const { db, skills } = this.d
    const msgs = db.listMessages(t.id)
    const origin = this.originOf(t.id, msgs)
    // A skill is followed by every later run: none from a run that read outside content, a chat the
    // user didn't start, or a chat holding any outside tool output or relayed message.
    if (r.tainted || origin !== 'user' || chatHasUntrusted(msgs)) return false
    const index = skills.list().filter((s) => s.source !== 'builtin' && !s.untrusted).slice(0, 40).map((s) => `- ${s.name}: ${s.description}`).join('\n')
    const reply = await this.ask(SKILL_SYSTEM, `<skills>\n${index || '(none)'}\n</skills>\n\n<trace>\n${runTrace(r)}\n</trace>`, 900)
    const draft = parseSkill(reply)
    if (!draft) return false
    const userText = userTextOf(msgs)
    const secrets = this.d.secretValues?.() ?? []
    if (skillRisk(draft, `${userText}\n${runTrace(r)}`, secrets)) return false
    // Borderline: it carries an address only the run's own calls had (not the user's words), or the chat
    // had the user's activity (other apps' window titles) in view. Saved as unverified, out of the skill
    // index, until the user approves it in the learning log.
    const borderline = !!skillRisk(draft, userText, secrets) || activityTexts(db.getState(t.id).pins).length > 0
    const st = this.store.state()
    // Improve a learned skill in place; never overwrite one the user wrote or a built-in one.
    const target = draft.improves && skills.get(draft.improves)?.source === 'learned' && !borderline ? draft.improves : draft.name
    const existing = skills.get(target)
    let name = target
    if (existing && (existing.source !== 'learned' || borderline)) name = `${target}-${borderline ? 'unverified' : 'learned'}`.slice(0, 48)
    if (st.rejectedSkills.includes(name)) return false
    const prev = skills.get(name)
    if (prev && (prev.source !== 'learned' || borderline)) return false
    const body = skillBody(draft, { title: t.title, day: dayKey(this.now()) })
    const sk = skills.save({ name, description: draft.description, body, source: 'learned', ...(borderline ? { untrusted: true } : {}) })
    if (borderline) this.queued++
    this.log({
      kind: 'skill', title: sk.name, detail: borderline ? `Waiting for your OK (not used until you approve): ${sk.description}` : `${prev ? 'Improved' : 'New skill'}: ${sk.description}`,
      threadId: t.id, spaceId: t.spaceId, untrusted: borderline,
      undo: borderline ? { op: 'pending-skill', name: sk.name }
        : prev ? { op: 'restore-skill', name: sk.name, prev: { description: prev.description, body: prev.body, source: 'learned' } } : { op: 'remove-skill', name: sk.name }
    })
    return true
  }

  // ------------------------------------------------------------ b. tidying memories

  async consolidate(): Promise<number> {
    const { memory } = this.d
    if (!memory.enabled) return 0
    const now = this.now()
    const st = this.store.state()
    const sig = (): string => { const all = memory.list(); return `${all.length}:${Math.max(0, ...all.map((m) => m.updatedAt))}` }
    if (st.consolidateSig === sig() || now - (st.lastConsolidateAt ?? 0) < 12 * 3_600_000) return 0
    let changes = 0
    const scopes = new Map<string | null, Memory[]>()
    for (const m of memory.list()) if (m.category !== 'worklog') scopes.set(m.spaceId, [...(scopes.get(m.spaceId) ?? []), m])
    // Memories the user put back with Undo are never retired again.
    const kept = new Set(st.kept)
    const retire = (drop: Memory, kind: 'merge' | 'stale' | 'trim', title: string, detail: string, revert?: { id: string; from: string; to: string }): void => {
      this.removeOwn(drop.id)
      changes++
      this.log({ kind, title, detail, threadId: null, spaceId: drop.spaceId, untrusted: false, undo: { op: 'restore-memory', memory: drop, ...(revert ? { revert } : {}) } })
    }
    for (const [scope, list] of scopes) {
      // Near-identical wording: no model needed.
      for (const [a, b] of nearDuplicates(list)) {
        const [keep, drop] = keeper(a, b)
        // An unverified memory never retires a trusted one.
        if (drop.source === 'you' || kept.has(drop.id) || (isUntrusted(keep) && !isUntrusted(drop))) continue
        retire(drop, 'merge', keep.content, `Merged a duplicate: “${drop.content}”`)
      }
      let ms = memory.list(scope).filter((m) => m.spaceId === scope && m.category !== 'worklog')
      if (ms.length >= 6) {
        const shown = [...ms].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 80)
        const ids = new Set(shown.map((m) => m.id))
        const reply = await this.ask(CONSOLIDATE_SYSTEM, `<memories>\n${shown.map((m) => `[${m.id}] (${m.category}, ${dayKey(m.updatedAt)}) ${m.content}`).join('\n')}\n</memories>`, 600)
        const c = parseConsolidation(reply, ids)
        for (const dup of c.duplicates) {
          const keep = memory.get(dup.keep)
          if (!keep) continue
          const drops = dup.drop.map((id) => memory.get(id)).filter((m): m is Memory => !!m && m.source !== 'you' && !kept.has(m.id) && m.category === keep.category && (!isUntrusted(keep) || isUntrusted(m)))
          if (!drops.length) continue
          let revert: { id: string; from: string; to: string } | undefined
          // Merged wording never carries unverified words into a trusted memory.
          const mixed = !isUntrusted(keep) && drops.some(isUntrusted)
          if (dup.text && keep.source !== 'you' && !mixed && mergedTextOk(dup.text, [keep.content, ...drops.map((m) => m.content)]) && !hasSecret(dup.text)) {
            memory.update(keep.id, dup.text)
            revert = { id: keep.id, from: keep.content, to: memory.get(keep.id)?.content ?? dup.text }
          }
          drops.forEach((d, i) => retire(d, 'merge', memory.get(keep.id)?.content ?? keep.content, `Merged a duplicate: “${d.content}”`, i === 0 ? revert : undefined))
        }
        for (const cf of c.conflicts) {
          const newer = memory.get(cf.newer)
          if (!newer) continue
          for (const id of cf.older) {
            const old = memory.get(id)
            // Newer wins; your own words are never retired by a bot's newer guess.
            if (!old || old.source === 'you' || kept.has(old.id) || old.updatedAt >= newer.updatedAt || (isUntrusted(newer) && !isUntrusted(old))) continue
            retire(old, 'stale', old.content, `Out of date: replaced by “${newer.content}”`)
          }
        }
        ms = memory.list(scope).filter((m) => m.spaceId === scope && m.category !== 'worklog')
      }
      // A cap per scope: the oldest learned memories go first (never yours or a bot's own saves).
      const cap = scope === null ? SCOPE_CAP.shared : SCOPE_CAP.bot
      if (ms.length > cap) {
        const learned = ms.filter((m) => m.source === 'learned').sort((a, b) => a.updatedAt - b.updatedAt)
        for (const m of learned.filter((x) => !kept.has(x.id)).slice(0, ms.length - cap)) retire(m, 'trim', m.content, 'Removed to keep memory tidy (oldest learned item over the limit)')
      }
    }
    this.store.patch({ consolidateSig: sig(), lastConsolidateAt: now })
    return changes
  }

  // ------------------------------------------------------------ the log

  private canUndo(e: LogEntry): boolean {
    if (e.undoneAt || !e.undo || isPending(e.undo)) return false
    const u = e.undo
    if (u.op === 'remove-memory') return !!this.d.memory.get(u.id)
    if (u.op === 'remove-skill') return this.d.skills.get(u.name)?.source === 'learned'
    // Never back into a bot that was deleted since.
    if (u.op === 'restore-memory') return !this.d.memory.get(u.memory.id) && (u.memory.spaceId === null || !!this.d.db.getSpace(u.memory.spaceId))
    return true
  }

  list(limit = 200): LearnedItem[] {
    return this.store.list(limit).map((e) => ({
      id: e.id, at: e.at, kind: e.kind, title: e.title, detail: e.detail, threadId: e.threadId ?? null,
      threadTitle: e.threadId ? this.d.db.getThread(e.threadId)?.title : undefined,
      spaceId: e.spaceId ?? null, untrusted: e.untrusted, origin: e.origin, undone: !!e.undoneAt, canUndo: this.canUndo(e),
      ...(isPending(e.undo) && !e.undoneAt ? { pending: true } : {})
    }))
  }

  undo(id: string): LearnedItem[] {
    const e = this.store.get(id)
    if (!e) throw new Error('That item is no longer in the log.')
    if (isPending(e.undo) && !e.undoneAt) return this.dismiss(id)
    if (!this.canUndo(e)) throw new Error('This can no longer be undone (it was changed or removed since).')
    const { memory, skills } = this.d
    const u = e.undo!
    if (u.op === 'remove-memory') {
      this.removeOwn(u.id)
      this.store.patch({ rejected: [...this.store.state().rejected, rejectKey(u.content)] })
    } else if (u.op === 'restore-memory') {
      memory.restore(u.memory)
      this.store.patch({ kept: [...this.store.state().kept, u.memory.id] })
      if (u.revert && memory.get(u.revert.id)?.content === u.revert.to) memory.update(u.revert.id, u.revert.from)
    } else if (u.op === 'remove-skill') {
      skills.remove(u.name)
      this.store.patch({ rejectedSkills: [...this.store.state().rejectedSkills, u.name] })
    } else if (u.op === 'restore-skill') {
      skills.save({ name: u.name, description: u.prev.description, body: u.prev.body, source: u.prev.source })
    }
    this.store.markUndone(id)
    this.d.onChange?.()
    return this.list()
  }

  /** "Approve" on an item waiting for the user's OK: the rule is saved, or the skill joins the index. Undo works after. */
  approve(id: string): LearnedItem[] {
    const e = this.store.get(id)
    if (!e || e.undoneAt || !isPending(e.undo)) throw new Error('That item is no longer waiting for your OK.')
    const u = e.undo as Extract<UndoPlan, { op: 'pending-memory' | 'pending-skill' }>
    let next: UndoPlan
    if (u.op === 'pending-memory') {
      if (u.spaceId && !this.d.db.getSpace(u.spaceId)) throw new Error('The bot it was for was deleted.')
      if (!this.d.memory.enabled) throw new Error('Memory is off (Settings → Memory).')
      const r = this.d.memory.save(u.content, u.kind, u.spaceId, 'learned', 'trusted')
      next = { op: 'remove-memory', id: r.memory.id, content: r.memory.content }
    } else {
      const sk = this.d.skills.get(u.name)
      if (!sk || sk.source !== 'learned') throw new Error('That skill was changed or removed since.')
      this.d.skills.save({ name: sk.name, description: sk.description, body: sk.body, source: 'learned', untrusted: false })
      next = { op: 'remove-skill', name: sk.name }
    }
    this.store.setUndo(id, next, { detail: `${(e.detail ?? '').replace(/\s*·?\s*waiting for your OK[^·]*$/i, '').replace(/^Waiting for your OK[^:]*:\s*/i, '')} · approved by you`.replace(/^ · /, '') })
    this.d.onChange?.()
    return this.list()
  }

  /** "Dismiss": it's dropped and never learned again. */
  dismiss(id: string): LearnedItem[] {
    const e = this.store.get(id)
    if (!e || e.undoneAt || !isPending(e.undo)) throw new Error('That item is no longer waiting for your OK.')
    const u = e.undo as Extract<UndoPlan, { op: 'pending-memory' | 'pending-skill' }>
    if (u.op === 'pending-memory') this.store.patch({ rejected: [...this.store.state().rejected, rejectKey(u.content)] })
    else {
      const sk = this.d.skills.get(u.name)
      if (sk?.source === 'learned' && sk.untrusted) this.d.skills.remove(u.name)
      this.store.patch({ rejectedSkills: [...this.store.state().rejectedSkills, u.name] })
    }
    this.store.setUndo(id, null, { detail: 'Dismissed' })
    this.store.markUndone(id)
    this.d.onChange?.()
    return this.list()
  }
}
